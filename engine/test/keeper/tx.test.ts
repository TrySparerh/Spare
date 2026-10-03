/**
 * One keeper transaction in flight at a time: the in-flight tx and the
 * pending nonce gate every tick, reads are never pinned below our own last
 * mined tx, ticks are serialised (a queued sweep before a queued accrue),
 * stop() drains, /health reflects failures, stalls and low gas, and every
 * tx carries gas headroom over its estimate, raised after an out-of-gas sign.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { encodeErrorResult, getAddress, type Hex } from "viem";
import { stockRouterAbi, sweepExecutorAbi } from "../../src/chain/abis.ts";
import { TOKENS } from "../../src/chain/constants.ts";
import { fmtUsdg } from "../../src/keeper/keeper.ts";
import { ACCRUE_GAS } from "../../src/keeper/plan.ts";
import { Revert, rpcError } from "../helpers/fake-rpc.ts";
import { addr, BOOK, captureLogs, keeperOn, SpareWorld, usd, type Entry } from "../helpers/fake-rpc-spare.ts";

const A = addr(0xa11ce);
const W1 = addr(0x1001);
const M = addr(0x3e7c4a7);

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  setSystemTime();
});

function oneWallet(): SpareWorld {
  const w = new SpareWorld();
  w.enroll(A, [W1]);
  w.pay(W1, M, usd(4.3), 3_000n);
  return w;
}
const history = (k: { history: { detail: string; ok: boolean }[] }) => k.history.map((h) => `${h.ok ? "ok" : "FAIL"} ${h.detail}`);
const readBlocks = (w: SpareWorld) => [...new Set(w.rpc.callsTo("ruleOf").map((c) => c.block))];
/** eth_getTransactionReceipt fails (not "not found") while `on`: the confirmation wait gives up, the tx stays in flight. */
function flakyReceipts(w: SpareWorld): { off: () => void } {
  let on = true;
  w.rpc.use((method) => {
    if (on && method === "eth_getTransactionReceipt") throw rpcError(-32000, "header not found");
  });
  return { off: () => void (on = false) };
}

