/**
 * Chunked eth_getLogs for outgoing USDG transfers.
 *
 * Measured on the public RHC RPC (2026-09-30):
 *   - A sender-filtered Transfer query over 6,000,000 blocks was accepted
 *     (~1s); the binding limit is RESULTS: "logs matched by query exceeds
 *     limit of 10000".
 *   - Unfiltered USDG Transfer volume is ~4.7 logs per block, so an
 *     unfiltered scan must stay well under ~2,000 blocks per call.
 *   - The RPC rate-limits: HTTP 429 "Too Many Requests".
 * The engine always filters by sender, halves a chunk (sequentially) whenever
 * the provider reports the RESULT cap, and backs off (honouring Retry-After)
 * when it reports a RATE limit — a throttled request is never split, which
 * would only multiply the requests being throttled.
 *
 * Every call is charged to a LogBudget: the chunk calls, each half of a split
 * and each retry after a rate limit, plus every log held. A busy sender (a
 * pool, a payout bot) can need thousands of split calls and hold hundreds of
 * thousands of logs; the budget refuses that with a LogBudgetError instead.
 *
 * Every returned log is validated: mined, not removed, inside its range.
 */
import { parseAbiItem, type Address, type PublicClient } from "viem";

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface TransferLog {
  from: Address;
  to: Address;
  amount: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

export class LogRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogRangeError";
  }
}

/**
 * Which ceiling refused: the window needs more calls than are left (before
 * any call), the calls ran out (splits and retries included), too many logs
 * are held, or the deadline passed.
 */
export type LogBudgetLimit = "window" | "calls" | "logs" | "deadline";

/** A LogBudget refused more work. A LogRangeError, so "window too large" handling covers it. */
export class LogBudgetError extends LogRangeError {
  constructor(
    readonly limit: LogBudgetLimit,
    message: string,
  ) {
    super(message);
    this.name = "LogBudgetError";
  }
}

export interface LogBudgetLimits {
  /** eth_getLogs calls: chunks, every half of a split, every rate-limit retry. */
  maxCalls: number;
  /** Logs collected — all held until the scan returns — cache hits and DB rows included. Default: unbounded. */
  maxLogs?: number;
  /** Epoch ms: no call starts and no backoff is slept past it. Default: none. */
  deadline?: number;
}

/**
 * One scan's eth_getLogs allowance. A budget may have a parent (one request
 * scanning several wallets): every charge counts against both, so the parent
 * bounds the request however its work is divided.
 *
 * A refused charge shuts the level whose limit it hit, and a failed scan
 * shuts its own budget (`close`): sibling chunks still in flight stop at
 * their next call instead of finishing work nobody will read.
 */
export class LogBudget {
  calls = 0;
  logs = 0;
  private shut: Error | null = null;

  constructor(
    readonly limits: LogBudgetLimits,
    private readonly parent?: LogBudget,
  ) {}

  /** Calls still allowed here and in every parent. */
  get callsLeft(): number {
    const own = Math.max(0, this.limits.maxCalls - this.calls);
    return this.parent ? Math.min(own, this.parent.callsLeft) : own;
  }

  /** Logs that may still be held here and in every parent. */
  get logsLeft(): number {
    const own = Math.max(0, (this.limits.maxLogs ?? Number.POSITIVE_INFINITY) - this.logs);
    return this.parent ? Math.min(own, this.parent.logsLeft) : own;
  }

  /** Refuse up front — before any call is made — when `what` needs more calls than are left. */
  require(calls: number, what: string): void {
    this.open();
    if (calls > this.callsLeft) {
      throw new LogBudgetError("window", `${what} needs ${calls} getLogs calls; the budget has ${this.callsLeft} left`);
    }
  }

  /** Charge one eth_getLogs call; refuses once a level's calls or time are spent. */
  call(): void {
    this.open();
    for (let b: LogBudget | undefined = this; b; b = b.parent) {
      if (b.limits.deadline !== undefined && Date.now() > b.limits.deadline) {
        b.refuse("deadline", "the log scan ran past its deadline");
      }
      if (b.calls >= b.limits.maxCalls) {
        b.refuse("calls", `the log scan needs more than ${b.limits.maxCalls} getLogs calls (split ranges and throttled retries included)`);
      }
    }
    for (let b: LogBudget | undefined = this; b; b = b.parent) b.calls++;
  }

  /** Charge `n` logs now held; refuses once a level holds more than its maxLogs. */
  hold(n: number): void {
    this.open();
    for (let b: LogBudget | undefined = this; b; b = b.parent) b.logs += n;
    for (let b: LogBudget | undefined = this; b; b = b.parent) {
      if (b.limits.maxLogs !== undefined && b.logs > b.limits.maxLogs) {
        b.refuse("logs", `the log scan matched more than ${b.limits.maxLogs} transfers`);
      }
    }
  }

