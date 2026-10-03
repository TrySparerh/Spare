/**
 * spare_roundup_preview, wallet mode: replay a wallet's real outgoing USDG
 * payments from the last N days under a hypothetical rule.
 *
 * What counts as a payment is the keeper's rule (engine/src/lib/payments.ts +
 * engine/src/keeper/venue.ts): an outgoing USDG Transfer, EXCLUDING transfers
 *   to-zero-address    a burn / redemption
 *   to-account         to the Spare account the wallet feeds
 *   to-linked-wallet   to any wallet linked to that account (incl. itself)
 *   to-spare-contract  to any Spare contract
 *   to-venue           to a Uniswap router / PoolManager, or a canonical v3 pool
 * Each remaining payment is priced with RoundUp.sol math, and the weekly cap
 * is applied over rolling 7 UTC days exactly as SweepExecutor.dayPulled does.
 *
 * Cost bounds, whatever the wallet: logs are filtered by sender (Transfer
 * topic + `from`), scanned newest-first in 2,000,000-block chunks (the
 * keeper's LOGS_MAX_RANGE), and a chunk that hits the provider's result cap
 * is halved, newer half first. One call sends at most REPLAY_MAX_CALLS
 * eth_getLogs, holds at most REPLAY_MAX_TRANSFERS transfers, and checks at
 * most REPLAY_MAX_RECIPIENTS distinct payees for v3 pools (3 eth_calls per 60,
 * so ~32 eth_calls in all). The first bound reached stops the replay at a
 * whole block: `complete` is false, `stoppedBy` names the bound, and every
 * payment from `scannedFromBlock` to the head is in the result.
 */
import { getAddress, isAddress, parseAbi, parseAbiItem, type Abi, type Address, type PublicClient } from 'viem';
import { ruleRegistryAbi } from './abis.js';
import { aggregate3 } from './multicall.js';
import { APPROX_BLOCKS_PER_DAY, VENUE, getBook, type SpareBook } from './book.js';
import { getSpareClient, rpcBusyOf } from './client.js';
import { isMultiplier, isRoundTo, parseUnitsExact, roundUpDelta, SpareInputError, usdg } from './roundup.js';

export const MAX_REPLAY_DAYS = 30;
export const REPLAY_CHUNK_BLOCKS = 2_000_000n;
export const REPLAY_MAX_CALLS = 40;
/** Outgoing transfers one replay holds (two full 10,000-log provider pages). */
export const REPLAY_MAX_TRANSFERS = 20_000;
/** Distinct payees one replay checks for v3 pools: 10 batches of V3_CHECK_BATCH. */
export const REPLAY_MAX_RECIPIENTS = 600;
export const REPLAY_MAX_ROWS = 500;
export const REPLAY_MAX_EXCLUDED = 200;
const V3_CHECK_BATCH = 60;

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Swap venues on 4663 beyond the Spare book (engine/src/chain/constants.ts
 * VENUE + engine/src/keeper/venue.ts KEEPER_EXTRA_VENUE).
 */
export const V3_FACTORY: Address = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
export const REPLAY_VENUE: readonly Address[] = [
  ...Object.values(VENUE),
  V3_FACTORY,
  '0xcaf681a66d020601342297493863e78c959e5cb2', // SwapRouter02
];

export type ExclusionReason = 'to-zero-address' | 'to-account' | 'to-linked-wallet' | 'to-spare-contract' | 'to-venue';

/** engine/src/lib/payments.ts makeClassifier, same order. Pure. */
export function makeClassifier(ctx: { account: string; linkedWallets: Iterable<string>; spareContracts: Iterable<string>; venue: Iterable<string> }) {
  const lc = (xs: Iterable<string>) => new Set([...xs].map((x) => x.toLowerCase()));
  const account = ctx.account.toLowerCase();
  const wallets = lc(ctx.linkedWallets);
  const spare = lc(ctx.spareContracts);
  const venue = lc(ctx.venue);
  return (to: string): ExclusionReason | null => {
    const t = to.toLowerCase();
    if (t === ZERO) return 'to-zero-address';
    if (t === account) return 'to-account';
    if (wallets.has(t)) return 'to-linked-wallet';
    if (spare.has(t)) return 'to-spare-contract';
    if (venue.has(t)) return 'to-venue';
    return null;
  };
}

export interface ReplayPayment {
  amount: bigint;
  blockNumber: bigint;
  /** Unix seconds (estimated from the block height). */
  ts: number;
}

/**
 * Clamp round-ups to a weekly cap over rolling 7 UTC days
 * (SweepExecutor._pulled7d: today and the 6 days before). Oldest first. Pure.
 */