describe("in-flight transaction and nonces", () => {
  test("a tx whose receipt could not be read stays in flight: ticks wait for it, then pin reads at or above its block", async () => {
    const w = oneWallet();
    w.rpc.autoMine = false;
    const flaky = flakyReceipts(w);
    const k = keeperOn(w);

    await k.run("accrue");
    const [tx] = w.rpc.sent;
    expect(tx!.functionName).toBe("accrueBatch");
    expect(history(k)[0]).toMatch(/^FAIL /);
    expect(k.health().inflightTx).toBe(tx!.hash);

    await k.run("sweep");
    expect(history(k)[0]).toBe(`ok skipping: waiting for tx ${tx!.hash}`);
    await k.run("accrue");
    expect(history(k)[0]).toBe(`ok skipping: waiting for tx ${tx!.hash}`);
    expect(w.rpc.sent).toHaveLength(1);

    flaky.off();
    const mined = w.rpc.mine(tx!.hash as Hex); // 200_001
    let lagging = true;
    w.rpc.use((method) => {
      if (lagging && method === "eth_blockNumber") return "0x30d40"; // 200_000: the node has not seen our block yet
    });
    await k.run("accrue");
    expect(history(k)[0]).toBe(`ok skipping: RPC head 200000 is behind our last tx block ${mined}`);
    expect(k.health().inflightTx).toBeNull();

    lagging = false;
    w.rpc.requests.length = 0;
    w.rpc.calls.length = 0;
    await k.run("accrue");
    expect(readBlocks(w)).toEqual([mined]); // head - 2 would be below our tx: read at head
    w.rpc.head += 10n;
    w.rpc.calls.length = 0;
    await k.run("accrue");
    expect(readBlocks(w)).toEqual([w.rpc.head - 2n]);

    // A node behind our last mined tx (load-balanced RPC) is never read from.
    lagging = true;
    w.rpc.calls.length = 0;
    await k.run("sweep");
    expect(history(k)[0]).toBe(`ok skipping: RPC head 200000 is behind our last tx block ${mined}`);
    expect(w.rpc.calls).toHaveLength(0);
  });

  test("a tx the node dropped (pending nonce back to latest) is released after 5 minutes, and the work is re-sent", async () => {
    const w = oneWallet();
    w.rpc.autoMine = false;
    const flaky = flakyReceipts(w);
    const k = keeperOn(w);
    await k.run("accrue");
    const [tx] = w.rpc.sent;
    flaky.off();
    w.rpc.pendingNonce = w.rpc.latestNonce; // dropped from the mempool

    await k.run("accrue");
    expect(history(k)[0]).toBe(`ok skipping: waiting for tx ${tx!.hash}`);

    w.rpc.autoMine = true;
    setSystemTime(Date.now() + 300_001);
    await k.run("accrue");
    expect(logs.has(`[keeper] tx ${tx!.hash} was never mined; releasing`)).toBe(true);
    expect(w.rpc.sent).toHaveLength(2);
    expect(w.rpc.sent[1]!.nonce).toBe(0);
    expect(w.rpc.sent[1]!.args).toEqual(tx!.args);
  });

  test("another pending tx from the keeper key skips the tick (broadcast mode only)", async () => {
    const w = oneWallet();
    w.rpc.latestNonce = 4;
    w.rpc.pendingNonce = 5;
    const k = keeperOn(w);
    await k.run("accrue");
    await k.run("sweep");
    expect(history(k).slice(0, 2)).toEqual(["ok skipping: keeper has 1 pending tx(s)", "ok skipping: keeper has 1 pending tx(s)"]);
    expect(w.rpc.count("eth_call")).toBe(0);

    w.rpc.pendingNonce = 4;
    await k.run("accrue");
    expect(w.rpc.sent.map((t) => t.nonce)).toEqual([4]);
  });

  test("a tx that reverts on-chain fails the tick, and later reads are pinned above it", async () => {
    const w = oneWallet();
    const mined = w.rpc.onMined;
    w.rpc.onMined = () => ({ status: "reverted" }); // no logs, no state change
    const k = keeperOn(w, { HEALTH_MAX_BAD_TICKS: "2" });
    await k.run("accrue");
    const [tx] = w.rpc.sent;
    expect(history(k)[0]).toBe(`FAIL accrueBatch reverted on-chain (${tx!.hash})`);
    expect(k.health().ok).toBe(true);
    w.rpc.calls.length = 0;
    await k.run("accrue");
    expect(readBlocks(w)).toEqual([tx!.block!]);
    expect(k.health()).toMatchObject({ ok: false, reasons: ["accrue tick failed 2x in a row"] });

    w.rpc.onMined = mined;
    await k.run("accrue");
    expect(k.health()).toMatchObject({ ok: true, consecutiveFailures: { accrue: 0, sweep: 0 } });
    expect((w.rpc.sent[2]!.args[0] as Entry[])[0]!.amount).toBe(usd(0.7));
  });

  test("an accrueBatch whose simulation reverts is never sent, and the failed tick names the error", async () => {
    const w = oneWallet();
    w.rpc.contract(BOOK.sweepExecutor, [], {
      accrueBatch: () => {
        throw new Revert(encodeErrorResult({ abi: sweepExecutorAbi, errorName: "WeeklyCapExceeded", args: [700_000n, 500_000n] }));
      },
    });
    const k = keeperOn(w);
    await k.run("accrue");
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toBe("FAIL accrueBatch reverted: WeeklyCapExceeded(700000, 500000)");
  });
});

