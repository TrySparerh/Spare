/**
 * Live Robinhood Chain reads shared by the public developer pages
 * (/devtools, /datalayer, /dispatch). Every read pins chain 4663 and goes to
 * the public RPC through wagmi's client; every failure resolves to null so a
 * page shows "—" instead of breaking.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address, PublicClient } from 'viem';
import { SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import { blockTimes } from '@/lib/spare-chain/activity';
import { countLinkedWallets, latestFeedEvent, scanTotals, type FeedEvent, type FeedSummary } from '@/lib/spare-chain/protocol-feed';
import { KEEPER } from './addressBook';

export function useRhcClient(): PublicClient | undefined {
  return usePublicClient({ chainId: SPARE_CHAIN_ID }) as unknown as PublicClient | undefined;
}

const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const settle = <T,>(p: Promise<T>): Promise<{ ok: boolean; value: T | null }> =>
  p.then(
    (value) => ({ ok: true, value }),
    () => ({ ok: false, value: null }),
  );

/** Head block, refreshed every `refetchMs`. */
export function useHeadBlock(refetchMs = 15_000) {
  const client = useRhcClient();
  const q = useQuery({
    queryKey: ['spare-public', 'head'],
    queryFn: () => client!.getBlockNumber(),
    enabled: !!client,
    refetchInterval: refetchMs,
    retry: 2,
  });
  return { head: q.data ?? null, error: !!q.error, loading: q.isPending };
}

/** Bytecode present at each address (lower-cased keys). Unread addresses are absent. */
export function useBytecode(addresses: readonly Address[]) {
  const client = useRhcClient();
  const q = useQuery({
    queryKey: ['spare-public', 'bytecode', addresses.map((a) => a.toLowerCase()).join(',')],
    queryFn: async () => {
      const out: Record<string, boolean> = {};
      await Promise.all(
        addresses.map(async (a) => {
          const code = await soft(client!.getCode({ address: a }));
          if (code !== null) out[a.toLowerCase()] = !!code && code !== '0x';
        }),
      );
      return out;
    },
    enabled: !!client && addresses.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return { code: q.data ?? null, loading: q.isPending };
}

export interface TimedEvent {
  event: FeedEvent;
  /** Block timestamp (unix seconds), null if the block read failed. */
  at: number | null;
}

export interface KeeperPulse {
  head: bigint;
  balanceWei: bigint | null;
  lastAccrued: TimedEvent | null;
  lastAccountSwept: TimedEvent | null;
  lastAssetSwept: TimedEvent | null;
  /** Linked − Unlinked; null if the scan failed. */
  linkedWallets: number | null;
  /** True when a lookup failed (so "none yet" might not be the whole truth). */
  partial: boolean;
}

/**
 * What the keeper has done lately, from the chain: its ETH balance, the newest
 * collection and sweep events, and how many wallets it watches.
 */
export function useKeeperPulse(enabled = true) {
  const client = useRhcClient();
  const q = useQuery({
    queryKey: ['spare-public', 'keeper-pulse'],
    queryFn: async ({ signal }): Promise<KeeperPulse> => {
      const c = client!;
      const head = await c.getBlockNumber();
      const [balanceWei, accrued, accountSwept, assetSwept, linked] = await Promise.all([
        soft(c.getBalance({ address: KEEPER })),
        settle(latestFeedEvent(c, 'SweepExecutor', ['Accrued'], head, { signal })),
        settle(latestFeedEvent(c, 'SweepExecutor', ['AccountSwept'], head, { signal })),
        settle(latestFeedEvent(c, 'SweepExecutor', ['AssetSwept'], head, { signal })),
        settle(countLinkedWallets(c, head, { signal })),
      ]);
      const found = [accrued.value, accountSwept.value, assetSwept.value].filter((e): e is FeedEvent => !!e);
      const times = found.length ? ((await soft(blockTimes(c, found.map((e) => e.blockNumber)))) ?? new Map<bigint, number>()) : new Map<bigint, number>();
      const timed = (e: FeedEvent | null): TimedEvent | null => (e ? { event: e, at: times.get(e.blockNumber) ?? null } : null);
      return {
        head,
        balanceWei,
        lastAccrued: timed(accrued.value),
        lastAccountSwept: timed(accountSwept.value),
        lastAssetSwept: timed(assetSwept.value),
        linkedWallets: linked.value,
        partial: !accrued.ok || !accountSwept.ok || !assetSwept.ok || !linked.ok,
      };
    },
    enabled: enabled && !!client,
    refetchInterval: 60_000,
    retry: 1,
  });
  return { pulse: q.data ?? null, loading: q.isPending, error: !!q.error };
}

/** All-time Σ Accrued / Σ AssetSwept since deployment (narrow scans). */
export function useProtocolTotals(enabled = true) {
  const client = useRhcClient();
  const q = useQuery({
    queryKey: ['spare-public', 'protocol-totals'],
    queryFn: async ({ signal }): Promise<FeedSummary & { head: bigint }> => {
      const head = await client!.getBlockNumber();
      return { ...(await scanTotals(client!, head, { signal })), head };
    },
    enabled: enabled && !!client,
    refetchInterval: 60_000,
    retry: 1,
  });
  return { totals: q.data ?? null, loading: q.isPending, error: !!q.error };
}
