/**
 * Keeper accrue tick against a fake chain (test/helpers/fake-rpc.ts): the
 * window each wallet is priced over, what counts as a payment, the caps and
 * consent a pull must respect, the pre-flight, and the exact `accrueBatch`
 * calldata the keeper signs (decoded from the raw transaction it sends).
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { encodeErrorResult, getAddress, pad, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { sweepExecutorAbi } from "../../src/chain/abis.ts";
import { MULTICALL3, USDG, VENUE } from "../../src/chain/constants.ts";
import { budgetedLogs, ScanBudget } from "../../src/keeper/budget.ts";
import { KEEPER_EXTRA_VENUE } from "../../src/keeper/venue.ts";
import { Revert, rpcError } from "../helpers/fake-rpc.ts";
import { addr, BOOK, captureLogs, KEEPER, keeperOn, RR_LINKED, SpareWorld, usd, type Entry } from "../helpers/fake-rpc-spare.ts";

const A = addr(0xa11ce);
const B = addr(0xb0b);
const C = addr(0xca201);
const D = addr(0xd0d);
const W1 = addr(0x1001);
const W2 = addr(0x1002);
const W3 = addr(0x1003);
const W4 = addr(0x1004);
const W5 = addr(0x1005);
const W6 = addr(0x1006);
const M = addr(0x3e7c4a7); // a merchant (EOA)
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const TO_BLOCK = 199_880n; // head 200_000 - finalityBuffer 100 - FINALITY_MARGIN 20

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  setSystemTime();
});

/** USDG Transfer scans the keeper made: wallet and (from, to] as getLogs block range. */
function scans(w: SpareWorld): { wallet: Address; from: bigint; to: bigint }[] {
  return w.rpc.requests
    .filter((r) => r.method === "eth_getLogs" && String(r.params[0].address).toLowerCase() === USDG.toLowerCase())
    .map((r) => ({ wallet: getAddress(`0x${(r.params[0].topics[1] as string).slice(26)}`), from: BigInt(r.params[0].fromBlock), to: BigInt(r.params[0].toBlock) }));
}
const entriesOf = (w: SpareWorld, i = 0) => w.rpc.sent[i]!.args[0] as Entry[];
const history = (k: { history: { detail: string; ok: boolean }[] }) => k.history.map((h) => `${h.ok ? "ok" : "FAIL"} ${h.detail}`);

describe("accrual window: (max(lastAccruedBlock, linkedAt, activeSince), head - finalityBuffer - margin]", () => {
  test("each wallet is scanned and priced from its own window start, and accrueBatch carries exactly those amounts", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n });
    w.wallet(W1, { lastAccrued: 50_000n }); // cursor is the latest
    w.wallet(W2, { linkedAt: 60_000n }); // re-linked later
    w.setRule(C, { enabled: true }, 70_000n);
    w.account(C, { activeSince: 70_000n }); // re-activated later
    for (const [wallet, from] of [
      [W1, 50_000n],
      [W2, 60_000n],
      [W3, 70_000n],
    ] as const) {
      w.pay(wallet, M, usd(4.3), from); // at the window start: already accrued / not yet active
      w.pay(wallet, M, usd(1.25), from + 1n); // inside: $0.75
      w.pay(wallet, M, usd(2.2), TO_BLOCK + 1n); // past the safe toBlock
    }
    const k = keeperOn(w);
    await k.accrueTick();

    expect(scans(w)).toEqual([
      { wallet: W1, from: 50_001n, to: TO_BLOCK },
      { wallet: W2, from: 60_001n, to: TO_BLOCK },
      { wallet: W3, from: 70_001n, to: TO_BLOCK },
    ]);
    expect(w.rpc.sent).toHaveLength(1);
    const tx = w.rpc.sent[0]!;
    expect(tx).toMatchObject({ from: KEEPER, to: BOOK.sweepExecutor.toLowerCase(), chainId: 4663, nonce: 0, functionName: "accrueBatch" });
    expect(entriesOf(w)).toEqual([
      { account: A, wallet: W1, amount: usd(0.75), toBlock: TO_BLOCK },
      { account: B, wallet: W2, amount: usd(0.75), toBlock: TO_BLOCK },
      { account: C, wallet: W3, amount: usd(0.75), toBlock: TO_BLOCK },
    ]);
    // Each entry was pre-flighted alone with the keeper-only accrue, as the keeper.
    expect(w.rpc.callsTo("accrue").map((c) => [c.from, ...c.args])).toEqual([
      [KEEPER, A, W1, usd(0.75), TO_BLOCK],
      [KEEPER, B, W2, usd(0.75), TO_BLOCK],
      [KEEPER, C, W3, usd(0.75), TO_BLOCK],
    ]);
    expect(history(k)[0]).toBe(`ok 3/3 wallets accrued, 3 payments, $2.25 to block ${TO_BLOCK}`);
    expect(w.wallets.get(W1)!.lastAccrued).toBe(TO_BLOCK);
  });

  test("reads are pinned two blocks behind head, and discovery never lets the window pass what it has seen", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    w.executor.finalityBuffer = 0n; // safe = head - 20 would pass discovery (head - 64)
    const k = keeperOn(w, { FINALITY_MARGIN: "0" });
    await k.accrueTick();
    expect(scans(w)).toEqual([{ wallet: W1, from: 2_001n, to: 199_936n }]);
    expect(new Set(w.rpc.callsTo("ruleOf").map((c) => c.block))).toEqual(new Set([199_998n]));
    expect(entriesOf(w)[0]!.toBlock).toBe(199_936n);
  });

  test("a wallet linked inside the finality window is not scanned until its window opens", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 199_900n }); // discovered (head - 64), but after the safe toBlock (head - 120)
    w.pay(W1, M, usd(4.3), 3_000n);
    w.pay(W2, M, usd(4.3), 199_960n);
    const k = keeperOn(w);
    await k.accrueTick();
    expect(k.accounts.has(B)).toBe(true);
    expect(w.rpc.callsTo("linkedAt").some((c) => c.args[0] === W2)).toBe(true);
    expect(scans(w).map((s) => s.wallet)).toEqual([W1]);
    w.rpc.head += 1_000n;
    await k.accrueTick();
    expect(scans(w).filter((s) => s.wallet === W2)).toEqual([{ wallet: W2, from: 199_901n, to: 200_881n }]);
    expect(entriesOf(w, 1)).toContainEqual({ account: B, wallet: W2, amount: usd(0.7), toBlock: 200_881n });
  });

  test("each payment is priced with the rule in force at it (by block, then log index)", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n, rule: { roundTo: 1, multiplier: 1 } });
    w.setRule(A, { roundTo: 10, multiplier: 2 }, 100_000n);
    w.setRule(A, { roundTo: 5, multiplier: 1 }, 120_000n, 1);
    w.pay(W1, M, usd(4.3), 50_000n); // $1 x1 -> 0.70
    w.pay(W1, M, usd(4.3), 120_000n, 0); // same block, before the $5 rule: $10 x2 -> 11.40
    w.pay(W1, M, usd(4.3), 130_000n); // $5 x1 -> 0.70
    await keeperOn(w).accrueTick();
    expect(entriesOf(w)).toEqual([{ account: A, wallet: W1, amount: usd(12.8), toBlock: TO_BLOCK }]);
  });
});

