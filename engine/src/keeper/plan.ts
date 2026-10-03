/**
 * Pure planning math for the keeper — mirrors SweepExecutor operation for
 * operation, so what the keeper expects is what the contract will do.
 */
import type { Address } from "viem";
import { roundUpDelta } from "../lib/roundup.ts";

/** SweepExecutor._accrue: the window a wallet may accrue next is (from, toBlock]. */
export function accrualFrom(lastAccrued: bigint, linkedAt: bigint, activeSince: bigint): bigint {
  let from = lastAccrued;
  if (linkedAt > from) from = linkedAt;
  if (activeSince > from) from = activeSince;
  return from;
}

/** Newest block the executor will accept as `toBlock` given the head we saw. */
export function safeToBlock(head: bigint, finalityBuffer: bigint, margin: bigint): bigint {
  const t = head - finalityBuffer - margin;
  return t > 0n ? t : 0n;
}

/** Clamp a computed round-up to every bound the pull must respect. */
export function clampAccrual(delta: bigint, bounds: readonly bigint[]): bigint {
  let a = delta;
  for (const b of bounds) if (b < a) a = b;
  return a < 0n ? 0n : a;
}

export interface Leg {
  asset: Address;
  bps: number;
}

/** SweepExecutor._collect: split `got` across the mix; the last leg takes the remainder. */
export function splitMix(got: bigint, mix: readonly Leg[]): { asset: Address; usdg: bigint }[] {
  const out: { asset: Address; usdg: bigint }[] = [];
  let left = got;
  mix.forEach((leg, i) => {
    const amt = i === mix.length - 1 ? left : (got * BigInt(leg.bps)) / 10_000n;
    left -= amt;
    out.push({ asset: leg.asset, usdg: amt });
  });
  return out;
}

/** The fee is taken before the swap: swapIn = total - total*feeBps/10000. */
export function swapInFor(total: bigint, feeBps: bigint): bigint {
  return total - (total * feeBps) / 10_000n;
}

/**
 * Limit for `sweep`: minimum asset tokens per 1 USDG, from a same-block quote
 * of the exact netted swap, less `toleranceBps`. The contract recomputes
 * minOut = swapIn * minOutPerUsdg / 1e6, so this floors at every step.
 */
export function limitFromQuote(swapIn: bigint, quotedOut: bigint, toleranceBps: bigint): bigint {
  if (swapIn === 0n || quotedOut === 0n) return 0n;
  return (quotedOut * 1_000_000n * (10_000n - toleranceBps)) / 10_000n / swapIn;
}

// ── consent ─────────────────────────────────────────────────────────────

/**
 * A pull needs BOTH approvals: the USDG ERC-20 allowance to Permit2 and a live
 * Permit2 allowance to the executor. Reading only the second one made the
 * keeper re-send a pull that always reverted inside Permit2 (calls-01).
 */
export function hasConsent(p: {
  erc20Allowance: bigint;
  permit2Amount: bigint;
  permit2Expiration: bigint;
  now: bigint;
  safetySeconds: bigint;
}): boolean {
  return p.erc20Allowance > 0n && p.permit2Amount > 0n && p.permit2Expiration > p.now + p.safetySeconds;
}

/**
 * What a pull could take from a wallet now: the least of its USDG balance,
 * its Permit2 allowance to the executor, its USDG allowance to Permit2 and
 * the account's weekly-cap room; 0 without consent. A wallet at 0 cannot be
 * pulled, so the keeper does not scan it every tick (keeper.ts step 3).
 */
export function pullableNow(p: {
  consent: boolean;
  balance: bigint;
  permit2Amount: bigint;
  erc20Allowance: bigint;
  capRoom: bigint;
}): bigint {
  if (!p.consent) return 0n;
  return clampAccrual(p.balance, [p.permit2Amount, p.erc20Allowance, p.capRoom]);
}

// ── rule in force at a payment (calls-03) ───────────────────────────────

/** One RuleRegistry.RuleSet event. */
export interface RuleEvent {
  blockNumber: bigint;
  logIndex: number;
  roundTo: number;
  multiplier: number;
  weeklyCap: bigint;
  enabled: boolean;
}

type Pos = { blockNumber: bigint; logIndex: number };

function before(a: Pos, b: Pos): boolean {
  return a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex);
}

