/**
 * $SPARE token status: "not launched" until a token exists.
 *
 * No $SPARE token exists. With no contract address there is no price,
 * supply, holder list or buyback to report, so every token-facing endpoint
 * (/api/spare/token/*) answers from here with zeros and `launched: false`.
 *
 * SPARE_TOKEN_ADDRESS is the only input that can switch token reads on; no
 * other env key is ever read as the $SPARE address.
 */
import { getAddress, isAddress, type Address } from 'viem';

export const SPARE_TOKEN_SYMBOL = '$SPARE';

export const SPARE_OFFICIAL_CHANNELS = {
  site: 'https://trysparerh.com',
  x: 'https://x.com/TrySpareRH',
  telegram: 'https://t.me/sparerh',
} as const;

/** The $SPARE contract, or null until SPARE_TOKEN_ADDRESS is set. */
export function spareTokenAddress(): Address | null {
  const raw = process.env.SPARE_TOKEN_ADDRESS?.trim();
  if (!raw || !isAddress(raw, { strict: false })) return null;
  return getAddress(raw.toLowerCase());
}

export function isSpareTokenLaunched(): boolean {
  return spareTokenAddress() !== null;
}

export interface SpareTokenStatus {
  symbol: typeof SPARE_TOKEN_SYMBOL;
  launched: boolean;
  status: 'coming_soon' | 'live';
  chainId: 4663;
  address: Address | null;
  message: string;
  officialChannels: typeof SPARE_OFFICIAL_CHANNELS;
  /** From the Spare overview: conversion bps + boost-partner fees -> buyback + stakers (S3). Not live. */
  plannedUtility: string;
}

export function getSpareTokenStatus(): SpareTokenStatus {
  const address = spareTokenAddress();
  return {
    symbol: SPARE_TOKEN_SYMBOL,
    launched: address !== null,
    status: address ? 'live' : 'coming_soon',
    chainId: 4663,
    address,
    message: address
      ? '$SPARE contract address published by the operator.'
      : '$SPARE has not launched. There is no contract address, price, supply or holder data yet. Ignore any CA not announced on the official channels.',
    officialChannels: SPARE_OFFICIAL_CHANNELS,
    plannedUtility:
      'Planned (not live): conversion fees and boost-partner fees route to $SPARE buyback and stakers. Spare charges no subscription.',
  };
}

// ─── Token ledger (buyback) ───────────────────────────────────────────────
//
// Planned (not live): conversion and boost-partner fees fund $SPARE buybacks.
// Every figure is zero while the token is not launched.

export interface TokenLedgerStats {
  token: SpareTokenStatus;
  enabled: false;
  liveMode: false;
  cumulativeUsdgRouted: 0;
  cumulativeSpareBoughtBack: 0;
  last24hUsdgRouted: 0;
  last24hSpareBoughtBack: 0;
  buybackEventCount: 0;
  pending: { count: 0; usdgWaiting: 0; oldestAgeMs: null };
  lastBuyback: null;
  config: { tokenAddress: Address | null; mechanism: string };
}

export function getTokenLedgerStats(): TokenLedgerStats {
  return {
    token: getSpareTokenStatus(),
    enabled: false,
    liveMode: false,
    cumulativeUsdgRouted: 0,
    cumulativeSpareBoughtBack: 0,
    last24hUsdgRouted: 0,
    last24hSpareBoughtBack: 0,
    buybackEventCount: 0,
    pending: { count: 0, usdgWaiting: 0, oldestAgeMs: null },
    lastBuyback: null,
    config: {
      tokenAddress: spareTokenAddress(),
      mechanism: 'Not active: $SPARE has not launched, so nothing is bought back.',
    },
  };
}

/** No token, no ledger events. */
export function getTokenLedgerEvents(_limit: number): never[] {
  return [];
}

// ─── Holder tiers ─────────────────────────────────────────────────────────

export type HolderTier = 'standard' | 'holder' | 'whale' | 'og';

export interface TierDistribution {
  token: SpareTokenStatus;
  counts: Record<HolderTier, number>;
  supplyPct: Record<HolderTier, number>;
  supply: Record<HolderTier, number>;
  totalSupply: number;
  totalHolders: number;
  lastUpdated: string;
  /** Milliseconds spent building the snapshot. */
  buildMs: number;
  nextRefreshAt: string;
  cached: boolean;
  warming: boolean;
  /** False when a log chunk or a balance read failed (holders may be missing), or while warming. */
  complete: boolean;
}

const ZERO_TIERS = (): Record<HolderTier, number> => ({ standard: 0, holder: 0, whale: 0, og: 0 });

/** Tier distribution while the token is not launched: empty. */
export function emptyTierDistribution(): TierDistribution {
  const now = new Date().toISOString();
  return {
    token: getSpareTokenStatus(),
    counts: ZERO_TIERS(),
    supplyPct: ZERO_TIERS(),
    supply: ZERO_TIERS(),
    totalSupply: 0,
    totalHolders: 0,
    lastUpdated: now,
    buildMs: 0,
    nextRefreshAt: now,
    cached: false,
    warming: false,
    complete: true,
  };
}

/**
 * Tier floors in whole $SPARE (SPARE_TIER_*_MIN). Only meaningful once the
 * token launches; until then every wallet is `standard`.
 */
export function tierThresholds(): { holder: number; whale: number; og: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(x) && x >= 0 ? x : d;
  };
  return {
    holder: n(process.env.SPARE_TIER_HOLDER_MIN, 5_000),
    whale: n(process.env.SPARE_TIER_WHALE_MIN, 50_000),
    og: n(process.env.SPARE_TIER_OG_MIN, 500_000),
  };
}

export function classifyTier(balance: number, t = tierThresholds()): HolderTier {
  if (balance >= t.og) return 'og';
  if (balance >= t.whale) return 'whale';
  if (balance >= t.holder) return 'holder';
  return 'standard';
}