describe("what counts as a payment", () => {
  test("transfers to linked wallets, the account, Spare contracts, swap venues and v3 pools are not round-ups", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1, W2]);
    const P = addr(0x9001); // a canonical v3 pool: the factory names it
    const Q = addr(0x9002); // answers like a pool, but the factory names P
    const T = addr(0x9003); // answers token0 only
    w.v3Pool(P, USDG, WETH, 100);
    w.v3Pool(Q, USDG, WETH, 100);
    w.v3Pools.delete(Q.toLowerCase());
    w.rpc.contract(T, parseAbi(["function token0() view returns (address)"]), { token0: () => USDG });
    const out: [Address, number][] = [
      [W2, 3.3],
      [A, 3.3],
      [BOOK.cashPark, 3.3],
      [BOOK.sweepExecutor, 3.3],
      [getAddress(VENUE.v4PoolManager), 3.3],
      [getAddress(VENUE.swapRouter02), 3.3],
      [getAddress(KEEPER_EXTRA_VENUE[0]!), 3.3],
      [P, 3.3],
      [addr(0), 3.3],
      [M, 4.3], // 0.70
      [Q, 1.1], // 0.90
      [T, 2.6], // 0.40
    ];
    out.forEach(([to, amount], i) => w.pay(W1, to, usd(amount), 3_000n + BigInt(i)));
    const k = keeperOn(w);
    await k.accrueTick();

    expect(entriesOf(w)).toEqual([
      { account: A, wallet: W1, amount: usd(2), toBlock: TO_BLOCK },
      { account: A, wallet: W2, amount: 0n, toBlock: TO_BLOCK }, // idle and wide: its cursor advances past nothing
    ]);
    expect(history(k)[0]).toContain("3 payments, $2.00");
    // Only the unclassified counterparties are looked up, and only answering ones reach the factory.
    expect(w.rpc.callsTo("token0").map((c) => c.to)).toEqual([P, Q, T].map((x) => x.toLowerCase() as Address));
    expect(w.rpc.callsTo("getPool").map((c) => c.args)).toEqual([
      [USDG, WETH, 100],
      [USDG, WETH, 100],
    ]);
  });
});

