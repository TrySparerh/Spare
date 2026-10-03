/**
 * The monitor against an in-memory chain behind a viem `custom` transport:
 * real ABI encoding of logs and calls (Multicall3 included), so decoding,
 * cursoring, dedupe, balances, liveness and RPC-failure handling are all
 * exercised through the same viem client code paths production uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  keccak256,
  multicall3Abi,
  numberToHex,
  toEventSelector,
  toHex,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type AbiParameter,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { permit2Abi } from "../src/chain/abis.ts";
import { MULTICALL3, PERMIT2, USDG } from "../src/chain/constants.ts";
import type { Alert } from "../src/monitor/alerts.ts";
import { loadMonitorConfig, parseMonitorBook, withRoleOverrides, type MonitorBook, type MonitorConfig } from "../src/monitor/config.ts";
import { ChainMismatchError, Monitor } from "../src/monitor/monitor.ts";
import { Dispatcher, type Sink } from "../src/monitor/sinks.ts";
import { DEFAULT_HOOK_PINS, fablesHookAbi } from "../src/keeper/hooks.ts";
import {
  ACCESS_MANAGER_ABI,
  AUTH_CONTRACTS,
  CONTRACT_ABIS,
  HOOK_EVENTS_ABI,
  hookAuthorityContracts,
  hookContracts,
  TIMELOCK_ABI,
  TIMELOCK_WATCH,
  WATCH,
  type BookKey,
} from "../src/monitor/watch.ts";

const addr = (tag: string, i: number) => getAddress(`0x${tag.repeat(19)}${i.toString(16).padStart(2, "0")}`);
const KEYS: BookKey[] = [
  "assetRegistry",
  "ruleRegistry",
  "electionRegistry",
  "screeningGate",
  "stockRouter",
  "cashPark",
  "feeVault",
  "sweepExecutor",
  "usdgParkAdapter",
  "sgovParkAdapter",
];
const C = Object.fromEntries(KEYS.map((k, i) => [k, addr("c1", i)])) as Record<BookKey, Address>;
const OWNER = addr("0a", 1);
const KEEPER = addr("0b", 2);
const ATTACKER = addr("ee", 3);
const TOKEN = addr("70", 4);
const ACCOUNT = addr("ac", 5);
const WALLET = addr("aa", 6);
const TIMELOCK = addr("71", 7);
const RPC_SECRET = "https://rpc.example/v2/SUPERSECRETKEY";
const DEPLOY = 1_000n;

// Wed 2026-09-30 15:00 UTC: inside the 24/5 equity session. Sat 2026-10-03: closed.
const WEDNESDAY = Date.UTC(2026, 8, 30, 15);
const SATURDAY = Date.UTC(2026, 9, 3, 15);
const MIN = 60_000;

type RpcLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex; blockHash: Hex; transactionIndex: Hex; removed: boolean };

class FakeChain {
  head = 2_000_000n;
  logs: RpcLog[] = [];
  balances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  reads = new Map<string, (args: readonly unknown[]) => unknown>();
  abis = new Map<string, Abi>();
  down = false;
  /** Provider range cap, Alchemy-style message. */
  maxRange: bigint | null = null;
  getLogsCalls: { from: bigint; to: bigint; addresses: string[]; topic1?: Hex[] }[] = [];
  /** Return every matching log twice (a misbehaving provider). */
  duplicate = false;
  /** Fail a Multicall3 eth_call at the RPC (a 429, a timeout) when this says so for its calls. */
  multicallFails: (calls: readonly { target: Address; callData: Hex }[]) => boolean = () => false;
  chainId = 4663;

  constructor() {
    for (const k of KEYS) this.abis.set(C[k].toLowerCase(), CONTRACT_ABIS[k]);
    this.abis.set(USDG.toLowerCase(), erc20Abi as Abi);
    this.abis.set(PERMIT2.toLowerCase(), permit2Abi as Abi);
    this.abis.set(TOKEN.toLowerCase(), erc20Abi as Abi);
    this.read(TOKEN, "symbol", () => "NVDA");
    // The live wiring, matching the book.
    for (const k of AUTH_CONTRACTS) {
      this.read(C[k], "owner", () => OWNER);
      this.read(C[k], "pendingOwner", () => zeroAddress);
      this.read(C[k], "paused", () => false);
      this.read(C[k], "pauser", () => OWNER);
    }
    this.read(C.cashPark, "executor", () => C.sweepExecutor);
    this.read(C.cashPark, "adapter", () => C.usdgParkAdapter);
    this.read(C.cashPark, "isKeeper", ([a]) => a === KEEPER);
    this.read(C.sweepExecutor, "isKeeper", ([a]) => a === KEEPER);
    this.read(C.stockRouter, "isCaller", ([a]) => a === C.sweepExecutor);
    this.read(C.screeningGate, "attestor", () => OWNER);
    this.read(C.screeningGate, "enforced", () => false);
    this.balances.set(KEEPER.toLowerCase(), 10n ** 16n);
    this.balances.set(OWNER.toLowerCase(), 10n ** 16n);
  }

  read(address: Address, fn: string, h: (args: readonly unknown[]) => unknown) {
    this.reads.set(`${address.toLowerCase()}:${fn}`, h);
  }

  emit(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, block: bigint, logIndex = 0): RpcLog {
    const item = abi.find((x): x is AbiEvent => x.type === "event" && x.name === eventName)!;
    const topics = encodeEventTopics({ abi: [item], eventName, args: args as never }) as Hex[];
    const plain = item.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain as AbiParameter[], plain.map((i) => args[i.name!]));
    const log: RpcLog = {
      address,
      topics,
      data,
      blockNumber: numberToHex(block),
      logIndex: numberToHex(logIndex),
      transactionHash: keccak256(toHex(`${address}:${block}:${logIndex}`)),
      blockHash: keccak256(toHex(`block:${block}`)),
      transactionIndex: "0x0",
      removed: false,
    };
    this.logs.push(log);
    return log;
  }

  private call(to: string, data: Hex): { ok: boolean; data: Hex } {
    const abi = this.abis.get(to.toLowerCase());
    if (!abi) return { ok: false, data: "0x" };
    try {
      const d = decodeFunctionData({ abi, data });
      const h = this.reads.get(`${to.toLowerCase()}:${d.functionName}`);
      if (!h) return { ok: false, data: "0x" };
      return { ok: true, data: encodeFunctionResult({ abi, functionName: d.functionName, result: h(d.args ?? []) } as never) };
    } catch {
      return { ok: false, data: "0x" };
    }
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    if (this.down) throw new Error(`HTTP request failed. URL: ${RPC_SECRET}`);
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(this.chainId);
      case "eth_blockNumber":
        return numberToHex(this.head);
      case "eth_getBalance":
        return numberToHex(this.balances.get(String(p[0]).toLowerCase()) ?? 0n);
      case "eth_getTransactionCount":
        return numberToHex(this.nonces.get(String(p[0]).toLowerCase()) ?? 0);
      case "eth_getBlockByNumber": {
        const n = BigInt(p[0] as string);
        return { number: numberToHex(n), hash: keccak256(toHex(`block:${n}`)), timestamp: numberToHex(BigInt(this.blockTime(n))), transactions: [] };
      }
      case "eth_getLogs": {
        const f = p[0] as { address: string[] | string; topics?: (Hex[] | Hex | null)[]; fromBlock: Hex; toBlock: Hex };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        const addresses = (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase());
        const t1 = f.topics?.[1];
        const topic1 = t1 === null || t1 === undefined ? undefined : Array.isArray(t1) ? t1 : [t1];
        this.getLogsCalls.push({ from, to, addresses, ...(topic1 ? { topic1 } : {}) });
        if (this.maxRange !== null && to - from + 1n > this.maxRange) {
          throw new Error(`query spans ${to - from + 1n} blocks, but only ${this.maxRange} are allowed for this request; narrow the block range`);
        }
        const t0 = f.topics?.[0];
        const want = t0 === null || t0 === undefined ? null : new Set((Array.isArray(t0) ? t0 : [t0]).map((t) => t.toLowerCase()));
        const hits = this.logs.filter((l) => {
          const b = BigInt(l.blockNumber);
          return (
            b >= from &&
            b <= to &&
            addresses.includes(l.address.toLowerCase()) &&
            (!want || want.has(l.topics[0]!.toLowerCase())) &&
            (!topic1 || topic1.some((t) => t.toLowerCase() === l.topics[1]?.toLowerCase()))
          );
        });
        return this.duplicate ? [...hits, ...hits] : hits;
      }
      case "eth_call": {
        const c = p[0] as { to: string; data: Hex };
        if (c.to.toLowerCase() === MULTICALL3.toLowerCase()) {
          const d = decodeFunctionData({ abi: multicall3Abi, data: c.data });
          const calls = d.args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
          if (this.multicallFails(calls)) throw new Error("HTTP request failed. Status: 429. Details: Too Many Requests");
          const results = calls.map((x) => {
            const r = this.call(x.target, x.callData);
            return { success: r.ok, returnData: r.data };
          });
          return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
        }
        const r = this.call(c.to, c.data);
        if (!r.ok) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        return r.data;
      }
      default:
        throw new Error(`fake chain: ${method} not implemented`);
    }
  }

  blockTime(n: bigint): number {
    // ~0.1s blocks; block 2,000,000 lands on WEDNESDAY.
    return Math.floor(WEDNESDAY / 1000) + Math.floor(Number(n - 2_000_000n) / 10);
  }
}

