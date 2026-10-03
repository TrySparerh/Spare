/**
 * The keeper's sweep rules for one leg, exactly as it applies them.
 *
 * `splitMix`, `swapInFor`, `limitFromQuote`, `splitPending`, `poolFeePips`,
 * `quoteVsOracle` and `impactBps` are copied operation for operation from
 * engine/src/keeper/plan.ts. keeperRules.test.ts runs the engine's own cases
 * against them and, when the engine sources are in the checkout (CI), runs
 * the engine's plan.ts and batches.ts side by side with this file, so the two
 * cannot drift.
 *
 * `assetVerdict` and `legPlan` apply them in the keeper's order:
 *   1. keeper.ts assetInfos -> plan.ts assetState: inactive -> settle; an
 *      unreadable feed or ERC-8056 multiplier state, oracle not OK, market
 *      closed, or a multiplier change the feed has not caught up with -> wait
 *      (and the whole account waits: a sweep is all-or-nothing);
 *   2. batches.ts partitionSweep: a leg whose own price impact (vs a $1 quote
 *      on the same pool) is over SWEEP_MAX_IMPACT_BPS is swept alone;
 *   3. batches.ts planCall (audit B-L3): the $1 quote may be at most the pool
 *      fee + QUOTE_ORACLE_ALLOWANCE_BPS under the oracle, and the leg's own
 *      quote at most min(pool fee + allowance + SWEEP_MAX_IMPACT_BPS,
 *      QUOTE_MAX_SHORTFALL_BPS) in a packed call, QUOTE_MAX_SHORTFALL_BPS
 *      alone. Otherwise the asset is HELD: every account holding it sits the
 *      call out with its epoch untouched and is retried next tick;
 *   4. StockRouter: a fill outside the asset's bandBps reverts, and the
 *      executor defers the leg.
 * The keeper nets every due account's leg of an asset into one swap. The API
 * sees one account (or one spare_quote size), so steps 2-4 judge that leg
 * swept on its own. The keeper's env is not readable here: the limits are
 * its defaults (engine/src/keeper/config.ts).
 */
import type { Address } from 'viem';
import { KEEPER_QUOTE_TOLERANCE_BPS, ORACLE_STATUS, STOCK_DECIMALS } from './book.js';
import { formatUnitsExact, usdg } from './roundup.js';

/**
 * QUOTE_ORACLE_ALLOWANCE_BPS: impact + feed drift a $1 quote may show on top
 * of the pool fee. 60 since the 2026-10-02 fork run: Chainlink equity feeds
 * only post on a 50 bps deviation (or every 24 h), so a 30 bps allowance held
 * healthy assets between posts.
 */
export const KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS = 60;
/** SWEEP_MAX_IMPACT_BPS: a leg moving the price more than this is swept alone. */
export const KEEPER_SWEEP_MAX_IMPACT_BPS = 30;
/** QUOTE_MAX_SHORTFALL_BPS: no quote further than this under the oracle becomes a limit. */
export const KEEPER_QUOTE_MAX_SHORTFALL_BPS = 120;
/** plan.ts SPLIT_LEAD_SEC: seconds before a scheduled multiplier change at which buys stop. */
export const SPLIT_LEAD_SEC = 900;
/** batches.ts REF_SWAP_IN: the $1 reference swap impact and the pool check are measured with. */
export const REF_SWAP_IN = 1_000_000n;
/** v4 LPFeeLibrary.DYNAMIC_FEE_FLAG: the PoolKey fee of a pool whose hook sets the LP fee. */
export const DYNAMIC_FEE_FLAG = 0x800000;
const PIPS = 1_000_000;

// ─── engine/src/keeper/plan.ts, operation for operation ─────────────────

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

/** Limit for `sweep`: minimum asset tokens per 1 USDG, from the quote less `toleranceBps`. */
export function limitFromQuote(swapIn: bigint, quotedOut: bigint, toleranceBps: bigint): bigint {
  if (swapIn === 0n || quotedOut === 0n) return 0n;
  return (quotedOut * 1_000_000n * (10_000n - toleranceBps)) / 10_000n / swapIn;
}