describe("caps and consent", () => {
  test("the weekly cap is shared by an account's wallets; Permit2, ERC-20 allowance and balance each clamp", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1, W2], { block: 2_000n, remaining: usd(1) });
    w.enroll(B, [W3], { block: 2_100n, remaining: 0n });
    w.enroll(C, [W4], { block: 2_200n });
    w.enroll(D, [W5, W6], { block: 2_300n });
    w.wallet(W4, { permit2: { amount: usd(0.2), expiration: Math.floor(Date.now() / 1000) + 86_400, nonce: 0 } });
    w.wallet(W5, { erc20Allowance: usd(0.1) });
    w.wallet(W6, { balance: usd(0.05) });
    for (const x of [W1, W2, W3, W4, W5, W6]) w.pay(x, M, usd(4.3), 5_000n);
    const k = keeperOn(w);
    await k.accrueTick();
    expect(entriesOf(w)).toEqual([
      { account: A, wallet: W1, amount: usd(0.7), toBlock: TO_BLOCK },
      { account: A, wallet: W2, amount: usd(0.3), toBlock: TO_BLOCK }, // $1.00 cap - 0.70
      { account: C, wallet: W4, amount: usd(0.2), toBlock: TO_BLOCK },
      { account: D, wallet: W5, amount: usd(0.1), toBlock: TO_BLOCK },
      { account: D, wallet: W6, amount: usd(0.05), toBlock: TO_BLOCK },
    ]);
    expect(history(k)[0]).toContain("(held: 1 clamped-to-zero)");
  });

  test("no consent: a narrow window is not even scanned, round-ups are held (never zero-advanced) and pulled once consent returns", async () => {
    const w = new SpareWorld();
    const soon = Math.floor(Date.now() / 1000) + 30; // inside the 60 s expiry headroom
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n });
    w.wallet(W1, { erc20Allowance: 0n, lastAccrued: 195_000n }); // 4,880-block window < IDLE_ADVANCE_BLOCKS
    w.wallet(W2, { permit2: { amount: usd(100), expiration: soon, nonce: 0 } });
    w.wallet(W3, { erc20Allowance: 0n }); // idle
    w.pay(W1, M, usd(4.3), 196_000n);
    w.pay(W2, M, usd(4.3), 9_000n);
    const k = keeperOn(w);

    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W2, W3]);
    expect(entriesOf(w)).toEqual([{ account: C, wallet: W3, amount: 0n, toBlock: TO_BLOCK }]);
    expect(history(k)[0]).toContain("(held: 1 no-consent)");

    await k.accrueTick(); // W2 holds round-ups and still has no consent: not rescanned, nothing sent
    expect(scans(w)).toHaveLength(2);
    expect(w.rpc.sent).toHaveLength(1);
    expect(history(k)[0]).toBe("ok 3 accounts, 3 active, nothing to accrue");

    w.wallet(W2, { permit2: { amount: usd(100), expiration: soon + 86_400, nonce: 0 } });
    await k.accrueTick();
    // The held result is kept: only the block our own tx added is scanned (head moved by one).
    expect(scans(w)[2]).toEqual({ wallet: W2, from: TO_BLOCK + 1n, to: TO_BLOCK + 1n });
    expect(entriesOf(w, 1)).toEqual([{ account: B, wallet: W2, amount: usd(0.7), toBlock: TO_BLOCK + 1n }]);
  });
});

describe("wallets that cannot be pulled (linked-wallet floods)", () => {
  test("no USDG balance, no Permit2 amount, no cap room: a narrow window is not scanned at all, and a wallet that can be pulled again is", async () => {
    const w = new SpareWorld();
    const E = addr(0xe0e);
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n });
    w.enroll(D, [W4], { block: 2_300n, remaining: 0n }); // weekly cap used up
    w.enroll(E, [W5], { block: 2_400n });
    const narrow = { lastAccrued: 195_000n }; // 4,880-block windows < IDLE_ADVANCE_BLOCKS
    w.wallet(W1, narrow);
    w.wallet(W2, { ...narrow, balance: 0n }); // consent, nothing to pull
    w.wallet(W3, { ...narrow, permit2: { amount: 0n, expiration: Math.floor(Date.now() / 1000) + 86_400, nonce: 0 } });
    w.wallet(W4, narrow);
    w.wallet(W5, { ...narrow, erc20Allowance: 0n });
    for (const x of [W1, W2, W3, W4, W5]) w.pay(x, M, usd(4.3), 196_000n);
    const k = keeperOn(w);

    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W1]);
    expect(entriesOf(w)).toEqual([{ account: A, wallet: W1, amount: usd(0.7), toBlock: TO_BLOCK }]);
    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W1, W1]); // only our own tx's block, for W1 alone

    w.wallet(W2, { balance: usd(10) });
    await k.accrueTick();
    expect(scans(w).slice(2)).toEqual([{ wallet: W2, from: 195_001n, to: TO_BLOCK + 1n }]);
    expect(entriesOf(w, 1)).toEqual([{ account: B, wallet: W2, amount: usd(0.7), toBlock: TO_BLOCK + 1n }]);
  });

  test("an unpullable wallet with a wide window is scanned once to zero-advance it; one holding round-ups waits unscanned", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.wallet(W1, { balance: 0n }); // idle since linking: ~198k blocks >= IDLE_ADVANCE_BLOCKS
    w.wallet(W2, { balance: 0n });
    w.pay(W2, M, usd(4.3), 5_000n); // then spent the rest
    const k = keeperOn(w);
    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W1, W2]);
    expect(entriesOf(w)).toEqual([{ account: A, wallet: W1, amount: 0n, toBlock: TO_BLOCK }]);
    expect(history(k)[0]).toContain("(held: 1 clamped-to-zero)");
    w.rpc.head += 5_000n;
    await k.accrueTick();
    expect(scans(w)).toHaveLength(2); // W1's window is narrow again, W2 holds round-ups: neither is scanned
  });

  test("scans run in order of what can be pulled, most first; a tick that ran out of time still starts with the wallets it missed", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n, remaining: usd(2) });
    w.wallet(W1, { balance: usd(5) });
    w.wallet(W2, { balance: usd(500) });
    w.wallet(W3, { balance: usd(5_000) }); // capped by its account's $2 of cap room
    for (const x of [W1, W2, W3]) w.pay(x, M, usd(4.3), 3_000n);
    const k = keeperOn(w, { SCAN_CONCURRENCY: "1" });
    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W2, W1, W3]);
  });
});