const BOOK_JSON = {
  chainId: 4663,
  startBlock: Number(DEPLOY),
  contracts: Object.fromEntries(KEYS.map((k) => [k[0]!.toUpperCase() + k.slice(1), C[k]])),
  roles: { owner: OWNER, keeper: KEEPER, pauser: OWNER, attestor: OWNER },
  parkAdapter: { live: "UsdgParkAdapter", standby: "SgovParkAdapter" },
  screeningEnforced: false,
};

interface Rig {
  chain: FakeChain;
  monitor: Monitor;
  clock: { t: number };
  logs: string[];
  pushed: string[];
  cfg: MonitorConfig;
  book: MonitorBook;
}

function rig(env: Record<string, string> = {}, chain = new FakeChain(), clock = { t: WEDNESDAY }): Rig {
  // No hooked pools unless a test pins some (the "hooked pools" tests below).
  const cfg = loadMonitorConfig({ RPC_URL: RPC_SECRET, CONFIRMATIONS: "0", LOOKBACK_BLOCKS: "1000", HOOK_PINS: "[]", ...env });
  const book = withRoleOverrides(parseMonitorBook(BOOK_JSON, 4663), cfg);
  const vchain = defineChain({
    id: 4663,
    name: "fake",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://fake"] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const client = createPublicClient({ chain: vchain, transport: custom({ request: (a) => chain.request(a) }, { retryCount: 0 }) }) as PublicClient;
  const logs: string[] = [];
  const pushed: string[] = [];
  const sink: Sink = { name: "test", maxChars: 100_000, send: async (t) => void pushed.push(t) };
  const dispatcher = new Dispatcher({
    sinks: [sink],
    maxPerMinute: 60,
    secrets: [RPC_SECRET],
    explorer: cfg.EXPLORER_URL,
    header: "test",
    now: () => clock.t,
    write: (l) => logs.push(l),
  });
  const monitor = new Monitor({ cfg, book, client, dispatcher, now: () => clock.t, sleep: async () => {} });
  return { chain, monitor, clock, logs, pushed, cfg, book };
}

const events = (alerts: Alert[]) => alerts.filter((a) => a.key.startsWith("ev:"));
const conds = (alerts: Alert[], name?: string) => alerts.filter((a) => a.key.startsWith("cond:") && (!name || a.name === name));

/** A value of the right ABI type for any watched event's input. */
function sample(p: AbiParameter, i: number): unknown {
  if (p.type === "address") return p.name === "token" || p.name === "asset" ? TOKEN : addr("5a", i + 10);
  if (p.type === "bool") return true;
  if (p.type === "bytes32") return `0x${(i + 1).toString(16).padStart(64, "0")}`;
  if (p.type === "bytes") return "0x1234";
  if (p.type === "tuple[]") return [{ asset: TOKEN, bps: 10_000 }];
  if (p.type.startsWith("uint")) return BigInt(i + 1) * (p.type === "uint8" ? 1n : 3_600n);
  throw new Error(`no sample for ${p.type}`);
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spare-monitor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("monitor: privileged events", () => {
  test("every privileged and operational event on every contract (and the timelock) yields exactly one alert", async () => {
    const r = rig({ TIMELOCK_ADDRESS: TIMELOCK });
    r.chain.abis.set(TIMELOCK.toLowerCase(), TIMELOCK_ABI as unknown as Abi);
    let block = r.chain.head - 900n;
    const expected: string[] = [];
    const tables: [Address, Abi, (typeof WATCH)[BookKey]][] = [
      ...KEYS.map((k) => [C[k], CONTRACT_ABIS[k], WATCH[k]] as [Address, Abi, (typeof WATCH)[BookKey]]),
      [TIMELOCK, TIMELOCK_ABI as unknown as Abi, TIMELOCK_WATCH],
    ];
    for (const [address, abi, w] of tables) {
      for (const name of [...Object.keys(w.privileged), ...Object.keys(w.operational)]) {
        const item = abi.find((x): x is AbiEvent => x.type === "event" && x.name === name)!;
        const args = Object.fromEntries(item.inputs.map((p, i) => [p.name!, sample(p, i)]));
        r.chain.emit(address, abi, name, args, block++);
        expected.push(name);
      }
    }
    // Activity: logged, never alerted.
    r.chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "Accrued", { account: ACCOUNT, wallet: WALLET, amount: 1n, fromBlock: 1n, toBlock: 2n }, block++);
    r.chain.emit(C.cashPark, CONTRACT_ABIS.cashPark, "Parked", { usdgIn: 1n, unitsOut: 1n, accounts: 1n }, block++);
    expect(expected.length).toBeGreaterThan(45);

    const rep = await r.monitor.poll();
    const ev = events(rep.alerts);
    expect(ev.map((a) => a.name).sort()).toEqual([...expected].sort());
    expect(new Set(ev.map((a) => a.key)).size).toBe(ev.length);
    expect(conds(rep.alerts)).toEqual([]); // the wiring and balances match the book
    for (const a of ev) {
      expect(a.push).toBe(true);
      expect(a.lines.some((l) => l.startsWith("https://robinhoodchain.blockscout.com/tx/0x"))).toBe(true);
    }
    // A token symbol is resolved through Multicall3.
    expect(ev.find((a) => a.name === "AssetActive")!.title).toBe("AssetRegistry: NVDA ACTIVATED");
    // Nothing new: nothing alerted.
    r.chain.head += 50n;
    expect(events((await r.monitor.poll()).alerts)).toEqual([]);
  });

  test("severity tells the routine from the hostile", async () => {
    const r = rig();
    const b = r.chain.head - 100n;
    const cp = CONTRACT_ABIS.cashPark;
    r.chain.emit(C.cashPark, cp, "ExecutorSet", { executor: C.sweepExecutor }, b);
    r.chain.emit(C.cashPark, cp, "ExecutorSet", { executor: ATTACKER }, b + 1n);
    r.chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "KeeperSet", { keeper: KEEPER, enabled: true }, b + 2n);
    r.chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "KeeperSet", { keeper: ATTACKER, enabled: true }, b + 3n);
    r.chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "OwnershipTransferred", { previousOwner: zeroAddress, newOwner: OWNER }, b + 4n);
    r.chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "OwnershipTransferStarted", { previousOwner: OWNER, newOwner: ATTACKER }, b + 5n);
    r.chain.emit(C.stockRouter, CONTRACT_ABIS.stockRouter, "CallerSet", { caller: ATTACKER, enabled: true }, b + 6n);
    r.chain.emit(C.cashPark, cp, "Paused", { by: OWNER }, b + 7n);
    const ev = events((await r.monitor.poll()).alerts);
    expect(ev.map((a) => `${a.name}:${a.severity}`)).toEqual([
      "ExecutorSet:warning",
      "ExecutorSet:critical",
      "KeeperSet:warning",
      "KeeperSet:critical",
      "OwnershipTransferred:info",
      "OwnershipTransferStarted:critical",
      "CallerSet:critical",
      "Paused:critical",
    ]);
    expect(ev[1]!.title).toContain(ATTACKER);
    expect(ev[2]!.title).toContain("(keeper)");
  });

  test("a timelock call is decoded against the Spare ABIs", async () => {
    const r = rig({ TIMELOCK_ADDRESS: TIMELOCK });
    r.chain.abis.set(TIMELOCK.toLowerCase(), TIMELOCK_ABI as unknown as Abi);
    const data = encodeFunctionData({ abi: CONTRACT_ABIS.cashPark, functionName: "setExecutor", args: [ATTACKER] });
    r.chain.emit(
      TIMELOCK,
      TIMELOCK_ABI as unknown as Abi,
      "CallScheduled",
      { id: `0x${"ab".repeat(32)}`, index: 0n, target: C.cashPark, value: 0n, data, predecessor: `0x${"00".repeat(32)}`, delay: 172_800n },
      r.chain.head - 10n,
    );
    const [a] = events((await r.monitor.poll()).alerts);
    expect(a!.severity).toBe("critical");
    expect(a!.title).toBe("Timelock: call SCHEDULED, executable in 48h");
    expect(a!.lines[0]).toBe(`CashPark.setExecutor(${ATTACKER})`);
  });
});

