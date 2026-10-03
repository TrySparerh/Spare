/**
 * Per-wallet scan budget (audit B-L2): one linked wallet can no longer stall
 * the accrue tick. Exercised through the real scan path (chain/logs.ts
 * transfersFrom, venue.ts V3PoolResolver) against fake RPC clients.
 */
import { describe, expect, test } from "bun:test";
import { RpcRequestError, type PublicClient } from "viem";
import { classifyLogError, transfersFrom } from "../src/chain/logs.ts";
import { budgetedLogs, scanEach, ScanBudget, ScanBudgetError, withDeadline } from "../src/keeper/budget.ts";
import { nextScanSpan } from "../src/keeper/plan.ts";
import { V3PoolResolver } from "../src/keeper/venue.ts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const SPAMMER = "0x000000000000000000000000000000000000dead" as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const far = () => Date.now() + 60_000;

/**
 * The public RHC RPC for a wallet that sends 1 unit to a new address every
 * other block: 250k transfers in a 500k-block scan window. Like the real node,
 * it refuses any range matching more than 10,000 logs.
 */
function spamWalletRpc(): { client: PublicClient; calls: () => number } {
  let n = 0;
  const client = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      n++;
      const first = fromBlock % 2n === 0n ? fromBlock : fromBlock + 1n;
      const count = toBlock >= first ? (toBlock - first) / 2n + 1n : 0n;
      if (count > 10_000n) {
        throw new RpcRequestError({ body: {}, url: "https://rpc.example", error: { code: -32602, message: "logs matched by query exceeds limit of 10000" } });
      }
      return Array.from({ length: Number(count) }, (_, i) => {
        const b = first + 2n * BigInt(i);
        return {
          removed: false,
          blockNumber: b,
          transactionHash: `0x${b.toString(16).padStart(64, "0")}`,
          logIndex: 0,
          args: { from: SPAMMER, to: `0x${b.toString(16).padStart(40, "0")}`, value: 1n },
        };
      });
    },
  } as unknown as PublicClient;
  return { client, calls: () => n };
}
const window = { token: USDG, wallet: SPAMMER, fromBlock: 1n, toBlock: 500_000n, maxRange: 2_000_000n, maxChunks: 1_000, finalBlock: 500_000n, cache: false };