describe("accounts and discovery", () => {
  test("a disabled rule makes the account dormant until an event or the recheck", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n, rule: { enabled: false } });
    const k = keeperOn(w);
    const ruleReads = () => w.rpc.callsTo("ruleOf").length;
    await k.accrueTick();
    expect(ruleReads()).toBe(1);
    expect(k.health().dormantAccounts).toBe(1);
    await k.accrueTick();
    expect(ruleReads()).toBe(1);

    w.rpc.head += 1_000n; // a RuleSet inside the next discovery range wakes it
    w.setRule(A, { enabled: true }, 200_000n);
    w.account(A, { activeSince: 200_000n });
    w.pay(W1, M, usd(4.3), 200_500n);
    await k.accrueTick();
    expect(ruleReads()).toBe(2);
    expect(scans(w)).toEqual([{ wallet: W1, from: 200_001n, to: 200_880n }]);
    expect(entriesOf(w)).toEqual([{ account: A, wallet: W1, amount: usd(0.7), toBlock: 200_880n }]);

    w.account(A, { rule: { ...w.accounts.get(A)!.rule, enabled: false } });
    await k.accrueTick();
    expect(ruleReads()).toBe(3);
    setSystemTime(Date.now() + 3_600_001); // DORMANT_RECHECK_MS
    await k.accrueTick();
    expect(ruleReads()).toBe(4);
  });

  test("an active account with no RuleSet history is never priced, and the warning is logged once", async () => {
    const w = new SpareWorld();
    w.rpc.emit(BOOK.ruleRegistry, RR_LINKED, { account: A, wallet: W1 }, 2_000n);
    w.account(A, { wallets: [W1], activeSince: 2_000n });
    w.wallet(W1, { linkedAt: 2_000n });
    w.pay(W1, M, usd(4.3), 3_000n);
    const k = keeperOn(w);
    await k.accrueTick();
    await k.accrueTick();
    expect(logs.lines.filter((l) => l.includes("has an active rule but no RuleSet history"))).toHaveLength(1);
    expect(scans(w)).toHaveLength(0);
    expect(w.rpc.sent).toHaveLength(0);
  });

  test("discovery halves a result-capped range, doubles back, and only moves on success", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.rpc.use((method, [f]) => {
      if (method !== "eth_getLogs" || String(f.address).toLowerCase() !== BOOK.ruleRegistry.toLowerCase()) return;
      if (BigInt(f.toBlock) - BigInt(f.fromBlock) > 60_000n) throw rpcError(-32602, "logs matched by query exceeds limit of 10000");
    });
    const k = keeperOn(w, { LOGS_MAX_RANGE: "100000" });
    await k.accrueTick();
    const ranges = w.rpc.requests
      .filter((r) => r.method === "eth_getLogs" && String(r.params[0].address).toLowerCase() === BOOK.ruleRegistry.toLowerCase())
      .map((r) => [BigInt(r.params[0].fromBlock), BigInt(r.params[0].toBlock)]);
    expect(ranges).toEqual([
      [1_000n, 100_999n],
      [1_000n, 50_999n],
      [51_000n, 150_999n],
      [51_000n, 100_999n],
      [101_000n, 199_936n],
      [101_000n, 150_999n],
      [151_000n, 199_936n],
    ]);
    expect(k.health().discoveredTo).toBe("199936");
    expect(entriesOf(w)).toHaveLength(1);
  });

  test("a discovery failure is reported and accrual stops at what was discovered", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    const k = keeperOn(w, { LOGS_MAX_RANGE: "100000" });
    let calls = 0;
    w.rpc.use((method, [f]) => {
      if (method === "eth_getLogs" && String(f.address).toLowerCase() === BOOK.ruleRegistry.toLowerCase() && ++calls === 2) {
        throw rpcError(-32000, "upstream unavailable");
      }
    });
    await k.accrueTick();
    expect(history(k)).toContain("FAIL discovery stalled at 100999: Missing or invalid parameters.");
    expect(scans(w)).toEqual([
      { wallet: W1, from: 2_001n, to: 99_999n }, // aligned LOGS_MAX_RANGE chunks
      { wallet: W1, from: 100_000n, to: 100_999n },
    ]);
    expect(entriesOf(w)[0]!.toBlock).toBe(100_999n);
  });

  test("a removed (reorged) registry log is ignored", async () => {
    const w = new SpareWorld();
    const k = keeperOn(w);
    w.rpc.use((method, [f]) => {
      if (method !== "eth_getLogs" || String(f.address).toLowerCase() !== BOOK.ruleRegistry.toLowerCase()) return;
      w.enroll(A, [W1]);
      const [linked] = w.rpc.logs.splice(0);
      return [
        {
          ...linked,
          blockNumber: "0x7d0",
          logIndex: "0x0",
          transactionIndex: "0x0",
          blockHash: `0x${"ab".repeat(32)}`,
          removed: true,
        },
      ];
    });
    await k.accrueTick();
    expect(k.accounts.size).toBe(0);
  });
});