describe("monitor: dedupe and cursoring", () => {
  test("a provider returning a log twice still yields one alert", async () => {
    const r = rig();
    r.chain.duplicate = true;
    r.chain.emit(C.cashPark, CONTRACT_ABIS.cashPark, "ExecutorSet", { executor: ATTACKER }, r.chain.head - 5n);
    expect(events((await r.monitor.poll()).alerts).length).toBe(1);
  });

  test("bounded, contiguous getLogs ranges; a provider range cap halves the step and leaves no gap", async () => {
    const r = rig({ LOGS_RANGE: "1000", MAX_CHUNKS_PER_POLL: "3", START_BLOCK: String(2_000_000n - 9_999n), DISCOVERY_CHUNKS_PER_POLL: "10000" });
    r.chain.maxRange = 400n;
    r.chain.emit(C.feeVault, CONTRACT_ABIS.feeVault, "Withdrawn", { token: USDG, to: ATTACKER, amount: 5n }, 1_999_000n);
    const first = await r.monitor.poll();
    expect(first.caughtUp).toBe(false); // 3 chunks per poll
    let polls = 1;
    let rep = first;
    const all = [...first.alerts];
    while (!rep.caughtUp) {
      rep = await r.monitor.poll();
      all.push(...rep.alerts);
      if (++polls > 100) throw new Error("never caught up");
    }
    const scans = r.chain.getLogsCalls.filter((c) => c.addresses.length > 1 && c.to - c.from + 1n <= 400n).sort((a, b) => (a.from < b.from ? -1 : 1));
    for (const c of r.chain.getLogsCalls) expect(c.to - c.from + 1n).toBeLessThanOrEqual(1000n);
    expect(scans[0]!.from).toBe(2_000_000n - 9_999n);
    for (let i = 1; i < scans.length; i++) expect(scans[i]!.from).toBe(scans[i - 1]!.to + 1n);
    expect(scans[scans.length - 1]!.to).toBe(2_000_000n);
    expect(events(all).map((a) => a.name)).toEqual(["Withdrawn"]);
  });

  test("a start without state pushes only recent events; older ones are logged as history", async () => {
    // LOOKBACK 1000: events below head - 1000 are history even when START_BLOCK reaches them.
    const r = rig({ START_BLOCK: String(2_000_000n - 5_000n) });
    r.chain.emit(C.cashPark, CONTRACT_ABIS.cashPark, "ExecutorSet", { executor: ATTACKER }, 2_000_000n - 4_000n);
    r.chain.emit(C.cashPark, CONTRACT_ABIS.cashPark, "AdapterSet", { adapter: ATTACKER }, 2_000_000n - 10n);
    const ev = events((await r.monitor.poll()).alerts);
    expect(ev.map((a) => [a.name, a.push])).toEqual([
      ["ExecutorSet", false],
      ["AdapterSet", true],
    ]);
    expect(r.pushed.join("\n")).not.toContain("executor set");
    expect(r.pushed.join("\n")).toContain("park adapter set");
    expect(r.logs.some((l) => l.includes("executor set") && l.includes('"pushed":false'))).toBe(true);
  });

  test("restart with STATE_FILE resumes at cursor + 1: nothing repeats, the downtime gap is alerted", async () => {
    const state = join(dir, "state.json");
    const chain = new FakeChain();
    chain.emit(C.cashPark, CONTRACT_ABIS.cashPark, "ExecutorSet", { executor: ATTACKER }, chain.head - 10n);
    chain.balances.set(KEEPER.toLowerCase(), 1n); // a condition that must not re-fire either
    const a = rig({ STATE_FILE: state }, chain);
    const r1 = await a.monitor.poll();
    expect(events(r1.alerts).length).toBe(1);
    expect(conds(r1.alerts, "balance.keeper").length).toBe(1);

    // Down for a while; an event lands in the gap.
    chain.head += 5_000n;
    chain.emit(C.stockRouter, CONTRACT_ABIS.stockRouter, "CallerSet", { caller: ATTACKER, enabled: true }, chain.head - 4_000n);
    const b = rig({ STATE_FILE: state }, chain, { t: WEDNESDAY + 10 * MIN });
    const r2 = await b.monitor.poll();
    expect(events(r2.alerts).map((x) => [x.name, x.push])).toEqual([["CallerSet", true]]);
    expect(conds(r2.alerts)).toEqual([]);
    // The second process scanned from exactly where the first stopped.
    expect(chain.getLogsCalls.filter((c) => c.addresses.length > 1).at(-1)?.from).toBe(2_000_001n);
  });
});