describe("scan budget: a spammy wallet's range splitting stops at the budget", () => {
  test("unbudgeted, one spam wallet's window costs 63 sequential getLogs and 250k logs held in memory", async () => {
    const { client, calls } = spamWalletRpc();
    const logs = await transfersFrom(client, window);
    expect(calls()).toBe(63);
    expect(logs).toHaveLength(250_000);
  });

  test("budgeted, the scan stops at the log budget (first slice that answers) and throws ScanBudgetError", async () => {
    const { client, calls } = spamWalletRpc();
    const budget = new ScanBudget({ maxCalls: 64, maxLogs: 5_000, deadlineAt: far() });
    await expect(transfersFrom(budgetedLogs(client, budget), window)).rejects.toThrow("scan budget spent: 7812/5000 logs");
    expect(calls()).toBe(6); // 5 result-capped halvings + the first 15.6k-block slice
  });

  test("budgeted on calls alone, the halving stops at the call budget", async () => {
    const { client, calls } = spamWalletRpc();
    const budget = new ScanBudget({ maxCalls: 20, maxLogs: 1_000_000, deadlineAt: far() });
    await expect(transfersFrom(budgetedLogs(client, budget), window)).rejects.toThrow("scan budget spent: 20/20 RPC calls");
    expect(calls()).toBe(20);
  });

  test("a spent budget is never mistaken for a result cap (split) or a rate limit (retry)", () => {
    for (const msg of [
      new ScanBudgetError("scan budget spent: 64/64 RPC calls"),
      new ScanBudgetError("scan budget spent: 5001/5000 logs"),
      new ScanBudgetError("scan deadline passed after 3 RPC call(s)"),
      new ScanBudgetError("scan deadline: still running after 3 RPC call(s)"),
    ]) {
      expect(classifyLogError(msg)).toBe("other");
    }
  });

  test("logs are counted: a call returning more than the log budget throws", async () => {
    const logs = Array.from({ length: 300 }, () => ({}));
    const client = { getLogs: async () => logs } as unknown as PublicClient;
    const budget = new ScanBudget({ maxCalls: 64, maxLogs: 500, deadlineAt: far() });
    const c = budgetedLogs(client, budget);
    await c.getLogs({} as never);
    expect(budget.logs).toBe(300);
    await expect(c.getLogs({} as never)).rejects.toThrow("scan budget spent: 600/500 logs");
  });

  test("v3 pool lookups for thousands of counterparties are charged to the same budget", async () => {
    let multicalls = 0;
    const client = {
      // Multicall3.aggregate3: every counterparty is an EOA (no return data).
      readContract: async ({ args: [calls] }: { args: [unknown[]] }) => {
        multicalls++;
        return calls.map(() => ({ success: true, returnData: "0x" }));
      },
    } as unknown as PublicClient;
    const addrs = Array.from({ length: 5_000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const budget = new ScanBudget({ maxCalls: 10, maxLogs: 5_000, deadlineAt: far() });
    await expect(new V3PoolResolver(client).pools(addrs, () => budget.call())).rejects.toBeInstanceOf(ScanBudgetError);
    expect(multicalls).toBe(10);
    // Unbudgeted, the same lookup is one multicall per 60 addresses.
    expect(await new V3PoolResolver(client).pools(addrs)).toEqual(new Set());
    expect(multicalls).toBe(10 + Math.ceil(5_000 / 60));
  });
});

describe("deadline: an abandoned scan can never commit late", () => {
  test("withDeadline rejects at the deadline and stops the budget", async () => {
    const budget = new ScanBudget({ maxCalls: 64, maxLogs: 5_000, deadlineAt: Date.now() + 30 });
    let committed = false;
    const work = (async () => {
      await sleep(80);
      budget.check(); // the scan's commit guard
      committed = true;
    })();
    await expect(withDeadline(work, budget)).rejects.toBeInstanceOf(ScanBudgetError);
    await sleep(100);
    expect(committed).toBe(false);
    expect(() => budget.call()).toThrow(ScanBudgetError);
  });

  test("work that finishes in time resolves normally", async () => {
    const budget = new ScanBudget({ maxCalls: 64, maxLogs: 5_000, deadlineAt: Date.now() + 500 });
    expect(await withDeadline(sleep(5).then(() => 7), budget)).toBe(7);
  });

  test("an injected clock drives the deadline check", () => {
    let now = 1_000;
    const budget = new ScanBudget({ maxCalls: 64, maxLogs: 5_000, deadlineAt: 2_000 }, () => now);
    budget.call();
    now = 2_000;
    expect(() => budget.call()).toThrow("scan deadline passed after 1 RPC call(s)");
  });
});

describe("scanEach: one wallet never blocks the others", () => {
  const limits = { maxCalls: 8, maxLogs: 5_000, deadlineMs: 60 };

  test("a wallet that hangs is cut off at its own deadline; every other wallet is scanned", async () => {
    const done: string[] = [];
    const t0 = Date.now();
    const r = await scanEach(["spam", "a", "b", "c"], {
      concurrency: 1,
      tickDeadlineAt: Date.now() + 5_000,
      limits,
      scan: async (w) => {
        if (w === "spam") await new Promise(() => {}); // never settles
        done.push(w);
      },
    });
    expect(r.overran.map((o) => o.item)).toEqual(["spam"]);
    expect(r.done).toEqual(["a", "b", "c"]);
    expect(done).toEqual(["a", "b", "c"]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("a wallet that burns RPC calls is stopped at its call budget", async () => {
    let spamCalls = 0;
    const r = await scanEach(["spam", "a"], {
      concurrency: 2,
      tickDeadlineAt: Date.now() + 5_000,
      limits,
      scan: async (w, budget) => {
        for (;;) {
          budget.call();
          if (w === "spam") spamCalls++;
          else return;
          await null;
        }
      },
    });
    expect(spamCalls).toBe(8);
    expect(r.overran[0]!.error.message).toBe("scan budget spent: 8/8 RPC calls");
    expect(r.done).toEqual(["a"]);
  });

  test("the tick deadline bounds the whole phase; wallets not reached are reported, not failed", async () => {
    // a takes 60 ms; b starts before the 100 ms tick deadline and is cut off AT it; c, d never start.
    const t0 = Date.now();
    const r = await scanEach(["a", "b", "c", "d"], {
      concurrency: 1,
      tickDeadlineAt: t0 + 100,
      limits: { ...limits, deadlineMs: 1_000 },
      scan: () => sleep(60),
    });
    expect(r.done).toEqual(["a"]);
    expect(r.overran.map((o) => o.item)).toEqual(["b"]);
    expect(r.unreached).toEqual(["c", "d"]);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  test("a scan error that is not the budget is reported as a failure of that wallet only", async () => {
    const r = await scanEach(["bad", "a"], {
      concurrency: 2,
      tickDeadlineAt: Date.now() + 5_000,
      limits,
      scan: async (w) => {
        if (w === "bad") throw new Error("no RuleSet before block 7");
      },
    });
    expect(r.failed.map((f) => [f.item, (f.error as Error).message])).toEqual([["bad", "no RuleSet before block 7"]]);
    expect(r.done).toEqual(["a"]);
  });
});

describe("scan span adapts so a busy wallet still progresses", () => {
  const roomy = (blocks: bigint) => ({ ok: true as const, blocks, used: 0.5 });
  test("halves on an overrun, doubles back on a clean full-span scan with budget to spare, within [min, max]", () => {
    expect(nextScanSpan(500_000n, { ok: false }, 1_000n, 500_000n)).toBe(250_000n);
    expect(nextScanSpan(1_500n, { ok: false }, 1_000n, 500_000n)).toBe(1_000n);
    expect(nextScanSpan(250_000n, roomy(250_000n), 1_000n, 500_000n)).toBe(500_000n);
    expect(nextScanSpan(400_000n, roomy(400_000n), 1_000n, 500_000n)).toBe(500_000n);
  });

  test("a span that only just fit is kept, not doubled into an overrun; so is one a short window never filled", () => {
    expect(nextScanSpan(125_000n, { ok: true, blocks: 125_000n, used: 0.51 }, 1_000n, 500_000n)).toBe(125_000n);
    expect(nextScanSpan(125_000n, { ok: true, blocks: 30_000n, used: 0.1 }, 1_000n, 500_000n)).toBe(125_000n);
    expect(nextScanSpan(800_000n, { ok: true, blocks: 30_000n, used: 0.1 }, 1_000n, 500_000n)).toBe(500_000n); // max lowered
  });

  test("ScanBudget.used(): the largest share spent of calls, logs and time to the deadline", () => {
    let now = 1_000;
    const b = new ScanBudget({ maxCalls: 64, maxLogs: 5_000, deadlineAt: 11_000 }, () => now);
    expect(b.used()).toBe(0);
    b.call();
    b.addLogs(2_500);
    expect(b.used()).toBe(0.5);
    for (let i = 0; i < 47; i++) b.call();
    expect(b.used()).toBe(0.75);
    now = 10_000;
    expect(b.used()).toBe(0.9);
    expect(new ScanBudget({ maxCalls: 64, maxLogs: 5_000, deadlineAt: 1_000 }, () => 1_000).used()).toBe(1); // no time at all
  });
});