/**
 * ERC-8056 corporate actions: the token's uiMultiplier moves to
 * newUIMultiplier at effectiveAt and the feed quotes the multiplier-adjusted
 * price, but OracleGuard reads neither field. Pending while a change is in
 * force and the feed has not posted since it took effect, and from `leadSec`
 * before a scheduled change. Any feed post after effectiveAt clears it.
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

/** StockRouter.oracleTokensFor: asset tokens (18 dp) a USDG amount (6 dp) buys at the oracle price. */
function oracleTokensFor(usdgIn: bigint, price1e18: bigint): bigint {
  return (usdgIn * 10n ** 12n * 10n ** 18n) / price1e18;
}

/**
 * The fee a v4 swap pays, in pips (1e6 = 100%): ProtocolFeeLibrary.calculateSwapFee
 * over the LP fee (the PoolKey fee, or slot0.lpFee for a dynamic-fee pool) and
 * the protocol fee for the swap's direction. An unread slot0 counts as no
 * protocol fee (and no dynamic LP fee): only ever a tighter check.
 */
export function poolFeePips(p: { keyFee: number; zeroForOne: boolean; slot0?: { protocolFee: number; lpFee: number } }): number {
  const lp = p.keyFee === DYNAMIC_FEE_FLAG ? (p.slot0?.lpFee ?? 0) : p.keyFee;
  const pf = p.slot0 ? (p.zeroForOne ? p.slot0.protocolFee & 0xfff : (p.slot0.protocolFee >> 12) & 0xfff) : 0;
  return pf + lp - Math.floor((pf * lp) / PIPS);
}

/**
 * A quote is only used as a sweep limit if it is at most the pool's own swap
 * fee plus `allowanceBps` worse than the oracle. Better-than-oracle quotes
 * always pass; no oracle price never passes.
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
 * small reference swap's on the same pool (the fee cancels). Rounded up; a
 * fill at or better than the reference rate is 0; an unusable reference is
 * +Infinity.
 */
export function impactBps(ref: { swapIn: bigint; out: bigint }, swapIn: bigint, out: bigint): number {
  if (ref.swapIn <= 0n || ref.out <= 0n || swapIn <= 0n) return Number.POSITIVE_INFINITY;
  const num = out * ref.swapIn * 10_000n;
  const den = swapIn * ref.out;
  const kept = num / den;
  return kept >= 10_000n ? 0 : Number(10_000n - kept);
}

// ─── one asset, one leg, in the keeper's order ──────────────────────────

/** plan.ts LegState: buy it, safe-settle it (inactive), or wait (the whole account waits). */
export type LegState = 'ok' | 'settle' | 'wait';

/**
 * What a sweep does with one leg right now:
 *   buy         - the keeper sends it with a limit and the fill clears the router's band;
 *   wait        - plan.ts assetState "wait": the keeper holds the whole account;
 *   hold        - batches.ts planCall drops the asset (no quote, or B-L3): every
 *                 account holding it sits the call out, epoch kept, retried next tick;
 *   defer       - sent, but the router's oracle band rejects the fill: the executor
 *                 defers the leg after marking the account swept for the epoch;
 *   safe_settle - asset inactive: the executor pays the leg out as USDG.
 */
export type LegOutcome = 'buy' | 'wait' | 'hold' | 'defer' | 'safe_settle';

/** A stock token's ERC-8056 state (effectiveAt 0: no change ever scheduled). */
export interface MultiplierState {
  effectiveAt: bigint;
  uiMultiplier: bigint;
  newUIMultiplier: bigint;
}

export interface AssetInputs {
  /** Block timestamp the reads were taken at. */
  nowSec: number;
  /** AssetRegistry.isEligible (Asset.active); null when the registry read failed. */
  active: boolean | null;
  /** StockRouter.oracleStatus status. */
  oracleStatus: number;
  /** The feed's latestRoundData().updatedAt; null when the read failed. */
  feedUpdatedAt: number | null;
  /** The keeper's market-hours gate for this feed (marketHours.ts marketView). */
  market: { open: boolean; reason: string | null };
  /** effectiveAt / uiMultiplier / newUIMultiplier; null when any of them failed to read. */
  multiplier: MultiplierState | null;
}