describe("reads that fail and executor state", () => {
  test("paused executor or paused USDG: skip the tick; an unreadable USDG pause flag is not a pause", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    const k = keeperOn(w);
    w.executor.paused = true;
    await k.accrueTick();
    w.executor.paused = false;
    w.usdgPaused = true;
    await k.accrueTick();
    expect(history(k).slice(0, 2)).toEqual(["ok USDG paused (every pull would revert); skipping", "ok executor paused; skipping"]);
    expect(w.rpc.count("eth_getLogs")).toBe(0);
    w.usdgPaused = "revert";
    await k.accrueTick();
    expect(w.rpc.sent).toHaveLength(1);
  });

  test("an account whose reads revert, or a whole chunk that fails, is skipped for the tick", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.pay(W1, M, usd(4.3), 3_000n);
    w.pay(W2, M, usd(4.3), 3_000n);
    w.rpc.contract(BOOK.sweepExecutor, [], {
      remainingWeeklyCap: ([a]) => {
        if (a === B) throw new Revert("0x");
        return usd(50);
      },
    });
    const k = keeperOn(w);
    await k.accrueTick();
    expect(logs.has(`account ${B} read failed; skipped this tick`)).toBe(true);
    expect(entriesOf(w).map((e) => e.account)).toEqual([A]);

    // The whole account-read eth_call fails at the RPC: a failed read of the chunk
    // (logged with the RPC's error), not two accounts whose calls all reverted.
    // Nothing is scanned or sent.
    w.rpc.requests.length = 0;
    w.rpc.head += 1_000n;
    let first = true;
    w.rpc.use((method, [tx]) => {
      if (method === "eth_call" && tx.to.toLowerCase() === MULTICALL3.toLowerCase() && first) {
        first = false;
        throw rpcError(-32000, "upstream unavailable");
      }
    });
    await k.accrueTick();
    expect(logs.has("[keeper] account read failed for 2 item(s): ")).toBe(true);
    expect(logs.lines.filter((l) => / read failed; skipped this tick$/.test(l))).toHaveLength(1); // B, last tick
    expect(w.rpc.count("eth_getLogs")).toBe(1); // discovery only
    expect(w.rpc.sent).toHaveLength(1);
  });

  test("a wallet whose state cannot be read is not scanned", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1, W2]);
    w.pay(W1, M, usd(4.3), 3_000n);
    w.pay(W2, M, usd(4.3), 3_000n);
    w.rpc.contract(BOOK.ruleRegistry, [], {
      linkedAt: ([x]) => {
        if (x === W2) throw new Revert("0x");
        return 2_000n;
      },
    });
    await keeperOn(w).accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W1]);
  });
});

