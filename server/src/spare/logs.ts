/**
 * Chunked eth_getLogs for Spare activity.
 *
 * The public RHC RPC is rate-limited and shared, so every scan:
 *   - spans at most LOG_CHUNK_BLOCKS (50,000) blocks per call,
 *   - is filtered by event topic0 (and by the account topic for one account),
 *   - never starts before the deploy block (nothing Spare existed earlier),
 *   - walks NEWEST-first and stops once it has `limit` events, with bounded
 *     concurrency and backoff on HTTP 429,
 *   - reads at most ACTIVITY_MAX_CALLS chunks for one spare_activity call; a
 *     window it did not finish continues on the next page (`nextBefore`).
 *
 * `chunkRange`, `activityWindow`, `decodeActivity` and `pageNewestFirst` are
 * pure and unit-tested.
 */
import {
  decodeEventLog,
  encodeEventTopics,
  pad,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { cashParkAbi, electionRegistryAbi, ruleRegistryAbi, sweepExecutorAbi } from './abis.js';
import { APPROX_BLOCKS_PER_DAY, LOG_CHUNK_BLOCKS, type SpareBook } from './book.js';
import { rpcBusyOf } from './client.js';

export const MAX_ACTIVITY_DAYS = 7;
export const MAX_ACTIVITY_LIMIT = 100;
/**
 * eth_getLogs one spare_activity call may send: 4 rounds of 6 chunks, ~1.4
 * days of blocks. A whole 7-day window is 121 chunks, so a filter that never
 * matches pages through it with `nextBefore` instead of costing 121 reads.
 */
export const ACTIVITY_MAX_CALLS = 24;

export interface BlockRange {
  from: bigint;
  to: bigint;
}

/** Split [from, to] (inclusive) into consecutive ranges of at most `size` blocks. */
export function chunkRange(from: bigint, to: bigint, size: bigint = LOG_CHUNK_BLOCKS): BlockRange[] {
  if (size <= 0n) throw new RangeError('chunk size must be positive');
  if (size > LOG_CHUNK_BLOCKS) throw new RangeError(`chunk size must be <= ${LOG_CHUNK_BLOCKS} blocks`);
  if (to < from) return [];
  const out: BlockRange[] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    out.push({ from: start, to: end < to ? end : to });
  }
  return out;
}

/**
 * The block window for "the last `days` days" ending at `head`, clamped to
 * the deploy block. Days are validated (1..7, integer).
 */
export function activityWindow(
  head: bigint,
  days: number,
  startBlock: bigint,
  blocksPerDay: bigint = APPROX_BLOCKS_PER_DAY,
): BlockRange & { days: number; clampedToDeploy: boolean } {
  if (!Number.isInteger(days) || days < 1 || days > MAX_ACTIVITY_DAYS) {
    throw new RangeError(`days must be an integer 1..${MAX_ACTIVITY_DAYS} (got ${days})`);
  }
  const span = BigInt(days) * blocksPerDay;
  const naive = head > span ? head - span + 1n : 0n;
  const from = naive < startBlock ? startBlock : naive;
  return { from, to: head, days, clampedToDeploy: naive < startBlock };
}

/** Events that carry the account as their FIRST indexed topic. */
const ACCOUNT_EVENTS = [
  { abi: sweepExecutorAbi, names: ['Accrued', 'AccountSwept', 'Delivered', 'DeliveryHeld', 'Deferred', 'SafeSettled', 'Claimed', 'AccrualSkipped'] },
  { abi: cashParkAbi, names: ['Credited', 'WithdrawnForSweep', 'Returned', 'Exited', 'ExitUnitsKept'] },
  { abi: ruleRegistryAbi, names: ['RuleSet', 'Linked', 'Unlinked'] },
  { abi: electionRegistryAbi, names: ['MixSet', 'MixCleared'] },
] as const;

/** Batch-level events (no account) that only the global feed shows. */
const GLOBAL_ONLY_EVENTS = [{ abi: sweepExecutorAbi, names: ['AssetSwept', 'SwapDeferred'] }] as const;

export function topic0(abi: readonly unknown[], eventName: string): Hex {
  const encode = encodeEventTopics as unknown as (p: { abi: readonly unknown[]; eventName: string }) => Hex[];
  return encode({ abi, eventName })[0]!;
}