/** Insert keeping (blockNumber, logIndex) order; a duplicate position is ignored. */
export function insertRuleEvent(history: RuleEvent[], ev: RuleEvent): void {
  let i = history.length;
  while (i > 0 && before(ev, history[i - 1]!)) i--;
  const prev = history[i - 1];
  if (prev && prev.blockNumber === ev.blockNumber && prev.logIndex === ev.logIndex) return;
  history.splice(i, 0, ev);
}

/** The latest RuleSet strictly before (blockNumber, logIndex), or null. `history` is sorted. */
export function ruleAt(history: readonly RuleEvent[], blockNumber: bigint, logIndex: number): RuleEvent | null {
  const pos = { blockNumber, logIndex };
  let lo = 0;
  let hi = history.length; // first index NOT before `pos`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(history[mid]!, pos)) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? history[lo - 1]! : null;
}

export class UnpricedPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpricedPaymentError";
  }
}

/**
 * Round-up for one payment with the rule in force when it was made, not the
 * rule at tick time. A disabled or zero-cap rule prices it at 0. No RuleSet
 * before the payment means the keeper's rule history is incomplete: refuse
 * (throw) rather than guess, so nothing is pulled or advanced on a wrong price.
 */
export function priceAt(history: readonly RuleEvent[], t: { amount: bigint; blockNumber: bigint; logIndex: number }): bigint {
  const r = ruleAt(history, t.blockNumber, t.logIndex);
  if (!r) throw new UnpricedPaymentError(`no RuleSet before block ${t.blockNumber} log ${t.logIndex}`);
  if (!r.enabled || r.weeklyCap === 0n) return 0n;
  return roundUpDelta(t.amount, r.roundTo, r.multiplier);
}

// ── what to do with a wallet's window ───────────────────────────────────

export type AccrualDecision =
  | { kind: "pull"; amount: bigint }
  | { kind: "advance" }
  | { kind: "hold"; reason: "narrow" | "no-consent" | "clamped-to-zero" };

/**
 * - pull:    consent, and something left to collect after every clamp.
 * - advance: a 0-amount accrual, ONLY for a truly idle window (delta == 0)
 *            that has grown wide. It moves the cursor past nothing.
 * - hold:    everything else. A window holding real round-ups is never
 *            zero-advanced (that forfeited them for good); it waits for
 *            consent, balance or cap room.
 */
export function decideAccrual(p: { consent: boolean; delta: bigint; bounds: readonly bigint[]; wide: boolean }): AccrualDecision {
  if (p.delta === 0n) return p.wide ? { kind: "advance" } : { kind: "hold", reason: "narrow" };
  if (!p.consent) return { kind: "hold", reason: "no-consent" };
  const amount = clampAccrual(p.delta, p.bounds);
  return amount > 0n ? { kind: "pull", amount } : { kind: "hold", reason: "clamped-to-zero" };
}

/** Exponential per-wallet backoff: base, 2*base, 4*base, ... capped at max. */
export function nextBackoffMs(failures: number, baseMs: number, maxMs: number): number {
  const n = Math.max(1, failures);
  return Math.min(baseMs * 2 ** Math.min(n - 1, 30), maxMs);
}

/** A clean scan may double its span only if it spent at most this share of every budget limit. */
export const SCAN_GROW_AT = 0.5;

/**
 * Blocks a wallet's next scan may cover. A scan that overran its budget is
 * retried over half the range (never below `min`), so a busy wallet still
 * moves forward a slice at a time. A clean scan doubles back toward `max`
 * only when it covered its whole span (`blocks`) on at most SCAN_GROW_AT of
 * its budget (`used`: the largest share of any limit it spent); otherwise the
 * span is kept. Doubling a span that only just fit overran on the next tick,
 * so a busy wallet alternated overrun, backoff and one clean slice instead of
 * settling on the largest span it can scan every tick.
 */
export function nextScanSpan(span: bigint, scan: { ok: false } | { ok: true; blocks: bigint; used: number }, min: bigint, max: bigint): bigint {
  const next = !scan.ok ? span / 2n : scan.blocks >= span && scan.used <= SCAN_GROW_AT ? span * 2n : span;
  return next < min ? min : next > max ? max : next;
}

// ── gas limits for keeper transactions ──────────────────────────────────

