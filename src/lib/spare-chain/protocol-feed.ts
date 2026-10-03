/**
 * Protocol-wide Spare activity from event logs, for the public pages
 * (/dispatch, /datalayer, /devtools). Everything here reads Robinhood Chain
 * directly: no backend, nothing to trust but the chain.
 *
 *   scanFeed          every feed event (collections, sweeps, deferrals, exits)
 *                     in a block range, ≤ 50,000-block chunks, newest first
 *   latestFeedEvent   the newest event of some kinds, walking back from the head
 *   countLinkedWallets  Linked − Unlinked since deployment
 *   summarizeFeed / feedRowText / keeperStatus   pure helpers for the pages
 *
 * The public feed never shows account or wallet addresses: rows say what
 * happened, not who it happened to.
 *
 * Row sentences, badges, keeper words and "3m ago" come out in the live
 * language (pages-b `feed.*`, `dispatch.tags.*`, `dispatch.keeper.*`,
 * `common.ago.*`): call the presentation helpers at render.
 *
 * Broad scans (many event kinds across SweepExecutor + CashPark) use the same
 * 50,000-block ceiling as activity.ts. Narrow lookups (one contract, one or two
 * event kinds) use NARROW_LOG_RANGE and halve on a range complaint.
 */
import {
  BaseError,
  HttpRequestError,
  decodeEventLog,
  encodeEventTopics,
  toHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { formatToken, formatUsd } from '@/lib/spare';
import { cashParkAbi, ruleRegistryAbi, sweepExecutorAbi } from './abis';
import { SPARE, START_BLOCK, STOCK_DECIMALS, symbolOf } from './addresses';
import { MAX_LOG_RANGE, NARROW_LOG_RANGE, chunkRange, isRateLimited, mapLimit } from './activity';
import { getT } from '@/i18n';

const tf = getT('pages-b');

/* --------------------------------- kinds ----------------------------------- */

/** SweepExecutor events that appear in the public feed. All are emitted by keeper transactions. */
export const KEEPER_FEED_KINDS = ['Accrued', 'AssetSwept', 'AccountSwept', 'Deferred', 'SwapDeferred', 'SafeSettled', 'DeliveryHeld'] as const;
/** CashPark events that appear in the public feed (user actions). */
export const PARK_FEED_KINDS = ['Exited'] as const;

export type FeedKind = (typeof KEEPER_FEED_KINDS)[number] | (typeof PARK_FEED_KINDS)[number];
export const FEED_KINDS: readonly FeedKind[] = [...KEEPER_FEED_KINDS, ...PARK_FEED_KINDS];

type SourceName = 'SweepExecutor' | 'CashPark' | 'RuleRegistry';

const SOURCES: Record<SourceName, { address: Address; abi: Abi }> = {
  SweepExecutor: { address: SPARE.SweepExecutor, abi: sweepExecutorAbi as unknown as Abi },
  CashPark: { address: SPARE.CashPark, abi: cashParkAbi as unknown as Abi },
  RuleRegistry: { address: SPARE.RuleRegistry, abi: ruleRegistryAbi as unknown as Abi },
};

function topicOf(source: SourceName, eventName: string): Hex {
  return encodeEventTopics({ abi: SOURCES[source].abi, eventName } as never)[0] as Hex;
}

export interface FeedEvent {
  id: string;
  kind: string;
  source: SourceName;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hash;
  args: Record<string, unknown>;
}

interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  logIndex: Hex | null;
  transactionHash: Hash | null;
  removed?: boolean;
}

