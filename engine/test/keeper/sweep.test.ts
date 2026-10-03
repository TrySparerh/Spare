/**
 * Keeper sweep tick against a fake chain: which accounts are due, which wait
 * (oracle, market hours, ERC-8056 multiplier change), how calls are split so
 * one account's impact never sets another's limit (A-M1), the quote-vs-oracle
 * hold (B-L3), and the exact `sweep(accounts, limits)` calldata signed.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { encodeErrorResult, getAddress, parseAbi, type Address } from "viem";
import { stockRouterAbi, sweepExecutorAbi } from "../../src/chain/abis.ts";
import { MULTICALL3, TOKENS, USDG, VENUE } from "../../src/chain/constants.ts";
import { limitFromQuote, quoteVsOracle, swapInFor } from "../../src/keeper/plan.ts";
import { Revert, rpcError } from "../helpers/fake-rpc.ts";
import { addr, BOOK, captureLogs, cpQuote, KEEPER, keeperOn, SAT_1500, SpareWorld, usd, WED_1500, type AssetState } from "../helpers/fake-rpc-spare.ts";

const SPY = getAddress(TOKENS.SPY);
const NVDA = getAddress(TOKENS.NVDA);
const OLD = addr(0x01d); // a deactivated asset
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);
const CAROL = addr(0xca201);
const DAVE = addr(0xda5e);
const ERIN = addr(0xe1e);
const FRED = addr(0xf2ed);
const GINA = addr(0x6a);
const MALLORY = addr(0xba11);
const TOL = 50n; // QUOTE_TOLERANCE_BPS default
const FEE = 25n; // executor feeBps in the world

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  setSystemTime();
});

let walletN = 0x7000;
/** An account the keeper discovers (Linked + RuleSet), with `value` parked and `mix`. */
function due(w: SpareWorld, account: Address, value: number, mix: [Address, number][]) {
  w.enroll(account, [addr(walletN++)], { block: 2_000n + BigInt(walletN) });
  w.account(account, { value: usd(value), mix: mix.map(([asset, bps]) => ({ asset, bps })) });
}
function world(ts = WED_1500): { w: SpareWorld; spy: AssetState; nvda: AssetState } {
  const w = new SpareWorld({ ts });
  return { w, spy: w.asset(SPY, 660), nvda: w.asset(NVDA, 180) };
}
const pool = (s: AssetState) => ({ ...s.pool });
const sweeps = (w: SpareWorld) => w.rpc.sent.filter((t) => t.functionName === "sweep").map((t) => t.args as [Address[], { asset: Address; minOutPerUsdg: bigint }[]]);
const history = (k: { history: { detail: string; ok: boolean }[] }) => k.history.map((h) => `${h.ok ? "ok" : "FAIL"} ${h.detail}`);
/** V4Quoter calls as (asset swapped, exactAmount, block, zeroForOne). */
function quotes(w: SpareWorld) {
  return w.rpc.callsTo("quoteExactInputSingle").map((c) => {
    const p = c.args[0] as { poolKey: { currency0: Address; currency1: Address }; zeroForOne: boolean; exactAmount: bigint };
    const token = p.poolKey.currency0.toLowerCase() === USDG.toLowerCase() ? p.poolKey.currency1 : p.poolKey.currency0;
    return { token, swapIn: p.exactAmount, block: c.block, zeroForOne: p.zeroForOne };
  });
}

