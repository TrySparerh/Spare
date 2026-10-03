import { REGISTRY, type ToolDef } from "./registry.js";
import { normalizeToolName } from "./normalize.js";
import { safeErrorMessage } from "../redact.js";
import { rpcBusyOf } from "../spare/client.js";

export interface ResolvedTool {
  tool: ToolDef;
  /** Registry (canonical `spare_*`) name. */
  name: string;
}

/** Resolve a tool name to a registry tool: canonical `spare_*` or a bare name (`universe` -> `spare_universe`). */
export function resolveTool(rawName: unknown): ResolvedTool | null {
  const name = normalizeToolName(rawName);
  const tool = REGISTRY[name];
  return tool ? { tool, name } : null;
}

export interface ExecResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Run a tool. Every tool is a free, read-only Spare read, so there is no key.
 * Response body: `{ result, latency_ms }`. A failure's message is one redacted
 * line (redact.ts): never the RPC URL, the upstream reply or a stack. The
 * server-wide eth_getLogs cap being full is 503 `rpc_busy` (spare/client.ts).
 */
export async function executeTool(rawName: string, params: Record<string, unknown>): Promise<ExecResult> {
  const resolved = resolveTool(rawName);
  if (!resolved) {
    return { status: 400, body: { error: "unknown_tool", tool: rawName } };
  }
  const t0 = Date.now();
  try {
    const result = await resolved.tool.handler({ ...(params ?? {}) });
    return { status: 200, body: { result, latency_ms: Date.now() - t0 } };
  } catch (e) {
    const busy = rpcBusyOf(e);
    if (busy) return { status: 503, body: { error: "rpc_busy", message: busy.message, retryAfterSeconds: busy.retryAfterSeconds } };
    const invalid = e instanceof RangeError; // SpareInputError extends RangeError
    const message = safeErrorMessage(e, invalid ? "invalid params" : "tool failed");
    return {
      status: invalid ? 400 : 500,
      body: invalid ? { error: "invalid_params", message } : { error: "tool_error", message },
    };
  }
}