/** topic0 of every account-scoped Spare event (one getLogs filter covers them all). */
export const ACCOUNT_TOPICS: Hex[] = ACCOUNT_EVENTS.flatMap((g) => g.names.map((n) => topic0(g.abi, n)));
/** Account-scoped events plus batch-level sweep events. */
export const GLOBAL_TOPICS: Hex[] = [...ACCOUNT_TOPICS, ...GLOBAL_ONLY_EVENTS.flatMap((g) => g.names.map((n) => topic0(g.abi, n)))];

/** Contracts whose events make up the activity feed. */
export function activityContracts(book: SpareBook): Address[] {
  return [
    book.contracts.SweepExecutor,
    book.contracts.CashPark,
    book.contracts.RuleRegistry,
    book.contracts.ElectionRegistry,
  ];
}

export type ActivityKind =
  | 'accrued'
  | 'accrual_skipped'
  | 'swept'
  | 'asset_swept'
  | 'swap_deferred'
  | 'delivered'
  | 'delivery_held'
  | 'deferred'
  | 'safe_settled'
  | 'claimed'
  | 'credited'
  | 'withdrawn_for_sweep'
  | 'returned'
  | 'exited'
  | 'exit_units_kept'
  | 'rule_set'
  | 'linked'
  | 'unlinked'
  | 'mix_set'
  | 'mix_cleared';

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'accrued',
  'accrual_skipped',
  'swept',
  'asset_swept',
  'swap_deferred',
  'delivered',
  'delivery_held',
  'deferred',
  'safe_settled',
  'claimed',
  'credited',
  'withdrawn_for_sweep',
  'returned',
  'exited',
  'exit_units_kept',
  'rule_set',
  'linked',
  'unlinked',
  'mix_set',
  'mix_cleared',
];

export interface ActivityItem {
  kind: ActivityKind;
  contract: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
  /** Decoded event args; bigints as decimal strings. */
  args: Record<string, unknown>;
}

const KIND: Record<string, ActivityKind> = {
  Accrued: 'accrued',
  AccrualSkipped: 'accrual_skipped',
  AccountSwept: 'swept',
  AssetSwept: 'asset_swept',
  SwapDeferred: 'swap_deferred',
  Delivered: 'delivered',
  DeliveryHeld: 'delivery_held',
  Deferred: 'deferred',
  SafeSettled: 'safe_settled',
  Claimed: 'claimed',
  Credited: 'credited',
  WithdrawnForSweep: 'withdrawn_for_sweep',
  Returned: 'returned',
  Exited: 'exited',
  ExitUnitsKept: 'exit_units_kept',
  RuleSet: 'rule_set',
  Linked: 'linked',
  Unlinked: 'unlinked',
  MixSet: 'mix_set',
  MixCleared: 'mix_cleared',
};

const CONTRACT_ABI: Array<[keyof SpareBook['contracts'], readonly unknown[]]> = [
  ['SweepExecutor', sweepExecutorAbi],
  ['CashPark', cashParkAbi],
  ['RuleRegistry', ruleRegistryAbi],
  ['ElectionRegistry', electionRegistryAbi],
];

function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

function compareOldestFirst(a: ActivityItem, b: ActivityItem): number {
  const ba = BigInt(a.blockNumber);
  const bb = BigInt(b.blockNumber);
  return ba === bb ? a.logIndex - b.logIndex : ba < bb ? -1 : 1;
}

/**
 * Decode raw logs into activity items, oldest first. Logs from other
 * contracts, unknown events and removed logs are dropped. With an `account`,
 * only that account's events are kept (a provider that ignores the topic
 * filter cannot leak someone else's feed); with `null`, every Spare event is
 * kept (global feed).
 */
