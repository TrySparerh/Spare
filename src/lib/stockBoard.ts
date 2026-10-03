/**
 * The stock board shared by the desktop's Markets apps (Stock Desk, After
 * Hours, Portfolio X-Ray) and the live ticker — read straight from Robinhood
 * Chain, no backend:
 *
 *   AssetRegistry.tokens() / get()        the universe, pinned pools, feeds
 *   token symbol() / name()               (both via the shared catalog in
 *                                         spare-chain/universe.ts)
 *   StockRouter.oracleStatus()            the guarded price the keeper would use
 *   Chainlink latestRoundData()           the last answer, even when STALE
 *   ElectionRegistry.defaultMix()         the default mix weights
 *   V4Quoter.quoteExactInputSingle()      what USDG buys right now through the
 *                                         pool Spare pins for each stock (every
 *                                         pool batched through Multicall3)
 *
 * Everything that can fail degrades to `null` ("—" on screen); nothing here
 * ever invents a number.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient, useReadContract } from 'wagmi';
import { type Address, type PublicClient } from 'viem';
import { electionRegistryAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, sameAddress } from '@/lib/spare-chain/addresses';
import { ORACLE_OK, oraclePriceOf, oracleView, useUniverse, type OracleView, type UniverseAsset } from '@/lib/spare-chain/hooks';
import { type PoolKey } from '@/lib/spare-chain/fund-swap';
import { quoteMany, type AssetKind } from '@/lib/spare-chain/universe';
import { getT } from '@/i18n';

const tf = getT('shell');

const chainId = SPARE_CHAIN_ID;

/* ------------------------------ pure helpers ------------------------------- */

/** 1e18-scaled USD → a plain number (display only). */
export function usd1e18ToNumber(v: bigint | undefined | null): number | null {
  if (v == null || v <= 0n) return null;
  const n = Number(v) / 1e18;
  return Number.isFinite(n) ? n : null;
}

