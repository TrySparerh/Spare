/**
 * The asset universe, read from Robinhood Chain — never from a fixed list.
 *
 *   AssetRegistry.tokens()          which tokens are registered (append-only)
 *   AssetRegistry.get(token)        feed, heartbeat, band, active flag, pinned PoolKey
 *   token.symbol() / token.name()   how each one is shown
 *
 * One multicall, cached by react-query under ['spare', 'assets'] and shared by
 * every window and page, so registering a new asset on-chain is all it takes
 * for it to appear everywhere. Each read also feeds rememberAssets()
 * (addresses.ts), which is how plain helpers like symbolOf() name new tokens.
 *
 * Also here, because every asset screen needs them:
 *   assetKind()      ETF / fund vs single stock, from the token's own name()
 *   assetColor()     a deterministic holo pastel per symbol (no logos needed)
 *   standbyReason()  why a registered asset is not active, from chain reads
 *   quoteMany()      V4Quoter quotes for many pools in a few Multicall3 eth_calls
 *   readDayChanges() ~1-day change per feed from Chainlink round history
 *   filterAssets() / sortAssets()  the search / filter / sort every list shares
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { assetRegistryAbi } from './abis';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, assetNamesStamp, rememberAssets, sameAddress } from './addresses';
import { V4_QUOTER, v4QuoterAbi, type PoolKey } from './fund-swap';
import { getT } from '@/i18n';

const tf = getT('shell');
const chainId = SPARE_CHAIN_ID;

/** Canonical Multicall3 (lib/chain.ts). */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/* --------------------------------- model ---------------------------------- */

export type AssetKind = 'stock' | 'etf';

export interface AssetMeta {
  token: Address;
  /** token.symbol(); a short address until it answers. */
  symbol: string;
  /** token.name() without the " • Robinhood Token" suffix, or null. */
  name: string | null;
  kind: AssetKind;
  /** AssetRegistry.get().active — false = registered but on standby. */
  active: boolean;
  feed: Address | null;
  feedDecimals: number | null;
  heartbeat: number | null;
  bandBps: number | null;
  poolKey: PoolKey | null;
  /** The pinned pool runs a third-party hook. */
  hooked: boolean;
  /** Position in AssetRegistry.tokens() (registration order). */
  index: number;
}

type AssetStruct = {
  token: Address;
  feed: Address;
  feedDecimals: number;
  heartbeat: number;
  bandBps: number;
  active: boolean;
  poolKey: PoolKey;
};

/** "Apple • Robinhood Token" → "Apple". */
export function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s*[•·|-]\s*Robinhood Token\s*$/i, '').trim();
  return s || null;
}

/**
 * ETF / fund vs single stock, from the token's name(). Fund issuers and
 * wrappers name themselves ("SPDR S&P 500 ETF Trust", "iShares Silver Trust",
 * "United States Oil Fund", "Invesco QQQ"); operating companies don't.
 * Checked against every one of the 203 tokenized assets on Robinhood Chain
 * (the list is in universe.test.ts).
 */
const FUND_WORDS = /\b(ETF|ETN|Fund|Trust|iShares|SPDR|Invesco|Vanguard|ProShares|Direxion|WisdomTree|VanEck|Roundhill|Schwab|Global X)\b/i;
export function assetKind(name: string | null | undefined): AssetKind {
  return name && FUND_WORDS.test(name) ? 'etf' : 'stock';
}

/** FNV-1a, 32-bit. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A holo pastel per ticker: the hue comes from a hash of the upper-cased
 * symbol (so the same ticker is the same colour in every window, page and
 * session), saturation and lightness stay in the Spare Holo pastel band so
 * it always reads against the indigo ink frame. Any number of assets, no
 * palette to keep in sync, no logos.
 */
export function assetColor(symbol: string): string {
  // murmur3's finaliser on top of FNV: short tickers that differ by one letter land far apart.
  let h = fnv1a(symbol.trim().toUpperCase());
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const hue = h % 360;
  const light = 72 + ((h >>> 10) % 3) * 5; // 72 / 77 / 82 %
  const sat = 86 + ((h >>> 13) % 2) * 8; // 86 / 94 %
  return `hsl(${hue} ${sat}% ${light}%)`;
}

/* --------------------------------- reads ---------------------------------- */

type MC = { status: 'success' | 'failure'; result?: unknown };
const ok = <T,>(r: MC | undefined): T | undefined => (r && r.status === 'success' ? (r.result as T) : undefined);

