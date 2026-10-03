/**
 * The keeper's per-leg rules (keeperRules.ts) pinned three ways:
 *   - the engine's own cases (engine/test/keeper-plan.test.ts and
 *     keeper-batches.test.ts), copied, against the API's copy;
 *   - each rule's outcome and reason, against a constant-product model pool;
 *   - side by side with the engine's plan.ts and batches.ts on the same
 *     seeded random inputs, when the engine sources are in the checkout (CI
 *     checks out the whole repo), so the two cannot drift.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  accountLegPlans,
  assetVerdict,
  DYNAMIC_FEE_FLAG,
  impactBps,
  KEEPER_QUOTE_MAX_SHORTFALL_BPS,
  KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS,
  KEEPER_SWEEP_MAX_IMPACT_BPS,
  legPlan,
  limitFromQuote,
  poolFeePips,
  quoteCheck,
  quoteCheckView,
  quoteVsOracle,
  REF_SWAP_IN,
  SPLIT_LEAD_SEC,
  splitMix,
  splitPending,
  swapInFor,
  type AssetInputs,
  type LegInputs,
} from './keeperRules.js';
import { KEEPER_QUOTE_TOLERANCE_BPS } from './book.js';

const utc = (s: string) => Date.parse(s) / 1000;
const E18 = 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const A = '0x000000000000000000000000000000000000000a' as Address;
const B = '0x000000000000000000000000000000000000000b' as Address;

/** StockRouter.oracleTokensFor. */
const fairOut = (usdgIn: bigint, price1e18: bigint) => (usdgIn * 10n ** 30n) / price1e18;

/** x*y=k with the LP fee kept in the pool; x = USDG (6 dp), y = token (18 dp). As engine/test/keeper-batches.test.ts. */
class Pool {
  constructor(
    public x: bigint,
    public y: bigint,
    readonly feePips: bigint,
  ) {}
  quote(dx: bigint): bigint {
    const dxf = (dx * (1_000_000n - this.feePips)) / 1_000_000n;
    return (this.y * dxf) / (this.x + dxf);
  }
}
/** A pool holding `usdgDepth` dollars of USDG whose spot is `offBps` under the oracle. */
function poolAt(price1e18: bigint, usdgDepth: number, feePips: bigint, offBps = 0n): Pool {
  const x = usd(usdgDepth);
  return new Pool(x, (fairOut(x, price1e18) * (10_000n - offBps)) / 10_000n, feePips);
}

