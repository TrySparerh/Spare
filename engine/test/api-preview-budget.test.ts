/**
 * B-M3: rule.preview is public, so its eth_getLogs work and the logs it holds
 * must be bounded PER REQUEST — however the provider makes it split, however
 * many wallets it scans — and the engine must not run an unbounded number of
 * them at once.
 *
 * A fake RHC RPC (viem `custom` transport) counts every eth_getLogs and
 * answers like the real one: a query matching more than its result cap fails
 * with the RHC's own -32000 "logs matched by query exceeds limit of N", which
 * makes logs.ts split the range. A "busy sender" sends one USDG Transfer every
 * `every` blocks; blocks are 0.1 s apart, as on RHC.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPublicClient,
  custom,
  encodeEventTopics,
  getAddress,
  pad,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { classifyLogError, LogBudget, LogBudgetError, TRANSFER_EVENT, transfersFrom } from "../src/chain/logs.ts";
import { runPreview, type PreviewInput } from "../src/chain/preview.ts";
import { robinhoodChain } from "../src/chain/client.ts";
import { USDG, VENUE } from "../src/chain/constants.ts";
import { paymentsCursorName } from "../src/workers/cursors.ts";
import { Gate, KeyedGate } from "../src/lib/gate.ts";
import type { Db, DbHandle } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { caller, makeCtx } from "./helpers/context.ts";
import { closeTestDb, testDb, type TestDb } from "./helpers/db.ts";

const HEAD = 30_000_000n;
const GENESIS_TS = 1_780_000_000n;
const blockTs = (n: bigint) => GENESIS_TS + n / 10n;
const DAY_BLOCKS = 864_000n;
const WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const MERCHANT: Address = getAddress("0x2222222222222222222222222222222222222222");
const RULE = { roundTo: 1 as const, multiplier: 1 };

interface FakeRpc {
  client: PublicClient;
  /** eth_getLogs requests the transport received. */
  getLogs: number;
  /** Logs it returned (what the engine was made to hold). */
  logsServed: number;
}

/**
 * A fake RHC node. `every`: one Transfer from ANY sender every `every`
 * blocks. `resultCap`: the provider's per-query result limit. `throttle`:
 * answer every eth_getLogs with a 429 (Retry-After: 0) instead.
 */
function fakeRpc(o: { every: bigint; resultCap: number; throttle?: boolean }): FakeRpc {
  const [transferTopic] = encodeEventTopics({ abi: [TRANSFER_EVENT], eventName: "Transfer" });
  const merchantTopic = pad(MERCHANT.toLowerCase() as Address, { size: 32 });
  const fake: FakeRpc = { client: undefined as unknown as PublicClient, getLogs: 0, logsServed: 0 };
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = params as any[];
    switch (method) {
      case "eth_chainId":
        return toHex(robinhoodChain.id);
      case "eth_blockNumber":
        return toHex(HEAD);
      case "eth_getBlockByNumber": {
        const n = BigInt(p[0]);
        if (n > HEAD) return null;
        return { number: toHex(n), hash: pad(toHex(n), { size: 32 }), timestamp: toHex(blockTs(n)), transactions: [] };
      }
      case "eth_getLogs": {
        fake.getLogs++;
        if (o.throttle) {
          throw Object.assign(new Error("Too Many Requests"), { code: 429, headers: new Headers({ "retry-after": "0" }) });
        }
        const f = p[0] as { fromBlock: `0x${string}`; toBlock: `0x${string}`; topics: `0x${string}`[] };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        const first = ((from + o.every - 1n) / o.every) * o.every;
        const matched = first > to ? 0n : (to - first) / o.every + 1n;
        if (matched > BigInt(o.resultCap)) {
          throw Object.assign(new Error(`logs matched by query exceeds limit of ${o.resultCap}`), { code: -32000 });
        }
        const out = [];
        for (let b = first; b <= to; b += o.every) {
          out.push({
            address: USDG.toLowerCase(),
            blockHash: pad(toHex(b), { size: 32 }),
            blockNumber: toHex(b),
            data: pad(toHex(1_230_000n), { size: 32 }), // 1.23 USDG
            logIndex: "0x0",
            removed: false,
            topics: [transferTopic, f.topics[1], merchantTopic],
            transactionHash: pad(toHex(b), { size: 32 }),
            transactionIndex: "0x0",
          });
        }
        fake.logsServed += out.length;
        return out;
      }
    }
    throw new Error(`fake RPC: unexpected ${method}`);
  };
  // retryCount 0: count exactly what logs.ts asks for. (The RHC's -32000
  // result-cap error is not one viem's http transport retries either.)
  fake.client = createPublicClient({ chain: robinhoodChain, transport: custom({ request }, { retryCount: 0 }) }) as PublicClient;
  return fake;
}