/** The whole registry in one multicall: get() + symbol() + name() per token, in registration order. */
export async function readAssetCatalog(client: Pick<PublicClient, 'readContract' | 'multicall'>): Promise<AssetMeta[]> {
  const tokens = (await client.readContract({
    address: SPARE.AssetRegistry,
    abi: assetRegistryAbi,
    functionName: 'tokens',
  } as never)) as unknown as readonly Address[];
  if (tokens.length === 0) return [];
  const r = (await client.multicall({
    allowFailure: true,
    contracts: tokens.flatMap((t) => [
      { address: SPARE.AssetRegistry, abi: assetRegistryAbi, functionName: 'get', args: [t] },
      { address: t, abi: erc20Abi, functionName: 'symbol' },
      { address: t, abi: erc20Abi, functionName: 'name' },
    ]),
  } as never)) as unknown as MC[];
  const list = tokens.map((t, i): AssetMeta => {
    const get = ok<AssetStruct>(r[i * 3]);
    const sym = ok<string>(r[i * 3 + 1]);
    const name = cleanName(ok<string>(r[i * 3 + 2]));
    const pk = get?.poolKey && get.poolKey.currency0 !== zeroAddress ? get.poolKey : null;
    return {
      token: t,
      symbol: sym?.trim() || `${t.slice(0, 6)}…${t.slice(-4)}`,
      name,
      kind: assetKind(name),
      active: !!get?.active,
      feed: get?.feed && get.feed !== zeroAddress ? get.feed : null,
      feedDecimals: get ? Number(get.feedDecimals) : null,
      heartbeat: get ? Number(get.heartbeat) : null,
      bandBps: get ? Number(get.bandBps) : null,
      poolKey: pk,
      hooked: !!pk && !sameAddress(pk.hooks, zeroAddress),
      index: i,
    };
  });
  rememberAssets(list.filter((a) => !a.symbol.includes('…')));
  return list;
}

export const ASSET_CATALOG_KEY = ['spare', 'assets', SPARE.AssetRegistry] as const;

/**
 * The registered universe (cached; refreshed every 5 minutes and after any
 * Spare write). `assets` is [] until the first answer.
 */
export function useAssetCatalog({ enabled = true }: { enabled?: boolean } = {}) {
  const client = usePublicClient({ chainId });
  const q = useQuery({
    queryKey: ASSET_CATALOG_KEY,
    queryFn: () => readAssetCatalog(client!),
    enabled: enabled && !!client,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 2,
  });
  const assets = useMemo(() => q.data ?? [], [q.data]);
  // A cached answer (another window read it first) still names tokens here.
  useEffect(() => {
    if (q.data) rememberAssets(q.data.filter((a) => !a.symbol.includes('…')));
  }, [q.data]);
  return {
    assets,
    isLoading: q.isLoading,
    error: (q.error as Error | null) ?? null,
    refetch: () => void q.refetch(),
  };
}

/**
 * Re-render when asset names arrive: call it in any component that shows
 * symbolOf() for an address it got from elsewhere (events, receipts).
 */
export function useAssetNames({ enabled = true }: { enabled?: boolean } = {}): number {
  // Subscribing is the point: the catalog answer re-renders the caller, and
  // readAssetCatalog has already taught symbolOf() every name by then.
  useAssetCatalog({ enabled });
  return assetNamesStamp();
}

/* --------------------------------- quotes ---------------------------------- */

export interface QuoteRequest {
  poolKey: PoolKey;
  /** USDG in, base units (6 dp). */
  usdgIn: bigint;
}

const aggregate3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/** Quotes per eth_call: ~110k gas each, so a chunk stays far under any RPC gas cap. */
export const QUOTES_PER_CALL = 24;

/**
 * USDG → token quotes from Uniswap's V4Quoter for many pools at once: Multicall3
 * aggregate3 over eth_call (nothing is sent), QUOTES_PER_CALL per call, chunks
 * in parallel. A failed quote (or a pool that doesn't hold USDG) is null.
 */