describe('plan.ts parity: the engine cases', () => {
  it('splitMix floors each leg and gives the remainder to the last; the fee comes off before the swap', () => {
    expect(
      splitMix(10_000_001n, [
        { asset: A, bps: 6000 },
        { asset: B, bps: 4000 },
      ]),
    ).toEqual([
      { asset: A, usdg: 6_000_000n },
      { asset: B, usdg: 4_000_001n },
    ]);
    expect(swapInFor(20_000_000n, 25n)).toBe(19_950_000n);
  });

  it('limit reproduces quote minus tolerance on-chain', () => {
    const swapIn = 7_980_000n;
    const out = 34_956_000_000_000_000n;
    const minOut = (swapIn * limitFromQuote(swapIn, out, 50n)) / 1_000_000n;
    expect(minOut).toBeLessThanOrEqual((out * 9_950n) / 10_000n);
    expect(minOut).toBeGreaterThan((out * 9_949n) / 10_000n);
    expect(limitFromQuote(0n, out, 50n)).toBe(0n);
  });

  // Mainnet SGOV (2026-10-01): effectiveAt 00:10:35 UTC; the feed's session-open post was 00:00:40.
  const eff = utc('2026-10-01T00:10:35Z');
  const m = { uiMultiplier: 1_007_186_931_447_954_063n, newUIMultiplier: 1_007_186_931_447_954_063n };
  it('ERC-8056: in force and the feed not posted since effectiveAt -> pending; any post at or after it clears it', () => {
    expect(splitPending({ ...m, now: eff + 60, effectiveAt: eff, feedUpdatedAt: utc('2026-10-01T00:00:40Z') })).toBe(true);
    expect(splitPending({ ...m, now: utc('2026-10-02T04:34:40Z'), effectiveAt: eff, feedUpdatedAt: utc('2026-10-01T22:42:05Z') })).toBe(false);
    expect(splitPending({ ...m, now: eff + 5, effectiveAt: eff, feedUpdatedAt: eff })).toBe(false);
    expect(splitPending({ uiMultiplier: E18, newUIMultiplier: E18, now: eff, effectiveAt: 0, feedUpdatedAt: 0 })).toBe(false);
  });

  it('ERC-8056: a scheduled change pauses buys from SPLIT_LEAD_SEC (900 s) before it, not earlier', () => {
    expect(SPLIT_LEAD_SEC).toBe(900);
    const split = { uiMultiplier: E18, newUIMultiplier: 10n * E18, effectiveAt: eff, feedUpdatedAt: eff - 600 };
    expect(splitPending({ ...split, now: eff - SPLIT_LEAD_SEC })).toBe(true);
    expect(splitPending({ ...split, now: eff - SPLIT_LEAD_SEC - 1 })).toBe(false);
    expect(splitPending({ ...split, newUIMultiplier: split.uiMultiplier, now: eff - 60 })).toBe(false);
  });

  it('pool fee: PoolKey fee + the directional protocol fee; slot0 LP fee for a dynamic pool; unread slot0 is no extra fee', () => {
    // slot0 read on mainnet 2026-10-02 via StateView.getSlot0.
    expect(poolFeePips({ keyFee: 100, zeroForOne: true, slot0: { protocolFee: 102_425, lpFee: 100 } })).toBe(125);
    expect(poolFeePips({ keyFee: 3000, zeroForOne: true, slot0: { protocolFee: 2_048_500, lpFee: 3000 } })).toBe(3499);
    expect(poolFeePips({ keyFee: 500, zeroForOne: false, slot0: { protocolFee: 7 | (125 << 12), lpFee: 500 } })).toBe(625);
    expect(poolFeePips({ keyFee: DYNAMIC_FEE_FLAG, zeroForOne: false, slot0: { protocolFee: 0, lpFee: 3000 } })).toBe(3000);
    expect(poolFeePips({ keyFee: DYNAMIC_FEE_FLAG, zeroForOne: false, slot0: { protocolFee: 0, lpFee: 0 } })).toBe(0); // GME
    expect(poolFeePips({ keyFee: 3000, zeroForOne: true })).toBe(3000);
    expect(poolFeePips({ keyFee: DYNAMIC_FEE_FLAG, zeroForOne: true })).toBe(0);
  });

  it('quote vs oracle: up to the pool fee + allowance under it; better always passes; no price never does', () => {
    const price = 180n * E18;
    const swapIn = 7_980_000n;
    const fair = fairOut(swapIn, price);
    const under = (bps: bigint) => (fair * (10_000n - bps)) / 10_000n;
    expect(quoteVsOracle({ swapIn, quotedOut: under(30n), price1e18: price, feePips: 100, allowanceBps: 30 }).ok).toBe(true);
    expect(quoteVsOracle({ swapIn, quotedOut: under(32n), price1e18: price, feePips: 100, allowanceBps: 30 }).ok).toBe(false);
    expect(quoteVsOracle({ swapIn, quotedOut: (fair * 10_050n) / 10_000n, price1e18: price, feePips: 100, allowanceBps: 30 }).ok).toBe(true);
    expect(quoteVsOracle({ swapIn, quotedOut: under(115n), price1e18: price, feePips: 0, allowanceBps: 30 }).ok).toBe(false);
    expect(quoteVsOracle({ swapIn, quotedOut: under(115n), price1e18: price, feePips: 10_000, allowanceBps: 30 })).toEqual({ ok: true, shortfallBps: 115, maxBps: 130 });
    expect(quoteVsOracle({ swapIn, quotedOut: fair, price1e18: 0n, feePips: 100, allowanceBps: 30 }).ok).toBe(false);
    expect(quoteVsOracle({ swapIn: 1n, quotedOut: 0n, price1e18: 10n ** 37n, feePips: 3_000, allowanceBps: 30 })).toEqual({ ok: true, shortfallBps: 0, maxBps: 60 });
  });

  it('impact vs a $1 reference: the fee cancels, it rounds up, a better fill is 0, an unusable reference is infinite', () => {
    const ref = { swapIn: 1_000_000n, out: 5_555_000_000_000_000n };
    expect(impactBps(ref, 1_000_000_000n, (ref.out * 1000n * 9_888n) / 10_000n)).toBe(112);
    expect(impactBps(ref, 1_000_000_000n, (ref.out * 1000n * 98_885n) / 100_000n)).toBe(112);
    expect(impactBps(ref, 2_000_000n, ref.out * 2n)).toBe(0);
    expect(impactBps(ref, 2_000_000n, ref.out * 3n)).toBe(0);
    expect(impactBps({ swapIn: 1_000_000n, out: 0n }, 5_000_000n, 1n)).toBe(Number.POSITIVE_INFINITY);
  });
});

