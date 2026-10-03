/**
 * Spare MCP — Model Context Protocol server over Streamable HTTP (stateless).
 *
 * POST /api/mcp accepts JSON-RPC 2.0 (single message or batch) and answers
 * with application/json. Implemented methods:
 *   initialize, notifications/initialized (and any notification), ping,
 *   tools/list, tools/call
 * Every tool is a free, read-only Spare read; no key is needed.
 * A batch carries at most MAX_BATCH messages; the HTTP layer (routes/mcp.ts)
 * charges each one to the caller's per-IP read budget before it runs.
 *
 * Connect any MCP client to https://<api-host>/mcp (also served at /api/mcp).
 * tools/list advertises the seven Spare engine tools; add ?toolset=all to the
 * URL to also list spare_token.
 */
import { SPARE_MCP_SERVER } from './server.info.js';
import { TOOLS, type ToolDef } from './registry.js';
import { executeTool } from './dispatch.js';
import { inSpareToolset, type ToolParam } from './registry.types.js';

export { SPARE_MCP_SERVER };

type Id = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string; data?: unknown } };

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Over the per-IP read budget (HTTP 429 + Retry-After). */
  LIMIT_EXCEEDED: -32005,
} as const;

const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

function jsonSchemaType(t: ToolParam['type']): string {
  return t === 'integer' ? 'integer' : t;
}

/** MCP tool descriptor (inputSchema is JSON Schema) for a registry tool. */
export function toMcpTool(t: ToolDef) {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const p of t.params) {
    properties[p.name] = {
      type: jsonSchemaType(p.type),
      description: p.description,
      ...(p.default !== undefined ? { default: p.default } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return {
    name: t.name,
    title: t.name
      .replace(/^spare_/, '')
      .split('_')
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' '),
    description: `[${t.category}] ${t.description}`,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
}

export type Toolset = 'spare' | 'all';

/**
 * `spare` (default): the seven Spare engine tools. `all`: every tool (adds
 * spare_token). Any tool can be CALLED regardless of the toolset; the toolset
 * only decides what tools/list advertises.
 */
export function parseToolset(v: unknown): Toolset {
  return String(v ?? '').toLowerCase() === 'all' ? 'all' : 'spare';
}

const toolListCache = new Map<Toolset, ReturnType<typeof toMcpTool>[]>();
export function toolList(toolset: Toolset = 'spare') {
  let list = toolListCache.get(toolset);
  if (!list) {
    list = (toolset === 'all' ? TOOLS : TOOLS.filter(inSpareToolset)).map(toMcpTool);
    toolListCache.set(toolset, list);
  }
  return list;
}

function negotiateVersion(requested: unknown): string {
  const versions = SPARE_MCP_SERVER.protocolVersions as readonly string[];
  return typeof requested === 'string' && versions.includes(requested) ? requested : versions[0]!;
}

function serializeResult(result: unknown): string {
  return JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

/** Handle one JSON-RPC message. Returns null for notifications (no reply). */
export interface RpcContext {
  toolset?: Toolset;
}

export async function handleRpcMessage(msg: unknown, ctx: RpcContext): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(null, RPC.INVALID_REQUEST, 'Invalid Request');
  }
  const req = msg as JsonRpcRequest;
  const isNotification = !('id' in req) || req.id === undefined;
  const id: Id = isNotification ? null : (req.id as Id);
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return isNotification ? null : fail(id, RPC.INVALID_REQUEST, 'Invalid Request');
  }
  const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;

  // Notifications (notifications/initialized, cancelled, …) never get a reply.
  if (isNotification) return null;

  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SPARE_MCP_SERVER.name,
          title: SPARE_MCP_SERVER.title,
          version: SPARE_MCP_SERVER.version,
          websiteUrl: SPARE_MCP_SERVER.websiteUrl,
        },
        instructions: SPARE_MCP_SERVER.instructions,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolList(ctx.toolset ?? 'spare') });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !name) return fail(id, RPC.INVALID_PARAMS, 'tools/call requires params.name');
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const { status, body } = await executeTool(name, args);
      if (status === 400 && body.error === 'unknown_tool') return fail(id, RPC.INVALID_PARAMS, `Unknown tool: ${name}`);
      if (status !== 200) {
        // Tool-level failure: reported inside the result so the model can see and recover.
        return ok(id, {
          content: [{ type: 'text', text: `${String(body.error)}: ${String(body.message ?? '')}`.trim() }],
          isError: true,
        });
      }
      const result = body.result;
      const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
      return ok(id, {
        content: [{ type: 'text', text: serializeResult(result) }],
        ...(structured ? { structuredContent: JSON.parse(serializeResult(structured)) } : {}),
        isError: false,
      });
    }
    default:
      return fail(id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

/** Most JSON-RPC messages one POST may carry. Every message is charged to the caller's read budget. */
export const MAX_BATCH = 10;

/**
 * Handle an HTTP POST body. Returns the JSON to send, or null when every
 * message was a notification (reply 202 Accepted, no body).
 */
export async function handleRpcBody(body: unknown, ctx: RpcContext): Promise<unknown | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return fail(null, RPC.INVALID_REQUEST, 'Invalid Request');
    if (body.length > MAX_BATCH) {
      return fail(null, RPC.INVALID_REQUEST, `Batch too large: at most ${MAX_BATCH} messages per request (got ${body.length}).`);
    }
    const replies = (await Promise.all(body.map((m) => handleRpcMessage(m, ctx)))).filter(
      (r): r is JsonRpcResponse => r !== null,
    );
    return replies.length ? replies : null;
  }
  if (body === undefined || body === null || typeof body !== 'object') {
    return fail(null, RPC.PARSE_ERROR, 'Parse error');
  }
  return handleRpcMessage(body, ctx);
}
