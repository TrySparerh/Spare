/**
 * wagmi hooks shared by the Spare desktop apps.
 *
 *   useSpareDeployment  bytecode check at SweepExecutor (gates every read)
 *   useSpareTx          switch chain -> simulate -> sign -> wait for receipt,
 *                       with an optional queue for multi-step writes
 *   useUniverse         the registry catalog (universe.ts) + live oracle status
 *   useSweepParams      SweepExecutor threshold / fee / epoch / pause
 *   useSpareAccount     which ACCOUNT the connected wallet is (itself, or the
 *                       account it feeds as a linked spending wallet)
 *   usePullConsent      both pull approvals for each of an account's wallets
 *
 * Every read pins `chainId: 4663` so it works even while the wallet sits on
 * another chain; every write switches the wallet to 4663 first.
 *
 * Words shown to people (oracle badges, tx errors) come from the
 * apps-b namespace and are built when read, so they follow the live language.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  erc20Abi,
  zeroAddress,
  type Abi,
  type Address,
  type ContractFunctionName,
  type ContractFunctionParameters,
  type Hash,
} from 'viem';
import {
  aggregatorV3Abi,
  electionRegistryAbi,
  permit2Abi,
  ruleRegistryAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from './abis';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, isDeployed, sameAddress } from './addresses';
import { consentView, type WalletConsent } from './consent';
import { humanizeError } from './errors';
import { to1e18 } from '@/lib/spare';
import { getT } from '@/i18n';
import { useAssetCatalog, type AssetKind } from './universe';
import type { PoolKey } from './fund-swap';

const tf = getT('apps-b');

const chainId = SPARE_CHAIN_ID;

/* ------------------------------- deployment -------------------------------- */

export interface DeploymentState {
  deployed: boolean;
  checking: boolean;
  error: string | null;
}

export function useSpareDeployment(): DeploymentState {
  const client = usePublicClient({ chainId });
  const q = useQuery({
    queryKey: ['spare', 'deployed', SPARE.SweepExecutor],
    queryFn: () => isDeployed(client!),
    enabled: !!client,
    staleTime: Infinity,
    // Keep asking while the answer is "not yet", so an open window flips to
    // live on its own the moment the broadcast lands.
    refetchInterval: (query) => (query.state.data === true ? false : 30_000),
    retry: 2,
  });
  return {
    deployed: q.data === true,
    checking: q.isPending,
    error: q.error ? humanizeError(q.error) : null,
  };
}

/* --------------------------------- writes ---------------------------------- */

export type TxPhase = 'idle' | 'switching' | 'checking' | 'wallet' | 'pending' | 'confirmed' | 'error';

export interface TxState {
  phase: TxPhase;
  /** What the user asked for, e.g. "Save rule". */
  label: string;
  hash?: Hash;
  error?: string;
  /** 1-based position in a multi-step run, and its length. */
  step: number;
  steps: number;
}

/** A contract write: address + abi + functionName + args, type-checked per ABI. */
export type SpareWrite<
  abi extends Abi = Abi,
  fn extends ContractFunctionName<abi, 'nonpayable' | 'payable'> = ContractFunctionName<abi, 'nonpayable' | 'payable'>,
> = ContractFunctionParameters<abi, 'nonpayable' | 'payable', fn>;

export interface TxStep {
  label: string;
  write: SpareWrite;
}

/** Build a TxStep with full argument checking against the ABI. */
export function txStep<abi extends Abi, fn extends ContractFunctionName<abi, 'nonpayable' | 'payable'>>(
  label: string,
  write: SpareWrite<abi, fn>,
): TxStep {
  return { label, write: write as unknown as SpareWrite };
}

/** Refetch every contract read on screen — all Spare windows share one cache. */
export function invalidateSpareReads(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey[0];
      return k === 'readContract' || k === 'readContracts' || k === 'balance' || (k === 'spare' && q.queryKey[1] !== 'deployed');
    },
  });
}

const IDLE: TxState = { phase: 'idle', label: '', step: 0, steps: 0 };

/**
 * One write pipeline per app section. `run([...steps])` executes the steps in
 * order; each waits for its receipt (useWaitForTransactionReceipt) before the
 * next is simulated and sent, and any failure stops the queue.
 */
