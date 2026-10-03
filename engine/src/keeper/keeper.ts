/**
 * SPARE keeper — accrues round-ups and sweeps them into stocks.
 *
 *   accrue tick: for every ACTIVE account's linked wallets, scan the wallet's
 *                outgoing USDG payments incrementally, price each payment with
 *                the rule IN FORCE AT THAT PAYMENT (RuleSet history, ordered by
 *                block and log index), clamp to the rolling weekly cap / Permit2
 *                allowance / USDG->Permit2 allowance / balance, pre-flight each
 *                entry alone, and send one accrueBatch.
 *   sweep tick:  for every account over the threshold and not yet swept this
 *                epoch, classify each leg (ok / safe-settle / wait), split the
 *                due accounts into sweep calls so no account's price impact
 *                sets another's limit (batches.ts), and for each call in turn
 *                net the quotable legs per asset exactly as the executor will,
 *                quote each netted swap on the v4 Quoter, check the quote
 *                against the oracle, drop accounts holding an asset that fails
 *                either, and send `sweep(accounts, limits)`. A hooked pool's
 *                fee is the hook's own, checked against its pin (hooks.ts);
 *                every asset an isolated call bought waits, this tick and
 *                after, until its pool's $1 quote is back where it was
 *                (batches.ts recoveryHeld).
 *                The universe is the AssetRegistry's (no token list here):
 *                asset state and quotes are batched Multicall3 reads however
 *                many assets are registered, and a call is capped by
 *                distinct assets / legs / estimated gas so a sweep over
 *                dozens of assets still fits in a block.
 *
 * Every cursor is on-chain, so a restart resumes exactly. In-memory state is
 * only an optimisation or a safety brake: RuleSet history and account set
 * (rebuilt from logs), per-wallet scan progress, per-wallet backoff.
 *
 * Single-writer hygiene (the contract does not bind an accrual amount to its
 * fromBlock): reads are pinned to one block at or above our last mined tx, a
 * tick is skipped while a keeper tx is pending, and each entry's window start
 * is re-read at latest right before sending. run.ts delays the first tick and
 * drains on SIGTERM so an overlapping deployment does not double-pull.
 */
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseAbiItem,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  aggregatorV3Abi,
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  feeVaultAbi,
  permit2Abi,
  ruleRegistryAbi,
  screeningGateAbi,
  sgovParkAdapterAbi,
  stockRouterAbi,
  stockTokenAbi,
  sweepExecutorAbi,
  usdgParkAdapterAbi,
} from "../chain/abis.ts";
import { MULTICALL3, PERMIT2, USDG, VENUE } from "../chain/constants.ts";
import { classifyLogError, transfersFrom } from "../chain/logs.ts";
import { makeClassifier, type Classifier } from "../lib/payments.ts";
import { heldPools, partitionSweep, planCall, recoveryHeld, REF_SWAP_IN, type Due, type Market, type QuoteReq, type Recovery } from "./batches.ts";
import { budgetedLogs, scanEach, type ScanBudget } from "./budget.ts";
import type { Book, KeeperConfig } from "./config.ts";
import { aggregate3, type Got, type Read } from "./multicall.ts";
import {
  accountReady,
  accrualFrom,
  accrueGasFloor,
  assetState,
  capSweepBatch,
  decideAccrual,
  equityMarketOpen,
  GAS_STEPS_PCT,
  gasLimit,
  hasConsent,
  insertRuleEvent,
  nextBackoffMs,
  nextScanSpan,
  poolFeePips,
  priceAt,
  pullableNow,
  safeToBlock,
  splitPending,
  withoutAssets,
  type Leg,
  type LegState,
  type RuleEvent,
} from "./plan.ts";
import { fablesHookAbi, hookVerdict, type HookPin } from "./hooks.ts";
import { KEEPER_EXTRA_VENUE, V3PoolResolver } from "./venue.ts";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function paused() view returns (bool)",
]);

const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const POOL_KEY_PARAMS = parseAbiParameters("address, address, uint24, int24, address");

const RR_EVENTS = [
  parseAbiItem("event Linked(address indexed account, address indexed wallet)"),
  parseAbiItem("event Unlinked(address indexed account, address indexed wallet)"),
  parseAbiItem("event RuleSet(address indexed account, uint8 roundTo, uint8 multiplier, uint64 weeklyCap, bool enabled)"),
] as const;

const PERMIT2_EXPIRY_SAFETY = 60n; // seconds of Permit2 expiry headroom we require
/** Discovery stays this far behind head: a lagging RPC node may truncate the newest blocks silently. */
const DISCOVERY_LAG = 64n;
const MAX_BATCH = 64;
const SIM_CONCURRENCY = 16;
const READ_CONCURRENCY = 4;
/** Quotes per eth_call: each V4Quoter call simulates a swap, so a big probe set is split under the node's eth_call gas cap. */
const QUOTE_CHUNK = 24;
/** Smallest span a wallet scan is cut down to after overrunning its budget. */
const MIN_SCAN_SPAN = 1_000n;

export interface TickReport {
  at: string;
  kind: "accrue" | "sweep";
  ok: boolean;
  detail: string;
  tx?: `0x${string}`;
}

type Kind = "accrue" | "sweep";
type Call = Read;
type Res = Got;

interface Rule {
  roundTo: number;
  multiplier: number;
  weeklyCap: bigint;
  enabled: boolean;
}
interface AccountView {
  account: Address;
  rule: Rule;
  wallets: readonly Address[];
  activeSince: bigint;
  remaining: bigint;
}
interface WalletView {
  last: bigint;
  linkedAt: bigint;
  permit2Amount: bigint;
  permit2Expiration: bigint;
  erc20Allowance: bigint;
  balance: bigint;
}
/** Incremental scan of one wallet's window (from, scannedTo]. Valid while `from` and `ctx` hold. */
interface Scan {
  from: bigint;
  ctx: string;
  scannedTo: bigint;
  delta: bigint;
  payments: number;
}
/**
 * A wallet held back after failures, counted by kind: a scan that overran or
 * failed, and an accrual that could not be pulled (pre-flight revert,
 * AccrualSkipped, a batch that accrued nothing). A clean scan clears the scan
 * count and only an Accrued clears both, so a wallet whose window scans fine
 * but whose pull keeps failing still backs off to the cap.
 */
interface Backoff {
  scan: number;
  accrue: number;
  until: number;
  reason: string;
}
interface Entry {
  account: Address;
  wallet: Address;
  amount: bigint;
  toBlock: bigint;
  /** The window start the amount was priced from. */
  from: bigint;
}
/** What a wallet's past scans taught: how many blocks fit its budget, and the accrue tick it was last tried in. */
interface ScanMeta {
  span: bigint;
  tried: number;
}
interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** v4 PoolId: keccak256(abi.encode(PoolKey)). */
function poolIdOf(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_PARAMS, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}
interface AssetInfo {
  asset: Address;
  state: LegState;
  poolKey?: PoolKey;
  why?: string;
}

const lc = (a: string) => a.toLowerCase();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (err: unknown) => ((err as Error)?.message ?? String(err)).split("\n")[0] ?? "error";

async function eachLimit<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

/** The distinct assets the entries' legs swap into (state "ok": quoted and bought, not waiting or safe-settled). */
function quotedAssets(entries: readonly { legs: readonly Leg[] }[], state: ReadonlyMap<string, AssetInfo>): Address[] {
  const out = new Map<string, Address>();
  for (const e of entries) for (const l of e.legs) if (state.get(lc(l.asset))?.state === "ok") out.set(lc(l.asset), l.asset);
  return [...out.values()];
}

/** Why a simulated call reverted, or null when the failure was not a revert (RPC trouble). */
function revertReason(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!rev) return null;
  return rev.data?.errorName ?? rev.reason ?? rev.signature ?? rev.shortMessage;
}

/** Every custom error a keeper call can revert with: the executor's, and those of every contract it calls. */
const REVERTS = [
  ...sweepExecutorAbi,
  ...cashParkAbi,
  ...stockRouterAbi,
  ...permit2Abi,
  ...ruleRegistryAbi,
  ...electionRegistryAbi,
  ...screeningGateAbi,
  ...assetRegistryAbi,
  ...feeVaultAbi,
  ...usdgParkAdapterAbi,
  ...sgovParkAdapterAbi,
].filter((x) => x.type === "error") as Abi;

/** Revert data by name: Error(string) as its message, a custom error by name (and its arguments), else the selector. */
function decodeReason(data: Hex, withArgs = false): string {
  try {
    const d = decodeErrorResult({ abi: REVERTS, data });
    if (d.errorName === "Error") return String(d.args?.[0]);
    return withArgs && d.args?.length ? `${d.errorName}(${d.args.map(String).join(", ")})` : d.errorName;
  } catch {
    return data.slice(0, 10);
  }
}

/**
 * A failed tick in one line. viem's first line drops a revert's reason (`The
 * contract function "sweep" reverted.`), so a revert is named by its decoded
 * error and arguments, e.g. `sweep reverted: OutsideOracleBand(1, 2)`; any
 * other failure, or a revert that carries no reason, by that first line.
 */
function tickError(err: unknown): string {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const why = rev?.raw && rev.raw !== "0x" ? decodeReason(rev.raw, true) : rev?.reason && rev.reason !== "execution reverted" ? rev.reason : null;
    if (why) {
      const call = err.walk((e) => e instanceof ContractFunctionExecutionError) as ContractFunctionExecutionError | null;
      return `${call?.functionName ?? "call"} reverted: ${why}`;
    }
  }
  return short(err);
}

