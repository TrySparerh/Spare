/**
 * Live reads for /proof. Every read is public and read-only:
 *
 *   useSourcify(addresses)  Sourcify v2, straight from the browser (CORS open)
 *   useController(address)  getCode + TimelockController / Safe probes
 *   useRoleReads()          owner / pendingOwner / pauser / paused / isKeeper on
 *                           the 7 owned contracts, plus the no-owner probes,
 *                           ScreeningGate and CashPark wiring — one multicall
 *   useRailReads()          the on-chain limits — one multicall
 *   useHookReads(hooks)     authority() on third-party pool hooks
 *   useProofHealth()        spare-api /health, liveness fields only
 *
 * Nothing here throws into the page: a failed read is null and the page shows
 * "—" (or "no answer"), never a remembered or assumed value.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { usePublicClient, useReadContracts } from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  RawContractError,
  parseAbi,
  type Abi,
  type Address,
} from 'viem';
import {
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  feeVaultAbi,
  screeningGateAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import { API_BASE } from '@/lib/config';
import { KEEPER } from '@/components/public/live/addressBook';
import {
  classifyController,
  parseProofHealth,
  parseSourcify,
  sourcifyApiUrl,
  type ControllerView,
  type OwnedRow,
  type ProofHealth,
  type SourcifyView,
} from './proofLogic';

const chainId = SPARE_CHAIN_ID;
const TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' }, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ───────────────────────────── Sourcify ───────────────────────────── */

/** Sourcify's answer for one address; never throws (no answer → kind "unknown"). */
export async function readSourcify(address: string, signal?: AbortSignal): Promise<SourcifyView> {
  try {
    const res = await fetchWithTimeout(sourcifyApiUrl(chainId, address), signal);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return parseSourcify(res.status, body);
  } catch {
    return parseSourcify(null, null);
  }
}

/** Lower-cased address → Sourcify view (absent while that address is still being checked). */
export function useSourcify(addresses: readonly string[]): { byAddress: Map<string, SourcifyView>; checking: boolean } {
  const results = useQueries({
    queries: addresses.map((a) => ({
      queryKey: ['proof', 'sourcify', chainId, a.toLowerCase()],
      queryFn: ({ signal }: { signal?: AbortSignal }) => readSourcify(a, signal),
      staleTime: 10 * 60_000,
      retry: 0,
    })),
  });
  const byAddress = new Map<string, SourcifyView>();
  results.forEach((r, i) => {
    if (r.data) byAddress.set(addresses[i].toLowerCase(), r.data);
  });
  return { byAddress, checking: results.some((r) => r.isPending) };
}

/* ──────────────────────────── controllers ──────────────────────────── */

const timelockAbi = parseAbi(['function getMinDelay() view returns (uint256)']);
const safeAbi = parseAbi(['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])']);

/** What holds a role: a single key, a timelock (and its delay), a Safe, or another contract. */
export function useController(address: Address | null | undefined): { view: ControllerView | null; loading: boolean } {
  const client = usePublicClient({ chainId });
  const q = useQuery({
    queryKey: ['proof', 'controller', address?.toLowerCase() ?? ''],
    enabled: !!client && !!address,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<ControllerView> => {
      const c = client!;
      const code = await c.getCode({ address: address! }).then(
        (v) => v ?? '0x',
        () => null,
      );
      if (code == null || code === '0x' || code.length <= 2) return classifyController({ code });
      const r = (await c
        .multicall({
          allowFailure: true,
          contracts: [
            { address: address!, abi: timelockAbi, functionName: 'getMinDelay' },
            { address: address!, abi: safeAbi, functionName: 'getThreshold' },
            { address: address!, abi: safeAbi, functionName: 'getOwners' },
          ],
        } as never)
        .catch(() => null)) as { status: string; result?: unknown; error?: unknown }[] | null;
      // Every probe failing for a reason other than the contract refusing it = the RPC failed: say unknown, not "contract".
      if (!r || r.every((x) => x.status === 'failure' && !isContractRefusal(x.error))) return { kind: 'unknown' };
      const ok = <T,>(i: number) => (r[i]?.status === 'success' ? (r[i].result as T) : null);
      return classifyController({ code, minDelay: ok<bigint>(0), threshold: ok<bigint>(1), owners: ok<readonly string[]>(2) });
    },
  });
  return { view: q.data ?? null, loading: !!address && q.isPending };
}