export async function quoteMany(client: Pick<PublicClient, 'call'>, reqs: readonly QuoteRequest[]): Promise<(bigint | null)[]> {
  const out: (bigint | null)[] = reqs.map(() => null);
  const idx: number[] = [];
  const calls: { target: Address; allowFailure: boolean; callData: `0x${string}` }[] = [];
  reqs.forEach((q, i) => {
    const usdgIs0 = sameAddress(q.poolKey.currency0, EXTERNAL.USDG);
    if ((!usdgIs0 && !sameAddress(q.poolKey.currency1, EXTERNAL.USDG)) || q.usdgIn <= 0n) return;
    idx.push(i);
    calls.push({
      target: V4_QUOTER,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: q.poolKey, zeroForOne: usdgIs0, exactAmount: q.usdgIn, hookData: '0x' }],
      }),
    });
  });
  const chunks: number[] = [];
  for (let s = 0; s < calls.length; s += QUOTES_PER_CALL) chunks.push(s);
  await Promise.all(
    chunks.map(async (start) => {
      const part = calls.slice(start, start + QUOTES_PER_CALL);
      try {
        const { data } = await client.call({
          to: MULTICALL3,
          data: encodeFunctionData({ abi: aggregate3Abi, functionName: 'aggregate3', args: [part] }),
        });
        if (!data) return;
        const res = decodeFunctionResult({ abi: aggregate3Abi, functionName: 'aggregate3', data }) as readonly { success: boolean; returnData: `0x${string}` }[];
        res.forEach((r, j) => {
          if (!r.success || r.returnData === '0x') return;
          try {
            const [amountOut] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: r.returnData }) as readonly [bigint, bigint];
            out[idx[start + j]] = amountOut > 0n ? amountOut : null;
          } catch {
            /* unreadable quote: stays null */
          }
        });
      } catch {
        /* the whole chunk failed: its quotes stay null */
      }
    }),
  );
  return out;
}

/**
 * Percent FEWER tokens than Chainlink's price buys (positive = worse fill,
 * negative = a better-than-oracle fill), or null.
 * `usdgIn` 6 dp, `tokensOut` 18 dp, `oracle1e18` USD per token at 1e18.
 */
export function shortfallPct(usdgIn: bigint, tokensOut: bigint | null | undefined, oracle1e18: bigint | null | undefined): number | null {
  if (!tokensOut || !oracle1e18 || usdgIn <= 0n || tokensOut <= 0n || oracle1e18 <= 0n) return null;
  const atOracle = (usdgIn * 10n ** 12n * 10n ** 18n) / oracle1e18;
  if (atOracle === 0n) return null;
  return Number(((atOracle - tokensOut) * 1_000_000n) / atOracle) / 10_000;
}

/* --------------------------------- standby --------------------------------- */

/**
 * The deploy's activation bar: an asset goes live only when $5 and $100 both
 * fill within 1.2% of Chainlink on a fork (contracts/config/4663.json
 * `_assets_about`). Policy, not a contract value — the contract only enforces
 * each asset's bandBps.
 */
export const ACTIVATION_BAR_PCT = 1.2;
/** The size standby reasons are measured at. */
export const STANDBY_PROBE_USDG = 100_000_000n;

export type StandbyReason =
  /** Not measured yet (or no oracle price to compare against). */
  | { code: 'pool' }
  /** The pinned pool returns no quote. */
  | { code: 'noQuote' }
  /** $100 through the pinned pool, vs Chainlink. */
  | { code: 'fillOutside' | 'fillThin' | 'fillOk'; shortfallPct: number; bandPct: number };

/**
 * Why a registered asset is on standby, from what the chain says right now.
 * `measured` is the $100 shortfall vs Chainlink (shortfallPct), `null` when
 * the pool returned no quote, `undefined` when not measured.
 */
export function standbyReason(a: { active: boolean; bandBps?: number | null }, measured?: number | null): StandbyReason | null {
  if (a.active) return null;
  if (measured === undefined) return { code: 'pool' };
  if (measured === null) return { code: 'noQuote' };
  const bandPct = (a.bandBps ?? 150) / 100;
  if (measured > bandPct) return { code: 'fillOutside', shortfallPct: measured, bandPct };
  if (measured > ACTIVATION_BAR_PCT) return { code: 'fillThin', shortfallPct: measured, bandPct };
  return { code: 'fillOk', shortfallPct: measured, bandPct };
}