export class Keeper {
  /** Reads (JSON-RPC batched). */
  readonly client: PublicClient;
  /** eth_getLogs only: never folded into a JSON-RPC batch with other calls. */
  readonly logClient: PublicClient;
  readonly wallet: WalletClient;
  readonly account: PrivateKeyAccount;
  /** Every account that ever linked a wallet. */
  readonly accounts = new Set<Address>();
  /** RuleSet history per account, sorted by (block, logIndex). */
  readonly rules = new Map<Address, RuleEvent[]>();
  readonly history: TickReport[] = [];
  lastEth: bigint | null = null;

  private discoveredTo: bigint;
  private readonly dormantUntil = new Map<Address, number>();
  private readonly scans = new Map<string, Scan>();
  private readonly scanMeta = new Map<string, ScanMeta>();
  private readonly backoff = new Map<string, Backoff>();
  private readonly pools: V3PoolResolver;
  /** HOOK_PINS by asset (lower-cased). */
  private readonly hookPins: Map<string, HookPin>;
  private readonly warned = new Set<string>();
  private busy = false;
  private stopping = false;
  /** Where the next sweep tick starts in the ready list (fairness when more are due than fit). */
  private sweepRotation = 0;
  /** Assets an isolated call bought, held until their pool recovers (A-M1, batches.ts recoveryHeld), by asset (lower-cased). */
  private readonly recovering = new Map<string, Recovery>();
  private readonly pending = new Set<Kind>();
  private lastTxBlock = 0n;
  private inflight: { hash: Hex; sentAt: number } | undefined;
  private readonly bad: Record<Kind, number> = { accrue: 0, sweep: 0 };
  private noProgress = 0;
  /** Accrue ticks run so far: when each wallet was last tried (ScanMeta.tried). */
  private accrueRound = 0;
  /** Each tx kind's step in GAS_STEPS_PCT; raised by outOfGas(). */
  private readonly gasStep: Record<"accrueBatch" | "sweep", number> = { accrueBatch: 0, sweep: 0 };

