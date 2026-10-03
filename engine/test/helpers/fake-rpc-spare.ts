/**
 * The deployed Spare system, modelled on a FakeRpc for the keeper's unit
 * tests: the address book's contracts, USDG, Permit2, the registry's assets
 * (Chainlink feed, ERC-8056 token, constant-product v4 pool behind the V4
 * Quoter and StateView) and the canonical v3 factory.
 *
 * State is plain mutable records that tests set directly. Registry events
 * (Linked, RuleSet) and USDG transfers are real logs. A mined accrueBatch
 * emits Accrued / AccrualSkipped and moves the wallet cursors; a mined sweep
 * marks its accounts swept, empties their park and swaps each asset's netted
 * USDG through its pool, as SweepExecutor does (or, for an asset in
 * `sweepDefers`, emits SwapDeferred and returns its USDG to the parks).
 */
import { spyOn } from "bun:test";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aggregatorV3Abi,
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  permit2Abi,
  ruleRegistryAbi,
  screeningGateAbi,
  stockRouterAbi,
  stockTokenAbi,
  sweepExecutorAbi,
} from "../../src/chain/abis.ts";
import { PERMIT2, USDG, VENUE } from "../../src/chain/constants.ts";
import { TRANSFER_EVENT } from "../../src/chain/logs.ts";
import { loadConfig, type Book } from "../../src/keeper/config.ts";
import { fablesHookAbi, type HookPin } from "../../src/keeper/hooks.ts";
import { Keeper } from "../../src/keeper/keeper.ts";
import { oracleTokensFor, splitMix, swapInFor } from "../../src/keeper/plan.ts";
import { encodeLog, FakeRpc, Revert, type SentTx } from "./fake-rpc.ts";

/** A throwaway key that only ever signs for the fake chain. */
export const TEST_PK = `0x${"11".repeat(32)}` as Hex;
export const KEEPER = privateKeyToAccount(TEST_PK).address;

/** A checksummed address from a small number (test fixtures). */
export const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const at = addr;
export const BOOK: Book = {
  chainId: 4663,
  startBlock: 1_000n,
  assetRegistry: at(0x5a0001),
  ruleRegistry: at(0x5a0002),
  electionRegistry: at(0x5a0003),
  screeningGate: at(0x5a0004),
  stockRouter: at(0x5a0005),
  cashPark: at(0x5a0006),
  feeVault: at(0x5a0007),
  sweepExecutor: at(0x5a0008),
  usdgParkAdapter: at(0x5a0009),
};
/** The address book as contracts/addresses/4663.json spells it. */
export const BOOK_JSON = {
  chainId: 4663,
  startBlock: 1000,
  contracts: {
    AssetRegistry: BOOK.assetRegistry,
    RuleRegistry: BOOK.ruleRegistry,
    ElectionRegistry: BOOK.electionRegistry,
    ScreeningGate: BOOK.screeningGate,
    StockRouter: BOOK.stockRouter,
    CashPark: BOOK.cashPark,
    FeeVault: BOOK.feeVault,
    SweepExecutor: BOOK.sweepExecutor,
    UsdgParkAdapter: BOOK.usdgParkAdapter,
  },
};

export const E18 = 10n ** 18n;
export const usd = (n: number) => BigInt(Math.round(n * 1e6));
/** Wednesday 2026-09-30 15:00 UTC (11:00 ET): the 24/5 equity session is open. */
export const WED_1500 = Date.UTC(2026, 8, 30, 15) / 1000;
/** Saturday 2026-10-03 15:00 UTC: closed. */
export const SAT_1500 = Date.UTC(2026, 9, 3, 15) / 1000;

export const RR_LINKED = parseAbiItem("event Linked(address indexed account, address indexed wallet)");
export const RR_RULESET = parseAbiItem("event RuleSet(address indexed account, uint8 roundTo, uint8 multiplier, uint64 weeklyCap, bool enabled)");
const ACCRUED = parseAbiItem("event Accrued(address indexed account, address indexed wallet, uint256 amount, uint256 fromBlock, uint256 toBlock)");
const SKIPPED = parseAbiItem("event AccrualSkipped(address indexed account, address indexed wallet, uint256 toBlock, bytes reason)");
const SWAP_DEFERRED = parseAbiItem("event SwapDeferred(address indexed asset, uint256 usdg, bytes reason)");

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function paused() view returns (bool)",
]);
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const v3PoolAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"]);
const v3FactoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);