describe("pre-flight", () => {
  test("a moved cursor drops the entry; a revert backs the wallet off; an RPC failure only drops it this tick", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n });
    w.enroll(D, [W4], { block: 2_300n });
    for (const x of [W1, W2, W3, W4]) w.pay(x, M, usd(4.3), 5_000n);
    // Another writer moved W2's cursor after our pinned read (head - 2).
    w.cursorAt = (wallet, block, stored) => (wallet === W2 && block === w.rpc.head ? 150_000n : stored);
    w.accrueReverts.set(W3.toLowerCase(), new Revert(encodeErrorResult({ abi: sweepExecutorAbi, errorName: "NotFinal", args: [199_880n, 199_900n] })));
    const accrueSel = toFunctionSelector("accrue(address,address,uint256,uint256)");
    const offW4 = w.rpc.use((method, [tx]) => {
      if (method === "eth_call" && tx.data?.startsWith(accrueSel) && tx.data.includes(W4.slice(2).toLowerCase())) throw rpcError(-32000, "upstream timeout");
    });
    const k = keeperOn(w);
    await k.accrueTick();

    expect(entriesOf(w)).toEqual([{ account: A, wallet: W1, amount: usd(0.7), toBlock: TO_BLOCK }]);
    expect(logs.has(`${W2} window start moved 2100 -> 150000 since read; dropped`)).toBe(true);
    expect(logs.has(`${W3} backed off 5m (1x): pre-flight revert: NotFinal`)).toBe(true);
    expect(logs.has(`pre-flight for ${W4} failed (not a revert)`)).toBe(true);
    expect(history(k)[0]).toBe("ok pre-flight dropped 3/4 entries");
    expect(k.health().walletsBackedOff).toBe(1);

    // Next tick: W3 is backed off (not even scanned); W4 is tried again from its kept scan.
    w.rpc.requests.length = 0;
    w.cursorAt = null;
    offW4();
    await k.accrueTick();
    const next = TO_BLOCK + 1n; // our accrueBatch was mined one block above head
    expect(scans(w)).toEqual([
      { wallet: W1, from: next, to: next },
      { wallet: W2, from: 2_101n, to: next }, // its dropped scan starts over from the real cursor
      { wallet: W4, from: next, to: next }, // its kept scan only extends
    ]);
    expect(entriesOf(w, 1)).toEqual([
      { account: B, wallet: W2, amount: usd(0.7), toBlock: next },
      { account: D, wallet: W4, amount: usd(0.7), toBlock: next },
    ]);
  });

  test("an entry whose window start cannot be re-read at latest is dropped, never pulled on a stale cursor", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    w.rpc.contract(BOOK.ruleRegistry, [], {
      linkedAt: (_, ctx) => {
        if (ctx.block === w.rpc.head) throw new Revert("0x");
        return 2_000n;
      },
    });
    const k = keeperOn(w);
    await k.accrueTick();
    expect(w.rpc.callsTo("accrue")).toHaveLength(0);
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toBe("FAIL pre-flight dropped 1/1 entries");
    expect(k.health().walletsBackedOff).toBe(0);
  });

  test("a batch whose simulation accrues nothing is never broadcast, and the wallets back off", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    w.accrueBatchResult = () => 0n;
    const k = keeperOn(w, { HEALTH_MAX_BAD_TICKS: "1" });
    await k.accrueTick();
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(history(k)[0]).toBe("FAIL 1 wallets would all be skipped; not broadcast");
    expect(logs.has(`${W1} backed off 5m (1x): accrueBatch simulation accrued nothing`)).toBe(true);
    expect(k.health()).toMatchObject({ ok: false, reasons: ["accrue attempts accrued nothing 1x in a row"], noProgressAttempts: 1 });
  });

  test("simulate-only (KEEPER_BROADCAST=0): the exact batch is simulated, nothing is signed, no nonce is read", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    const k = keeperOn(w, { KEEPER_BROADCAST: "0" });
    await k.accrueTick();
    expect(w.rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(w.rpc.count("eth_getTransactionCount")).toBe(0);
    const sim = w.rpc.callsTo("accrueBatch", "eth_call");
    expect(sim.map((c) => [c.from, c.args[0]])).toEqual([[KEEPER, [{ account: A, wallet: W1, amount: usd(0.7), toBlock: TO_BLOCK }]]]);
    expect(history(k)[0]).toBe("ok simulate-only: 1/1 wallets, $0.70");
    expect(k.health().noProgressAttempts).toBe(0);
  });

  test("AccrualSkipped in the receipt backs off that wallet with the decoded reason; Accrued clears it", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n });
    w.enroll(D, [W4], { block: 2_300n });
    for (const x of [W1, W2, W3, W4]) w.pay(x, M, usd(4.3), 5_000n);
    w.batchSkips.set(W2.toLowerCase(), encodeErrorResult({ abi: sweepExecutorAbi, errorName: "WeeklyCapExceeded", args: [1n, 2n] }));
    w.batchSkips.set(W3.toLowerCase(), encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["TRANSFER_FROM_FAILED"] }));
    w.batchSkips.set(W4.toLowerCase(), "0xdeadbeef00" as Hex);
    const k = keeperOn(w);
    await k.accrueTick();
    expect(entriesOf(w)).toHaveLength(4);
    expect(history(k)[0]).toBe(`FAIL 1/4 wallets accrued, 4 payments, $2.80 to block ${TO_BLOCK}, 3 skipped`);
    expect(k.history[0]!.tx).toBe(w.rpc.sent[0]!.hash);
    expect(logs.has(`${W2} backed off 5m (1x): AccrualSkipped: WeeklyCapExceeded`)).toBe(true);
    expect(logs.has(`${W3} backed off 5m (1x): AccrualSkipped: TRANSFER_FROM_FAILED`)).toBe(true);
    expect(logs.has(`${W4} backed off 5m (1x): AccrualSkipped: 0xdeadbeef`)).toBe(true);
    expect(k.health().walletsBackedOff).toBe(3);
  });

  test("more than 64 entries go out as consecutive batches of at most 64", async () => {
    const w = new SpareWorld();
    for (let i = 0; i < 65; i++) {
      w.enroll(addr(0xa000 + i), [addr(0xb000 + i)], { block: 2_000n + BigInt(i) });
      w.pay(addr(0xb000 + i), M, usd(4.3), 5_000n);
    }
    await keeperOn(w).accrueTick();
    expect(w.rpc.sent.map((t) => [t.nonce, (t.args[0] as Entry[]).length])).toEqual([
      [0, 64],
      [1, 1],
    ]);
  });
});

