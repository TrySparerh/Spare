/**
 * SPARE on-chain monitor — read-only, keyless.
 *
 * Each poll:
 *   1. scan  — every watched contract's events from cursor + 1 to
 *              head - CONFIRMATIONS, in bounded eth_getLogs chunks (one
 *              filter: all addresses, all watched topics), and over the same
 *              range the fee-setting events of the hooks in HOOK_PINS, for
 *              the pinned PoolIds only (a second filter on topic 1). The
 *              AccessManager those hooks answer to (each pin's hookAuthority)
 *              is in the first filter: its role, target and operation events.
 *              Each privileged or operational log becomes exactly one alert,
 *              keyed by tx hash + log index.
 *   2. discover — rebuild the linked-wallet set (RuleRegistry Linked /
 *              Unlinked) from the deploy block, a bounded slice per poll.
 *   3. checks (every CHECK_EVERY_MS) — keeper / owner / pauser ETH, the
 *              keeper's nonce, and the live wiring: owner, pendingOwner,
 *              paused, pauser on every owned contract; CashPark executor /
 *              adapter / keeper; SweepExecutor keeper; StockRouter caller;
 *              ScreeningGate attestor / enforced; each pinned hook's
 *              authority and its pool's fee cap.
 *   4. liveness (every LIVENESS_EVERY_MS, once discovery is complete) —
 *              keeper.idle and sweep.overdue from per-account state.
 *   5. keeper /health (KEEPER_HEALTH_URL), RPC-failure accounting.
 * Conditions fire once, remind every REPEAT_MINUTES and resolve once. The
 * cursor only moves past a chunk once its alerts are built, and state is
 * saved after they are dispatched: a crash can repeat an alert, never lose it.
 */