describe("netted quote and limits", () => {
  test("legs are netted per asset exactly as the executor nets them; each limit is the pinned quote less the tolerance", async () => {
    const { w, spy, nvda } = world();
    due(w, ALICE, 20, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, BOB, 30, [
      [SPY, 5_000],
      [NVDA, 5_000],
    ]);
    due(w, CAROL, 5, [[SPY, 10_000]]); // under the $10 threshold
    due(w, DAVE, 40, [[SPY, 10_000]]);
    w.account(DAVE, { sweptEpoch: w.executor.epoch }); // already swept this epoch
    due(w, ERIN, 40, [[SPY, 10_000]]);
    w.account(ERIN, { eligible: false }); // screening
    due(w, FRED, 40, []); // no mix
    const spyIn = swapInFor(usd(12 + 15), FEE);
    const nvdaIn = swapInFor(usd(8 + 15), FEE);
    const want = [
      { asset: SPY, minOutPerUsdg: limitFromQuote(spyIn, cpQuote(pool(spy), spyIn), TOL) },
      { asset: NVDA, minOutPerUsdg: limitFromQuote(nvdaIn, cpQuote(pool(nvda), nvdaIn), TOL) },
    ];
    const k = keeperOn(w);
    await k.sweepTick();

    expect(sweeps(w)).toEqual([[[ALICE, BOB], want]]);
    const tx = w.rpc.sent[0]!;
    expect(tx).toMatchObject({ from: KEEPER, to: BOOK.sweepExecutor.toLowerCase(), chainId: 4663, nonce: 0 });
    // The limits come from quotes of the exact netted swaps, pinned two blocks behind head, in the pool's
    // direction; each pool is also quoted at the $1 reference to check the pool itself against the oracle.
    expect(quotes(w).filter((q) => q.block === 199_998n)).toEqual([
      { token: SPY, swapIn: spyIn, block: 199_998n, zeroForOne: false }, // SPY sorts before USDG: currency0
      { token: NVDA, swapIn: nvdaIn, block: 199_998n, zeroForOne: true },
      { token: SPY, swapIn: 1_000_000n, block: 199_998n, zeroForOne: false },
      { token: NVDA, swapIn: 1_000_000n, block: 199_998n, zeroForOne: true },
    ]);
    // Only accounts over the threshold get their detail read.
    expect(w.rpc.callsTo("mixOf").map((c) => c.args[0])).toEqual([ALICE, BOB, DAVE, ERIN, FRED]);
    expect(history(k)[0]).toBe("ok 2 accounts, $50.00 across 2 quoted assets");
    expect(k.history[0]!.tx).toBe(tx.hash);
    expect(w.accounts.get(ALICE)!.sweptEpoch).toBe(w.executor.epoch);
  });

  test("a deactivated asset's leg is safe-settled: no quote, no limit, and it never holds the account", async () => {
    const { w } = world();
    w.asset(OLD, 10).eligible = false;
    due(w, ALICE, 20, [
      [SPY, 5_000],
      [OLD, 5_000],
    ]);
    due(w, GINA, 15, [[OLD, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    const [accounts, limits] = sweeps(w)[0]!;
    expect(accounts).toEqual([ALICE, GINA]);
    expect(limits.map((l) => l.asset)).toEqual([SPY]);
    expect(quotes(w).some((q) => q.token === OLD)).toBe(false);
    expect(history(k)[0]).toContain("across 1 quoted assets, 1 safe-settle only");
  });
});

describe("whale isolation (A-M1)", () => {
  test("an account whose own leg moves the pool past the cap is swept alone, last, and quoted after the first call is mined", async () => {
    const { w, nvda } = world();
    due(w, ALICE, 20, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, MALLORY, 25_000, [[NVDA, 10_000]]);
    const p0 = pool(nvda);
    const aliceIn = swapInFor(usd(8), FEE);
    const malloryIn = swapInFor(usd(25_000), FEE);
    const nettedIn = swapInFor(usd(25_008), FEE);
    const p1 = { ...p0, x: p0.x + aliceIn, y: p0.y - cpQuote(p0, aliceIn) }; // after Alice's call
    const k = keeperOn(w);
    await k.sweepTick();

    const calls = sweeps(w);
    expect(calls.map(([a]) => a)).toEqual([[ALICE], [MALLORY]]);
    const aliceNvda = calls[0]![1].find((l) => l.asset === NVDA)!.minOutPerUsdg;
    expect(aliceNvda).toBe(limitFromQuote(aliceIn, cpQuote(p0, aliceIn), TOL));
    // Netted with Mallory, Alice's limit (and fill) would have been ~50 bps worse.
    const netted = limitFromQuote(nettedIn, cpQuote(p0, nettedIn), TOL);
    expect(aliceNvda * 10_000n).toBeGreaterThan(netted * 10_040n);
    expect(calls[1]![1]).toEqual([{ asset: NVDA, minOutPerUsdg: limitFromQuote(malloryIn, cpQuote(p1, malloryIn), TOL) }]);
    const mined = w.rpc.sent[0]!.block!;
    expect(quotes(w).filter((q) => q.swapIn === malloryIn && q.block >= mined)).toHaveLength(1);
    expect(logs.has(new RegExp(`plan: 2 call\\(s\\) \\[1, 1 accounts\\]; on their own, last: ${MALLORY} \\(${NVDA} impact \\d+ bps > 30 bps\\)`))).toBe(true);
    expect(history(k).slice(0, 2)).toEqual([
      expect.stringMatching(new RegExp(`^ok call 2/2: 1 accounts, \\$25000\\.00 across 1 quoted assets; ${NVDA} held until its pool recovers$`)),
      expect.stringMatching(/^ok call 1\/2: 1 accounts, \$20\.00 across 2 quoted assets$/),
    ]);
  });

  test("a pool too thin for even one small account: probed down to the $1 reference, then swept alone at its own impact", async () => {
    const { w } = world();
    w.asset(NVDA, 180, { depth: 5_000 }); // $20 moves this pool ~40 bps
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    const head = w.rpc.head;
    await k.sweepTick();
    // $1 reference + the netted swap; then, over the cap, the leg itself and a halving ladder that stops at $1.
    const probes = quotes(w).filter((q) => q.block === head).map((q) => q.swapIn);
    const leg = swapInFor(usd(20), FEE);
    expect(probes).toEqual([1_000_000n, leg, leg, leg / 2n, leg / 4n, leg / 8n, leg / 16n]);
    // Isolated, her ~40 bps only costs her and stays inside the 120 bps cap: she is swept, not held forever.
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
    expect(history(k)[0]).toMatch(new RegExp(`^ok 1 accounts, \\$20\\.00 across 1 quoted assets; ${NVDA} held until its pool recovers$`));
  });

  test("an account whose own impact is past the 120 bps cap is held alone, never sent to fail the backstop", async () => {
    const { w } = world();
    w.asset(NVDA, 180, { depth: 500 }); // $20 moves this pool ~400 bps
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toMatch(/held this tick: .* bps under the oracle \(max 120\.0, alone\)\); epochs kept$/);
  });

  test("SWEEP_MAX_CALLS caps the calls per tick; the rest wait", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    due(w, MALLORY, 25_000, [[NVDA, 10_000]]);
    const k = keeperOn(w, { SWEEP_MAX_CALLS: "1" });
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
    expect(history(k)[0]).toBe("ok 1 more call(s) wait for the next tick (SWEEP_MAX_CALLS 1)");
  });

  test("an RPC head behind our last tx stops the remaining calls", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    due(w, MALLORY, 25_000, [[NVDA, 10_000]]);
    w.rpc.use((method) => {
      if (method === "eth_blockNumber" && w.rpc.sent.length === 1) return "0x1"; // a lagging node
    });
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w)).toHaveLength(1);
    expect(history(k)[0]).toBe("ok call 2/2: RPC head 1 is behind our last tx block 200001; the rest wait for the next tick");
  });
});