export function applyRollingCap(items: ReadonlyArray<{ delta: bigint; ts: number }>, cap: bigint | null): bigint[] {
  if (cap === null) return items.map((i) => i.delta);
  const byDay = new Map<number, bigint>();
  return items.map((i) => {
    const day = Math.floor(i.ts / 86_400);
    let used = 0n;
    for (let k = 0; k < 7; k++) used += byDay.get(day - k) ?? 0n;
    const room = used >= cap ? 0n : cap - used;
    const got = i.delta < room ? i.delta : room;
    byDay.set(day, (byDay.get(day) ?? 0n) + got);
    return got;
  });
}

const RATE_LIMIT = /too many requests|rate[\s_-]?limit|429/i;
const RESULT_CAP = /exceeds limit|query returned more than|response size|logs matched by query|block range|too many (?:results|logs|blocks)/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Transfer {
  to: Address;
  amount: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
}

const newestFirst = (a: Transfer, b: Transfer) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);

/** The bound that stopped a replay short of its window. */
export type ReplayStop = 'log-reads' | 'transfers' | 'recipients';

/**
 * The transfers read so far. Ranges arrive newest first and each one ends
 * where the last began, so every block in [coveredFrom, head] is in
 * `transfers`, and nothing older is.
 */
class Scan {
  calls = 0;
  readonly transfers: Transfer[] = [];
  coveredFrom: bigint;
  stopped: ReplayStop | null = null;
  constructor(head: bigint) {
    this.coveredFrom = head + 1n;
  }
  /** Take one eth_getLogs from the budget; false (and stopped) once it is spent. */
  spend(): boolean {
    if (this.calls >= REPLAY_MAX_CALLS) {
      this.stopped = 'log-reads';
      return false;
    }
    this.calls++;
    return true;
  }
  /**
   * Add every transfer of [from, coveredFrom - 1]. Past REPLAY_MAX_TRANSFERS
   * it keeps the newest whole blocks that fit and stops the scan.
   */
  add(from: bigint, got: Transfer[]): void {
    const room = REPLAY_MAX_TRANSFERS - this.transfers.length;
    if (got.length <= room) {
      for (const t of got) this.transfers.push(t);
      this.coveredFrom = from;
      return;
    }
    const newest = [...got].sort(newestFirst);
    const cut = newest[room]!.blockNumber; // the newest block that does not fit whole
    for (const t of newest) {
      if (t.blockNumber <= cut) break;
      this.transfers.push(t);
    }
    this.coveredFrom = cut + 1n;
    this.stopped = 'transfers';
  }
}

/** Read [from, to] into `scan`, unless a bound has already stopped it. */
async function fetchRange(client: PublicClient, usdgToken: Address, wallet: Address, from: bigint, to: bigint, scan: Scan, depth = 0): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (scan.stopped || !scan.spend()) return;
    try {
      const logs = await client.getLogs({ address: usdgToken, event: TRANSFER, args: { from: wallet }, fromBlock: from, toBlock: to });
      const out: Transfer[] = [];
      for (const l of logs) {
        if (l.removed || l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
        if (l.blockNumber < from || l.blockNumber > to) continue;
        if (!l.args.from || l.args.from.toLowerCase() !== wallet.toLowerCase() || !l.args.to || l.args.value === undefined) continue;
        out.push({ to: l.args.to, amount: l.args.value, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash });
      }
      scan.add(from, out);
      return;
    } catch (err) {
      // The server-wide log-read cap is full: fail now, a retry here would only queue.
      if (rpcBusyOf(err)) throw err;
      const msg = `${(err as Error)?.message ?? ''} ${(err as { details?: string })?.details ?? ''}`;
      if (RATE_LIMIT.test(msg) && attempt < 3) {
        await sleep(Math.min(8_000, 500 * 2 ** attempt));
        continue;
      }
      if (RESULT_CAP.test(msg) && to > from && depth < 12) {
        const mid = from + (to - from) / 2n;
        // Newer half first, so a bound that stops the scan still covers the most recent payments.
        await fetchRange(client, usdgToken, wallet, mid + 1n, to, scan, depth + 1);
        await fetchRange(client, usdgToken, wallet, from, mid, scan, depth + 1);
        return;
      }
      throw err;
    }
  }
}

export const V3_POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);
export const V3_FACTORY_ABI = parseAbi(['function getPool(address, address, uint24) view returns (address)']);

/**
 * The subset of `addrs` (lower-cased) that are canonical Uniswap v3 pools
 * (engine V3PoolResolver). A recipient whose token0/token1/fee revert is not
 * a pool; an RPC failure fails the replay (multicall.ts), never "not a pool",
 * which would count a swap leg as a payment.
 */
