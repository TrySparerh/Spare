/**
 * On-chain activity for one SPARE account, straight from event logs.
 *
 * One eth_getLogs per chunk covers SweepExecutor, CashPark, RuleRegistry and
 * ElectionRegistry at once: every per-account event in those contracts has the
 * account as its FIRST indexed argument, so `topics: [null, account]` selects
 * exactly this account's events. Decoded names are whitelisted, which drops
 * the rare admin event whose first indexed arg happens to be the same address.
 *
 * Chunks are ≤ 50,000 blocks. Robinhood Chain produces ~10 blocks/s, so a
 * week is ~6M blocks (~121 chunks); the app scans the last 7 days first and
 * pages older weeks on demand, never before the deployment's startBlock.
 */
import {
  BaseError,
  HttpRequestError,
  decodeEventLog,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  pad,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { isMultiplier, isRoundTo, roundUpDelta } from '@/lib/spare';
import { cashParkAbi, electionRegistryAbi, ruleRegistryAbi, sweepExecutorAbi } from './abis';
import { EXTERNAL, SPARE, START_BLOCK, sameAddress } from './addresses';

export const BLOCKS_PER_SECOND = 10n;
export const WEEK_BLOCKS = 7n * 24n * 3600n * BLOCKS_PER_SECOND;
export const MAX_LOG_RANGE = 50_000n;
/**
 * Range for NARROW filters (one event or one sender, one account): results
 * stay tiny, and the public RPC answers 2M-block ranges; a range complaint
 * still halves it.
 */
export const NARROW_LOG_RANGE = 1_000_000n;
const MIN_LOG_RANGE = 1_000n;
const CONCURRENCY = 4;

/** Events that describe something that happened to the account. */
export const ACTIVITY_EVENTS = {
  SweepExecutor: ['Accrued', 'AccrualSkipped', 'AccountSwept', 'Delivered', 'DeliveryHeld', 'Deferred', 'SafeSettled', 'Claimed'],
  CashPark: ['Credited', 'Returned', 'WithdrawnForSweep', 'Exited', 'ExitUnitsKept'],
  RuleRegistry: ['RuleSet', 'Linked', 'Unlinked'],
  ElectionRegistry: ['MixSet', 'MixCleared'],
} as const;

type Source = keyof typeof ACTIVITY_EVENTS;

const SOURCES: { source: Source; address: Address; abi: Abi }[] = [
  { source: 'SweepExecutor', address: SPARE.SweepExecutor, abi: sweepExecutorAbi as unknown as Abi },
  { source: 'CashPark', address: SPARE.CashPark, abi: cashParkAbi as unknown as Abi },
  { source: 'RuleRegistry', address: SPARE.RuleRegistry, abi: ruleRegistryAbi as unknown as Abi },
  { source: 'ElectionRegistry', address: SPARE.ElectionRegistry, abi: electionRegistryAbi as unknown as Abi },
];

export interface ActivityEvent {
  id: string;
  source: Source;
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hash;
}

/** Per-asset outcome of a netted sweep, read from the sweep tx's receipt. */
export interface AssetFill {
  asset: Address;
  kind: 'swept' | 'deferred';
  usdgIn: bigint;
  fee: bigint;
  tokensOut: bigint;
}

/** Aligned chunk boundaries [k*size, (k+1)*size-1] clipped to [from, to], ascending. */
export function chunkRange(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  if (size <= 0n) throw new RangeError('chunk size must be positive');
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

/** The window to scan below `before` (exclusive): one week, floored at startBlock. */
export function olderWindow(before: bigint, startBlock: bigint = START_BLOCK): { from: bigint; to: bigint } | null {
  const to = before - 1n;
  if (to < startBlock) return null;
  const from = to - WEEK_BLOCKS + 1n;
  return { from: from < startBlock ? startBlock : from, to };
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

function decode(log: RpcLog): ActivityEvent | null {
  if (log.removed || !log.blockNumber || !log.transactionHash || log.logIndex == null) return null;
  const src = SOURCES.find((s) => sameAddress(s.address, log.address));
  if (!src) return null;
  try {
    const d = decodeEventLog({ abi: src.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (!(ACTIVITY_EVENTS[src.source] as readonly string[]).includes(d.eventName)) return null;
    const logIndex = Number(BigInt(log.logIndex));
    return {
      id: `${log.transactionHash}:${logIndex}`,
      source: src.source,
      name: d.eventName,
      args: (d.args ?? {}) as Record<string, unknown>,
      blockNumber: BigInt(log.blockNumber),
      logIndex,
      txHash: log.transactionHash,
    };
  } catch {
    return null;
  }
}

/**
 * A provider refusing because the RESULT (or the range) is too big — the only
 * case where splitting the range helps. Rate limits are deliberately NOT here:
 * a throttled request split in two is just two throttled requests.
 */
const RESULT_CAP = /exceeds limit|query returned more than|response size|logs matched by query|block range|range (is )?too (large|wide)/i;
const RATE_LIMIT = /too many requests|rate[ -]?limit|request limit/i;
const RATE_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorText(e: unknown): string {
  if (e instanceof BaseError) {
    const parts: string[] = [];
    e.walk((x) => {
      const m = (x as { message?: unknown }).message;
      if (typeof m === 'string') parts.push(m);
      const d = (x as { details?: unknown }).details;
      if (typeof d === 'string') parts.push(d);
      return false;
    });
    return parts.join(' | ');
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * HTTP 429, a JSON-RPC 429, a -32005 that is not a result cap, or a "too many
 * requests / rate limit" message anywhere in the error chain.
 */
export function isRateLimited(e: unknown): boolean {
  const text = errorText(e);
  const hit = (x: unknown): boolean => {
    if (x instanceof HttpRequestError && x.status === 429) return true;
    const code = (x as { code?: unknown } | null)?.code;
    if (code === 429) return true;
    if (code === -32005 && !RESULT_CAP.test(text)) return true;
    return false;
  };
  if (e instanceof BaseError ? !!e.walk(hit) : hit(e)) return true;
  return RATE_LIMIT.test(text);
}

/** The server's Retry-After (seconds or an HTTP date), in ms, if it sent one. */
function retryAfterMs(e: unknown): number | null {
  const http = e instanceof BaseError ? (e.walk((x) => x instanceof HttpRequestError) as HttpRequestError | null) : null;
  const raw = http?.headers?.get('Retry-After');
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function isResultCap(e: unknown): boolean {
  return !isRateLimited(e) && RESULT_CAP.test(errorText(e));
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

interface LogFilter {
  address: Address | Address[];
  topics: (Hex | Hex[] | null)[];
}

/**
 * eth_getLogs over [from, to] with three distinct failure paths:
 *   rate limited  → wait (Retry-After, else exponential + jitter) and retry the SAME range
 *   result capped → halve the range and retry, down to a floor
 *   anything else → two gentle retries, then give up
 */
async function getLogsRange(
  client: PublicClient,
  filter: LogFilter,
  from: bigint,
  to: bigint,
  signal?: AbortSignal,
  attempt = 0,
): Promise<RpcLog[]> {
  if (signal?.aborted) throw abortError();
  try {
    return (await client.request({
      method: 'eth_getLogs',
      params: [{ address: filter.address, fromBlock: toHex(from), toBlock: toHex(to), topics: filter.topics }],
    } as never)) as RpcLog[];
  } catch (e) {
    if (signal?.aborted) throw abortError();
    const span = to - from + 1n;
    if (isRateLimited(e)) {
      if (attempt >= RATE_RETRIES) throw e;
      const backoff = Math.min(15_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      await sleep(Math.max(retryAfterMs(e) ?? 0, backoff));
      return getLogsRange(client, filter, from, to, signal, attempt + 1);
    }
    if (isResultCap(e) && span > MIN_LOG_RANGE) {
      const mid = from + span / 2n;
      const a = await getLogsRange(client, filter, from, mid - 1n, signal);
      const b = await getLogsRange(client, filter, mid, to, signal);
      return [...a, ...b];
    }
    if (attempt < 2) {
      await sleep(600 * (attempt + 1));
      return getLogsRange(client, filter, from, to, signal, attempt + 1);
    }
    throw e;
  }
}

async function logsForChunk(client: PublicClient, account: Address, from: bigint, to: bigint, signal?: AbortSignal): Promise<ActivityEvent[]> {
  const logs = await getLogsRange(
    client,
    { address: SOURCES.map((s) => s.address), topics: [null, pad(account.toLowerCase() as Hex, { size: 32 })] },
    from,
    to,
    signal,
  );
  return logs.map(decode).filter((e): e is ActivityEvent => e !== null);
}

/** Run `fn` over items with at most `limit` in flight; results keep item order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Every activity event for `account` in [from, to], newest first.
 * `onProgress(done, total)` fires per chunk; `signal` aborts between chunks.
 */
export async function scanAccountActivity(
  client: PublicClient,
  account: Address,
  from: bigint,
  to: bigint,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<ActivityEvent[]> {
  // Newest chunks first, so the rows a user most wants arrive first.
  const chunks = chunkRange(from, to, MAX_LOG_RANGE).reverse();
  let done = 0;
  opts.onProgress?.(0, chunks.length);
  const parts = await mapLimit(chunks, CONCURRENCY, async (c) => {
    if (opts.signal?.aborted) throw abortError();
    const events = await logsForChunk(client, account, c.from, c.to, opts.signal);
    done += 1;
    opts.onProgress?.(done, chunks.length);
    return events;
  });
  return sortNewestFirst(parts.flat());
}

export function sortNewestFirst(events: ActivityEvent[]): ActivityEvent[] {
  return events.sort((a, b) =>
    a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
  );
}

/**
 * Hide CashPark bookkeeping that an executor event in the SAME tx already
 * tells: Credited (= Accrued), Returned (= Deferred), WithdrawnForSweep
 * (= AccountSwept). A CashPark event with no executor twin is kept.
 */
export function dedupeBookkeeping(events: ActivityEvent[]): ActivityEvent[] {
  const byTx = new Map<string, Set<string>>();
  for (const e of events) {
    const s = byTx.get(e.txHash) ?? new Set<string>();
    s.add(e.name);
    byTx.set(e.txHash, s);
  }
  const twin: Record<string, string> = { Credited: 'Accrued', Returned: 'Deferred', WithdrawnForSweep: 'AccountSwept' };
  return events.filter((e) => !(e.source === 'CashPark' && twin[e.name] && byTx.get(e.txHash)?.has(twin[e.name])));
}

/** Per-asset AssetSwept / SwapDeferred from one sweep transaction's receipt. */
export async function fillsForTx(client: PublicClient, hash: Hash): Promise<AssetFill[]> {
  const receipt = await client.getTransactionReceipt({ hash });
  const out: AssetFill[] = [];
  for (const raw of receipt.logs) {
    const log = raw as unknown as { address: Address; data: Hex; topics: [Hex, ...Hex[]] };
    if (!sameAddress(log.address, SPARE.SweepExecutor)) continue;
    try {
      const d = decodeEventLog({ abi: sweepExecutorAbi as unknown as Abi, data: log.data, topics: log.topics }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      const a = d.args;
      if (d.eventName === 'AssetSwept') {
        out.push({ asset: a.asset as Address, kind: 'swept', usdgIn: a.usdgIn as bigint, fee: a.fee as bigint, tokensOut: a.tokensOut as bigint });
      } else if (d.eventName === 'SwapDeferred') {
        out.push({ asset: a.asset as Address, kind: 'deferred', usdgIn: a.usdg as bigint, fee: 0n, tokensOut: 0n });
      }
    } catch {
      /* not an executor event we render */
    }
  }
  return out;
}

const blockTimeCache = new Map<bigint, number>();

/** Unix seconds for each block, cached for the session. */
export async function blockTimes(client: PublicClient, blocks: bigint[]): Promise<Map<bigint, number>> {
  const missing = [...new Set(blocks)].filter((b) => !blockTimeCache.has(b));
  await mapLimit(missing, 6, async (b) => {
    const blk = await client.getBlock({ blockNumber: b });
    blockTimeCache.set(b, Number(blk.timestamp));
  });
  const out = new Map<bigint, number>();
  for (const b of blocks) {
    const t = blockTimeCache.get(b);
    if (t != null) out.set(b, t);
  }
  return out;
}

/* --------------------------- this epoch's sweep ---------------------------- */

/** What one account's sweep actually did, from the sweep transaction's receipt. */
export interface SweepOutcome {
  txHash: Hash;
  blockNumber: bigint;
  epoch: bigint;
  /** USDG withdrawn from the park for the sweep (AccountSwept.usdg). */
  withdrawn: bigint;
  /** USDG that came straight back to the park (Deferred). */
  deferred: bigint;
  /** USDG paid out as USDG because a leg was delisted (SafeSettled). */
  safeSettled: bigint;
  /** withdrawn − deferred: what really left the park (bought or safe-settled). */
  settled: bigint;
  deferredLegs: { asset: Address; usdg: bigint; status: number }[];
}

/** Per-account view of one sweep receipt. Pure. */
export function sweepOutcomeFromLogs(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  account: Address,
  txHash: Hash,
  blockNumber: bigint,
): SweepOutcome | null {
  let found: { epoch: bigint; usdg: bigint } | null = null;
  let deferred = 0n;
  let safeSettled = 0n;
  const deferredLegs: SweepOutcome['deferredLegs'] = [];
  for (const log of logs) {
    if (!sameAddress(log.address, SPARE.SweepExecutor) || log.topics.length === 0) continue;
    let d: { eventName: string; args: Record<string, unknown> };
    try {
      d = decodeEventLog({ abi: sweepExecutorAbi as unknown as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as typeof d;
    } catch {
      continue;
    }
    if (!sameAddress(d.args.account as string | undefined, account)) continue;
    if (d.eventName === 'AccountSwept') {
      found = { epoch: d.args.epoch as bigint, usdg: d.args.usdg as bigint };
    } else if (d.eventName === 'Deferred') {
      deferred += d.args.usdg as bigint;
      deferredLegs.push({ asset: d.args.asset as Address, usdg: d.args.usdg as bigint, status: Number(d.args.status) });
    } else if (d.eventName === 'SafeSettled') {
      safeSettled += d.args.usdg as bigint;
    }
  }
  if (!found) return null;
  return {
    txHash,
    blockNumber,
    epoch: found.epoch,
    withdrawn: found.usdg,
    deferred,
    safeSettled,
    settled: found.usdg > deferred ? found.usdg - deferred : 0n,
    deferredLegs,
  };
}

/**
 * The account's sweep in `epoch`, if one happened in [fromBlock, toBlock].
 * Scans AccountSwept(account) newest-first and stops at the first hit, then
 * reads that transaction's receipt for the per-leg outcome.
 */
export async function findEpochSweep(
  client: PublicClient,
  account: Address,
  epoch: bigint,
  fromBlock: bigint,
  toBlock: bigint,
  signal?: AbortSignal,
): Promise<SweepOutcome | null> {
  const topics = encodeEventTopics({ abi: sweepExecutorAbi as unknown as Abi, eventName: 'AccountSwept', args: { account } } as never) as Hex[];
  const lo = fromBlock < START_BLOCK ? START_BLOCK : fromBlock;
  for (const c of chunkRange(lo, toBlock, NARROW_LOG_RANGE).reverse()) {
    const logs = await getLogsRange(client, { address: SPARE.SweepExecutor, topics }, c.from, c.to, signal);
    const hits = logs
      .map(decode)
      .filter((e): e is ActivityEvent => e !== null && e.name === 'AccountSwept' && (e.args.epoch as bigint) === epoch);
    if (hits.length === 0) continue;
    const hit = sortNewestFirst(hits)[0];
    const receipt = await client.getTransactionReceipt({ hash: hit.txHash });
    return sweepOutcomeFromLogs(
      receipt.logs as unknown as { address: Address; data: Hex; topics: Hex[] }[],
      account,
      hit.txHash,
      hit.blockNumber,
    );
  }
  return null;
}

/* ------------------------- round-ups NOT collected -------------------------- */

/**
 * Swap-venue addresses the keeper's payment classifier treats as "not a
 * payment". MUST mirror engine/src/chain/constants.ts VENUE.
 */
export const KEEPER_VENUE: readonly Address[] = [
  '0x8366a39cc670b4001a1121b8f6a443a643e40951', // v4 PoolManager
  '0x58daec3116aae6d93017baaea7749052e8a04fa7', // v4 PositionManager
  '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', // v4 StateView
  '0x8dc178efb8111bb0973dd9d722ebeff267c98f94', // v4 Quoter
  '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', // v3 factory
  '0xcaf681a66d020601342297493863e78c959e5cb2', // SwapRouter02
].map((a) => getAddress(a));

/** Lower-cased set of recipients whose incoming USDG is not spending (keeper classifier). */
export function exclusionSet(account: Address, linkedWallets: Iterable<string>): Set<string> {
  const out = new Set<string>([zeroAddress, account.toLowerCase()]);
  for (const w of linkedWallets) out.add(w.toLowerCase());
  for (const a of Object.values(SPARE)) out.add(a.toLowerCase());
  for (const a of KEEPER_VENUE) out.add(a.toLowerCase());
  return out;
}

export interface WalletTransfer {
  to: Address;
  amount: bigint;
  blockNumber: bigint;
}

/** What the keeper should have priced for one Accrued window. */
export interface AccrualAudit {
  /** Outgoing USDG transfers in the window that count as payments. */
  payments: number;
  /** Round-up owed for them under the rule in force. */
  due: bigint;
}

export interface AuditRule {
  roundTo: number;
  multiplier: number;
}

/**
 * Re-price each Accrued window (fromBlock, toBlock] from the wallet's outgoing
 * USDG transfers — the same sum the keeper works out before clamping to the
 * weekly cap, the Permit2 allowance and the wallet's balance. A window whose
 * rule is unknown is left out rather than guessed.
 */
export function priceAccrualWindows(
  accruals: readonly ActivityEvent[],
  transfersByWallet: ReadonlyMap<string, readonly WalletTransfer[]>,
  excluded: ReadonlySet<string>,
  ruleAt: (block: bigint) => AuditRule | null,
): Map<string, AccrualAudit> {
  const out = new Map<string, AccrualAudit>();
  for (const e of accruals) {
    if (e.name !== 'Accrued') continue;
    const wallet = String(e.args.wallet ?? '').toLowerCase();
    const list = transfersByWallet.get(wallet);
    const rule = ruleAt(e.blockNumber);
    if (!list || !rule || !isRoundTo(rule.roundTo) || !isMultiplier(rule.multiplier)) continue;
    const from = e.args.fromBlock as bigint;
    const to = e.args.toBlock as bigint;
    let payments = 0;
    let due = 0n;
    for (const t of list) {
      if (t.blockNumber <= from || t.blockNumber > to) continue;
      if (excluded.has(t.to.toLowerCase())) continue;
      payments += 1;
      due += roundUpDelta(t.amount, rule.roundTo, rule.multiplier);
    }
    out.set(e.id, { payments, due });
  }
  return out;
}

/** Outgoing USDG transfers of `wallet` in [from, to]. */
export async function usdgTransfersFrom(
  client: PublicClient,
  wallet: Address,
  from: bigint,
  to: bigint,
  signal?: AbortSignal,
): Promise<WalletTransfer[]> {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: wallet } }) as Hex[];
  const out: WalletTransfer[] = [];
  for (const c of chunkRange(from, to, NARROW_LOG_RANGE)) {
    const logs = await getLogsRange(client, { address: EXTERNAL.USDG, topics }, c.from, c.to, signal);
    for (const l of logs) {
      if (l.removed || !l.blockNumber) continue;
      try {
        const d = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        out.push({ to: d.args.to, amount: d.args.value, blockNumber: BigInt(l.blockNumber) });
      } catch {
        /* not a standard Transfer */
      }
    }
  }
  return out;
}

/**
 * Fetch each wallet's outgoing USDG over the union of its Accrued windows and
 * price every window. Windows that could not be checked are simply absent.
 */
export async function auditAccruals(
  client: PublicClient,
  accruals: readonly ActivityEvent[],
  excluded: ReadonlySet<string>,
  ruleAt: (block: bigint) => AuditRule | null,
  signal?: AbortSignal,
): Promise<Map<string, AccrualAudit>> {
  const spans = new Map<string, { wallet: Address; from: bigint; to: bigint }>();
  for (const e of accruals) {
    if (e.name !== 'Accrued') continue;
    const wallet = e.args.wallet as Address;
    const from = (e.args.fromBlock as bigint) + 1n;
    const to = e.args.toBlock as bigint;
    if (to < from) continue;
    const k = wallet.toLowerCase();
    const cur = spans.get(k);
    spans.set(k, cur ? { wallet, from: from < cur.from ? from : cur.from, to: to > cur.to ? to : cur.to } : { wallet, from, to });
  }
  const byWallet = new Map<string, WalletTransfer[]>();
  await mapLimit([...spans.entries()], 2, async ([k, s]) => {
    try {
      byWallet.set(k, await usdgTransfersFrom(client, s.wallet, s.from, s.to, signal));
    } catch (e) {
      if (signal?.aborted) throw e;
      /* leave this wallet unchecked */
    }
  });
  return priceAccrualWindows(accruals, byWallet, excluded, ruleAt);
}