describe("monitor: hooked pools (A-L3)", () => {
  const RWA = addr("5e", 8);
  const RAMP = addr("08", 9);
  const AUTHORITY = addr("a3", 10);
  const MU_TOKEN = addr("ff", 11); // above USDG: the keeper's swaps are 0->1
  const GME_TOKEN = addr("1b", 12); // below USDG: 1->0
  const MU_ID = `0x${"11".repeat(32)}` as Hex;
  const GME_ID = `0x${"22".repeat(32)}` as Hex;
  const OTHER_ID = `0x${"33".repeat(32)}` as Hex;
  const PINS = [
    { symbol: "MU", token: MU_TOKEN, hook: RWA, poolId: MU_ID, hookCodehash: `0x${"ab".repeat(32)}`, hookAuthority: AUTHORITY, hookFeeCap: 50_000, hookMaxFeePips: 4_000 },
    { symbol: "GME", token: GME_TOKEN, hook: RAMP, poolId: GME_ID, hookCodehash: `0x${"cd".repeat(32)}`, hookAuthority: AUTHORITY, hookFeeCap: 20_000, hookMaxFeePips: 500 },
  ];
  const HOOK_ABI = [...HOOK_EVENTS_ABI, ...fablesHookAbi] as unknown as Abi;
  const RAMP_CONFIGURED = [HOOK_EVENTS_ABI[8]] as unknown as Abi; // FablesRamp's PoolConfigured (FablesRWA's has the same name)

  function hookRig(env: Record<string, string> = {}) {
    const r = rig({ HOOK_PINS: JSON.stringify(PINS), CHECK_EVERY_MS: "60000", ...env });
    for (const h of [RWA, RAMP]) {
      r.chain.abis.set(h.toLowerCase(), HOOK_ABI);
      r.chain.read(h, "authority", () => AUTHORITY);
      r.chain.read(h, "maxFee", ([id]) => (id === MU_ID ? 50_000 : id === GME_ID ? 20_000 : 0));
    }
    return r;
  }

  test("the verified sources' event signatures (topic0, as `cast sig-event` computes them)", () => {
    expect(HOOK_EVENTS_ABI.map((e) => `${e.name} ${toEventSelector(e)}`)).toEqual([
      "FeePoked 0x3b158a8283be40bf4eb77d5d4ede4264472c14a6904cf6161876e3e32c98ce28",
      "PokeCleared 0xb8fae5f44b3e1ea6cb10a6d677d5a9441301da4f60509c3ecccf8c67d34a50cb",
      "PoolAsymmetrySet 0x36922399b38aaeb027c5fb2231292adf37f11b1eabe65fccbc495b366247c250",
      "PoolConfigured 0x2e9273ab7229fcfc198610765943b0b1e1c7ad733c971f27143736d7e210dd2d",
      `DayOverridesSet ${toEventSelector("DayOverridesSet(bytes32,uint256,uint64)")}`,
      `SessionHoursSet ${toEventSelector("SessionHoursSet(bytes32,uint32,uint32)")}`,
      `DstModeSet ${toEventSelector("DstModeSet(bytes32,uint8)")}`,
      `EarlyCloseSet ${toEventSelector("EarlyCloseSet(bytes32,uint256,uint256,uint256,uint32)")}`,
      "PoolConfigured 0x0cd5d07754e72da6a4377b10c0e71af087f26ee3d83fe1477267deb81b4a9fd5",
    ]);
  });

  test("every fee-setting event for a pinned pool is one alert, critical when the keeper now holds the asset; other pools are never asked for", async () => {
    const r = hookRig();
    let b = r.chain.head - 50n;
    const expiry = Math.floor(WEDNESDAY / 1000) + 3_600;
    const config = { openFloor: 3_000, overnightFloor: 2_000, closedFloor: 1_000, spikeMult: 5, closedSpike: 12_000, descentWindow: 1_800, closeFloor: 4_000, closeBefore: 1_800, closeAfter: 1_800 };
    r.chain.emit(RWA, HOOK_ABI, "FeePoked", { poolId: MU_ID, fee0For1: 10_000, fee1For0: 10_000, expiry }, b++);
    r.chain.emit(RWA, HOOK_ABI, "FeePoked", { poolId: MU_ID, fee0For1: 3_000, fee1For0: 9_000, expiry }, b++);
    r.chain.emit(RAMP, HOOK_ABI, "FeePoked", { poolId: GME_ID, fee0For1: 9_000, fee1For0: 400, expiry }, b++);
    r.chain.emit(RWA, HOOK_ABI, "PoolConfigured", { poolId: MU_ID, config, maxFee: 50_000 }, b++);
    r.chain.emit(RAMP, RAMP_CONFIGURED, "PoolConfigured", { poolId: GME_ID, floorPips: 300, flatPips: 600, maxFee: 20_000 }, b++);
    r.chain.emit(RWA, HOOK_ABI, "PoolAsymmetrySet", { poolId: MU_ID, premiumPips: 500, premiumZeroForOne: true }, b++);
    r.chain.emit(RWA, HOOK_ABI, "PokeCleared", { poolId: MU_ID }, b++);
    r.chain.emit(RWA, HOOK_ABI, "DayOverridesSet", { poolId: MU_ID, yearMonth: 202_610n, packed: 1n }, b++);
    r.chain.emit(RWA, HOOK_ABI, "SessionHoursSet", { poolId: MU_ID, openSec: 34_200, closeSec: 57_600 }, b++);
    r.chain.emit(RWA, HOOK_ABI, "DstModeSet", { poolId: MU_ID, mode: 1 }, b++);
    r.chain.emit(RWA, HOOK_ABI, "EarlyCloseSet", { poolId: MU_ID, y: 2026n, m: 11n, d: 27n, closeSec: 46_800 }, b++);
    r.chain.emit(RWA, HOOK_ABI, "FeePoked", { poolId: OTHER_ID, fee0For1: 50_000, fee1For0: 50_000, expiry }, b++); // a pool we do not use

    const rep = await r.monitor.poll();
    expect(events(rep.alerts).map((a) => [a.name, a.severity, a.title])).toEqual([
      ["FeePoked", "critical", `Hook MU: MU pool fee POKED to 1.00% (0->1) / 1.00% (1->0) until ${new Date(expiry * 1000).toISOString()}`],
      ["FeePoked", "warning", `Hook MU: MU pool fee POKED to 0.30% (0->1) / 0.90% (1->0) until ${new Date(expiry * 1000).toISOString()}`],
      ["FeePoked", "warning", `Hook GME: GME pool fee POKED to 0.90% (0->1) / 0.04% (1->0) until ${new Date(expiry * 1000).toISOString()}`],
      ["PoolConfigured", "warning", "Hook MU: MU pool fees RE-CONFIGURED (cap 5.00%)"],
      ["PoolConfigured", "critical", "Hook GME: GME pool fees RE-CONFIGURED (cap 2.00%)"],
      ["PoolAsymmetrySet", "warning", "Hook MU: MU pool premium set to 0.05% on 0->1 swaps"],
      ["PokeCleared", "info", "Hook MU: MU pool fee poke cleared (back to its own fee)"],
      ["DayOverridesSet", "warning", "Hook MU: MU market calendar overridden for 202610"],
      ["SessionHoursSet", "warning", "Hook MU: MU session hours set to 34200s-57600s ET"],
      ["DstModeSet", "warning", "Hook MU: MU DST mode set to 1"],
      ["EarlyCloseSet", "warning", "Hook MU: MU early close 2026-11-27 at 46800s ET"],
    ]);
    const mu = events(rep.alerts)[3]!;
    expect(mu.lines).toEqual([
      "open 0.30%, overnight 0.20%, closed 0.10%, closing ramp 0.40%, opening spike x5 / 1.20% over 1800s",
      "the keeper holds MU while its fee is above 0.40% or its cap above 5.00% (HOOK_PINS)",
      `Hook MU ${RWA}, block ${r.chain.head - 47n}`,
      expect.stringContaining("/tx/0x"),
    ]);
    // One filter for the hooks, on the pinned PoolIds, over the same range as the main scan.
    const hookCalls = r.chain.getLogsCalls.filter((c) => c.addresses.includes(RWA.toLowerCase()));
    expect(hookCalls.map((c) => [c.addresses, c.topic1])).toEqual([[[RWA.toLowerCase(), RAMP.toLowerCase()], [MU_ID, GME_ID]]]);
    const main = r.chain.getLogsCalls.find((c) => c.addresses.includes(C.sweepExecutor.toLowerCase()))!;
    expect([hookCalls[0]!.from, hookCalls[0]!.to]).toEqual([main.from, main.to]);

    // Seen once: the next poll repeats nothing.
    r.chain.head += 10n;
    expect(events((await r.monitor.poll()).alerts)).toEqual([]);
  });

  test("the hooks' AccessManager: its verified events' signatures (topic0, as `cast sig-event` computes them)", () => {
    expect(ACCESS_MANAGER_ABI.map((e) => `${e.name} ${toEventSelector(e)}`)).toEqual([
      "RoleGranted 0xf98448b987f1428e0e230e1f3c6e2ce15b5693eaf31827fbd0b1ec4b424ae7cf",
      "RoleRevoked 0xf229baa593af28c41b1d16b748cd7688f0c83aaf92d4be41c44005defe84c166",
      "RoleGrantDelayChanged 0xfeb69018ee8b8fd50ea86348f1267d07673379f72cffdeccec63853ee8ce8b48",
      "RoleAdminChanged 0x1fd6dd7631312dfac2205b52913f99de03b4d7e381d5d27d3dbfe0713e6e6340",
      "RoleGuardianChanged 0x7a8059630b897b5de4c08ade69f8b90c3ead1f8596d62d10b6c4d14a0afb4ae2",
      "TargetFunctionRoleUpdated 0x9ea6790c7dadfd01c9f8b9762b3682607af2c7e79e05a9f9fdf5580dde949151",
      "TargetAdminDelayUpdated 0xa56b76017453f399ec2327ba00375dbfb1fd070ff854341ad6191e6a2e2de19c",
      "TargetClosed 0x90d4e7bb7e5d933792b3562e1741306f8be94837e1348dacef9b6f1df56eb138",
      "OperationScheduled 0x82a2da5dee54ea8021c6545b4444620291e07ee83be6dd57edb175062715f3b4",
      "OperationExecuted 0x76a2a46953689d4861a5d3f6ed883ad7e6af674a21f8e162707159fc9dde614d",
      "OperationCanceled 0xbd9ac67a6e2f6463b80927326310338bcbb4bdb7936ce1365ea3e01067e7b9f7",
    ]);
  });

  test("the hooks' AccessManager: role, delay, target and operation changes are alerts, critical when they reach the pinned hooks", async () => {
    const r = hookRig();
    const AM = ACCESS_MANAGER_ABI as unknown as Abi;
    const since = Math.floor(WEDNESDAY / 1000);
    const iso = new Date(since * 1000).toISOString();
    const OTHER_TARGET = addr("0d", 13);
    let b = r.chain.head - 50n;
    r.chain.emit(AUTHORITY, AM, "RoleGranted", { roleId: 1n, account: ATTACKER, delay: 0, since, newMember: true }, b++);
    r.chain.emit(AUTHORITY, AM, "RoleGranted", { roleId: 0n, account: OWNER, delay: 3_600, since, newMember: false }, b++);
    r.chain.emit(AUTHORITY, AM, "RoleRevoked", { roleId: 1n, account: ATTACKER }, b++);
    r.chain.emit(AUTHORITY, AM, "RoleGrantDelayChanged", { roleId: 1n, delay: 0, since }, b++);
    r.chain.emit(AUTHORITY, AM, "RoleAdminChanged", { roleId: 1n, admin: 2n ** 64n - 1n }, b++);
    r.chain.emit(AUTHORITY, AM, "TargetFunctionRoleUpdated", { target: RWA, selector: "0x12345678", roleId: 1n }, b++);
    r.chain.emit(AUTHORITY, AM, "TargetFunctionRoleUpdated", { target: OTHER_TARGET, selector: "0x12345678", roleId: 1n }, b++);
    r.chain.emit(AUTHORITY, AM, "TargetAdminDelayUpdated", { target: RAMP, delay: 0, since }, b++);
    r.chain.emit(AUTHORITY, AM, "OperationScheduled", { operationId: `0x${"44".repeat(32)}`, nonce: 1, schedule: since, caller: ATTACKER, target: RWA, data: "0xabcdef0100" }, b++);
    r.chain.emit(AUTHORITY, AM, "OperationExecuted", { operationId: `0x${"44".repeat(32)}`, nonce: 1 }, b++);
    r.chain.emit(ATTACKER, AM, "RoleGranted", { roleId: 1n, account: ATTACKER, delay: 0, since, newMember: true }, b++); // another AccessManager

    const rep = await r.monitor.poll();
    const am = "AccessManager (MU/GME hooks)";
    expect(events(rep.alerts).map((a) => [a.name, a.severity, a.title])).toEqual([
      ["RoleGranted", "critical", `${am}: role 1 GRANTED to ${ATTACKER} (execution delay 0s, from ${iso})`],
      ["RoleGranted", "warning", `${am}: ADMIN_ROLE execution delay of ${OWNER} (owner/pauser/attestor) set to 3600s from ${iso}`],
      ["RoleRevoked", "warning", `${am}: role 1 revoked from ${ATTACKER}`],
      ["RoleGrantDelayChanged", "critical", `${am}: role 1 grant delay set to 0s from ${iso}`],
      ["RoleAdminChanged", "critical", `${am}: admin of role 1 is now PUBLIC_ROLE`],
      ["TargetFunctionRoleUpdated", "critical", `${am}: the MU hook function 0x12345678 now needs role 1`],
      ["TargetFunctionRoleUpdated", "info", `${am}: ${OTHER_TARGET} function 0x12345678 now needs role 1`],
      ["TargetAdminDelayUpdated", "critical", `${am}: admin delay of the GME hook set to 0s from ${iso}`],
      ["OperationScheduled", "critical", `${am}: operation SCHEDULED on the MU hook by ${ATTACKER}, runnable from ${iso}`],
      ["OperationExecuted", "info", `${am}: operation executed`],
    ]);
    expect(events(rep.alerts)[0]!.lines).toEqual([
      "a new member of a role can change the pools' fees: it governs the fee setters of the MU and GME hooks (accepted risk A-L3)",
      `${am} ${AUTHORITY}, block ${r.chain.head - 50n}`,
      expect.stringContaining("/tx/0x"),
    ]);
    // In the main filter, beside the book's contracts; never the hooks' PoolId filter.
    const main = r.chain.getLogsCalls.find((c) => c.addresses.includes(C.sweepExecutor.toLowerCase()))!;
    expect(main.addresses).toContain(AUTHORITY.toLowerCase());
    expect(r.chain.getLogsCalls.filter((c) => c.topic1).every((c) => !c.addresses.includes(AUTHORITY.toLowerCase()))).toBe(true);
  });

  test("the AccessManager watched is each pin's hookAuthority: the built-in pins name 0xA362…4f30", () => {
    expect(hookAuthorityContracts(DEFAULT_HOOK_PINS).map((w) => [w.name, w.address])).toEqual([
      ["AccessManager (MU/GME hooks)", "0xA362D98B33A7bb5B5E2180a05f995A70FB404f30"],
    ]);
  });

  test("a hook whose authority or cap moves off its pin is a critical condition until it is back", async () => {
    const r = hookRig();
    expect(conds((await r.monitor.poll()).alerts)).toEqual([]);
    expect(r.logs.some((l) => l.includes("invariant reads failed"))).toBe(false);

    r.chain.read(RWA, "authority", () => ATTACKER);
    r.chain.read(RAMP, "maxFee", ([id]) => (id === GME_ID ? 30_000 : 0));
    r.clock.t += 2 * MIN;
    const bad = conds((await r.monitor.poll()).alerts);
    expect(bad.map((a) => [a.name, a.severity, a.title])).toEqual([
      ["wiring.Hook MU.authority", "critical", `MU hook authority is ${ATTACKER}, pinned ${AUTHORITY}: whoever holds it sets the MU pool fee; the keeper holds MU`],
      ["wiring.Hook GME.maxFee", "critical", "GME pool fee cap is 3% (pinned 2%): the keeper holds GME until HOOK_PINS is reviewed"],
    ]);

    r.chain.read(RWA, "authority", () => AUTHORITY);
    r.chain.read(RAMP, "maxFee", ([id]) => (id === GME_ID ? 20_000 : 0));
    r.clock.t += 2 * MIN;
    expect(conds((await r.monitor.poll()).alerts).map((a) => [a.name, a.state])).toEqual([
      ["wiring.Hook MU.authority", "resolved"],
      ["wiring.Hook GME.maxFee", "resolved"],
    ]);
  });

  test("HOOK_PINS defaults to the keeper's built-in pins (MU and GME)", () => {
    const cfg = loadMonitorConfig({});
    expect(cfg.HOOK_PINS).toEqual([...DEFAULT_HOOK_PINS]);
    expect(hookContracts(cfg.HOOK_PINS).watched.map((w) => [w.name, w.address])).toEqual([
      ["Hook MU", "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080"],
      ["Hook GME", "0x08E52564Bad99E05a694b4809F397edcA417A080"],
    ]);
    expect(() => loadMonitorConfig({ HOOK_PINS: "{" })).toThrow(/HOOK_PINS/);
  });
});