function decodeLog(log: RpcLog, allowed: ReadonlySet<string>): FeedEvent | null {
  if (log.removed || !log.blockNumber || !log.transactionHash || log.logIndex == null) return null;
  const entry = (Object.entries(SOURCES) as [SourceName, { address: Address; abi: Abi }][]).find(
    ([, s]) => s.address.toLowerCase() === log.address.toLowerCase(),
  );
  if (!entry) return null;
  try {
    const d = decodeEventLog({ abi: entry[1].abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (!d.eventName || !allowed.has(d.eventName)) return null;
    const logIndex = Number(BigInt(log.logIndex));
    return {
      id: `${log.transactionHash}:${logIndex}`,
      kind: d.eventName,
      source: entry[0],
      blockNumber: BigInt(log.blockNumber),
      logIndex,
      txHash: log.transactionHash,
      args: (d.args ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function sortFeedNewestFirst<T extends { blockNumber: bigint; logIndex: number }>(events: T[]): T[] {
  return events.sort((a, b) =>
    a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
  );
}

/* ------------------------------- log reads -------------------------------- */

const RESULT_CAP = /exceeds limit|query returned more than|response size|logs matched by query|block range|range (is )?too (large|wide)/i;
const MIN_RANGE = 1_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorText(e: unknown): string {
  if (e instanceof BaseError) return `${e.shortMessage} ${e.details ?? ''} ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

interface Filter {
  address: Address | Address[];
  topics: (Hex | Hex[] | null)[];
}

/**
 * eth_getLogs over [from, to]:
 *   rate limited  → back off and retry the same range (up to 5 times)
 *   result capped → halve the range, down to a floor
 *   anything else → two gentle retries, then give up
 */
async function getLogs(client: PublicClient, filter: Filter, from: bigint, to: bigint, signal?: AbortSignal, attempt = 0): Promise<RpcLog[]> {
  if (signal?.aborted) throw abortError();
  try {
    return (await client.request({
      method: 'eth_getLogs',
      params: [{ address: filter.address, fromBlock: toHex(from), toBlock: toHex(to), topics: filter.topics }],
    } as never)) as RpcLog[];
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (isRateLimited(e)) {
      if (attempt >= 5) throw e;
      const http = e instanceof BaseError ? (e.walk((x) => x instanceof HttpRequestError) as HttpRequestError | null) : null;
      const after = Number(http?.headers?.get('Retry-After'));
      const backoff = Math.min(15_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      await sleep(Math.max(Number.isFinite(after) ? after * 1000 : 0, backoff));
      return getLogs(client, filter, from, to, signal, attempt + 1);
    }
    const span = to - from + 1n;
    if (RESULT_CAP.test(errorText(e)) && span > MIN_RANGE) {
      const mid = from + span / 2n;
      const a = await getLogs(client, filter, from, mid - 1n, signal);
      const b = await getLogs(client, filter, mid, to, signal);
      return [...a, ...b];
    }
    if (attempt < 2) {
      await sleep(600 * (attempt + 1));
      return getLogs(client, filter, from, to, signal, attempt + 1);
    }
    throw e;
  }
}

/* --------------------------------- scans ---------------------------------- */

const FEED_FILTER = (): Filter => ({
  address: [SPARE.SweepExecutor, SPARE.CashPark],
  topics: [[...KEEPER_FEED_KINDS.map((k) => topicOf('SweepExecutor', k)), ...PARK_FEED_KINDS.map((k) => topicOf('CashPark', k))]],
});

export interface ScanOpts {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Every feed event in [from, to] (clipped to the deployment), newest first.
 * Chunks are ≤ MAX_LOG_RANGE (50,000 blocks), 4 in flight, newest chunk first.
 */
export async function scanFeed(client: PublicClient, from: bigint, to: bigint, opts: ScanOpts = {}): Promise<FeedEvent[]> {
  const lo = from < START_BLOCK ? START_BLOCK : from;
  if (to < lo) return [];
  const filter = FEED_FILTER();
  const allowed = new Set<string>(FEED_KINDS);
  const chunks = chunkRange(lo, to, MAX_LOG_RANGE).reverse();
  let done = 0;
  opts.onProgress?.(0, chunks.length);
  const parts = await mapLimit(chunks, 4, async (c) => {
    if (opts.signal?.aborted) throw abortError();
    const logs = await getLogs(client, filter, c.from, c.to, opts.signal);
    done += 1;
    opts.onProgress?.(done, chunks.length);
    return logs.map((l) => decodeLog(l, allowed)).filter((e): e is FeedEvent => e !== null);
  });
  return sortFeedNewestFirst(parts.flat());
}

/**
 * The newest event of `kinds` on one contract at or below `to`, walking back
 * from the head in narrow chunks and stopping at the first chunk with a hit.
 */
export async function latestFeedEvent(
  client: PublicClient,
  source: SourceName,
  kinds: readonly string[],
  to: bigint,
  opts: { signal?: AbortSignal; from?: bigint } = {},
): Promise<FeedEvent | null> {
  const lo = opts.from != null && opts.from > START_BLOCK ? opts.from : START_BLOCK;
  if (to < lo) return null;
  const filter: Filter = { address: SOURCES[source].address, topics: [kinds.map((k) => topicOf(source, k))] };
  const allowed = new Set(kinds);
  for (const c of chunkRange(lo, to, NARROW_LOG_RANGE).reverse()) {
    const logs = await getLogs(client, filter, c.from, c.to, opts.signal);
    const events = logs.map((l) => decodeLog(l, allowed)).filter((e): e is FeedEvent => e !== null);
    if (events.length) return sortFeedNewestFirst(events)[0];
  }
  return null;
}

/**
 * Every event of `kinds` on one contract since deployment (or `from`), newest
 * first. A NARROW filter (one address, a few topic0s), so chunks are
 * NARROW_LOG_RANGE wide — the whole history stays a handful of requests.
 */
export async function scanKinds(
  client: PublicClient,
  source: SourceName,
  kinds: readonly string[],
  to: bigint,
  opts: { signal?: AbortSignal; from?: bigint } = {},
): Promise<FeedEvent[]> {
  const lo = opts.from != null && opts.from > START_BLOCK ? opts.from : START_BLOCK;
  if (to < lo) return [];
  const filter: Filter = { address: SOURCES[source].address, topics: [kinds.map((k) => topicOf(source, k))] };
  const allowed = new Set(kinds);
  const parts = await mapLimit(chunkRange(lo, to, NARROW_LOG_RANGE), 4, async (c) => {
    const logs = await getLogs(client, filter, c.from, c.to, opts.signal);
    return logs.map((l) => decodeLog(l, allowed)).filter((e): e is FeedEvent => e !== null);
  });
  return sortFeedNewestFirst(parts.flat());
}

/** Linked − Unlinked on RuleRegistry since deployment: how many spending wallets the keeper watches. */
export async function countLinkedWallets(client: PublicClient, to: bigint, opts: { signal?: AbortSignal } = {}): Promise<number> {
  return linkedFromEvents(await scanKinds(client, 'RuleRegistry', ['Linked', 'Unlinked'], to, opts));
}

/** All-time totals: Σ Accrued and Σ AssetSwept since deployment (narrow scans, not the 50k feed scan). */
export async function scanTotals(client: PublicClient, to: bigint, opts: { signal?: AbortSignal } = {}): Promise<FeedSummary> {
  return summarizeFeed(await scanKinds(client, 'SweepExecutor', ['Accrued', 'AssetSwept', 'AccountSwept'], to, opts));
}

/** Linked − Unlinked, never below zero. */
export function linkedFromEvents(events: readonly Pick<FeedEvent, 'kind'>[]): number {
  let n = 0;
  for (const e of events) {
    if (e.kind === 'Linked') n += 1;
    else if (e.kind === 'Unlinked') n -= 1;
  }
  return Math.max(0, n);
}

/* ---------------------------- pure presentation ---------------------------- */

const big = (v: unknown): bigint => {
  try {
    return typeof v === 'bigint' ? v : BigInt(v as string | number);
  } catch {
    return 0n;
  }
};

/** OracleGuard.Status → the words a Deferred row uses. */
export function deferReason(status: unknown): string {
  switch (Number(status)) {
    case 0: return tf('feed.defer.live');
    case 1: return tf('feed.defer.closed');
    case 2: return tf('feed.defer.paused');
    case 3: return tf('feed.defer.seqDown');
    case 4: return tf('feed.defer.badAnswer');
    default: return tf('feed.defer.unavailable');
  }
}

/** One plain line per feed event, in the live language. Never names an account or wallet. */
export function feedRowText(e: Pick<FeedEvent, 'kind' | 'args'>): string {
  const a = e.args;
  switch (e.kind) {
    case 'Accrued':
      return tf('feed.row.accrued', { amount: formatUsd(big(a.amount)) });
    case 'AssetSwept':
      return tf('feed.row.assetSwept', {
        qty: formatToken(big(a.tokensOut), STOCK_DECIMALS, 6),
        sym: symbolOf(a.asset as string),
        usdg: formatUsd(big(a.usdgIn)),
        fee: formatUsd(big(a.fee)),
      });
    case 'AccountSwept':
      return tf('feed.row.accountSwept', { usdg: formatUsd(big(a.usdg)), epoch: big(a.epoch).toString() });
    case 'Deferred':
      return tf('feed.row.deferred', { sym: symbolOf(a.asset as string), usdg: formatUsd(big(a.usdg)), reason: deferReason(a.status) });
    case 'SwapDeferred':
      return tf('feed.row.swapDeferred', { sym: symbolOf(a.asset as string), usdg: formatUsd(big(a.usdg)) });
    case 'SafeSettled': {
      // The reason is the contract's own string, shown as emitted.
      const reason = typeof a.reason === 'string' && a.reason.trim() ? ` · ${a.reason.trim()}` : '';
      return tf('feed.row.safeSettled', { sym: symbolOf(a.asset as string), usdg: formatUsd(big(a.usdg)) }) + reason;
    }
    case 'DeliveryHeld':
      return tf('feed.row.deliveryHeld', { qty: formatToken(big(a.amount), STOCK_DECIMALS, 6), sym: symbolOf(a.token as string) });
    case 'Exited':
      return tf('feed.row.exited', { usdg: formatUsd(big(a.usdgOut)) });
    default:
      return e.kind;
  }
}

/** Short badge for a row, in the live language. */
export function feedRowTag(kind: string): { label: string; tone: 'good' | 'warn' | 'info' | 'holo' | 'muted' } {
  switch (kind) {
    case 'Accrued': return { label: tf('dispatch.tags.roundUp'), tone: 'info' };
    case 'AssetSwept': return { label: tf('dispatch.tags.bought'), tone: 'good' };
    case 'AccountSwept': return { label: tf('dispatch.tags.swept'), tone: 'holo' };
    case 'Deferred': return { label: tf('dispatch.tags.deferred'), tone: 'warn' };
    case 'SwapDeferred': return { label: tf('dispatch.tags.deferred'), tone: 'warn' };
    case 'SafeSettled': return { label: tf('dispatch.tags.returned'), tone: 'warn' };
    case 'DeliveryHeld': return { label: tf('dispatch.tags.held'), tone: 'warn' };
    case 'Exited': return { label: tf('dispatch.tags.exit'), tone: 'muted' };
    default: return { label: kind.toUpperCase(), tone: 'muted' };
  }
}

export interface FeedSummary {
  accruedCount: number;
  /** Σ Accrued.amount, USDG 6 dp. */
  accruedUsdg: bigint;
  /** Σ AssetSwept.usdgIn. */
  convertedUsdg: bigint;
  /** Σ AssetSwept.fee. */
  feesUsdg: bigint;
  /** Newest keeper-emitted event (every SweepExecutor feed event). */
  lastKeeper: FeedEvent | null;
  /** Newest Accrued or AccountSwept — the "Running" signal. */
  lastCollectOrSweep: FeedEvent | null;
}

export function summarizeFeed(events: readonly FeedEvent[]): FeedSummary {
  const s: FeedSummary = { accruedCount: 0, accruedUsdg: 0n, convertedUsdg: 0n, feesUsdg: 0n, lastKeeper: null, lastCollectOrSweep: null };
  const newer = (a: FeedEvent | null, b: FeedEvent) =>
    !a || b.blockNumber > a.blockNumber || (b.blockNumber === a.blockNumber && b.logIndex > a.logIndex) ? b : a;
  for (const e of events) {
    if (e.kind === 'Accrued') {
      s.accruedCount += 1;
      s.accruedUsdg += big(e.args.amount);
    } else if (e.kind === 'AssetSwept') {
      s.convertedUsdg += big(e.args.usdgIn);
      s.feesUsdg += big(e.args.fee);
    }
    if (e.source === 'SweepExecutor') s.lastKeeper = newer(s.lastKeeper, e);
    if (e.kind === 'Accrued' || e.kind === 'AccountSwept') s.lastCollectOrSweep = newer(s.lastCollectOrSweep, e);
  }
  return s;
}

/** "Running" while a collection or sweep is under 24 h old. */
export const KEEPER_RUNNING_WINDOW_SEC = 24 * 3600;

export function keeperStatus(args: { lastCollectOrSweepAt: number | null; nowSec: number; linkedWallets: number | null }): {
  running: boolean;
  label: string;
} {
  const { lastCollectOrSweepAt, nowSec, linkedWallets } = args;
  if (lastCollectOrSweepAt != null && nowSec - lastCollectOrSweepAt < KEEPER_RUNNING_WINDOW_SEC) {
    return { running: true, label: tf('dispatch.keeper.statusRunning') };
  }
  const n = linkedWallets == null ? '—' : String(linkedWallets);
  return { running: false, label: tf(linkedWallets === 1 ? 'dispatch.keeper.statusStandbyOne' : 'dispatch.keeper.statusStandbyMany', { n }) };
}

/** "3m ago", "5h ago", "2d ago" ("—" when unknown), in the live language. */
export function ago(sec: number | null | undefined, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const d = Math.max(0, Math.floor(nowSec - sec));
  if (d < 60) return tf('common.ago.s', { n: d });
  if (d < 3600) return tf('common.ago.m', { n: Math.floor(d / 60) });
  if (d < 86_400) return tf('common.ago.h', { n: Math.floor(d / 3600) });
  return tf('common.ago.d', { n: Math.floor(d / 86_400) });
}
