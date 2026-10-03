/**
 * Typed reads of SPARE contract state.
 *
 * Each function is ONE Multicall3 eth_call (or two, when the second depends on
 * the first), so every figure in a response comes from the same block — a
 * progress bar is never `value` from one block over `threshold` from another.
 * Each snapshot carries `timestamp` (the block.timestamp the state was read at,
 * via Multicall3.getCurrentBlockTimestamp) so views that depend on time
 * (weekly cap window, epochs, feed age) are computed against the chain's clock,
 * not the server's.
 *
 * Solidity `block.number` is NOT used anywhere: on Nitro it is an L1 estimate.
 * The L2 head is eth_blockNumber, read alongside.
 */
import { erc20Abi, multicall3Abi, type Address, type PublicClient } from "viem";
import {
  aggregatorV3Abi,
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  parkAdapterAbi,
  permit2Abi,
  ruleRegistryAbi,
  screeningGateAbi,
  stockRouterAbi,
  stockTokenAbi,
  sweepExecutorAbi,
} from "./abis.ts";
import { MULTICALL3 } from "./constants.ts";
import type { SpareAddresses } from "./addresses.ts";

const TS = { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" } as const;

export interface Rule {
  roundTo: number;
  multiplier: number;
  weeklyCap: bigint;
  enabled: boolean;
  /** RuleRegistry returns zeros for an account that never called setRule. */
  set: boolean;
}

export interface Leg {
  asset: Address;
  bps: number;
}

// ---------------------------------------------------------------------------
// immutables (cached per client + contract set)
// ---------------------------------------------------------------------------
export interface Immutables {
  usdg: Address;
  permit2: Address;
  poolManager: Address;
  parkUsdg: Address;
}

const immCache = new WeakMap<PublicClient, Map<string, Immutables>>();

export async function readImmutables(client: PublicClient, a: SpareAddresses): Promise<Immutables> {
  let m = immCache.get(client);
  if (!m) immCache.set(client, (m = new Map()));
  const key = `${a.sweepExecutor}:${a.stockRouter}:${a.cashPark}`;
  const hit = m.get(key);
  if (hit) return hit;
  const [usdg, permit2, poolManager, parkUsdg] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: a.stockRouter, abi: stockRouterAbi, functionName: "usdg" },
      { address: a.sweepExecutor, abi: sweepExecutorAbi, functionName: "permit2" },
      { address: a.stockRouter, abi: stockRouterAbi, functionName: "poolManager" },
      { address: a.cashPark, abi: cashParkAbi, functionName: "usdg" },
    ],
  });
  const imm = { usdg, permit2, poolManager, parkUsdg };
  m.set(key, imm);
  return imm;
}

// ---------------------------------------------------------------------------
// executor parameters
// ---------------------------------------------------------------------------
export interface ExecutorParams {
  timestamp: bigint;
  finalityBuffer: bigint;
  threshold: bigint;
  feeBps: number;
  slippageBps: number;
  epochLength: bigint;
  currentEpoch: bigint;
  paused: boolean;
  maxBatch: bigint;
}

export async function readExecutorParams(client: PublicClient, a: SpareAddresses): Promise<ExecutorParams> {
  const x = { address: a.sweepExecutor, abi: sweepExecutorAbi } as const;
  const [timestamp, finalityBuffer, threshold, feeBps, slippageBps, epochLength, currentEpoch, paused, maxBatch] =
    await client.multicall({
      allowFailure: false,
      contracts: [
        TS,
        { ...x, functionName: "finalityBuffer" },
        { ...x, functionName: "threshold" },
        { ...x, functionName: "feeBps" },
        { ...x, functionName: "slippageBps" },
        { ...x, functionName: "epochLength" },
        { ...x, functionName: "currentEpoch" },
        { ...x, functionName: "paused" },
        { ...x, functionName: "MAX_BATCH" },
      ],
    });
  return { timestamp, finalityBuffer, threshold, feeBps, slippageBps, epochLength: BigInt(epochLength), currentEpoch, paused, maxBatch };
}