import {
  decodeErrorResult,
  decodeFunctionData,
  erc20Abi,
  formatEther,
  formatLog,
  getAddress,
  numberToHex,
  parseEventLogs,
  toEventSelector,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { permit2Abi, stockRouterAbi, sweepExecutorAbi } from "../chain/abis.ts";
import { PERMIT2, USDG } from "../chain/constants.ts";
import { classifyLogError, RATE_LIMIT_RETRIES, rateLimitDelayMs, retryAfterMs } from "../chain/logs.ts";
import { fablesHookAbi } from "../keeper/hooks.ts";
import { aggregate3, type Got, type Read } from "../keeper/multicall.ts";
import { equitySessionOpenedAt, hasConsent } from "../keeper/plan.ts";
import { Conditions, errorSummary, minutes, redact, SeenSet, type Alert, type Severity } from "./alerts.ts";
import type { MonitorBook, MonitorConfig } from "./config.ts";
import type { Dispatcher } from "./sinks.ts";
import { loadState, saveState, type LinkRecord, type MonitorState } from "./state.ts";
import {
  AUTH_CONTRACTS,
  CONTRACT_ABIS,
  CONTRACT_NAMES,
  eventsOf,
  HOOK_EVENTS_ABI,
  hookAuthorityContracts,
  hookContracts,
  uniqueEvents,
  watchedContracts,
  type Args,
  type DescribeCtx,
  type Watched,
} from "./watch.ts";

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface MonitorDeps {
  cfg: MonitorConfig;
  book: MonitorBook;
  client: PublicClient;
  dispatcher: Dispatcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: Fetch;
}

export interface PollReport {
  head: bigint | null;
  cursor: bigint;
  /** cursor reached head - CONFIRMATIONS this poll. */
  caughtUp: boolean;
  alerts: Alert[];
  error: string | null;
}

type DecodedLog = {
  address: Address;
  eventName?: string;
  args?: unknown;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  removed?: boolean;
};
type Call = Read;
/** The subset of the keeper's /health body (keeper/run.ts) the monitor reads. */
type KeeperHealthBody = { ok?: unknown; reasons?: unknown; started?: unknown; recent?: { at?: string }[]; uptimeSec?: unknown };
type Res = Got;

/** The RPC serves another chain: nothing it says can be trusted, so the process stops. */
export class ChainMismatchError extends Error {
  constructor(observed: number, expected: number) {
    super(`RPC is chain ${observed}, monitor expects ${expected}`);
    this.name = "ChainMismatchError";
  }
}

/** Every configured value that must never appear in a log line or an alert. */
export function monitorSecrets(cfg: MonitorConfig): string[] {
  return [cfg.RPC_URL, cfg.TELEGRAM_BOT_TOKEN, cfg.ALERT_WEBHOOK_URL, cfg.KEEPER_HEALTH_URL, cfg.KEEPER_HEALTH_TOKEN].filter((s): s is string => Boolean(s));
}

/** Events that prove the keeper (or the executor it drives) did work. */
const KEEPER_ACTIVITY = new Set(["Accrued", "AccrualSkipped", "AccountSwept", "AssetSwept", "Deferred", "SafeSettled", "Parked"]);
const MULTICALL_CHUNK = 200;
const lc = (a: string) => a.toLowerCase();
const posBefore = (b1: bigint, i1: number, b2: bigint, i2: number) => b1 < b2 || (b1 === b2 && i1 < i2);

export class Monitor {
  readonly contracts: Watched[];
  /** The hooks HOOK_PINS names, scanned for the pinned PoolIds only. */
  readonly hooks: Watched[];
  private readonly hookPoolIds: Hex[];
  readonly conditions: Conditions;
  readonly seen = new SeenSet();
  private readonly byAddress = new Map<string, Watched>();
  private readonly events: AbiEvent[];
  private readonly linkEvents: AbiEvent[];
  private readonly addresses: Address[];
  private readonly scanStep: { step: bigint };
  private readonly discoverStep: { step: bigint };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: string[];
  private readonly symbols = new Map<string, string>();
  private readonly links = new Map<string, LinkRecord>();
  private readonly labels = new Map<string, string>();

  cursor = 0n;
  /** First block of the live scan; discovery covers [deploy, scanStart - 1]. */
  scanStart = 0n;
  /** Events below this block are history: logged, not pushed. */
  pushFrom = 0n;
  discoveredTo = 0n;
  keeperNonce: number | null = null;
  /** Newest keeper tx / activity seen (ms); null until one is seen. */
  lastKeeperActivityAt: number | null = null;
  /** When this process (or the saved state's first process) started watching. */
  watchingSince = 0;
  sweepDueSince: number | null = null;
  private rpcFailingSince: number | null = null;
  private lastRpcError = "";
  private keeperHealthFailingSince: number | null = null;
  private nextCheckAt = 0;
  private nextLivenessAt = 0;
  private lastPollOkAt: number | null = null;
  private head: bigint | null = null;
  private ready = false;

  constructor(private readonly deps: MonitorDeps) {
    const { cfg, book } = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.conditions = new Conditions(cfg.REPEAT_MINUTES * 60_000);
    this.contracts = [...watchedContracts(book, cfg.TIMELOCK_ADDRESS), ...hookAuthorityContracts(cfg.HOOK_PINS)];
    for (const w of this.contracts) this.byAddress.set(lc(w.address), w);
    const hooks = hookContracts(cfg.HOOK_PINS);
    this.hooks = hooks.watched;
    this.hookPoolIds = hooks.poolIds;
    for (const w of this.hooks) this.byAddress.set(lc(w.address), w);
    this.events = uniqueEvents(this.contracts.flatMap((w) => eventsOf(w.abi, w.watch, w.name)));
    this.linkEvents = eventsOf(CONTRACT_ABIS.ruleRegistry, { privileged: {}, operational: {}, activity: ["Linked", "Unlinked"] }, "RuleRegistry");
    this.addresses = this.contracts.filter((w) => eventsOf(w.abi, w.watch, w.name).length > 0).map((w) => w.address);
    this.scanStep = { step: cfg.LOGS_RANGE };
    this.discoverStep = { step: cfg.LOGS_RANGE };
    this.secrets = monitorSecrets(cfg);
    for (const w of [...this.contracts, ...this.hooks]) this.labels.set(lc(w.address), w.name);
    const r = book.roles;
    for (const [name, a] of [["owner", r.owner], ["keeper", r.keeper], ["pauser", r.pauser], ["attestor", r.attestor]] as const) {
      if (!a) continue;
      const prev = this.labels.get(lc(a));
      this.labels.set(lc(a), prev ? `${prev}/${name}` : name);
    }
    this.labels.set(lc(USDG), "USDG");
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /** Check the chain, then resume from STATE_FILE or start at START_BLOCK / head - LOOKBACK_BLOCKS. */
  async init(): Promise<void> {
    const { cfg, book, client, dispatcher } = this.deps;
    const chainId = await client.getChainId();
    if (chainId !== cfg.CHAIN_ID) throw new ChainMismatchError(chainId, cfg.CHAIN_ID);
    const now = this.now();
    const saved = cfg.STATE_FILE ? loadState(cfg.STATE_FILE, cfg.CHAIN_ID) : { state: null, problem: null };
    if (saved.problem) dispatcher.log("warn", saved.problem);
    if (saved.state) {
      this.restore(saved.state);
      dispatcher.log("info", "resumed from saved state", { cursor: this.cursor, discoveredTo: this.discoveredTo });
    } else {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const target = head > cfg.CONFIRMATIONS ? head - cfg.CONFIRMATIONS : 0n;
      const lookback = target > cfg.LOOKBACK_BLOCKS ? target - cfg.LOOKBACK_BLOCKS : 0n;
      const start = cfg.START_BLOCK ?? lookback;
      this.cursor = start > 0n ? start - 1n : 0n;
      this.scanStart = this.cursor + 1n;
      this.pushFrom = lookback > start ? lookback : start;
      // Links before the scan come from the deploy block; with no deploy block, only from the scan on.
      this.discoveredTo = book.startBlock > 0n && book.startBlock <= this.scanStart ? book.startBlock - 1n : this.cursor;
      this.watchingSince = now;
      dispatcher.log("info", "starting without saved state", {
        head,
        scanFrom: this.scanStart,
        pushFrom: this.pushFrom,
        discoverFrom: this.discoveredTo + 1n,
        stateFile: cfg.STATE_FILE ? "new" : "none (a restart rescans LOOKBACK_BLOCKS)",
      });
    }
    this.ready = true;
  }

  private restore(s: MonitorState): void {
    this.cursor = BigInt(s.cursor);
    this.scanStart = BigInt(s.scanStart);
    this.pushFrom = BigInt(s.pushFrom);
    this.discoveredTo = BigInt(s.discoveredTo);
    for (const [w, rec] of Object.entries(s.links)) this.links.set(w, rec);
    for (const [k, at] of s.seen) this.seen.keys.set(k, at);
    for (const [k, rec] of s.conditions) this.conditions.active.set(k, rec);
    this.keeperNonce = s.keeperNonce;
    this.lastKeeperActivityAt = s.lastKeeperActivityAt;
    this.watchingSince = s.watchingSince;
    this.sweepDueSince = s.sweepDueSince;
  }

  snapshot(): MonitorState {
    return {
      version: 1,
      chainId: this.deps.cfg.CHAIN_ID,
      cursor: this.cursor.toString(),
      scanStart: this.scanStart.toString(),
      pushFrom: this.pushFrom.toString(),
      discoveredTo: this.discoveredTo.toString(),
      links: Object.fromEntries(this.links),
      seen: [...this.seen.keys],
      conditions: [...this.conditions.active],
      keeperNonce: this.keeperNonce,
      lastKeeperActivityAt: this.lastKeeperActivityAt,
      watchingSince: this.watchingSince,
      sweepDueSince: this.sweepDueSince,
    };
  }

  get discoveryComplete(): boolean {
    return this.discoveredTo + 1n >= this.scanStart;
  }

  /** Wallets currently linked, by account. */
  linkedAccounts(): Map<Address, Address[]> {
    const out = new Map<Address, Address[]>();
    for (const [w, rec] of this.links) {
      if (!rec.account) continue;
      const a = getAddress(rec.account);
      const list = out.get(a);
      if (list) list.push(getAddress(w));
      else out.set(a, [getAddress(w)]);
    }
    return out;
  }

  health() {
    const now = this.now();
    const target = this.head !== null && this.head > this.deps.cfg.CONFIRMATIONS ? this.head - this.deps.cfg.CONFIRMATIONS : null;
    const fresh = this.lastPollOkAt !== null && now - this.lastPollOkAt < 5 * this.deps.cfg.POLL_MS;
    return {
      ok: this.ready && fresh && this.rpcFailingSince === null,
      chainId: this.deps.cfg.CHAIN_ID,
      head: this.head?.toString() ?? null,
      cursor: this.cursor.toString(),
      lagBlocks: target !== null && target > this.cursor ? (target - this.cursor).toString() : "0",
      discovery: { complete: this.discoveryComplete, discoveredTo: this.discoveredTo.toString() },
      linkedWallets: [...this.links.values()].filter((r) => r.account).length,
      lastPollOkAt: this.lastPollOkAt === null ? null : new Date(this.lastPollOkAt).toISOString(),
      rpcFailingSince: this.rpcFailingSince === null ? null : new Date(this.rpcFailingSince).toISOString(),
      firing: [...this.conditions.active.keys()],
      queued: this.deps.dispatcher.pending(),
    };
  }

  // ── poll ──────────────────────────────────────────────────────────────

  async poll(): Promise<PollReport> {
    const { cfg, client, dispatcher } = this.deps;
    const now = this.now();
    const alerts: Alert[] = [];
    if (!this.ready) {
      try {
        await this.init();
      } catch (err) {
        this.rpcHealth(now, err, alerts);
        await dispatcher.dispatch(alerts);
        return { head: null, cursor: this.cursor, caughtUp: false, alerts, error: this.lastRpcError };
      }
    }
    let rpcError: unknown = null;
    let caughtUp = false;
    try {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      this.head = head;
      const target = head > cfg.CONFIRMATIONS ? head - cfg.CONFIRMATIONS : 0n;
      await this.scan(target, now, alerts);
      caughtUp = this.cursor >= target;
      await this.discover();
    } catch (err) {
      rpcError = err;
    }
    if (rpcError === null && now >= this.nextCheckAt) {
      try {
        await this.checks(now, alerts);
        this.nextCheckAt = now + cfg.CHECK_EVERY_MS;
      } catch (err) {
        rpcError = err;
      }
    }
    if (rpcError === null && caughtUp && this.discoveryComplete && now >= this.nextLivenessAt) {
      try {
        await this.liveness(now, alerts);
        this.nextLivenessAt = now + cfg.LIVENESS_EVERY_MS;
      } catch (err) {
        rpcError = err;
      }
    }
    if (cfg.KEEPER_HEALTH_URL) await this.keeperHealth(now, alerts);
    this.rpcHealth(now, rpcError, alerts);
    if (rpcError === null) this.lastPollOkAt = now;
    this.seen.prune(now);

    await dispatcher.dispatch(alerts);
    if (cfg.STATE_FILE) {
      // After dispatch: a crash in between repeats an alert, never loses one.
      let problem = "";
      try {
        saveState(cfg.STATE_FILE, this.snapshot());
      } catch (err) {
        problem = redact(errorSummary(err), this.secrets);
      }
      const a = this.conditions.observe("state.save", problem !== "", now, (state) => ({
        severity: "warning",
        title: state === "resolved" ? "state file writable again" : `cannot write STATE_FILE: ${problem}`,
        lines: state === "resolved" ? [] : ["a restart will rescan LOOKBACK_BLOCKS and may repeat alerts; check the volume mount and its owner"],
      }));
      if (a) {
        alerts.push(a);
        await dispatcher.dispatch([a]);
      }
    }
    return { head: this.head, cursor: this.cursor, caughtUp, alerts, error: rpcError === null ? null : this.lastRpcError };
  }

  // ── logs ──────────────────────────────────────────────────────────────

  /**
   * One bounded getLogs. Throttling is retried with backoff; a provider range
   * or result cap halves `ref.step` for good and returns null (caller retries
   * the smaller range). Anything else throws. With `topic1`, only logs whose
   * first indexed argument is one of those values (a hook's PoolIds).
   */
  private async getLogs(
    address: Address[],
    events: readonly AbiEvent[],
    from: bigint,
    to: bigint,
    ref: { step: bigint },
    topic1?: readonly Hex[],
  ): Promise<DecodedLog[] | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const logs = (
          topic1
            ? await this.logsByTopic1(address, events, topic1, from, to)
            : await this.deps.client.getLogs({ address, events: events as AbiEvent[], fromBlock: from, toBlock: to })
        ) as unknown as DecodedLog[];
        for (const l of logs) {
          if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null) throw new Error("provider returned an unmined log");
          if (l.blockNumber < from || l.blockNumber > to) throw new Error("provider returned a log outside the requested range");
        }
        return logs.filter((l) => !l.removed).sort((a, b) => (posBefore(a.blockNumber!, a.logIndex!, b.blockNumber!, b.logIndex!) ? -1 : 1));
      } catch (err) {
        const kind = classifyLogError(err);
        if (kind === "rate-limit" && attempt < RATE_LIMIT_RETRIES) {
          const ms = rateLimitDelayMs(attempt, retryAfterMs(err));
          this.deps.dispatcher.log("warn", "getLogs rate-limited; backing off", { ms, attempt: attempt + 1, from, to });
          await this.sleep(ms);
          continue;
        }
        if (kind === "result-cap" && ref.step > 1n) {
          ref.step = ref.step / 2n;
          this.deps.dispatcher.log("warn", `getLogs capped by the provider; range now ${ref.step} blocks`, { from, to });
          return null;
        }
        throw err;
      }
    }
  }

  /** eth_getLogs filtered on topic 1 as well (viem's getLogs takes no topics with several events), decoded against `events`. */
  private async logsByTopic1(address: Address[], events: readonly AbiEvent[], topic1: readonly Hex[], from: bigint, to: bigint) {
    const raw = (await this.deps.client.request({
      method: "eth_getLogs",
      params: [{ address, topics: [events.map((e) => toEventSelector(e)), [...topic1]], fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
    } as never)) as Parameters<typeof formatLog>[0][];
    return parseEventLogs({ abi: events, logs: raw.map((l) => formatLog(l)) });
  }

  private async scan(target: bigint, now: number, alerts: Alert[]): Promise<void> {
    const { cfg, dispatcher } = this.deps;
    let chunks = 0;
    const hookAddresses = this.hooks.map((w) => w.address);
    while (this.cursor < target && chunks < cfg.MAX_CHUNKS_PER_POLL) {
      const from = this.cursor + 1n;
      const to = from + this.scanStep.step - 1n < target ? from + this.scanStep.step - 1n : target;
      const logs = await this.getLogs(this.addresses, this.events, from, to, this.scanStep);
      if (logs === null) continue;
      const hookLogs = hookAddresses.length ? await this.getLogs(hookAddresses, HOOK_EVENTS_ABI, from, to, this.scanStep, this.hookPoolIds) : [];
      if (hookLogs === null) continue;
      chunks++;
      const all = hookLogs.length ? [...logs, ...hookLogs].sort((a, b) => (posBefore(a.blockNumber!, a.logIndex!, b.blockNumber!, b.logIndex!) ? -1 : 1)) : logs;
      await this.handle(all, now, alerts);
      this.cursor = to;
    }
    if (chunks > 1) dispatcher.log("info", "scan progress", { cursor: this.cursor, target, chunks });
  }

  private async discover(): Promise<void> {
    const end = this.scanStart - 1n;
    const rr = this.deps.book.ruleRegistry;
    let chunks = 0;
    while (this.discoveredTo < end && chunks < this.deps.cfg.DISCOVERY_CHUNKS_PER_POLL) {
      const from = this.discoveredTo + 1n;
      const to = from + this.discoverStep.step - 1n < end ? from + this.discoverStep.step - 1n : end;
      const logs = await this.getLogs([rr], this.linkEvents, from, to, this.discoverStep);
      if (logs === null) continue;
      chunks++;
      for (const l of logs) this.applyLink(l);
      this.discoveredTo = to;
    }
    if (chunks && this.discoveryComplete) {
      this.deps.dispatcher.log("info", "linked-wallet discovery complete", { linkedWallets: [...this.links.values()].filter((r) => r.account).length });
    }
  }

  /** Latest Linked / Unlinked per wallet wins, by (block, logIndex): replaying a log is harmless. */
  private applyLink(l: DecodedLog): void {
    const a = l.args as { account?: Address; wallet?: Address };
    if (!a?.wallet || (l.eventName !== "Linked" && l.eventName !== "Unlinked")) return;
    const k = lc(a.wallet);
    const prev = this.links.get(k);
    const block = l.blockNumber!;
    const idx = l.logIndex!;
    if (prev && !posBefore(BigInt(prev.block), prev.logIndex, block, idx)) return;
    this.links.set(k, { account: l.eventName === "Linked" && a.account ? getAddress(a.account) : null, block: block.toString(), logIndex: idx });
  }

  private async handle(logs: DecodedLog[], now: number, alerts: Alert[]): Promise<void> {
    const { cfg, dispatcher } = this.deps;
    const activity: Record<string, number> = {};
    let lastActivityBlock: bigint | null = null;
    const alerting: { l: DecodedLog; w: Watched; describe: (a: Args, c: DescribeCtx) => { severity: Severity; title: string; lines?: string[] } }[] = [];
    for (const l of logs) {
      const w = this.byAddress.get(lc(l.address));
      const name = l.eventName;
      if (!w || !name) continue;
      const describe = w.watch.privileged[name] ?? w.watch.operational[name];
      if (describe) {
        alerting.push({ l, w, describe });
        continue;
      }
      if (!w.watch.activity.includes(name)) continue;
      activity[`${w.name}.${name}`] = (activity[`${w.name}.${name}`] ?? 0) + 1;
      if (name === "Linked" || name === "Unlinked") this.applyLink(l);
      if (KEEPER_ACTIVITY.has(name)) lastActivityBlock = l.blockNumber;
    }
    if (Object.keys(activity).length) dispatcher.log("info", "activity", { counts: activity, toBlock: logs[logs.length - 1]?.blockNumber ?? null });
    if (lastActivityBlock !== null) {
      const b = await this.deps.client.getBlock({ blockNumber: lastActivityBlock });
      const at = Number(b.timestamp) * 1000;
      if (this.lastKeeperActivityAt === null || at > this.lastKeeperActivityAt) this.lastKeeperActivityAt = Math.min(at, now);
    }
    if (!alerting.length) return;
    await this.resolveSymbols(alerting.map((x) => x.l.args as Args));
    const ctx = (w: Watched): DescribeCtx => ({
      book: this.deps.book,
      contract: w.name,
      label: (a) => this.label(a),
      symbol: (a) => this.symbol(a),
      call: (t, d) => this.describeCall(t, d),
      reason: (d) => this.describeRevert(d),
    });
    for (const { l, w, describe } of alerting) {
      const key = `ev:${l.transactionHash}:${l.logIndex}`;
      if (!this.seen.add(key, now)) continue;
      const v = describe((l.args ?? {}) as Args, ctx(w));
      const tx = cfg.EXPLORER_URL ? `${cfg.EXPLORER_URL}/tx/${l.transactionHash}` : `tx ${l.transactionHash}`;
      alerts.push({
        key,
        name: l.eventName!,
        severity: v.severity,
        title: v.title,
        lines: [...(v.lines ?? []), `${w.name} ${w.address}, block ${l.blockNumber}`, tx],
        push: l.blockNumber! >= this.pushFrom,
      });
    }
  }

  // ── formatting helpers ────────────────────────────────────────────────

  private label(a: unknown): string {
    if (typeof a !== "string") return String(a);
    if (lc(a) === zeroAddress) return "address(0)";
    const name = this.labels.get(lc(a));
    let shown = a;
    try {
      shown = getAddress(a);
    } catch {}
    return name ? `${shown} (${name})` : shown;
  }

  private symbol(a: unknown): string {
    if (typeof a !== "string") return String(a);
    return this.symbols.get(lc(a)) ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  /** Best effort: symbol() for every token an alert names, one multicall, cached. */
  private async resolveSymbols(args: Args[]): Promise<void> {
    const want = new Set<string>();
    for (const a of args) {
      for (const k of ["token", "asset"]) if (typeof a?.[k] === "string") want.add(lc(a[k] as string));
      const legs = a?.legs as { asset?: string }[] | undefined;
      if (Array.isArray(legs)) for (const leg of legs) if (typeof leg.asset === "string") want.add(lc(leg.asset));
    }
    const missing = [...want].filter((t) => !this.symbols.has(t));
    if (!missing.length) return;
    try {
      const res = await this.multi(missing.map((t) => ({ address: getAddress(t), abi: erc20Abi as Abi, functionName: "symbol" })));
      missing.forEach((t, i) => {
        const r = res[i];
        if (r?.ok && typeof r.value === "string" && /^[\w .$-]{1,16}$/.test(r.value)) this.symbols.set(t, r.value);
      });
    } catch (err) {
      this.deps.dispatcher.log("warn", "symbol lookup failed; alerts show addresses", { error: errorSummary(err) });
    }
  }

  private describeCall(target: unknown, data: unknown): string {
    const w = typeof target === "string" ? this.byAddress.get(lc(target)) : undefined;
    if (w && typeof data === "string") {
      try {
        const d = decodeFunctionData({ abi: w.abi, data: data as Hex });
        const args = (d.args ?? []).map((x) => (typeof x === "string" && x.startsWith("0x") && x.length === 42 ? this.label(x) : String(x)));
        return `${w.name}.${d.functionName}(${args.join(", ")})`;
      } catch {}
    }
    return `${this.label(target)} calldata ${typeof data === "string" ? data.slice(0, 10) : "?"}`;
  }

  private describeRevert(data: unknown): string {
    if (typeof data !== "string" || data.length < 10) return "(empty)";
    try {
      const d = decodeErrorResult({ abi: [...stockRouterAbi, ...sweepExecutorAbi] as Abi, data: data as Hex });
      return d.errorName === "Error" ? String(d.args?.[0]).slice(0, 80) : d.errorName;
    } catch {
      return data.slice(0, 10);
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /**
   * MULTICALL_CHUNK calls per Multicall3 eth_call (keeper/multicall.ts): a
   * call that reverts fails alone, and an eth_call that fails at the RPC
   * THROWS, so the poll counts an RPC failure. viem's multicall with
   * allowFailure read that as every call failing: liveness then saw no wallet
   * the keeper must accrue and no account due, and resolved keeper.idle and
   * sweep.overdue on an RPC blip.
   */
  private async multi(calls: readonly Call[]): Promise<Res[]> {
    const out: Res[] = [];
    for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) out.push(...(await aggregate3(this.deps.client, calls.slice(i, i + MULTICALL_CHUNK))));
    return out;
  }

  /** Balances, the keeper's nonce and the wiring invariants. */
  private async checks(now: number, alerts: Alert[]): Promise<void> {
    const { cfg, book, client } = this.deps;
    const r = book.roles;
    const floors: { who: string; address: Address; min: bigint; severity: Severity }[] = [];
    if (r.keeper && cfg.KEEPER_MIN_ETH > 0n) floors.push({ who: "keeper", address: r.keeper, min: cfg.KEEPER_MIN_ETH, severity: "critical" });
    if (r.owner && cfg.OWNER_MIN_ETH > 0n) floors.push({ who: "owner", address: r.owner, min: cfg.OWNER_MIN_ETH, severity: "warning" });
    if (r.pauser && cfg.PAUSER_MIN_ETH > 0n && lc(r.pauser) !== lc(r.owner ?? "")) {
      floors.push({ who: "pauser", address: r.pauser, min: cfg.PAUSER_MIN_ETH, severity: "warning" });
    }
    const [balances, nonce] = await Promise.all([
      Promise.all(floors.map((f) => client.getBalance({ address: f.address }))),
      r.keeper ? client.getTransactionCount({ address: r.keeper, blockTag: "latest" }) : Promise.resolve(null),
    ]);
    floors.forEach((f, i) => {
      const bal = balances[i]!;
      const a = this.conditions.observe(`balance.${f.who}`, bal < f.min, now, (state) => ({
        severity: f.severity,
        title:
          state === "resolved"
            ? `${f.who} ETH back above the floor: ${formatEther(bal)} ETH`
            : `${f.who} ETH low: ${formatEther(bal)} ETH (floor ${formatEther(f.min)})`,
        lines: [
          `${f.who} ${f.address}`,
          ...(state === "resolved" ? [] : [f.who === "keeper" ? "top it up: with no gas, accruals and sweeps stop (exits are unaffected)" : "top it up: this key must be able to pause"]),
        ],
      }));
      if (a) alerts.push(a);
    });
    if (nonce !== null) {
      if (this.keeperNonce !== null && nonce > this.keeperNonce) this.lastKeeperActivityAt = now;
      this.keeperNonce = nonce;
    }
    const wiring = await this.invariants(now, alerts);
    this.deps.dispatcher.log("info", "checks", {
      eth: Object.fromEntries(floors.map((f, i) => [f.who, formatEther(balances[i]!)])),
      keeperNonce: nonce,
      wiring,
    });
  }

  /** The live wiring must match the book; a mismatch stays open until fixed. */
  private async invariants(now: number, alerts: Alert[]): Promise<{ checked: number; failing: string[]; unread: string[] }> {
    const { book, cfg, dispatcher } = this.deps;
    const r = book.roles;
    type Check = { name: string; call: Call; ok: (v: unknown) => boolean; severity: Severity; bad: (v: unknown) => string };
    const checks: Check[] = [];
    const eq = (want: Address | null | undefined) => (v: unknown) => typeof v === "string" && !!want && lc(v) === lc(want);
    for (const key of AUTH_CONTRACTS) {
      const address = book[key];
      const name = CONTRACT_NAMES[key];
      const abi = CONTRACT_ABIS[key];
      if (r.owner) {
        checks.push({ name: `${name}.owner`, call: { address, abi, functionName: "owner" }, ok: eq(r.owner), severity: "critical", bad: (v) => `${name} owner is ${this.label(v)}, expected ${this.label(r.owner)}` });
      }
      checks.push({
        name: `${name}.pendingOwner`,
        call: { address, abi, functionName: "pendingOwner" },
        ok: eq(zeroAddress),
        severity: "critical",
        bad: (v) => `${name} has a pending ownership transfer to ${this.label(v)}`,
      });
      checks.push({ name: `${name}.paused`, call: { address, abi, functionName: "paused" }, ok: (v) => v === false, severity: "critical", bad: () => `${name} is PAUSED` });
      if (r.pauser) {
        checks.push({ name: `${name}.pauser`, call: { address, abi, functionName: "pauser" }, ok: eq(r.pauser), severity: "critical", bad: (v) => `${name} pauser is ${this.label(v)}, expected ${this.label(r.pauser)}` });
      }
    }
    const cp = book.cashPark;
    checks.push({
      name: "CashPark.executor",
      call: { address: cp, abi: CONTRACT_ABIS.cashPark, functionName: "executor" },
      ok: eq(book.sweepExecutor),
      severity: "critical",
      bad: (v) => `CashPark executor is ${this.label(v)}, expected SweepExecutor ${book.sweepExecutor}`,
    });
    if (book.liveAdapter) {
      const want = book[book.liveAdapter]!;
      checks.push({
        name: "CashPark.adapter",
        call: { address: cp, abi: CONTRACT_ABIS.cashPark, functionName: "adapter" },
        ok: eq(want),
        severity: "critical",
        bad: (v) => `CashPark adapter is ${this.label(v)}, expected ${this.label(want)}`,
      });
    }
    if (r.keeper) {
      for (const key of ["sweepExecutor", "cashPark"] as const) {
        checks.push({
          name: `${CONTRACT_NAMES[key]}.isKeeper`,
          call: { address: book[key], abi: CONTRACT_ABIS[key], functionName: "isKeeper", args: [r.keeper] },
          ok: (v) => v === true,
          severity: "critical",
          bad: () => `${this.label(r.keeper)} is not a keeper on ${CONTRACT_NAMES[key]}: accruals and sweeps stop`,
        });
      }
    }
    checks.push({
      name: "StockRouter.isCaller",
      call: { address: book.stockRouter, abi: CONTRACT_ABIS.stockRouter, functionName: "isCaller", args: [book.sweepExecutor] },
      ok: (v) => v === true,
      severity: "critical",
      bad: () => "SweepExecutor is not a StockRouter caller: every sweep defers",
    });
    if (r.attestor) {
      checks.push({
        name: "ScreeningGate.attestor",
        call: { address: book.screeningGate, abi: CONTRACT_ABIS.screeningGate, functionName: "attestor" },
        ok: eq(r.attestor),
        severity: "critical",
        bad: (v) => `ScreeningGate attestor is ${this.label(v)}, expected ${this.label(r.attestor)}`,
      });
    }
    // A pinned hook's operator: whoever holds its authority sets the pool's fee
    // (keeper/hooks.ts), and the keeper holds the asset on either mismatch.
    for (const p of cfg.HOOK_PINS) {
      checks.push({
        name: `Hook ${p.symbol}.authority`,
        call: { address: p.hook, abi: fablesHookAbi as Abi, functionName: "authority" },
        ok: eq(p.hookAuthority),
        severity: "critical",
        bad: (v) => `${p.symbol} hook authority is ${this.label(v)}, pinned ${p.hookAuthority}: whoever holds it sets the ${p.symbol} pool fee; the keeper holds ${p.symbol}`,
      });
      checks.push({
        name: `Hook ${p.symbol}.maxFee`,
        call: { address: p.hook, abi: fablesHookAbi as Abi, functionName: "maxFee", args: [p.poolId] },
        ok: (v) => Number(v) > 0 && Number(v) <= p.hookFeeCap,
        severity: "critical",
        bad: (v) => `${p.symbol} pool fee cap is ${Number(v) / 10_000}% (pinned ${p.hookFeeCap / 10_000}%): the keeper holds ${p.symbol} until HOOK_PINS is reviewed`,
      });
    }
    if (book.screeningEnforced !== null) {
      checks.push({
        name: "ScreeningGate.enforced",
        call: { address: book.screeningGate, abi: CONTRACT_ABIS.screeningGate, functionName: "enforced" },
        ok: (v) => v === book.screeningEnforced,
        severity: "warning",
        bad: (v) => `ScreeningGate enforced is ${String(v)}, the book says ${String(book.screeningEnforced)}`,
      });
    }
    const res = await this.multi(checks.map((c) => c.call));
    const failing: string[] = [];
    const unread: string[] = [];
    checks.forEach((c, i) => {
      const got = res[i];
      if (!got?.ok) {
        // A reverted read is not evidence either way: the condition keeps its state.
        unread.push(c.name);
        return;
      }
      const bad = !c.ok(got.value);
      if (bad) failing.push(c.name);
      const a = this.conditions.observe(`wiring.${c.name}`, bad, now, (state) => ({
        severity: c.severity,
        title: state === "resolved" ? `${c.name} matches the book again` : c.bad(got.value),
      }));
      if (a) alerts.push(a);
    });
    if (unread.length) dispatcher.log("warn", "invariant reads failed", { unread });
    return { checked: checks.length, failing, unread };
  }

  /**
   * keeper.idle   — a linked wallet the keeper MUST act on (active rule,
   *                 Permit2 consent, cap room, a USDG balance: it is pulled or,
   *                 if idle, zero-advanced every IDLE_ADVANCE_BLOCKS) and no
   *                 keeper tx / activity for KEEPER_IDLE_MINUTES. Not
   *                 market-gated: accrual runs around the clock.
   * sweep.overdue — during the 24/5 equity session, an account due a sweep
   *                 (park value >= threshold, not swept this epoch, eligible)
   *                 for SWEEP_OVERDUE_MINUTES. The keeper sweeps every 10 min
   *                 and only waits on a closed market or a non-OK oracle.
   */
  private async liveness(now: number, alerts: Alert[]): Promise<void> {
    const { cfg, book } = this.deps;
    const byAccount = this.linkedAccounts();
    const accounts = [...byAccount.keys()];
    const wallets = accounts.flatMap((a) => byAccount.get(a)!.map((w) => ({ a, w })));
    let expecting = 0;
    const due: Address[] = [];
    if (accounts.length) {
      const x = book.sweepExecutor;
      const calls: Call[] = [
        { address: x, abi: CONTRACT_ABIS.sweepExecutor, functionName: "threshold" },
        { address: x, abi: CONTRACT_ABIS.sweepExecutor, functionName: "currentEpoch" },
        ...accounts.flatMap((a): Call[] => [
          { address: book.ruleRegistry, abi: CONTRACT_ABIS.ruleRegistry, functionName: "ruleOf", args: [a] },
          { address: x, abi: CONTRACT_ABIS.sweepExecutor, functionName: "remainingWeeklyCap", args: [a] },
          { address: book.cashPark, abi: CONTRACT_ABIS.cashPark, functionName: "valueOf", args: [a] },
          { address: x, abi: CONTRACT_ABIS.sweepExecutor, functionName: "sweptEpoch", args: [a] },
          { address: book.screeningGate, abi: CONTRACT_ABIS.screeningGate, functionName: "isEligible", args: [a] },
        ]),
        ...wallets.flatMap(({ w }): Call[] => [
          { address: USDG, abi: erc20Abi as Abi, functionName: "allowance", args: [w, PERMIT2] },
          { address: PERMIT2, abi: permit2Abi as Abi, functionName: "allowance", args: [w, USDG, x] },
          { address: USDG, abi: erc20Abi as Abi, functionName: "balanceOf", args: [w] },
        ]),
      ];
      const res = await this.multi(calls);
      const v = (i: number) => (res[i]?.ok ? (res[i] as { value: unknown }).value : undefined);
      const threshold = v(0) as bigint | undefined;
      const epoch = v(1) as bigint | undefined;
      const acc = new Map<string, { active: boolean; room: boolean }>();
      accounts.forEach((a, i) => {
        const o = 2 + i * 5;
        const rule = v(o) as { enabled?: boolean; weeklyCap?: bigint } | undefined;
        const room = v(o + 1) as bigint | undefined;
        const value = v(o + 2) as bigint | undefined;
        const swept = v(o + 3) as bigint | undefined;
        const eligible = v(o + 4) as boolean | undefined;
        acc.set(lc(a), { active: rule?.enabled === true && (rule.weeklyCap ?? 0n) > 0n, room: (room ?? 0n) > 0n });
        if (threshold !== undefined && epoch !== undefined && value !== undefined && swept !== undefined && value >= threshold && swept !== epoch && eligible === true) {
          due.push(a);
        }
      });
      const base = 2 + accounts.length * 5;
      const nowSec = BigInt(Math.floor(now / 1000));
      wallets.forEach(({ a }, j) => {
        const o = base + j * 3;
        const erc20Allowance = v(o) as bigint | undefined;
        const p2 = v(o + 1) as readonly [bigint, number, number] | undefined;
        const balance = v(o + 2) as bigint | undefined;
        const s = acc.get(lc(a));
        if (!s?.active || !s.room || erc20Allowance === undefined || !p2 || balance === undefined || balance === 0n) return;
        if (hasConsent({ erc20Allowance, permit2Amount: p2[0], permit2Expiration: BigInt(p2[1]), now: nowSec, safetySeconds: 60n })) expecting++;
      });
    }

    // Unknown last activity (fresh start, none in the scanned range): count from when we started watching.
    const idleMs = now - (this.lastKeeperActivityAt ?? this.watchingSince);
    const idle = this.conditions.observe("keeper.idle", expecting > 0 && idleMs >= cfg.KEEPER_IDLE_MINUTES * 60_000, now, (state) => ({
      severity: "warning",
      title:
        state === "resolved"
          ? "keeper activity resumed (or no wallet is waiting on it)"
          : `keeper idle for ${minutes(idleMs)} with ${expecting} wallet(s) it must accrue`,
      lines: state === "resolved" ? [] : ["check the keeper service logs and /health; a wallet with consent is pulled or zero-advanced at least every ~14h"],
    }));
    if (idle) alerts.push(idle);

    const marketOpen = equitySessionOpenedAt(Math.floor(now / 1000)) !== null;
    this.deps.dispatcher.log("info", "liveness", {
      accounts: accounts.length,
      wallets: wallets.length,
      walletsKeeperMustAccrue: expecting,
      accountsDueSweep: due.length,
      keeperIdleFor: minutes(idleMs),
      marketOpen,
    });
    if (!marketOpen) {
      // Closed market: sweeps legitimately wait; the clock restarts at the next open.
      this.sweepDueSince = null;
      return;
    }
    if (due.length) this.sweepDueSince ??= now;
    else this.sweepDueSince = null;
    const dueFor = this.sweepDueSince === null ? 0 : now - this.sweepDueSince;
    const overdue = this.conditions.observe("sweep.overdue", dueFor >= cfg.SWEEP_OVERDUE_MINUTES * 60_000, now, (state) => ({
      severity: "warning",
      title: state === "resolved" ? "overdue sweeps cleared" : `${due.length} account(s) due a sweep for ${minutes(dueFor)} during market hours`,
      lines:
        state === "resolved"
          ? []
          : [`e.g. ${due.slice(0, 3).join(", ")}`, "the keeper waits while any leg's oracle is not OK or its market is closed: see its sweep log line (\"waiting: ...\")"],
    }));
    if (overdue) alerts.push(overdue);
  }

  /** The keeper's own /health: reachable, ok, and ticking. */
  private async keeperHealth(now: number, alerts: Alert[]): Promise<void> {
    const { cfg } = this.deps;
    const f = this.deps.fetch ?? (fetch as unknown as Fetch);
    let body: KeeperHealthBody | null = null;
    let problem = "";
    try {
      const headers: Record<string, string> = cfg.KEEPER_HEALTH_TOKEN ? { authorization: `Bearer ${cfg.KEEPER_HEALTH_TOKEN}` } : {};
      const res = await f(cfg.KEEPER_HEALTH_URL!, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as KeeperHealthBody;
    } catch (err) {
      problem = redact(errorSummary(err), this.secrets);
    }
    if (body === null) this.keeperHealthFailingSince ??= now;
    else this.keeperHealthFailingSince = null;
    const downFor = this.keeperHealthFailingSince === null ? 0 : now - this.keeperHealthFailingSince;
    const push = (a: Alert | null) => a && alerts.push(a);
    push(
      this.conditions.observe("keeper.unreachable", downFor >= cfg.RPC_DOWN_MINUTES * 60_000, now, (state) => ({
        severity: "critical",
        title: state === "resolved" ? "keeper /health reachable again" : `keeper /health unreachable for ${minutes(downFor)}: ${problem}`,
      })),
    );
    if (body === null) return;
    const reasons = Array.isArray(body.reasons) ? body.reasons.map((x) => redact(String(x), this.secrets)).slice(0, 5) : [];
    push(
      this.conditions.observe("keeper.unhealthy", body.ok === false, now, (state) => ({
        severity: "warning",
        title: state === "resolved" ? "keeper reports healthy again" : `keeper reports unhealthy: ${reasons.join("; ") || "no detail (set KEEPER_HEALTH_TOKEN to see why)"}`,
      })),
    );
    const newest = body.recent?.[0]?.at ? Date.parse(body.recent[0].at) : NaN;
    const uptimeMs = typeof body.uptimeSec === "number" ? body.uptimeSec * 1000 : 0;
    const staleMs = cfg.KEEPER_TICK_STALE_MINUTES * 60_000;
    const ticked = Number.isNaN(newest) ? null : now - newest;
    const stalled = body.started === true && (ticked === null ? uptimeMs >= staleMs : ticked >= staleMs);
    push(
      this.conditions.observe("keeper.stalled", stalled, now, (state) => ({
        severity: "critical",
        title: state === "resolved" ? "keeper ticking again" : `keeper has not ticked for ${ticked === null ? "its whole uptime" : minutes(ticked)}`,
        lines: state === "resolved" ? [] : ["the process answers /health but its accrue / sweep loop is stuck: restart the keeper service"],
      })),
    );
  }

  private rpcHealth(now: number, err: unknown, alerts: Alert[]): void {
    const { cfg, dispatcher } = this.deps;
    if (err !== null) {
      this.rpcFailingSince ??= now;
      this.lastRpcError = redact(errorSummary(err), this.secrets);
      dispatcher.log("warn", "rpc error", { error: this.lastRpcError, failingForMs: now - this.rpcFailingSince, cursor: this.cursor });
    } else {
      this.rpcFailingSince = null;
    }
    const downFor = this.rpcFailingSince === null ? 0 : now - this.rpcFailingSince;
    const a = this.conditions.observe("rpc.down", downFor >= cfg.RPC_DOWN_MINUTES * 60_000, now, (state, since) => ({
      severity: "critical",
      title: state === "resolved" ? `RPC healthy again (alerted ${minutes(now - since)} ago)` : `RPC failing for ${minutes(downFor)}: ${this.lastRpcError}`,
      lines: state === "resolved" ? [] : [`the monitor is blind past block ${this.cursor}; the keeper uses its own RPC_URL, check it too`],
    }));
    if (a) alerts.push(a);
  }
}