export function decodeActivity(logs: readonly Log[], book: SpareBook, account: Address | null): ActivityItem[] {
  const acct = account?.toLowerCase() ?? null;
  const out: ActivityItem[] = [];
  for (const l of logs) {
    if (l.removed || l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
    const entry = CONTRACT_ABI.find(([name]) => book.contracts[name].toLowerCase() === l.address.toLowerCase());
    if (!entry) continue;
    let decoded: { eventName: string; args: unknown };
    try {
      decoded = decodeEventLog({ abi: entry[1] as never, data: l.data, topics: l.topics as never }) as never;
    } catch {
      continue;
    }
    const kind = KIND[decoded.eventName];
    if (!kind) continue;
    const args = (plain(decoded.args) ?? {}) as Record<string, unknown>;
    if (acct !== null && String(args.account ?? '').toLowerCase() !== acct) continue;
    out.push({ kind, contract: entry[0], blockNumber: l.blockNumber.toString(), txHash: l.transactionHash, logIndex: l.logIndex, args });
  }
  return out.sort(compareOldestFirst);
}

/**
 * Newest-first page of at most `limit` items. Never splits a block across
 * pages: when the cut falls inside a block, that whole block moves to the next
 * page (unless it is the only block, then it is returned whole).
 * `nextBefore` is the exclusive upper bound for the next page.
 */
export function pageNewestFirst(
  items: readonly ActivityItem[],
  limit: number,
): { items: ActivityItem[]; truncated: boolean; nextBefore: string | null } {
  const newest = [...items].sort((a, b) => -compareOldestFirst(a, b));
  if (newest.length <= limit) return { items: newest, truncated: false, nextBefore: null };
  const cutBlock = BigInt(newest[limit - 1]!.blockNumber);
  const whole = newest.filter((i) => BigInt(i.blockNumber) > cutBlock);
  if (whole.length > 0) return { items: whole, truncated: true, nextBefore: (cutBlock + 1n).toString() };
  // The first `limit` items all sit in one block: return that block whole.
  const block = newest.filter((i) => BigInt(i.blockNumber) === cutBlock);
  return { items: block, truncated: true, nextBefore: cutBlock.toString() };
}

const RATE_LIMIT = /too many requests|rate[\s_-]?limit|429/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getLogsChunk(client: PublicClient, addresses: Address[], topics: (Hex | Hex[] | null)[], range: BlockRange): Promise<Log[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = (await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: addresses,
            topics,
            fromBlock: `0x${range.from.toString(16)}`,
            toBlock: `0x${range.to.toString(16)}`,
          },
        ],
      } as never)) as unknown as Record<string, unknown>[];
      return raw.map(normaliseLog);
    } catch (err) {
      // The server-wide log-read cap is full: fail now, a retry here would only queue.
      if (rpcBusyOf(err)) throw err;
      const msg = `${(err as Error)?.message ?? ''} ${(err as { details?: string })?.details ?? ''}`;
      if (RATE_LIMIT.test(msg) && attempt < 4) {
        await sleep(Math.min(8_000, 500 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

/** Normalise a raw JSON-RPC log (hex strings) to viem's Log shape. */
function normaliseLog(raw: Record<string, unknown>): Log {
  const hexToBig = (v: unknown) => (typeof v === 'string' ? BigInt(v) : (v as bigint | null));
  const hexToNum = (v: unknown) => (typeof v === 'string' ? Number(BigInt(v)) : (v as number | null));
  return {
    ...(raw as object),
    blockNumber: hexToBig(raw.blockNumber),
    logIndex: hexToNum(raw.logIndex),
    transactionIndex: hexToNum(raw.transactionIndex),
    removed: Boolean(raw.removed),
  } as unknown as Log;
}

export interface ScanResult {
  items: ActivityItem[];
  calls: number;
  /** Lowest block actually scanned (the window start when complete). */
  scannedFrom: bigint;
  /** True when every chunk of the window was scanned. */
  complete: boolean;
}

/**
 * Scan the window newest-first, `concurrency` chunks at a time, and stop as
 * soon as more than `limit` matching items are in hand (so a busy global feed
 * costs a few calls, not 121), or after `maxCalls` chunks (`complete` false,
 * `scannedFrom` says where the next page starts).
 */
export async function scanActivity(
  client: PublicClient,
  book: SpareBook,
  opts: { account: Address | null; range: BlockRange; limit: number; kinds?: ReadonlySet<ActivityKind>; concurrency?: number; maxCalls?: number },
): Promise<ScanResult> {
  const chunks = chunkRange(opts.range.from, opts.range.to)
    .reverse()
    .slice(0, opts.maxCalls ?? Infinity);
  const addresses = activityContracts(book);
  const topics: (Hex | Hex[] | null)[] = opts.account
    ? [ACCOUNT_TOPICS, pad(opts.account.toLowerCase() as Hex, { size: 32 })]
    : [GLOBAL_TOPICS];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 12));
  const items: ActivityItem[] = [];
  let calls = 0;
  let scannedFrom = opts.range.to + 1n;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const logs = (await Promise.all(batch.map((c) => getLogsChunk(client, addresses, topics, c)))).flat();
    calls += batch.length;
    scannedFrom = batch[batch.length - 1]!.from;
    for (const it of decodeActivity(logs, book, opts.account)) {
      if (!opts.kinds || opts.kinds.has(it.kind)) items.push(it);
    }
    if (items.length > opts.limit) break;
  }
  return { items, calls, scannedFrom, complete: scannedFrom <= opts.range.from };
}