// ---------------------------------------------------------------------------
// one account
// ---------------------------------------------------------------------------
export interface AccountState extends ExecutorParams {
  rule: Rule;
  wallets: Address[];
  /** If `account` is linked as a spending wallet of ANOTHER account, that account (a self-link is null). */
  linkedTo: Address | null;
  pending: bigint;
  units: bigint;
  value: bigint;
  /** USDG pulled over the executor's rolling 7-day window. */
  pulledLast7Days: bigint;
  /** L2 block the rule last became active (accrual never reaches before it). */
  activeSince: bigint;
  sweptEpoch: bigint;
  remainingWeeklyCap: bigint;
  claimableUsdg: bigint;
  screening: { eligible: boolean; enforced: boolean; clearedUntil: bigint };
  mix: Leg[];
  hasOwnMix: boolean;
  parkFresh: boolean;
  parkPaused: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export async function readAccount(client: PublicClient, a: SpareAddresses, account: Address): Promise<AccountState> {
  const imm = await readImmutables(client, a);
  const x = { address: a.sweepExecutor, abi: sweepExecutorAbi } as const;
  const r = { address: a.ruleRegistry, abi: ruleRegistryAbi } as const;
  const p = { address: a.cashPark, abi: cashParkAbi } as const;
  const e = { address: a.electionRegistry, abi: electionRegistryAbi } as const;
  const s = { address: a.screeningGate, abi: screeningGateAbi } as const;
  const res = await client.multicall({
    allowFailure: false,
    contracts: [
      TS,
      { ...x, functionName: "finalityBuffer" },
      { ...x, functionName: "threshold" },
      { ...x, functionName: "feeBps" },
      { ...x, functionName: "slippageBps" },
      { ...x, functionName: "epochLength" },
      { ...x, functionName: "currentEpoch" },
      { ...x, functionName: "paused" },
      { ...x, functionName: "MAX_BATCH" },
      { ...r, functionName: "ruleOf", args: [account] },
      { ...r, functionName: "walletsOf", args: [account] },
      { ...r, functionName: "accountOf", args: [account] },
      { ...p, functionName: "pending", args: [account] },
      { ...p, functionName: "units", args: [account] },
      { ...p, functionName: "valueOf", args: [account] },
      { ...x, functionName: "pulledLast7Days", args: [account] },
      { ...r, functionName: "activeSince", args: [account] },
      { ...x, functionName: "sweptEpoch", args: [account] },
      { ...x, functionName: "remainingWeeklyCap", args: [account] },
      { ...x, functionName: "claimable", args: [account, imm.usdg] },
      { ...s, functionName: "isEligible", args: [account] },
      { ...s, functionName: "enforced" },
      { ...s, functionName: "clearedUntil", args: [account] },
      { ...e, functionName: "mixOf", args: [account] },
      { ...e, functionName: "hasOwnMix", args: [account] },
      { ...p, functionName: "isFresh" },
      { ...p, functionName: "paused" },
    ],
  });
  const [
    timestamp, finalityBuffer, threshold, feeBps, slippageBps, epochLength, currentEpoch, paused, maxBatch,
    rule, wallets, accountOf, pending, units, value, pulledLast7Days, activeSince, sweptEpoch, remainingWeeklyCap,
    claimableUsdg, eligible, enforced, clearedUntil, mix, hasOwnMix, parkFresh, parkPaused,
  ] = res;
  return {
    timestamp,
    finalityBuffer,
    threshold,
    feeBps,
    slippageBps,
    epochLength: BigInt(epochLength),
    currentEpoch,
    paused,
    maxBatch,
    rule: { ...rule, weeklyCap: BigInt(rule.weeklyCap), set: rule.roundTo !== 0 },
    wallets: [...wallets],
    linkedTo: accountOf.toLowerCase() === ZERO || accountOf.toLowerCase() === account.toLowerCase() ? null : accountOf,
    pending,
    units,
    value,
    pulledLast7Days,
    activeSince,
    sweptEpoch,
    remainingWeeklyCap,
    claimableUsdg,
    screening: { eligible, enforced, clearedUntil: BigInt(clearedUntil) },
    mix: mix.map((l) => ({ asset: l.asset, bps: l.bps })),
    hasOwnMix,
    parkFresh,
    parkPaused,
  };
}

// ---------------------------------------------------------------------------
// link set (light)
// ---------------------------------------------------------------------------
export async function readLinkSet(
  client: PublicClient,
  a: SpareAddresses,
  account: Address,
): Promise<{ timestamp: bigint; wallets: Address[]; linkedTo: Address | null; maxWallets: bigint; rule: Rule }> {
  const r = { address: a.ruleRegistry, abi: ruleRegistryAbi } as const;
  const [timestamp, wallets, accountOf, maxWallets, rule] = await client.multicall({
    allowFailure: false,
    contracts: [
      TS,
      { ...r, functionName: "walletsOf", args: [account] },
      { ...r, functionName: "accountOf", args: [account] },
      { ...r, functionName: "MAX_WALLETS" },
      { ...r, functionName: "ruleOf", args: [account] },
    ],
  });
  return {
    timestamp,
    wallets: [...wallets],
    linkedTo: accountOf.toLowerCase() === ZERO || accountOf.toLowerCase() === account.toLowerCase() ? null : accountOf,
    maxWallets,
    rule: { ...rule, weeklyCap: BigInt(rule.weeklyCap), set: rule.roundTo !== 0 },
  };
}

// ---------------------------------------------------------------------------
// per-wallet state
// ---------------------------------------------------------------------------
export interface WalletState {
  wallet: Address;
  accountOf: Address | null;
  linkedAt: bigint;
  lastAccruedBlock: bigint;
  /** Cursor the next accrual starts after: max(lastAccruedBlock, linkedAt). */
  accrualCursor: bigint;
  usdgBalance: bigint;
  permit2: { amount: bigint; expiration: number; nonce: number };
  /** USDG allowance the wallet granted Permit2 itself (ERC-20 approve). */
  erc20AllowanceToPermit2: bigint;
}

export async function readWallets(client: PublicClient, a: SpareAddresses, wallets: readonly Address[]): Promise<WalletState[]> {
  if (wallets.length === 0) return [];
  const imm = await readImmutables(client, a);
  const perWallet = 6;
  const contracts = wallets.flatMap((w) => [
    { address: a.ruleRegistry, abi: ruleRegistryAbi, functionName: "accountOf", args: [w] },
    { address: a.ruleRegistry, abi: ruleRegistryAbi, functionName: "linkedAt", args: [w] },
    { address: a.sweepExecutor, abi: sweepExecutorAbi, functionName: "lastAccruedBlock", args: [w] },
    { address: imm.usdg, abi: erc20Abi, functionName: "balanceOf", args: [w] },
    { address: imm.permit2, abi: permit2Abi, functionName: "allowance", args: [w, imm.usdg, a.sweepExecutor] },
    { address: imm.usdg, abi: erc20Abi, functionName: "allowance", args: [w, imm.permit2] },
  ]);
  const res = (await client.multicall({ allowFailure: false, contracts: contracts as never })) as unknown[];
  return wallets.map((wallet, i) => {
    const o = i * perWallet;
    const accountOf = res[o] as Address;
    const linkedAt = res[o + 1] as bigint;
    const lastAccruedBlock = res[o + 2] as bigint;
    const [amount, expiration, nonce] = res[o + 4] as readonly [bigint, number, number];
    return {
      wallet,
      accountOf: accountOf.toLowerCase() === ZERO ? null : accountOf,
      linkedAt,
      lastAccruedBlock,
      accrualCursor: lastAccruedBlock > linkedAt ? lastAccruedBlock : linkedAt,
      usdgBalance: res[o + 3] as bigint,
      permit2: { amount, expiration: Number(expiration), nonce: Number(nonce) },
      erc20AllowanceToPermit2: res[o + 5] as bigint,
    };
  });
}

// ---------------------------------------------------------------------------
// mixes
// ---------------------------------------------------------------------------
export async function readMix(
  client: PublicClient,
  a: SpareAddresses,
  account: Address,
): Promise<{ timestamp: bigint; mix: Leg[]; hasOwnMix: boolean; defaultMix: Leg[]; maxLegs: bigint }> {
  const e = { address: a.electionRegistry, abi: electionRegistryAbi } as const;
  const [timestamp, mix, hasOwnMix, defaultMix, maxLegs] = await client.multicall({
    allowFailure: false,
    contracts: [
      TS,
      { ...e, functionName: "mixOf", args: [account] },
      { ...e, functionName: "hasOwnMix", args: [account] },
      { ...e, functionName: "defaultMix" },
      { ...e, functionName: "MAX_LEGS" },
    ],
  });
  const legs = (ls: readonly { asset: Address; bps: number }[]) => ls.map((l) => ({ asset: l.asset, bps: l.bps }));
  return { timestamp, mix: legs(mix), hasOwnMix, defaultMix: legs(defaultMix), maxLegs };
}

// ---------------------------------------------------------------------------
// registry assets + oracle state
// ---------------------------------------------------------------------------
export interface RegistryAsset {
  token: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  feed: Address;
  feedDecimals: number;
  heartbeat: number;
  bandBps: number;
  active: boolean;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  /** OracleGuard verdict via StockRouter.oracleStatus. */
  oracle: { status: number; price1e18: bigint };
  feedRound: { roundId: bigint; answer: bigint; startedAt: bigint; updatedAt: bigint } | null;
  token8056: {
    uiMultiplier: bigint | null;
    newUIMultiplier: bigint | null;
    effectiveAt: bigint | null;
    paused: boolean | null;
    oraclePaused: boolean | null;
  };
}

export interface RegistryState {
  timestamp: bigint;
  sequencerFeed: Address | null;
  assets: RegistryAsset[];
}

type Ok<T> = { status: "success"; result: T } | { status: "failure"; error: Error };
const val = <T>(r: unknown): T | null => ((r as Ok<T>).status === "success" ? (r as { result: T }).result : null);

export async function readRegistry(client: PublicClient, a: SpareAddresses): Promise<RegistryState> {
  const [tokens, sequencerFeed] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: a.assetRegistry, abi: assetRegistryAbi, functionName: "tokens" },
      { address: a.stockRouter, abi: stockRouterAbi, functionName: "sequencerFeed" },
    ],
  });
  const per = 10;
  const phase1 = tokens.flatMap((t) => [
    { address: a.assetRegistry, abi: assetRegistryAbi, functionName: "get", args: [t] },
    { address: a.stockRouter, abi: stockRouterAbi, functionName: "oracleStatus", args: [t] },
    { address: t, abi: erc20Abi, functionName: "symbol" },
    { address: t, abi: erc20Abi, functionName: "name" },
    { address: t, abi: erc20Abi, functionName: "decimals" },
    { address: t, abi: stockTokenAbi, functionName: "uiMultiplier" },
    { address: t, abi: stockTokenAbi, functionName: "newUIMultiplier" },
    { address: t, abi: stockTokenAbi, functionName: "effectiveAt" },
    { address: t, abi: stockTokenAbi, functionName: "paused" },
    { address: t, abi: stockTokenAbi, functionName: "oraclePaused" },
  ]);
  const r1 = (await client.multicall({ allowFailure: true, contracts: [TS, ...phase1] as never })) as unknown[];
  const timestamp = val<bigint>(r1[0]);
  if (timestamp === null) throw new Error("Multicall3.getCurrentBlockTimestamp failed");

  type AssetStruct = Omit<RegistryAsset, "symbol" | "name" | "decimals" | "oracle" | "feedRound" | "token8056">;
  const base = tokens.map((token, i) => {
    const o = 1 + i * per;
    const got = val<AssetStruct>(r1[o]);
    const os = val<readonly [number, bigint]>(r1[o + 1]);
    if (!got || !os) throw new Error(`registry read failed for ${token}`);
    return {
      got,
      oracle: { status: Number(os[0]), price1e18: os[1] },
      symbol: val<string>(r1[o + 2]),
      name: val<string>(r1[o + 3]),
      decimals: val<number>(r1[o + 4]),
      token8056: {
        uiMultiplier: val<bigint>(r1[o + 5]),
        newUIMultiplier: val<bigint>(r1[o + 6]),
        effectiveAt: val<bigint>(r1[o + 7]),
        paused: val<boolean>(r1[o + 8]),
        oraclePaused: val<boolean>(r1[o + 9]),
      },
    };
  });

  const r2 = (await client.multicall({
    allowFailure: true,
    contracts: base.map((b) => ({ address: b.got.feed, abi: aggregatorV3Abi, functionName: "latestRoundData" })) as never,
  })) as unknown[];

  const assets: RegistryAsset[] = base.map((b, i) => {
    const round = val<readonly [bigint, bigint, bigint, bigint, bigint]>(r2[i]);
    return {
      token: b.got.token,
      symbol: b.symbol,
      name: b.name,
      decimals: b.decimals === null ? null : Number(b.decimals),
      feed: b.got.feed,
      feedDecimals: Number(b.got.feedDecimals),
      heartbeat: Number(b.got.heartbeat),
      bandBps: Number(b.got.bandBps),
      active: b.got.active,
      poolKey: {
        currency0: b.got.poolKey.currency0,
        currency1: b.got.poolKey.currency1,
        fee: Number(b.got.poolKey.fee),
        tickSpacing: Number(b.got.poolKey.tickSpacing),
        hooks: b.got.poolKey.hooks,
      },
      oracle: b.oracle,
      feedRound: round ? { roundId: round[0], answer: round[1], startedAt: round[2], updatedAt: round[3] } : null,
      token8056: b.token8056,
    };
  });
  return { timestamp, sequencerFeed: sequencerFeed.toLowerCase() === ZERO ? null : sequencerFeed, assets };
}