  constructor(
    readonly cfg: KeeperConfig,
    readonly book: Book,
    /** Serves every client instead of HTTP to RPC_URL (the unit tests' fake chain). */
    transport?: Transport,
  ) {
    const chain = defineChain({
      id: cfg.CHAIN_ID,
      name: cfg.CHAIN_ID === 4663 ? "Robinhood Chain" : `chain ${cfg.CHAIN_ID}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.RPC_URL] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    });
    this.client = createPublicClient({
      chain,
      transport: transport ?? http(cfg.RPC_URL, { timeout: 20_000, retryCount: 3, batch: { batchSize: 50, wait: 10 } }),
    }) as PublicClient;
    this.logClient = createPublicClient({
      chain,
      transport: transport ?? http(cfg.RPC_URL, { timeout: 30_000, retryCount: 3 }),
    }) as PublicClient;
    this.account = privateKeyToAccount(cfg.KEEPER_PK as `0x${string}`);
    this.wallet = createWalletClient({ account: this.account, chain, transport: transport ?? http(cfg.RPC_URL, { timeout: 30_000 }) });
    this.discoveredTo = book.startBlock > 0n ? book.startBlock - 1n : 0n;
    this.pools = new V3PoolResolver(this.client);
    this.hookPins = new Map(cfg.HOOK_PINS.map((p) => [lc(p.token), p]));
  }

  private log(r: Omit<TickReport, "at">) {
    const rep = { at: new Date().toISOString(), ...r };
    this.history.unshift(rep);
    this.history.length = Math.min(this.history.length, 50);
    const line = `[keeper:${r.kind}] ${r.ok ? "ok" : "FAIL"} ${r.detail}${r.tx ? ` tx ${r.tx}` : ""}`;
    if (r.ok) console.log(line);
    else console.warn(line);
  }

  private warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    if (this.warned.size > 10_000) this.warned.clear();
    this.warned.add(key);
    console.warn(msg);
  }

  /**
   * Serialise ticks: one keeper transaction in flight at a time. A tick that
   * arrives while another runs is queued (not dropped), and a queued sweep
   * runs before a queued accrue, so a long accrue tick cannot starve sweeps.
   */
  async run(kind: Kind): Promise<void> {
    if (this.stopping) return;
    if (this.busy) {
      this.pending.add(kind);
      return;
    }
    this.busy = true;
    try {
      let next: Kind | undefined = kind;
      while (next && !this.stopping) {
        this.pending.delete(next);
        await this.tick(next);
        next = this.pending.has("sweep") ? "sweep" : this.pending.has("accrue") ? "accrue" : undefined;
      }
    } finally {
      this.busy = false;
    }
  }

  private async tick(kind: Kind): Promise<void> {
    try {
      if (kind === "accrue") await this.accrueTick();
      else await this.sweepTick();
      this.bad[kind] = 0;
    } catch (err) {
      this.bad[kind]++;
      this.log({ kind, ok: false, detail: tickError(err) });
    }
  }

  /** Stop taking ticks and wait (bounded) for the one in flight to finish. */
  async stop(maxWaitMs = 120_000): Promise<void> {
    this.stopping = true;
    const t0 = Date.now();
    while (this.busy && Date.now() - t0 < maxWaitMs) await sleep(200);
  }

  health() {
    const reasons: string[] = [];
    const n = this.cfg.HEALTH_MAX_BAD_TICKS;
    if (this.bad.accrue >= n) reasons.push(`accrue tick failed ${this.bad.accrue}x in a row`);
    if (this.bad.sweep >= n) reasons.push(`sweep tick failed ${this.bad.sweep}x in a row`);
    if (this.noProgress >= n) reasons.push(`accrue attempts accrued nothing ${this.noProgress}x in a row`);
    if (this.lastEth !== null && this.lastEth < this.cfg.LOW_GAS_WEI) reasons.push(`low gas: ${formatEther(this.lastEth)} ETH`);
    const now = Date.now();
    return {
      ok: reasons.length === 0,
      reasons,
      consecutiveFailures: { ...this.bad },
      noProgressAttempts: this.noProgress,
      eth: this.lastEth === null ? null : formatEther(this.lastEth),
      walletsBackedOff: [...this.backoff.values()].filter((b) => b.until > now).length,
      /** Assets held after an isolated sweep until their pool's $1 quote recovers (A-M1). */
      assetsRecovering: [...this.recovering.values()].map((r) => r.asset),
      dormantAccounts: [...this.dormantUntil.values()].filter((t) => t > now).length,
      inflightTx: this.inflight?.hash ?? null,
      discoveredTo: this.discoveredTo.toString(),
      /** Gas limit sent, as a multiple of the estimate (raised after an out-of-gas sign). */
      gasMultiplier: { accrueBatch: GAS_STEPS_PCT[this.gasStep.accrueBatch]! / 100, sweep: GAS_STEPS_PCT[this.gasStep.sweep]! / 100 },
    };
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /**
   * One Multicall3 eth_call (multicall.ts): a call that reverts fails alone;
   * an eth_call that fails at the RPC throws, so every caller's catch sees it.
   */
  private multi(calls: readonly Call[], blockNumber?: bigint): Promise<Res[]> {
    return aggregate3(this.client, calls, blockNumber);
  }

  /**
   * Multicall `per(item)` for every item, READ_CHUNK items per eth_call. A
   * failed chunk only loses its own items (logged), never the whole tick, and
   * makes the read incomplete: its items are unknown, not absent.
   */
  private async readEach<T>(
    items: readonly T[],
    per: (t: T) => Call[],
    blockNumber: bigint | undefined,
    label: string,
  ): Promise<{ results: Map<T, Res[]>; complete: boolean }> {
    const results = new Map<T, Res[]>();
    let complete = true;
    const size = this.cfg.READ_CHUNK;
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size) as T[]);
    await eachLimit(chunks, READ_CONCURRENCY, async (chunk) => {
      const calls = chunk.map(per);
      try {
        const flat = await this.multi(calls.flat(), blockNumber);
        let k = 0;
        chunk.forEach((t, j) => {
          const n = calls[j]!.length;
          results.set(t, flat.slice(k, k + n));
          k += n;
        });
      } catch (err) {
        complete = false;
        console.warn(`[keeper] ${label} read failed for ${chunk.length} item(s): ${short(err)}`);
      }
    });
    return { results, complete };
  }

  /** Reads pinned a hair behind head (a node may not have `head` yet), never below our last mined tx. */
  private readBlockFor(head: bigint): bigint {
    return head - 2n >= this.lastTxBlock ? head - 2n : head;
  }

  /** A reason to skip this tick, or null. Keeps one keeper tx in flight, and never reads behind it. */
  private async txGuard(head: bigint): Promise<string | null> {
    if (head < this.lastTxBlock) return `RPC head ${head} is behind our last tx block ${this.lastTxBlock}`;
    if (this.inflight) {
      const r = await this.client.getTransactionReceipt({ hash: this.inflight.hash }).catch(() => null);
      if (r) {
        if (r.blockNumber > this.lastTxBlock) this.lastTxBlock = r.blockNumber;
        this.inflight = undefined;
        if (head < r.blockNumber) return `RPC head ${head} is behind our last tx block ${r.blockNumber}`;
      } else {
        const [p, l] = await this.nonces();
        if (p === l && Date.now() - this.inflight.sentAt > 300_000) {
          console.warn(`[keeper] tx ${this.inflight.hash} was never mined; releasing`);
          this.inflight = undefined;
        } else {
          return `waiting for tx ${this.inflight.hash}`;
        }
      }
    }
    if (this.cfg.KEEPER_BROADCAST === "1") {
      const [p, l] = await this.nonces();
      if (p > l) return `keeper has ${p - l} pending tx(s)`;
    }
    return null;
  }

  private nonces(): Promise<[number, number]> {
    return Promise.all([
      this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
      this.client.getTransactionCount({ address: this.account.address, blockTag: "latest" }),
    ]);
  }

  // ── discovery ─────────────────────────────────────────────────────────

  /**
   * Linked / Unlinked / RuleSet from the RuleRegistry, up to head - DISCOVERY_LAG.
   * Builds the account set, each account's rule history (to price a payment
   * with the rule in force at it) and wakes dormant accounts on any change.
   * A result-capped range is halved; `discoveredTo` only moves on success.
   */
  async discover(head: bigint): Promise<void> {
    const target = head > DISCOVERY_LAG ? head - DISCOVERY_LAG : 0n;
    const max = BigInt(this.cfg.LOGS_MAX_RANGE);
    let step = max;
    let from = this.discoveredTo + 1n;
    while (from <= target) {
      const to = from + step - 1n < target ? from + step - 1n : target;
      let logs;
      try {
        logs = await this.logClient.getLogs({ address: this.book.ruleRegistry, events: RR_EVENTS, fromBlock: from, toBlock: to });
      } catch (err) {
        if (classifyLogError(err) === "result-cap" && step > 1n) {
          step = step / 2n;
          continue;
        }
        throw err;
      }
      for (const l of logs) {
        if (l.removed || l.blockNumber === null || l.logIndex === null) continue;
        const account = l.args.account;
        if (!account) continue;
        this.dormantUntil.delete(account);
        if (l.eventName === "Linked") this.accounts.add(account);
        if (l.eventName === "RuleSet") {
          const a = l.args as { roundTo?: number; multiplier?: number; weeklyCap?: bigint; enabled?: boolean };
          let h = this.rules.get(account);
          if (!h) this.rules.set(account, (h = []));
          insertRuleEvent(h, {
            blockNumber: l.blockNumber,
            logIndex: l.logIndex,
            roundTo: Number(a.roundTo),
            multiplier: Number(a.multiplier),
            weeklyCap: a.weeklyCap ?? 0n,
            enabled: a.enabled === true,
          });
        }
      }
      this.discoveredTo = to;
      from = to + 1n;
      if (step < max) step = step * 2n > max ? max : step * 2n;
    }
  }

  // ── accrual ───────────────────────────────────────────────────────────

  private fail(wallet: Address, kind: "scan" | "accrue", reason: string) {
    const k = lc(wallet);
    const b = this.backoff.get(k) ?? { scan: 0, accrue: 0, until: 0, reason };
    const failures = ++b[kind];
    const ms = nextBackoffMs(failures, this.cfg.BACKOFF_BASE_MS, this.cfg.BACKOFF_MAX_MS);
    b.until = Date.now() + ms;
    b.reason = reason;
    this.backoff.set(k, b);
    console.warn(`[keeper:accrue] ${wallet} backed off ${Math.round(ms / 60_000)}m (${failures}x): ${reason}`);
  }

  /** A clean scan: the wallet's scan failures are over (its accrual failures are not). */
  private scanned(wallet: Address) {
    const k = lc(wallet);
    const b = this.backoff.get(k);
    if (!b) return;
    b.scan = 0;
    if (b.accrue === 0) this.backoff.delete(k);
  }

  private scanFor(wallet: Address, from: bigint, ctx: string): Scan {
    const k = lc(wallet);
    let s = this.scans.get(k);
    if (!s || s.from !== from || s.ctx !== ctx) {
      s = { from, ctx, scannedTo: from, delta: 0n, payments: 0 };
      this.scans.set(k, s);
    }
    return s;
  }

  /**
   * Scan the next slice of (scannedTo, toBlock], at most `span` blocks, with
   * every RPC call charged to `budget`. Commits only after every payment in
   * it is priced, and only while the scan still owns the window: not
   * abandoned at its deadline, and not advanced by anyone else meanwhile.
   */
  private async scanWallet(
    s: Scan,
    wallet: Address,
    classifier: Classifier,
    history: readonly RuleEvent[],
    toBlock: bigint,
    span: bigint,
    budget: ScanBudget,
  ): Promise<void> {
    const start = s.scannedTo;
    const to = start + span < toBlock ? start + span : toBlock;
    const logs = await transfersFrom(budgetedLogs(this.logClient, budget), {
      token: USDG,
      wallet,
      fromBlock: start + 1n,
      toBlock: to,
      maxRange: BigInt(this.cfg.LOGS_MAX_RANGE),
      maxChunks: 1_000,
      finalBlock: to,
      concurrency: 2,
      cache: false,
    });
    const open = logs.filter((t) => classifier.classify(t.to) === null);
    // A Transfer straight into a canonical Uniswap v3 pool is a swap / LP leg, not spending.
    const pools = open.length ? await this.pools.pools(open.map((t) => t.to), () => budget.call()) : new Set<string>();
    let delta = 0n;
    let payments = 0;
    for (const t of open) {
      if (pools.has(lc(t.to))) continue;
      payments++;
      delta += priceAt(history, t);
    }
    budget.check();
    if (s.scannedTo !== start) throw new Error(`window moved ${start} -> ${s.scannedTo} during the scan; result dropped`);
    s.delta += delta;
    s.payments += payments;
    s.scannedTo = to;
  }

  async accrueTick(): Promise<void> {
    const x = this.book.sweepExecutor;
    const rr = this.book.ruleRegistry;
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const skip = await this.txGuard(head);
    if (skip) return this.log({ kind: "accrue", ok: true, detail: `skipping: ${skip}` });
    const readBlock = this.readBlockFor(head);
    const [paused, finalityBuffer, usdgPaused] = await Promise.all([
      this.client.readContract({ address: x, abi: sweepExecutorAbi, functionName: "paused", blockNumber: readBlock }),
      this.client.readContract({ address: x, abi: sweepExecutorAbi, functionName: "finalityBuffer", blockNumber: readBlock }),
      this.client
        .readContract({ address: USDG, abi: erc20Abi, functionName: "paused", blockNumber: readBlock })
        .catch(() => false),
    ]);
    if (paused) return this.log({ kind: "accrue", ok: true, detail: "executor paused; skipping" });
    if (usdgPaused) return this.log({ kind: "accrue", ok: true, detail: "USDG paused (every pull would revert); skipping" });
    try {
      await this.discover(head);
    } catch (err) {
      this.log({ kind: "accrue", ok: false, detail: `discovery stalled at ${this.discoveredTo}: ${short(err)}` });
    }
    // Rule history must cover every payment priced, so never scan past discovery.
    const safe = safeToBlock(head, finalityBuffer, BigInt(this.cfg.FINALITY_MARGIN));
    const toBlock = safe < this.discoveredTo ? safe : this.discoveredTo;
    const nowMs = Date.now();
    const now = BigInt(Math.floor(nowMs / 1000));
    const idle = BigInt(this.cfg.IDLE_ADVANCE_BLOCKS);

    // 1. Account state, skipping dormant accounts (no rule / no wallets) until an event or the recheck.
    const due = [...this.accounts].filter((a) => (this.dormantUntil.get(a) ?? 0) <= nowMs);
    const acc = await this.readEach(
      due,
      (a): Call[] => [
        { address: rr, abi: ruleRegistryAbi, functionName: "ruleOf", args: [a] },
        { address: rr, abi: ruleRegistryAbi, functionName: "walletsOf", args: [a] },
        { address: rr, abi: ruleRegistryAbi, functionName: "activeSince", args: [a] },
        { address: x, abi: sweepExecutorAbi, functionName: "remainingWeeklyCap", args: [a] },
      ],
      readBlock,
      "account",
    );
    const spare = Object.values(this.book).filter((v): v is Address => typeof v === "string");
    const venue = [...Object.values(VENUE), ...KEEPER_EXTRA_VENUE] as Address[];
    const active: { view: AccountView; classifier: Classifier; ctx: string; history: RuleEvent[] }[] = [];
    let unread = 0;
    for (const [account, r] of acc.results) {
      if (!r.every((x) => x.ok)) {
        unread++;
        console.warn(`[keeper:accrue] account ${account} read failed; skipped this tick`);
        continue;
      }
      const [rule, wallets, activeSince, remaining] = r.map((x) => (x as { value: unknown }).value) as [
        Rule,
        readonly Address[],
        bigint,
        bigint,
      ];
      if (!rule.enabled || rule.weeklyCap === 0n || wallets.length === 0) {
        this.dormantUntil.set(account, nowMs + this.cfg.DORMANT_RECHECK_MS);
        continue;
      }
      const history = this.rules.get(account);
      if (!history?.length) {
        // Activated after discovery's reach: nothing is accruable yet (toBlock <= discoveredTo).
        // Activated before it with no RuleSet seen: history is incomplete; never guess a price.
        if (activeSince <= this.discoveredTo) {
          this.warnOnce(`nohist:${account}`, `[keeper:accrue] ${account} has an active rule but no RuleSet history (startBlock too late?); not accruing it`);
        }
        continue;
      }
      active.push({
        view: { account, rule, wallets, activeSince, remaining },
        classifier: makeClassifier({ account, linkedWallets: wallets, spareContracts: spare, venue }),
        ctx: `${lc(account)}|${wallets.map(lc).sort().join(",")}`,
        history,
      });
    }

    // 2. Wallet state.
    const pairs = active.flatMap((a) => a.view.wallets.map((w) => ({ a, w })));
    const wr = await this.readEach(
      pairs,
      ({ w }): Call[] => [
        { address: x, abi: sweepExecutorAbi, functionName: "lastAccruedBlock", args: [w] },
        { address: rr, abi: ruleRegistryAbi, functionName: "linkedAt", args: [w] },
        { address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [w, USDG, x] },
        // The pull also needs the ERC-20 approval Permit2 spends through.
        { address: USDG, abi: erc20Abi, functionName: "allowance", args: [w, PERMIT2] },
        { address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [w] },
      ],
      readBlock,
      "wallet",
    );

    // 3. What to scan. A wallet that cannot be pulled now (no consent, or no
    //    USDG balance, Permit2 allowance, USDG allowance or cap room left) is
    //    scanned only once its window is wide (to learn whether it is idle),
    //    and not at all once it is known to hold round-ups: it waits until it
    //    can be pulled, it is never zero-advanced. So a linked wallet with
    //    nothing to pull costs one scan per IDLE_ADVANCE_BLOCKS, not one a tick.
    interface Job {
      a: (typeof active)[number];
      w: Address;
      v: WalletView;
      from: bigint;
      consent: boolean;
      /** pullableNow(): what a pull could take now (scan order). */
      pullable: bigint;
      scan: Scan;
      failed?: boolean;
      /** A clean scan's blocks covered and share of its budget spent (nextScanSpan). */
      fit?: { blocks: bigint; used: number };
    }
    const jobs: Job[] = [];
    const seen = new Set<string>();
    for (const p of pairs) {
      seen.add(lc(p.w));
      const r = wr.results.get(p);
      if (!r || !r.every((x) => x.ok)) continue;
      const [last, linkedAt, p2, erc20Allowance, balance] = r.map((x) => (x as { value: unknown }).value) as [
        bigint,
        bigint,
        readonly [bigint, number, number],
        bigint,
        bigint,
      ];
      const v: WalletView = {
        last,
        linkedAt,
        permit2Amount: p2[0],
        permit2Expiration: BigInt(p2[1]),
        erc20Allowance,
        balance,
      };
      const from = accrualFrom(last, linkedAt, p.a.view.activeSince);
      if (toBlock <= from) continue;
      const bo = this.backoff.get(lc(p.w));
      if (bo && bo.until > nowMs) continue;
      const consent = hasConsent({
        erc20Allowance: v.erc20Allowance,
        permit2Amount: v.permit2Amount,
        permit2Expiration: v.permit2Expiration,
        now,
        safetySeconds: PERMIT2_EXPIRY_SAFETY,
      });
      const pullable = pullableNow({
        consent,
        balance: v.balance,
        permit2Amount: v.permit2Amount,
        erc20Allowance: v.erc20Allowance,
        capRoom: p.a.view.remaining,
      });
      const scan = this.scanFor(p.w, from, p.a.ctx);
      if (pullable === 0n && (toBlock - from < idle || scan.delta > 0n)) continue;
      jobs.push({ a: p.a, w: p.w, v, from, consent, pullable, scan });
    }
    // Forget the scan state of wallets no longer linked, and only then: after a
    // read that failed (an eth_call, or one account's calls), a wallet missing
    // from `seen` may be one we could not see, and its progress and learned
    // span must survive the blip.
    if (acc.complete && wr.complete && unread === 0) {
      for (const k of this.scans.keys()) if (!seen.has(k)) this.scans.delete(k);
      for (const k of this.scanMeta.keys()) if (!seen.has(k)) this.scanMeta.delete(k);
    }

    // 4. Scan in parallel, each wallet under its own budget (calls, logs,
    //    deadline) and all of them under the tick's deadline. Wallets last
    //    tried in the oldest tick first, so a tick that runs out of time never
    //    starves the same wallets; within a tick, the most pullable first, so
    //    the wallets with the most to pull are scanned before the rest when
    //    there is not time for all. An overrun or failure backs off that
    //    wallet only; an overrun also halves the span its next scan covers. A
    //    clean scan ends the wallet's scan backoff (a busy wallet with nothing
    //    to pull is never Accrued, and must not climb to the cap for overruns
    //    it has outgrown) and grows its span only with budget to spare.
    const maxSpan = BigInt(this.cfg.SCAN_MAX_BLOCKS);
    const metaOf = (w: Address): ScanMeta => {
      let m = this.scanMeta.get(lc(w));
      if (!m) this.scanMeta.set(lc(w), (m = { span: maxSpan, tried: 0 }));
      if (m.span > maxSpan) m.span = maxSpan;
      return m;
    };
    const round = ++this.accrueRound;
    const toScan = jobs
      .filter((j) => j.scan.scannedTo < toBlock)
      .sort((a, b) => metaOf(a.w).tried - metaOf(b.w).tried || (b.pullable > a.pullable ? 1 : b.pullable < a.pullable ? -1 : 0));
    const scanned = await scanEach(toScan, {
      concurrency: this.cfg.SCAN_CONCURRENCY,
      tickDeadlineAt: Date.now() + this.cfg.SCAN_TICK_DEADLINE_MS,
      limits: {
        maxCalls: this.cfg.SCAN_WALLET_MAX_CALLS,
        maxLogs: this.cfg.SCAN_WALLET_MAX_LOGS,
        deadlineMs: this.cfg.SCAN_WALLET_DEADLINE_MS,
      },
      scan: async (j, budget) => {
        const meta = metaOf(j.w);
        meta.tried = round;
        const start = j.scan.scannedTo;
        await this.scanWallet(j.scan, j.w, j.a.classifier, j.a.history, toBlock, meta.span, budget);
        j.fit = { blocks: j.scan.scannedTo - start, used: budget.used() };
      },
    });
    for (const j of scanned.done) {
      const meta = metaOf(j.w);
      meta.span = nextScanSpan(meta.span, { ok: true, ...(j.fit ?? { blocks: 0n, used: 1 }) }, MIN_SCAN_SPAN, maxSpan);
      this.scanned(j.w);
    }
    for (const { item: j, error } of scanned.overran) {
      j.failed = true;
      const meta = metaOf(j.w);
      meta.span = nextScanSpan(meta.span, { ok: false }, MIN_SCAN_SPAN, maxSpan);
      this.fail(j.w, "scan", `skipped this tick, ${error.message}; next scan covers ${meta.span} blocks`);
    }
    for (const { item: j, error } of scanned.failed) {
      j.failed = true;
      this.fail(j.w, "scan", `scan: ${short(error)}`);
    }
    if (scanned.overran.length || scanned.unreached.length) {
      console.warn(
        `[keeper:accrue] ${scanned.overran.length} wallet(s) over their scan budget, ${scanned.unreached.length} not reached before the ${this.cfg.SCAN_TICK_DEADLINE_MS} ms tick deadline (scanned first next tick)`,
      );
    }

    // 5. Decide, account by account (wallets share the account's cap room).
    const batch: Entry[] = [];
    const held: Record<string, number> = {};
    let payments = 0;
    const byAccount = new Map<Address, Job[]>();
    for (const j of jobs) {
      const list = byAccount.get(j.a.view.account);
      if (list) list.push(j);
      else byAccount.set(j.a.view.account, [j]);
    }
    for (const [account, list] of byAccount) {
      let capLeft = list[0]!.a.view.remaining;
      for (const j of list) {
        const s = j.scan;
        if (j.failed || s.scannedTo <= j.from) continue;
        const d = decideAccrual({
          consent: j.consent,
          delta: s.delta,
          bounds: [capLeft, j.v.permit2Amount, j.v.erc20Allowance, j.v.balance],
          wide: s.scannedTo - j.from >= idle,
        });
        if (d.kind === "hold") {
          held[d.reason] = (held[d.reason] ?? 0) + 1;
          continue;
        }
        const amount = d.kind === "pull" ? d.amount : 0n;
        capLeft -= amount;
        payments += s.payments;
        batch.push({ account, wallet: j.w, amount, toBlock: s.scannedTo, from: j.from });
      }
    }
    const heldNote = Object.keys(held).length
      ? ` (held: ${Object.entries(held).map(([k, n]) => `${n} ${k}`).join(", ")})`
      : "";

    if (batch.length === 0) {
      return this.log({ kind: "accrue", ok: true, detail: `${this.accounts.size} accounts, ${active.length} active, nothing to accrue${heldNote}` });
    }

    // 6. Pre-flight, then send.
    const ready = await this.preflight(batch);
    let accrued = 0;
    for (let i = 0; i < ready.length; i += MAX_BATCH) {
      const slice = ready.slice(i, i + MAX_BATCH);
      const total = slice.reduce((s, b) => s + b.amount, 0n);
      const r = await this.send(
        "accrueBatch",
        [slice.map(({ account, wallet, amount, toBlock }) => ({ account, wallet, amount, toBlock }))],
        accrueGasFloor(slice.map((e) => e.amount)),
      );
      if (r.simulated === 0n) {
        for (const e of slice) this.fail(e.wallet, "accrue", "accrueBatch simulation accrued nothing");
        this.log({ kind: "accrue", ok: false, detail: `${slice.length} wallets would all be skipped; not broadcast` });
        continue;
      }
      if (!r.receipt) {
        accrued += Number(r.simulated as bigint);
        this.log({ kind: "accrue", ok: true, detail: `simulate-only: ${String(r.simulated)}/${slice.length} wallets, $${fmtUsdg(total)}${heldNote}` });
        continue;
      }
      const got = parseEventLogs({ abi: sweepExecutorAbi, eventName: "Accrued", logs: r.receipt.logs });
      const skipped = parseEventLogs({ abi: sweepExecutorAbi, eventName: "AccrualSkipped", logs: r.receipt.logs });
      for (const ev of got) {
        const w = ev.args.wallet as Address;
        this.backoff.delete(lc(w));
        this.scans.delete(lc(w));
      }
      // An entry skipped with an EMPTY reason, after its own pre-flight passed,
      // ran out of gas inside the try (send() explains why the tx still
      // succeeds). It is not the wallet's fault: no backoff, the gas step goes
      // up and the entry is retried next tick. Only at the top step does it
      // back off like any other skip.
      const oog = skipped.filter((ev) => ev.args.reason === "0x");
      const retry =
        oog.length > 0 &&
        this.outOfGas(
          "accrueBatch",
          `accrueBatch ${r.hash} skipped ${oog.length}/${slice.length} entries with an empty reason at its ${r.gas} gas limit (estimate ${r.estimate})`,
        );
      for (const ev of skipped) {
        const empty = ev.args.reason === "0x";
        if (empty && retry) continue;
        this.fail(ev.args.wallet as Address, "accrue", `AccrualSkipped: ${empty ? "out of gas (empty reason)" : decodeReason(ev.args.reason as Hex)}`);
      }
      accrued += got.length;
      this.log({
        kind: "accrue",
        ok: skipped.length === 0,
        detail: `${got.length}/${slice.length} wallets accrued, ${payments} payments, $${fmtUsdg(total)} to block ${toBlock}${
          skipped.length ? `, ${skipped.length} skipped` : ""
        }${oog.length ? ` (${oog.length} out of gas${retry ? `: retried next tick at ${GAS_STEPS_PCT[this.gasStep.accrueBatch]! / 100}x the estimate` : ""})` : ""}${heldNote}`,
        tx: r.hash,
      });
    }
    if (accrued > 0) this.noProgress = 0;
    else this.noProgress++;
    if (ready.length < batch.length) {
      this.log({ kind: "accrue", ok: ready.length > 0, detail: `pre-flight dropped ${batch.length - ready.length}/${batch.length} entries` });
    }
  }

  /**
   * 1. Re-read each entry's window start at LATEST: if it moved (another
   *    instance or a lagging read), the amount no longer matches the range the
   *    contract will use, so the entry is dropped rather than pulled twice.
   * 2. Simulate each entry ALONE with the keeper-only `accrue`, which reverts
   *    with the reason (accrueBatch swallows it into AccrualSkipped and still
   *    costs gas). A reverting wallet is backed off exponentially.
   */
  private async preflight(batch: Entry[]): Promise<Entry[]> {
    const x = this.book.sweepExecutor;
    const rr = this.book.ruleRegistry;
    const cur = await this.readEach(
      batch,
      (e): Call[] => [
        { address: x, abi: sweepExecutorAbi, functionName: "lastAccruedBlock", args: [e.wallet] },
        { address: rr, abi: ruleRegistryAbi, functionName: "linkedAt", args: [e.wallet] },
        { address: rr, abi: ruleRegistryAbi, functionName: "activeSince", args: [e.account] },
      ],
      undefined,
      "pre-flight cursor",
    );
    const fresh = batch.filter((e) => {
      const r = cur.results.get(e);
      if (!r || !r.every((v) => v.ok)) return false;
      const [l, k, s] = r.map((v) => (v as { value: unknown }).value) as [bigint, bigint, bigint];
      if (accrualFrom(l, k, s) === e.from) return true;
      this.scans.delete(lc(e.wallet));
      console.warn(`[keeper:accrue] ${e.wallet} window start moved ${e.from} -> ${accrualFrom(l, k, s)} since read; dropped`);
      return false;
    });
    const ok = new Set<Entry>();
    await eachLimit(fresh, SIM_CONCURRENCY, async (e) => {
      try {
        await this.client.simulateContract({
          address: x,
          abi: sweepExecutorAbi,
          functionName: "accrue",
          args: [e.account, e.wallet, e.amount, e.toBlock],
          account: this.account,
        });
        ok.add(e);
      } catch (err) {
        const why = revertReason(err);
        if (why) this.fail(e.wallet, "accrue", `pre-flight revert: ${why}`);
        else console.warn(`[keeper:accrue] pre-flight for ${e.wallet} failed (not a revert): ${short(err)}`);
      }
    });
    return batch.filter((e) => ok.has(e));
  }

  // ── sweep ─────────────────────────────────────────────────────────────

  /**
   * State of every asset the due accounts hold, in two batched reads however
   * many assets the registry has: isEligible + oracleStatus + get for all of
   * them (one multicall), then, for the eligible ones, the feed's
   * latestRoundData and the token's ERC-8056 multiplier state (one multicall)
   * for the market-hours gate and the multiplier-change check. The universe
   * is the registry's; nothing here lists a token.
   */
  private async assetInfos(assets: readonly Address[], readBlock: bigint, ts: number): Promise<Map<string, AssetInfo>> {
    const out = new Map<string, AssetInfo>();
    const uniq = [...new Map(assets.map((a) => [lc(a), a])).values()];
    if (uniq.length === 0) return out;
    let r: Res[];
    try {
      r = await this.multi(
        uniq.flatMap((asset): Call[] => [
          { address: this.book.assetRegistry, abi: assetRegistryAbi as Abi, functionName: "isEligible", args: [asset] },
          { address: this.book.stockRouter, abi: stockRouterAbi as Abi, functionName: "oracleStatus", args: [asset] },
          { address: this.book.assetRegistry, abi: assetRegistryAbi as Abi, functionName: "get", args: [asset] },
        ]),
        readBlock,
      );
    } catch (err) {
      console.warn(`[keeper:sweep] asset reads failed for ${uniq.length} asset(s): ${short(err)}`);
      for (const asset of uniq) out.set(lc(asset), { asset, state: "wait", why: "read failed" });
      return out;
    }
    type Reg = { feed: Address; poolKey: PoolKey };
    const rows = uniq.map((asset, i) => ({
      asset,
      eligible: r[i * 3],
      status: r[i * 3 + 1],
      reg: r[i * 3 + 2],
    }));
    // Per eligible asset: the feed's last update (market-hours gate, multiplier
    // check) and the token's uiMultiplier / newUIMultiplier / effectiveAt.
    const live = rows.filter((x) => x.eligible?.ok && x.eligible.value === true && x.reg?.ok);
    const extra = new Map<string, Res[]>();
    if (live.length) {
      try {
        const rr = await this.multi(
          live.flatMap((x): Call[] => [
            { address: (x.reg as { value: Reg }).value.feed, abi: aggregatorV3Abi as Abi, functionName: "latestRoundData" },
            { address: x.asset, abi: stockTokenAbi as Abi, functionName: "effectiveAt" },
            { address: x.asset, abi: stockTokenAbi as Abi, functionName: "uiMultiplier" },
            { address: x.asset, abi: stockTokenAbi as Abi, functionName: "newUIMultiplier" },
          ]),
          readBlock,
        );
        live.forEach((x, i) => extra.set(lc(x.asset), rr.slice(4 * i, 4 * i + 4)));
      } catch (err) {
        console.warn(`[keeper:sweep] feed / multiplier reads failed: ${short(err)}`);
      }
    }
    for (const x of rows) {
      const { asset } = x;
      if (!x.eligible?.ok) {
        out.set(lc(asset), { asset, state: "wait", why: "read failed" });
        continue;
      }
      // Deactivated: the executor safe-settles this leg to USDG before any
      // oracle or limit check. No quote needed; must not block the account.
      if (x.eligible.value !== true) {
        out.set(lc(asset), { asset, state: "settle" });
        continue;
      }
      if (!x.status?.ok || !x.reg?.ok) {
        out.set(lc(asset), { asset, state: "wait", why: "read failed" });
        continue;
      }
      const [status] = x.status.value as readonly [number, bigint];
      const reg = x.reg.value as Reg;
      const [round, eff, ui, nui] = extra.get(lc(asset)) ?? [];
      if (!round?.ok) {
        out.set(lc(asset), { asset, state: "wait", why: "read failed" });
        continue;
      }
      // Unreadable multiplier state is not "no change": wait, never guess.
      if (!eff?.ok || !ui?.ok || !nui?.ok) {
        out.set(lc(asset), { asset, state: "wait", why: "multiplier state unreadable" });
        continue;
      }
      const [, , , updatedAt] = round.value as readonly [bigint, bigint, bigint, bigint, bigint];
      const marketOpen =
        this.cfg.MARKET_HOURS_GATE !== "1" || this.cfg.MARKET_GATE_EXEMPT.has(lc(asset)) || equityMarketOpen(ts, Number(updatedAt));
      const split = splitPending({
        now: ts,
        effectiveAt: Number(eff.value as bigint),
        uiMultiplier: ui.value as bigint,
        newUIMultiplier: nui.value as bigint,
        feedUpdatedAt: Number(updatedAt),
      });
      const state = assetState({ eligible: true, oracleStatus: Number(status), marketOpen, splitPending: split });
      out.set(lc(asset), {
        asset,
        state,
        poolKey: reg.poolKey,
        why:
          state === "wait"
            ? Number(status) !== 0
              ? `oracle status ${Number(status)}`
              : !marketOpen
                ? "market closed"
                : "multiplier change not yet in the feed"
            : undefined,
      });
    }
    return out;
  }

  /** The exact quote the executor's limit is built from, as a call. */
  private quoteCall(info: AssetInfo, swapIn: bigint): Call {
    const key = info.poolKey!;
    return {
      address: VENUE.v4Quoter as Address,
      abi: v4QuoterAbi as unknown as Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks },
          zeroForOne: lc(key.currency0) === lc(USDG),
          exactAmount: swapIn,
          hookData: "0x",
        },
      ],
    };
  }

  /**
   * V4Quoter output for each swap: batched Multicall3 reads (QUOTE_CHUNK
   * quotes per eth_call), then one individual retry for any that failed.
   * null when a swap cannot be quoted. `blockNumber` pins the reads so a call
   * is never quoted against pool state from before our own last sweep.
   */
  private async quoteOuts(reqs: readonly QuoteReq[], state: ReadonlyMap<string, AssetInfo>, blockNumber?: bigint): Promise<(bigint | null)[]> {
    const outs: (bigint | null)[] = reqs.map(() => null);
    const todo = reqs
      .map((r, i) => ({ ...r, i, info: state.get(lc(r.asset)) }))
      .filter((r): r is typeof r & { info: AssetInfo } => !!r.info?.poolKey && r.swapIn > 0n);
    const chunks: (typeof todo)[] = [];
    for (let i = 0; i < todo.length; i += QUOTE_CHUNK) chunks.push(todo.slice(i, i + QUOTE_CHUNK));
    const retry: typeof todo = [];
    await eachLimit(chunks, READ_CONCURRENCY, async (chunk) => {
      let res: Res[] = [];
      try {
        res = await this.multi(chunk.map((r) => this.quoteCall(r.info, r.swapIn)), blockNumber);
      } catch (err) {
        console.warn(`[keeper:sweep] batched quote failed (${chunk.length} swaps): ${short(err)}`);
      }
      chunk.forEach((r, k) => {
        const x = res[k];
        if (x?.ok) outs[r.i] = (x.value as readonly [bigint, bigint])[0];
        else retry.push(r);
      });
    });
    await eachLimit(retry, READ_CONCURRENCY, async (r) => {
      try {
        const q = await this.client.simulateContract({
          ...(this.quoteCall(r.info, r.swapIn) as object),
          abi: v4QuoterAbi,
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        } as never);
        outs[r.i] = (q as { result: readonly [bigint, bigint] }).result[0];
      } catch (err) {
        console.warn(`[keeper:sweep] quote failed for ${r.asset} ($${fmtUsdg(r.swapIn)}): ${short(err)}`);
      }
    });
    return outs;
  }

  /**
   * Oracle price (only while OracleGuard says OK) and the pinned pool's swap
   * fee per asset, one multicall at `blockNumber`: StockRouter.oracleStatus
   * and StateView.getSlot0 (protocol fee; LP fee of a dynamic-fee pool). An
   * asset missing from the result has no usable oracle price.
   *
   * A hooked pool's LP fee is the hook's own (A-L3, hooks.ts): its
   * currentFee for our direction, with its authority and fee cap in the same
   * multicall and its code read at the same block, all checked against the
   * asset's HOOK_PINS entry. Anything off its pin or unread holds the asset
   * (Market.held), whatever its quote.
   */
  private async marketOf(assets: readonly Address[], state: ReadonlyMap<string, AssetInfo>, blockNumber?: bigint): Promise<Map<string, Market>> {
    const out = new Map<string, Market>();
    const rows = assets
      .map((asset) => ({ asset, key: state.get(lc(asset))?.poolKey }))
      .filter((r): r is { asset: Address; key: PoolKey } => !!r.key)
      .map((r) => ({ ...r, id: poolIdOf(r.key), zeroForOne: lc(r.key.currency0) === lc(USDG), hooked: lc(r.key.hooks) !== lc(zeroAddress) }));
    if (!rows.length) return out;
    const hooks = [...new Set(rows.filter((r) => r.hooked).map((r) => lc(r.key.hooks)))];
    let res: Res[];
    let codehash: Map<string, Hex | null>;
    try {
      [res, codehash] = await Promise.all([
        this.multi(
          rows.flatMap(({ asset, key, id, zeroForOne, hooked }): Call[] => [
            { address: this.book.stockRouter, abi: stockRouterAbi as Abi, functionName: "oracleStatus", args: [asset] },
            { address: VENUE.v4StateView as Address, abi: stateViewAbi as Abi, functionName: "getSlot0", args: [id] },
            ...(hooked
              ? ([
                  { address: key.hooks, abi: fablesHookAbi as Abi, functionName: "currentFee", args: [id, zeroForOne] },
                  { address: key.hooks, abi: fablesHookAbi as Abi, functionName: "maxFee", args: [id] },
                  { address: key.hooks, abi: fablesHookAbi as Abi, functionName: "authority" },
                ] satisfies Call[])
              : []),
          ]),
          blockNumber,
        ),
        this.codehashes(hooks, blockNumber),
      ]);
    } catch (err) {
      console.warn(`[keeper:sweep] oracle / pool fee reads failed for ${rows.length} asset(s): ${short(err)}`);
      return out;
    }
    let k = 0;
    for (const { asset, key, id, zeroForOne, hooked } of rows) {
      const st = res[k++];
      const s0 = res[k++];
      const [fee, cap, authority] = hooked ? [res[k++], res[k++], res[k++]] : [];
      if (!st?.ok) continue;
      const [status, price] = st.value as readonly [number, bigint];
      if (Number(status) !== 0 || price <= 0n) continue;
      const slot0 = s0?.ok
        ? (([, , protocolFee, lpFee]) => ({ protocolFee: Number(protocolFee), lpFee: Number(lpFee) }))(s0.value as readonly [bigint, number, number, number])
        : undefined;
      if (!hooked) {
        out.set(lc(asset), { price1e18: price, feePips: poolFeePips({ keyFee: Number(key.fee), zeroForOne, slot0 }) });
        continue;
      }
      const v = hookVerdict(this.hookPins.get(lc(asset)), { hook: key.hooks, poolId: id }, {
        codehash: codehash.get(lc(key.hooks)) ?? null,
        authority: authority?.ok ? (authority.value as Address) : null,
        maxFee: cap?.ok ? Number(cap.value) : null,
        currentFee: fee?.ok ? Number(fee.value) : null,
      });
      if ("held" in v) out.set(lc(asset), { price1e18: price, feePips: 0, held: v.held });
      else out.set(lc(asset), { price1e18: price, feePips: poolFeePips({ keyFee: Number(key.fee), zeroForOne, slot0, hookFee: v.feePips }) });
    }
    return out;
  }

  /** keccak256 of each hook's runtime code at `blockNumber`; null where it could not be read (or there is none). */
  private async codehashes(hooks: readonly string[], blockNumber?: bigint): Promise<Map<string, Hex | null>> {
    const out = new Map<string, Hex | null>();
    await Promise.all(
      hooks.map(async (h) => {
        const code = await this.client
          .getCode({ address: h as Address, ...(blockNumber !== undefined ? { blockNumber } : {}) })
          .catch((err: unknown) => {
            console.warn(`[keeper:sweep] hook ${h} code read failed: ${short(err)}`);
            return undefined;
          });
        out.set(h, code && code !== "0x" ? keccak256(code) : null);
      }),
    );
    return out;
  }

  /**
   * Of `assets`, those an isolated call bought that are still held (A-M1):
   * one $1 quote and one oracle read each at `blockNumber`, judged by
   * recoveryHeld. A recovered asset, or one past SWEEP_RECOVERY_MAX_MS, is
   * released for good.
   */
  private async recoveryHolds(
    assets: readonly Address[],
    state: ReadonlyMap<string, AssetInfo>,
    blockNumber: bigint,
  ): Promise<Map<string, { asset: Address; why: string }>> {
    const held = new Map<string, { asset: Address; why: string }>();
    const todo = assets.filter((a) => this.recovering.has(lc(a)));
    if (!todo.length) return held;
    const [refs, market] = await Promise.all([
      this.quoteOuts(todo.map((asset) => ({ asset, swapIn: REF_SWAP_IN })), state, blockNumber),
      this.marketOf(todo, state, blockNumber),
    ]);
    const opts = { bps: this.cfg.SWEEP_RECOVERY_BPS, maxMs: this.cfg.SWEEP_RECOVERY_MAX_MS };
    const at = Date.now();
    todo.forEach((asset, i) => {
      const r = this.recovering.get(lc(asset))!;
      const v = recoveryHeld(r, { ref: refs[i] ?? null, price1e18: market.get(lc(asset))?.price1e18 ?? null, at }, opts);
      if (v.held) {
        held.set(lc(asset), { asset, why: v.why });
        return;
      }
      this.recovering.delete(lc(asset));
      if (v.why === "recovered") console.log(`[keeper:sweep] ${asset}: $1 quote back within ${opts.bps} bps of its value before the isolated sweep; released`);
      else console.warn(`[keeper:sweep] ${asset}: $1 quote still off its value before the isolated sweep after ${Math.round((at - r.since) / 60_000)} min; hold lapsed (the oracle checks still apply)`);
    });
    return held;
  }

  /** Net, quote and oracle-check one sweep call at `blockNumber` (batches.ts planCall). */
  private planSweep(picked: readonly Due[], state: ReadonlyMap<string, AssetInfo>, feeBps: bigint, blockNumber: bigint, isolated: boolean) {
    return planCall(picked, {
      state: (a) => state.get(lc(a))?.state,
      feeBps,
      toleranceBps: BigInt(this.cfg.QUOTE_TOLERANCE_BPS),
      allowanceBps: this.cfg.QUOTE_ORACLE_ALLOWANCE_BPS,
      sizeAllowanceBps: this.cfg.SWEEP_MAX_IMPACT_BPS,
      maxShortfallBps: this.cfg.QUOTE_MAX_SHORTFALL_BPS,
      isolated,
      quote: (reqs) => this.quoteOuts(reqs, state, blockNumber),
      market: (assets) => this.marketOf(assets, state, blockNumber),
    });
  }

  async sweepTick(): Promise<void> {
    const x = this.book.sweepExecutor;
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const skip = await this.txGuard(head);
    if (skip) return this.log({ kind: "sweep", ok: true, detail: `skipping: ${skip}` });
    const readBlock = this.readBlockFor(head);
    const [paused, threshold, feeBps, epoch, block] = await Promise.all([
      this.client.readContract({ address: x, abi: sweepExecutorAbi, functionName: "paused", blockNumber: readBlock }),
      this.client.readContract({ address: x, abi: sweepExecutorAbi, functionName: "threshold", blockNumber: readBlock }),
      this.client.readContract({ address: x, abi: sweepExecutorAbi, functionName: "feeBps", blockNumber: readBlock }),
      this.client.readContract({ address: x, abi: sweepExecutorAbi, functionName: "currentEpoch", blockNumber: readBlock }),
      this.client.getBlock({ blockNumber: readBlock }),
    ]);
    if (paused) return this.log({ kind: "sweep", ok: true, detail: "executor paused; skipping" });
    try {
      await this.discover(head);
    } catch (err) {
      console.warn(`[keeper:sweep] discovery stalled at ${this.discoveredTo}: ${short(err)}`);
    }
    const ts = Number(block.timestamp);

    // Values first (one cheap read per account), details only above threshold.
    const all = [...this.accounts];
    const vals = await this.readEach(
      all,
      (a): Call[] => [{ address: this.book.cashPark, abi: cashParkAbi, functionName: "valueOf", args: [a] }],
      readBlock,
      "park value",
    );
    const value = (a: Address) => {
      const r = vals.results.get(a)?.[0];
      return r?.ok ? (r.value as bigint) : 0n;
    };
    const over = all.filter((a) => value(a) >= threshold);
    const det = await this.readEach(
      over,
      (a): Call[] => [
        { address: x, abi: sweepExecutorAbi, functionName: "sweptEpoch", args: [a] },
        { address: this.book.screeningGate, abi: screeningGateAbi, functionName: "isEligible", args: [a] },
        { address: this.book.electionRegistry, abi: electionRegistryAbi, functionName: "mixOf", args: [a] },
      ],
      readBlock,
      "sweep detail",
    );

    // Accounts that are due, then the state of every asset they hold — read once, batched.
    const due: { account: Address; legs: readonly Leg[] }[] = [];
    for (const account of over) {
      const r = det.results.get(account);
      if (!r || !r.every((v) => v.ok)) continue;
      const [swept, eligible, mix] = r.map((v) => (v as { value: unknown }).value) as [bigint, boolean, readonly Leg[]];
      if (swept === epoch || !eligible || mix.length === 0) continue;
      due.push({ account, legs: mix });
    }
    const state = await this.assetInfos(
      due.flatMap((d) => d.legs.map((l) => l.asset)),
      readBlock,
      ts,
    );

    const ready: { account: Address; value: bigint; legs: readonly Leg[] }[] = [];
    const waitingOn = new Map<string, number>();
    let waiting = 0;
    for (const { account, legs } of due) {
      const legInfo = legs.map((l) => state.get(lc(l.asset)) ?? { asset: l.asset, state: "wait" as const, why: "not read" });
      // All-or-nothing on the legs that can only defer (weekend, paused token,
      // closed market): they would still consume the epoch. A DEACTIVATED leg
      // does not wait: the executor safe-settles it.
      if (!accountReady(legInfo.map((i) => i.state))) {
        waiting++;
        for (const i of legInfo) {
          if (i.state !== "wait") continue;
          const k = `${i.asset} ${i.why ?? "not ready"}`;
          waitingOn.set(k, (waitingOn.get(k) ?? 0) + 1);
        }
        continue;
      }
      ready.push({ account, value: value(account), legs });
    }
    // An asset an isolated call bought in an earlier tick waits until its pool
    // has recovered (A-M1): its accounts sit this tick out, epochs kept.
    const preHeld = await this.recoveryHolds(quotedAssets(ready, state), state, readBlock);
    const open = preHeld.size ? withoutAssets(ready, new Set(preHeld.keys())) : ready;
    // One sweep's work stays bounded however many assets the registry holds.
    // Start where the last tick stopped, so accounts held for hours (B-L3,
    // isolation) cannot keep the front slots and starve everyone behind them.
    const caps = { maxAssets: this.cfg.SWEEP_MAX_ASSETS, maxLegs: this.cfg.SWEEP_MAX_LEGS };
    const rotate = <T>(list: readonly T[]) => {
      const off = list.length ? this.sweepRotation % list.length : 0;
      return { off, order: off ? [...list.slice(off), ...list.slice(0, off)] : [...list] };
    };
    let sweepable = open;
    let { off, order } = rotate(sweepable);
    let picked = capSweepBatch(order.slice(0, MAX_BATCH), caps).batch;
    // When that budget leaves accounts out, an account whose pool is already
    // too far under the oracle at $1 (B-L3's pool check, the same whatever the
    // call) must not take a slot: it is certain to be dropped at planning, and
    // the accounts it crowded out would wait a whole tick for nothing. Screen
    // those pools first, then fill the budget from the accounts left.
    if (picked.length < open.length) {
      const pools = await heldPools(quotedAssets(open, state), {
        quote: (reqs) => this.quoteOuts(reqs, state, readBlock),
        market: (as) => this.marketOf(as, state, readBlock),
        allowanceBps: this.cfg.QUOTE_ORACLE_ALLOWANCE_BPS,
      });
      if (pools.size) {
        for (const [k, v] of pools) preHeld.set(k, v);
        sweepable = withoutAssets(open, new Set(pools.keys()));
        ({ off, order } = rotate(sweepable));
        picked = capSweepBatch(order.slice(0, MAX_BATCH), caps).batch;
      }
    }
    this.sweepRotation = picked.length < sweepable.length ? off + picked.length : 0;
    const later = sweepable.length - picked.length;
    const heldNote = (dropped: ReadonlyMap<string, { asset: Address; why: string }> = new Map()) => {
      const all = new Map([...preHeld, ...dropped]);
      return all.size ? `; held this tick: ${[...all.values()].map((d) => `${d.asset} (${d.why})`).join(", ")}` : "";
    };
    const waitNote = `${waiting ? ` (${waiting} waiting: ${[...waitingOn.keys()].slice(0, 4).join("; ")})` : ""}${
      later ? ` (${later} more due next tick: a sweep takes at most ${MAX_BATCH} accounts, ${this.cfg.SWEEP_MAX_ASSETS} assets, ${this.cfg.SWEEP_MAX_LEGS} legs)` : ""
    }`;

    if (picked.length === 0) {
      if (preHeld.size) {
        return this.log({ kind: "sweep", ok: false, detail: `${ready.length} due, none sweepable${heldNote()}; epochs kept${waitNote}` });
      }
      return this.log({ kind: "sweep", ok: true, detail: `${this.accounts.size} accounts, none due${waitNote}` });
    }

    // Split into calls so no account's price impact sets another's limit (A-M1).
    const fee = BigInt(feeBps);
    const part = await partitionSweep(picked, {
      needsQuote: (a) => state.get(lc(a))?.state === "ok",
      feeBps: fee,
      maxImpactBps: this.cfg.SWEEP_MAX_IMPACT_BPS,
      quote: (reqs) => this.quoteOuts(reqs, state),
    });
    if (part.calls.length > 1 || part.sittingOut.length) {
      const iso = part.isolated.map(
        (i) => `${i.entry.account} (${i.asset} impact ${i.impactBps === null ? "over" : `${i.impactBps} bps >`} ${this.cfg.SWEEP_MAX_IMPACT_BPS} bps)`,
      );
      console.log(
        `[keeper:sweep] plan: ${part.calls.length} call(s) [${part.calls.map((c) => c.length).join(", ")} accounts]${
          iso.length ? `; on their own, last: ${iso.join(", ")}` : ""
        }${part.sittingOut.length ? `; ${part.sittingOut.length} sit out (impact unmeasurable: ${part.unmeasured.join(", ")})` : ""}`,
      );
    }

    const firstIsolated = part.calls.length - part.isolated.length;
    for (const [i, call] of part.calls.entries()) {
      if (this.stopping) break;
      const label = part.calls.length > 1 ? `call ${i + 1}/${part.calls.length}: ` : "";
      const note = i === 0 ? waitNote : "";
      if (i >= this.cfg.SWEEP_MAX_CALLS) {
        this.log({ kind: "sweep", ok: true, detail: `${part.calls.length - i} more call(s) wait for the next tick (SWEEP_MAX_CALLS ${this.cfg.SWEEP_MAX_CALLS})` });
        break;
      }
      // Each call is quoted against the pool state the previous one left: never below our last mined tx.
      const at = await this.client.getBlockNumber({ cacheTime: 0 });
      if (at < this.lastTxBlock) {
        this.log({ kind: "sweep", ok: true, detail: `${label}RPC head ${at} is behind our last tx block ${this.lastTxBlock}; the rest wait for the next tick` });
        break;
      }
      await this.sweepCall(call, state, fee, this.readBlockFor(at), label, note, i >= firstIsolated, i === 0 ? heldNote : undefined);
    }
  }

  /**
   * Plan, size and send ONE sweep call. If it would estimate above
   * SWEEP_MAX_GAS, halve it and re-plan. An asset an earlier isolated call
   * bought (this tick or before) and whose pool has not recovered takes its
   * accounts out first; an isolated call that is mined marks every asset it
   * bought as recovering (A-M1).
   */
  private async sweepCall(
    accounts: readonly Due[],
    state: ReadonlyMap<string, AssetInfo>,
    feeBps: bigint,
    blockNumber: bigint,
    label: string,
    note: string,
    isolated = false,
    /** The "held this tick" text from this call's dropped assets (the first call also names the tick's pre-held ones). */
    heldNote: (dropped: ReadonlyMap<string, { asset: Address; why: string }>) => string = (d) =>
      d.size ? `; held this tick: ${[...d.values()].map((x) => `${x.asset} (${x.why})`).join(", ")}` : "",
  ): Promise<void> {
    const x = this.book.sweepExecutor;
    const recovering = this.recovering.size ? await this.recoveryHolds(quotedAssets(accounts, state), state, blockNumber) : new Map<string, { asset: Address; why: string }>();
    let picked = recovering.size ? withoutAssets(accounts, new Set(recovering.keys())) : accounts;
    if (picked.length === 0) {
      return this.log({ kind: "sweep", ok: false, detail: `${label}${accounts.length} due, none sweepable${heldNote(recovering)}; epochs kept${note}` });
    }
    let plan = await this.planSweep(picked, state, feeBps, blockNumber, isolated);
    for (let halvings = 0; plan.chosen.length > 1 && halvings < 6; halvings++) {
      const gas = await this.client
        .estimateContractGas({
          address: x,
          abi: sweepExecutorAbi,
          functionName: "sweep",
          args: [plan.chosen.map((c) => c.account), plan.limits] as never,
          account: this.account,
        } as never)
        .catch(() => null);
      // A revert is send()'s to report (it simulates and decodes); only a too-big batch shrinks here.
      if (gas === null || gas <= this.cfg.SWEEP_MAX_GAS) break;
      console.warn(`[keeper:sweep] ${label}${plan.chosen.length} accounts estimate ${gas} gas > ${this.cfg.SWEEP_MAX_GAS}; halving the batch`);
      picked = plan.chosen.slice(0, Math.ceil(plan.chosen.length / 2));
      plan = await this.planSweep(picked, state, feeBps, blockNumber, isolated);
    }
    const { chosen, limits, refs, dropped, settleOnly } = plan;
    const held = heldNote(new Map([...recovering, ...dropped]));
    if (chosen.length === 0) {
      return this.log({ kind: "sweep", ok: false, detail: `${label}${picked.length} due, none sweepable${held}; epochs kept${note}` });
    }

    const usd = chosen.reduce((s, c) => s + c.value, 0n);
    const r = await this.send("sweep", [chosen.map((c) => c.account), limits]);
    if (r.simulated === 0n) {
      return this.log({ kind: "sweep", ok: true, detail: `${label}${chosen.length} accounts would sweep nothing; not broadcast${held}` });
    }
    // A swap deferred with an EMPTY reason ran out of gas inside the executor's
    // try (send() explains why the sweep still succeeds). Its contributors'
    // USDG is back in the park and their epoch is spent, so this cannot be
    // retried before the next epoch; the next sweep goes out with more gas.
    const oog = r.receipt
      ? parseEventLogs({ abi: sweepExecutorAbi, eventName: "SwapDeferred", logs: r.receipt.logs }).filter((e) => e.args.reason === "0x").map((e) => e.args.asset as Address)
      : [];
    if (oog.length) {
      this.outOfGas("sweep", `sweep ${r.hash} deferred ${oog.join(", ")} with an empty reason at its ${r.gas} gas limit (estimate ${r.estimate}); those legs' USDG is back in the park until the next epoch`);
    }
    // A mined isolated call left its impact in every pool it bought from (a
    // deferred swap bought nothing): those assets wait until it is gone.
    const marked: Address[] = [];
    if (isolated && r.receipt) {
      const deferred = new Set(parseEventLogs({ abi: sweepExecutorAbi, eventName: "SwapDeferred", logs: r.receipt.logs }).map((e) => lc(e.args.asset as string)));
      const since = Date.now();
      for (const l of limits) {
        const before = refs.get(lc(l.asset));
        if (!before || deferred.has(lc(l.asset))) continue;
        this.recovering.set(lc(l.asset), { asset: l.asset, ref: before.ref, price1e18: before.price1e18, since });
        marked.push(l.asset);
      }
    }
    this.log({
      kind: "sweep",
      ok: oog.length === 0,
      detail: `${label}${chosen.length} accounts, $${fmtUsdg(usd)} across ${limits.length} quoted assets${
        settleOnly ? `, ${settleOnly} safe-settle only` : ""
      }${oog.length ? `; out of gas, deferred: ${oog.join(", ")}` : ""}${
        marked.length ? `; ${marked.join(", ")} held until ${marked.length > 1 ? "their pools recover" : "its pool recovers"}` : ""
      }${held}${note}`,
      tx: r.hash,
    });
  }

  // ── tx ────────────────────────────────────────────────────────────────

  /**
   * Simulate; never broadcast a call that would do nothing (accrueBatch /
   * sweep returning 0). While a sent tx is unconfirmed it stays `inflight`
   * and every tick waits for it.
   *
   * The gas limit is never the bare estimate: it is gasLimit() of it at this
   * kind's current step of GAS_STEPS_PCT, and at least `floor` (plan.ts says
   * why a short limit skips or defers instead of reverting). A tx that
   * reverts having used its whole limit ran out of gas: the step goes up.
   */
  private async send(
    functionName: "accrueBatch" | "sweep",
    args: readonly unknown[],
    floor?: bigint,
  ): Promise<{ simulated: unknown; hash?: `0x${string}`; receipt?: TransactionReceipt; gas?: bigint; estimate?: bigint }> {
    const call = { address: this.book.sweepExecutor, abi: sweepExecutorAbi, functionName, args: args as never, account: this.account };
    const sim = await this.client.simulateContract(call);
    if (sim.result === 0n) return { simulated: 0n };
    if (this.cfg.KEEPER_BROADCAST !== "1") {
      console.log(`[keeper] simulate-only ${functionName} -> ${String(sim.result)}`);
      return { simulated: sim.result };
    }
    const estimate = await this.client.estimateContractGas(call as never);
    const gas = gasLimit({ estimate, pct: GAS_STEPS_PCT[this.gasStep[functionName]]!, floor });
    const hash = await this.wallet.writeContract({ ...(sim.request as object), gas } as never);
    this.inflight = { hash, sentAt: Date.now() };
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    this.inflight = undefined;
    if (receipt.blockNumber > this.lastTxBlock) this.lastTxBlock = receipt.blockNumber;
    if (receipt.status !== "success") {
      if (receipt.gasUsed >= gas) this.outOfGas(functionName, `${functionName} ${hash} reverted having used its whole ${gas} gas limit (estimate ${estimate})`);
      throw new Error(`${functionName} reverted on-chain (${hash})`);
    }
    return { simulated: sim.result, hash, receipt, gas, estimate };
  }

  /**
   * A keeper tx ran (some of its work) out of gas. Logged loudly, and the
   * next tx of that kind is sent at the next GAS_STEPS_PCT step; the step
   * never comes back down while the process runs (unused gas is not
   * charged). False when it was already at the top step.
   */
  private outOfGas(functionName: "accrueBatch" | "sweep", what: string): boolean {
    const step = this.gasStep[functionName];
    const raised = step < GAS_STEPS_PCT.length - 1;
    if (raised) this.gasStep[functionName] = step + 1;
    const pct = GAS_STEPS_PCT[this.gasStep[functionName]]!;
    console.error(
      `[keeper] OUT OF GAS: ${what}; ${raised ? `${functionName} is now sent at ${pct / 100}x its estimate` : `already at the top step (${pct / 100}x its estimate)`}`,
    );
    return raised;
  }

  async ethBalance(): Promise<bigint> {
    const b = await this.client.getBalance({ address: this.account.address });
    this.lastEth = b;
    return b;
  }
}

export function fmtUsdg(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}
