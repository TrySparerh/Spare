/**
 * Every read the API serves is either real (`available: true`, with the block
 * or rows it came from) or explicitly unavailable with a reason the UI prints.
 * There is no third state: no placeholder zeros, no plausible-looking balances
 * for money that has not moved.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
} from "viem";

export type UnavailableCode =
  | "not_deployed"
  | "rpc_unavailable"
  | "chain_mismatch"
  | "chain_revert"
  | "db_unavailable"
  | "not_indexed"
  | "too_large"
  | "busy"
  | "internal";

export interface Unavailable {
  available: false;
  code: UnavailableCode;
  reason: string;
}

export function unavailable(code: UnavailableCode, reason: string): Unavailable {
  return { available: false, code, reason };
}

/** Thrown inside a resolver to short-circuit to an `Unavailable` result. */
export class UnavailableError extends Error {
  constructor(
    readonly code: UnavailableCode,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "UnavailableError";
  }
}

const PG_UNAVAILABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "3D000", // invalid_catalog_name (database missing)
  "28P01", // invalid_password
  "42P01", // undefined_table (migrations not applied)
]);

function isPostgresError(err: unknown): err is { code?: string; name?: string; message: string } {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "PostgresError" || (typeof e.code === "string" && PG_UNAVAILABLE.has(e.code));
}

/** First line of a message, bounded — enough to act on, never a stack. */
function short(msg: string): string {
  const line = msg.split("\n")[0] ?? msg;
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

/** Map any thrown value to an Unavailable. Unknown errors are logged, not leaked. */
export function classifyError(err: unknown, where = "engine"): Unavailable {
  if (err instanceof UnavailableError) return unavailable(err.code, err.reason);
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason ?? "revert";
      return unavailable("chain_revert", `contract call reverted: ${name}`);
    }
    if (
      err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError)
    ) {
      return unavailable("rpc_unavailable", `RPC unavailable: ${short(err.shortMessage)}`);
    }
    return unavailable("rpc_unavailable", `chain read failed: ${short(err.shortMessage)}`);
  }
  // Drizzle wraps driver errors (DrizzleQueryError) — look through the causes.
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (isPostgresError(e)) {
      const code = (e as { code?: string }).code;
      if (code === "42P01") return unavailable("db_unavailable", "database is not migrated — run `bun run db:migrate`");
      if (code && PG_UNAVAILABLE.has(code)) return unavailable("db_unavailable", `database unavailable (${code})`);
      console.error(`[${where}] database error:`, e);
      return unavailable("internal", "database query failed — see engine logs");
    }
    if (e instanceof Error && /ECONNREFUSED|CONNECT_TIMEOUT/i.test(`${(e as { code?: string }).code ?? ""} ${e.message}`)) {
      return unavailable("db_unavailable", "database unavailable (connection refused)");
    }
  }
  console.error(`[${where}] unexpected error:`, err);
  return unavailable("internal", "internal error — see engine logs");
}

/** Run a resolver body; any failure becomes an Unavailable instead of a 500. */
export async function guard<T>(where: string, fn: () => Promise<T>): Promise<T | Unavailable> {
  try {
    return await fn();
  } catch (err) {
    return classifyError(err, where);
  }
}