/** Raw Chainlink round for arbitrary feeds (USDG/USD, ETH/USD, ...). */
export async function readFeeds(
  client: PublicClient,
  feeds: readonly Address[],
): Promise<{ timestamp: bigint; rounds: ({ decimals: number; roundId: bigint; answer: bigint; updatedAt: bigint } | null)[] }> {
  const contracts = feeds.flatMap((f) => [
    { address: f, abi: aggregatorV3Abi, functionName: "decimals" },
    { address: f, abi: aggregatorV3Abi, functionName: "latestRoundData" },
  ]);
  const r = (await client.multicall({ allowFailure: true, contracts: [TS, ...contracts] as never })) as unknown[];
  const timestamp = val<bigint>(r[0]);
  if (timestamp === null) throw new Error("Multicall3.getCurrentBlockTimestamp failed");
  return {
    timestamp,
    rounds: feeds.map((_, i) => {
      const d = val<number>(r[1 + i * 2]);
      const round = val<readonly [bigint, bigint, bigint, bigint, bigint]>(r[2 + i * 2]);
      return d === null || !round ? null : { decimals: Number(d), roundId: round[0], answer: round[1], updatedAt: round[3] };
    }),
  };
}

// ---------------------------------------------------------------------------
// park
// ---------------------------------------------------------------------------
export interface ParkState {
  timestamp: bigint;
  adapter: Address | null;
  underlying: Address | null;
  underlyingSymbol: string | null;
  underlyingDecimals: number | null;
  isFresh: boolean | null;
  paused: boolean;
  totalPending: bigint;
  totalUnits: bigint;
  /** USDG value of ONE whole underlying unit at the adapter's NAV. */
  navPerUnit: bigint | null;
  /** USDG value of every parked unit. */
  parkedValue: bigint | null;
}

