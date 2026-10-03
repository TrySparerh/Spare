/**
 * /datalayer — the data Spare runs on: live receipts for
 * Robinhood Chain, the Chainlink stock feeds, the pinned Uniswap v4 pools and
 * the deployed contracts. Every number is read from the chain in the
 * browser; the one off-chain probe (Spare API) degrades to "offline".
 *
 *   banner → hero → stat boxes → boot probes → chain → feeds → pools →
 *   deployments → stock tokens → check it yourself → CTAs → footer
 *
 * The stock rows (feeds, pools, tokens) are whatever AssetRegistry holds,
 * read live; quotes for every pool go out in a few batched Multicall3 calls.
 *
 * Text: pages-b namespace (`dataLayer.*`; feed hours under `book.*`, shown
 * only while they still match addressBook.ts; standby reasons from shell
 * `assets.standby.*`).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  erc20Abi,
  formatGwei,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import {
  FONT_PIXEL,
  FONT_TEXT,
  HOLO,
  INK,
  HoloBadge,
  HoloCard,
  HoloHero,
  HoloList,
  HoloListRow,
  HoloScreen,
  HoloStat,
  HoloTable,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';
import { formatToken, formatUsd, to1e18 } from '@/lib/spare';
import { aggregatorV3Abi, assetRegistryAbi, cashParkAbi, stockRouterAbi, sweepExecutorAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, rememberAssets, shortAddr, symbolOf } from '@/lib/spare-chain/addresses';
import { type PoolKey } from '@/lib/spare-chain/fund-swap';
import { oracleView } from '@/lib/spare-chain/hooks';
import { ago } from '@/lib/spare-chain/protocol-feed';
import { assetKind, cleanName, quoteMany, shortfallPct, standbyReason, standbyText, symbolList, type AssetKind } from '@/lib/spare-chain/universe';
import { AssetLabel } from '@/components/retro/apps/assetUi';
import {
  FEED_DECIMALS,
  FEED_HEARTBEAT_SEC,
  INFRA_CONTRACTS,
  REFERENCE_FEEDS,
  RHC_RPC_URL,
  SPARE_CONTRACTS,
  STOCK_TOKEN_BEACON,
  stockFeedEntries,
  type BookEntry,
  type FeedEntry,
} from '@/components/public/live/addressBook';
import { LivePageFrame } from '@/components/public/live/LivePageFrame';
import { AddressLink, CodeBadge, CodeBlock, CtaRow, FlexRows, Grid, LinkButton, Mono, Prose, type FlexCell } from '@/components/public/live/LiveAtoms';
import { edgePct, fmtEdge, fmtFeedPrice, fmtPoolFee } from '@/components/public/live/format';
import { usePageMeta } from '@/components/public/live/pageMeta';
import { useSpareApi } from '@/components/public/live/spareApi';
import { useBytecode, useKeeperPulse, useRhcClient } from '@/components/public/live/useLiveChain';
import { Trans, tKey, useTranslation } from '@/i18n';

const STOCK_TOKEN_ABI = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function paused() view returns (bool)',
  'function oraclePaused() view returns (bool)',
]);

const QUOTE_SIZES = [5_000_000n, 100_000_000n] as const; // $5, $100 in USDG base units

type MC = { status: 'success' | 'failure'; result?: unknown };
const ok = <T,>(r: MC | undefined): T | null => (r && r.status === 'success' ? (r.result as T) : null);
const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/* ---------------------------------- reads ---------------------------------- */

interface ChainInfo {
  chainId: number;
  head: bigint;
  blockTimeSec: number | null;
  gasPriceWei: bigint | null;
}

async function readChain(c: PublicClient): Promise<ChainInfo> {
  const [chainId, head, gasPriceWei] = await Promise.all([c.getChainId(), c.getBlockNumber(), soft(c.getGasPrice())]);
  const [b1, b0] = await Promise.all([soft(c.getBlock({ blockNumber: head })), soft(c.getBlock({ blockNumber: head - 100n }))]);
  const blockTimeSec = b1 && b0 ? Number(b1.timestamp - b0.timestamp) / 100 : null;
  return { chainId, head, blockTimeSec, gasPriceWei };
}

interface EngineInfo {
  paused: boolean;
  feeBps: number;
  threshold: bigint;
}

async function readEngine(c: PublicClient): Promise<EngineInfo> {
  const r = (await c.multicall({
    allowFailure: false,
    contracts: [
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'paused' },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'feeBps' },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'threshold' },
    ],
  } as never)) as unknown as [boolean, number, bigint];
  return { paused: r[0], feeBps: Number(r[1]), threshold: BigInt(r[2]) };
}