/* ───────────────────────────── role reads ───────────────────────────── */

/** The seven Ownable2Step contracts (SpareAuth), in the docs' order. */
export const OWNED: readonly { name: keyof typeof SPARE; abi: Abi }[] = [
  { name: 'SweepExecutor', abi: sweepExecutorAbi as unknown as Abi },
  { name: 'CashPark', abi: cashParkAbi as unknown as Abi },
  { name: 'AssetRegistry', abi: assetRegistryAbi as unknown as Abi },
  { name: 'ElectionRegistry', abi: electionRegistryAbi as unknown as Abi },
  { name: 'StockRouter', abi: stockRouterAbi as unknown as Abi },
  { name: 'FeeVault', abi: feeVaultAbi as unknown as Abi },
  { name: 'ScreeningGate', abi: screeningGateAbi as unknown as Abi },
];

/** The three contracts with no owner at all: owner() must revert on each. */
export const UNOWNED: readonly (keyof typeof SPARE)[] = ['RuleRegistry', 'UsdgParkAdapter', 'SgovParkAdapter'];

const ownableAbi = parseAbi(['function owner() view returns (address)']);
const PER_OWNED = 5;

/**
 * True when a multicall entry failed because the CONTRACT refused the call
 * (revert, or no data back), not because the RPC failed. viem marks every
 * entry "failure" when the whole multicall request fails, so a failure alone
 * proves nothing.
 */
export function isContractRefusal(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof RawContractError || x instanceof ContractFunctionZeroDataError)
  );
}

export interface RoleReads {
  rows: OwnedRow[];
  /** name → true when owner() reverted (no owner), false when it answered, null when unread. */
  noOwner: Record<string, boolean | null>;
  attestor: Address | null;
  enforced: boolean | null;
  executor: Address | null;
  adapter: Address | null;
  loading: boolean;
  /** The multicall itself failed (RPC down): nothing above was read. */
  failed: boolean;
}

export function useRoleReads(): RoleReads {
  const contracts = [
    ...OWNED.flatMap((c) => [
      { address: SPARE[c.name], abi: c.abi, functionName: 'owner', chainId },
      { address: SPARE[c.name], abi: c.abi, functionName: 'pendingOwner', chainId },
      { address: SPARE[c.name], abi: c.abi, functionName: 'pauser', chainId },
      { address: SPARE[c.name], abi: c.abi, functionName: 'paused', chainId },
      { address: SPARE[c.name], abi: c.abi, functionName: 'isKeeper', args: [KEEPER], chainId },
    ]),
    ...UNOWNED.map((n) => ({ address: SPARE[n], abi: ownableAbi, functionName: 'owner', chainId })),
    { address: SPARE.ScreeningGate, abi: screeningGateAbi, functionName: 'attestor', chainId },
    { address: SPARE.ScreeningGate, abi: screeningGateAbi, functionName: 'enforced', chainId },
    { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'executor', chainId },
    { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'adapter', chainId },
  ];
  const q = useReadContracts({
    allowFailure: true,
    contracts: contracts as never,
    query: { refetchInterval: 120_000 },
  });
  const d = q.data as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] | undefined;
  const val = <T,>(i: number): T | null => (d?.[i]?.status === 'success' ? (d[i].result as T) : null);
  const rows: OwnedRow[] = OWNED.map((c, i) => ({
    name: c.name,
    owner: val<Address>(i * PER_OWNED),
    pendingOwner: val<Address>(i * PER_OWNED + 1),
    pauser: val<Address>(i * PER_OWNED + 2),
    paused: val<boolean>(i * PER_OWNED + 3),
    keeper: val<boolean>(i * PER_OWNED + 4),
  }));
  const base = OWNED.length * PER_OWNED;
  const noOwner: Record<string, boolean | null> = {};
  UNOWNED.forEach((n, i) => {
    const r = d?.[base + i];
    // An answer means it HAS an owner(); a contract refusal means it has none; an RPC failure is unread.
    noOwner[n] = !r ? null : r.status === 'success' ? false : isContractRefusal(r.error) ? true : null;
  });
  const tail = base + UNOWNED.length;
  return {
    rows,
    noOwner,
    attestor: val<Address>(tail),
    enforced: val<boolean>(tail + 1),
    executor: val<Address>(tail + 2),
    adapter: val<Address>(tail + 3),
    loading: q.isPending,
    failed: d ? d.every((r) => r.status === 'failure' && !isContractRefusal(r.error)) : !!q.error,
  };
}