/**
 * Gas limit as a percentage of eth_estimateGas, one step per out-of-gas sign
 * (keeper.ts): 1.5x to start, then 2x, then 3x. The executor catches a failed
 * entry: accrueBatch wraps each wallet in `try this.accrueSelf` and sweep each
 * swap in `try router.buy`, and the 1/64 of gas EIP-150 keeps back from a call
 * is enough to emit the skip and return. So a limit that is barely short does
 * not revert; it SUCCEEDS with the accrual skipped (AccrualSkipped, empty
 * reason) or the swap deferred (SwapDeferred, empty reason; the epoch is
 * consumed). eth_estimateGas binary-searches for the least gas that does not
 * revert, and that can be exactly this path: on a mainnet fork (MockArbSys at
 * 0x64), a new wallet's first pull alone in a batch estimated 271,957 gas,
 * inside a 4,008-gas window below the 275,965 its accrual needs, and the tx
 * succeeded with the entry skipped. On Nitro an L1-fee rise between estimate
 * and inclusion also eats into a bare estimate. Nitro charges gas used, not
 * the limit, so the headroom is free unless used.
 */
export const GAS_STEPS_PCT = [150, 200, 300] as const;

/**
 * What an accrueBatch needs at least, whatever the estimate says: a base plus
 * a pull (Permit2 transfer, CashPark credit, cap bookkeeping) or a zero-amount
 * advance per entry, so that the floor alone covers a batch even if an
 * estimate lands deep in a skip path. Measured on a mainnet fork (gas limit a
 * batch needs to accrue every entry): a new wallet's first pull 275,965 (cold
 * slots), a returning wallet's 258,578, four new wallets 749,733; a zero
 * advance 64,467. On 4663 a one-entry advance used 75-81k.
 */
export const ACCRUE_GAS = { base: 100_000n, pull: 200_000n, advance: 50_000n } as const;

/** Never ask for more than this (Nitro caps a transaction at 32M gas). */
export const TX_GAS_CAP = 30_000_000n;

/** The floor an accrueBatch's limit never goes below, from its entries' amounts. */
export function accrueGasFloor(amounts: readonly bigint[]): bigint {
  return amounts.reduce((g, a) => g + (a > 0n ? ACCRUE_GAS.pull : ACCRUE_GAS.advance), ACCRUE_GAS.base);
}

/** max(estimate x pct / 100, floor), capped at `cap` (but never below the estimate itself). */
export function gasLimit(p: { estimate: bigint; pct: number; floor?: bigint; cap?: bigint }): bigint {
  const want = (p.estimate * BigInt(p.pct) + 99n) / 100n;
  const g = p.floor !== undefined && p.floor > want ? p.floor : want;
  const cap = p.cap ?? TX_GAS_CAP;
  if (g <= cap) return g;
  return p.estimate > cap ? p.estimate : cap;
}

// ── sweep planning ──────────────────────────────────────────────────────

/**
 * ok     -> eligible, oracle OK, market open: quote and buy it.
 * settle -> not eligible (deactivated): the executor safe-settles the leg to
 *           USDG before any oracle or limit check, so it needs no quote and
 *           must not block the account.
 * wait   -> eligible but "not now" (oracle status != OK, market closed, or a
 *           multiplier change the feed has not caught up with).
 */
export type LegState = "ok" | "settle" | "wait";

export function assetState(p: { eligible: boolean; oracleStatus: number; marketOpen: boolean; splitPending?: boolean }): LegState {
  if (!p.eligible) return "settle";
  if (p.oracleStatus !== 0 || !p.marketOpen || p.splitPending === true) return "wait";
  return "ok";
}

/** Seconds before a scheduled multiplier change at which the keeper stops buying the asset. */
export const SPLIT_LEAD_SEC = 900;

/**
 * ERC-8056 corporate actions (splits, dividend re-invests). Balances never
 * rebase; the token's uiMultiplier moves to newUIMultiplier at effectiveAt,
 * and the Chainlink feed quotes the multiplier-adjusted price. OracleGuard
 * reads neither field, so from effectiveAt until the feed's next post the
 * router would price a fill with the OLD multiplier. Wait while a change is
 * in force and the feed has not posted since it took effect, and from
 * `leadSec` before a scheduled change (a sweep quoted before it could land
 * after it). After effectiveAt the token reports uiMultiplier ==
 * newUIMultiplier, so an in-force change is judged on the timestamps alone;
 * any feed post after effectiveAt clears it.
 */