describe("gas limits: a short limit skips or defers instead of reverting", () => {
  const SPY = getAddress(TOKENS.SPY);
  const ALICE = addr(0xa11ce5);
  /** Alice, $20 parked, 100% SPY, due a sweep. */
  function dueSweep(): SpareWorld {
    const w = new SpareWorld();
    w.asset(SPY, 660);
    w.enroll(ALICE, [addr(0x2001)]);
    w.account(ALICE, { value: usd(20), mix: [{ asset: SPY, bps: 10_000 }] });
    return w;
  }
  const gas = (w: SpareWorld) => w.rpc.sent.map((t) => [t.functionName, t.gas]);

  test("accrueBatch goes out at 1.5x its estimate, and never under its entries' floor (base + one pull)", async () => {
    const w = oneWallet();
    w.rpc.gasFor = (c) => (c.functionName === "accrueBatch" ? 228_722n : 300_000n); // one pull on a mainnet fork
    const k = keeperOn(w);
    await k.run("accrue");
    expect(gas(w)).toEqual([["accrueBatch", 343_083n]]); // ceil(228,722 x 1.5)
    // An estimate under what a pull needs at all is lifted to the floor.
    w.rpc.gasFor = () => 100_000n;
    w.pay(W1, M, usd(2.2), w.rpc.head + 100n);
    w.rpc.head += 1_000n;
    setSystemTime(Date.now() + 60_000);
    await k.run("accrue");
    expect(gas(w)[1]).toEqual(["accrueBatch", ACCRUE_GAS.base + ACCRUE_GAS.pull]);
    expect(k.health().gasMultiplier).toEqual({ accrueBatch: 1.5, sweep: 1.5 });
  });

  test("an entry skipped with an EMPTY reason ran out of gas: logged loudly, not backed off, retried next tick at 2x the estimate", async () => {
    const w = oneWallet();
    w.batchSkips.set(W1.toLowerCase(), "0x");
    w.accrueBatchResult = (entries) => BigInt(entries.length); // the simulation (at no gas limit) accrues it
    const k = keeperOn(w);
    await k.run("accrue");
    const [tx] = w.rpc.sent;
    expect(history(k)[0]).toBe("FAIL 0/1 wallets accrued, 1 payments, $0.70 to block 199880, 1 skipped (1 out of gas: retried next tick at 2x the estimate)");
    expect(logs.errors).toEqual([
      `[keeper] OUT OF GAS: accrueBatch ${tx!.hash} skipped 1/1 entries with an empty reason at its 450000 gas limit (estimate 300000); accrueBatch is now sent at 2x its estimate`,
    ]);
    expect(logs.has("backed off")).toBe(false);
    expect(k.health()).toMatchObject({ walletsBackedOff: 0, gasMultiplier: { accrueBatch: 2, sweep: 1.5 } });

    w.batchSkips.clear();
    setSystemTime(Date.now() + 60_000); // the next tick, well inside a 5-minute backoff
    await k.run("accrue");
    expect(gas(w)).toEqual([
      ["accrueBatch", 450_000n],
      ["accrueBatch", 600_000n],
    ]);
    expect(history(k)[0]).toMatch(/^ok 1\/1 wallets accrued, 1 payments, \$0\.70 to block 19988\d$/);
    expect(w.wallets.get(W1)!.lastAccrued).toBeGreaterThan(0n);
  });

  test("a skip with a reason is the wallet's own: backed off, the gas step untouched", async () => {
    const w = oneWallet();
    w.batchSkips.set(W1.toLowerCase(), encodeErrorResult({ abi: sweepExecutorAbi, errorName: "RuleDisabled", args: [A] }));
    w.accrueBatchResult = (entries) => BigInt(entries.length); // it changed between the simulation and the block
    const k = keeperOn(w);
    await k.run("accrue");
    expect(logs.has(`${W1} backed off 5m (1x): AccrualSkipped: RuleDisabled`)).toBe(true);
    expect(logs.errors).toEqual([]);
    expect(k.health().gasMultiplier).toEqual({ accrueBatch: 1.5, sweep: 1.5 });
  });

  test("the steps stop at 3x: out of gas there backs the wallet off like any other skip", async () => {
    const w = oneWallet();
    w.batchSkips.set(W1.toLowerCase(), "0x");
    w.accrueBatchResult = (entries) => BigInt(entries.length); // the simulation (at no gas limit) accrues it
    const k = keeperOn(w);
    for (let i = 0; i < 3; i++) {
      await k.run("accrue");
      setSystemTime(Date.now() + 60_000);
    }
    expect(gas(w).map(([, g]) => g)).toEqual([450_000n, 600_000n, 900_000n]);
    expect(logs.errors.at(-1)).toMatch(/OUT OF GAS: .*; already at the top step \(3x its estimate\)$/);
    expect(logs.has(`${W1} backed off 5m (1x): AccrualSkipped: out of gas (empty reason)`)).toBe(true);
    await k.run("accrue");
    expect(w.rpc.sent).toHaveLength(3); // backed off
  });

  test("a tx that reverts having used its whole limit ran out of gas: the step goes up; a revert under its limit does not", async () => {
    const w = oneWallet();
    const mined = w.rpc.onMined;
    w.rpc.onMined = () => ({ status: "reverted", gasUsed: 400_000n });
    const k = keeperOn(w);
    await k.run("accrue");
    expect(logs.errors).toEqual([]);
    w.rpc.onMined = () => ({ status: "reverted", gasUsed: "all" });
    await k.run("accrue");
    const tx = w.rpc.sent[1]!;
    expect(history(k)[0]).toBe(`FAIL accrueBatch reverted on-chain (${tx.hash})`);
    expect(logs.errors).toEqual([
      `[keeper] OUT OF GAS: accrueBatch ${tx.hash} reverted having used its whole 450000 gas limit (estimate 300000); accrueBatch is now sent at 2x its estimate`,
    ]);
    w.rpc.onMined = mined;
    await k.run("accrue");
    expect(gas(w).map(([, g]) => g)).toEqual([450_000n, 450_000n, 600_000n]);
    expect(history(k)[0]).toMatch(/^ok 1\/1 wallets accrued/);
  });

  test("a sweep goes out at 1.5x; a swap deferred with an EMPTY reason ran out of gas: FAIL line, loud, the next sweep at 2x", async () => {
    const w = dueSweep();
    w.sweepDefers.set(SPY.toLowerCase(), "0x");
    const k = keeperOn(w);
    await k.run("sweep");
    const [tx] = w.rpc.sent;
    expect(gas(w)).toEqual([["sweep", 450_000n]]);
    expect(history(k)[0]).toBe(`FAIL 1 accounts, $20.00 across 1 quoted assets; out of gas, deferred: ${SPY}`);
    expect(logs.errors).toEqual([
      `[keeper] OUT OF GAS: sweep ${tx!.hash} deferred ${SPY} with an empty reason at its 450000 gas limit (estimate 300000); those legs' USDG is back in the park until the next epoch; sweep is now sent at 2x its estimate`,
    ]);
    // Deferred, not lost: the USDG is parked again and the account is swept next epoch, with more gas.
    expect(w.accounts.get(ALICE)).toMatchObject({ value: usd(20), sweptEpoch: w.executor.epoch });
    w.sweepDefers.clear();
    w.executor.epoch += 1n;
    await k.run("sweep");
    expect(gas(w)[1]).toEqual(["sweep", 600_000n]);
    expect(history(k)[0]).toBe("ok 1 accounts, $20.00 across 1 quoted assets");
  });

  test("a swap deferred WITH a reason (the band, the limit) is not a gas problem", async () => {
    const w = dueSweep();
    w.sweepDefers.set(SPY.toLowerCase(), encodeErrorResult({ abi: stockRouterAbi, errorName: "OutsideOracleBand", args: [1n, 2n] }));
    const k = keeperOn(w);
    await k.run("sweep");
    expect(logs.errors).toEqual([]);
    expect(k.health().gasMultiplier).toEqual({ accrueBatch: 1.5, sweep: 1.5 });
  });
});

