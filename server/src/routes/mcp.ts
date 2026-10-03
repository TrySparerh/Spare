/**
 * Spare MCP over HTTP.
 *
 *   POST /mcp  (also /api/mcp)   MCP JSON-RPC (Streamable HTTP): initialize, tools/list, tools/call, ping
 *   GET  /mcp  (also /api/mcp)   server card (405 for SSE clients — this server is stateless)
 *   GET  /api/mcp/tools          tool catalog JSON: the seven Spare engine tools (?toolset=all adds spare_token)
 *
 * Every tool is a free, read-only Spare tool named `spare_*` (a bare name gets
 * the prefix). No key is needed.
 *
 * Every POST is charged to the caller's per-IP read budget (shared with the
 * /api/spare REST mirror): one charge per JSON-RPC message, scan-heavy tools
 * cost more (spare/budget.ts). A batch holds at most MAX_BATCH messages.
 */
import { Router } from 'express';
import { buildCatalog } from '../mcp/registry.js';
import { handleRpcBody, MAX_BATCH, parseToolset, RPC, SPARE_MCP_SERVER, toolList } from '../mcp/server.js';
import { BUDGET_CAPACITY, BUDGET_WINDOW_MS, charge, rpcMessageCost } from '../spare/budget.js';
import { safeErrorMessage } from '../redact.js';

/** The MCP endpoint itself — mounted at /mcp and /api/mcp. */
export const rpcRouter = Router();

rpcRouter.post('/', async (req, res) => {
  const body: unknown = req.body;
  // Oversized batches are refused by handleRpcBody without running anything; charge them 1.
  const messages = Array.isArray(body) ? (body.length > MAX_BATCH ? [] : body) : [body];
  const cost = Math.max(1, messages.reduce((s: number, m) => s + rpcMessageCost(m), 0));
  const id = !Array.isArray(body) && body && typeof body === 'object' ? ((body as { id?: unknown }).id ?? null) : null;
  if (!charge(req, res, cost, { id })) return;
  let reply: unknown;
  try {
    reply = await handleRpcBody(body, { toolset: parseToolset(req.query.toolset) });
  } catch (err) {
    // Tool failures are already answered inside the result; this is anything else. Detail stays in the log.
    console.error('[MCP] POST:', safeErrorMessage(err, 'rpc failed'));
    return res.status(500).json({ jsonrpc: '2.0', id, error: { code: RPC.INTERNAL_ERROR, message: 'Internal error' } });
  }
  if (reply === null) return res.status(202).end();
  res.json(reply);
});

rpcRouter.get('/', (req, res) => {
  if (String(req.header('accept') ?? '').includes('text/event-stream')) {
    res.set('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed', message: 'Spare MCP is stateless: POST JSON-RPC to this URL.' });
  }
  const toolset = parseToolset(req.query.toolset);
  res.json({
    name: SPARE_MCP_SERVER.name,
    title: SPARE_MCP_SERVER.title,
    version: SPARE_MCP_SERVER.version,
    description: SPARE_MCP_SERVER.description,
    transport: 'streamable-http (stateless, JSON responses)',
    endpoint: '/mcp',
    alsoAt: '/api/mcp',
    protocolVersions: SPARE_MCP_SERVER.protocolVersions,
    toolset,
    tools: toolList(toolset).map((t) => t.name),
    catalog: '/api/mcp/tools',
    auth: 'None. Every tool is a free, read-only view of public chain state.',
    limits: {
      maxBatch: MAX_BATCH,
      readUnitsPerMinute: BUDGET_CAPACITY,
      windowSeconds: BUDGET_WINDOW_MS / 1000,
      note: 'Per client IP, shared with /api/spare/*. spare_activity costs 6 units, spare_fees 4, a wallet replay in spare_roundup_preview 10, most others 1-2.',
    },
  });
});

rpcRouter.delete('/', (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).json({ error: 'method_not_allowed', message: 'No sessions to delete: Spare MCP is stateless.' });
});

/** /api/mcp/* — the tool catalog, plus the RPC endpoint at /api/mcp. */
const router = Router();

// Same default as tools/list: the Spare engine tools. ?toolset=all adds spare_token.
router.get('/tools', (req, res) => {
  res.json(buildCatalog(parseToolset(req.query.toolset)));
});

router.use('/', rpcRouter);

export default router;