  /** Back off before a retry; refused when the pause would end past a deadline. */
  async pause(ms: number): Promise<void> {
    this.open();
    for (let b: LogBudget | undefined = this; b; b = b.parent) {
      if (b.limits.deadline !== undefined && Date.now() + ms > b.limits.deadline) {
        b.refuse("deadline", "the RPC is throttling and the log scan would run past its deadline");
      }
    }
    await sleep(ms);
  }

  /** Shut this budget after a failure: every later charge rethrows `err`. */
  close(err: Error): void {
    this.shut ??= err;
  }

  private open(): void {
    for (let b: LogBudget | undefined = this; b; b = b.parent) if (b.shut) throw b.shut;
  }

  private refuse(limit: LogBudgetLimit, message: string): never {
    const err = new LogBudgetError(limit, message);
    this.close(err);
    throw err;
  }
}

/** Aligned chunk boundaries: [k*size, (k+1)*size - 1] clipped to [from, to]. */
export function chunkRange(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  if (size <= 0n) throw new RangeError("chunk size must be positive");
  if (to < from) return [];
  const out: { from: bigint; to: bigint }[] = [];
  let start = from;
  while (start <= to) {
    const alignedEnd = (start / size + 1n) * size - 1n;
    const end = alignedEnd < to ? alignedEnd : to;
    out.push({ from: start, to: end });
    start = end + 1n;
  }
  return out;
}

/** True when [from, to] is exactly one aligned chunk, i.e. its key can ever be requested again. */
export function isFullAlignedChunk(c: { from: bigint; to: bigint }, size: bigint): boolean {
  return c.from % size === 0n && c.to === c.from + size - 1n;
}

// Rate limiting is tested FIRST: "Too Many Requests" used to match a loose
// /too many/ result-cap pattern and turned throttling into range halving.
const RATE_LIMIT = /too many requests|rate[\s_-]?limit|request limit reached/i;
const RESULT_CAP = /exceeds limit|query returned more than|response size|logs matched by query|block range|too many (?:results|logs|blocks)/i;

export type LogErrorKind = "rate-limit" | "result-cap" | "other";