describe("monitor: balances", () => {
  test("keeper ETH below the floor fires once, reminds after REPEAT, and resolves on top-up", async () => {
    const r = rig({ CHECK_EVERY_MS: "60000", REPEAT_MINUTES: "60" });
    r.chain.balances.set(KEEPER.toLowerCase(), 10n ** 15n); // 0.001 < 0.002
    const fired = conds((await r.monitor.poll()).alerts, "balance.keeper");
    expect(fired.map((a) => [a.state, a.severity])).toEqual([["firing", "critical"]]);
    expect(fired[0]!.title).toBe("keeper ETH low: 0.001 ETH (floor 0.002)");
    for (let i = 1; i <= 5; i++) {
      r.clock.t += MIN;
      expect(conds((await r.monitor.poll()).alerts, "balance.keeper")).toEqual([]);
    }
    r.clock.t += 56 * MIN;
    expect(conds((await r.monitor.poll()).alerts, "balance.keeper").map((a) => a.state)).toEqual(["repeat"]);
    r.chain.balances.set(KEEPER.toLowerCase(), 5n * 10n ** 15n);
    r.clock.t += MIN;
    const back = conds((await r.monitor.poll()).alerts, "balance.keeper");
    expect(back.map((a) => [a.state, a.severity])).toEqual([["resolved", "critical"]]);
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts, "balance.keeper")).toEqual([]);
  });

  test("owner ETH has its own floor; 0 disables a floor", async () => {
    const r = rig({ KEEPER_MIN_ETH: "0" });
    r.chain.balances.set(KEEPER.toLowerCase(), 0n);
    r.chain.balances.set(OWNER.toLowerCase(), 10n ** 14n);
    const c = conds((await r.monitor.poll()).alerts);
    expect(c.map((a) => [a.name, a.severity])).toEqual([["balance.owner", "warning"]]);
  });

  test("a pauser separate from the owner gets its own floor", async () => {
    const PAUSER = addr("0c", 9);
    const r = rig({ PAUSER_ADDRESS: PAUSER, OWNER_MIN_ETH: "0" });
    for (const k of AUTH_CONTRACTS) r.chain.read(C[k], "pauser", () => PAUSER);
    r.chain.balances.set(OWNER.toLowerCase(), 0n);
    r.chain.balances.set(PAUSER.toLowerCase(), 10n ** 14n);
    const c = conds((await r.monitor.poll()).alerts);
    expect(c.map((a) => [a.name, a.severity])).toEqual([["balance.pauser", "warning"]]);
    expect(c[0]!.lines[0]).toBe(`pauser ${PAUSER}`);
  });
});

