/**
 * Protocol-wide totals for the public pages (/buyback, /flywheel), read
 * straight from Robinhood Chain — no backend in the path.
 *
 *   useProtocolLedger   Σ Accrued (round-ups collected), Σ AssetSwept (USDG
 *                       converted + conversion fees), Linked − Unlinked, and
 *                       every FeeVault.Withdrawn, since the deploy block
 *   useFeeVault         FeeVault's USDG + WETH balances and the live fee rates
 *
 * Event scanning uses NARROW filters only (one address + one topic0 per
 * request). The public RPC answers those for spans up to 10M blocks, so the
 * whole history since 30 Sep 2026 is a handful of requests. The ledger is
 * incremental and shared by every page in the session: a refetch scans only
 * the blocks since the last complete scan. A scan that fails part-way never
 * surfaces partial totals — the pages show the last COMPLETE snapshot, or
 * "unavailable".
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient, useReadContracts } from 'wagmi';
import { erc20Abi, getAbiItem, type AbiEvent, type Address, type Hash, type PublicClient } from 'viem';
import { feeVaultAbi, ruleRegistryAbi, sweepExecutorAbi } from './abis';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, START_BLOCK } from './addresses';
import { chunkRange, isRateLimited } from './activity';
import { humanizeError } from './errors';
import { FUND_FEE_BPS, WETH } from './fund-swap';
import { getT } from '@/i18n';

const tf = getT('pages-b');

const chainId = SPARE_CHAIN_ID;

/** Blocks per narrow eth_getLogs request (the public RPC allows 10M). */
export const LEDGER_CHUNK = 5_000_000n;
const MIN_SPAN = 10_000n;
const RANGE_ERR = /spans|are allowed|block range|range (is )?too|too (large|wide|many)|exceeds limit|query returned more than|response size|logs matched/i;

export { FUND_FEE_BPS };

/* ---------------------------------- types ---------------------------------- */

export interface FeeWithdrawal {
  token: Address;
  to: Address;
  amount: bigint;
  txHash: Hash;
  blockNumber: bigint;
  logIndex: number;
}

export interface ProtocolLedger {
  /** First block covered (the deployment's startBlock). */
  fromBlock: bigint;
  /** Last block covered, inclusive. */
  scannedTo: bigint;
  /** Accrued events — one per wallet per collection. */
  collections: number;
  /** Σ Accrued.amount, USDG base units. */
  collectedUsdg: bigint;
  lastCollectedBlock: bigint | null;
  /** AssetSwept events — one per stock per netted sweep. */
  buys: number;
  /** Σ AssetSwept.usdgIn, USDG base units. */
  convertedUsdg: bigint;
  /** Σ AssetSwept.fee, USDG base units. */
  feesUsdg: bigint;
  lastBuyBlock: bigint | null;
  linked: number;
  unlinked: number;
  /** FeeVault.Withdrawn, newest first. */
  withdrawals: FeeWithdrawal[];
}

export type LedgerEventKind = 'accrued' | 'assetSwept' | 'linked' | 'unlinked' | 'withdrawn';

export interface LedgerLog {
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hash;
}

/* ------------------------------ pure reducer ------------------------------- */

export function emptyLedger(fromBlock: bigint = START_BLOCK): ProtocolLedger {
  return {
    fromBlock,
    scannedTo: fromBlock - 1n,
    collections: 0,
    collectedUsdg: 0n,
    lastCollectedBlock: null,
    buys: 0,
    convertedUsdg: 0n,
    feesUsdg: 0n,
    lastBuyBlock: null,
    linked: 0,
    unlinked: 0,
    withdrawals: [],
  };
}

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : 0n);
const maxBlock = (a: bigint | null, b: bigint): bigint => (a === null || b > a ? b : a);

/** Fold one event kind's logs into a ledger (returns a new ledger). */
export function applyLedgerLogs(ledger: ProtocolLedger, kind: LedgerEventKind, logs: readonly LedgerLog[]): ProtocolLedger {
  if (logs.length === 0) return ledger;
  const next: ProtocolLedger = { ...ledger, withdrawals: [...ledger.withdrawals] };
  for (const l of logs) {
    switch (kind) {
      case 'accrued':
        next.collections += 1;
        next.collectedUsdg += big(l.args.amount);
        next.lastCollectedBlock = maxBlock(next.lastCollectedBlock, l.blockNumber);
        break;
      case 'assetSwept':
        next.buys += 1;
        next.convertedUsdg += big(l.args.usdgIn);
        next.feesUsdg += big(l.args.fee);
        next.lastBuyBlock = maxBlock(next.lastBuyBlock, l.blockNumber);
        break;
      case 'linked':
        next.linked += 1;
        break;
      case 'unlinked':
        next.unlinked += 1;
        break;
      case 'withdrawn':
        next.withdrawals.push({
          token: l.args.token as Address,
          to: l.args.to as Address,
          amount: big(l.args.amount),
          txHash: l.txHash,
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
        });
        break;
    }
  }
  next.withdrawals.sort((a, b) =>
    a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
  );
  return next;
}

/** Wallets currently linked across all accounts (never negative). */
export function linkedNow(ledger: ProtocolLedger): number {
  return Math.max(0, ledger.linked - ledger.unlinked);
}

/* --------------------------------- scanning -------------------------------- */

