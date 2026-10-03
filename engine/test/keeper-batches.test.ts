/**
 * Sweep batching (audit A-M1) and the quote-vs-oracle check (audit B-L3),
 * against a constant-product model pool and a model of SweepExecutor.sweep:
 * netted per asset, fee off the top, minOut = max(keeper limit, oracle floor),
 * one all-or-nothing swap per asset, every contributor deferred on a revert,
 * and every account in the call marked swept for the epoch either way.
 */
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { partitionSweep, planCall, poolHeld, recoveryHeld, REF_SWAP_IN, type Due, type Market, type QuoteReq, type Quoter } from "../src/keeper/batches.ts";
import { impactBps, limitFromQuote, oracleTokensFor, splitMix, swapInFor } from "../src/keeper/plan.ts";

const SPY = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" as Address;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const INTC = "0x00000000000000000000000000000000000017c0" as Address;
const ALICE = "0x000000000000000000000000000000000000a11c" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const MALLORY = "0x000000000000000000000000000000000000ba11" as Address;
const lc = (a: string) => a.toLowerCase();
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const E18 = 10n ** 18n;

const FEE_BPS = 25n; // SweepExecutor.feeBps
const TOL = 50n; // QUOTE_TOLERANCE_BPS
const SLIPPAGE_BPS = 150n; // SweepExecutor.slippageBps
const BAND_BPS = 150n; // AssetRegistry bandBps
const PRICE: Record<string, bigint> = { [lc(SPY)]: 660n * E18, [lc(NVDA)]: 180n * E18, [lc(INTC)]: 24n * E18 };

/** x*y=k with the LP fee kept in the pool; x = USDG (6 dp), y = token (18 dp). */
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
  swap(dx: bigint): bigint {
    const out = this.quote(dx);
    this.x += dx;
    this.y -= out;
    return out;
  }
}
/** A pool holding `usdgDepth` dollars of USDG whose spot is `offBps` under the oracle. */
function poolAt(asset: Address, usdgDepth: number, feePips: bigint, offBps = 0n): Pool {
  const x = usd(usdgDepth);
  return new Pool(x, (oracleTokensFor(x, PRICE[lc(asset)]!) * (10_000n - offBps)) / 10_000n, feePips);
}

function quoterFor(pools: Record<string, Pool>, seen?: QuoteReq[]): Quoter {
  return async (reqs) => {
    seen?.push(...reqs);
    return reqs.map((r) => pools[lc(r.asset)]?.quote(r.swapIn) ?? null);
  };
}
function marketFor(pools: Record<string, Pool>) {
  return async (assets: readonly Address[]) => {
    const m = new Map<string, Market>();
    for (const a of assets) m.set(lc(a), { price1e18: PRICE[lc(a)]!, feePips: Number(pools[lc(a)]!.feePips) });
    return m;
  };
}

