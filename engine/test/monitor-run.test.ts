/**
 * The monitor entrypoint (run.ts startMonitor): env refused before anything
 * starts, the chain-id check at boot, /health from the first poll, an RPC
 * outage at boot that the loop recovers from, a graceful SIGTERM that
 * finishes the poll in flight, the --once and --test-alert modes, and the
 * image's start command over HTTP. Loop timers are Bun's fake timers; the
 * chain is the fake RPC (custom transport, and once over HTTP).
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { startMonitor } from "../src/monitor/run.ts";
import { rpcError } from "./helpers/fake-rpc.ts";
import { BOOK, BOOK_JSON, captureLogs, KEEPER, SpareWorld } from "./helpers/fake-rpc-spare.ts";

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

const added = (event: (typeof EVENTS)[number]) => process.listeners(event).filter((l) => !before[event]!.includes(l)) as ((...a: unknown[]) => void)[];
const signal = (event: "SIGTERM" | "SIGINT") => added(event).forEach((l) => l(event));

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 2_000; i++) await Promise.resolve();
}
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50_000; i++) {
    if (cond()) return settle();
    await Promise.resolve();
    if (i % 500 === 499) await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** The structured log lines (Dispatcher.log writes JSON to stdout). */
const lines = () => logs.lines.flatMap((l) => (l.startsWith("{") ? [JSON.parse(l) as { level: string; msg: string } & Record<string, unknown>] : []));
const logged = (msg: string) => lines().some((l) => l.msg === msg);