export interface Rule {
  roundTo: number;
  multiplier: number;
  weeklyCap: bigint;
  enabled: boolean;
}
export interface AccountState {
  rule: Rule;
  wallets: Address[];
  activeSince: bigint;
  remaining: bigint;
  value: bigint;
  sweptEpoch: bigint;
  eligible: boolean;
  mix: { asset: Address; bps: number }[];
}
export interface WalletState {
  lastAccrued: bigint;
  linkedAt: bigint;
  permit2: { amount: bigint; expiration: number; nonce: number };
  erc20Allowance: bigint;
  balance: bigint;
}
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
export interface AssetState {
  token: Address;
  eligible: boolean;
  status: number;
  price1e18: bigint;
  feed: Address;
  poolKey: PoolKey;
  updatedAt: bigint;
  effectiveAt: bigint;
  ui: bigint;
  nui: bigint;
  /** Constant product: x USDG (6 dp), y tokens (18 dp), LP fee kept in the pool. */
  pool: { x: bigint; y: bigint; feePips: bigint };
  slot0: { protocolFee: number; lpFee: number };
  /** A dynamic-fee hook that sets every swap's LP fee (hooked()); slot0.lpFee stays 0. */
  hook?: HookState;
}

/** A FablesBaseHook on one pool, as the keeper reads it (keeper/hooks.ts). */
export interface HookState {
  address: Address;
  /** currentFee for the keeper's direction, pips; also the fee the pool charges. */
  fee: number;
  /** maxFee(poolId). */
  cap: number;
  authority: Address;
  code: Hex;
}

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

/** The pool as a swap sees it: a hooked pool charges the hook's fee. */
export function feePool(s: AssetState): AssetState["pool"] {
  return s.hook ? { ...s.pool, feePips: BigInt(s.hook.fee) } : s.pool;
}

/** Constant-product quote, LP fee kept in the pool (what the fake V4 Quoter answers). */
export function cpQuote(p: { x: bigint; y: bigint; feePips: bigint }, dx: bigint): bigint {
  const dxf = (dx * (1_000_000n - p.feePips)) / 1_000_000n;
  return (p.y * dxf) / (p.x + dxf);
}

export class SpareWorld {
  readonly rpc = new FakeRpc();
  readonly book = BOOK;
  readonly accounts = new Map<Address, AccountState>();
  readonly wallets = new Map<Address, WalletState>();
  readonly assets = new Map<string, AssetState>();
  readonly executor = { paused: false, finalityBuffer: 100n, threshold: usd(10), feeBps: 25, epoch: 7n };
  usdgPaused: boolean | "revert" = false;
  /** Pre-flight `accrue` reverts per wallet (lower-case). */
  readonly accrueReverts = new Map<string, Revert>();
  /** Wallets (lower-case) the mined accrueBatch skips, with the reason bytes. */
  readonly batchSkips = new Map<string, Hex>();
  /** Assets (lower-case) whose swap a mined sweep defers, with the reason bytes. */
  readonly sweepDefers = new Map<string, Hex>();
  /** Override the simulated return of accrueBatch / sweep. */
  accrueBatchResult: ((entries: readonly Entry[]) => bigint) | null = null;
  sweepResult: ((accounts: readonly Address[]) => bigint) | null = null;
  /** Override what lastAccruedBlock answers at a block (pre-flight cursor races). */
  cursorAt: ((wallet: Address, block: bigint, stored: bigint) => bigint) | null = null;
  readonly v3Pools = new Map<string, { t0: Address; t1: Address; fee: number }>();