const SOURCES: { kind: LedgerEventKind; address: Address; event: AbiEvent }[] = [
  { kind: 'accrued', address: SPARE.SweepExecutor, event: getAbiItem({ abi: sweepExecutorAbi, name: 'Accrued' }) as AbiEvent },
  { kind: 'assetSwept', address: SPARE.SweepExecutor, event: getAbiItem({ abi: sweepExecutorAbi, name: 'AssetSwept' }) as AbiEvent },
  { kind: 'linked', address: SPARE.RuleRegistry, event: getAbiItem({ abi: ruleRegistryAbi, name: 'Linked' }) as AbiEvent },
  { kind: 'unlinked', address: SPARE.RuleRegistry, event: getAbiItem({ abi: ruleRegistryAbi, name: 'Unlinked' }) as AbiEvent },
  { kind: 'withdrawn', address: SPARE.FeeVault, event: getAbiItem({ abi: feeVaultAbi, name: 'Withdrawn' }) as AbiEvent },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errText(e: unknown): string {
  const x = e as { shortMessage?: unknown; details?: unknown; message?: unknown } | null;
  return [x?.shortMessage, x?.details, x?.message].filter((s) => typeof s === 'string').join(' | ') || String(e);
}

/** One narrow eth_getLogs over [from, to]; halves the range if the RPC refuses the span. */
async function narrowLogs(
  client: PublicClient,
  address: Address,
  event: AbiEvent,
  from: bigint,
  to: bigint,
  attempt = 0,
): Promise<LedgerLog[]> {
  try {
    const logs = await client.getLogs({ address, event, fromBlock: from, toBlock: to, strict: true });
    const out: LedgerLog[] = [];
    for (const l of logs as unknown as { args?: Record<string, unknown>; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hash | null; removed?: boolean }[]) {
      if (l.removed || l.blockNumber == null || l.logIndex == null || !l.transactionHash) continue;
      out.push({ args: l.args ?? {}, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash });
    }
    return out;
  } catch (e) {
    const span = to - from + 1n;
    if (isRateLimited(e)) {
      if (attempt >= 4) throw e;
      await sleep(Math.min(8_000, 800 * 2 ** attempt) + Math.floor(Math.random() * 300));
      return narrowLogs(client, address, event, from, to, attempt + 1);
    }
    if (span > MIN_SPAN && RANGE_ERR.test(errText(e))) {
      const mid = from + span / 2n;
      const a = await narrowLogs(client, address, event, from, mid - 1n);
      const b = await narrowLogs(client, address, event, mid, to);
      return [...a, ...b];
    }
    if (attempt < 1) {
      await sleep(600);
      return narrowLogs(client, address, event, from, to, attempt + 1);
    }
    throw e;
  }
}

/** Resume point: blocks already folded in, possibly short of the head after a failed scan. */
let progress: ProtocolLedger | null = null;
let inflight: Promise<ProtocolLedger> | null = null;

/**
 * Bring the shared ledger up to the current head and return it. Concurrent
 * callers share one scan. Throws when a chunk can't be read; the next call
 * resumes from the last chunk that was read in full.
 */
export function syncProtocolLedger(client: PublicClient): Promise<ProtocolLedger> {
  if (inflight) return inflight;
  inflight = (async () => {
    const head = await client.getBlockNumber();
    let ledger = progress ?? emptyLedger(START_BLOCK);
    if (head > ledger.scannedTo) {
      for (const c of chunkRange(ledger.scannedTo + 1n, head, LEDGER_CHUNK)) {
        const parts = await Promise.all(SOURCES.map((s) => narrowLogs(client, s.address, s.event, c.from, c.to)));
        let next = ledger;
        SOURCES.forEach((s, i) => {
          next = applyLedgerLogs(next, s.kind, parts[i]);
        });
        ledger = { ...next, scannedTo: c.to };
        progress = ledger;
      }
    }
    return ledger;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Test hook — forget the session ledger. */
export function resetProtocolLedger(): void {
  progress = null;
  inflight = null;
}

/* ---------------------------------- hooks ---------------------------------- */

export interface ProtocolLedgerState {
  /** Last complete ledger, or null while the first scan runs / after it failed. */
  ledger: ProtocolLedger | null;
  loading: boolean;
  error: string | null;
}

export function useProtocolLedger(enabled: boolean): ProtocolLedgerState {
  const client = usePublicClient({ chainId });
  const q = useQuery({
    queryKey: ['spare', 'protocol-ledger'],
    queryFn: () => syncProtocolLedger(client as PublicClient),
    enabled: enabled && !!client,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  return {
    ledger: q.data ?? null,
    loading: enabled && q.data === undefined && !q.error,
    error: q.error ? humanizeError(q.error) : null,
  };
}

export interface FeeVaultState {
  /** USDG held, base units (6 dp). null = unread / read failed. */
  usdg: bigint | null;
  /** WETH held, wei. */
  weth: bigint | null;
  /** SweepExecutor.feeBps(). */
  feeBps: number | null;
  /** SweepExecutor.MAX_FEE_BPS() — the on-chain ceiling. */
  maxFeeBps: number | null;
  loading: boolean;
  error: string | null;
}

export function useFeeVault(enabled: boolean): FeeVaultState {
  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: EXTERNAL.USDG, abi: erc20Abi, functionName: 'balanceOf', args: [SPARE.FeeVault], chainId },
      { address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [SPARE.FeeVault], chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'feeBps', chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'MAX_FEE_BPS', chainId },
    ],
    query: { enabled, refetchInterval: 60_000 },
  });
  const r = q.data;
  const num = (v: unknown): number | null => (typeof v === 'bigint' || typeof v === 'number' ? Number(v) : null);
  const bal = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
  const allFailed = !!r && r.every((x) => x.status === 'failure');
  return {
    usdg: bal(r?.[0]?.result),
    weth: bal(r?.[1]?.result),
    feeBps: num(r?.[2]?.result),
    maxFeeBps: num(r?.[3]?.result),
    loading: enabled && q.isLoading,
    error: q.error ? humanizeError(q.error) : allFailed ? tf('feed.chainNoAnswer') : null,
  };
}