export function splitPending(p: {
  now: number;
  effectiveAt: number;
  uiMultiplier: bigint;
  newUIMultiplier: bigint;
  feedUpdatedAt: number;
  leadSec?: number;
}): boolean {
  if (p.effectiveAt === 0) return false;
  if (p.now >= p.effectiveAt) return p.feedUpdatedAt < p.effectiveAt;
  return p.newUIMultiplier !== p.uiMultiplier && p.effectiveAt - p.now <= (p.leadSec ?? SPLIT_LEAD_SEC);
}

// ── quote sanity (B-L3) ─────────────────────────────────────────────────

/** StockRouter.oracleTokensFor: asset tokens (18 dp) a USDG amount (6 dp) buys at the oracle price. */
export function oracleTokensFor(usdgIn: bigint, price1e18: bigint): bigint {
  return (usdgIn * 10n ** 12n * 10n ** 18n) / price1e18;
}

/** v4 LPFeeLibrary.DYNAMIC_FEE_FLAG: the PoolKey fee of a pool whose hook sets the LP fee. */
export const DYNAMIC_FEE_FLAG = 0x800000;
const PIPS = 1_000_000;

/**
 * The fee a v4 swap pays, in pips (1e6 = 100%): ProtocolFeeLibrary.calculateSwapFee
 * over the LP fee and the protocol fee for the swap's direction. A static pool's
 * LP fee is its PoolKey fee; a dynamic-fee pool's is slot0.lpFee, unless its
 * hook overrides the fee per swap (`hookFee`, read from the hook: hooks.ts),
 * when slot0.lpFee stays 0. An unread slot0 counts as no protocol fee (and no
 * dynamic LP fee): a smaller fee only tightens the oracle check below.
 */
export function poolFeePips(p: { keyFee: number; zeroForOne: boolean; slot0?: { protocolFee: number; lpFee: number }; hookFee?: number }): number {
  const lp = p.hookFee ?? (p.keyFee === DYNAMIC_FEE_FLAG ? (p.slot0?.lpFee ?? 0) : p.keyFee);
  const pf = p.slot0 ? (p.zeroForOne ? p.slot0.protocolFee & 0xfff : (p.slot0.protocolFee >> 12) & 0xfff) : 0;
  return pf + lp - Math.floor((pf * lp) / PIPS);
}

/**
 * A quote is only used as a sweep limit if it is at most the pool's own swap
 * fee plus `allowanceBps` (impact + feed drift) worse than the oracle. A spot
 * pool pushed off the oracle would otherwise set the limit, leaving the
 * router's ~1.5% band as the only pool-independent bound. Better-than-oracle
 * quotes always pass. No oracle price never passes.
 */
export function quoteVsOracle(p: { swapIn: bigint; quotedOut: bigint; price1e18: bigint; feePips: number; allowanceBps: number }): {
  ok: boolean;
  /** How far the quote is under the oracle, bps (negative: better than the oracle). */
  shortfallBps: number;
  /** The most it may be under, bps. */
  maxBps: number;
} {
  const maxPips = p.feePips + p.allowanceBps * 100;
  const maxBps = maxPips / 100;
  if (p.price1e18 <= 0n) return { ok: false, shortfallBps: Number.POSITIVE_INFINITY, maxBps };
  const fair = oracleTokensFor(p.swapIn, p.price1e18);
  if (fair === 0n) return { ok: true, shortfallBps: 0, maxBps };
  const shortfallBps = Number(((fair - p.quotedOut) * 1_000_000n) / fair) / 100;
  const floorPips = maxPips >= PIPS ? 0n : BigInt(PIPS - maxPips);
  return { ok: p.quotedOut * BigInt(PIPS) >= fair * floorPips, shortfallBps, maxBps };
}

/**
 * Price impact of a swap, bps: how much worse its average rate is than a
 * small reference swap's on the same pool (the fee cancels). Rounded up;
 * a fill at or better than the reference rate is 0. An unusable reference is
 * +Infinity, so the caller treats the size as too big.
 */
export function impactBps(ref: { swapIn: bigint; out: bigint }, swapIn: bigint, out: bigint): number {
  if (ref.swapIn <= 0n || ref.out <= 0n || swapIn <= 0n) return Number.POSITIVE_INFINITY;
  // rate / refRate = (out * ref.swapIn) / (swapIn * ref.out)
  const num = out * ref.swapIn * 10_000n;
  const den = swapIn * ref.out;
  const kept = num / den; // floored: the impact rounds up
  return kept >= 10_000n ? 0 : Number(10_000n - kept);
}