/** Why an asset waits, in the keeper's order. */
export type WaitCause = 'unread' | 'oracle' | 'market' | 'multiplier_change';

export interface AssetVerdict {
  state: LegState;
  /** Short cause when the leg does not buy (the keeper's log names the same); null otherwise. */
  why: string | null;
  /** Set when state is wait. */
  waitCause: WaitCause | null;
  /** plan.ts splitPending; null when the multiplier state or the feed is unreadable. */
  splitPending: boolean | null;
}

const isoSec = (s: number | bigint) => new Date(Number(s) * 1000).toISOString();

/**
 * keeper.ts assetInfos -> plan.ts assetState for one asset. An unreadable
 * registry, feed or multiplier state waits: the keeper never guesses.
 */
export function assetVerdict(p: AssetInputs): AssetVerdict {
  const m = p.multiplier;
  const split =
    m && p.feedUpdatedAt !== null
      ? splitPending({
          now: p.nowSec,
          effectiveAt: Number(m.effectiveAt),
          uiMultiplier: m.uiMultiplier,
          newUIMultiplier: m.newUIMultiplier,
          feedUpdatedAt: p.feedUpdatedAt,
        })
      : null;
  const wait = (waitCause: WaitCause, why: string): AssetVerdict => ({ state: 'wait', why, waitCause, splitPending: split });
  if (p.active === null) return wait('unread', 'AssetRegistry read failed');
  // Deactivated: the executor safe-settles the leg before any oracle or limit check.
  if (!p.active) return { state: 'settle', why: 'asset inactive', waitCause: null, splitPending: split };
  if (p.feedUpdatedAt === null) return wait('unread', 'Chainlink feed unreadable');
  // Unreadable multiplier state is not "no change": wait, never guess.
  if (!m) return wait('unread', 'ERC-8056 multiplier state unreadable');
  if (p.oracleStatus !== 0) return wait('oracle', `oracle ${ORACLE_STATUS[p.oracleStatus] ?? p.oracleStatus}`);
  if (!p.market.open) return wait('market', p.market.reason ?? 'market closed (keeper market-hours gate)');
  if (split) {
    return wait(
      'multiplier_change',
      p.nowSec >= Number(m.effectiveAt)
        ? `multiplier change in force since ${isoSec(m.effectiveAt)} and not yet in the Chainlink feed (last post ${isoSec(p.feedUpdatedAt)})`
        : `multiplier change scheduled for ${isoSec(m.effectiveAt)} (the keeper stops buying ${SPLIT_LEAD_SEC / 60} min before it)`,
    );
  }
  return { state: 'ok', why: null, waitCause: null, splitPending: split };
}

/** batches.ts planCall's check of one asset in a call of its own size. */
export interface QuoteCheck {
  /** poolFeePips of the pinned pool. */
  feePips: number;
  /** The $1 reference vs the oracle; null without a reference quote or an OK oracle price. */
  reference: { out: bigint; shortfallBps: number; maxBps: number; ok: boolean } | null;
  /** The leg's own size; null when it nets nothing, was not quoted, or has no OK oracle price. */
  full: { swapIn: bigint; out: bigint; impactBps: number; alone: boolean; shortfallBps: number; maxBps: number; ok: boolean } | null;
  /** Why the keeper holds the asset, in its own words (planCall `why`); null when it would carry a limit. */
  why: string | null;
  /** The limit the keeper would send: minimum tokens (18 dp) per 1 USDG; 0 when held or nothing to swap. */
  minOutPerUsdg: bigint;
}

/**
 * partitionSweep's isolation and planCall's B-L3 check for ONE leg of
 * `swapIn` USDG (after the conversion fee), quoted at the same block as the
 * $1 reference. `price1e18` is 0 when OracleGuard is not OK. A leg that nets
 * nothing (swapIn 0) is only checked at $1: the pool check holds an asset at
 * any size. `alone` is the call's isolation when the caller knows it (an
 * account is isolated by ANY of its legs); otherwise the leg's own impact.
 */
