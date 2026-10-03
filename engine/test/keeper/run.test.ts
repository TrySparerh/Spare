/**
 * The keeper entrypoint (run.ts startKeeper): startup checks, /health from the
 * first second, the first tick only after STARTUP_DELAY_MS, the two loops, the
 * gas check, and a graceful SIGTERM / SIGINT that drains the tick in flight.
 * Timers are Bun's fake timers; the chain is the fake RPC (custom transport,
 * and once over HTTP the way production reaches its node).
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { Keeper } from "../../src/keeper/keeper.ts";
import { loadConfig } from "../../src/keeper/config.ts";
import { startKeeper } from "../../src/keeper/run.ts";
import { rpcError } from "../helpers/fake-rpc.ts";
import { addr, BOOK, BOOK_JSON, captureLogs, KEEPER, keeperEnv, SpareWorld, usd, type Entry } from "../helpers/fake-rpc-spare.ts";

const A = addr(0xa11ce);
const W1 = addr(0x1001);
const M = addr(0x3e7c4a7);
const TOKEN = "h".repeat(40);
const EVENTS = ["SIGTERM", "SIGINT", "unhandledRejection"] as const;

let logs: ReturnType<typeof captureLogs>;
let exits: (number | undefined)[];
let exitSpy: ReturnType<typeof spyOn>;
let before: Record<string, Function[]>;
let stops: (() => void)[];
beforeEach(() => {
  logs = captureLogs();
  exits = [];
  exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => void exits.push(code)) as never);
  before = Object.fromEntries(EVENTS.map((e) => [e, process.listeners(e)]));
  stops = [];
});
afterEach(() => {
  jest.useRealTimers();
  for (const s of stops) s();
  for (const e of EVENTS) for (const l of process.listeners(e)) if (!before[e]!.includes(l)) process.off(e, l as never);
  exitSpy.mockRestore();
  logs.restore();
});

/** The handlers startKeeper registered for `event` (the test process's own are left alone). */
const added = (event: (typeof EVENTS)[number]) => process.listeners(event).filter((l) => !before[event]!.includes(l)) as ((...a: unknown[]) => void)[];
const signal = (event: "SIGTERM" | "SIGINT") => added(event).forEach((l) => l(event));

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}
/** Let promise chains run (the fake chain answers in microtasks), then let the loops re-arm their timers. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50_000; i++) {
    if (cond()) return settle();
    await Promise.resolve();
    if (i % 500 === 499) await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function settle(): Promise<void> {
  for (let i = 0; i < 2_000; i++) await Promise.resolve();
}
/** Move fake time forward a second at a time, letting each tick finish as it would in real time. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) {
    jest.advanceTimersByTime(Math.min(1_000, left));
    await settle();
  }
}
function world(): SpareWorld {
  const w = new SpareWorld();
  w.enroll(A, [W1]);
  w.pay(W1, M, usd(4.3), 3_000n);
  return w;
}
async function start(w: SpareWorld, env: Record<string, string> = {}) {
  const port = freePort();
  const r = await startKeeper({ ...keeperEnv(), ADDRESSES_JSON: JSON.stringify(BOOK_JSON), PORT: String(port), HEALTH_TOKEN: TOKEN, ...env }, w.rpc.transport());
  if (r.server) stops.push(() => r.server!.stop(true));
  const get = async (path: string, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };
  return { ...r, port, get };
}
const ticks = (k: Keeper) => k.history.map((h) => h.kind).reverse();

describe("startup", () => {
  test("refuses an RPC with no SweepExecutor bytecode, or on another chain, before starting anything", async () => {
    const w = world();
    w.rpc.code.delete(BOOK.sweepExecutor.toLowerCase());
    await expect(start(w)).rejects.toThrow(`no SweepExecutor bytecode at ${BOOK.sweepExecutor} on chain 4663`);
    const w2 = world();
    w2.rpc.chainId = 1;
    await expect(start(w2)).rejects.toThrow("RPC is chain 1, expected 4663");
    expect(added("SIGTERM")).toHaveLength(0);
    expect(w.rpc.count("eth_blockNumber") + w2.rpc.count("eth_blockNumber")).toBe(0);
  });

  test("/health is up at once; the first tick waits STARTUP_DELAY_MS; the sweep loop starts 15 s after it; each loop then keeps its own interval", async () => {
    jest.useFakeTimers();
    const w = world();
    const { keeper, port, get } = await start(w);
    expect(logs.lines.slice(0, 3)).toEqual([
      `[keeper] chain 4663; keeper ${KEEPER}; executor ${BOOK.sweepExecutor}; broadcast ON; eth 1`,
      `[keeper] health on [::]:${port}/health`,
      "[keeper] first tick in 180s",
    ]);
    // Public: liveness only (no address, gas or reasons).
    expect(await get("/health")).toEqual({ status: 200, body: { ok: true, started: false, uptimeSec: expect.any(Number), recent: [] } });
    expect((await get("/", TOKEN)).body).toMatchObject({
      ok: true,
      started: false,
      chainId: 4663,
      keeper: KEEPER,
      executor: BOOK.sweepExecutor,
      broadcast: true,
      accounts: 0,
      recent: [],
      reasons: [],
      eth: "1",
    });
    expect(await get("/metrics")).toEqual({ status: 404, body: "not found" });

    jest.advanceTimersByTime(179_999);
    await settle();
    expect(w.rpc.count("eth_blockNumber")).toBe(0);
    jest.advanceTimersByTime(1);
    await until(() => keeper.history.length === 1, "the first accrue tick");
    expect(ticks(keeper)).toEqual(["accrue"]);
    expect((w.rpc.sent[0]!.args[0] as Entry[])[0]).toEqual({ account: A, wallet: W1, amount: usd(0.7), toBlock: 199_880n });
    const detail = (await get("/health", TOKEN)).body as { started: boolean; accounts: number; recent: { kind: string; tx: string }[] };
    expect(detail).toMatchObject({ started: true, accounts: 1 });
    expect(detail.recent[0]).toMatchObject({ kind: "accrue", tx: w.rpc.sent[0]!.hash });

    jest.advanceTimersByTime(14_999);
    await settle();
    expect(ticks(keeper)).toEqual(["accrue"]);
    jest.advanceTimersByTime(1);
    await until(() => keeper.history.length === 2, "the first sweep tick");
    expect(ticks(keeper)).toEqual(["accrue", "sweep"]);

    jest.advanceTimersByTime(44_999); // the next accrue is ACCRUE_EVERY_MS after the first one finished (t = 240 s)
    await settle();
    expect(ticks(keeper)).toEqual(["accrue", "sweep"]);
    jest.advanceTimersByTime(1);
    await until(() => keeper.history.length === 3, "the second accrue tick");
    await advance(554_999); // t = 794.999 s
    expect(ticks(keeper).filter((k) => k === "sweep")).toHaveLength(1);
    await advance(1); // t = 795 s: SWEEP_EVERY_MS after the first sweep
    expect(ticks(keeper).filter((k) => k === "sweep")).toHaveLength(2);
    expect(ticks(keeper).filter((k) => k === "accrue")).toHaveLength(11); // t = 180, 240, ..., 780 s
  });

  test("/health listens dual-stack on \"::\" (the private network is IPv6): the same liveness answer over IPv6 and IPv4; HOST overrides", async () => {
    jest.useFakeTimers();
    const { server, port } = await start(world());
    expect(server!.hostname).toBe("::");
    for (const host of ["[::1]", "127.0.0.1"]) {
      const res = await fetch(`http://${host}:${port}/health`);
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { ok: true, started: false, uptimeSec: expect.any(Number), recent: [] } });
    }
    const v4 = await start(world(), { HOST: "127.0.0.1" });
    expect(v4.server!.hostname).toBe("127.0.0.1");
    expect(logs.has(`[keeper] health on 127.0.0.1:${v4.port}/health`)).toBe(true);
    expect((await v4.get("/health")).status).toBe(200);
  });

  test("the gas check runs every 5 minutes, warns below LOW_GAS_WEI and survives a failed read", async () => {
    jest.useFakeTimers();
    const w = world();
    await start(w, { STARTUP_DELAY_MS: "3600000" });
    w.rpc.balance = 10n ** 14n;
    jest.advanceTimersByTime(300_000);
    await until(() => logs.has("LOW GAS"), "the gas warning");
    expect(logs.has(`[keeper] LOW GAS: 0.0001 ETH on ${KEEPER}`)).toBe(true);
    w.rpc.use((method) => {
      if (method === "eth_getBalance") throw rpcError(-32000, "upstream unavailable");
    });
    const n = logs.lines.length;
    jest.advanceTimersByTime(300_000);
    await settle();
    expect(w.rpc.count("eth_getBalance")).toBe(3);
    expect(logs.lines.length).toBe(n);
  });

  test("without PORT there is no health server; with no delay there is no delay line", async () => {
    jest.useFakeTimers();
    const w = world();
    const { server } = await start(w, { PORT: "", STARTUP_DELAY_MS: "0" });
    expect(server).toBeUndefined();
    expect(logs.lines.some((l) => l.includes("health on") || l.includes("first tick in"))).toBe(false);
    signal("SIGTERM");
  });

  test("an unhandled rejection is logged, not fatal", async () => {
    jest.useFakeTimers();
    await start(world());
    added("unhandledRejection").forEach((l) => l(new Error("socket hang up")));
    expect(logs.has("[keeper] unhandled rejection: socket hang up")).toBe(true);
    expect(exits).toEqual([]);
  });
});

describe("graceful shutdown", () => {
  test("SIGTERM: no new ticks, /health goes not-ok, the tick in flight drains, then exit 0", async () => {
    jest.useFakeTimers();
    const w = world();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let armed = true;
    w.rpc.use(async (method) => {
      if (armed && method === "eth_getLogs") {
        armed = false;
        await held;
      }
    });
    const { keeper, get } = await start(w, { STARTUP_DELAY_MS: "0" });
    jest.advanceTimersByTime(0);
    await until(() => !armed, "the first tick to reach the RPC");

    signal("SIGTERM");
    expect(logs.has("[keeper] SIGTERM: no new ticks; draining the one in flight")).toBe(true);
    expect(await get("/health?strict=1")).toEqual({ status: 503, body: { ok: false, started: true, uptimeSec: expect.any(Number), recent: [] } });
    expect(((await get("/health", TOKEN)).body as { reasons: string[] }).reasons).toEqual(["shutting down"]);
    signal("SIGINT"); // already stopping: ignored
    expect(logs.lines.filter((l) => l.includes("no new ticks"))).toHaveLength(1);

    jest.advanceTimersByTime(1_000);
    await settle();
    expect(exits).toEqual([]); // still draining

    release();
    await until(() => keeper.history.length === 1, "the drained tick");
    expect(w.rpc.sent).toHaveLength(1); // the tick in flight finished its work
    jest.advanceTimersByTime(200);
    await until(() => exits.length === 1, "exit");
    expect(exits).toEqual([0]);
    expect(logs.has("[keeper] drained; exiting")).toBe(true);

    const n = w.rpc.count("eth_blockNumber");
    jest.advanceTimersByTime(3_600_000); // the sweep timer and the next accrue never tick
    await settle();
    expect(w.rpc.count("eth_blockNumber")).toBe(n);
    expect(ticks(keeper)).toEqual(["accrue"]);
  });

  test("SIGTERM between ticks: the armed loop timers fire into nothing", async () => {
    jest.useFakeTimers();
    const w = world();
    const { keeper } = await start(w, { STARTUP_DELAY_MS: "0" });
    jest.advanceTimersByTime(0);
    await until(() => keeper.history.length === 1, "the first accrue tick");
    signal("SIGTERM");
    await until(() => exits.length === 1, "exit");
    const n = w.rpc.count("eth_blockNumber");
    await advance(61_000); // the sweep (t = 15 s) and the next accrue (t = 60 s) timers fire
    expect(w.rpc.count("eth_blockNumber")).toBe(n);
    expect(ticks(keeper)).toEqual(["accrue"]);
  });

  test("SIGINT during the startup delay: nothing to drain, exit 0, and the first tick never runs", async () => {
    jest.useFakeTimers();
    const w = world();
    await start(w);
    signal("SIGINT");
    await until(() => exits.length === 1, "exit");
    expect(exits).toEqual([0]);
    expect(logs.has("[keeper] SIGINT: no new ticks; draining the one in flight")).toBe(true);
    jest.advanceTimersByTime(200_000);
    await settle();
    expect(w.rpc.count("eth_blockNumber")).toBe(0);
  });
});

describe("over HTTP (the production transport)", () => {
  test("a Keeper with no transport reaches RPC_URL with batched JSON-RPC and sends the same accrueBatch", async () => {
    const w = world();
    const node = w.rpc.serve();
    stops.push(node.stop);
    const k = new Keeper(loadConfig(keeperEnv({ RPC_URL: node.url })), BOOK);
    await k.accrueTick();
    expect((w.rpc.sent[0]!.args[0] as Entry[])[0]).toEqual({ account: A, wallet: W1, amount: usd(0.7), toBlock: 199_880n });
    expect(Math.max(...w.rpc.httpPosts)).toBeGreaterThan(1); // concurrent reads went out as one JSON-RPC batch
  });

  test("`bun run src/keeper/run.ts` (the image's CMD) starts the keeper on the process env", async () => {
    const w = world();
    const node = w.rpc.serve();
    stops.push(node.stop);
    const port = freePort();
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" };
    Object.assign(env, keeperEnv(), { RPC_URL: node.url, ADDRESSES_JSON: JSON.stringify(BOOK_JSON), PORT: String(port), STARTUP_DELAY_MS: "3600000" });
    const proc = Bun.spawn([process.execPath, "run", "src/keeper/run.ts"], { cwd: resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" });
    stops.push(() => proc.kill());
    let out = "";
    const reader = proc.stdout.getReader();
    while (!out.includes("health on")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`keeper exited: ${out}${await new Response(proc.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain(`[keeper] chain 4663; keeper ${KEEPER}; executor ${BOOK.sweepExecutor}; broadcast ON; eth 1`);
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ ok: true, started: false, uptimeSec: expect.any(Number), recent: [] });
    expect(w.rpc.requests.map((r) => r.method)).toEqual(["eth_getCode", "eth_chainId", "eth_getBalance"]);
  });

  test("startKeeper with no transport checks the node over HTTP before anything starts", async () => {
    const w = world();
    const node = w.rpc.serve();
    stops.push(node.stop);
    const { server } = await startKeeper({ ...keeperEnv(), RPC_URL: node.url, ADDRESSES_JSON: JSON.stringify(BOOK_JSON), STARTUP_DELAY_MS: "3600000" });
    expect(server).toBeUndefined();
    expect(w.rpc.requests.map((r) => r.method)).toEqual(["eth_getCode", "eth_chainId", "eth_getBalance"]);
    signal("SIGTERM");
    await until(() => exits.length === 1, "exit");
  });
});