export function useSpareTx() {
  const { address, chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId });
  const queryClient = useQueryClient();

  const [state, setState] = useState<TxState>(IDLE);
  const queue = useRef<TxStep[]>([]);
  const onDone = useRef<((hash: Hash) => void) | undefined>(undefined);
  const handled = useRef<Set<string>>(new Set());

  const receipt = useWaitForTransactionReceipt({
    hash: state.phase === 'pending' ? state.hash : undefined,
    chainId,
    query: { enabled: state.phase === 'pending' && !!state.hash },
  });

  const sendOne = useCallback(
    async (step: TxStep, index: number, total: number) => {
      const base = { label: step.label, step: index, steps: total };
      if (!address) {
        setState({ ...base, phase: 'error', error: tf('tx.connectFirst') });
        return;
      }
      try {
        if (walletChainId !== chainId) {
          setState({ ...base, phase: 'switching' });
          await switchChainAsync({ chainId });
        }
        setState({ ...base, phase: 'checking' });
        // Simulate against our own RPC first: a revert comes back decoded
        // (custom error + args) instead of as a wallet's opaque gas failure.
        const w = step.write as SpareWrite & { value?: bigint };
        await client!.simulateContract({ ...(w as object), account: address } as Parameters<NonNullable<typeof client>['simulateContract']>[0]);
        setState({ ...base, phase: 'wallet' });
        const hash = await writeContractAsync({ ...(w as object), account: address, chainId } as Parameters<typeof writeContractAsync>[0]);
        setState({ ...base, phase: 'pending', hash });
      } catch (e) {
        queue.current = [];
        setState({ ...base, phase: 'error', error: humanizeError(e) });
      }
    },
    [address, walletChainId, switchChainAsync, client, writeContractAsync],
  );

  // Receipt landed: advance the queue, or finish.
  useEffect(() => {
    if (state.phase !== 'pending' || !state.hash) return;
    const hash = state.hash;
    if (receipt.data && receipt.data.transactionHash === hash) {
      if (handled.current.has(hash)) return;
      handled.current.add(hash);
      if (receipt.data.status !== 'success') {
        queue.current = [];
        setState((s) => ({ ...s, phase: 'error', error: tf('tx.revertedOnChain') }));
        return;
      }
      void invalidateSpareReads(queryClient);
      const next = queue.current.shift();
      if (next) {
        void sendOne(next, state.step + 1, state.steps);
      } else {
        setState((s) => ({ ...s, phase: 'confirmed' }));
        onDone.current?.(hash);
      }
    } else if (receipt.error) {
      queue.current = [];
      setState((s) => ({ ...s, phase: 'error', error: humanizeError(receipt.error) }));
    }
  }, [receipt.data, receipt.error, state.phase, state.hash, state.step, state.steps, queryClient, sendOne]);

  const run = useCallback(
    (steps: TxStep[], done?: (hash: Hash) => void) => {
      if (steps.length === 0) return;
      queue.current = steps.slice(1);
      onDone.current = done;
      void sendOne(steps[0], 1, steps.length);
    },
    [sendOne],
  );

  const reset = useCallback(() => {
    queue.current = [];
    setState(IDLE);
  }, []);

  const busy = state.phase === 'switching' || state.phase === 'checking' || state.phase === 'wallet' || state.phase === 'pending';

  return { state, run, reset, busy };
}

/* --------------------------------- oracle ---------------------------------- */

export const ORACLE_OK = 0;

export interface OracleView {
  /** Short badge text. */
  label: string;
  tone: 'up' | 'warn' | 'down' | 'muted';
  /** One line on what it means for a sweep. */
  detail: string;
}

/**
 * OracleGuard.Status -> what the user should read. Any non-OK status DEFERS a sweep leg.
 * Label and detail are in the live language: call it at render, and compare `status`, not the label.
 */