/** Monitor env on the fake chain: the test book, no hook pins, quick confirmations. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ADDRESSES_JSON: JSON.stringify(BOOK_JSON), HOOK_PINS: "[]", CONFIRMATIONS: "0", LOOKBACK_BLOCKS: "1000", ...extra };
}
async function start(w: SpareWorld, extra: Record<string, string> = {}, argv: string[] = []) {
  const port = freePort();
  const r = await startMonitor(env({ PORT: String(port), ...extra }), argv, w.rpc.transport());
  if (r.server) stops.push(() => r.server!.stop(true));
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as Record<string, unknown>) : await res.text() };
  };
  return { ...r, port, get };
}

describe("configuration", () => {
  test("a bad environment is refused before anything starts: no listener, no server, no RPC call", async () => {
    const w = new SpareWorld();
    const bad: [Record<string, string>, string | RegExp][] = [
      [{ TELEGRAM_BOT_TOKEN: "1234567890:abcdef" }, "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together"],
      [{ POLL_MS: "1000" }, /POLL_MS|5000/],
      [{ KEEPER_MIN_ETH: "lots" }, "must be a decimal ETH amount"],
      [{ OWNER_ADDRESS: "0x1234" }, "must be a 0x address"],
      [{ ADDRESSES_JSON: "", ADDRESSES_FILE: "/nowhere/4663.json" }, "no address book at"],
      [{ HOOK_PINS: "{" }, "HOOK_PINS"],
    ];
    for (const [extra, why] of bad) await expect(startMonitor(env(extra), [], w.rpc.transport())).rejects.toThrow(why);
    expect(added("SIGTERM")).toHaveLength(0);
    expect(w.rpc.requests).toEqual([]);
  });

  test("an RPC on another chain stops it at boot, in loop mode too; the RPC URL never reaches the error", async () => {
    const w = new SpareWorld();
    w.rpc.chainId = 1;
    await expect(startMonitor(env({ RPC_URL: "https://rpc.example/v2/SECRETKEY" }), [], w.rpc.transport())).rejects.toThrow("RPC is chain 1, monitor expects 4663");
    expect(added("SIGTERM")).toHaveLength(0);
    expect(logs.lines.join("\n")).not.toContain("SECRETKEY");
    expect(lines().find((l) => l.msg === "monitor starting")).toMatchObject({ mode: "loop", rpc: "custom RPC_URL", chainId: 4663 });
  });
});

describe("loop mode", () => {
  test("/health from the first poll (200 while catching up, ?strict=1 says 503 when not ok); anything else is 404", async () => {
    jest.useFakeTimers();
    const w = new SpareWorld();
    const { get, monitor, port } = await start(w);
    expect(logged(`health on :${port}/health`)).toBe(true);
    await until(() => monitor.health().lastPollOkAt !== null, "the first poll");
    const h = await get("/health?strict=1");
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ ok: true, chainId: 4663, head: String(w.rpc.head), cursor: String(w.rpc.head), firing: [] });
    expect((await get("/")).status).toBe(200);
    expect(await get("/metrics")).toEqual({ status: 404, body: "not found" });

    // The RPC fails: the next poll is not ok; the hosting platform's plain probe still gets 200.
    w.rpc.use((method) => {
      if (method === "eth_blockNumber") throw rpcError(-32000, "upstream unavailable");
    });
    jest.advanceTimersByTime(30_000);
    await until(() => monitor.health().rpcFailingSince !== null, "the failing poll");
    expect((await get("/health?strict=1")).status).toBe(503);
    expect(await get("/health")).toMatchObject({ status: 200, body: { ok: false } });
  });

  test("an RPC outage at boot is not fatal: logged, and the loop's next poll runs init", async () => {
    jest.useFakeTimers();
    const w = new SpareWorld();
    let down = true;
    w.rpc.use((method) => {
      if (down && method === "eth_chainId") throw rpcError(-32000, "upstream unavailable");
    });
    const { monitor } = await start(w);
    expect(logged("init failed; poll will retry it")).toBe(true);
    await settle();
    expect(monitor.health().ok).toBe(false);
    down = false;
    jest.advanceTimersByTime(30_000);
    await until(() => monitor.health().ok, "a poll after the outage");
    expect(logs.lines.some((l) => l.includes("starting without saved state"))).toBe(true);
  });

  test("polls every POLL_MS; SIGTERM finishes the poll in flight, flushes, exits 0, and no poll follows", async () => {
    jest.useFakeTimers();
    const w = new SpareWorld();
    const { monitor } = await start(w, { POLL_MS: "60000" });
    await until(() => monitor.health().lastPollOkAt !== null, "the first poll");
    const polls = () => w.rpc.count("eth_blockNumber");
    const n = polls();
    jest.advanceTimersByTime(59_999);
    await settle();
    expect(polls()).toBe(n);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let armed = true;
    w.rpc.use(async (method) => {
      if (armed && method === "eth_blockNumber") {
        armed = false;
        await held;
      }
    });
    jest.advanceTimersByTime(1);
    await until(() => !armed, "the second poll to reach the RPC");
    signal("SIGTERM");
    expect(logged("SIGTERM: finishing the poll in flight")).toBe(true);
    signal("SIGINT"); // already stopping
    expect(lines().filter((l) => /finishing the poll in flight/.test(l.msg))).toHaveLength(1);
    jest.advanceTimersByTime(1_000);
    await settle();
    expect(exits).toEqual([]);

    release();
    for (let i = 0; i < 20 && exits.length === 0; i++) {
      jest.advanceTimersByTime(200);
      await settle();
    }
    expect(exits).toEqual([0]);
    const after = polls();
    jest.advanceTimersByTime(3_600_000);
    await settle();
    expect(polls()).toBe(after);
  });

  test("an unhandled rejection is logged, not fatal", async () => {
    jest.useFakeTimers();
    await start(new SpareWorld());
    added("unhandledRejection").forEach((l) => l(new Error("socket hang up")));
    expect(lines().find((l) => l.msg === "unhandled rejection")).toMatchObject({ level: "warn", error: "socket hang up" });
    expect(exits).toEqual([]);
  });
});

describe("--once and --test-alert", () => {
  test("--once catches up to head, runs every check, logs a summary and exits 0; no server, no loop", async () => {
    const w = new SpareWorld();
    const { server } = await startMonitor(env({ START_BLOCK: String(w.rpc.head - 500n), PORT: String(freePort()), KEEPER_ADDRESS: KEEPER }), ["--once"], w.rpc.transport());
    expect(server).toBeUndefined();
    expect(exits).toEqual([0]);
    const done = lines().find((l) => l.msg === "once: done") as { polls: number; health: { cursor: string } } | undefined;
    expect(done?.health.cursor).toBe(String(w.rpc.head));
    expect(w.rpc.requests.filter((r) => r.method === "eth_getBalance").map((r) => r.params[0])).toEqual([KEEPER]); // the checks ran
    expect(added("SIGTERM")).toHaveLength(0);
  });

  test("--once refuses a failing RPC instead of reporting a partial pass", async () => {
    const w = new SpareWorld();
    w.rpc.use((method) => {
      if (method === "eth_getLogs") throw rpcError(-32000, "upstream unavailable");
    });
    await expect(startMonitor(env(), ["--once"], w.rpc.transport())).rejects.toThrow(/^poll failed at cursor \d+: /);
    expect(exits).toEqual([]);
  });

  test("--test-alert: refused with no sink; delivered to a webhook that takes it; an error when the sink refuses", async () => {
    const w = new SpareWorld();
    await expect(startMonitor(env(), ["--test-alert"], w.rpc.transport())).rejects.toThrow("no sink configured");

    const got: string[] = [];
    let status = 200;
    const hook = Bun.serve({ port: 0, fetch: async (req) => (got.push(((await req.json()) as { text: string }).text), new Response("", { status })) });
    stops.push(() => hook.stop(true));
    const url = `http://127.0.0.1:${hook.port}/hook/SECRET`;
    await startMonitor(env({ ALERT_WEBHOOK_URL: url }), ["--test-alert"], w.rpc.transport());
    expect(exits).toEqual([0]);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("[CRITICAL] test alert: routing works");
    expect(lines().find((l) => l.msg === "test alert delivered")).toMatchObject({ sinks: ["webhook"] });
    expect(w.rpc.requests).toEqual([]); // the chain is not touched

    status = 500;
    await expect(startMonitor(env({ ALERT_WEBHOOK_URL: url }), ["--test-alert"], w.rpc.transport())).rejects.toThrow("not delivered to: webhook");
    expect(logs.lines.join("\n")).not.toContain("SECRET");
  });
});

describe("over HTTP (the image's start command)", () => {
  test("`bun run src/monitor/run.ts` starts on the process env with the built-in hook pins, and serves /health", async () => {
    const w = new SpareWorld();
    const node = w.rpc.serve();
    stops.push(node.stop);
    const port = freePort();
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" };
    Object.assign(childEnv, { RPC_URL: node.url, ADDRESSES_JSON: JSON.stringify(BOOK_JSON), PORT: String(port), CONFIRMATIONS: "0", LOOKBACK_BLOCKS: "1000" });
    const proc = Bun.spawn([process.execPath, "run", "src/monitor/run.ts"], { cwd: resolve(import.meta.dir, ".."), env: childEnv, stdout: "pipe", stderr: "pipe" });
    stops.push(() => proc.kill());
    let out = "";
    const reader = proc.stdout.getReader();
    while (!out.includes("health on")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`monitor exited: ${out}${await new Response(proc.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    const starting = out.split("\n").map((l) => (l.startsWith("{") ? JSON.parse(l) : null)).find((l) => l?.msg === "monitor starting");
    expect(starting).toMatchObject({ chainId: 4663, mode: "loop", rpc: "custom RPC_URL" });
    expect(starting.contracts).toContain(`SweepExecutor ${BOOK.sweepExecutor}`);
    expect(starting.contracts).toContain("Hook MU 0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080");
    expect(out).not.toContain(node.url);
    const h = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>;
    expect(h).toMatchObject({ chainId: 4663 });
  });
});