  constructor(opts: { head?: bigint; ts?: number } = {}) {
    const rpc = this.rpc;
    rpc.head = opts.head ?? 200_000n;
    const head0 = rpc.head;
    const ts0 = BigInt(opts.ts ?? WED_1500);
    rpc.timestampOf = (b) => ts0 + (b - head0) / 10n;
    rpc.code.set(this.book.sweepExecutor.toLowerCase(), "0x6080");
    rpc.onMined = (tx) => this.mined(tx);
    this.install();
  }

  /** Seconds at the fake head. */
  get now(): bigint {
    return this.rpc.timestampOf(this.rpc.head);
  }

  account(a: Address, s: Partial<AccountState> = {}): AccountState {
    const cur = this.accounts.get(a);
    const next: AccountState = {
      rule: { roundTo: 1, multiplier: 1, weeklyCap: usd(50), enabled: true },
      wallets: [],
      activeSince: 0n,
      remaining: usd(50),
      value: 0n,
      sweptEpoch: 0n,
      eligible: true,
      mix: [],
      ...cur,
      ...s,
    };
    this.accounts.set(a, next);
    return next;
  }

  wallet(w: Address, s: Partial<WalletState> = {}): WalletState {
    const cur = this.wallets.get(w);
    const next: WalletState = {
      lastAccrued: 0n,
      linkedAt: 0n,
      permit2: { amount: usd(1_000_000), expiration: Math.floor(Date.now() / 1000) + 30 * 86_400, nonce: 0 },
      erc20Allowance: 2n ** 255n,
      balance: usd(10_000),
      ...cur,
      ...s,
    };
    this.wallets.set(w, next);
    return next;
  }

  /** Linked + RuleSet events and the matching state: an active account with `wallets`. */
  enroll(account: Address, wallets: Address[], opts: { block?: bigint; rule?: Partial<Rule>; remaining?: bigint } = {}): AccountState {
    const block = opts.block ?? 2_000n;
    const rule: Rule = { roundTo: 1, multiplier: 1, weeklyCap: usd(50), enabled: true, ...opts.rule };
    wallets.forEach((w, i) => {
      this.rpc.emit(this.book.ruleRegistry, RR_LINKED, { account, wallet: w }, block, i);
      this.wallet(w, { linkedAt: block });
    });
    this.rpc.emit(this.book.ruleRegistry, RR_RULESET, { account, ...rule }, block, wallets.length);
    return this.account(account, { rule, wallets, activeSince: block, remaining: opts.remaining ?? rule.weeklyCap });
  }

  /** A RuleSet event (and the rule now in force). */
  setRule(account: Address, rule: Partial<Rule>, block: bigint, logIndex = 0): void {
    const next = { ...this.account(account).rule, ...rule };
    this.rpc.emit(this.book.ruleRegistry, RR_RULESET, { account, ...next }, block, logIndex);
    this.account(account, { rule: next });
  }

  /** An outgoing USDG transfer. */
  pay(from: Address, to: Address, amount: bigint, block: bigint, logIndex = 0): void {
    this.rpc.emit(USDG, TRANSFER_EVENT, { from, to, value: amount }, block, logIndex);
  }

  /** A registry asset: eligible, oracle OK at `price`, feed posted a minute ago, pool `offBps` under the oracle. */
  asset(token: Address, price: number, opts: { depth?: number; feePips?: number; offBps?: bigint; feed?: Address } = {}): AssetState {
    const price1e18 = BigInt(Math.round(price * 1e6)) * 10n ** 12n;
    const x = usd(opts.depth ?? 5_000_000);
    const y = (oracleTokensFor(x, price1e18) * (10_000n - (opts.offBps ?? 0n))) / 10_000n;
    const [c0, c1] = BigInt(token) < BigInt(USDG) ? [token, USDG] : [USDG, token];
    const fee = opts.feePips ?? 3_000;
    const s: AssetState = {
      token,
      eligible: true,
      status: 0,
      price1e18,
      feed: opts.feed ?? at(0xfeed00 + this.assets.size),
      poolKey: { currency0: c0, currency1: c1, fee, tickSpacing: 60, hooks: at(0) },
      updatedAt: this.now - 60n,
      effectiveAt: 0n,
      ui: E18,
      nui: E18,
      pool: { x, y, feePips: BigInt(fee === 0x800000 ? 0 : fee) },
      slot0: { protocolFee: 0, lpFee: 0 },
    };
    this.assets.set(token.toLowerCase(), s);
    const feedFns = { latestRoundData: () => [1n, s.price1e18 / 10n ** 10n, s.updatedAt, s.updatedAt, 1n] };
    this.rpc.contract(s.feed, aggregatorV3Abi as Abi, feedFns);
    this.rpc.contract(token, stockTokenAbi as Abi, {
      effectiveAt: () => s.effectiveAt,
      uiMultiplier: () => s.ui,
      newUIMultiplier: () => s.nui,
    });
    return s;
  }