export function quoteCheck(p: {
  swapIn: bigint;
  out: bigint | null;
  refOut: bigint | null;
  price1e18: bigint;
  feePips: number;
  alone?: boolean;
}): QuoteCheck {
  const allowance = KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS;
  const sized = p.swapIn > 0n;
  const priced = p.price1e18 > 0n;
  const spot =
    p.refOut && priced
      ? quoteVsOracle({ swapIn: REF_SWAP_IN, quotedOut: p.refOut, price1e18: p.price1e18, feePips: p.feePips, allowanceBps: allowance })
      : null;
  let full: QuoteCheck['full'] = null;
  if (sized && p.out && p.refOut && priced) {
    // Alone when the leg's own impact is over the cap; whole pips keep the floor exact.
    const impact = impactBps({ swapIn: REF_SWAP_IN, out: p.refOut }, p.swapIn, p.out);
    const alone = p.alone ?? impact > KEEPER_SWEEP_MAX_IMPACT_BPS;
    const capPips = alone
      ? KEEPER_QUOTE_MAX_SHORTFALL_BPS * 100
      : Math.min(p.feePips + (allowance + KEEPER_SWEEP_MAX_IMPACT_BPS) * 100, KEEPER_QUOTE_MAX_SHORTFALL_BPS * 100);
    const q = quoteVsOracle({ swapIn: p.swapIn, quotedOut: p.out, price1e18: p.price1e18, feePips: capPips, allowanceBps: 0 });
    full = { swapIn: p.swapIn, out: p.out, impactBps: impact, alone, ...q };
  }
  let why: string | null = null;
  if (sized && !p.out) why = 'no quote';
  else if (!p.refOut) why = 'no $1 reference quote';
  else if (!priced) why = 'no OK oracle price';
  else if (!spot!.ok) {
    why = `pool ${spot!.shortfallBps.toFixed(1)} bps under the oracle at $1 (max ${spot!.maxBps.toFixed(1)}: pool fee + ${allowance})`;
  } else if (full && !full.ok) {
    why = `quote ${full.shortfallBps.toFixed(1)} bps under the oracle (max ${full.maxBps.toFixed(1)}${full.alone ? ', alone' : ''})`;
  }
  const minOutPerUsdg = sized && p.out && !why ? limitFromQuote(p.swapIn, p.out, BigInt(KEEPER_QUOTE_TOLERANCE_BPS)) : 0n;
  if (sized && !why && minOutPerUsdg === 0n) why = 'limit rounds to 0';
  return {
    feePips: p.feePips,
    reference: spot && p.refOut ? { out: p.refOut, shortfallBps: spot.shortfallBps, maxBps: spot.maxBps, ok: spot.ok } : null,
    full,
    why,
    minOutPerUsdg,
  };
}

export interface LegInputs extends AssetInputs {
  /** StockRouter.oracleStatus price (1e18); used only while the status is OK. */
  price1e18: bigint;
  /** USDG into the swap after the conversion fee; 0 when the leg nets nothing. */
  swapIn: bigint;
  /** V4Quoter output at `swapIn` and at the $1 reference; null when that swap would not quote. */
  out: bigint | null;
  refOut: bigint | null;
  /** poolFeePips of the asset's pinned pool. */
  feePips: number;
  /** AssetRegistry bandBps: StockRouter rejects a fill further than this from the oracle. */
  bandBps: number;
  /** The call's isolation, when known (accountLegPlans); otherwise the leg's own impact decides. */
  alone?: boolean;
}

export interface LegPlan extends AssetVerdict {
  outcome: LegOutcome;
  /** What happens and why, as a sentence; null when the leg buys. */
  reason: string | null;
  /** The B-L3 check; null for an inactive asset (it is never quoted). */
  check: QuoteCheck | null;
}