// Wednesday inside the session; an SGOV-like token whose dividend re-invest took effect at EFF.
const NOW = utc('2026-10-01T00:20:00Z');
const EFF = BigInt(utc('2026-10-01T00:10:35Z'));
const open = { open: true, reason: null };
const base: AssetInputs = {
  nowSec: NOW,
  active: true,
  oracleStatus: 0,
  feedUpdatedAt: utc('2026-10-01T00:15:00Z'),
  market: open,
  multiplier: { effectiveAt: EFF, uiMultiplier: E18, newUIMultiplier: E18 },
};

describe('assetVerdict: keeper.ts assetInfos -> plan.ts assetState, in its order', () => {
  it('ok when every per-asset gate passes', () => {
    expect(assetVerdict(base)).toEqual({ state: 'ok', why: null, waitCause: null, splitPending: false });
  });

  it('a multiplier change in force that the feed has not posted since -> wait, with when and the last post', () => {
    const v = assetVerdict({ ...base, feedUpdatedAt: utc('2026-10-01T00:00:40Z') });
    expect(v).toMatchObject({ state: 'wait', waitCause: 'multiplier_change', splitPending: true });
    expect(v.why).toBe('multiplier change in force since 2026-10-01T00:10:35.000Z and not yet in the Chainlink feed (last post 2026-10-01T00:00:40.000Z)');
  });

  it('a change scheduled within 900 s -> wait; 901 s out it still buys', () => {
    const scheduled = { effectiveAt: BigInt(NOW + 900), uiMultiplier: E18, newUIMultiplier: 2n * E18 };
    const v = assetVerdict({ ...base, multiplier: scheduled });
    expect(v).toMatchObject({ state: 'wait', waitCause: 'multiplier_change' });
    expect(v.why).toBe('multiplier change scheduled for 2026-10-01T00:35:00.000Z (the keeper stops buying 15 min before it)');
    expect(assetVerdict({ ...base, multiplier: { ...scheduled, effectiveAt: BigInt(NOW + 901) } }).state).toBe('ok');
  });

  it('unreadable registry, feed or multiplier state waits: the keeper never guesses', () => {
    expect(assetVerdict({ ...base, active: null })).toMatchObject({ state: 'wait', why: 'AssetRegistry read failed' });
    expect(assetVerdict({ ...base, feedUpdatedAt: null })).toMatchObject({ state: 'wait', why: 'Chainlink feed unreadable', splitPending: null });
    expect(assetVerdict({ ...base, multiplier: null })).toMatchObject({ state: 'wait', why: 'ERC-8056 multiplier state unreadable' });
  });

  it('order: inactive settles before anything; oracle before market before multiplier change', () => {
    const everything = { ...base, oracleStatus: 2, market: { open: false, reason: 'market closed (x)' }, feedUpdatedAt: 0 };
    expect(assetVerdict({ ...everything, active: false, multiplier: null })).toMatchObject({ state: 'settle', why: 'asset inactive' });
    expect(assetVerdict(everything)).toMatchObject({ state: 'wait', waitCause: 'oracle', why: 'oracle PAUSED' });
    expect(assetVerdict({ ...everything, oracleStatus: 0 })).toMatchObject({ waitCause: 'market', why: 'market closed (x)' });
    expect(assetVerdict({ ...everything, oracleStatus: 0, market: open })).toMatchObject({ waitCause: 'multiplier_change' });
  });
});

// NVDA-like: $180, hookless fee-100 pool with ~$442k of USDG depth (a $5k buy moves it ~113 bps).
const NVDA_PRICE = 180n * E18;
const FEE_BPS = 25n;
function leg(pool: Pool, gross: bigint, over: Partial<LegInputs> = {}): LegInputs {
  const swapIn = swapInFor(gross, FEE_BPS);
  return {
    ...base,
    price1e18: NVDA_PRICE,
    swapIn,
    out: swapIn > 0n ? pool.quote(swapIn) : null,
    refOut: pool.quote(REF_SWAP_IN),
    feePips: Number(pool.feePips),
    bandBps: 150,
    ...over,
  };
}