describe("per-wallet scan budget (B-L2)", () => {
  test("a spam wallet over its log budget is skipped and backed off, and its next scan covers half the span; others accrue", async () => {
    const w = new SpareWorld({ head: 2_000_000n });
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.pay(W1, M, usd(4.3), 3_000n);
    for (let i = 0; i < 120; i++) w.pay(W2, addr(0x70000 + i), 1n, 3_000n + BigInt(i));
    const k = keeperOn(w, { SCAN_WALLET_MAX_LOGS: "100" });
    await k.accrueTick();
    expect(scans(w)).toEqual([
      { wallet: W1, from: 2_001n, to: 502_000n }, // SCAN_MAX_BLOCKS slice
      { wallet: W2, from: 2_101n, to: 502_100n },
    ]);
    expect(entriesOf(w)).toEqual([{ account: A, wallet: W1, amount: usd(0.7), toBlock: 502_000n }]);
    expect(logs.has(`${W2} backed off 5m (1x): skipped this tick, scan budget spent: 120/100 logs; next scan covers 250000 blocks`)).toBe(true);

    w.rpc.requests.length = 0;
    setSystemTime(Date.now() + 301_000);
    await k.accrueTick();
    expect(scans(w)).toEqual([
      { wallet: W1, from: 502_001n, to: 1_002_000n },
      { wallet: W2, from: 2_101n, to: 252_100n },
    ]);
    expect(logs.has(`${W2} backed off 10m (2x): skipped this tick, scan budget spent: 120/100 logs; next scan covers 125000 blocks`)).toBe(true);
  });

  test("an unlinked wallet's scan state is forgotten: re-linked, it starts over on its new window at the full span", async () => {
    const w = new SpareWorld({ head: 2_000_000n });
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    for (let i = 0; i < 120; i++) w.pay(W2, addr(0x70000 + i), 1n, 3_000n + BigInt(i));
    const k = keeperOn(w, { SCAN_WALLET_MAX_LOGS: "100" });
    await k.accrueTick(); // W2 overruns: next span 250,000
    w.account(B, { wallets: [] }); // unlinked
    await k.accrueTick();
    expect(k.health().dormantAccounts).toBe(1);

    w.rpc.head += 1_000_000n;
    w.rpc.emit(BOOK.ruleRegistry, RR_LINKED, { account: B, wallet: W2 }, 2_100_000n);
    w.account(B, { wallets: [W2] });
    w.wallet(W2, { linkedAt: 2_100_000n });
    setSystemTime(Date.now() + 301_000); // past W2's backoff
    w.rpc.requests.length = 0;
    await k.accrueTick();
    expect(scans(w).find((s) => s.wallet === W2)).toEqual({ wallet: W2, from: 2_100_001n, to: 2_600_000n });
  });

  /** A world where W2 (account B) overran its first scan: its next scan covers 250,000 blocks, not 500,000. */
  async function overranOnce() {
    const w = new SpareWorld({ head: 2_000_000n });
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    for (let i = 0; i < 120; i++) w.pay(W2, addr(0x70000 + i), 1n, 3_000n + BigInt(i));
    const k = keeperOn(w, { SCAN_WALLET_MAX_LOGS: "100" });
    await k.accrueTick();
    expect(logs.has(`${W2} backed off 5m (1x): skipped this tick, scan budget spent: 120/100 logs; next scan covers 250000 blocks`)).toBe(true);
    return { w, k };
  }
  /** W2's scan once its backoff is over. */
  async function nextW2Scan(w: SpareWorld, k: { accrueTick: () => Promise<void> }) {
    w.rpc.requests.length = 0;
    setSystemTime(Date.now() + 301_000);
    await k.accrueTick();
    return scans(w).find((s) => s.wallet === W2);
  }

  test("an account read that fails at the RPC is an incomplete read: logged with its error, and no wallet's learned span is forgotten", async () => {
    const { w, k } = await overranOnce();
    const ruleOf = toFunctionSelector("ruleOf(address)").slice(2);
    const off = w.rpc.use((method, [tx]) => {
      if (method === "eth_call" && tx.to.toLowerCase() === MULTICALL3.toLowerCase() && tx.data.includes(ruleOf)) throw rpcError(-32000, "upstream unavailable");
    });
    await k.accrueTick();
    off();
    // Forgotten, W2 would start over at 500,000 blocks and overrun again.
    expect(await nextW2Scan(w, k)).toEqual({ wallet: W2, from: 2_101n, to: 252_100n });
    expect(logs.has("[keeper] account read failed for 2 item(s): ")).toBe(true);
    expect(logs.has("read failed; skipped this tick")).toBe(false);
  });

  test("an account whose own reads revert keeps its wallets' learned span: they are unseen, not unlinked", async () => {
    const { w, k } = await overranOnce();
    w.rpc.contract(BOOK.ruleRegistry, [], {
      activeSince: ([a]) => {
        if (a === B) throw new Revert("0x");
        return w.accounts.get(a)!.activeSince;
      },
    });
    await k.accrueTick();
    expect(logs.has(`account ${B} read failed; skipped this tick`)).toBe(true);
    w.rpc.contract(BOOK.ruleRegistry, [], { activeSince: ([a]) => w.accounts.get(a)!.activeSince });
    expect(await nextW2Scan(w, k)).toEqual({ wallet: W2, from: 2_101n, to: 252_100n });
  });

  test("the budgeted client charges getLogs only; every other call passes through", async () => {
    const w = new SpareWorld();
    const k = keeperOn(w);
    const budget = new ScanBudget({ maxCalls: 1, maxLogs: 10, deadlineAt: Date.now() + 60_000 });
    const c = budgetedLogs(k.logClient, budget);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(200_000n);
    expect(await c.getChainId()).toBe(4663);
    expect(budget.calls).toBe(0);
    await c.getLogs({ address: USDG, fromBlock: 1n, toBlock: 2n });
    expect(budget.calls).toBe(1);
    await expect(c.getLogs({ address: USDG, fromBlock: 1n, toBlock: 2n })).rejects.toThrow("scan budget spent: 1/1 RPC calls");
  });

  test("a wallet whose scan hangs is cut off at its own deadline; the tick goes on without it", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.pay(W1, M, usd(4.3), 3_000n);
    let hung: Promise<unknown> | undefined;
    w.rpc.use((method, [f]) => {
      if (method === "eth_getLogs" && f.topics?.[1] === pad(W2.toLowerCase() as Hex)) return (hung = new Promise((r) => setTimeout(r, 1_500)).then(() => []));
    });
    const k = keeperOn(w, { SCAN_WALLET_DEADLINE_MS: "1000" });
    const t0 = Date.now();
    await k.accrueTick();
    expect(Date.now() - t0).toBeLessThan(1_450);
    expect(entriesOf(w).map((e) => e.wallet)).toEqual([W1]);
    expect(logs.has(`${W2} backed off 5m (1x): skipped this tick, scan deadline: still running after 1 RPC call(s)`)).toBe(true);
    await hung;
  });

  test("wallets not reached before the tick deadline are scanned first next tick", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.enroll(C, [W3], { block: 2_200n });
    for (const x of [W1, W3]) w.pay(x, M, usd(4.3), 3_000n);
    w.rpc.use((method, [f]) => {
      // W2's scan answers only after the tick's 120 s scan deadline has passed.
      if (method === "eth_getLogs" && f.topics?.[1] === pad(W2.toLowerCase() as Hex)) setSystemTime(Date.now() + 130_000);
    });
    const k = keeperOn(w, { SCAN_CONCURRENCY: "1" });
    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W1, W2]);
    expect(logs.has("1 wallet(s) over their scan budget, 1 not reached before the 120000 ms tick deadline (scanned first next tick)")).toBe(true);
    expect(logs.has(`${W2} backed off 5m (1x): skipped this tick, scan deadline passed after 1 RPC call(s)`)).toBe(true);
    expect(entriesOf(w).map((e) => e.wallet)).toEqual([W1]);

    w.rpc.requests.length = 0;
    w.rpc.head += 1_000n;
    w.pay(W1, M, usd(4.3), 199_950n);
    await k.accrueTick();
    expect(scans(w).map((s) => s.wallet)).toEqual([W3, W1]); // never tried before the one tried last tick
  });

  test("a scan that fails backs off only that wallet", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1], { block: 2_000n });
    w.enroll(B, [W2], { block: 2_100n });
    w.pay(W1, M, usd(4.3), 3_000n);
    w.rpc.use((method, [f]) => {
      if (method === "eth_getLogs" && f.topics?.[1] === pad(W2.toLowerCase() as Hex)) throw rpcError(-32000, "header not found");
    });
    await keeperOn(w).accrueTick();
    expect(entriesOf(w).map((e) => e.wallet)).toEqual([W1]);
    expect(logs.has(`${W2} backed off 5m (1x): scan: `)).toBe(true);
  });
});