function errorChain(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let e: unknown = err;
  for (let i = 0; i < 8 && e && typeof e === "object"; i++) {
    out.push(e as Record<string, unknown>);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

/** Classify a getLogs failure: throttled (back off), result cap (split), or other (throw). */
export function classifyLogError(err: unknown): LogErrorKind {
  let text = "";
  let status: number | undefined;
  let code: number | undefined;
  for (const e of errorChain(err)) {
    if (status === undefined && typeof e.status === "number") status = e.status;
    if (code === undefined && typeof e.code === "number") code = e.code;
    for (const k of ["message", "details", "shortMessage"]) if (typeof e[k] === "string") text += ` ${e[k] as string}`;
  }
  if (status === 429) return "rate-limit";
  if (RATE_LIMIT.test(text)) return "rate-limit";
  if (RESULT_CAP.test(text)) return "result-cap";
  if (code === 429 || code === -32005) return "rate-limit";
  return "other";
}

/** Retry-After (seconds or HTTP date) from any error in the chain, in ms. */
export function retryAfterMs(err: unknown, nowMs = Date.now()): number | null {
  for (const e of errorChain(err)) {
    const h = e.headers as { get?: (k: string) => string | null } | undefined;
    const v = typeof h?.get === "function" ? h.get("retry-after") : null;
    if (!v) continue;
    if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v) * 1000);
    const at = Date.parse(v);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  return null;
}

export const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_MAX_DELAY_MS = 30_000;

/** Delay before retry `attempt` (0-based): Retry-After if given, else 1s, 2s, 4s, ... capped. */
export function rateLimitDelayMs(attempt: number, retryAfter: number | null): number {
  const d = retryAfter ?? 1_000 * 2 ** attempt;
  return Math.min(Math.max(d, 250), RATE_LIMIT_MAX_DELAY_MS);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Full, final, aligned chunks never change: cache them, bounded by chunk count
// AND total log count (a moving tail chunk is never cached — its key never
// repeats, so caching it only grew the heap).
const MAX_CACHED_CHUNKS = 5_000;
const MAX_CACHED_LOGS = 250_000;
interface ChunkCache {
  map: Map<string, TransferLog[]>;
  logs: number;
}
const chunkCache = new WeakMap<PublicClient, ChunkCache>();

function cachePut(cache: ChunkCache, key: string, logs: TransferLog[]) {
  if (logs.length > MAX_CACHED_LOGS / 10) return;
  cache.map.set(key, logs);
  cache.logs += logs.length;
  while (cache.map.size > MAX_CACHED_CHUNKS || cache.logs > MAX_CACHED_LOGS) {
    const oldest = cache.map.keys().next().value as string;
    cache.logs -= cache.map.get(oldest)!.length;
    cache.map.delete(oldest);
  }
}

async function fetchChunk(
  client: PublicClient,
  budget: LogBudget,
  token: Address,
  wallet: Address,
  from: bigint,
  to: bigint,
  depth = 0,
): Promise<TransferLog[]> {
  for (let attempt = 0; ; attempt++) {
    let logs;
    budget.call();
    try {
      logs = await client.getLogs({ address: token, event: TRANSFER_EVENT, args: { from: wallet }, fromBlock: from, toBlock: to });
    } catch (err) {
      const kind = classifyLogError(err);
      if (kind === "rate-limit" && attempt < RATE_LIMIT_RETRIES) {
        await budget.pause(rateLimitDelayMs(attempt, retryAfterMs(err)));
        continue;
      }
      if (kind === "result-cap" && to > from && depth < 24) {
        // Sequential halves: bounded concurrency, never an exponential fan-out.
        const mid = from + (to - from) / 2n;
        const a = await fetchChunk(client, budget, token, wallet, from, mid, depth + 1);
        const b = await fetchChunk(client, budget, token, wallet, mid + 1n, to, depth + 1);
        return [...a, ...b];
      }
      throw err;
    }
    budget.hold(logs.length);
    return logs.map((l) => {
      if (l.removed || l.blockNumber === null || l.transactionHash === null || l.logIndex === null) {
        throw new LogRangeError("provider returned an unmined or removed log");
      }
      if (l.blockNumber < from || l.blockNumber > to) throw new LogRangeError("provider returned a log outside the requested range");
      if (!l.args.from || !l.args.to || l.args.value === undefined) throw new LogRangeError("provider returned a malformed Transfer log");
      if (l.args.from.toLowerCase() !== wallet.toLowerCase()) throw new LogRangeError("provider ignored the sender filter");
      return {
        from: l.args.from,
        to: l.args.to,
        amount: l.args.value,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      };
    });
  }
}

/**
 * Every USDG Transfer(from = wallet) in [fromBlock, toBlock], oldest first.
 * Refuses (LogBudgetError) rather than silently truncating: before any call
 * when the window needs more than `maxChunks` chunk calls, and mid-scan once
 * `maxChunks` calls — splits and retries included — are spent. A `budget`
 * shared across scans (one request, several wallets) is charged too.
 */
export async function transfersFrom(
  client: PublicClient,
  opts: {
    token: Address;
    wallet: Address;
    fromBlock: bigint;
    toBlock: bigint;
    maxRange: bigint;
    /** Most eth_getLogs calls this scan may make, every split and retry counted. */
    maxChunks: number;
    /** Full aligned chunks ending at or below this block are cached. */
    finalBlock: bigint;
    concurrency?: number;
    /** false: never read or write the chunk cache (incremental scanners). */
    cache?: boolean;
    /** A request-wide budget this scan also draws on (calls, logs held, deadline). */
    budget?: LogBudget;
  },
): Promise<TransferLog[]> {
  const chunks = chunkRange(opts.fromBlock, opts.toBlock, opts.maxRange);
  const budget = new LogBudget({ maxCalls: opts.maxChunks }, opts.budget);
  budget.require(chunks.length, `window of ${opts.toBlock - opts.fromBlock + 1n} blocks`);
  const useCache = opts.cache !== false;
  let cache = chunkCache.get(client);
  if (!cache) chunkCache.set(client, (cache = { map: new Map(), logs: 0 }));
  const concurrency = opts.concurrency ?? 4;
  const out: TransferLog[][] = new Array(chunks.length);
  try {
    for (let i = 0; i < chunks.length; i += concurrency) {
      const slice = chunks.slice(i, i + concurrency);
      const got = await Promise.all(
        slice.map(async (c) => {
          const cacheable = useCache && c.to <= opts.finalBlock && isFullAlignedChunk(c, opts.maxRange);
          const key = `${opts.token.toLowerCase()}:${opts.wallet.toLowerCase()}:${c.from}:${c.to}`;
          if (cacheable) {
            const hit = cache!.map.get(key);
            if (hit) {
              budget.hold(hit.length);
              return hit;
            }
          }
          const logs = await fetchChunk(client, budget, opts.token, opts.wallet, c.from, c.to);
          if (cacheable) cachePut(cache!, key, logs);
          return logs;
        }),
      );
      got.forEach((logs, j) => (out[i + j] = logs));
    }
  } catch (err) {
    // Stop sibling chunks (and their split halves) at their next call.
    budget.close(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return out
    .flat()
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}