  /**
   * Put `token`'s pool behind a FablesBaseHook-style dynamic-fee hook: the
   * PoolKey takes the dynamic flag and the hook's address, slot0.lpFee stays 0,
   * and every quote and fill pays the hook's `fee`. Returns the hook's state
   * (mutable) and a pin that matches it.
   */
  hooked(token: Address, o: { fee?: number; cap?: number; authority?: Address; maxFeePips?: number } = {}): { hook: HookState; pin: HookPin } {
    const s = this.assetOf(token);
    const hook: HookState = {
      address: at(0x5eb800 + this.assets.size),
      fee: o.fee ?? 3_000,
      cap: o.cap ?? 50_000,
      authority: o.authority ?? at(0xa362),
      code: `0x6080${token.slice(2, 10).toLowerCase()}`,
    };
    s.hook = hook;
    s.poolKey = { ...s.poolKey, fee: 0x800000, hooks: hook.address };
    s.slot0 = { ...s.slot0, lpFee: 0 };
    this.rpc.code.set(hook.address.toLowerCase(), hook.code);
    const id = () => poolIdOf(s.poolKey);
    this.rpc.contract(hook.address, fablesHookAbi as Abi, {
      currentFee: ([poolId]) => (poolId === id() ? hook.fee : 0),
      maxFee: ([poolId]) => (poolId === id() ? hook.cap : 0),
      authority: () => hook.authority,
    });
    const pin: HookPin = {
      symbol: "TEST",
      token,
      hook: hook.address,
      poolId: id(),
      hookCodehash: keccak256(hook.code),
      hookAuthority: hook.authority,
      hookFeeCap: hook.cap,
      hookMaxFeePips: o.maxFeePips ?? 4_000,
    };
    return { hook, pin };
  }

  /** A canonical v3 pool (the factory names it) at `addr`. */
  v3Pool(addr: Address, t0: Address, t1: Address, fee: number): void {
    this.v3Pools.set(addr.toLowerCase(), { t0, t1, fee });
    this.rpc.contract(addr, v3PoolAbi as Abi, { token0: () => t0, token1: () => t1, fee: () => fee });
  }

  /** What a pool quotes for `swapIn` USDG now. */
  quote(token: Address, swapIn: bigint): bigint {
    return cpQuote(feePool(this.assets.get(token.toLowerCase())!), swapIn);
  }

  private assetOf(a: Address): AssetState {
    const s = this.assets.get(a.toLowerCase());
    if (!s) throw new Revert("0x");
    return s;
  }