describe("tick serialisation and shutdown", () => {
  /** Hold the next eth_blockNumber until released. */
  function gate(w: SpareWorld): { release: () => void; reached: Promise<void> } {
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const at = new Promise<void>((r) => (reached = r));
    let armed = true;
    w.rpc.use(async (method) => {
      if (!armed || method !== "eth_blockNumber") return;
      armed = false;
      reached();
      await held;
    });
    return { release, reached: at };
  }

  test("a tick arriving while one runs is queued, duplicates collapse, and a queued sweep runs before a queued accrue", async () => {
    const w = oneWallet();
    const g = gate(w);
    const k = keeperOn(w);
    const first = k.run("accrue");
    await g.reached;
    await k.run("accrue");
    await k.run("sweep");
    await k.run("accrue");
    g.release();
    await first;
    expect(k.history).toHaveLength(3);
    expect(logs.lines.filter((l) => l.startsWith("[keeper:")).map((l) => l.split("]")[0])).toEqual(["[keeper:accrue", "[keeper:sweep", "[keeper:accrue"]);
  });

  test("stop() takes no new ticks, waits (bounded) for the one in flight, and drops the queue", async () => {
    const w = oneWallet();
    const g = gate(w);
    const k = keeperOn(w);
    const first = k.run("accrue");
    await g.reached;
    await k.run("sweep"); // queued
    const t0 = Date.now();
    await k.stop(300); // the tick is still held: stop gives up waiting after ~300 ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    g.release();
    await first;
    expect(logs.lines.filter((l) => l.startsWith("[keeper:")).map((l) => l.split("]")[0])).toEqual(["[keeper:accrue"]);
    const before = w.rpc.requests.length;
    await k.run("accrue");
    expect(w.rpc.requests.length).toBe(before);
    await k.stop(); // idle: returns at once
  });
});

describe("/health inputs", () => {
  test("low gas is reported from the last balance read", async () => {
    const w = oneWallet();
    const k = keeperOn(w);
    expect(k.health()).toMatchObject({ ok: true, eth: null });
    w.rpc.balance = 10n ** 14n;
    expect(await k.ethBalance()).toBe(10n ** 14n);
    expect(k.health()).toMatchObject({ ok: false, reasons: ["low gas: 0.0001 ETH"], eth: "0.0001" });
    w.rpc.balance = 10n ** 18n;
    await k.ethBalance();
    expect(k.health().ok).toBe(true);
  });

  test("fmtUsdg: dollars and cents, truncated, signed", () => {
    expect(fmtUsdg(1_234_567n)).toBe("1.23");
    expect(fmtUsdg(-1_239_999n)).toBe("-1.23");
    expect(fmtUsdg(5n)).toBe("0.00");
  });
});