export async function readPark(client: PublicClient, a: SpareAddresses): Promise<ParkState> {
  const p = { address: a.cashPark, abi: cashParkAbi } as const;
  const [timestamp, adapter, totalPending, totalUnits, paused] = await client.multicall({
    allowFailure: false,
    contracts: [
      TS,
      { ...p, functionName: "adapter" },
      { ...p, functionName: "totalPending" },
      { ...p, functionName: "totalUnits" },
      { ...p, functionName: "paused" },
    ],
  });
  if (adapter.toLowerCase() === ZERO) {
    return {
      timestamp, adapter: null, underlying: null, underlyingSymbol: null, underlyingDecimals: null,
      isFresh: null, paused, totalPending, totalUnits, navPerUnit: null, parkedValue: null,
    };
  }
  const ad = { address: adapter, abi: parkAdapterAbi } as const;
  const underlying = await client.readContract({ ...ad, functionName: "underlying" });
  // isFresh / valueOf can revert (the SGOV adapter reads the registry and the
  // feed) — a failed read is reported as null, never as "fresh" or "0".
  const r = (await client.multicall({
    allowFailure: true,
    contracts: [
      { ...ad, functionName: "isFresh" },
      { address: underlying, abi: erc20Abi, functionName: "decimals" },
      { address: underlying, abi: erc20Abi, functionName: "symbol" },
    ],
  })) as unknown[];
  const isFresh = val<boolean>(r[0]);
  const decimals = val<number>(r[1]);
  const symbol = val<string>(r[2]);
  let navPerUnit: bigint | null = null;
  let parkedValue: bigint | null = null;
  if (decimals !== null) {
    const v = (await client.multicall({
      allowFailure: true,
      contracts: [
        { ...ad, functionName: "valueOf", args: [10n ** BigInt(decimals)] },
        { ...ad, functionName: "valueOf", args: [totalUnits] },
      ],
    })) as unknown[];
    navPerUnit = val<bigint>(v[0]);
    parkedValue = val<bigint>(v[1]);
  }
  return {
    timestamp, adapter, underlying, underlyingSymbol: symbol,
    underlyingDecimals: decimals === null ? null : Number(decimals),
    isFresh, paused, totalPending, totalUnits, navPerUnit, parkedValue,
  };
}