/** A database whose payment observer has indexed nothing: every wallet takes the RPC path. */
const nothingIndexed = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db;
const noDb = { db: nothingIndexed, sql: undefined } as unknown as DbHandle;

function previewArgs(client: PublicClient, over: Partial<PreviewInput> = {}): PreviewInput {
  return {
    client,
    db: nothingIndexed,
    chainId: 4663,
    account: WALLET,
    wallets: [WALLET],
    walletsNote: null,
    usdgToken: USDG,
    spareContracts: [],
    venue: Object.values(VENUE),
    rule: { ...RULE, weeklyCap: null, enabled: true, source: "input" },
    days: 1,
    finalityBuffer: 3000n,
    maxRange: 2_000_000n,
    maxChunks: 250,
    maxLogs: 20_000,
    timeoutMs: 20_000,
    ...over,
  };
}

async function refusal(p: Promise<unknown>): Promise<LogBudgetError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LogBudgetError);
  return err as LogBudgetError;
}

describe("transfersFrom: every getLogs call counts against maxChunks", () => {
  test("result-cap splits are charged: a scan needing ~2,300 calls stops at exactly maxChunks", async () => {
    // One day at the old 50k range = 18 chunks (inside maxChunks), but a 100-result
    // provider cap splits each chunk into 64 leaves: ~2,300 calls before the fix.
    const rpc = fakeRpc({ every: 10n, resultCap: 100 });
    const err = await refusal(
      transfersFrom(rpc.client, {
        token: USDG,
        wallet: WALLET,
        fromBlock: HEAD - DAY_BLOCKS,
        toBlock: HEAD,
        maxRange: 50_000n,
        maxChunks: 40,
        finalBlock: HEAD - 3000n,
        cache: false,
      }),
    );
    expect(err.limit).toBe("calls");
    expect(err.message).toContain("more than 40 getLogs calls");
    expect(rpc.getLogs).toBe(40);
  });

  test("rate-limit retries are charged too (maxChunks 3 = 3 requests, not 1 + 4 retries)", async () => {
    const rpc = fakeRpc({ every: 10n, resultCap: 10_000, throttle: true });
    const err = await refusal(
      transfersFrom(rpc.client, {
        token: USDG,
        wallet: WALLET,
        fromBlock: HEAD - 1_000n,
        toBlock: HEAD - 1n, // one chunk
        maxRange: 50_000n,
        maxChunks: 3,
        finalBlock: HEAD - 3000n,
        cache: false,
      }),
    );
    expect(err.limit).toBe("calls");
    expect(rpc.getLogs).toBe(3);
  });

  test("a throttled scan fails at its deadline instead of sleeping past it", async () => {
    const rpc = fakeRpc({ every: 10n, resultCap: 10_000, throttle: true });
    const started = Date.now();
    const err = await refusal(
      transfersFrom(rpc.client, {
        token: USDG,
        wallet: WALLET,
        fromBlock: HEAD - 1_000n,
        toBlock: HEAD - 1n, // one chunk
        maxRange: 50_000n,
        maxChunks: 100,
        finalBlock: HEAD - 3000n,
        cache: false,
        // The first backoff is >= 250 ms; only 100 ms are left.
        budget: new LogBudget({ maxCalls: 100, deadline: Date.now() + 100 }),
      }),
    );
    expect(err.limit).toBe("deadline");
    expect(rpc.getLogs).toBe(1);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("a shared budget bounds several scans together, and a refused level stays shut", async () => {
    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    const shared = new LogBudget({ maxCalls: 3 });
    const scan = () =>
      transfersFrom(rpc.client, {
        token: USDG,
        wallet: WALLET,
        fromBlock: HEAD - 100_000n,
        toBlock: HEAD - 1n,
        maxRange: 50_000n, // 2 calls per scan (two 50k-aligned chunks)
        maxChunks: 250,
        finalBlock: HEAD - 3000n,
        cache: false,
        budget: shared,
      });
    expect((await scan()).length).toBe(1);
    expect(shared.calls).toBe(2);
    expect((await refusal(scan())).limit).toBe("window"); // needs 2, 1 left: refused before calling
    expect(rpc.getLogs).toBe(2);
  });
});

describe("LogBudget refusals", () => {
  test("are never mistaken for a result cap (split) or a rate limit (retry)", async () => {
    const refusals: unknown[] = [];
    const catching = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        refusals.push(e);
      }
    };
    catching(() => new LogBudget({ maxCalls: 1 }).require(2, "a window of 9 blocks"));
    const spent = new LogBudget({ maxCalls: 1 });
    spent.call();
    catching(() => spent.call());
    catching(() => new LogBudget({ maxCalls: 9, maxLogs: 1 }).hold(2));
    catching(() => new LogBudget({ maxCalls: 9, deadline: Date.now() - 1 }).call());
    await new LogBudget({ maxCalls: 9, deadline: Date.now() + 10 }).pause(1_000).catch((e) => refusals.push(e));
    expect(refusals.map((e) => (e as LogBudgetError).limit)).toEqual(["window", "calls", "logs", "deadline", "deadline"]);
    for (const e of refusals) expect(classifyLogError(e)).toBe("other");
  });

  test("a parent shut by its own limit refuses every child; a child's failure leaves the parent open", () => {
    const parent = new LogBudget({ maxCalls: 1 });
    const a = new LogBudget({ maxCalls: 9 }, parent);
    a.call();
    expect(() => new LogBudget({ maxCalls: 9 }, parent).call()).toThrow(LogBudgetError);
    const open = new LogBudget({ maxCalls: 9 });
    const child = new LogBudget({ maxCalls: 9 }, open);
    child.close(new Error("rpc down"));
    expect(() => child.call()).toThrow("rpc down");
    expect(() => new LogBudget({ maxCalls: 9 }, open).call()).not.toThrow();
  });
});