/* ───────────────────────────── rail reads ───────────────────────────── */

export interface RailReads {
  feeBps: number | null;
  maxFeeBps: number | null;
  slippageBps: number | null;
  maxSlippageBps: number | null;
  /** USDG base units. */
  threshold: bigint | null;
  epochLength: bigint | null;
  finalityBuffer: bigint | null;
  sweepPaused: boolean | null;
  parkPaused: boolean | null;
  maxBandBps: number | null;
  sequencerFeed: Address | null;
  maxLegs: number | null;
  loading: boolean;
}

export function useRailReads(): RailReads {
  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'feeBps', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'MAX_FEE_BPS', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'slippageBps', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'MAX_SLIPPAGE_BPS', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'threshold', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'epochLength', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'finalityBuffer', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'paused', chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'paused', chainId },
      { address: SPARE.AssetRegistry, abi: assetRegistryAbi, functionName: 'MAX_BAND_BPS', chainId },
      { address: SPARE.StockRouter, abi: stockRouterAbi, functionName: 'sequencerFeed', chainId },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'MAX_LEGS', chainId },
    ],
    query: { refetchInterval: 120_000 },
  });
  const d = q.data as { status: 'success' | 'failure'; result?: unknown }[] | undefined;
  const raw = (i: number): unknown => (d?.[i]?.status === 'success' ? d[i].result : null);
  const num = (i: number): number | null => {
    const v = raw(i);
    return typeof v === 'bigint' || typeof v === 'number' ? Number(v) : null;
  };
  const big = (i: number): bigint | null => {
    const v = raw(i);
    return typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : null;
  };
  const bool = (i: number): boolean | null => {
    const v = raw(i);
    return typeof v === 'boolean' ? v : null;
  };
  return {
    feeBps: num(0),
    maxFeeBps: num(1),
    slippageBps: num(2),
    maxSlippageBps: num(3),
    threshold: big(4),
    epochLength: big(5),
    finalityBuffer: big(6),
    sweepPaused: bool(7),
    parkPaused: bool(8),
    maxBandBps: num(9),
    sequencerFeed: (raw(10) as Address | null) ?? null,
    maxLegs: num(11),
    loading: q.isPending,
  };
}

/* ───────────────────────────── hook reads ───────────────────────────── */

const accessManagedAbi = parseAbi(['function authority() view returns (address)']);

/** authority() of each hook contract (OpenZeppelin AccessManaged): lower-cased hook → address, null when it does not answer. */
export function useHookReads(hooks: readonly Address[]): { authority: Map<string, Address | null>; loading: boolean } {
  const q = useReadContracts({
    allowFailure: true,
    contracts: hooks.map((h) => ({ address: h, abi: accessManagedAbi, functionName: 'authority', chainId }) as const),
    query: { enabled: hooks.length > 0, refetchInterval: 300_000 },
  });
  const authority = new Map<string, Address | null>();
  if (q.data) hooks.forEach((h, i) => authority.set(h.toLowerCase(), q.data?.[i]?.status === 'success' ? (q.data[i].result as Address) : null));
  return { authority, loading: hooks.length > 0 && q.isPending };
}

/* ───────────────────────────── API health ───────────────────────────── */

export async function readProofHealth(signal?: AbortSignal): Promise<ProofHealth | null> {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/health`, signal);
    if (!res.ok) return null;
    return parseProofHealth(await res.json());
  } catch {
    return null;
  }
}

/** spare-api /health, re-checked every minute. `health` null = offline or not the Spare API. */
export function useProofHealth(): { health: ProofHealth | null; checking: boolean } {
  const q = useQuery({
    queryKey: ['proof', 'api-health', API_BASE],
    queryFn: ({ signal }) => readProofHealth(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  return { health: q.data ?? null, checking: q.isPending };
}

/** The API's host, for the "where this came from" line. */
export function apiHost(): string {
  try {
    return new URL(API_BASE).host;
  } catch {
    return API_BASE;
  }
}