describe('B-L3: a quote becomes a limit only if it agrees with the oracle (batches.ts planCall)', () => {
  it('a pool pushed 90 bps under the oracle is held at any size, with the keeper reason verbatim', () => {
    const pool = poolAt(NVDA_PRICE, 442_000, 100n, 90n);
    const p = legPlan(leg(pool, usd(8)));
    expect(p.outcome).toBe('hold');
    expect(p.why).toMatch(/^pool 9\d\.\d bps under the oracle at \$1 \(max 61\.0: pool fee \+ 60\)$/);
    expect(p.reason).toMatch(/^held this tick: pool 9\d\.\d bps .* epoch kept and is retried next tick; value stays parked$/);
    expect(p.check!.minOutPerUsdg).toBe(0n);
    // A leg that nets nothing (an account below the threshold) is still judged at $1.
    const idle = legPlan(leg(pool, 0n));
    expect(idle.outcome).toBe('hold');
    expect(idle.check!.full).toBeNull();
  });

  it('QUOTE_ORACLE_ALLOWANCE_BPS is the keeper default, 60: a pool 45 bps under a feed that posts on 50 bps moves buys', () => {
    expect(KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS).toBe(60);
    // Past the old 30 bps allowance (which held it), inside the feed's own 50 bps deviation threshold.
    const p = legPlan(leg(poolAt(NVDA_PRICE, 442_000, 100n, 45n), usd(8)));
    expect(p.check!.reference).toMatchObject({ maxBps: 61, ok: true });
    expect(p.check!.reference!.shortfallBps).toBeGreaterThan(31);
    expect(p).toMatchObject({ outcome: 'buy', why: null, reason: null });
    expect(p.check!.minOutPerUsdg).toBeGreaterThan(0n);
  });

  it("the pool's own fee is allowed for: a 1% pool quoting 1.1% under the oracle buys", () => {
    const p = legPlan(leg(poolAt(24n * E18, 2_000_000, 10_000n, 10n), usd(10), { price1e18: 24n * E18 }));
    expect(p.outcome).toBe('buy');
    expect(p.reason).toBeNull();
    expect(p.check!.reference!.maxBps).toBe(160);
    expect(p.check!.full!.maxBps).toBe(KEEPER_QUOTE_MAX_SHORTFALL_BPS); // min(100 + 60 + 30, 120)
  });

  it('a whale leg (~113 bps impact) is swept alone and passes the 120 bps cap; packed it would be held', () => {
    const pool = poolAt(NVDA_PRICE, 442_000, 100n);
    const alone = legPlan(leg(pool, usd(5_000)));
    expect(alone.outcome).toBe('buy');
    expect(alone.check!.full).toMatchObject({ alone: true, maxBps: 120, ok: true });
    expect(alone.check!.full!.impactBps).toBeGreaterThan(100);
    const minOut = limitFromQuote(alone.check!.full!.swapIn, alone.check!.full!.out, 50n);
    expect(alone.check!.minOutPerUsdg).toBe(minOut);
    const packed = legPlan({ ...leg(pool, usd(5_000)), alone: false });
    expect(packed.outcome).toBe('hold');
    expect(packed.why).toMatch(/^quote 11\d\.\d bps under the oracle \(max 91\.0\)$/);
  });

  it('a $12k whale (~270 bps) is held even alone, never sent to fail the 150 bps backstop', () => {
    const p = legPlan(leg(poolAt(NVDA_PRICE, 442_000, 100n), usd(12_000)));
    expect(p.outcome).toBe('hold');
    expect(p.why).toMatch(/^quote 2\d\d\.\d bps under the oracle \(max 120\.0, alone\)$/);
  });

  it('no quote, no $1 reference or no OK oracle price -> held, never sent without a limit', () => {
    const pool = poolAt(NVDA_PRICE, 442_000, 100n);
    expect(legPlan(leg(pool, usd(8), { out: null })).why).toBe('no quote');
    expect(legPlan(leg(pool, usd(8), { refOut: null })).why).toBe('no $1 reference quote');
    expect(quoteCheck({ swapIn: usd(8), out: 1n, refOut: 1n, price1e18: 0n, feePips: 100 }).why).toBe('no OK oracle price');
  });

  it('a waiting or inactive leg is never held: the keeper does not quote it this tick', () => {
    const off = poolAt(NVDA_PRICE, 442_000, 100n, 60n);
    expect(legPlan(leg(off, usd(8), { oracleStatus: 1 }))).toMatchObject({
      outcome: 'wait',
      reason: 'oracle STALE: the keeper holds the account; value stays parked',
    });
    expect(legPlan(leg(off, usd(8), { market: { open: false, reason: 'market closed (keeper market-hours gate): z' } })).reason).toBe(
      'market closed (keeper market-hours gate): z',
    );
    expect(legPlan(leg(off, usd(8), { active: false }))).toMatchObject({ outcome: 'safe_settle', check: null });
  });

  it('a fill the keeper would send but outside the asset band defers on-chain', () => {
    // ~70 bps impact: alone (cap 120) so the keeper sends it, but a 50 bps band rejects it.
    const pool = poolAt(NVDA_PRICE, 442_000, 100n);
    const p = legPlan(leg(pool, usd(3_150), { bandBps: 50 }));
    expect(p.check!.why).toBeNull();
    expect(p.outcome).toBe('defer');
    expect(p.reason).toBe('fill outside the oracle band: the swap would revert and the leg defers');
    expect(legPlan(leg(pool, usd(3_150))).outcome).toBe('buy');
  });

  it('an account is swept alone when ANY leg is over the impact cap: every leg is judged alone', () => {
    const nvda = poolAt(NVDA_PRICE, 442_000, 100n);
    const spy = poolAt(660n * E18, 5_000_000, 500n);
    const small = leg(spy, usd(20), { price1e18: 660n * E18, feePips: 500 });
    const { plans, alone } = accountLegPlans([small, leg(nvda, usd(5_000))]);
    expect(alone).toBe(true);
    expect(plans[0]!.check!.full).toMatchObject({ alone: true, maxBps: 120 });
    expect(plans[0]!.check!.full!.impactBps).toBeLessThanOrEqual(1);
    const { plans: packed, alone: none } = accountLegPlans([small, leg(nvda, usd(8))]);
    expect(none).toBe(false);
    expect(packed[0]!.check!.full).toMatchObject({ alone: false, maxBps: 95 }); // 5 bps fee + 60 + 30
  });

  it('the API view: bps, decimal strings, the keeper limits', () => {
    const v = quoteCheckView(legPlan(leg(poolAt(NVDA_PRICE, 442_000, 100n), usd(8))).check);
    expect(v).toMatchObject({ ok: true, why: null, poolFeeBps: 1, allowanceBps: 60, maxImpactBps: 30, maxShortfallBps: 120 });
    expect(v!.reference).toMatchObject({ swapInUsd: '1', maxBps: 61, ok: true });
    expect(v!.fullSize).toMatchObject({ swapInUsd: '7.98', alone: false, maxBps: 91, ok: true });
    expect(quoteCheckView(null)).toBeNull();
  });
});