export function oracleView(status: number | null | undefined): OracleView {
  switch (status) {
    case 0: return { label: tf('oracle.label.live'), tone: 'up', detail: tf('oracle.detail.live') };
    // STALE only once the last answer is older than heartbeat + 1h grace
    // (OracleGuard) — for a daily feed that is ~25h after the last update, so
    // the first ~day of a weekend still reads OK at Friday's close.
    case 1: return { label: tf('oracle.label.stale'), tone: 'warn', detail: tf('oracle.detail.stale') };
    case 2: return { label: tf('oracle.label.paused'), tone: 'warn', detail: tf('oracle.detail.paused') };
    case 3: return { label: tf('oracle.label.seqDown'), tone: 'warn', detail: tf('oracle.detail.seqDown') };
    case 4: return { label: tf('oracle.label.badAnswer'), tone: 'down', detail: tf('oracle.detail.badAnswer') };
    default: return { label: '—', tone: 'muted', detail: tf('oracle.detail.unknown') };
  }
}

/* -------------------------------- universe --------------------------------- */

export interface UniverseAsset {
  token: Address;
  symbol: string;
  /** token.name() without the Robinhood suffix, null until read. */
  name: string | null;
  /** ETF / fund or single stock (from the name). */
  kind: AssetKind;
  active: boolean;
  feed?: Address;
  feedDecimals?: number;
  heartbeat?: number;
  bandBps?: number;
  /** The one Uniswap v4 pool the registry pins for this asset. */
  poolKey: PoolKey | null;
  hooked: boolean;
  /** OracleGuard.Status, null while unread / on read failure. */
  status: number | null;
  /** Guarded price (0 unless status OK), 1e18 USD per token. */
  price1e18: bigint;
  /** Chainlink's last answer regardless of staleness (1e18), when requested. */
  lastPrice1e18?: bigint;
  /** Unix seconds of that last answer. */
  lastUpdatedAt?: number;
}

/**
 * The eligible universe straight from AssetRegistry (the shared, cached
 * catalog in universe.ts), with the router's guarded oracle status for each
 * token. `withFeedPrices` also reads each Chainlink feed directly so a weekend
 * (STALE) can still show the last close. Nothing here lists tokens itself.
 */
export function useUniverse({ enabled, withFeedPrices = false }: { enabled: boolean; withFeedPrices?: boolean }) {
  const catalog = useAssetCatalog({ enabled });
  const metas = catalog.assets;

  const statusQ = useReadContracts({
    allowFailure: true,
    contracts: metas.map((m) => ({ address: SPARE.StockRouter, abi: stockRouterAbi, functionName: 'oracleStatus', args: [m.token], chainId }) as const),
    query: { enabled: enabled && metas.length > 0, refetchInterval: 60_000 },
  });

  const feeds = metas.map((m) => m.feed).filter(Boolean) as Address[];
  const feedQ = useReadContracts({
    allowFailure: true,
    contracts: feeds.map((f) => ({ address: f, abi: aggregatorV3Abi, functionName: 'latestRoundData', chainId }) as const),
    query: { enabled: enabled && withFeedPrices && feeds.length > 0, refetchInterval: 60_000 },
  });

  let feedIdx = 0;
  const assets: UniverseAsset[] = metas.map((m, i) => {
    const os = statusQ.data?.[i]?.result as readonly [number, bigint] | undefined;
    const a: UniverseAsset = {
      token: m.token,
      symbol: m.symbol,
      name: m.name,
      kind: m.kind,
      active: m.active,
      feed: m.feed ?? undefined,
      feedDecimals: m.feedDecimals ?? undefined,
      heartbeat: m.heartbeat ?? undefined,
      bandBps: m.bandBps ?? undefined,
      poolKey: m.poolKey,
      hooked: m.hooked,
      status: os ? Number(os[0]) : null,
      price1e18: os ? os[1] : 0n,
    };
    if (m.feed) {
      const round = feedQ.data?.[feedIdx]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
      feedIdx += 1;
      if (round && round[1] > 0n && m.feedDecimals != null) {
        a.lastPrice1e18 = to1e18(round[1], Number(m.feedDecimals));
        a.lastUpdatedAt = Number(round[3]);
      }
    }
    return a;
  });

  return {
    assets,
    isLoading: catalog.isLoading || (metas.length > 0 && statusQ.isLoading),
    error: catalog.error ?? statusQ.error ?? null,
    refetch: () => {
      catalog.refetch();
      void statusQ.refetch();
      if (withFeedPrices) void feedQ.refetch();
    },
  };
}

