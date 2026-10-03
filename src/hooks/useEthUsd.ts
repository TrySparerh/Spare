/**
 * ETH / USD from Chainlink on Robinhood Chain — a reference price for display
 * (system tray, Portfolio X-Ray). Read straight from the feed, no backend.
 *
 * `price` is null until the first answer arrives or when the read fails, and
 * callers render "—" for it. `stale` is true once the
 * answer is older than the feed's heartbeat plus 1 h of grace.
 */
import { useReadContract } from 'wagmi';
import { aggregatorV3Abi } from '@/lib/spare-chain/abis';
import { SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import {
  CHAINLINK_ETH_USD,
  CHAINLINK_ETH_USD_DECIMALS,
  CHAINLINK_MAX_AGE_SECONDS,
} from '@/lib/spare-chain/fund-swap';

export interface EthUsd {
  /** USD per ETH, or null when unknown. */
  price: number | null;
  /** Unix seconds of the answer, or null. */
  updatedAt: number | null;
  stale: boolean;
  isLoading: boolean;
  error: Error | null;
}

export function useEthUsd(): EthUsd {
  const q = useReadContract({
    address: CHAINLINK_ETH_USD,
    abi: aggregatorV3Abi,
    functionName: 'latestRoundData',
    chainId: SPARE_CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const round = q.data as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
  const answer = round?.[1];
  const updatedAt = round ? Number(round[3]) : null;
  const price = answer && answer > 0n ? Number(answer) / 10 ** CHAINLINK_ETH_USD_DECIMALS : null;
  const stale = updatedAt != null && Date.now() / 1000 - updatedAt > CHAINLINK_MAX_AGE_SECONDS;
  return {
    price: price != null && Number.isFinite(price) ? price : null,
    updatedAt,
    stale,
    isLoading: q.isLoading,
    error: (q.error as Error | null) ?? null,
  };
}