  private install() {
    const rpc = this.rpc;
    const acct = (a: Address) => this.accounts.get(a) ?? this.account(a);
    const wal = (w: Address) => this.wallets.get(w) ?? this.wallet(w);
    rpc.contract(this.book.sweepExecutor, sweepExecutorAbi as Abi, {
      paused: () => this.executor.paused,
      finalityBuffer: () => this.executor.finalityBuffer,
      threshold: () => this.executor.threshold,
      feeBps: () => this.executor.feeBps,
      currentEpoch: () => this.executor.epoch,
      remainingWeeklyCap: ([a]) => acct(a).remaining,
      sweptEpoch: ([a]) => acct(a).sweptEpoch,
      lastAccruedBlock: ([w], ctx) => (this.cursorAt ? this.cursorAt(w, ctx.block, wal(w).lastAccrued) : wal(w).lastAccrued),
      accrue: ([, w]) => {
        const r = this.accrueReverts.get(String(w).toLowerCase());
        if (r) throw r;
      },
      accrueBatch: ([entries]) =>
        this.accrueBatchResult ? this.accrueBatchResult(entries) : BigInt((entries as Entry[]).filter((e) => !this.batchSkips.has(e.wallet.toLowerCase())).length),
      sweep: ([accounts]) => (this.sweepResult ? this.sweepResult(accounts) : BigInt(accounts.length)),
    });
    rpc.contract(this.book.ruleRegistry, ruleRegistryAbi as Abi, {
      ruleOf: ([a]) => acct(a).rule,
      walletsOf: ([a]) => acct(a).wallets,
      activeSince: ([a]) => acct(a).activeSince,
      linkedAt: ([w]) => wal(w).linkedAt,
    });
    rpc.contract(USDG, erc20Abi as Abi, {
      paused: () => {
        if (this.usdgPaused === "revert") throw new Revert("0x");
        return this.usdgPaused;
      },
      allowance: ([w, spender]) => (String(spender).toLowerCase() === PERMIT2.toLowerCase() ? wal(w).erc20Allowance : 0n),
      balanceOf: ([w]) => wal(w).balance,
    });
    rpc.contract(PERMIT2, permit2Abi as Abi, {
      allowance: ([w, token, spender]) => {
        if (String(token).toLowerCase() !== USDG.toLowerCase() || String(spender).toLowerCase() !== this.book.sweepExecutor.toLowerCase()) return [0n, 0, 0];
        const p = wal(w).permit2;
        return [p.amount, p.expiration, p.nonce];
      },
    });
    rpc.contract(this.book.cashPark, cashParkAbi as Abi, { valueOf: (args: readonly any[]) => acct(args[0]).value });
    rpc.contract(this.book.screeningGate, screeningGateAbi as Abi, { isEligible: ([a]) => acct(a).eligible });
    rpc.contract(this.book.electionRegistry, electionRegistryAbi as Abi, { mixOf: ([a]) => acct(a).mix });
    rpc.contract(this.book.assetRegistry, assetRegistryAbi as Abi, {
      isEligible: ([a]) => this.assetOf(a).eligible,
      get: ([a]) => {
        const s = this.assetOf(a);
        return { token: s.token, feed: s.feed, feedDecimals: 8, heartbeat: 86_400, bandBps: 150, active: s.eligible, poolKey: s.poolKey };
      },
    });
    rpc.contract(this.book.stockRouter, stockRouterAbi as Abi, {
      oracleStatus: ([a]) => {
        const s = this.assetOf(a);
        return [s.status, s.status === 0 ? s.price1e18 : 0n];
      },
    });
    rpc.contract(VENUE.v4Quoter, v4QuoterAbi as Abi, {
      quoteExactInputSingle: ([p]) => {
        const k = p.poolKey as PoolKey;
        const token = k.currency0.toLowerCase() === USDG.toLowerCase() ? k.currency1 : k.currency0;
        const s = this.assetOf(token);
        if (poolIdOf(k) !== poolIdOf(s.poolKey)) throw new Revert("0x");
        // The keeper always sells USDG: zeroForOne iff USDG is currency0.
        if (p.zeroForOne !== (k.currency0.toLowerCase() === USDG.toLowerCase())) throw new Revert("0x");
        return [cpQuote(feePool(s), p.exactAmount as bigint), 120_000n];
      },
    });
    rpc.contract(VENUE.v4StateView, stateViewAbi as Abi, {
      getSlot0: ([id]) => {
        const s = [...this.assets.values()].find((x) => poolIdOf(x.poolKey) === id);
        if (!s) throw new Revert("0x");
        return [2n ** 96n, 0, s.slot0.protocolFee, s.slot0.lpFee];
      },
    });
    rpc.contract(VENUE.v3Factory, v3FactoryAbi as Abi, {
      getPool: ([t0, t1, fee]) => {
        for (const [addr, p] of this.v3Pools) {
          if (p.t0.toLowerCase() === String(t0).toLowerCase() && p.t1.toLowerCase() === String(t1).toLowerCase() && p.fee === Number(fee)) return getAddress(addr);
        }
        return at(0);
      },
    });
  }