describe("after an isolated call (A-M1 residual): the whale's leftover impact sets nobody's limit", () => {
  const OSCAR = addr(0x05ca2);
  /** NVDA quoting 60 bps better than the oracle, so a whale's ~80 bps of leftover impact still passes the $1 pool check (fee 30 + 60). */
  function cheapNvda() {
    const { w } = world();
    const nvda = w.asset(NVDA, 180, { offBps: -60n });
    return { w, nvda, p0: pool(nvda) };
  }
  const ref = (p: AssetState["pool"]) => cpQuote(p, 1_000_000n);
  const HELD = / \(\$1 quote \d+\.\d bps under its value before an isolated sweep \(max 10\)\)/;
  const released = `[keeper:sweep] ${NVDA}: $1 quote back within 10 bps of its value before the isolated sweep; released`;

  test("a second whale in the same tick is held until the first one's impact is gone, then swept; the pool check alone would have let it fill", async () => {
    const { w, nvda, p0 } = cheapNvda();
    due(w, MALLORY, 20_000, [[NVDA, 10_000]]);
    due(w, OSCAR, 20_000, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY]]);
    expect(Number(((ref(p0) - ref(nvda.pool)) * 10_000n) / ref(p0))).toBeGreaterThan(60); // Mallory's leftover impact
    const [second, first] = history(k);
    expect(second!.startsWith(`FAIL call 2/2: 1 due, none sweepable; held this tick: ${NVDA} ($1 quote `)).toBe(true);
    expect(second).toMatch(HELD);
    expect(second!.endsWith("; epochs kept")).toBe(true);
    expect(first).toBe(`ok call 1/2: 1 accounts, $20000.00 across 1 quoted assets; ${NVDA} held until its pool recovers`);
    expect(w.accounts.get(OSCAR)!.sweptEpoch).toBe(0n);
    expect(k.health().assetsRecovering).toEqual([NVDA]);

    // Next tick, still not recovered: Oscar waits, before any quote of his own size.
    w.rpc.head += 10n;
    const before = quotes(w).length;
    await k.sweepTick();
    expect(sweeps(w)).toHaveLength(1);
    expect(history(k)[0]!.startsWith(`FAIL 1 due, none sweepable; held this tick: ${NVDA} ($1 quote `)).toBe(true);
    expect(quotes(w).slice(before).map((q) => q.swapIn)).toEqual([1_000_000n]); // the $1 reference only

    // Arbitrage puts the pool back within 10 bps of its pre-sweep $1 quote: released, and Oscar is swept on his own.
    nvda.pool = { ...p0, y: (p0.y * 9_995n) / 10_000n };
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(logs.has(released)).toBe(true);
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY], [OSCAR]]);
    expect(k.health().assetsRecovering).toEqual([NVDA]); // Oscar's own call is isolated too
  });

  test("an account due later in the epoch waits for the pool too: a small leg never fills into a whale's impact", async () => {
    const { w, nvda, p0 } = cheapNvda();
    due(w, MALLORY, 20_000, [[NVDA, 10_000]]);
    due(w, CAROL, 0, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, BOB, 0, [[SPY, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY]]);

    // Carol and Bob cross the threshold after Mallory's sweep.
    w.account(CAROL, { value: usd(20) });
    w.account(BOB, { value: usd(20) });
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY], [BOB]]);
    expect(history(k)[0]!.startsWith(`ok 1 accounts, $20.00 across 1 quoted assets; held this tick: ${NVDA} ($1 quote `)).toBe(true);
    expect(w.accounts.get(CAROL)!.sweptEpoch).toBe(0n);

    nvda.pool = { ...p0 };
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(logs.has(released)).toBe(true);
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY], [BOB], [CAROL]]);
    expect(k.health().assetsRecovering).toEqual([]); // Carol's call was not isolated
  });

  test("a move the oracle has posted since is the market's, not leftover impact: released", async () => {
    const { w, nvda, p0 } = cheapNvda();
    due(w, MALLORY, 20_000, [[NVDA, 10_000]]);
    due(w, CAROL, 0, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    w.account(CAROL, { value: usd(20) });
    // The feed posts NVDA up by exactly what the pool moved: the pool is where the market now is.
    nvda.price1e18 = (nvda.price1e18 * ref(p0)) / ref(nvda.pool);
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(logs.has(released)).toBe(true);
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY], [CAROL]]);
  });

  test("the hold lapses after SWEEP_RECOVERY_MAX_MS whatever the quote (the oracle checks still apply)", async () => {
    const { w } = cheapNvda();
    due(w, MALLORY, 20_000, [[NVDA, 10_000]]);
    due(w, CAROL, 0, [[NVDA, 10_000]]);
    const k = keeperOn(w, { SWEEP_RECOVERY_MAX_MS: "600000" });
    await k.sweepTick();
    w.account(CAROL, { value: usd(20) });
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(sweeps(w)).toHaveLength(1);
    setSystemTime(new Date(Date.now() + 600_000));
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(logs.has(`[keeper:sweep] ${NVDA}: $1 quote still off its value before the isolated sweep after 10 min; hold lapsed (the oracle checks still apply)`)).toBe(true);
    expect(sweeps(w).map(([a]) => a)).toEqual([[MALLORY], [CAROL]]);
  });

  test("nothing is held when the isolated call bought nothing: simulate-only, or its swap deferred", async () => {
    for (const [env, defer] of [
      [{ KEEPER_BROADCAST: "0" }, false],
      [{}, true],
    ] as const) {
      const { w } = cheapNvda();
      if (defer) w.sweepDefers.set(NVDA.toLowerCase(), "0x1234");
      due(w, MALLORY, 20_000, [[NVDA, 10_000]]);
      const k = keeperOn(w, env);
      await k.sweepTick();
      expect(k.history.length).toBeGreaterThan(0);
      expect(k.health().assetsRecovering).toEqual([]);
    }
  });
});