describe("runPreview: one budget per request", () => {
  test("the audit's 2-day busy sender (864k transfers) is refused after a bounded scan", async () => {
    // One Transfer every 2 blocks = 864,000 in 2 days; each 2M chunk splits 7 levels deep.
    const rpc = fakeRpc({ every: 2n, resultCap: 10_000 });
    const err = await refusal(runPreview(previewArgs(rpc.client, { days: 2 })));
    expect(err.limit).toBe("logs");
    expect(err.message).toContain("more than 20000 transfers");
    // Before the fix: ~220 calls and all 864,000 logs held.
    expect(rpc.getLogs).toBeLessThanOrEqual(16);
    expect(rpc.logsServed).toBeLessThan(20_000 + 4 * 10_000); // the cap + one leaf per concurrent chunk
  });

  test("a window too large for the RPC budget is refused before a single getLogs call", async () => {
    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    // 30 days at a 50k range = 519 calls > 250.
    const err = await refusal(runPreview(previewArgs(rpc.client, { days: 30, maxRange: 50_000n })));
    expect(err.limit).toBe("window");
    expect(rpc.getLogs).toBe(0);
  });

  test("the call budget is per REQUEST: 8 wallets cannot each spend maxChunks", async () => {
    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    const wallets = Array.from({ length: 8 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "a")}`));
    // 7 days at 2M = 5 aligned chunks per wallet, 40 in all; each wallet alone would fit in 20.
    const err = await refusal(runPreview(previewArgs(rpc.client, { wallets, days: 7, maxChunks: 20 })));
    expect(err.limit).toBe("window");
    expect(err.message).toContain("8 unindexed wallets needs 40 getLogs calls");
    expect(rpc.getLogs).toBe(0);
  });

  test("an ordinary wallet still previews, inside the budget", async () => {
    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    const r = await runPreview(previewArgs(rpc.client, { days: 1 }));
    // Window [29,136,000, 30,000,000]: transfers at 29.2M ... 30.0M.
    expect(r.totals.payments).toBe(9);
    expect(r.totals.roundUps.raw).toBe((9n * 770_000n).toString());
    expect(rpc.getLogs).toBe(2); // two 2M-aligned chunks
  });
});

describe("rule.preview (router): bounded and typed", () => {
  test("a preview that needs more calls than the cap answers too_large after exactly previewMaxChunks calls", async () => {
    // A 100-result provider cap: one day splits into ~255 calls before the fix.
    const rpc = fakeRpc({ every: 100n, resultCap: 100 });
    const api = caller(makeCtx({ client: rpc.client, handle: noDb, previewMaxChunks: 40, previewMaxLogs: 200_000 }));
    const r = (await api.rule.preview({ account: WALLET, days: 1, rule: RULE })) as { available: boolean; code: string; reason: string };
    expect(r.available).toBe(false);
    expect(r.code).toBe("too_large");
    expect(r.reason).toContain("more than 40 getLogs calls");
    expect(rpc.getLogs).toBe(40);
  });

  test("too many held logs answers too_large, not an out-of-memory engine", async () => {
    const rpc = fakeRpc({ every: 2n, resultCap: 10_000 });
    const api = caller(makeCtx({ client: rpc.client, handle: noDb }));
    const r = (await api.rule.preview({ account: WALLET, days: 2, rule: RULE })) as { available: boolean; code: string; reason: string };
    expect(r).toMatchObject({ available: false, code: "too_large" });
    expect(r.reason).toContain("more than 20000 transfers");
    expect(rpc.getLogs).toBeLessThanOrEqual(16);
  });

  test("a full preview gate answers busy before any RPC call, and every exit releases its slot", async () => {
    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    const gate = new Gate(1);
    const api = caller(makeCtx({ client: rpc.client, handle: noDb, previewGate: gate }));

    const held = gate.tryEnter()!;
    const busy = (await api.rule.preview({ account: WALLET, days: 1, rule: RULE })) as { available: boolean; code: string };
    expect(busy).toMatchObject({ available: false, code: "busy" });
    expect(rpc.getLogs).toBe(0);
    held();

    const ok = (await api.rule.preview({ account: WALLET, days: 1, rule: RULE })) as { available: boolean };
    expect(ok.available).toBe(true);
    expect(gate.inUse).toBe(0);
    // A refused preview releases its slot too.
    const tooBig = caller(makeCtx({ client: rpc.client, handle: noDb, previewGate: gate, previewMaxChunks: 1 }));
    expect(((await tooBig.rule.preview({ account: WALLET, days: 1, rule: RULE })) as { code: string }).code).toBe("too_large");
    expect(gate.inUse).toBe(0);
  });

  test("one preview in flight per client: a second from the same rate-limit key is busy before any RPC call, others still run", async () => {
    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    const perClient = new KeyedGate(1);
    const gate = new Gate(4);
    const from = (clientKey: string) => caller(makeCtx({ client: rpc.client, handle: noDb, previewGate: gate, previewClientGate: perClient, clientKey }));

    // 203.0.113.7 has a slow preview running; the engine-wide gate has room for three more.
    const running = perClient.tryEnter("203.0.113.7")!;
    const second = (await from("203.0.113.7").rule.preview({ account: WALLET, days: 1, rule: RULE })) as { available: boolean; code: string; reason: string };
    expect(second).toMatchObject({ available: false, code: "busy", reason: "a rule preview from your address is already running — wait for it to finish" });
    expect(rpc.getLogs).toBe(0);
    expect(gate.inUse).toBe(0); // refused before it took an engine-wide slot

    const other = (await from("198.51.100.4").rule.preview({ account: WALLET, days: 1, rule: RULE })) as { available: boolean };
    expect(other.available).toBe(true);
    running();
    expect(((await from("203.0.113.7").rule.preview({ account: WALLET, days: 1, rule: RULE })) as { available: boolean }).available).toBe(true);
    expect([gate.inUse, perClient.keys]).toEqual([0, 0]);

    // The engine-wide gate full: busy, and the client's own slot is handed back.
    const all = [gate.tryEnter()!, gate.tryEnter()!, gate.tryEnter()!, gate.tryEnter()!];
    const full = (await from("192.0.2.1").rule.preview({ account: WALLET, days: 1, rule: RULE })) as { code: string; reason: string };
    expect(full).toMatchObject({ code: "busy", reason: "4 rule previews are already running — try again in a few seconds" });
    expect(perClient.inUse("192.0.2.1")).toBe(0);
    all.forEach((r) => r());
  });

  test("KeyedGate: per-key limit, idempotent release, idle keys forgotten", () => {
    const g = new KeyedGate(2);
    const a1 = g.tryEnter("a")!;
    const a2 = g.tryEnter("a")!;
    expect(g.tryEnter("a")).toBeNull();
    const b1 = g.tryEnter("b")!;
    expect([g.inUse("a"), g.inUse("b"), g.keys]).toEqual([2, 1, 2]);
    a1();
    a1();
    expect(g.inUse("a")).toBe(1);
    a2();
    b1();
    expect(g.keys).toBe(0);
    expect(() => new KeyedGate(0)).toThrow();
  });

  test("Gate: refuses past its size, release is idempotent", () => {
    const g = new Gate(2);
    const a = g.tryEnter()!;
    const b = g.tryEnter()!;
    expect(g.tryEnter()).toBeNull();
    a();
    a();
    expect(g.inUse).toBe(1);
    expect(g.tryEnter()).not.toBeNull();
    b();
    expect(() => new Gate(0)).toThrow();
  });
});

describe("rule.preview DB path: indexed rows count against the same logs cap", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await testDb(4663);
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("a covered wallet with more rows than maxLogs is refused without loading them all, and without RPC logs", async () => {
    const { db } = tdb.handle;
    await db.insert(schema.cursors).values({
      chainId: 4663,
      name: paymentsCursorName(WALLET),
      source: "test",
      startBlock: 0n,
      lastBlock: HEAD,
    });
    const rows = Array.from({ length: 101 }, (_, i) => {
      const block = HEAD - 1_000n - BigInt(i) * 100n;
      return {
        chainId: 4663,
        wallet: WALLET.toLowerCase(),
        account: WALLET.toLowerCase(),
        txHash: pad(toHex(block), { size: 32 }),
        logIndex: 0,
        blockNumber: block,
        blockTime: new Date(Number(blockTs(block)) * 1000),
        amount: "1230000",
        counterparty: MERCHANT.toLowerCase(),
        excludedReason: null,
        delta: "770000",
        roundTo: 1,
        multiplier: 1,
      };
    });
    await db.insert(schema.payments).values(rows);

    const rpc = fakeRpc({ every: 100_000n, resultCap: 10_000 });
    const err = await refusal(runPreview(previewArgs(rpc.client, { db, maxLogs: 100 })));
    expect(err.limit).toBe("logs");
    expect(rpc.getLogs).toBe(0);

    // At the cap it is served, from the DB.
    const ok = await runPreview(previewArgs(rpc.client, { db, maxLogs: 101 }));
    expect(ok.sources).toEqual([{ wallet: WALLET, source: "db", payments: 101 }]);
    expect(rpc.getLogs).toBe(0);
  });
});