  /** What a mined keeper tx does to the world. */
  private mined(tx: SentTx) {
    if (tx.functionName === "accrueBatch") {
      const logs = (tx.args[0] as Entry[]).map((e) => {
        const reason = this.batchSkips.get(e.wallet.toLowerCase());
        if (reason) return encodeLog(this.book.sweepExecutor, SKIPPED, { account: e.account, wallet: e.wallet, toBlock: e.toBlock, reason });
        const w = this.wallet(e.wallet);
        const from = w.lastAccrued;
        w.lastAccrued = e.toBlock;
        return encodeLog(this.book.sweepExecutor, ACCRUED, { account: e.account, wallet: e.wallet, amount: e.amount, fromBlock: from, toBlock: e.toBlock });
      });
      return { logs };
    }
    if (tx.functionName === "sweep") {
      const [accounts, limits] = tx.args as [Address[], { asset: Address; minOutPerUsdg: bigint }[]];
      const netted = new Map<string, bigint>();
      const legs: { account: Address; asset: string; usdg: bigint }[] = [];
      for (const a of accounts) {
        const s = this.account(a);
        for (const leg of splitMix(s.value, s.mix)) {
          netted.set(leg.asset.toLowerCase(), (netted.get(leg.asset.toLowerCase()) ?? 0n) + leg.usdg);
          legs.push({ account: a, asset: leg.asset.toLowerCase(), usdg: leg.usdg });
        }
        s.sweptEpoch = this.executor.epoch;
        s.value = 0n;
      }
      const logs = [];
      for (const l of limits) {
        const reason = this.sweepDefers.get(l.asset.toLowerCase());
        if (reason) {
          // Deferred: its contributors' USDG goes back to their parks; the epoch stays spent.
          logs.push(encodeLog(this.book.sweepExecutor, SWAP_DEFERRED, { asset: l.asset, usdg: netted.get(l.asset.toLowerCase()) ?? 0n, reason }));
          for (const leg of legs) if (leg.asset === l.asset.toLowerCase()) this.account(leg.account).value += leg.usdg;
          continue;
        }
        const s = this.assetOf(l.asset);
        const dx = swapInFor(netted.get(l.asset.toLowerCase()) ?? 0n, BigInt(this.executor.feeBps));
        const out = cpQuote(feePool(s), dx);
        s.pool = { ...s.pool, x: s.pool.x + dx, y: s.pool.y - out };
      }
      return { logs };
    }
    return {};
  }
}

export interface Entry {
  account: Address;
  wallet: Address;
  amount: bigint;
  toBlock: bigint;
}

/** Keeper env for the fake chain: broadcast on, test key, small idle window. */
export function keeperEnv(env: Record<string, string> = {}): Record<string, string> {
  return { KEEPER_PK: TEST_PK, KEEPER_BROADCAST: "1", IDLE_ADVANCE_BLOCKS: "10000", ...env };
}

/** A Keeper on `world`'s fake chain. */
export function keeperOn(world: SpareWorld, env: Record<string, string> = {}): Keeper {
  return new Keeper(loadConfig(keeperEnv(env)), world.book, world.rpc.transport());
}

/** console.log / warn / error lines while installed (and silenced; `errors` holds console.error's alone); `restore()` puts them back. */
export function captureLogs(): { lines: string[]; errors: string[]; has: (s: string | RegExp) => boolean; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const log = spyOn(console, "log").mockImplementation(grab);
  const warn = spyOn(console, "warn").mockImplementation(grab);
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    grab(...a);
    errors.push(a.map(String).join(" "));
  });
  return {
    lines,
    errors,
    has: (s) => lines.some((l) => (typeof s === "string" ? l.includes(s) : s.test(l))),
    restore: () => {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    },
  };
}