describe("quote vs oracle (B-L3)", () => {
  test("a pool pushed under the oracle holds the accounts holding that asset; the rest are re-netted and swept", async () => {
    const { w, nvda } = world();
    w.asset(SPY, 660, { offBps: 100n });
    due(w, ALICE, 20, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, BOB, 30, [[NVDA, 10_000]]);
    const bobIn = swapInFor(usd(30), FEE);
    const want = limitFromQuote(bobIn, cpQuote(pool(nvda), bobIn), TOL);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w)).toEqual([[[BOB], [{ asset: NVDA, minOutPerUsdg: want }]]]);
    expect(history(k)[0]).toMatch(new RegExp(`held this tick: ${SPY} \\(pool 1[23]\\d\\.\\d bps under the oracle at \\$1 \\(max 90\\.0: pool fee \\+ 60\\)\\)$`));
    expect(w.accounts.get(ALICE)!.sweptEpoch).toBe(0n);
  });

  test("defaults: a pool within the feeds' 50 bps deviation of a feed that has not posted is swept, the 60/40 mix included; one past fee + 60 is held", async () => {
    // Mainnet overnight, 2026-10-02: NVDA's fee-100 pool quoted $1 33 bps under a 12 h old feed and held the
    // default 60/40 SPY/NVDA mix all night at the old 30 bps allowance (max 31). Here it is 40 bps off.
    const { w } = world();
    const nvda = w.asset(NVDA, 180, { feePips: 100, offBps: 40n });
    w.asset(SPY, 660, { feePips: 500, offBps: 20n });
    const aapl = w.asset(getAddress(TOKENS.AAPL), 330, { feePips: 100, offBps: 75n }); // pushed further than the feeds drift
    due(w, ALICE, 20, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, BOB, 20, [[aapl.token, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w).map(([a, l]) => [a, l.map((x) => x.asset)])).toEqual([[[ALICE], [SPY, NVDA]]]);
    expect(history(k)[0]).toMatch(new RegExp(`held this tick: ${aapl.token} \\(pool 7\\d\\.\\d bps under the oracle at \\$1 \\(max 61\\.0: pool fee \\+ 60\\)\\)$`));
    expect(nvda.pool.x).toBeGreaterThan(usd(5_000_000)); // NVDA was bought
  });

  test("when every account is held, nothing is sent and every epoch is kept", async () => {
    const { w } = world();
    w.asset(NVDA, 180, { offBps: 200n });
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toMatch(/^FAIL 1 due, none sweepable; held this tick: .*; epochs kept$/);
  });

  test("the pool's fee is read by PoolId from StateView: a dynamic LP fee and the protocol fee for the swap direction", async () => {
    const { w } = world();
    // SPY: hooked pool, LP fee 1% (PoolKey fee is the 0x800000 flag); quotes ~1% under the oracle.
    const spy = w.asset(SPY, 660, { feePips: 0x800000 });
    spy.pool.feePips = 10_000n;
    spy.slot0 = { protocolFee: 0, lpFee: 10_000 };
    // NVDA (USDG is currency0, zeroForOne): 70 bps off, allowed only with its 0->1 protocol fee.
    const nvda = w.asset(NVDA, 180, { offBps: 70n });
    nvda.slot0 = { protocolFee: 2_000 << 12, lpFee: 0 }; // 1->0 direction only: does not apply
    due(w, ALICE, 20, [[SPY, 10_000]]);
    due(w, BOB, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
    expect(history(k)[0]).toMatch(new RegExp(`held this tick: ${NVDA} \\(pool \\d+\\.\\d bps under the oracle at \\$1 \\(max 90\\.0: pool fee \\+ 60\\)\\)$`));

    nvda.slot0 = { protocolFee: 2_000, lpFee: 0 }; // 0->1: 20 bps more allowed
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE], [BOB]]);
  });

  test("an unreadable slot0 counts no dynamic or protocol fee: the check only tightens", async () => {
    const { w } = world();
    const spy = w.asset(SPY, 660, { feePips: 0x800000 });
    spy.pool.feePips = 10_000n;
    spy.slot0 = { protocolFee: 0, lpFee: 10_000 };
    due(w, ALICE, 20, [[SPY, 10_000]]);
    w.rpc.contract(VENUE.v4StateView, [], {
      getSlot0: () => {
        throw new Revert("0x");
      },
    });
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w)).toHaveLength(0);
    expect(history(k)[0]).toMatch(/max 60\.0: pool fee \+ 60/);
  });

  test("a swap too small to buy one token wei at the oracle price is never held", () => {
    expect(quoteVsOracle({ swapIn: 1n, quotedOut: 0n, price1e18: 10n ** 37n, feePips: 3_000, allowanceBps: 30 })).toEqual({ ok: true, shortfallBps: 0, maxBps: 60 });
  });

  test("no OK oracle price at the call's block holds the asset", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    // OK when the tick classified it, stale by the time the call is planned.
    let reads = 0;
    w.rpc.contract(BOOK.stockRouter, [], {
      oracleStatus: () => (++reads === 1 ? [0, 180n * 10n ** 18n] : [1, 0n]),
    });
    const k = keeperOn(w);
    await k.sweepTick();
    expect(history(k)[0]).toContain(`held this tick: ${NVDA} (no OK oracle price)`);

    // Same when the router's oracle read itself reverts at the call's block.
    reads = 0;
    w.rpc.contract(BOOK.stockRouter, [], {
      oracleStatus: () => {
        if (++reads === 1) return [0, 180n * 10n ** 18n];
        throw new Revert("0x");
      },
    });
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(history(k)[0]).toContain(`held this tick: ${NVDA} (no OK oracle price)`);
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
  });
});