describe("monitor: RPC failures", () => {
  test("short blips are silent; a sustained outage alerts once, without the RPC key; recovery resolves and loses no block", async () => {
    const r = rig({ RPC_DOWN_MINUTES: "5", CHECK_EVERY_MS: "600000" });
    await r.monitor.poll();
    const before = r.monitor.cursor;
    r.chain.down = true;
    const seen: Alert[] = [];
    for (let i = 0; i < 4; i++) {
      r.clock.t += MIN;
      seen.push(...(await r.monitor.poll()).alerts);
    }
    expect(conds(seen, "rpc.down")).toEqual([]); // 3 minutes of failures
    r.clock.t += 2 * MIN;
    const down = conds((await r.monitor.poll()).alerts, "rpc.down");
    expect(down.length).toBe(1);
    expect(down[0]!.severity).toBe("critical");
    expect(down[0]!.title).toStartWith("RPC failing for 5m");
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts, "rpc.down")).toEqual([]);
    for (const l of [...r.logs, ...r.pushed]) expect(l).not.toContain("SUPERSECRETKEY");
    expect(r.monitor.health().ok).toBe(false);

    // Events emitted during the outage are picked up after it.
    r.chain.head += 200n;
    r.chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "ParamsSet", { finalityBuffer: 0n, threshold: 1_000_000n, feeBps: 100, slippageBps: 500, epochLength: 3_600n }, r.chain.head - 100n);
    r.chain.down = false;
    r.clock.t += MIN;
    const rec = (await r.monitor.poll()).alerts;
    expect(conds(rec, "rpc.down").map((a) => a.state)).toEqual(["resolved"]);
    expect(events(rec).map((a) => a.name)).toEqual(["ParamsSet"]);
    expect(r.monitor.cursor).toBe(r.chain.head);
    expect(r.monitor.cursor).toBeGreaterThan(before);
    expect(r.monitor.health().ok).toBe(true);
  });
});