async function v3Pools(client: PublicClient, addrs: readonly string[]): Promise<Set<string>> {
  const all = [...new Set(addrs.map((a) => a.toLowerCase()))];
  // replayRoundUps stops at REPLAY_MAX_RECIPIENTS payees; never check more.
  if (all.length > REPLAY_MAX_RECIPIENTS) throw new Error(`v3 pool check: ${all.length} payees, more than ${REPLAY_MAX_RECIPIENTS}`);
  const pools = new Set<string>();
  for (let i = 0; i < all.length; i += V3_CHECK_BATCH) {
    const slice = all.slice(i, i + V3_CHECK_BATCH);
    const ids = await aggregate3(
      client,
      slice.flatMap((a) => [
        { address: a as Address, abi: V3_POOL_ABI as Abi, functionName: 'token0' },
        { address: a as Address, abi: V3_POOL_ABI as Abi, functionName: 'token1' },
        { address: a as Address, abi: V3_POOL_ABI as Abi, functionName: 'fee' },
      ]),
    );
    const candidates: Array<{ addr: string; t0: Address; t1: Address; fee: number }> = [];
    slice.forEach((addr, k) => {
      const [t0, t1, fee] = [ids[3 * k], ids[3 * k + 1], ids[3 * k + 2]];
      if (t0?.ok && t1?.ok && fee?.ok) candidates.push({ addr, t0: t0.value as Address, t1: t1.value as Address, fee: Number(fee.value) });
    });
    if (!candidates.length) continue;
    const got = await aggregate3(
      client,
      candidates.map((c) => ({ address: V3_FACTORY, abi: V3_FACTORY_ABI as Abi, functionName: 'getPool', args: [c.t0, c.t1, c.fee] })),
    );
    candidates.forEach((c, k) => {
      const r = got[k];
      if (r?.ok && String(r.value).toLowerCase() === c.addr) pools.add(c.addr);
    });
  }
  return pools;
}

const STOP_NOTE: Record<ReplayStop, string> = {
  'log-reads': `Scan budget reached (${REPLAY_MAX_CALLS} log reads)`,
  transfers: `Transfer cap reached (${REPLAY_MAX_TRANSFERS.toLocaleString('en-US')} outgoing transfers read)`,
  recipients: `Payee cap reached (${REPLAY_MAX_RECIPIENTS} distinct payees checked for swap pools)`,
};

export interface ReplayQuery {
  wallet: unknown;
  days?: unknown;
  roundTo: number;
  multiplier: number;
  weeklyCapUsd?: unknown;
}