interface StockInfo {
  token: Address;
  symbol: string;
  name: string | null;
  kind: AssetKind;
  eligible: boolean | null;
  active: boolean | null;
  feed: Address | null;
  feedDecimals: number | null;
  bandBps: number | null;
  poolKey: PoolKey | null;
  status: number | null;
  uiMultiplier: bigint | null;
  paused: boolean | null;
  oraclePaused: boolean | null;
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

/** Every registered token, live: active first, then A→Z by ticker. */
async function readUniverse(c: PublicClient): Promise<StockInfo[]> {
  const tokens = (await c.readContract({ address: SPARE.AssetRegistry, abi: assetRegistryAbi, functionName: 'tokens' } as never)) as unknown as readonly Address[];
  const per = 8;
  const calls = tokens.flatMap((t) => [
    { address: SPARE.AssetRegistry, abi: assetRegistryAbi, functionName: 'get', args: [t] },
    { address: SPARE.AssetRegistry, abi: assetRegistryAbi, functionName: 'isEligible', args: [t] },
    { address: SPARE.StockRouter, abi: stockRouterAbi, functionName: 'oracleStatus', args: [t] },
    { address: t, abi: STOCK_TOKEN_ABI, functionName: 'uiMultiplier' },
    { address: t, abi: STOCK_TOKEN_ABI, functionName: 'paused' },
    { address: t, abi: STOCK_TOKEN_ABI, functionName: 'oraclePaused' },
    { address: t, abi: erc20Abi, functionName: 'symbol' },
    { address: t, abi: erc20Abi, functionName: 'name' },
  ]);
  const r = (await c.multicall({ allowFailure: true, contracts: calls } as never)) as unknown as MC[];
  const rows = tokens
    .map((t, i) => {
      const get = ok<AssetStruct>(r[i * per]);
      const os = ok<readonly [number, bigint]>(r[i * per + 2]);
      const sym = ok<string>(r[i * per + 6]);
      const name = cleanName(ok<string>(r[i * per + 7]));
      const hasPool = !!get?.poolKey && get.poolKey.currency0 !== zeroAddress && get.poolKey.currency1 !== zeroAddress;
      return {
        token: t,
        symbol: sym?.trim() || symbolOf(t),
        name,
        kind: assetKind(name),
        eligible: ok<boolean>(r[i * per + 1]),
        active: get ? !!get.active : null,
        feed: get?.feed ?? null,
        feedDecimals: get ? Number(get.feedDecimals) : null,
        bandBps: get ? Number(get.bandBps) : null,
        poolKey: hasPool ? get!.poolKey : null,
        status: os ? Number(os[0]) : null,
        uiMultiplier: ok<bigint>(r[i * per + 3]),
        paused: ok<boolean>(r[i * per + 4]),
        oraclePaused: ok<boolean>(r[i * per + 5]),
      };
    })
    .sort((a, b) => Number(!!b.eligible) - Number(!!a.eligible) || a.symbol.localeCompare(b.symbol));
  rememberAssets(rows.filter((x) => !x.symbol.includes('…')));
  return rows;
}

interface FeedRead {
  answer: bigint | null;
  updatedAt: number | null;
}

async function readFeeds(c: PublicClient, feeds: readonly FeedEntry[]): Promise<Record<string, FeedRead>> {
  const r = (await c.multicall({
    allowFailure: true,
    contracts: feeds.map((f) => ({ address: f.proxy, abi: aggregatorV3Abi, functionName: 'latestRoundData' })),
  } as never)) as unknown as MC[];
  const out: Record<string, FeedRead> = {};
  feeds.forEach((f, i) => {
    const round = ok<readonly [bigint, bigint, bigint, bigint, bigint]>(r[i]);
    out[f.proxy.toLowerCase()] = round && round[1] > 0n ? { answer: round[1], updatedAt: Number(round[3]) } : { answer: null, updatedAt: null };
  });
  return out;
}

interface PoolQuote {
  /** Fill vs Chainlink in percent (positive = paid above Chainlink), null when unquoted. */
  edge: (number | null)[];
  /** $100 shortfall vs Chainlink (universe.ts shortfallPct): null = no quote, undefined = no oracle price. */
  short100: number | null | undefined;
}

/** $5 and $100 through every pinned pool, all in a few batched Multicall3 eth_calls. */
async function readQuotes(c: PublicClient, stocks: StockInfo[], feeds: Record<string, FeedRead>): Promise<Record<string, PoolQuote>> {
  const out: Record<string, PoolQuote> = {};
  const pooled = stocks.filter((s) => s.poolKey);
  const got = await quoteMany(
    c,
    pooled.flatMap((s) => QUOTE_SIZES.map((usdgIn) => ({ poolKey: s.poolKey as PoolKey, usdgIn }))),
  );
  pooled.forEach((s, i) => {
    const feed = s.feed ? feeds[s.feed.toLowerCase()] : undefined;
    const oracle = feed?.answer != null ? to1e18(feed.answer, s.feedDecimals ?? FEED_DECIMALS) : null;
    const quotes = QUOTE_SIZES.map((_, k) => got[i * QUOTE_SIZES.length + k]);
    const q100 = quotes[QUOTE_SIZES.length - 1];
    out[s.token.toLowerCase()] = {
      edge: QUOTE_SIZES.map((amt, k) => (quotes[k] != null && oracle != null ? edgePct(amt, quotes[k]!, oracle) : null)),
      short100: q100 == null ? null : oracle == null ? undefined : shortfallPct(QUOTE_SIZES[QUOTE_SIZES.length - 1], q100, oracle) ?? undefined,
    };
  });
  return out;
}

function useDataLayer() {
  const client = useRhcClient();
  const enabled = !!client;
  const chain = useQuery({ queryKey: ['datalayer', 'chain'], queryFn: () => readChain(client!), enabled, refetchInterval: 15_000, retry: 2 });
  const engine = useQuery({ queryKey: ['datalayer', 'engine'], queryFn: () => readEngine(client!), enabled, refetchInterval: 60_000, retry: 1 });
  const universe = useQuery({ queryKey: ['datalayer', 'universe'], queryFn: () => readUniverse(client!), enabled, refetchInterval: 60_000, retry: 1 });
  // Every registry asset's own feed, then the reference feeds (USDG / USD, ETH / USD).
  const feedRows = useMemo(() => (universe.data ? stockFeedEntries(universe.data) : REFERENCE_FEEDS), [universe.data]);
  const feeds = useQuery({
    queryKey: ['datalayer', 'feeds', feedRows.map((f) => f.proxy).join(',')],
    queryFn: () => readFeeds(client!, feedRows),
    enabled,
    refetchInterval: 60_000,
    retry: 1,
    placeholderData: (prev) => prev,
  });
  const park = useQuery({
    queryKey: ['datalayer', 'park'],
    queryFn: async () => (await client!.readContract({ address: SPARE.CashPark, abi: cashParkAbi, functionName: 'adapter' } as never)) as unknown as Address,
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const quotes = useQuery({
    queryKey: ['datalayer', 'quotes', universe.dataUpdatedAt, feeds.dataUpdatedAt],
    queryFn: () => readQuotes(client!, universe.data!, feeds.data!),
    enabled: enabled && !!universe.data && !!feeds.data,
    staleTime: 120_000,
    placeholderData: (prev) => prev,
    retry: 0,
  });
  return { chain, engine, universe, feeds, feedRows, park, quotes };
}

/* ----------------------------------- i18n ---------------------------------- */

/** protocol-feed's ago() ("3m ago"); it already returns the live language (pages-b `common.ago.*`). */
function useAgo() {
  return ago;
}

/** addressBook.ts copy (feed hours), keyed by its English. */
const HOURS_KEY: Record<string, string> = { 'US equities 24/5': tKey('book.hours.equities'), 'crypto 24/7': tKey('book.hours.crypto') };

/** Inline code inside a translated sentence (<mono>…</mono>). */
const MonoTag = ({ children }: { children?: ReactNode }) => <Mono>{children}</Mono>;

/* --------------------------------- helpers --------------------------------- */

const toneOf = (t: 'up' | 'warn' | 'down' | 'muted'): HoloTone => (t === 'up' ? 'good' : t === 'down' ? 'bad' : t);

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // i18n-ignore — a UTC clock reads the same in every language
  return <span translate="no">{now.toISOString().slice(11, 19)} UTC</span>;
}

/* ---------------------------------- boot ----------------------------------- */

type ProbeState = 'pending' | 'ok' | 'warn' | 'fail' | 'info';
interface Probe {
  label: string;
  state: ProbeState;
  text: string;
}

const PROBE_COLOR: Record<ProbeState, string> = {
  pending: HOLO.onScreenSubtle,
  ok: HOLO.goodLit,
  warn: HOLO.warnLit,
  fail: HOLO.badLit,
  info: HOLO.onScreen,
};

function BootLine({ p }: { p: Probe }) {
  return (
    <div className="dl-line" key={`${p.label}:${p.state}`} style={{ display: 'flex', gap: 0, minWidth: 0 }}>
      <span className="dl-label" style={{ flexShrink: 0, width: '17ch', color: HOLO.onScreenMuted, whiteSpace: 'pre' }}>
        {p.label.padEnd(16, ' ')}
      </span>
      <span
        className={p.state === 'pending' ? 'dl-pending' : 'dl-typed'}
        style={{ minWidth: 0, color: PROBE_COLOR[p.state], overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
      >
        :{p.text}
      </span>
    </div>
  );
}

/* ---------------------------------- page ----------------------------------- */

type Row = Record<string, unknown>;

export default function DataLayer() {
  const { t } = useTranslation('pages-b');
  const agoT = useAgo();
  usePageMeta(t('dataLayer.meta.title'), t('dataLayer.meta.description'));
  /** Text owned by addressBook.ts: our translation only while our English copy still matches it. */
  const book = (key: string | undefined, english: string) => (key && t(key, { lng: 'en' }) === english ? t(key) : english);
  const ROW = {
    chain: t('dataLayer.boot.rows.chain'),
    contracts: t('dataLayer.boot.rows.contracts'),
    engine: t('dataLayer.boot.rows.engine'),
    oracles: t('dataLayer.boot.rows.oracles'),
    universe: t('dataLayer.boot.rows.universe'),
    park: t('dataLayer.boot.rows.park'),
    keeper: t('dataLayer.boot.rows.keeper'),
  };
  const { chain, engine, universe, feeds, feedRows, park, quotes } = useDataLayer();
  const { status: api, checking: apiChecking } = useSpareApi();
  const { pulse, loading: pulseLoading } = useKeeperPulse(true);
  const deployAddrs = useMemo(() => [...SPARE_CONTRACTS, ...INFRA_CONTRACTS].map((c) => c.address), []);
  const { code } = useBytecode(deployAddrs);

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const stocks = universe.data ?? null;
  const eligible = stocks?.filter((s) => s.eligible) ?? [];
  const standby = stocks?.filter((s) => s.eligible === false) ?? [];
  const liveCount = eligible.filter((s) => s.status === 0).length;
  const deployedCount = code ? SPARE_CONTRACTS.filter((c) => code[c.address.toLowerCase()]).length : null;
  const head = chain.data?.head ?? null;

  /* ── boot probes ── */
  const probes: Probe[] = [];
  // Chain
  if (chain.data) {
    probes.push(
      chain.data.chainId === SPARE_CHAIN_ID
        ? { label: ROW.chain, state: 'ok', text: t('dataLayer.boot.chainOk', { block: chain.data.head.toLocaleString('en-US') }) }
        : { label: ROW.chain, state: 'fail', text: t('dataLayer.boot.chainWrong', { id: chain.data.chainId }) },
    );
  } else probes.push({ label: ROW.chain, state: chain.error ? 'fail' : 'pending', text: chain.error ? t('dataLayer.boot.rpcDown') : '…' });
  // Contracts
  const execCode = code ? code[SPARE.SweepExecutor.toLowerCase()] : undefined;
  probes.push(
    execCode === undefined
      ? { label: ROW.contracts, state: 'pending', text: '…' }
      : execCode
      ? { label: ROW.contracts, state: 'ok', text: t('dataLayer.boot.contractsOk', { addr: shortAddr(SPARE.SweepExecutor) }) }
      : { label: ROW.contracts, state: 'fail', text: t('dataLayer.boot.contractsFail') },
  );
  // Engine
  if (engine.data) {
    probes.push(
      engine.data.paused
        ? { label: ROW.engine, state: 'warn', text: t('dataLayer.boot.enginePaused') }
        : {
            label: ROW.engine,
            state: 'ok',
            text: t('dataLayer.boot.engineOk', { fee: (engine.data.feeBps / 100).toFixed(2), threshold: formatUsd(engine.data.threshold) }),
          },
    );
  } else probes.push({ label: ROW.engine, state: engine.error ? 'fail' : 'pending', text: engine.error ? t('dataLayer.boot.engineFail') : '…' });
  // Oracles
  if (stocks) {
    const n = eligible.length;
    const stale = eligible.filter((s) => s.status === 1);
    const firstBad = eligible.find((s) => s.status !== 0);
    if (n > 0 && liveCount === n) {
      probes.push({
        label: ROW.oracles,
        state: 'ok',
        text: t('dataLayer.boot.oraclesOk', { live: liveCount, n, symbols: symbolList(eligible.map((s) => s.symbol), 8) }),
      });
    } else if (n > 0 && stale.length === n) {
      const newest = Math.max(
        ...eligible.map((s) => (s.feed && feeds.data ? feeds.data[s.feed.toLowerCase()]?.updatedAt ?? 0 : 0)),
      );
      probes.push({
        label: ROW.oracles,
        state: 'warn',
        text: t('dataLayer.boot.oraclesClosed', { ago: newest > 0 ? agoT(newest, nowSec) : '—' }),
      });
    } else if (firstBad) {
      probes.push({
        label: ROW.oracles,
        state: 'warn',
        text: t('dataLayer.boot.oraclesDegraded', { live: liveCount, n, symbol: firstBad.symbol, status: oracleView(firstBad.status).label }),
      });
    } else probes.push({ label: ROW.oracles, state: 'warn', text: t('dataLayer.boot.oraclesNone') });
    // Universe
    probes.push({
      label: ROW.universe,
      state: 'info',
      text: standby.length
        ? t('dataLayer.boot.universeList', { n, standby: standby.length, list: symbolList(standby.map((s) => s.symbol), 8) })
        : t('dataLayer.boot.universe', { n, standby: standby.length }),
    });
  } else {
    probes.push({ label: ROW.oracles, state: universe.error ? 'fail' : 'pending', text: universe.error ? t('dataLayer.boot.registryFail') : '…' });
    probes.push({ label: ROW.universe, state: universe.error ? 'fail' : 'pending', text: universe.error ? t('dataLayer.boot.registryFail') : '…' });
  }
  // Park
  if (park.data) {
    probes.push(
      park.data.toLowerCase() === SPARE.SgovParkAdapter.toLowerCase()
        ? { label: ROW.park, state: 'info', text: t('dataLayer.boot.parkSgov') }
        : { label: ROW.park, state: 'ok', text: t('dataLayer.boot.parkUsdg') },
    );
  } else probes.push({ label: ROW.park, state: park.error ? 'fail' : 'pending', text: park.error ? t('dataLayer.boot.parkFail') : '…' });
  // Spare API
  if (api) {
    probes.push(
      api.online
        ? { label: 'Spare API', state: 'ok', text: t('dataLayer.boot.apiOk', { n: api.toolCount ?? '—' }) }
        : { label: 'Spare API', state: 'warn', text: t('dataLayer.boot.apiDown') },
    );
  } else probes.push({ label: 'Spare API', state: apiChecking ? 'pending' : 'warn', text: apiChecking ? '…' : t('dataLayer.boot.apiDown') });
  // Keeper
  if (pulse) {
    const w = pulse.linkedWallets == null ? '—' : String(pulse.linkedWallets);
    const lastSweep = pulse.lastAccountSwept;
    const newest = Math.max(pulse.lastAccrued?.at ?? 0, lastSweep?.at ?? 0);
    if (!pulse.lastAccrued) {
      probes.push({
        label: ROW.keeper,
        state: 'info',
        text: w === '1' ? t('dataLayer.boot.keeperStandbyOne', { n: w }) : t('dataLayer.boot.keeperStandbyMany', { n: w }),
      });
    } else if (newest > 0 && nowSec - newest > 48 * 3600) {
      probes.push({ label: ROW.keeper, state: 'warn', text: t('dataLayer.boot.keeperIdle', { ago: agoT(newest, nowSec) }) });
    } else {
      probes.push({
        label: ROW.keeper,
        state: 'ok',
        text: lastSweep
          ? t('dataLayer.boot.keeperOk', { ago: agoT(pulse.lastAccrued.at, nowSec), sweep: agoT(lastSweep.at, nowSec) })
          : t('dataLayer.boot.keeperOkNoSweep', { ago: agoT(pulse.lastAccrued.at, nowSec) }),
      });
    }
  } else probes.push({ label: ROW.keeper, state: pulseLoading ? 'pending' : 'warn', text: pulseLoading ? '…' : t('dataLayer.boot.keeperFail') });
  // One line per contract
  for (const c of SPARE_CONTRACTS) {
    const has = code ? code[c.address.toLowerCase()] : undefined;
    probes.push(
      has === undefined
        ? { label: c.name, state: 'pending', text: '…' }
        : {
            label: c.name,
            state: has ? 'ok' : 'fail',
            text: has ? t('dataLayer.boot.codeOk', { addr: shortAddr(c.address) }) : t('dataLayer.boot.codeFail', { addr: shortAddr(c.address) }),
          },
    );
  }

  /* ── tables ── */
  type FeedRow = FeedEntry & Row;
  const bySymbol = new Map((stocks ?? []).map((s) => [s.symbol, s]));
  const feedCols: HoloColumn<FeedRow>[] = [
    { key: 'pair', label: t('dataLayer.feeds.cols.feed'), width: 110, render: (r) => <strong translate="no">{r.pair}</strong> },
    { key: 'proxy', label: t('dataLayer.feeds.cols.proxy'), width: 'minmax(120px, 1fr)', render: (r) => <AddressLink address={r.proxy} /> },
    { key: 'hours', label: t('dataLayer.feeds.cols.hours'), width: 'minmax(140px, 1fr)', render: (r) => book(HOURS_KEY[r.hours], r.hours) },
    {
      key: 'answer',
      label: t('dataLayer.feeds.cols.answer'),
      width: 110,
      align: 'right',
      render: (r) => fmtFeedPrice(feeds.data?.[r.proxy.toLowerCase()]?.answer ?? null, FEED_DECIMALS),
    },
    {
      key: 'updated',
      label: t('dataLayer.feeds.cols.updated'),
      width: 90,
      align: 'right',
      render: (r) => agoT(feeds.data?.[r.proxy.toLowerCase()]?.updatedAt ?? null, nowSec),
    },
    {
      key: 'status',
      label: t('dataLayer.feeds.cols.status'),
      width: 110,
      pin: false,
      render: (r) => {
        if (r.symbol) {
          const s = bySymbol.get(r.symbol);
          if (!s) return <HoloBadge label={universe.isPending ? '…' : '—'} tone="muted" />;
          const v = oracleView(s.status);
          return <HoloBadge label={v.label} tone={toneOf(v.tone)} title={v.detail} />;
        }
        const at = feeds.data?.[r.proxy.toLowerCase()]?.updatedAt;
        if (at == null) return <HoloBadge label={feeds.isPending ? '…' : '—'} tone="muted" />;
        return nowSec - at <= FEED_HEARTBEAT_SEC + 3600 ? (
          <HoloBadge label={t('dataLayer.feeds.fresh')} tone="good" />
        ) : (
          <HoloBadge label={t('dataLayer.feeds.stale')} tone="warn" />
        );
      },
    },
  ];

  type PoolRow = StockInfo & Row;
  const poolCols: HoloColumn<PoolRow>[] = [
    {
      key: 'symbol',
      label: t('dataLayer.pools.cols.stock'),
      width: 120,
      wrap: true,
      render: (r) => {
        // standbyText is already in the live language (shell assets.standby.*).
        const why = r.eligible === false ? standbyText(standbyReason({ active: false, bandBps: r.bandBps }, quotes.data?.[r.token.toLowerCase()]?.short100)) : null;
        return (
          <span>
            <AssetLabel symbol={r.symbol} kind={r.kind} size={12.5} />
            {why && <span style={{ display: 'block', color: INK.muted, fontSize: 11 }}>{why}</span>}
          </span>
        );
      },
    },
    {
      key: 'status',
      label: t('dataLayer.pools.cols.status'),
      width: 100,
      render: (r) => (r.eligible ? <HoloBadge label={t('common.active')} tone="good" /> : <HoloBadge label={t('common.inactive')} tone="warn" />),
    },
    { key: 'fee', label: t('dataLayer.pools.cols.fee'), width: 80, align: 'right', render: (r) => (r.poolKey ? fmtPoolFee(Number(r.poolKey.fee)) : '—') },
    { key: 'tick', label: t('dataLayer.pools.cols.tick'), width: 96, align: 'right', render: (r) => (r.poolKey ? String(r.poolKey.tickSpacing) : '—') },
    {
      key: 'hook',
      label: t('dataLayer.pools.cols.hook'),
      width: 110,
      render: (r) => (!r.poolKey ? '—' : r.poolKey.hooks === zeroAddress ? t('dataLayer.pools.none') : <AddressLink address={r.poolKey.hooks} />),
    },
    {
      key: 'q5',
      label: t('dataLayer.pools.cols.q5'),
      width: 160,
      align: 'right',
      render: (r) => (quotes.data ? fmtEdge(quotes.data[r.token.toLowerCase()]?.edge[0]) : quotes.isFetching ? '…' : '—'),
    },
    {
      key: 'q100',
      label: t('dataLayer.pools.cols.q100'),
      width: 172,
      align: 'right',
      pin: false,
      render: (r) => (quotes.data ? fmtEdge(quotes.data[r.token.toLowerCase()]?.edge[1]) : quotes.isFetching ? '…' : '—'),
    },
  ];

  type DeployRow = BookEntry & Row & { group: string };
  const deployRows: DeployRow[] = [
    ...SPARE_CONTRACTS.map((c) => ({ ...c, group: 'Spare' })),
    ...INFRA_CONTRACTS.map((c) => ({ ...c, group: 'Robinhood Chain' })),
  ] as DeployRow[];
  const deployCells: FlexCell<DeployRow>[] = [
    { key: 'name', basis: '190px', grow: 0, render: (r) => <strong translate="no">{r.name}</strong> },
    { key: 'address', basis: '330px', grow: 2, render: (r) => <AddressLink address={r.address} full /> },
    { key: 'group', basis: '70px', grow: 0, muted: true, render: (r) => (r.group === 'Spare' ? 'Spare' : t('dataLayer.deploy.external')) },
    { key: 'code', basis: 'auto', fixed: true, render: (r) => <CodeBadge ok={code ? code[r.address.toLowerCase()] : null} /> },
  ];

  const tokenCols: HoloColumn<PoolRow>[] = [
    { key: 'symbol', label: t('dataLayer.tokens.cols.token'), width: 70, render: (r) => <strong translate="no">{r.symbol}</strong> },
    {
      key: 'token',
      label: t('dataLayer.tokens.cols.address'),
      width: 'minmax(250px, 1.6fr)',
      wrap: true,
      render: (r) => <AddressLink address={r.token} full kind="token" />,
    },
    {
      key: 'ui',
      label: 'uiMultiplier()', // i18n-ignore — function name
      width: 110,
      align: 'right',
      render: (r) => (r.uiMultiplier != null && r.uiMultiplier > 0n ? formatToken(r.uiMultiplier, 18, 6) : '—'),
    },
    {
      key: 'paused',
      label: 'paused()', // i18n-ignore — function name
      width: 84,
      render: (r) => (r.paused == null ? '—' : r.paused ? <HoloBadge label={t('dataLayer.tokens.yes')} tone="warn" /> : t('dataLayer.tokens.no')),
    },
    {
      key: 'oraclePaused',
      label: 'oraclePaused()', // i18n-ignore — function name
      width: 110,
      pin: false,
      render: (r) => (r.oraclePaused == null ? '—' : r.oraclePaused ? <HoloBadge label={t('dataLayer.tokens.yes')} tone="warn" /> : t('dataLayer.tokens.no')),
    },
  ];

  // Any registered token works; the first active one (or the registry's own list) is the example.
  const sampleToken = eligible[0]?.token ?? stocks?.[0]?.token;
  const checkIt = `cast block-number --rpc-url ${RHC_RPC_URL}
cast call ${SPARE.AssetRegistry} "tokens()(address[])" --rpc-url ${RHC_RPC_URL}
cast call ${SPARE.StockRouter} "oracleStatus(address)(uint8,uint256)" ${sampleToken ?? '<token from tokens()>'} --rpc-url ${RHC_RPC_URL}
cast call ${SPARE.SweepExecutor} "threshold()(uint256)" --rpc-url ${RHC_RPC_URL}`;

  const registered = stocks?.length ?? null;
  const pending = (q: { isPending: boolean; error: unknown }) => (q.error ? '—' : '…');

  return (
    <LivePageFrame
      exeTitle={t('dataLayer.exeTitle')}
      banner={t('dataLayer.banner')}
      bannerRight={
        <>
          <UtcClock />
          <Link to="/" className="dl-open">
            {t('dataLayer.openSpareBar')}
          </Link>
        </>
      }
    >
      <HoloHero
        kicker={t('dataLayer.hero.kicker')}
        title={t('dataLayer.hero.title')}
        description={t('dataLayer.hero.description')}
        art={null}
        aside={<HoloBadge label={t('shell:common.liveData')} tone="good" variant="solid" pulse dot />}
        seed={5}
      >
        <CtaRow>
          <LinkButton to="/" variant="primary" size="sm">
            {t('dataLayer.hero.open')}
          </LinkButton>
        </CtaRow>
      </HoloHero>

      <Grid min={380} gap={12}>
        <HoloCard compact flat closeBox={false}>
          <HoloStat label={t('dataLayer.stats.head')} value={head != null ? `#${head.toLocaleString('en-US')}` : pending(chain)} size="lg" sub="Robinhood Chain · 4663" />
        </HoloCard>
        <HoloCard compact flat closeBox={false}>
          <HoloStat
            label={t('dataLayer.stats.feeds')}
            value={stocks ? `${liveCount}/${eligible.length}` : pending(universe)}
            size="lg"
            sub={t('dataLayer.stats.feedsSub')}
            tone={stocks && liveCount < eligible.length ? 'warn' : 'holo'}
          />
        </HoloCard>
        <HoloCard compact flat closeBox={false}>
          <HoloStat
            label={t('dataLayer.stats.pools')}
            value={registered != null ? String(registered) : pending(universe)}
            size="lg"
            sub={stocks ? t('dataLayer.stats.poolsSub', { n: eligible.length }) : t('dataLayer.stats.poolsSubPending')}
          />
        </HoloCard>
        <HoloCard compact flat closeBox={false}>
          <HoloStat
            label={t('dataLayer.stats.contracts')}
            value={deployedCount != null ? `${deployedCount}/10` : '…'}
            size="lg"
            sub={t('dataLayer.stats.contractsSub')}
          />
        </HoloCard>
      </Grid>

      <HoloCard title={t('dataLayer.boot.title')} bar="ink" accent={t('dataLayer.boot.accent')} accentTone="good">
        <HoloScreen grid padding="10px 12px">
          <div
            role="log"
            aria-live="polite"
            style={{ fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.7, display: 'flex', flexDirection: 'column', minWidth: 0 }}
          >
            {probes.map((p, i) => (
              <BootLine key={`${i}-${p.label}`} p={p} />
            ))}
          </div>
        </HoloScreen>
      </HoloCard>

      <HoloCard title="Robinhood Chain">
        <HoloList>
          <HoloListRow
            label={t('dataLayer.chain.network')}
            value={
              chain.data
                ? chain.data.chainId === SPARE_CHAIN_ID
                  ? t('dataLayer.chain.mainnet')
                  : t('dataLayer.chain.unexpected', { id: chain.data.chainId })
                : pending(chain)
            }
            tone={chain.data && chain.data.chainId !== SPARE_CHAIN_ID ? 'bad' : 'ink'}
            hint="eth_chainId" // i18n-ignore — RPC method
          />
          <HoloListRow
            label={t('dataLayer.chain.head')}
            value={head != null ? `#${head.toLocaleString('en-US')}` : pending(chain)}
            hint={t('dataLayer.chain.headHint')}
          />
          <HoloListRow
            label={t('dataLayer.chain.blockTime')}
            value={chain.data?.blockTimeSec != null ? `${chain.data.blockTimeSec.toFixed(2)}s` : chain.data ? '—' : pending(chain)}
            hint={t('dataLayer.chain.blockTimeHint')}
          />
          <HoloListRow
            label={t('dataLayer.chain.gas')}
            value={chain.data?.gasPriceWei != null ? `${Number(formatGwei(chain.data.gasPriceWei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} gwei` : chain.data ? '—' : pending(chain)}
            hint={t('dataLayer.chain.gasHint')}
          />
          <HoloListRow label="RPC" value="rpc.mainnet.chain.robinhood.com" hint={t('dataLayer.chain.rpcHint')} />
        </HoloList>
      </HoloCard>

      <HoloCard
        title={t('dataLayer.feeds.title')}
        accent={universe.data ? t('dataLayer.feeds.accent', { n: feedRows.length }) : pending(universe)}
        accentTone="info"
      >
        <HoloTable<FeedRow>
          columns={feedCols}
          rows={feedRows as FeedRow[]}
          rowKey={(r) => r.proxy}
          minWidth={700}
          maxHeight={520}
          ariaLabel={t('dataLayer.feeds.title')}
        />
        <Prose muted style={{ fontSize: 11.5 }}>
          {t('dataLayer.feeds.note')}
        </Prose>
      </HoloCard>

      <HoloCard title={t('dataLayer.pools.title')} accent={t('dataLayer.pools.accent')} accentTone="info">
        <HoloTable<PoolRow>
          columns={poolCols}
          rows={(stocks ?? []) as PoolRow[]}
          rowKey={(r) => r.token}
          loading={universe.isPending}
          emptyMessage={universe.error ? t('dataLayer.pools.registryFail') : t('dataLayer.noStocks')}
          minWidth={820}
          maxHeight={560}
          ariaLabel={t('dataLayer.pools.aria')}
        />
        <Prose muted style={{ fontSize: 11.5 }}>
          {t('dataLayer.pools.note')}
        </Prose>
      </HoloCard>

      <HoloCard
        title={t('dataLayer.deploy.title')}
        accent={deployedCount != null ? t('dataLayer.deploy.accent', { n: deployedCount }) : t('dataLayer.deploy.checking')}
        accentTone={deployedCount === 10 ? 'good' : 'info'}
      >
        <FlexRows cells={deployCells} rows={deployRows} rowKey={(r) => `${r.group}:${r.name}`} ariaLabel={t('dataLayer.deploy.title')} />
      </HoloCard>

      <HoloCard title={t('dataLayer.tokens.title')}>
        <Prose>
          <Trans
            t={t}
            i18nKey="dataLayer.tokens.intro"
            components={{ addr: <AddressLink address={STOCK_TOKEN_BEACON} />, mono: <MonoTag /> }}
          />
        </Prose>
        <HoloTable<PoolRow>
          columns={tokenCols}
          rows={(stocks ?? []) as PoolRow[]}
          rowKey={(r) => r.token}
          loading={universe.isPending}
          emptyMessage={universe.error ? t('dataLayer.tokens.fail') : t('dataLayer.noStocks')}
          minWidth={680}
          maxHeight={520}
          dense
          ariaLabel={t('dataLayer.tokens.title')}
        />
      </HoloCard>

      <HoloCard title={t('dataLayer.check.title')} bar="lilac">
        <Prose>{t('dataLayer.check.body')}</Prose>
        {/* i18n-ignore — shell and tool names */}
        <CodeBlock code={checkIt} title="bash · cast" />
      </HoloCard>

      <CtaRow>
        <LinkButton to="/universe" variant="primary">
          {t('dataLayer.cta.stocks')}
        </LinkButton>
        <LinkButton to="/dispatch">{t('common.liveSweeps')}</LinkButton>
        <LinkButton to="/devtools">{t('common.devtools')}</LinkButton>
      </CtaRow>

      <style>{`
        .dl-open {
          color: ${HOLO.onScreen};
          font-family: ${FONT_PIXEL};
          text-decoration: none;
          padding: 1px 6px;
          box-shadow: inset 0 0 0 1px ${HOLO.onScreenSubtle};
        }
        .dl-open:hover { background: rgba(255,255,255,.12); }
        .dl-typed { display: inline-block; animation: dl-type .5s steps(24, end) both; }
        .dl-pending { animation: dl-blink 1s steps(2, end) infinite; }
        @keyframes dl-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes dl-blink { 50% { opacity: .25; } }
        @media (max-width: 767px) {
          .dl-line { flex-direction: column; padding-bottom: 4px; }
          .dl-label { width: auto !important; font-size: 10.5px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dl-typed, .dl-pending { animation: none; }
        }
      `}</style>
    </LivePageFrame>
  );
}