describe("monitor: state file", () => {
  test("an unwritable STATE_FILE is a warning, raised once", async () => {
    const r = rig({ STATE_FILE: dir }); // a directory: the rename onto it fails
    const first = conds((await r.monitor.poll()).alerts, "state.save");
    expect(first.map((a) => [a.state, a.severity])).toEqual([["firing", "warning"]]);
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts, "state.save")).toEqual([]);
  });
});

describe("monitor: startup", () => {
  test("an RPC on another chain is refused before anything is read", async () => {
    const chain = new FakeChain();
    chain.chainId = 1;
    const r = rig({}, chain);
    await expect(r.monitor.init()).rejects.toBeInstanceOf(ChainMismatchError);
    expect(chain.getLogsCalls).toEqual([]);
  });

  test("an RPC that is down at boot is retried by poll and alerts only once sustained", async () => {
    const chain = new FakeChain();
    chain.down = true;
    const r = rig({ RPC_DOWN_MINUTES: "5" }, chain);
    const seen: Alert[] = [];
    for (let m = 0; m <= 6; m++) {
      r.clock.t = WEDNESDAY + m * MIN;
      const rep = await r.monitor.poll();
      expect(rep.error).not.toBeNull();
      seen.push(...rep.alerts);
    }
    expect(conds(seen).map((a) => [a.name, a.state])).toEqual([["rpc.down", "firing"]]);
    chain.down = false;
    r.clock.t += MIN;
    const rep = await r.monitor.poll();
    expect(rep.error).toBeNull();
    expect(conds(rep.alerts, "rpc.down").map((a) => a.state)).toEqual(["resolved"]);
  });
});

describe("monitor: wiring invariants", () => {
  test("a live mismatch (executor swapped) fires once and resolves when fixed", async () => {
    const r = rig({ CHECK_EVERY_MS: "60000" });
    r.chain.read(C.cashPark, "executor", () => ATTACKER);
    const a = conds((await r.monitor.poll()).alerts);
    expect(a.map((x) => [x.name, x.severity, x.state])).toEqual([["wiring.CashPark.executor", "critical", "firing"]]);
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts)).toEqual([]);
    r.chain.read(C.cashPark, "executor", () => C.sweepExecutor);
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts).map((x) => x.state)).toEqual(["resolved"]);
  });

  test("a pending ownership transfer and a pause are open conditions", async () => {
    const r = rig();
    r.chain.read(C.sweepExecutor, "pendingOwner", () => ATTACKER);
    r.chain.read(C.sweepExecutor, "paused", () => true);
    const names = conds((await r.monitor.poll()).alerts).map((x) => x.name).sort();
    expect(names).toEqual(["wiring.SweepExecutor.paused", "wiring.SweepExecutor.pendingOwner"]);
  });
});

describe("monitor: liveness", () => {
  /** One linked, consenting, funded wallet with an active rule: the keeper must act on it. */
  function armed(chain: FakeChain, opts: { value?: bigint; swept?: bigint } = {}) {
    chain.emit(C.ruleRegistry, CONTRACT_ABIS.ruleRegistry, "Linked", { account: ACCOUNT, wallet: WALLET }, DEPLOY + 10n);
    chain.read(C.ruleRegistry, "ruleOf", () => ({ roundTo: 1, multiplier: 1, weeklyCap: 20_000_000n, enabled: true }));
    chain.read(C.sweepExecutor, "remainingWeeklyCap", () => 20_000_000n);
    chain.read(C.sweepExecutor, "threshold", () => 5_000_000n);
    chain.read(C.sweepExecutor, "currentEpoch", () => 20_000n);
    chain.read(C.sweepExecutor, "sweptEpoch", () => opts.swept ?? 19_999n);
    chain.read(C.cashPark, "valueOf", () => opts.value ?? 0n);
    chain.read(C.screeningGate, "isEligible", () => true);
    chain.read(USDG, "allowance", () => 10n ** 12n);
    chain.read(USDG, "balanceOf", () => 50_000_000n);
    chain.read(PERMIT2, "allowance", () => [10n ** 12n, 4_000_000_000, 0]);
  }

  test("discovery rebuilds the linked wallets from the deploy block before liveness runs", async () => {
    const chain = new FakeChain();
    armed(chain);
    const r = rig({ DISCOVERY_CHUNKS_PER_POLL: "10", LOGS_RANGE: "100000" }, chain);
    await r.monitor.poll();
    expect(r.monitor.discoveryComplete).toBe(false);
    for (let i = 0; i < 5 && !r.monitor.discoveryComplete; i++) await r.monitor.poll();
    expect(r.monitor.discoveryComplete).toBe(true);
    expect([...r.monitor.linkedAccounts()]).toEqual([[ACCOUNT, [WALLET]]]);
    // An unlink seen by the live scan removes it; replaying the old Linked does not resurrect it.
    chain.emit(C.ruleRegistry, CONTRACT_ABIS.ruleRegistry, "Unlinked", { account: ACCOUNT, wallet: WALLET }, chain.head + 5n);
    chain.head += 10n;
    await r.monitor.poll();
    expect(r.monitor.linkedAccounts().size).toBe(0);
  });

  test("keeper.idle: no keeper tx past the window while a wallet waits on it; resolves on the next keeper tx", async () => {
    const chain = new FakeChain();
    armed(chain);
    const r = rig({ KEEPER_IDLE_MINUTES: "60", LIVENESS_EVERY_MS: "60000", CHECK_EVERY_MS: "60000", LOGS_RANGE: "10000000" }, chain);
    chain.nonces.set(KEEPER.toLowerCase(), 2);
    expect(conds((await r.monitor.poll()).alerts, "keeper.idle")).toEqual([]);
    let fired: Alert[] = [];
    for (let m = 1; m <= 70 && !fired.length; m++) {
      r.clock.t += MIN;
      fired = conds((await r.monitor.poll()).alerts, "keeper.idle");
    }
    expect(fired.map((a) => [a.state, a.severity])).toEqual([["firing", "warning"]]);
    expect(r.clock.t - WEDNESDAY).toBeGreaterThanOrEqual(60 * MIN);
    expect(fired[0]!.title).toContain("1 wallet(s)");
    chain.nonces.set(KEEPER.toLowerCase(), 3);
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts, "keeper.idle").map((a) => a.state)).toEqual(["resolved"]);
  });

  test("keeper.idle stays quiet when no wallet needs the keeper (no consent)", async () => {
    const chain = new FakeChain();
    armed(chain);
    chain.read(PERMIT2, "allowance", () => [0n, 0, 0]);
    const r = rig({ KEEPER_IDLE_MINUTES: "60", LIVENESS_EVERY_MS: "60000", LOGS_RANGE: "10000000" }, chain);
    const all: Alert[] = [];
    for (let m = 0; m <= 120; m += 10) {
      r.clock.t = WEDNESDAY + m * MIN;
      all.push(...(await r.monitor.poll()).alerts);
    }
    expect(conds(all, "keeper.idle")).toEqual([]);
  });

  test("keeper activity events reset the idle clock to their block time", async () => {
    const chain = new FakeChain();
    armed(chain);
    const r = rig({ KEEPER_IDLE_MINUTES: "60", LIVENESS_EVERY_MS: "60000", LOGS_RANGE: "10000000" }, chain);
    await r.monitor.poll();
    r.clock.t += 50 * MIN;
    chain.head += 30_000n; // 50 minutes of blocks
    chain.emit(C.sweepExecutor, CONTRACT_ABIS.sweepExecutor, "Accrued", { account: ACCOUNT, wallet: WALLET, amount: 0n, fromBlock: 1n, toBlock: 2n }, chain.head - 10n);
    await r.monitor.poll();
    expect(r.monitor.lastKeeperActivityAt).toBe(chain.blockTime(chain.head - 10n) * 1000);
    r.clock.t += 30 * MIN; // 80 min since start, 30 since the accrual
    expect(conds((await r.monitor.poll()).alerts, "keeper.idle")).toEqual([]);
  });

  test("a liveness read that fails at the RPC is an RPC failure, never 'no wallet waits': keeper.idle and sweep.overdue stay firing", async () => {
    const chain = new FakeChain();
    armed(chain, { value: 6_000_000n });
    const r = rig({ KEEPER_IDLE_MINUTES: "60", SWEEP_OVERDUE_MINUTES: "30", LIVENESS_EVERY_MS: "60000", LOGS_RANGE: "10000000" }, chain);
    const seen: Alert[] = [];
    for (let m = 0; m <= 70; m++) {
      r.clock.t = WEDNESDAY + m * MIN;
      seen.push(...(await r.monitor.poll()).alerts);
    }
    expect(conds(seen, "keeper.idle").map((a) => a.state)).toEqual(["firing"]);
    expect(conds(seen, "sweep.overdue").map((a) => a.state)).toEqual(["firing"]);

    // The liveness multicall (the only read of remainingWeeklyCap) is rate-limited for a few polls.
    const selector = encodeFunctionData({ abi: CONTRACT_ABIS.sweepExecutor, functionName: "remainingWeeklyCap", args: [ACCOUNT] }).slice(0, 10);
    chain.multicallFails = (calls) => calls.some((c) => c.callData.startsWith(selector));
    const during: Alert[] = [];
    let error: string | null = null;
    for (let m = 1; m <= 3; m++) {
      r.clock.t += MIN;
      const rep = await r.monitor.poll();
      during.push(...rep.alerts);
      error = rep.error;
    }
    expect(conds(during, "keeper.idle")).toEqual([]);
    expect(conds(during, "sweep.overdue")).toEqual([]);
    expect(error).toContain("429");
    expect(r.logs.some((l) => l.includes('"rpc error"') || l.includes("rpc error"))).toBe(true);

    // Back: still idle and overdue, so nothing resolves or re-fires.
    chain.multicallFails = () => false;
    r.clock.t += MIN;
    expect(conds((await r.monitor.poll()).alerts)).toEqual([]);
  });

  test("sweep.overdue: an account due for longer than the window during market hours; never on a closed market", async () => {
    const open = new FakeChain();
    armed(open, { value: 6_000_000n });
    const r = rig({ SWEEP_OVERDUE_MINUTES: "30", LIVENESS_EVERY_MS: "60000", LOGS_RANGE: "10000000" }, open);
    const seen: Alert[] = [];
    for (let m = 0; m <= 40; m += 5) {
      r.clock.t = WEDNESDAY + m * MIN;
      seen.push(...(await r.monitor.poll()).alerts);
    }
    const overdue = conds(seen, "sweep.overdue");
    expect(overdue.map((a) => a.state)).toEqual(["firing"]);
    expect(overdue[0]!.title).toBe("1 account(s) due a sweep for 30m during market hours");
    // Swept this epoch: resolved.
    open.read(C.sweepExecutor, "sweptEpoch", () => 20_000n);
    r.clock.t += 5 * MIN;
    expect(conds((await r.monitor.poll()).alerts, "sweep.overdue").map((a) => a.state)).toEqual(["resolved"]);

    const closed = new FakeChain();
    armed(closed, { value: 6_000_000n });
    const s = rig({ SWEEP_OVERDUE_MINUTES: "30", LIVENESS_EVERY_MS: "60000", LOGS_RANGE: "10000000" }, closed, { t: SATURDAY });
    const quiet: Alert[] = [];
    for (let m = 0; m <= 120; m += 10) {
      s.clock.t = SATURDAY + m * MIN;
      quiet.push(...(await s.monitor.poll()).alerts);
    }
    expect(conds(quiet, "sweep.overdue")).toEqual([]);
  });
});