export async function replayRoundUps(q: ReplayQuery, client: PublicClient = getSpareClient(), book: SpareBook = getBook()) {
  const s = String(q.wallet ?? '').trim();
  if (!isAddress(s, { strict: false })) throw new SpareInputError('wallet must be a 0x address');
  const wallet = getAddress(s.toLowerCase());
  const daysRaw = q.days === undefined || q.days === null || q.days === '' ? 7 : Number(q.days);
  if (!Number.isInteger(daysRaw) || daysRaw < 1 || daysRaw > MAX_REPLAY_DAYS) throw new SpareInputError(`days must be an integer 1..${MAX_REPLAY_DAYS}`);
  if (!isRoundTo(q.roundTo)) throw new SpareInputError(`roundTo must be 1, 5 or 10 (got ${q.roundTo})`);
  if (!isMultiplier(q.multiplier)) throw new SpareInputError(`multiplier must be an integer 1..5 (got ${q.multiplier})`);
  const cap =
    q.weeklyCapUsd === undefined || q.weeklyCapUsd === null || q.weeklyCapUsd === '' ? null : parseUnitsExact(q.weeklyCapUsd, 6, 'weeklyCapUsd');

  const headBlock = await client.getBlock({ blockTag: 'latest' });
  const head = headBlock.number ?? 0n;
  const headTs = Number(headBlock.timestamp);
  const span = BigInt(daysRaw) * APPROX_BLOCKS_PER_DAY;
  const from = head > span ? head - span + 1n : 0n;

  // Exclusion context: the account this wallet feeds (if linked) and its wallets.
  // A revert reads as unlinked; an RPC failure fails the replay.
  const [feeds] = await aggregate3(client, [
    { address: book.contracts.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'accountOf', args: [wallet] },
  ]).then((r) => r.map((x) => (x.ok ? (x.value as Address) : null)));
  const linkedTo = feeds && feeds.toLowerCase() !== ZERO ? getAddress(feeds) : null;
  const account = linkedTo ?? wallet;
  let linked: Address[] = [wallet];
  if (linkedTo) {
    const w = (await client.readContract({ address: book.contracts.RuleRegistry, abi: ruleRegistryAbi, functionName: 'walletsOf', args: [account] })) as Address[];
    linked = [...new Set([wallet, ...w])];
  }
  const classify = makeClassifier({ account, linkedWallets: linked, spareContracts: Object.values(book.contracts), venue: REPLAY_VENUE });

  // Newest-first 2M-block chunks until the window, the log-read budget or the transfer cap runs out.
  const scan = new Scan(head);
  for (let hi = head; hi >= from && !scan.stopped; ) {
    const lo = hi - REPLAY_CHUNK_BLOCKS + 1n > from ? hi - REPLAY_CHUNK_BLOCKS + 1n : from;
    await fetchRange(client, book.external.USDG, wallet, lo, hi, scan);
    if (lo === 0n) break;
    hi = lo - 1n;
  }
  let stoppedBy: ReplayStop | null = scan.stopped;
  let scannedFrom = scan.coveredFrom;

  // Payees the address rules do not exclude are checked for v3 pools, newest
  // first. The payee past REPLAY_MAX_RECIPIENTS stops the replay: its block
  // and every older one are left out, so no payment is counted unchecked.
  const newest = scan.transfers.sort(newestFirst);
  const payees = new Set<string>();
  for (const t of newest) {
    if (classify(t.to) !== null) continue;
    const payee = t.to.toLowerCase();
    if (payees.has(payee)) continue;
    if (payees.size === REPLAY_MAX_RECIPIENTS) {
      scannedFrom = t.blockNumber + 1n;
      stoppedBy = 'recipients';
      break;
    }
    payees.add(payee);
  }
  const kept = newest.filter((t) => t.blockNumber >= scannedFrom);
  const open = kept.filter((t) => classify(t.to) === null);
  const pools = open.length ? await v3Pools(client, open.map((t) => t.to)) : new Set<string>();
  const tsOf = (b: bigint) => headTs - Number(head - b) / 10; // ~10 blocks/s; estimate only
  const complete = stoppedBy === null;

  const oldestFirst = kept.reverse();
  const payments: Array<Transfer & { delta: bigint; ts: number }> = [];
  const excluded: Array<{ txHash: string; block: string; to: string; amount: string; reason: ExclusionReason }> = [];
  for (const t of oldestFirst) {
    const reason = classify(t.to) ?? (pools.has(t.to.toLowerCase()) ? 'to-venue' : null);
    if (reason) {
      excluded.push({ txHash: t.txHash, block: t.blockNumber.toString(), to: t.to, amount: usdg(t.amount), reason });
      continue;
    }
    payments.push({ ...t, delta: roundUpDelta(t.amount, q.roundTo, q.multiplier), ts: tsOf(t.blockNumber) });
  }
  const pulled = applyRollingCap(payments, cap);
  const total = payments.reduce((s, p) => s + p.delta, 0n);
  const cappedTotal = pulled.reduce((s, p) => s + p, 0n);

  const rows = payments
    .map((p, i) => ({
      amount: usdg(p.amount),
      roundUp: usdg(p.delta),
      ...(cap !== null ? { collectedUnderCap: usdg(pulled[i]!) } : {}),
      onBoundary: p.delta === 0n,
      txHash: p.txHash,
      block: p.blockNumber.toString(),
      time: new Date(p.ts * 1000).toISOString(),
      timeEstimated: true,
    }))
    .reverse(); // newest first

  return {
    mode: 'wallet' as const,
    wallet,
    account: linkedTo,
    linkedWallets: linkedTo ? linked : [],
    rule: { roundTo: q.roundTo, multiplier: q.multiplier },
    window: {
      days: daysRaw,
      fromBlock: from.toString(),
      toBlock: head.toString(),
      scannedFromBlock: (scannedFrom > head ? head : scannedFrom).toString(),
      complete,
      stoppedBy,
      getLogsCalls: scan.calls,
    },
    payments: payments.length,
    rows: rows.slice(0, REPLAY_MAX_ROWS),
    rowsTruncated: rows.length > REPLAY_MAX_ROWS,
    totalUsd: usdg(total),
    weeklyCapUsd: cap === null ? null : usdg(cap),
    cappedTotalUsd: usdg(cappedTotal),
    droppedByCapUsd: usdg(total - cappedTotal),
    excluded: excluded.reverse().slice(0, REPLAY_MAX_EXCLUDED),
    excludedCount: excluded.length,
    formula: 'per payment: delta = amount % step == 0 ? 0 : (step - amount % step) * multiplier; step = roundTo * 1e6',
    source: 'contracts/src/libraries/RoundUp.sol; exclusions: engine/src/lib/payments.ts',
    notes: [
      'A replay under the rule you pass. It is not what Spare collected: real collection starts when a wallet is linked with a rule on, needs the Permit2 approval, and is clamped by allowance and balance too.',
      'The weekly cap is applied over rolling 7 UTC days (SweepExecutor.dayPulled). Times are estimated from block heights (~10 blocks/s).',
      stoppedBy ? `${STOP_NOTE[stoppedBy]}: payments before block ${scannedFrom} are not included.` : null,
    ].filter(Boolean),
  };
}