describe("hooked pools (A-L3): the hook's own fee, checked against its pin", () => {
  /** NVDA behind a dynamic-fee hook charging 0.40%, its spot 40 bps under the oracle: the $1 quote is ~80 bps under. */
  function hookedNvda(o: { fee?: number; offBps?: bigint } = {}) {
    const { w } = world();
    const nvda = w.asset(NVDA, 180, { offBps: o.offBps ?? 40n });
    const { hook, pin } = w.hooked(NVDA, { fee: o.fee ?? 4_000 });
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    return { w, nvda, hook, pin };
  }
  const env = (pins: unknown[]) => ({ HOOK_PINS: JSON.stringify(pins) });
  const heldFor = (k: { history: { detail: string; ok: boolean }[] }, why: string) =>
    expect(history(k)[0]).toBe(`FAIL 1 due, none sweepable; held this tick: ${NVDA} (${why}); epochs kept`);

  test("the swap's LP fee is the hook's currentFee for the keeper's direction, not slot0.lpFee (0 on these pools)", async () => {
    const { w, nvda, pin } = hookedNvda();
    expect(nvda.slot0.lpFee).toBe(0);
    const k = keeperOn(w, env([pin]));
    await k.sweepTick();
    // ~80 bps under the oracle at $1: inside the hook's 40 bps fee + 60; with slot0's 0 it was held (max 60).
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
    expect(w.rpc.callsTo("currentFee").map((c) => c.args)).toContainEqual([pin.poolId, true]); // USDG is NVDA's currency0
    expect(w.rpc.count("eth_getCode")).toBeGreaterThan(0);

    // SPY sorts before USDG: its swaps are oneForZero, and the hook is asked for that direction.
    const { w: w2 } = world();
    const { pin: spyPin } = w2.hooked(SPY, { fee: 500 });
    due(w2, BOB, 20, [[SPY, 10_000]]);
    await keeperOn(w2, env([spyPin])).sweepTick();
    expect(sweeps(w2).map(([a]) => a)).toEqual([[BOB]]);
    expect(new Set(w2.rpc.callsTo("currentFee").map((c) => c.args[1]))).toEqual(new Set([false]));
  });

  test("a fee above the pin's ceiling holds the asset even when the quote would pass; back under it, swept", async () => {
    const { w, hook, pin } = hookedNvda({ fee: 9_000, offBps: 0n });
    const k = keeperOn(w, env([pin]));
    await k.sweepTick();
    heldFor(k, "hook fee 9000 pips is above the keeper's 4000");
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(w.accounts.get(ALICE)!.sweptEpoch).toBe(0n);

    hook.fee = 3_000; // the operator's poke lapsed
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
  });

  test("fails closed: no pin, another pool, other code, another authority, a raised cap, an unreadable hook", async () => {
    const cases: [string, (x: ReturnType<typeof hookedNvda>) => unknown[], string | RegExp][] = [
      ["no pin", () => [], /^hooked pool \(hook 0x[0-9a-fA-F]{40}\) has no pin \(HOOK_PINS\)$/],
      ["another pool", ({ pin }) => [{ ...pin, poolId: `0x${"ab".repeat(32)}` }], /^pool 0x[0-9a-f]{64} on hook 0x[0-9a-fA-F]{40} is not the pinned TEST pool$/],
      [
        "other code",
        ({ w, hook, pin }) => {
          w.rpc.code.set(hook.address.toLowerCase(), "0x6080dead");
          return [pin];
        },
        /^hook code 0x[0-9a-f]{64} is not the pinned build$/,
      ],
      [
        "another authority",
        ({ hook, pin }) => {
          hook.authority = addr(0xbad);
          return [pin];
        },
        `hook authority ${addr(0xbad)} is not the pinned ${addr(0xa362)}`,
      ],
      [
        "a raised cap",
        ({ hook, pin }) => {
          hook.cap = 60_000;
          return [pin];
        },
        "hook fee cap 60000 pips is above the pinned 50000",
      ],
      [
        "currentFee reverts",
        ({ w, hook, pin }) => {
          w.rpc.contract(hook.address, [], {
            currentFee: () => {
              throw new Revert("0x");
            },
          });
          return [pin];
        },
        "hook state unreadable",
      ],
      [
        "no code read",
        ({ w, pin }) => {
          w.rpc.use((method) => {
            if (method === "eth_getCode") throw rpcError(-32000, "upstream unavailable");
          });
          return [pin];
        },
        "hook state unreadable",
      ],
      [
        "an unconfigured pool",
        ({ hook, pin }) => {
          hook.fee = 0;
          return [pin];
        },
        "hook reports the pool unconfigured",
      ],
    ];
    for (const [name, arrange, why] of cases) {
      const x = hookedNvda();
      const k = keeperOn(x.w, env(arrange(x)));
      await k.sweepTick();
      expect({ name, sent: x.w.rpc.count("eth_sendRawTransaction") }).toEqual({ name, sent: 0 });
      const line = history(k)[0]!;
      const reason = line.replace(`FAIL 1 due, none sweepable; held this tick: ${NVDA} (`, "").replace(/\); epochs kept$/, "");
      if (typeof why === "string") expect({ name, reason }).toEqual({ name, reason: why });
      else expect({ name, reason }).toMatchObject({ name, reason: expect.stringMatching(why) });
    }
  });
});