describe("monitor: keeper /health", () => {
  const TOKEN = "k".repeat(40);
  function withHealth(bodies: (() => unknown)[], env: Record<string, string> = {}) {
    let i = 0;
    const chain = new FakeChain();
    const headers: Record<string, string>[] = [];
    const r = rig({ KEEPER_HEALTH_URL: "http://keeper.internal:8080/health", RPC_DOWN_MINUTES: "5", KEEPER_TICK_STALE_MINUTES: "15", ...env }, chain);
    (r.monitor as unknown as { deps: { fetch: unknown } }).deps.fetch = async (_url: string, init: { headers: Record<string, string> }) => {
      headers.push(init.headers);
      const b = bodies[Math.min(i++, bodies.length - 1)]!();
      if (b instanceof Error) throw b;
      return { ok: true, status: 200, json: async () => b };
    };
    return Object.assign(r, { headers });
  }

  test("with the keeper's HEALTH_TOKEN the detail is requested as a bearer token, which never reaches a log", async () => {
    const r = withHealth([() => ({ ok: false, started: true, reasons: [`accrue tick failed 5x in a row`], recent: [{ at: new Date(WEDNESDAY).toISOString() }] })], {
      KEEPER_HEALTH_TOKEN: TOKEN,
    });
    const a = conds((await r.monitor.poll()).alerts, "keeper.unhealthy");
    expect(r.headers[0]).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(a[0]!.title).toBe("keeper reports unhealthy: accrue tick failed 5x in a row");
    for (const l of r.logs) expect(l).not.toContain(TOKEN);
  });

  test("without the token the keeper says only { ok }: unhealthy still alerts, stalled cannot misfire", async () => {
    const r = withHealth([() => ({ ok: false })]);
    const seen: Alert[] = [];
    for (let m = 0; m < 30; m++) {
      seen.push(...(await r.monitor.poll()).alerts);
      r.clock.t += MIN;
    }
    expect(r.headers[0]).toEqual({});
    expect(conds(seen).map((a) => `${a.name}:${a.state}`)).toEqual(["keeper.unhealthy:firing"]);
  });

  test("unhealthy, stalled and unreachable each alert once", async () => {
    const tick = (minsAgo: number, t: number) => [{ at: new Date(t - minsAgo * MIN).toISOString() }];
    let now = WEDNESDAY;
    const bodies: (() => unknown)[] = [
      () => ({ ok: true, started: true, reasons: [], recent: tick(1, now) }),
      () => ({ ok: false, started: true, reasons: ["low gas: 0.0004 ETH"], recent: tick(1, now) }),
      () => ({ ok: true, started: true, reasons: [], recent: tick(20, now) }),
      () => new Error("connect ECONNREFUSED"),
    ];
    const r = withHealth(bodies);
    const step = async () => {
      const a = (await r.monitor.poll()).alerts;
      r.clock.t += MIN;
      now = r.clock.t;
      return conds(a).filter((x) => x.name.startsWith("keeper.")).map((x) => `${x.name}:${x.state}`);
    };
    expect(await step()).toEqual([]);
    expect(await step()).toEqual(["keeper.unhealthy:firing"]);
    expect(await step()).toEqual(["keeper.unhealthy:resolved", "keeper.stalled:firing"]);
    const outage: string[] = [];
    for (let i = 0; i < 7; i++) outage.push(...(await step()));
    expect(outage).toEqual(["keeper.unreachable:firing"]);
  });
});