const pct2 = (n: number) => `${Math.abs(n).toFixed(2)}%`;
const bandText = (n: number) => `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;

/** One line, in the live language (shell `assets.standby.*`). */
export function standbyText(r: StandbyReason | null): string | null {
  if (!r) return null;
  switch (r.code) {
    case 'pool':
      return tf('assets.standby.pool');
    case 'noQuote':
      return tf('assets.standby.noQuote');
    case 'fillOutside':
      return tf('assets.standby.fillOutside', { pct: pct2(r.shortfallPct), band: bandText(r.bandPct) });
    case 'fillThin':
      return tf('assets.standby.fillThin', { pct: pct2(r.shortfallPct), bar: bandText(ACTIVATION_BAR_PCT) });
    case 'fillOk':
      return tf('assets.standby.fillOk', { pct: pct2(r.shortfallPct) });
  }
}

/**
 * $100 shortfall vs Chainlink for every STANDBY asset that has a pool and an
 * oracle price (`oracleOf` gives USD per token, 1e18: the guarded price, or
 * the feed's last answer). Map token(lc) → shortfall %, null = no quote.
 * One batched quote read, refreshed every 2 minutes.
 */
export function useStandbyMeasurements(
  assets: readonly { token: Address; active: boolean; poolKey?: PoolKey | null }[],
  oracleOf: (token: Address) => bigint | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): Map<string, number | null> {
  const client = usePublicClient({ chainId });
  const standby = assets.filter((a) => !a.active && a.poolKey);
  const key = standby.map((a) => a.token.toLowerCase()).join(',');
  const q = useQuery({
    queryKey: ['spare-standby-quotes', key],
    enabled: enabled && !!client && standby.length > 0,
    staleTime: 120_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      const outs = await quoteMany(client!, standby.map((a) => ({ poolKey: a.poolKey as PoolKey, usdgIn: STANDBY_PROBE_USDG })));
      return standby.map((a, i) => ({ token: a.token.toLowerCase(), out: outs[i] }));
    },
  });
  const m = new Map<string, number | null>();
  for (const r of q.data ?? []) {
    const oracle = oracleOf(r.token as Address);
    if (r.out == null) m.set(r.token, null);
    else if (oracle) {
      const s = shortfallPct(STANDBY_PROBE_USDG, r.out, oracle);
      if (s != null) m.set(r.token, s);
    }
  }
  return m;
}

/* ------------------------------ ~1 day change ------------------------------ */

const roundAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Look back for a print at least this much older than the latest one. */
export const DAY_CHANGE_WINDOW_SEC = 20 * 3600;
/** Rounds read per pass (newest first); busy feeds print many times a day. */
const ROUND_PASSES = [8, 16, 32] as const;

export interface DayChange {
  /** Percent move from the reference print to the latest one. */
  pct: number;
  /** Seconds between the two prints (≥ DAY_CHANGE_WINDOW_SEC unless history ran out). */
  spanSec: number;
}

type Round = readonly [bigint, bigint, bigint, bigint, bigint];

/**
 * The move between each feed's latest Chainlink print and the newest print
 * at least ~20 h older — a "1 day" change that also works over a weekend
 * (it measures between prints, not against the wall clock). Feeds print on a
 * 0.5% move or a 24 h heartbeat, so the reference is a handful of rounds back;
 * busy feeds get a second and third, deeper pass. Unreadable feeds are absent.
 */
export async function readDayChanges(client: Pick<PublicClient, 'multicall'>, feeds: readonly Address[]): Promise<Map<string, DayChange>> {
  const out = new Map<string, DayChange>();
  const uniq = [...new Set(feeds.map((f) => f.toLowerCase()))] as Address[];
  if (uniq.length === 0) return out;
  const latest = (await client.multicall({
    allowFailure: true,
    contracts: uniq.map((f) => ({ address: f, abi: roundAbi, functionName: 'latestRoundData' })),
  } as never)) as unknown as MC[];
  type Pending = { feed: Address; rid: bigint; answer: bigint; at: number; oldest: Round | null; from: number };
  let pending: Pending[] = [];
  uniq.forEach((f, i) => {
    const r = ok<Round>(latest[i]);
    if (r && r[1] > 0n && r[3] > 0n) pending.push({ feed: f, rid: r[0], answer: r[1], at: Number(r[3]), oldest: null, from: 1 });
  });
  for (const depth of ROUND_PASSES) {
    if (pending.length === 0) break;
    const calls = pending.flatMap((p) => {
      const n = Math.max(0, depth - p.from + 1);
      return Array.from({ length: n }, (_, k) => {
        const back = BigInt(p.from + k);
        return { address: p.feed, abi: roundAbi, functionName: 'getRoundData', args: [p.rid > back ? p.rid - back : 0n] };
      });
    });
    const res = (await client.multicall({ allowFailure: true, contracts: calls } as never)) as unknown as MC[];
    let c = 0;
    const next: Pending[] = [];
    for (const p of pending) {
      const n = Math.max(0, depth - p.from + 1);
      let found: Round | null = null;
      for (let k = 0; k < n; k++) {
        const r = ok<Round>(res[c + k]);
        if (!r || r[1] <= 0n || r[3] === 0n) continue;
        if (!found && p.at - Number(r[3]) >= DAY_CHANGE_WINDOW_SEC) found = r;
        if (!p.oldest || r[3] < p.oldest[3]) p.oldest = r;
      }
      c += n;
      const ref = found ?? (depth === ROUND_PASSES[ROUND_PASSES.length - 1] ? p.oldest : null);
      if (ref) {
        const pct = (Number(p.answer - ref[1]) / Number(ref[1])) * 100;
        if (Number.isFinite(pct)) out.set(p.feed.toLowerCase(), { pct, spanSec: p.at - Number(ref[3]) });
      } else next.push({ ...p, from: depth + 1 });
    }
    pending = next;
  }
  return out;
}

/** ~1-day change per feed (lower-case feed address → DayChange), refreshed every 10 minutes. */
export function useDayChanges(feeds: readonly (Address | null | undefined)[], { enabled = true }: { enabled?: boolean } = {}) {
  const client = usePublicClient({ chainId });
  const list = feeds.filter((f): f is Address => !!f);
  const key = [...new Set(list.map((f) => f.toLowerCase()))].sort().join(',');
  const q = useQuery({
    queryKey: ['spare-day-change', key],
    enabled: enabled && !!client && list.length > 0,
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
    queryFn: () => readDayChanges(client!, list),
  });
  return { changes: q.data ?? new Map<string, DayChange>(), isLoading: q.isLoading && q.fetchStatus !== 'idle' };
}

/* --------------------------- search / filter / sort ------------------------ */

export type KindFilter = 'all' | AssetKind;
export type StateFilter = 'all' | 'active' | 'standby';
export type SortKey = 'symbol' | 'name' | 'price' | 'change' | 'gap';

export interface AssetQuery {
  search: string;
  kind: KindFilter;
  state: StateFilter;
  sort: SortKey;
}

export const DEFAULT_ASSET_QUERY: AssetQuery = { search: '', kind: 'all', state: 'all', sort: 'symbol' };

interface Filterable {
  token: string;
  symbol: string;
  name?: string | null;
  kind?: AssetKind;
  active: boolean;
}

/** Search matches ticker, name or token address (case-insensitive); kind / state narrow it. */
export function filterAssets<T extends Filterable>(list: readonly T[], q: Pick<AssetQuery, 'search' | 'kind' | 'state'>): T[] {
  const s = q.search.trim().toLowerCase().replace(/^\$/, '');
  return list.filter((a) => {
    if (q.kind !== 'all' && (a.kind ?? assetKind(a.name)) !== q.kind) return false;
    if (q.state === 'active' && !a.active) return false;
    if (q.state === 'standby' && a.active) return false;
    if (!s) return true;
    return a.symbol.toLowerCase().includes(s) || (a.name ?? '').toLowerCase().includes(s) || a.token.toLowerCase().startsWith(s);
  });
}

/**
 * Active first, then by the chosen key: ticker or name A→Z, price high→low,
 * change high→low, gap by size (largest |gap| first). Missing values sort
 * last; ties fall back to the ticker.
 */
export function sortAssets<T extends Filterable>(
  list: readonly T[],
  key: SortKey,
  values: {
    price?: (a: T) => number | null | undefined;
    change?: (a: T) => number | null | undefined;
    gap?: (a: T) => number | null | undefined;
  } = {},
): T[] {
  const num = (f: ((a: T) => number | null | undefined) | undefined, a: T) => {
    const v = f?.(a);
    return v == null || !Number.isFinite(v) ? null : v;
  };
  const desc = (x: number | null, y: number | null) => (x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : y - x);
  return [...list].sort((a, b) => {
    const act = Number(b.active) - Number(a.active);
    if (act) return act;
    let c = 0;
    if (key === 'price') c = desc(num(values.price, a), num(values.price, b));
    else if (key === 'change') c = desc(num(values.change, a), num(values.change, b));
    else if (key === 'gap') {
      const ga = num(values.gap, a);
      const gb = num(values.gap, b);
      c = desc(ga == null ? null : Math.abs(ga), gb == null ? null : Math.abs(gb));
    }
    else if (key === 'name') c = (a.name ?? a.symbol).localeCompare(b.name ?? b.symbol);
    return c || a.symbol.localeCompare(b.symbol);
  });
}

/** "SPY NVDA AAPL +21": the first `max` symbols and a count for the rest. */
export function symbolList(symbols: readonly string[], max = 6, sep = ' '): string {
  if (symbols.length <= max) return symbols.join(sep);
  return `${symbols.slice(0, max).join(sep)}${sep}+${symbols.length - max}`;
}