/** SweepExecutor.sweep for one call (every asset eligible, oracle OK). Mutates the pools on a fill. */
function execSweep(call: readonly Due[], limits: readonly { asset: Address; minOutPerUsdg: bigint }[], pools: Record<string, Pool>) {
  const legs: { account: Address; asset: string; usdg: bigint }[] = [];
  const totals = new Map<string, bigint>();
  for (const e of call) {
    for (const s of splitMix(e.value, e.legs)) {
      legs.push({ account: e.account, asset: lc(s.asset), usdg: s.usdg });
      totals.set(lc(s.asset), (totals.get(lc(s.asset)) ?? 0n) + s.usdg);
    }
  }
  const got = new Map<string, bigint>(); // `${account}:${asset}` -> tokens
  const deferred = new Set<string>();
  for (const [asset, total] of totals) {
    const lim = limits.find((l) => lc(l.asset) === asset)?.minOutPerUsdg ?? 0n;
    const fee = (total * FEE_BPS) / 10_000n;
    const swapIn = total - fee;
    const fair = oracleTokensFor(swapIn, PRICE[asset]!);
    let minOut = (swapIn * lim) / 1_000_000n;
    const oracleMin = (fair * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    if (oracleMin > minOut) minOut = oracleMin;
    const out = pools[asset]!.quote(swapIn);
    if (lim === 0n || out < minOut || out < (fair * (10_000n - BAND_BPS)) / 10_000n) {
      deferred.add(asset);
      continue;
    }
    pools[asset]!.swap(swapIn);
    let assigned = 0n;
    let last = "";
    for (const l of legs) {
      if (l.asset !== asset) continue;
      const share = (out * l.usdg) / total;
      assigned += share;
      last = `${l.account}:${asset}`;
      got.set(last, (got.get(last) ?? 0n) + share);
    }
    got.set(last, got.get(last)! + out - assigned);
  }
  return { got, deferred, swept: new Set(call.map((e) => e.account)) };
}

/** How far under the oracle a fill landed, bps of the USDG spent on the leg (fee included). */
function underOracleBps(tokens: bigint, legUsdg: bigint, asset: Address): number {
  const fair = oracleTokensFor(legUsdg, PRICE[lc(asset)]!);
  return Number(((fair - tokens) * 100_000n) / fair) / 10;
}

/** The keeper before A-M1: every due account in ONE call, limits quoted on the netted swaps. */
async function nettedPlan(entries: readonly Due[], quote: Quoter) {
  const totals = new Map<Address, bigint>();
  for (const e of entries) for (const s of splitMix(e.value, e.legs)) totals.set(s.asset, (totals.get(s.asset) ?? 0n) + s.usdg);
  const need = [...totals].map(([asset, t]) => ({ asset, swapIn: swapInFor(t, FEE_BPS) }));
  const outs = await quote(need);
  return need.map((n, i) => ({ asset: n.asset, minOutPerUsdg: limitFromQuote(n.swapIn, outs[i]!, TOL) }));
}

const mix = (...legs: [Address, number][]) => legs.map(([asset, bps]) => ({ asset, bps }));
const planOpts = (pools: Record<string, Pool>, seen?: QuoteReq[], isolated = false) => ({
  state: () => "ok" as const,
  feeBps: FEE_BPS,
  toleranceBps: TOL,
  allowanceBps: 30,
  sizeAllowanceBps: 30,
  maxShortfallBps: 120,
  isolated,
  quote: quoterFor(pools, seen),
  market: marketFor(pools),
});

describe("NettedWhale regression (A-M1): one account's size never sets another's limit", () => {
  // NVDA hookless fee-100 pool with ~$442k of USDG depth: a $5k buy moves it ~113 bps.
  const fresh = () => ({ [lc(SPY)]: poolAt(SPY, 5_000_000, 500n), [lc(NVDA)]: poolAt(NVDA, 442_000, 100n) });
  const mallory: Due = { account: MALLORY, value: usd(5_000), legs: mix([NVDA, 10_000]) };
  const alice: Due = { account: ALICE, value: usd(20), legs: mix([SPY, 6_000], [NVDA, 4_000]) };

  test("before: in one netted call Alice's $8 NVDA leg fills ~110 bps under the oracle", async () => {
    const pools = fresh();
    const limits = await nettedPlan([mallory, alice], quoterFor(pools));
    const r = execSweep([mallory, alice], limits, pools);
    expect(r.deferred.size).toBe(0);
    expect(underOracleBps(r.got.get(`${ALICE}:${lc(NVDA)}`)!, usd(8), NVDA)).toBeGreaterThan(130); // 25 fee + ~111 impact
  });

  test("after: Mallory is isolated and Alice's NVDA limit is computed from Alice's call only", async () => {
    const pools = fresh();
    const part = await partitionSweep([mallory, alice], { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: 30, quote: quoterFor(pools) });
    expect(part.calls.map((c) => c.map((e) => e.account))).toEqual([[ALICE], [MALLORY]]);
    expect(part.isolated).toHaveLength(1);
    expect(part.isolated[0]!.asset).toBe(NVDA);
    expect(part.isolated[0]!.impactBps).toBeGreaterThan(100);

    // Call 1: Alice alone. Her NVDA limit is the quote of HER leg, nothing else.
    const seen: QuoteReq[] = [];
    const plan = await planCall(part.calls[0]!, planOpts(pools, seen));
    const aliceNvda = swapInFor(usd(8), FEE_BPS);
    // Her own leg, plus the $1 reference that checks the pool itself against the oracle.
    expect(seen.filter((q) => q.asset === NVDA).map((q) => q.swapIn)).toEqual([aliceNvda, REF_SWAP_IN]);
    const nvdaLimit = plan.limits.find((l) => l.asset === NVDA)!.minOutPerUsdg;
    expect(nvdaLimit).toBe(limitFromQuote(aliceNvda, pools[lc(NVDA)]!.quote(aliceNvda), TOL));
    const r = execSweep(plan.chosen, plan.limits, pools);
    expect(r.deferred.size).toBe(0);
    // Alice pays the conversion fee (25 bps) + the 1 bp pool fee, not Mallory's impact.
    expect(underOracleBps(r.got.get(`${ALICE}:${lc(NVDA)}`)!, usd(8), NVDA)).toBeLessThan(27);

    // Call 2: Mallory alone. The pool itself sits on the oracle ($1 check
    // passes); her own ~113 bps impact only costs her and stays inside the
    // 120 bps cap (under the executor's 150 bps backstop), so she is swept
    // alone, after Alice, at her own price.
    const m = await planCall(part.calls[1]!, planOpts(pools, undefined, true));
    expect(m.chosen.map((e) => e.account)).toEqual([MALLORY]);
    const rm = execSweep(m.chosen, m.limits, pools);
    expect(rm.deferred.size).toBe(0);
    expect(rm.got.get(`${MALLORY}:${lc(NVDA)}`)!).toBeGreaterThan(0n);

    // Packed with others she would not be: the same quote fails a packed call's
    // pool fee + 30 + 30 bps.
    const packed = await planCall(part.calls[1]!, planOpts(pools));
    expect(packed.chosen).toEqual([]);
    expect(packed.dropped.get(lc(NVDA))!.why).toContain("under the oracle");
  });

  test("a whale past the router band used to defer everyone's leg (and burn their epoch); now only the whale waits", async () => {
    const whale: Due = { account: MALLORY, value: usd(12_000), legs: mix([NVDA, 10_000]) };
    const before = fresh();
    const old = execSweep([whale, alice], await nettedPlan([whale, alice], quoterFor(before)), before);
    expect(old.deferred.has(lc(NVDA))).toBe(true); // ~270 bps impact > 150 bps oracle floor
    expect(old.swept.has(ALICE)).toBe(true); // ...after Alice was marked swept for the epoch
    expect(old.got.get(`${ALICE}:${lc(NVDA)}`)).toBeUndefined();

    const pools = fresh();
    const part = await partitionSweep([whale, alice], { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: 30, quote: quoterFor(pools) });
    expect(part.calls.map((c) => c.map((e) => e.account))).toEqual([[ALICE], [MALLORY]]);
    const plan = await planCall(part.calls[0]!, planOpts(pools));
    const r = execSweep(plan.chosen, plan.limits, pools);
    expect(r.deferred.size).toBe(0);
    expect(r.got.get(`${ALICE}:${lc(NVDA)}`)!).toBeGreaterThan(0n);
    // Alone, the $12k whale's ~270 bps impact is past the 120 bps cap: held
    // (no epoch burned), never sent to fail the 150 bps backstop.
    const w = await planCall(part.calls[1]!, planOpts(pools, undefined, true));
    expect(w.chosen).toEqual([]);
    expect(w.dropped.get(lc(NVDA))!.why).toMatch(/under the oracle \(max 120\.0, alone\)$/);
  });
});

describe("partition: gas stays sane", () => {
  test("no asset over the impact cap -> one call with everyone, two quotes per asset", async () => {
    const pools = { [lc(SPY)]: poolAt(SPY, 5_000_000, 500n), [lc(NVDA)]: poolAt(NVDA, 442_000, 100n) };
    const seen: QuoteReq[] = [];
    const entries: Due[] = [
      { account: ALICE, value: usd(20), legs: mix([SPY, 6_000], [NVDA, 4_000]) },
      { account: BOB, value: usd(300), legs: mix([NVDA, 10_000]) },
      { account: MALLORY, value: usd(50), legs: mix([SPY, 10_000]) },
    ];
    const part = await partitionSweep(entries, { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: 30, quote: quoterFor(pools, seen) });
    expect(part.calls).toEqual([entries]);
    expect(part.isolated).toEqual([]);
    expect(seen).toHaveLength(4);
  });

  test("many mid-size accounts are packed so each call's netted swap stays inside the cap", async () => {
    const pools = { [lc(NVDA)]: poolAt(NVDA, 442_000, 100n) };
    const entries: Due[] = Array.from({ length: 10 }, (_, i) => ({
      account: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      value: usd(400),
      legs: mix([NVDA, 10_000]),
    }));
    const part = await partitionSweep(entries, { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: 30, quote: quoterFor(pools) });
    expect(part.isolated).toEqual([]); // ~9 bps each: nobody is a whale
    expect(part.calls.flat()).toHaveLength(10);
    expect(part.calls.length).toBe(5); // $4k netted is ~90 bps; two $400 legs fit under the ~$1k cap
    const pool = pools[lc(NVDA)]!;
    const ref = { swapIn: 1_000_000n, out: pool.quote(1_000_000n) };
    for (const call of part.calls) {
      const swapIn = swapInFor(call.reduce((s, e) => s + e.value, 0n), FEE_BPS);
      expect(impactBps(ref, swapIn, pool.quote(swapIn))).toBeLessThanOrEqual(30);
    }
  });

  test("an asset whose impact cannot be measured sits its accounts out; the rest go", async () => {
    const pools = { [lc(SPY)]: poolAt(SPY, 5_000_000, 500n) };
    const entries: Due[] = [
      { account: ALICE, value: usd(20), legs: mix([SPY, 5_000], [NVDA, 5_000]) },
      { account: BOB, value: usd(20), legs: mix([SPY, 10_000]) },
    ];
    const part = await partitionSweep(entries, { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: 30, quote: quoterFor(pools) });
    expect(part.unmeasured).toEqual([NVDA]);
    expect(part.sittingOut.map((e) => e.account)).toEqual([ALICE]);
    expect(part.calls.map((c) => c.map((e) => e.account))).toEqual([[BOB]]);
  });

  test("a leg never measured inside the cap is isolated, not assumed fine", async () => {
    // Three $1k legs (~23 bps each) + Alice's $10; netted $3,010 is ~68 bps. The
    // halving ladder only proves ~$750 fits, so a $1k leg is "fine" only if its
    // own quote says so.
    const pool = poolAt(NVDA, 442_000, 100n);
    const k = (i: number) => `0x${(0xc0 + i).toString(16).padStart(40, "0")}` as Address;
    const entries: Due[] = [
      { account: ALICE, value: usd(10), legs: mix([NVDA, 10_000]) },
      ...[1, 2, 3].map((i) => ({ account: k(i), value: usd(1_000), legs: mix([NVDA, 10_000]) })),
    ];
    const opts = { needsQuote: () => true, feeBps: FEE_BPS, maxImpactBps: 30 };
    const measured = await partitionSweep(entries, { ...opts, quote: quoterFor({ [lc(NVDA)]: pool }) });
    expect(measured.isolated).toEqual([]);
    expect(measured.calls.map((c) => c.map((e) => e.account))).toEqual([[ALICE], [k(1)], [k(2)], [k(3)]]);

    // The same, but the $1k leg size will not quote (a hook reverting at that size): over the cap.
    const leg = swapInFor(usd(1_000), FEE_BPS);
    const quote: Quoter = async (reqs) => reqs.map((r) => (r.swapIn === leg ? null : pool.quote(r.swapIn)));
    const blind = await partitionSweep(entries, { ...opts, quote });
    expect(blind.isolated.map((i) => [i.entry.account, i.impactBps])).toEqual([
      [k(1), null],
      [k(2), null],
      [k(3), null],
    ]);
    expect(blind.calls.map((c) => c.map((e) => e.account))).toEqual([[ALICE], [k(1)], [k(2)], [k(3)]]);
  });
});

describe("planCall: a quote becomes a limit only if it agrees with the oracle (B-L3)", () => {
  test("a pool pushed 60 bps under the oracle holds its accounts; the rest re-net without them", async () => {
    const pools = { [lc(SPY)]: poolAt(SPY, 5_000_000, 500n), [lc(NVDA)]: poolAt(NVDA, 442_000, 100n, 60n) };
    const a: Due = { account: ALICE, value: usd(20), legs: mix([SPY, 6_000], [NVDA, 4_000]) };
    const b: Due = { account: BOB, value: usd(10), legs: mix([SPY, 10_000]) };
    const seen: QuoteReq[] = [];
    const plan = await planCall([a, b], planOpts(pools, seen));
    expect(plan.chosen.map((e) => e.account)).toEqual([BOB]);
    expect(plan.dropped.get(lc(NVDA))!.why).toMatch(/^pool 6\d\.\d bps under the oracle at \$1 \(max 31\.0: pool fee \+ 30\)$/);
    const bobSpy = swapInFor(usd(10), FEE_BPS);
    expect(plan.limits).toEqual([{ asset: SPY, minOutPerUsdg: limitFromQuote(bobSpy, pools[lc(SPY)]!.quote(bobSpy), TOL) }]);
    expect(seen.at(-1)).toEqual({ asset: SPY, swapIn: bobSpy }); // re-quoted for Bob's swap alone
  });

  test("the pool's own fee is allowed for: a 1% pool quoting 1.1% under the oracle passes", async () => {
    const pools = { [lc(INTC)]: poolAt(INTC, 2_000_000, 10_000n, 10n) };
    const plan = await planCall([{ account: ALICE, value: usd(10), legs: mix([INTC, 10_000]) }], planOpts(pools));
    expect(plan.chosen).toHaveLength(1);
    expect(plan.limits).toHaveLength(1);
  });

  test("no OK oracle price or no quote -> the asset is held, never sent without a limit", async () => {
    const pools = { [lc(SPY)]: poolAt(SPY, 5_000_000, 500n) };
    const noPrice = await planCall([{ account: ALICE, value: usd(10), legs: mix([SPY, 10_000]) }], {
      ...planOpts(pools),
      market: async () => new Map(),
    });
    expect(noPrice.chosen).toEqual([]);
    expect(noPrice.dropped.get(lc(SPY))!.why).toBe("no OK oracle price");
    const noQuote = await planCall([{ account: ALICE, value: usd(10), legs: mix([NVDA, 10_000]) }], {
      ...planOpts(pools),
      market: async () => new Map([[lc(NVDA), { price1e18: PRICE[lc(NVDA)]!, feePips: 100 }]]),
    });
    expect(noQuote.chosen).toEqual([]);
    expect(noQuote.dropped.get(lc(NVDA))!.why).toBe("no quote");
  });

  test("each limit's $1 reference quote and oracle price come back with the plan (what an isolated call's recovery is measured from)", async () => {
    const pools = { [lc(SPY)]: poolAt(SPY, 5_000_000, 500n), [lc(NVDA)]: poolAt(NVDA, 442_000, 100n, 60n) };
    const plan = await planCall([{ account: ALICE, value: usd(20), legs: mix([SPY, 6_000], [NVDA, 4_000]) }, { account: BOB, value: usd(10), legs: mix([SPY, 10_000]) }], planOpts(pools));
    expect([...plan.refs]).toEqual([[lc(SPY), { ref: pools[lc(SPY)]!.quote(REF_SWAP_IN), price1e18: PRICE[lc(SPY)]! }]]); // NVDA was dropped
  });

  test("a pool held by its own state (a hooked pool off its pin) is held whatever its quote", () => {
    const m: Market = { price1e18: PRICE[lc(SPY)]!, feePips: 500 };
    const ref = poolAt(SPY, 5_000_000, 500n).quote(REF_SWAP_IN);
    expect(poolHeld(ref, m, 60)).toBeNull();
    expect(poolHeld(ref, { ...m, held: "hook fee 9000 pips is above the keeper's 4000" }, 60)).toBe("hook fee 9000 pips is above the keeper's 4000");
  });

  test("safe-settle legs need no quote and never block the call", async () => {
    const pools = { [lc(SPY)]: poolAt(SPY, 5_000_000, 500n) };
    const plan = await planCall([{ account: ALICE, value: usd(10), legs: mix([NVDA, 10_000]) }], {
      ...planOpts(pools),
      state: (a: Address) => (a === NVDA ? ("settle" as const) : ("ok" as const)),
    });
    expect(plan.chosen).toHaveLength(1);
    expect(plan.limits).toEqual([]);
    expect(plan.settleOnly).toBe(1);
  });
});

describe("recoveryHeld: after an isolated call, an asset waits for its pool (A-M1 residual)", () => {
  const ref = 5_555_555_555_555_555n; // tokens per $1 at $180
  const r = { asset: NVDA, ref, price1e18: PRICE[lc(NVDA)]!, since: 1_000_000 };
  const opts = { bps: 10, maxMs: 4 * 3_600_000 };
  const at = 1_000_000 + 600_000;
  const off = (bps: bigint) => (ref * (10_000n - bps)) / 10_000n;

  test("held while the $1 quote is more than `bps` under its value before the call; released within it", () => {
    expect(recoveryHeld(r, { ref: off(80n), price1e18: r.price1e18, at }, opts)).toEqual({
      held: true,
      why: "$1 quote 80.0 bps under its value before an isolated sweep (max 10)",
    });
    expect(recoveryHeld(r, { ref: off(11n), price1e18: r.price1e18, at }, opts).held).toBe(true);
    expect(recoveryHeld(r, { ref: off(9n), price1e18: r.price1e18, at }, opts)).toEqual({ held: false, why: "recovered" });
    expect(recoveryHeld(r, { ref: ref + 1n, price1e18: r.price1e18, at }, opts)).toEqual({ held: false, why: "recovered" }); // overshot: cheaper than before
  });

  test("rebased by the oracle: a move the feed posted is the market's; a move against it is not", () => {
    const up80 = (r.price1e18 * 10_080n) / 10_000n;
    expect(recoveryHeld(r, { ref: off(80n), price1e18: up80, at }, opts).held).toBe(false);
    const down80 = (r.price1e18 * 9_920n) / 10_000n;
    expect(recoveryHeld(r, { ref, price1e18: down80, at }, opts)).toEqual({ held: true, why: "$1 quote 79.9 bps under its value before an isolated sweep (max 10)" });
  });

  test("fails closed on a missing quote or price; lapses after maxMs", () => {
    expect(recoveryHeld(r, { ref: null, price1e18: r.price1e18, at }, opts)).toEqual({ held: true, why: "no $1 reference quote" });
    expect(recoveryHeld(r, { ref, price1e18: null, at }, opts)).toEqual({ held: true, why: "no OK oracle price" });
    expect(recoveryHeld(r, { ref: off(500n), price1e18: r.price1e18, at: r.since + opts.maxMs }, opts)).toEqual({ held: false, why: "expired" });
    expect(recoveryHeld(r, { ref: null, price1e18: null, at: r.since + opts.maxMs }, opts)).toEqual({ held: false, why: "expired" });
  });
});