/** All-or-nothing: a leg that would only defer would still consume the epoch. */
export function accountReady(states: readonly LegState[]): boolean {
  return states.every((s) => s !== "wait");
}

/** Netted USDG per asset over the legs that need a quote, exactly as the executor nets them. */
export function netTotals(
  entries: readonly { value: bigint; legs: readonly Leg[] }[],
  needsQuote: (asset: Address) => boolean,
): Map<Address, bigint> {
  const totals = new Map<Address, bigint>();
  for (const e of entries) {
    for (const s of splitMix(e.value, e.legs)) {
      if (s.usdg === 0n || !needsQuote(s.asset)) continue;
      totals.set(s.asset, (totals.get(s.asset) ?? 0n) + s.usdg);
    }
  }
  return totals;
}

/**
 * Keep a sweep inside the executor's per-call work: one swap per distinct
 * asset and one delivery (or unwind) per account leg. Accounts are taken in
 * order while distinct assets <= maxAssets and total legs <= maxLegs; one that
 * would break a cap waits for the next tick (later, smaller mixes may still
 * fit). The first account is always taken, so no single mix can stall.
 */
export function capSweepBatch<T extends { legs: readonly Leg[] }>(
  entries: readonly T[],
  caps: { maxAssets: number; maxLegs: number },
): { batch: T[]; waiting: number } {
  const assets = new Set<string>();
  let legs = 0;
  const batch: T[] = [];
  for (const e of entries) {
    const add = e.legs.map((l) => l.asset.toLowerCase()).filter((a) => !assets.has(a));
    const fits = assets.size + new Set(add).size <= caps.maxAssets && legs + e.legs.length <= caps.maxLegs;
    if (!fits && batch.length > 0) continue;
    for (const a of add) assets.add(a);
    legs += e.legs.length;
    batch.push(e);
  }
  return { batch, waiting: entries.length - batch.length };
}

/** Drop every entry whose mix holds one of `bad` (case-insensitive). */
export function withoutAssets<T extends { legs: readonly Leg[] }>(entries: readonly T[], bad: ReadonlySet<string>): T[] {
  const lc = new Set([...bad].map((a) => a.toLowerCase()));
  return entries.filter((e) => !e.legs.some((l) => lc.has(l.asset.toLowerCase())));
}

// ── US-equity market hours ──────────────────────────────────────────────

/**
 * UTC offset of US Eastern time at `tsSec`: EDT (-4h) from the second Sunday
 * of March 07:00 UTC to the first Sunday of November 06:00 UTC, else EST (-5h).
 */
export function easternOffsetSeconds(tsSec: number): number {
  const year = new Date(tsSec * 1000).getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(year, 2, nthSunday(2, 2), 7) / 1000;
  const end = Date.UTC(year, 10, nthSunday(10, 1), 6) / 1000;
  return tsSec >= start && tsSec < end ? -4 * 3600 : -5 * 3600;
}

/**
 * The 24/5 tokenized-equity session runs Sunday 20:00 ET to Friday 20:00 ET.
 * Returns the UTC second the CURRENT session opened, or null when closed.
 * DST only changes at 02:00 on a Sunday, before the 20:00 open, so the offset
 * at `tsSec` is also the offset at the session's open.
 */
export function equitySessionOpenedAt(tsSec: number): number | null {
  const off = easternOffsetSeconds(tsSec);
  const local = tsSec + off;
  const day = Math.floor(local / 86_400);
  const dow = (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  const secOfDay = local - day * 86_400;
  const OPEN = 20 * 3600;
  const open = (dow === 0 && secOfDay >= OPEN) || (dow >= 1 && dow <= 4) || (dow === 5 && secOfDay < OPEN);
  if (!open) return null;
  return (day - dow) * 86_400 + OPEN - off;
}

/**
 * Sweep an equity leg only while its session is open AND its feed has
 * published since the session opened (the feeds post at the open; a holiday
 * Monday has no post). Otherwise OracleGuard keeps calling a frozen Friday
 * price OK for up to heartbeat + 1h (~25h) and the sweep would fill against it.
 */
export function equityMarketOpen(tsSec: number, feedUpdatedAt: number, graceSec = 3_600): boolean {
  const opened = equitySessionOpenedAt(tsSec);
  return opened !== null && feedUpdatedAt >= opened - graceSec;
}
