/**
 * /api/spare/* — REST mirror of the Spare MCP engine tools. Same handlers,
 * same JSON as `tools/call`. Read-only, free, live from Robinhood Chain.
 *
 *   GET /api/spare                                   index
 *   GET /api/spare/universe?includeInactive=true
 *   GET /api/spare/account/:address                  (or /account?address=0x…)
 *   GET /api/spare/activity/:address?days=7&limit=50&kinds=accrued,swept&before=<block>
 *   GET /api/spare/activity?days=1                   global feed (no account addresses)
 *   GET /api/spare/quote?asset=SPY&usdgIn=5     (any registered ticker or token address)
 *   GET /api/spare/roundup-preview?amountUsd=3.75&roundTo=1&multiplier=3
 *   GET /api/spare/roundup-preview?amounts=3.75,12.40&roundTo=1&weeklyCapUsd=5
 *   GET /api/spare/roundup-preview?wallet=0x…&days=7&roundTo=1&multiplier=2   (replay real payments)
 *   GET /api/spare/contracts
 *   GET /api/spare/fees
 *   GET /api/spare/token                             (served by routes/spareToken.ts)
 * Tool names work too: /api/spare/spare_universe, /api/spare/roundup_preview.
 *
 * Bad input -> 400 { error: 'invalid_params', message }. Chain/RPC trouble ->
 * 502 { error: 'chain_read_failed', message }. Over budget -> 429 (shared
 * per-IP budget with the MCP endpoint; see spare/budget.ts). The server-wide
 * eth_getLogs cap full -> 503 { error: 'rpc_busy', message } with Retry-After
 * (spare/client.ts). A message is one redacted line (redact.ts): never the
 * RPC URL, the upstream reply or a stack.
 */
import { Router, type Request, type Response } from 'express';
import { SPARE_ENGINE_TOOLS, SPARE_TOOL_BY_SLUG } from '../spare/tools.js';
import { charge, toolCost } from '../spare/budget.js';
import { rpcBusyOf } from '../spare/client.js';
import { safeErrorMessage } from '../redact.js';
import type { ToolDef } from '../mcp/registry.types.js';

const router = Router();

const MAX_AGE: Record<string, number> = {
  spare_universe: 15,
  spare_account: 5,
  spare_activity: 10,
  spare_quote: 5,
  spare_roundup_preview: 60,
  spare_contracts: 60,
  spare_fees: 15,
  spare_token: 30,
};

/** Query string -> tool args (first value of repeated keys, except list-valued ones). */
function argsOf(req: Request, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (Array.isArray(v)) out[k] = k === 'amounts' || k === 'kinds' ? v.map(String) : String(v[0]);
    else if (v !== undefined) out[k] = String(v);
  }
  return { ...out, ...extra };
}

async function run(tool: ToolDef, args: Record<string, unknown>, req: Request, res: Response) {
  // Each call fans out to reads on a shared, rate-limited RPC: charge the caller's budget first.
  if (!charge(req, res, toolCost(tool.name, args))) return;
  try {
    const out = await tool.handler(args);
    res.set('Cache-Control', `public, max-age=${MAX_AGE[tool.name] ?? 10}`);
    res.json(out);
  } catch (err) {
    if (err instanceof RangeError) {
      return res.status(400).json({ error: 'invalid_params', message: safeErrorMessage(err, 'invalid params') });
    }
    const busy = rpcBusyOf(err);
    if (busy) {
      res.set('Retry-After', String(busy.retryAfterSeconds));
      return res.status(503).json({ error: 'rpc_busy', message: busy.message, retryAfterSeconds: busy.retryAfterSeconds });
    }
    const message = safeErrorMessage(err, 'read failed');
    console.error(`[SPARE] ${req.path}:`, message);
    return res.status(502).json({ error: 'chain_read_failed', message });
  }
}

router.get('/', (_req, res) => {
  res.json({
    service: 'Spare engine reads',
    chainId: 4663,
    tools: SPARE_ENGINE_TOOLS.map((t) => ({
      tool: t.name,
      rest: `/api/spare/${t.name.replace(/^spare_/, '').replace(/_/g, '-')}`,
      params: t.params.map((p) => p.name),
      description: t.description,
    })),
    mcp: { endpoint: '/mcp', alsoAt: '/api/mcp', catalog: '/api/mcp/tools?toolset=spare' },
  });
});

router.get('/account/:address', (req, res) => run(SPARE_TOOL_BY_SLUG.get('account')!, argsOf(req, { address: req.params.address }), req, res));
router.get('/activity/:address', (req, res) => run(SPARE_TOOL_BY_SLUG.get('activity')!, argsOf(req, { address: req.params.address }), req, res));
router.get('/:tool', (req, res, next) => {
  const tool = SPARE_TOOL_BY_SLUG.get(String(req.params.tool).toLowerCase());
  if (!tool) return next();
  return run(tool, argsOf(req), req, res);
});

export default router;