describe("assets that wait (the account keeps its epoch)", () => {
  test("ERC-8056: a change in force that the feed has not posted since makes the asset wait; a feed post clears it", async () => {
    const { w, nvda } = world();
    nvda.effectiveAt = BigInt(WED_1500 - 600);
    nvda.updatedAt = BigInt(WED_1500 - 900);
    due(w, ALICE, 20, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, BOB, 20, [[SPY, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[BOB]]);
    expect(history(k)[0]).toContain(`(1 waiting: ${NVDA} multiplier change not yet in the feed)`);

    nvda.updatedAt = BigInt(WED_1500 - 60);
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[BOB], [ALICE]]);
  });

  test("ERC-8056: a change scheduled within 15 minutes waits; one further out does not; unreadable multiplier state waits", async () => {
    const { w, nvda } = world();
    nvda.effectiveAt = BigInt(WED_1500 + 600);
    nvda.nui = 2n * nvda.ui;
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(history(k)[0]).toContain("multiplier change not yet in the feed");

    nvda.effectiveAt = BigInt(WED_1500 + 1_200);
    await k.sweepTick();
    expect(sweeps(w)).toHaveLength(1);

    const { w: w2 } = world();
    due(w2, ALICE, 20, [[NVDA, 10_000]]);
    w2.rpc.contract(NVDA, [], {
      effectiveAt: () => {
        throw new Revert("0x");
      },
    });
    const k2 = keeperOn(w2);
    await k2.sweepTick();
    expect(history(k2)[0]).toContain(`${NVDA} multiplier state unreadable`);
  });

  test("market-hours gate: nothing equity-gated is swept on a Saturday unless exempt or the gate is off", async () => {
    const run = async (env: Record<string, string>) => {
      const { w } = world(SAT_1500);
      due(w, ALICE, 20, [[NVDA, 10_000]]);
      due(w, BOB, 20, [[SPY, 10_000]]);
      const k = keeperOn(w, env);
      await k.sweepTick();
      return { swept: sweeps(w).map(([a]) => a), last: history(k)[0] };
    };
    const gated = await run({});
    expect(gated.swept).toEqual([]);
    expect(gated.last).toBe(`ok 2 accounts, none due (2 waiting: ${NVDA} market closed; ${SPY} market closed)`);
    expect((await run({ MARKET_GATE_EXEMPT: SPY.toLowerCase() })).swept).toEqual([[BOB]]);
    expect((await run({ MARKET_HOURS_GATE: "0" })).swept).toEqual([[ALICE, BOB]]);
  });

  test("market-hours gate: a feed that has not posted since the session opened (holiday) waits", async () => {
    const { w, nvda } = world();
    nvda.updatedAt = BigInt(Date.UTC(2026, 8, 25, 23) / 1000); // last Friday's close
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(history(k)[0]).toContain(`${NVDA} market closed`);
  });

  test("an oracle that is not OK waits; registry reads that fail wait", async () => {
    const { w, nvda } = world();
    nvda.status = 2;
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w);
    await k.sweepTick();
    expect(history(k)[0]).toContain(`${NVDA} oracle status 2`);

    for (const [contract, fn] of [
      [BOOK.assetRegistry, "isEligible"],
      [BOOK.assetRegistry, "get"],
      [BOOK.stockRouter, "oracleStatus"],
      [nvda.feed, "latestRoundData"],
    ] as const) {
      const { w: w2 } = world();
      due(w2, ALICE, 20, [[NVDA, 10_000]]);
      w2.rpc.contract(contract, [], {
        [fn]: () => {
          throw new Revert("0x");
        },
      });
      const k2 = keeperOn(w2);
      await k2.sweepTick();
      expect(history(k2)[0]).toBe(`ok 1 accounts, none due (1 waiting: ${NVDA} read failed)`);
    }
  });

  test("a failed asset-state read (the whole eth_call) makes every asset wait", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    w.rpc.use((method, [tx]) => {
      if (method === "eth_call" && tx.to.toLowerCase() === MULTICALL3.toLowerCase() && tx.data.includes(BOOK.assetRegistry.slice(2).toLowerCase())) {
        throw rpcError(-32000, "upstream unavailable");
      }
    });
    const k = keeperOn(w);
    await k.sweepTick();
    expect(history(k)[0]).toBe(`ok 1 accounts, none due (1 waiting: ${NVDA} read failed)`);
    expect(logs.has("[keeper:sweep] asset reads failed for 1 asset(s): ")).toBe(true);
  });
});