/** USD per token (1e18) to judge a fill against: the guarded price when OK, else Chainlink's last answer. */
export function oraclePriceOf(a: Pick<UniverseAsset, 'status' | 'price1e18' | 'lastPrice1e18'>): bigint | null {
  if (a.status === ORACLE_OK && a.price1e18 > 0n) return a.price1e18;
  return a.lastPrice1e18 && a.lastPrice1e18 > 0n ? a.lastPrice1e18 : null;
}

/* ------------------------------ sweep params ------------------------------- */

export interface SweepParams {
  threshold: bigint;
  feeBps: number;
  epochLength: bigint;
  currentEpoch: bigint;
  paused: boolean;
  maxLegs: number;
}

export function useSweepParams(enabled: boolean) {
  const q = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'threshold', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'feeBps', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'epochLength', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'currentEpoch', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'paused', chainId },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'MAX_LEGS', chainId },
    ],
    query: { enabled, refetchInterval: 60_000 },
  });
  const d = q.data;
  const params: SweepParams | null = d
    ? {
        threshold: d[0],
        feeBps: Number(d[1]),
        epochLength: BigInt(d[2]),
        currentEpoch: d[3],
        paused: d[4],
        maxLegs: Number(d[5]),
      }
    : null;
  return { params, isLoading: q.isLoading, error: q.error };
}

/* ------------------------------ whose account ------------------------------ */

export interface SpareAccountView {
  /** The connected wallet. */
  me?: Address;
  /**
   * The account to SHOW: the connected wallet itself, or — when it is a linked
   * spending wallet of another account — that account. Rules, mix, park,
   * deliveries and events are all keyed by the account, never the spender.
   */
  account?: Address;
  /** The connected wallet feeds a different account (read-only view of it). */
  isSpendingWallet: boolean;
  /** accountOf(me) not answered yet. */
  resolving: boolean;
  error: Error | null;
}

/** RuleRegistry.accountOf(connected wallet) → which account the apps should show. */
export function useSpareAccount(): SpareAccountView {
  const { address } = useAccount();
  const me = address as Address | undefined;
  const q = useReadContract({
    address: SPARE.RuleRegistry,
    abi: ruleRegistryAbi,
    functionName: 'accountOf',
    args: [me ?? zeroAddress],
    chainId,
    query: { enabled: !!me, refetchInterval: 30_000 },
  });
  const feeds = q.data as Address | undefined;
  const isSpendingWallet = !!me && !!feeds && feeds !== zeroAddress && !sameAddress(feeds, me);
  return {
    me,
    account: isSpendingWallet ? feeds : me,
    isSpendingWallet,
    resolving: !!me && q.isPending,
    error: (q.error as Error | null) ?? null,
  };
}

/* ------------------------------- pull consent ------------------------------ */

/**
 * Both pull approvals for each wallet — USDG → Permit2 (ERC-20) and Permit2 →
 * SweepExecutor — judged against the account's weekly cap. `consents` stays
 * undefined until the wallet list is known.
 */
export function usePullConsent(wallets: readonly Address[] | undefined, weeklyCap: bigint | undefined) {
  const list = wallets ?? [];
  const q = useReadContracts({
    allowFailure: true,
    contracts: list.flatMap((w) => [
      { address: EXTERNAL.USDG, abi: erc20Abi, functionName: 'allowance', args: [w, EXTERNAL.Permit2], chainId } as const,
      { address: EXTERNAL.Permit2, abi: permit2Abi, functionName: 'allowance', args: [w, EXTERNAL.USDG, SPARE.SweepExecutor], chainId } as const,
    ]),
    query: { enabled: list.length > 0, refetchInterval: 30_000 },
  });
  const now = Math.floor(Date.now() / 1000);
  const consents: WalletConsent[] | undefined = wallets
    ? list.map((w, i) => {
        const erc20 = q.data?.[i * 2]?.result as bigint | undefined;
        const p2 = q.data?.[i * 2 + 1]?.result as readonly [bigint, number, number] | undefined;
        return {
          wallet: w,
          consent: consentView(erc20 != null && p2 ? { erc20, p2Amount: p2[0], p2Expiration: Number(p2[1]) } : undefined, { now, weeklyCap }),
        };
      })
    : undefined;
  return { consents, error: q.error ?? null };
}