// ─── side by side with the engine ────────────────────────────────────────

// A checkout without the engine (the API deployed on its own) skips this block;
// one whose engine sources no longer load fails it, rather than silently not comparing.
const ENGINE = new URL('../../../engine/src/keeper/', import.meta.url);
const HAVE_ENGINE = existsSync(fileURLToPath(new URL('batches.ts', ENGINE))) && existsSync(fileURLToPath(new URL('plan.ts', ENGINE)));
let engine: { plan: any; batches: any } | null = null;
let engineLoadError: unknown = null;
if (HAVE_ENGINE) {
  try {
    engine = { plan: await import(fileURLToPath(new URL('plan.ts', ENGINE))), batches: await import(fileURLToPath(new URL('batches.ts', ENGINE))) };
  } catch (err) {
    engineLoadError = err;
  }
}

/** mulberry32: the same inputs on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe.skipIf(!HAVE_ENGINE)('side by side with engine/src/keeper (plan.ts, batches.ts)', () => {
  it('the engine sources load', () => {
    expect(engineLoadError).toBeNull();
  });

  it("the mirror's limits and constants are the keeper's (config.ts defaults, plan.ts, batches.ts)", () => {
    // config.ts imports zod: read the defaults from its source rather than loading it.
    const config = fileURLToPath(new URL('config.ts', ENGINE));
    expect(existsSync(config)).toBe(true);
    const src = readFileSync(config, 'utf8');
    const def = (name: string) => {
      const m = new RegExp(String.raw`\b${name}: z[^\n]*?\.default\((\d+)\)`).exec(src);
      expect(m, `${name} default in engine/src/keeper/config.ts`).not.toBeNull();
      return Number(m![1]);
    };
    expect(KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS).toBe(def('QUOTE_ORACLE_ALLOWANCE_BPS'));
    expect(KEEPER_SWEEP_MAX_IMPACT_BPS).toBe(def('SWEEP_MAX_IMPACT_BPS'));
    expect(KEEPER_QUOTE_MAX_SHORTFALL_BPS).toBe(def('QUOTE_MAX_SHORTFALL_BPS'));
    expect(KEEPER_QUOTE_TOLERANCE_BPS).toBe(def('QUOTE_TOLERANCE_BPS'));
    expect(SPLIT_LEAD_SEC).toBe(engine!.plan.SPLIT_LEAD_SEC);
    expect(DYNAMIC_FEE_FLAG).toBe(engine!.plan.DYNAMIC_FEE_FLAG);
    expect(REF_SWAP_IN).toBe(engine!.batches.REF_SWAP_IN);
  });

  const r = rng(4663);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)]!;

  it('splitPending, poolFeePips, quoteVsOracle and impactBps agree on 4,000 random inputs', () => {
    const P = engine!.plan;
    for (let i = 0; i < 1_000; i++) {
      const eff = int(0, 1) ? 0 : 1_790_000_000 + int(0, 100_000);
      const now = eff === 0 ? 1_790_050_000 : eff + int(-2_000, 2_000);
      const s = {
        now,
        effectiveAt: eff,
        uiMultiplier: E18,
        newUIMultiplier: pick([E18, 2n * E18]),
        feedUpdatedAt: (eff || now) + int(-1_000, 100),
      };
      expect(splitPending(s)).toBe(P.splitPending(s));

      const f = {
        keyFee: pick([100, 500, 3000, 10_000, DYNAMIC_FEE_FLAG, int(0, 1_000_000)]),
        zeroForOne: r() < 0.5,
        slot0: r() < 0.2 ? undefined : { protocolFee: int(0, 1000) | (int(0, 1000) << 12), lpFee: int(0, 1_000_000) },
      };
      expect(poolFeePips(f)).toBe(P.poolFeePips(f));

      const price = BigInt(int(0, 3)) * BigInt(int(1, 900)) * E18;
      const swapIn = BigInt(int(1, 50_000_000_000));
      const fair = price > 0n ? fairOut(swapIn, price) : 10n ** 18n;
      const q = {
        swapIn,
        quotedOut: (fair * BigInt(int(9_700, 10_100))) / 10_000n,
        price1e18: price,
        feePips: int(0, 1_200_000),
        allowanceBps: int(0, 150),
      };
      expect(quoteVsOracle(q)).toEqual(P.quoteVsOracle(q));

      const ref = { swapIn: REF_SWAP_IN, out: BigInt(int(0, 3)) * 10n ** BigInt(int(12, 18)) };
      const out = (ref.out * swapIn * BigInt(int(9_000, 10_100))) / REF_SWAP_IN / 10_000n;
      expect(impactBps(ref, swapIn, out)).toBe(P.impactBps(ref, swapIn, out));
    }
  });

  it('one due account: partitionSweep + planCall hold, isolate and limit exactly as accountLegPlans does (600 random accounts)', async () => {
    const { partitionSweep, planCall } = engine!.batches;
    const assets = [A, B];
    const prices: Record<string, bigint> = { [A]: 180n * E18, [B]: 24n * E18 };
    const seen = { sitOut: 0, alone: 0, poolHeld: 0, quoteHeld: 0, quoteHeldAlone: 0, swept: 0, sweptAlone: 0 };
    for (let i = 0; i < 600; i++) {
      // Mostly pools near the oracle; some pushed off it; fees from 1 bp to 2%; account values $5..$20k, log-uniform.
      const pools: Record<string, Pool> = Object.fromEntries(
        assets.map((a) => [
          a,
          poolAt(prices[a]!, int(50_000, 5_000_000), BigInt(pick([100, 500, 3_000, 10_000, 20_000, int(0, 20_000)])), BigInt(r() < 0.7 ? int(-30, 30) : int(30, 160))),
        ]),
      );
      const mix = r() < 0.5 ? [{ asset: A, bps: 10_000 }] : [{ asset: A, bps: int(1, 9_999) }, { asset: B, bps: 0 }];
      if (mix.length === 2) mix[1]!.bps = 10_000 - mix[0]!.bps;
      const value = usd(Math.round(5 * 10 ** (r() * 3.6)));
      const unquotable = r() < 0.05 ? pick(assets) : null; // a hook that reverts at the leg's size
      const quote = async (reqs: readonly { asset: Address; swapIn: bigint }[]) =>
        reqs.map((q) => (q.asset === unquotable && q.swapIn !== REF_SWAP_IN ? null : pools[q.asset]!.quote(q.swapIn)));
      const due = { account: A, value, legs: mix };

      const part = await partitionSweep([due], { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: KEEPER_SWEEP_MAX_IMPACT_BPS, quote });
      const sitsOut = part.sittingOut.length === 1;
      const isolated = part.isolated.length === 1;
      const plan = sitsOut
        ? null
        : await planCall([due], {
            state: () => 'ok',
            feeBps: FEE_BPS,
            toleranceBps: 50n,
            allowanceBps: KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS,
            sizeAllowanceBps: KEEPER_SWEEP_MAX_IMPACT_BPS,
            maxShortfallBps: KEEPER_QUOTE_MAX_SHORTFALL_BPS,
            isolated,
            quote,
            market: async (xs: readonly Address[]) => new Map(xs.map((a) => [a.toLowerCase(), { price1e18: prices[a]!, feePips: Number(pools[a]!.feePips) }])),
          });

      const gross = new Map<string, bigint>();
      for (const s of splitMix(value, mix)) gross.set(s.asset, (gross.get(s.asset) ?? 0n) + s.usdg);
      const legs = mix.map((l) => {
        const swapIn = swapInFor(gross.get(l.asset)!, FEE_BPS);
        return {
          ...base,
          price1e18: prices[l.asset]!,
          swapIn,
          out: l.asset === unquotable || swapIn === 0n ? null : pools[l.asset]!.quote(swapIn),
          refOut: pools[l.asset]!.quote(REF_SWAP_IN),
          feePips: Number(pools[l.asset]!.feePips),
          bandBps: 150,
        };
      });
      const ours = accountLegPlans(legs);

      const label = `case ${i}: ${JSON.stringify(mix)} $${value / 1_000_000n}`;
      if (sitsOut) {
        // Impact unmeasurable: the engine sits the account out; the API holds it for "no quote".
        expect(ours.plans.some((p) => p.outcome === 'hold' && p.why === 'no quote'), label).toBe(true);
        seen.sitOut++;
        continue;
      }
      const whys = [...plan.dropped.values()].map((d: { why: string }) => d.why).join(' ');
      if (isolated) seen.alone++;
      if (whys.startsWith('pool ')) seen.poolHeld++;
      if (/^quote .*\(max [\d.]+\)/.test(whys)) seen.quoteHeld++;
      if (whys.includes(', alone)')) seen.quoteHeldAlone++;
      if (plan.chosen.length === 1) seen[isolated ? 'sweptAlone' : 'swept']++;
      expect(ours.alone, label).toBe(isolated);
      mix.forEach((l, k) => {
        if (legs[k]!.swapIn === 0n) return; // netted nothing: the engine never quotes it
        const dropped = plan.dropped.get(l.asset.toLowerCase())?.why ?? null;
        expect(ours.plans[k]!.check!.why, label).toBe(dropped);
        expect(ours.plans[k]!.outcome === 'hold', label).toBe(dropped !== null);
        if (plan.chosen.length === 1) {
          expect(ours.plans[k]!.check!.minOutPerUsdg, label).toBe(plan.limits.find((x: { asset: Address }) => x.asset === l.asset).minOutPerUsdg);
        }
      });
      expect(plan.chosen.length === 1, label).toBe(ours.plans.every((p) => p.outcome !== 'hold'));
    }
    // The random cases reach every branch of the keeper's decision.
    for (const [k, n] of Object.entries(seen)) expect(n, `${k}: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(5);
  });
});