describe("quotes that fail", () => {
  test("a failed batched quote is retried one by one; an asset that still cannot be quoted makes its accounts sit out", async () => {
    const { w } = world();
    due(w, ALICE, 20, [
      [SPY, 6_000],
      [NVDA, 4_000],
    ]);
    due(w, BOB, 20, [[SPY, 10_000]]);
    w.rpc.use((method, [tx]) => {
      if (method !== "eth_call") return;
      if (tx.to.toLowerCase() === MULTICALL3.toLowerCase() && tx.data.includes(VENUE.v4Quoter.slice(2))) throw rpcError(-32000, "execution timeout");
      if (tx.to.toLowerCase() === VENUE.v4Quoter && tx.data.includes(NVDA.slice(2).toLowerCase())) throw rpcError(-32000, "execution timeout");
    });
    const k = keeperOn(w);
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[BOB]]);
    expect(logs.has("[keeper:sweep] batched quote failed (")).toBe(true); // an RPC failure, not N reverted quotes
    expect(quotes(w).filter((q) => q.token === SPY).length).toBeGreaterThan(0); // the retries, one eth_call each
    expect(logs.has(`[keeper:sweep] quote failed for ${NVDA} ($7.98)`)).toBe(true);
    expect(logs.has(`[keeper:sweep] plan: 1 call(s) [1 accounts]; 1 sit out (impact unmeasurable: ${NVDA})`)).toBe(true);
  });

  test("an asset that quotes for the plan but not for the call is held for this tick", async () => {
    const { w, nvda } = world();
    due(w, ALICE, 20, [[NVDA, 10_000]]);
    let n = 0;
    w.rpc.contract(VENUE.v4Quoter, [], {
      quoteExactInputSingle: ([p]) => {
        if (++n > 2) throw new Revert("0x");
        return [cpQuote(nvda.pool, p.exactAmount), 1n];
      },
    });
    const k = keeperOn(w);
    await k.sweepTick();
    expect(history(k)[0]).toContain(`held this tick: ${NVDA} (no quote)`);
  });
});