/** "$1,234.56" or "—". */
export function fmtUsd(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

/** "+0.29%" / "−1.10%" or "—". */
export function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}%`;
}

/**
 * A timestamp as the Spare API sends it → unix seconds, or null. /health
 * serialises times as ISO-8601 text ("2026-10-01T20:20:25.000Z"); a number is
 * read as unix seconds, or milliseconds when it is that large.
 */
export function toUnixSeconds(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v > 1e12 ? v / 1000 : v) : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** "5m ago" / "3h ago" / "2d ago" from unix seconds, or "—", in the live language (shell `stockBoard.ago.*`). */
export function fmtAgo(tsSec: number | null | undefined, nowMs = Date.now()): string {
  if (!tsSec) return '—';
  const s = Math.max(0, Math.round(nowMs / 1000 - tsSec));
  if (s < 60) return tf('stockBoard.ago.s', { n: s });
  if (s < 3600) return tf('stockBoard.ago.m', { n: Math.floor(s / 60) });
  if (s < 86_400) return tf('stockBoard.ago.h', { n: Math.floor(s / 3600) });
  return tf('stockBoard.ago.d', { n: Math.floor(s / 86_400) });
}

/**
 * UTC offset of US Eastern time at `tsSec`: EDT (-4h) from the second Sunday of
 * March 07:00 UTC to the first Sunday of November 06:00 UTC, else EST (-5h).
 * Mirrors the keeper (engine/src/keeper/plan.ts).
 */
export function easternOffsetSeconds(tsSec: number): number {
  const year = new Date(tsSec * 1000).getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(year, 2, nthSunday(2, 2), 7) / 1000;
  const end = Date.UTC(year, 10, nthSunday(10, 1), 6) / 1000;
  return tsSec >= start && tsSec < end ? -4 * 3600 : -5 * 3600;
}

/**
 * The 24/5 tokenized-equity session runs Sunday 20:00 ET to Friday 20:00 ET.
 * Returns the UTC second the current session opened, or null while closed.
 * Mirrors the keeper's market-hours gate (engine/src/keeper/plan.ts).
 */
export function equitySessionOpenedAt(tsSec: number): number | null {
  const off = easternOffsetSeconds(tsSec);
  const local = tsSec + off;
  const day = Math.floor(local / 86_400);
  const dow = (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  const secOfDay = local - day * 86_400;
  const OPEN = 20 * 3600;
  const open = (dow === 0 && secOfDay >= OPEN) || (dow >= 1 && dow <= 4) || (dow === 5 && secOfDay < OPEN);
  if (!open) return null;
  return (day - dow) * 86_400 + OPEN - off;
}

/** The next session open (UTC seconds) when closed; null while open. */
export function nextSessionOpen(tsSec: number): number | null {
  if (equitySessionOpenedAt(tsSec) !== null) return null;
  // Closed only from Friday 20:00 ET to Sunday 20:00 ET: step forward an hour at a time.
  let t = Math.floor(tsSec / 3600) * 3600;
  for (let i = 0; i < 24 * 4; i++) {
    t += 3600;
    const opened = equitySessionOpenedAt(t);
    if (opened !== null) return opened;
  }
  return null;
}

/**
 * The on-chain fill price per token (USD) for `usdgIn` (6 dp) returning
 * `tokensOut` (18 dp), or null.
 */
export function fillPrice(usdgIn: bigint, tokensOut: bigint): number | null {
  if (usdgIn <= 0n || tokensOut <= 0n) return null;
  const p = Number(usdgIn) / 1e6 / (Number(tokensOut) / 1e18);
  return Number.isFinite(p) ? p : null;
}

/** Percent gap of `price` over `reference` (positive = premium), or null. */
export function gapPct(price: number | null, reference: number | null): number | null {
  if (price == null || reference == null || reference <= 0) return null;
  return (price / reference - 1) * 100;
}

/* --------------------------------- rows ----------------------------------- */

export interface StockRow {
  token: Address;
  symbol: string;
  /** Token name() — null until read. */
  name: string | null;
  kind: AssetKind;
  active: boolean;
  status: number | null;
  oracle: OracleView;
  /** Guarded price when the oracle is OK, else Chainlink's last answer. */
  price: number | null;
  /** True when `price` is the guarded (OK) price, false for a last close. */
  priceIsLive: boolean;
  /** Chainlink's last answer (USD), even when STALE. */
  lastPrice: number | null;
  lastUpdatedAt: number | null;
  /** Default-mix weight in bps, 0 when not in the default mix. */
  defaultBps: number;
  /** USD per token (1e18) to judge fills against: guarded price, else the last answer. */
  oracle1e18: bigint | null;
  poolKey: PoolKey | null;
  hooked: boolean;
  /** Chainlink feed (for the ~1 day change). */
  feed: Address | null;
  bandBps: number | null;
}

/** The market read off the feeds: open when any active stock is OK, closed when all are STALE. */
export type MarketState = 'open' | 'closed' | 'mixed' | 'unknown';

export function marketState(rows: readonly Pick<StockRow, 'active' | 'status'>[]): MarketState {
  const act = rows.filter((r) => r.active && r.status != null);
  if (act.length === 0) return 'unknown';
  if (act.some((r) => r.status === ORACLE_OK)) return 'open';
  if (act.every((r) => r.status === 1)) return 'closed';
  return 'mixed';
}

type Leg = { asset: Address; bps: number | bigint };

function toRow(a: UniverseAsset, defaultBps: number): StockRow {
  const live = a.status === ORACLE_OK ? usd1e18ToNumber(a.price1e18) : null;
  const last = usd1e18ToNumber(a.lastPrice1e18);
  return {
    token: a.token,
    symbol: a.symbol,
    name: a.name,
    kind: a.kind,
    active: a.active,
    status: a.status,
    oracle: oracleView(a.status),
    price: live ?? last,
    priceIsLive: live != null,
    lastPrice: last,
    lastUpdatedAt: a.lastUpdatedAt ?? null,
    defaultBps,
    oracle1e18: oraclePriceOf(a),
    poolKey: a.poolKey,
    hooked: a.hooked,
    feed: a.feed ?? null,
    bandBps: a.bandBps ?? null,
  };
}

/** Active stocks first, then by default-mix weight, then by symbol. */
export function sortRows(rows: readonly StockRow[]): StockRow[] {
  return [...rows].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.defaultBps - a.defaultBps || a.symbol.localeCompare(b.symbol),
  );
}

/**
 * The live stock board. `rows` is empty until AssetRegistry answers; `error`
 * is set when Robinhood Chain can't be reached.
 */
export function useStockBoard({ enabled = true }: { enabled?: boolean } = {}) {
  const uni = useUniverse({ enabled, withFeedPrices: true });

  const mixQ = useReadContract({
    address: SPARE.ElectionRegistry,
    abi: electionRegistryAbi,
    functionName: 'defaultMix',
    chainId,
    query: { enabled, staleTime: 5 * 60_000 },
  });
  const legs = (mixQ.data ?? []) as readonly Leg[];

  const rows = sortRows(
    uni.assets.map((a) => {
      const leg = legs.find((l) => sameAddress(l.asset, a.token));
      return toRow(a, leg ? Number(leg.bps) : 0);
    }),
  );

  return {
    rows,
    market: marketState(rows),
    isLoading: uni.isLoading,
    error: (uni.error as Error | null) ?? null,
    refetch: () => {
      uni.refetch();
      void mixQ.refetch();
    },
  };
}

/* --------------------------------- quotes ---------------------------------- */

/**
 * Tokens (18 dp) that `usdgIn` (6 dp) buys right now through `poolKey`, from
 * Uniswap's V4Quoter via eth_call (it never sends a transaction). Null when
 * the quote reverts or the pool doesn't hold USDG.
 */
export async function quoteUsdgToStock(
  client: Pick<PublicClient, 'call'>,
  poolKey: PoolKey,
  usdgIn: bigint,
): Promise<bigint | null> {
  const [out] = await quoteMany(client, [{ poolKey, usdgIn }]);
  return out ?? null;
}

export interface StockQuote {
  token: Address;
  /** USD per token filling `size` USDG, or null when no quote. */
  fill: number | null;
  /** USD per token filling the small probe, or null. */
  probeFill: number | null;
  /** Price impact from the probe to `size`, in percent (positive = worse), or null. */
  impactPct: number | null;
}

/** $100 and a $5 probe, in USDG base units. */
export const QUOTE_SIZE_USDG = 100_000_000n;
export const PROBE_SIZE_USDG = 5_000_000n;

/**
 * Live on-chain quotes for every row with a pinned pool, refreshed every 60 s:
 * a $100 quote and a $5 probe per pool, all in a few batched Multicall3
 * eth_calls however many assets are registered. Rows that can't be quoted
 * come back with null prices.
 */
export function useStockQuotes(rows: readonly StockRow[], { enabled = true }: { enabled?: boolean } = {}) {
  const client = usePublicClient({ chainId });
  const quotable = rows.filter((r) => r.poolKey);
  const key = quotable.map((r) => r.token).join(',');
  const q = useQuery({
    queryKey: ['spare-stock-quotes', key],
    enabled: enabled && !!client && quotable.length > 0,
    refetchInterval: 60_000,
    queryFn: async (): Promise<StockQuote[]> => {
      const outs = await quoteMany(
        client!,
        quotable.flatMap((r) => [
          { poolKey: r.poolKey as PoolKey, usdgIn: QUOTE_SIZE_USDG },
          { poolKey: r.poolKey as PoolKey, usdgIn: PROBE_SIZE_USDG },
        ]),
      );
      return quotable.map((r, i) => {
        const out = outs[i * 2];
        const probeOut = outs[i * 2 + 1];
        const fill = out != null ? fillPrice(QUOTE_SIZE_USDG, out) : null;
        const probeFill = probeOut != null ? fillPrice(PROBE_SIZE_USDG, probeOut) : null;
        return { token: r.token, fill, probeFill, impactPct: gapPct(fill, probeFill) };
      });
    },
  });
  const byToken = new Map((q.data ?? []).map((x) => [x.token.toLowerCase(), x]));
  return {
    quoteOf: (token: string): StockQuote | undefined => byToken.get(token.toLowerCase()),
    isLoading: q.isLoading && q.fetchStatus !== 'idle',
    isFetching: q.isFetching,
    error: (q.error as Error | null) ?? null,
    updatedAt: q.dataUpdatedAt || null,
    refetch: () => void q.refetch(),
  };
}