/** One leg, start to finish, in the keeper's order (see the file comment). */
export function legPlan(p: LegInputs): LegPlan {
  const v = assetVerdict(p);
  const price = p.oracleStatus === 0 ? p.price1e18 : 0n;
  const check = p.active ? quoteCheck({ swapIn: p.swapIn, out: p.out, refOut: p.refOut, price1e18: price, feePips: p.feePips, alone: p.alone }) : null;
  if (v.state === 'settle') return { ...v, outcome: 'safe_settle', reason: 'asset inactive: the leg is paid out as USDG with a notice', check };
  if (v.state === 'wait') {
    // The market-hours reason already says what the keeper does.
    const reason = v.waitCause === 'market' ? v.why : `${v.why}: the keeper holds the account; value stays parked`;
    return { ...v, outcome: 'wait', reason, check };
  }
  if (check!.why) {
    return {
      ...v,
      outcome: 'hold',
      why: check!.why,
      reason: `held this tick: ${check!.why}. Every account holding this stock sits the sweep out with its epoch kept and is retried next tick; value stays parked`,
      check,
    };
  }
  if (p.swapIn > 0n && p.out !== null && price > 0n) {
    const floor = (oracleTokensFor(p.swapIn, price) * BigInt(10_000 - p.bandBps)) / 10_000n;
    if (p.out < floor) {
      return { ...v, outcome: 'defer', why: 'fill outside the oracle band', reason: 'fill outside the oracle band: the swap would revert and the leg defers', check };
    }
  }
  return { ...v, outcome: 'buy', why: null, reason: null, check };
}

/**
 * Every leg of ONE account, as the keeper plans its call. partitionSweep
 * isolates the account when ANY quoted leg is over the impact cap, and
 * planCall then holds every leg of the call to the alone cap. Legs of the
 * same asset are expected to carry the asset's netted swapIn.
 */
export function accountLegPlans(legs: readonly LegInputs[]): { plans: LegPlan[]; alone: boolean } {
  const alone = legs.some((l) => {
    const p = legPlan({ ...l, alone: undefined });
    return p.state === 'ok' && p.check?.full?.alone === true;
  });
  return { plans: legs.map((l) => legPlan({ ...l, alone })), alone };
}

// ─── response views ─────────────────────────────────────────────────────

const bps2 = (x: number) => Math.round(x * 100) / 100;

/** The B-L3 check as the API reports it (keeperRules constants, decimal strings). */
export function quoteCheckView(c: QuoteCheck | null) {
  if (!c) return null;
  return {
    /** The keeper would turn this quote into a limit. */
    ok: c.why === null,
    /** The keeper's reason for holding the asset, verbatim; null when ok. */
    why: c.why,
    /** LP fee (slot0's for a dynamic-fee pool) + the protocol fee for USDG -> stock, bps. */
    poolFeeBps: c.feePips / 100,
    allowanceBps: KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS,
    maxImpactBps: KEEPER_SWEEP_MAX_IMPACT_BPS,
    maxShortfallBps: KEEPER_QUOTE_MAX_SHORTFALL_BPS,
    reference: c.reference
      ? {
          swapInUsd: usdg(REF_SWAP_IN),
          tokensOut: formatUnitsExact(c.reference.out, STOCK_DECIMALS),
          shortfallBps: bps2(c.reference.shortfallBps),
          maxBps: c.reference.maxBps,
          ok: c.reference.ok,
        }
      : null,
    fullSize: c.full
      ? {
          swapInUsd: usdg(c.full.swapIn),
          tokensOut: formatUnitsExact(c.full.out, STOCK_DECIMALS),
          impactBps: Number.isFinite(c.full.impactBps) ? c.full.impactBps : null,
          /** Impact over maxImpactBps: the keeper sweeps this account in a call of its own, after the others. */
          alone: c.full.alone,
          shortfallBps: bps2(c.full.shortfallBps),
          maxBps: c.full.maxBps,
          ok: c.full.ok,
        }
      : null,
  };
}

/** A token's ERC-8056 state and whether it makes the keeper wait; null when unreadable. */
export function multiplierView(m: MultiplierState | null, pending: boolean | null) {
  if (!m) return null;
  return {
    uiMultiplier: formatUnitsExact(m.uiMultiplier, 18),
    newUIMultiplier: formatUnitsExact(m.newUIMultiplier, 18),
    /** When the multiplier moves (or moved) to newUIMultiplier; null when never scheduled. */
    effectiveAt: m.effectiveAt > 0n ? isoSec(m.effectiveAt) : null,
    /** In force but not yet in the feed, or due within leadSeconds: the keeper waits. */
    pending,
    leadSeconds: SPLIT_LEAD_SEC,
  };
}