describe("sizing and sending", () => {
  test("a call estimating above SWEEP_MAX_GAS is halved and re-planned", async () => {
    const { w } = world();
    for (const a of [ALICE, BOB, CAROL]) due(w, a, 20, [[SPY, 10_000]]);
    w.rpc.gasFor = (c) => (c.functionName === "sweep" ? 10_000_000n * BigInt((c.args[0] as Address[]).length) : 300_000n);
    const k = keeperOn(w, { SWEEP_MAX_GAS: "15000000" });
    await k.sweepTick();
    expect(sweeps(w).map(([a, l]) => [a, l.map((x) => x.minOutPerUsdg > 0n)])).toEqual([[[ALICE], [true]]]);
    expect(logs.has("[keeper:sweep] 3 accounts estimate 30000000 gas > 15000000; halving the batch")).toBe(true);
    expect(logs.has("[keeper:sweep] 2 accounts estimate 20000000 gas > 15000000; halving the batch")).toBe(true);
    // The single account's limit is quoted on its own swap, not the 3-account one.
    const aliceIn = swapInFor(usd(20), FEE);
    expect(quotes(w).some((q) => q.swapIn === aliceIn && q.block === 199_998n)).toBe(true);
  });

  test("a sweep that would revert is never broadcast; the tick fails and counts toward /health", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[SPY, 10_000]]);
    due(w, BOB, 20, [[SPY, 10_000]]);
    const revert = new Revert(encodeErrorResult({ abi: sweepExecutorAbi, errorName: "NotKeeper" }));
    w.rpc.contract(BOOK.sweepExecutor, [], {
      sweep: () => {
        throw revert;
      },
    });
    const k = keeperOn(w, { HEALTH_MAX_BAD_TICKS: "1" });
    await k.run("sweep");
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toBe("FAIL sweep reverted: NotKeeper");
    expect(k.health()).toMatchObject({ ok: false, reasons: ["sweep tick failed 1x in a row"], consecutiveFailures: { accrue: 0, sweep: 1 } });
  });

  test("the failed tick names the revert: any called contract's custom error with its arguments, Error(string) by its message", async () => {
    const solidity = parseAbi(["error Error(string)", "error Panic(uint256)"]);
    const cases: [Revert, string][] = [
      [new Revert(encodeErrorResult({ abi: stockRouterAbi, errorName: "OutsideOracleBand", args: [1n, 2n] })), "sweep reverted: OutsideOracleBand(1, 2)"],
      [new Revert(encodeErrorResult({ abi: sweepExecutorAbi, errorName: "NotLinked", args: [ALICE] })), `sweep reverted: NotLinked(${ALICE})`],
      [new Revert(encodeErrorResult({ abi: solidity, errorName: "Error", args: ["STF"] })), "sweep reverted: STF"],
      [new Revert(encodeErrorResult({ abi: solidity, errorName: "Panic", args: [17n] })), "sweep reverted: Panic(17)"],
      [new Revert("0xdeadbeef"), "sweep reverted: 0xdeadbeef"],
      [new Revert("0x"), 'The contract function "sweep" reverted.'], // no reason to name
    ];
    for (const [revert, line] of cases) {
      const { w } = world();
      due(w, ALICE, 20, [[SPY, 10_000]]);
      w.rpc.contract(BOOK.sweepExecutor, [], {
        sweep: () => {
          throw revert;
        },
      });
      const k = keeperOn(w);
      await k.run("sweep");
      expect(history(k)[0]).toBe(`FAIL ${line}`);
    }
  });

  test("a sweep that would sweep nothing is never broadcast", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[SPY, 10_000]]);
    w.sweepResult = () => 0n;
    const k = keeperOn(w);
    await k.sweepTick();
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toBe("ok 1 accounts would sweep nothing; not broadcast");
  });

  test("simulate-only sweeps are simulated with the exact arguments and never signed", async () => {
    const { w, spy } = world();
    due(w, ALICE, 20, [[SPY, 10_000]]);
    const aliceIn = swapInFor(usd(20), FEE);
    const k = keeperOn(w, { KEEPER_BROADCAST: "0" });
    await k.sweepTick();
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(w.rpc.callsTo("sweep", "eth_call").map((c) => [c.from, c.args])).toEqual([
      [KEEPER, [[ALICE], [{ asset: SPY, minOutPerUsdg: limitFromQuote(aliceIn, cpQuote(spy.pool, aliceIn), TOL) }]]],
    ]);
    expect(logs.has("[keeper] simulate-only sweep -> 1")).toBe(true);
  });

  test("a sweep's batch is bounded by distinct assets and legs; the rest are due next tick", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[SPY, 10_000]]);
    due(w, BOB, 20, [[NVDA, 10_000]]);
    const k = keeperOn(w, { SWEEP_MAX_ASSETS: "1" });
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
    expect(history(k)[0]).toContain("(1 more due next tick: a sweep takes at most 64 accounts, 1 assets, 192 legs)");
  });

  test("an account whose pool is already held at $1 never takes the budget: the accounts behind it are swept this tick", async () => {
    const { w, spy, nvda } = world();
    const AAPL = getAddress(TOKENS.AAPL);
    const TSLA = getAddress(TOKENS.TSLA);
    w.asset(AAPL, 330);
    w.asset(TSLA, 440, { offBps: 200n }); // held: $1 ~230 bps under the oracle (max 90)
    due(w, ALICE, 20, [
      [SPY, 5_000],
      [TSLA, 5_000],
    ]);
    due(w, BOB, 20, [[NVDA, 10_000]]);
    due(w, CAROL, 20, [[AAPL, 10_000]]);
    due(w, DAVE, 20, [[TSLA, 10_000]]);
    // Two distinct assets per sweep: Alice alone fills it, and would be dropped at planning.
    const k = keeperOn(w, { SWEEP_MAX_ASSETS: "2" });
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[BOB, CAROL]]);
    expect(history(k)[0]).toMatch(
      new RegExp(`^ok 2 accounts, \\$40\\.00 across 2 quoted assets; held this tick: ${TSLA} \\(pool 2\\d\\d\\.\\d bps under the oracle at \\$1 \\(max 90\\.0: pool fee \\+ 60\\)\\)$`),
    );
    // Held accounts keep their epoch and are tried again next tick; the pre-screen read only the $1 reference.
    expect([ALICE, DAVE].map((a) => w.accounts.get(a)!.sweptEpoch)).toEqual([0n, 0n]);
    expect(quotes(w).filter((q) => q.block === 199_998n && q.swapIn === 1_000_000n).map((q) => q.token)).toEqual(expect.arrayContaining([SPY, TSLA, NVDA, AAPL]));
    expect([spy.pool.x, nvda.pool.x].map((x) => x > usd(5_000_000))).toEqual([false, true]);

    // Everyone left holds the held pool: nothing is sent, and the line says why.
    w.rpc.head += 10n;
    await k.sweepTick();
    expect(sweeps(w)).toHaveLength(1);
    expect(history(k)[0]).toMatch(new RegExp(`^FAIL 2 due, none sweepable; held this tick: ${TSLA} \\(pool 2\\d\\d\\.\\d bps .*\\); epochs kept$`));
  });

  test("paused executor, nobody due, unreadable account detail", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[SPY, 10_000]]);
    due(w, BOB, 20, [[SPY, 10_000]]);
    const k = keeperOn(w);
    w.executor.paused = true;
    await k.sweepTick();
    expect(history(k)[0]).toBe("ok executor paused; skipping");

    w.executor.paused = false;
    w.rpc.contract(BOOK.electionRegistry, [], {
      mixOf: ([a]) => {
        if (a === BOB) throw new Revert("0x");
        return w.accounts.get(a)!.mix;
      },
    });
    await k.sweepTick();
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);

    await k.sweepTick(); // Alice swept this epoch, Bob unreadable
    expect(history(k)[0]).toBe("ok 2 accounts, none due");
  });

  test("a discovery failure does not stop the sweep of accounts already known", async () => {
    const { w } = world();
    due(w, ALICE, 20, [[SPY, 10_000]]);
    const k = keeperOn(w);
    await k.discover(w.rpc.head);
    w.rpc.head += 100_000n;
    w.rpc.use((method, [f]) => {
      if (method === "eth_getLogs" && String(f.address).toLowerCase() === BOOK.ruleRegistry.toLowerCase()) throw rpcError(-32000, "upstream unavailable");
    });
    await k.sweepTick();
    expect(logs.has("[keeper:sweep] discovery stalled at 199936: ")).toBe(true);
    expect(sweeps(w).map(([a]) => a)).toEqual([[ALICE]]);
  });
});