describe("backoff: what a wallet has outgrown is forgotten, what still fails is not", () => {
  const backedOff = (wallet: Address) => logs.lines.filter((l) => l.includes(`${wallet} backed off`)).map((l) => l.replace(/^\[keeper:accrue\] 0x[0-9a-fA-F]+ backed off /, ""));

  test("a busy wallet with nothing to pull keeps up with head over many ticks: a clean scan ends its scan backoff, and a span that only just fits is kept", async () => {
    const w = new SpareWorld({ head: 500_000n });
    w.enroll(A, [W1], { block: 2_000n });
    const TICKS = 45;
    const STEP = 30_000n; // blocks per one-minute tick
    // W1 only ever swaps (USDG into SwapRouter02): 80 transfers per 100,000 blocks, none of them a payment.
    for (let b = 2_500n; b <= 500_000n + STEP * BigInt(TICKS); b += 1_250n) w.pay(W1, getAddress(VENUE.swapRouter02), usd(10), b);
    // 100 logs fit 100,000 blocks of W1 (80) but not 200,000 (160). Its window never grows wide enough to be
    // zero-advanced, so no Accrued ever clears its backoff.
    const k = keeperOn(w, { SCAN_WALLET_MAX_LOGS: "100", SCAN_MAX_BLOCKS: "400000", IDLE_ADVANCE_BLOCKS: "100000000" });
    let blip = false;
    w.rpc.use((method, [f]) => {
      if (blip && method === "eth_getLogs" && f.topics?.[1] === pad(W1.toLowerCase() as Hex)) {
        blip = false;
        throw rpcError(-32000, "header not found");
      }
    });
    let toBlock = 0n;
    for (let i = 0; i < TICKS; i++) {
      blip = i === 32; // one failed scan, long after the overruns
      toBlock = w.rpc.head - 120n;
      await k.accrueTick();
      w.rpc.head += STEP;
      setSystemTime(Date.now() + 60_000);
    }

    expect(backedOff(W1)).toEqual([
      "5m (1x): skipped this tick, scan budget spent: 320/100 logs; next scan covers 200000 blocks",
      "10m (2x): skipped this tick, scan budget spent: 160/100 logs; next scan covers 100000 blocks",
      // Its clean scans cleared the overruns: a later failure starts the backoff over, not at 20m (3x).
      expect.stringMatching(/^5m \(1x\): scan: /),
    ]);
    // After the overruns, every scan fits the 100,000 blocks it learned (never doubled into another overrun) ...
    const after = scans(w).filter((s) => s.from > 2_001n);
    expect(after.every((s) => s.to - s.from < 100_000n)).toBe(true);
    // ... and it caught up with head, and is level with it at the end.
    expect(scans(w).at(-1)!.to).toBe(toBlock);
    expect(k.health().walletsBackedOff).toBe(0);
    expect(w.rpc.sent).toHaveLength(0);
  });

  test("a wallet whose pull keeps reverting still backs off toward the cap: a clean scan clears scan failures only", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.pay(W1, M, usd(4.3), 3_000n);
    w.accrueReverts.set(W1.toLowerCase(), new Revert(encodeErrorResult({ abi: sweepExecutorAbi, errorName: "RuleDisabled", args: [A] })));
    const k = keeperOn(w);
    await k.accrueTick();
    for (const ms of [301_000, 601_000]) {
      setSystemTime(Date.now() + ms); // past the backoff
      w.rpc.head += 1_000n;
      await k.accrueTick(); // scans the new blocks cleanly, then the pre-flight reverts again
    }
    expect(scans(w).map((s) => s.from)).toEqual([2_001n, 199_881n, 200_881n]);
    expect(backedOff(W1)).toEqual(["5m (1x): pre-flight revert: RuleDisabled", "10m (2x): pre-flight revert: RuleDisabled", "20m (3x): pre-flight revert: RuleDisabled"]);
  });
});
