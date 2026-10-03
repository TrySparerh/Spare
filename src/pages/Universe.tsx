/**
 * /universe — the Stock Universe.
 *
 * Every asset Spare can buy, live from AssetRegistry + StockRouter + the
 * Chainlink feeds on Robinhood Chain: active / standby (with the reason,
 * measured live through the pinned pool), guarded price or last close, the
 * ~1 day move, oracle status, the pinned Uniswap v4 pool, the default mix and
 * the token address. Refreshes every 60 s.
 *
 * The list is whatever the registry holds — nothing here names a ticker — so
 * it has search, a stocks / ETFs and active / standby filter, sorting, a
 * scrolling table on desktop and a paged card list on phones. If the chain
 * can't be read the page says so and lists nothing.
 *
 * Text: pages-b `universe.*` (plus shared `common.*`, shell `common.*` and
 * shell `assets.*`).
 */
import { useState, type CSSProperties } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { parseAbi, zeroAddress, type Address } from 'viem';
import {
  FONT_TEXT,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloLabel,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloStat,
  HoloTable,
  INK,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';
import { AddrLink, Hint, MutedWell } from '@/components/retro/apps/spare/SpareUi';
import { AssetFilterBar, AssetLabel, NoAssetMatch, PagerRow, useAssetQuery, usePaged } from '@/components/retro/apps/assetUi';
import { CtaRow, HoloLinkButton, HoloPageWindow, usePageMeta } from '@/components/public/HoloPageWindow';
import { useIsMobile } from '@/hooks/use-mobile';
import { aggregatorV3Abi, electionRegistryAbi, stockRouterAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, addressUrl, sameAddress, shortAddr, symbolOf } from '@/lib/spare-chain/addresses';
import { oracleView, useSpareDeployment } from '@/lib/spare-chain/hooks';
import {
  filterAssets,
  sortAssets,
  standbyReason,
  standbyText,
  symbolList,
  useAssetCatalog,
  useDayChanges,
  useStandbyMeasurements,
  type AssetKind,
  type DayChange,
} from '@/lib/spare-chain/universe';
import { type PoolKey } from '@/lib/spare-chain/fund-swap';
import { formatBps, formatFixed, to1e18 } from '@/lib/spare';
import { Trans, getT, useTranslation } from '@/i18n';

const chainId = SPARE_CHAIN_ID;
const DASH = '—';
/** For the formatting helpers below, which run during render. */
const tf = getT('pages-b');

const stockTokenAbi = parseAbi(['function uiMultiplier() view returns (uint256)']);
/** v4's dynamic-fee flag: the hook sets the LP fee per swap. */
const DYNAMIC_FEE = 0x800000;
/** Phone cards per page before "show more". */
const MOBILE_PAGE = 10;

/* --------------------------------- model ---------------------------------- */

type AssetRow = {
  token: Address;
  symbol: string;
  name: string | null;
  kind: AssetKind;
  active: boolean;
  status: number | null;
  /** Guarded price (status OK), 1e18. */
  price1e18: bigint;
  /** Chainlink's last answer, 1e18. */
  lastPrice1e18: bigint | null;
  lastUpdatedAt: number | null;
  feed: Address | null;
  heartbeat: number | null;
  bandBps: number | null;
  poolKey: PoolKey | null;
  defaultBps: number | null;
  uiMultiplier: bigint | null;
} & Record<string, unknown>;

function useStockUniverse(enabled: boolean) {
  // Registry entries + symbol() / name(): the catalog every Spare screen shares.
  const catalog = useAssetCatalog({ enabled });
  const metas = catalog.assets;

  const liveQ = useReadContracts({
    allowFailure: true,
    contracts: metas.flatMap((m) => [
      { address: SPARE.StockRouter, abi: stockRouterAbi, functionName: 'oracleStatus', args: [m.token], chainId } as const,
      { address: m.token, abi: stockTokenAbi, functionName: 'uiMultiplier', chainId } as const,
    ]),
    query: { enabled: enabled && metas.length > 0, refetchInterval: 60_000 },
  });

  const feedList = metas.map((m) => m.feed).filter((f): f is Address => !!f && f !== zeroAddress);
  const feedQ = useReadContracts({
    allowFailure: true,
    contracts: feedList.map((f) => ({ address: f, abi: aggregatorV3Abi, functionName: 'latestRoundData', chainId }) as const),
    query: { enabled: enabled && feedList.length > 0, refetchInterval: 60_000 },
  });

  const mixQ = useReadContract({
    address: SPARE.ElectionRegistry,
    abi: electionRegistryAbi,
    functionName: 'defaultMix',
    chainId,
    query: { enabled, refetchInterval: 300_000 },
  });
  const defaultLegs = (mixQ.data ?? null) as readonly { asset: Address; bps: number }[] | null;

  let feedIdx = 0;
  const rows: AssetRow[] = metas.map((m, i) => {
    const os = liveQ.data?.[i * 2]?.result as readonly [number, bigint] | undefined;
    const uim = liveQ.data?.[i * 2 + 1]?.result as bigint | undefined;
    let lastPrice1e18: bigint | null = null;
    let lastUpdatedAt: number | null = null;
    if (m.feed) {
      const round = feedQ.data?.[feedIdx]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
      feedIdx += 1;
      if (round && round[1] > 0n && m.feedDecimals != null) {
        lastPrice1e18 = to1e18(round[1], m.feedDecimals);
        lastUpdatedAt = Number(round[3]);
      }
    }
    const leg = defaultLegs?.find((l) => sameAddress(l.asset, m.token));
    return {
      token: m.token,
      symbol: m.symbol,
      name: m.name,
      kind: m.kind,
      active: m.active,
      status: os ? Number(os[0]) : null,
      price1e18: os ? os[1] : 0n,
      lastPrice1e18,
      lastUpdatedAt,
      feed: m.feed,
      heartbeat: m.heartbeat,
      bandBps: m.bandBps,
      poolKey: m.poolKey,
      defaultBps: defaultLegs ? (leg ? Number(leg.bps) : 0) : null,
      uiMultiplier: uim ?? null,
    };
  });

  const mixText = defaultLegs
    ? defaultLegs.map((l) => `${formatBps(Number(l.bps))}% ${symbolOf(l.asset)}`).join(' · ') || DASH
    : null;

  return {
    rows,
    mixText,
    loading: enabled && (catalog.isLoading || (metas.length > 0 && liveQ.isLoading)),
    error: catalog.error,
    refetch: () => {
      catalog.refetch();
      void liveQ.refetch();
      void feedQ.refetch();
      void mixQ.refetch();
    },
  };
}

/* -------------------------------- formatting ------------------------------- */

function usd1e18(v: bigint): string {
  return `$${formatFixed(v, 18, 2)}`;
}

/** The price to show and judge fills by: guarded when OK, else Chainlink's last answer. */
function oracleOf(r: AssetRow): bigint | null {
  if (r.status === 0 && r.price1e18 > 0n) return r.price1e18;
  return r.lastPrice1e18;
}

function priceOf(r: AssetRow): { text: string; lastClose: boolean } {
  if (r.status === 0 && r.price1e18 > 0n) return { text: usd1e18(r.price1e18), lastClose: false };
  if (r.lastPrice1e18 !== null) return { text: usd1e18(r.lastPrice1e18), lastClose: true };
  return { text: DASH, lastClose: false };
}

function ago(ts: number | null): string {
  if (ts === null) return DASH;
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 3600) return tf('common.ago.m', { n: Math.max(1, Math.floor(s / 60)) });
  if (s < 48 * 3600) return tf('common.ago.h', { n: Math.floor(s / 3600) });
  return tf('common.ago.d', { n: Math.floor(s / 86400) });
}

function poolFee(fee: number): string {
  if (fee === DYNAMIC_FEE) return tf('universe.pool.dynamic');
  return fee === 0 ? '0%' : `${(fee / 10_000).toFixed(fee % 100 === 0 ? 2 : 4)}%`;
}

function poolText(p: PoolKey | null): string {
  if (!p) return DASH;
  return `Uniswap v4 · ${poolFee(Number(p.fee))} · ${p.hooks === zeroAddress ? tf('universe.pool.noHook') : tf('universe.pool.hooked')}`;
}

function oracleTone(status: number | null): HoloTone {
  const t = oracleView(status).tone;
  return t === 'up' ? 'good' : t === 'down' ? 'bad' : t === 'warn' ? 'warn' : 'muted';
}

function multiplierText(v: bigint | null): string {
  if (v === null) return DASH;
  const s = formatFixed(v, 18, 6);
  return `${s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s}×`;
}

function changeText(c: DayChange | undefined): string {
  if (!c) return DASH;
  return `${c.pct >= 0 ? '+' : '−'}${Math.abs(c.pct).toFixed(2)}%`;
}

/* -------------------------------- pieces ---------------------------------- */

function CopyAddress({ address }: { address: string }) {
  const { t } = useTranslation('pages-b');
  const [copied, setCopied] = useState(false);
  return (
    <HoloButton
      size="sm"
      variant="ghost"
      aria-label={t('universe.copyAria', { address })}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard
          ?.writeText(address)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? t('universe.copied') : t('universe.copy')}
    </HoloButton>
  );
}

function StatusCell({ r, why }: { r: AssetRow; why: string | null }) {
  const { t } = useTranslation('pages-b');
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
      <HoloBadge label={r.active ? t('universe.status.active') : t('universe.status.inactive')} tone={r.active ? 'good' : 'muted'} />
      {why && <span style={{ fontFamily: FONT_TEXT, fontSize: 10.5, color: INK.muted, whiteSpace: 'normal' }}>{why}</span>}
    </span>
  );
}

function PriceCell({ r, change }: { r: AssetRow; change: DayChange | undefined }) {
  const { t } = useTranslation('pages-b');
  const p = priceOf(r);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
      <span style={{ fontWeight: 700 }}>{p.text}</span>
      {p.lastClose && <span style={{ fontSize: 10.5, color: INK.muted }}>{t('universe.lastClose')}</span>}
      {change && (
        <span title={t('shell:assets.change.title')} style={{ fontSize: 10.5, fontWeight: 700, color: change.pct >= 0 ? INK.good : INK.bad }}>
          {changeText(change)}
        </span>
      )}
    </span>
  );
}

function AssetDetails({ r, why }: { r: AssetRow; why: string | null }) {
  const { t } = useTranslation('pages-b');
  const view = oracleView(r.status);
  return (
    <HoloList>
      {why && <HoloListRow label={t('universe.details.standby')} hint={why} />}
      <HoloListRow
        label={t('universe.details.addToWallet')}
        hint={
          <Trans
            t={t}
            i18nKey="universe.details.decimals"
            values={{ token: r.token }}
            components={{ addr: <span style={{ overflowWrap: 'anywhere' }} /> }}
          />
        }
        right={<CopyAddress address={r.token} />}
      />
      <HoloListRow label={t('universe.details.multiplier')} value={multiplierText(r.uiMultiplier)} hint={t('universe.details.multiplierHint')} />
      <HoloListRow
        label={t('universe.details.feed')}
        value={r.feed ? <AddrLink address={r.feed} /> : DASH}
        hint={r.heartbeat ? t('universe.details.heartbeat', { h: Math.round(r.heartbeat / 3600) }) : undefined}
      />
      <HoloListRow label={t('universe.details.oracle')} value={view.label} tone={oracleTone(r.status)} hint={view.detail} />
      <HoloListRow label={t('universe.details.band')} value={r.bandBps !== null ? `${formatBps(r.bandBps)}%` : DASH} hint={t('universe.details.bandHint')} />
      <HoloListRow
        label={t('universe.details.pool')}
        value={poolText(r.poolKey)}
        hint={
          r.poolKey ? (
            <>
              {t('universe.details.tickSpacing', { n: Number(r.poolKey.tickSpacing) })}
              {r.poolKey.hooks !== zeroAddress && (
                <>
                  {' '}
                  {/* i18n-ignore: "hook" is the Uniswap v4 term */}
                  · hook <AddrLink address={r.poolKey.hooks} />
                </>
              )}
            </>
          ) : undefined
        }
      />
    </HoloList>
  );
}

function TokenCell({ r }: { r: AssetRow }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <a
        href={addressUrl(r.token)}
        target="_blank"
        rel="noopener noreferrer"
        title={r.token}
        onClick={(e) => e.stopPropagation()}
        style={{ color: INK.link, fontWeight: 700, textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}
      >
        {shortAddr(r.token)} ↗
      </a>
      <CopyAddress address={r.token} />
    </span>
  );
}

/** Built at render so the headers follow the language. */
const columns = (
  t: typeof tf,
  whyOf: (r: AssetRow) => string | null,
  changeOf: (r: AssetRow) => DayChange | undefined,
): HoloColumn<AssetRow>[] => [
  {
    key: 'symbol',
    label: t('universe.cols.stock'),
    width: 'minmax(170px, 1.5fr)',
    // Standby assets read greyed out; the status column says why.
    render: (r) => (
      <span style={r.active ? undefined : { opacity: 0.6 }}>
        <AssetLabel symbol={r.symbol} name={r.name} kind={r.kind} />
      </span>
    ),
  },
  { key: 'active', label: t('universe.cols.status'), width: 'minmax(150px, 1.4fr)', wrap: true, render: (r) => <StatusCell r={r} why={whyOf(r)} /> },
  {
    key: 'price',
    label: t('universe.cols.price'),
    width: 104,
    align: 'right',
    render: (r) => (
      <span style={r.active ? undefined : { opacity: 0.6 }}>
        <PriceCell r={r} change={changeOf(r)} />
      </span>
    ),
  },
  { key: 'updated', label: t('universe.cols.updated'), width: 80, render: (r) => ago(r.lastUpdatedAt) },
  {
    key: 'oracle',
    label: t('universe.cols.oracle'),
    width: 104,
    render: (r) => <HoloBadge label={oracleView(r.status).label} tone={oracleTone(r.status)} title={oracleView(r.status).detail} />,
  },
  { key: 'pool', label: t('universe.cols.pool'), width: 'minmax(170px, 1.4fr)', wrap: true, render: (r) => poolText(r.poolKey) },
  { key: 'mix', label: t('universe.cols.mix'), width: 90, align: 'right', render: (r) => (r.defaultBps ? `${formatBps(r.defaultBps)}%` : DASH) },
  { key: 'token', label: t('universe.cols.token'), width: 170, pin: false, render: (r) => <TokenCell r={r} /> },
];

/** Surface-aware ink for the deep-indigo selected row (links, hints, the copy key). */
const SELECTED_ROW_CSS = `
  .su-board .holo-table__row--selected {
    --holo-ink: #FFF6EE;
    --holo-ink-muted: #CBBEFF;
    --holo-ink-link: #D9CCFF;
  }
  .su-board .holo-table__row--selected .holo-btn--ghost { color: #FFF6EE; }
`;

/* ---------------------------------- page ---------------------------------- */

const GRID: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 14, alignItems: 'start' };

export default function Universe() {
  const { t } = useTranslation('pages-b');
  usePageMeta(t('universe.meta.title'), t('universe.meta.description'));
  const isMobile = useIsMobile();
  const deployment = useSpareDeployment();
  const live = useStockUniverse(deployment.deployed);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useAssetQuery('spare.universe.query');

  const rows = live.rows;
  const unreadable = !deployment.checking && (!deployment.deployed || (!!live.error && rows.length === 0));
  const loading = deployment.checking || live.loading;

  const { changes } = useDayChanges(rows.map((r) => r.feed), { enabled: !unreadable });
  const changeOf = (r: AssetRow) => (r.feed ? changes.get(r.feed.toLowerCase()) : undefined);
  const measured = useStandbyMeasurements(rows, (tok) => {
    const r = rows.find((x) => sameAddress(x.token, tok));
    return r ? oracleOf(r) : null;
  });
  // standbyText speaks the live language (shell assets.standby.*).
  const whyOf = (r: AssetRow) =>
    standbyText(standbyReason(r, measured.has(r.token.toLowerCase()) ? measured.get(r.token.toLowerCase()) : undefined));

  const shown = sortAssets(filterAssets(rows, query), query.sort, {
    price: (r) => {
      const p = oracleOf(r);
      return p == null ? null : Number(p) / 1e18;
    },
    change: (r) => changeOf(r)?.pct,
  });
  const paged = usePaged(shown, MOBILE_PAGE, [query.search, query.kind, query.state, query.sort].join('|'));
  const clearFilters = () => setQuery({ search: '', kind: 'all', state: 'all' });

  const active = rows.filter((r) => r.active);
  const statuses = active.map((r) => r.status);
  const read = !unreadable && statuses.length > 0 && statuses.every((s) => s !== null);
  let market: { text: string; tone: HoloTone; sub: string } = {
    text: DASH,
    tone: 'ink',
    sub: loading ? t('universe.market.reading') : t('universe.market.unavailable'),
  };
  if (read) {
    if (statuses.every((s) => s === 0)) market = { text: t('universe.market.open'), tone: 'good', sub: t('universe.market.openSub') };
    else if (statuses.every((s) => s === 1)) market = { text: t('universe.market.closed'), tone: 'warn', sub: t('universe.market.closedSub') };
    else {
      const off = active.filter((r) => r.status !== 0);
      const label = oracleView(off[0]?.status).label;
      market = { text: t('universe.market.mixed'), tone: 'warn', sub: `${symbolList(off.map((r) => r.symbol), 4)} · ${label}` };
    }
  }

  const selectedRow = rows.find((r) => r.token === selected) ?? null;
  const heroBadge = unreadable ? (
    <HoloBadge label={t('shell:common.offline')} tone="warn" variant="solid" />
  ) : loading ? (
    <HoloBadge label={t('common.readingBadge')} variant="solid" />
  ) : (
    <HoloBadge label={t('shell:common.liveData')} tone="good" variant="solid" pulse />
  );

  return (
    <HoloPageWindow
      exeTitle={t('universe.exeTitle')}
      icon="/icons/spare/stock-desk.png"
      banner={t('universe.banner')}
      current="/universe"
      live={!unreadable}
    >
      <HoloHero
        art="/icons/spare/stock-desk.png"
        kicker={t('universe.hero.kicker')}
        title={t('universe.hero.title')}
        size="md"
        description={t('universe.hero.description')}
        aside={heroBadge}
        seed={59}
      />

      {unreadable && (
        <HoloNotice
          tone="warn"
          title={t('universe.fallback.title')}
          action={
            <HoloButton size="sm" onClick={live.refetch}>
              {t('shell:common.retry')}
            </HoloButton>
          }
        >
          {t('universe.fallback.body')}
        </HoloNotice>
      )}

      <HoloCard title={t('universe.registry.title')} icon="/icons/spare/stock-desk.png" accent={heroBadge}>
        <div style={GRID}>
          <HoloStat label={t('universe.registry.active')} value={loading || unreadable ? DASH : String(active.length)} size="lg" tone="good" sub={t('universe.registry.activeSub')} />
          <HoloStat label={t('universe.registry.registered')} value={loading || unreadable ? DASH : String(rows.length)} size="lg" sub={t('universe.registry.registeredSub')} />
          <HoloStat label={t('universe.registry.market')} value={market.text} size="lg" tone={market.tone} sub={market.sub} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <HoloLabel>{t('universe.cols.mix')}</HoloLabel>
            <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 14, lineHeight: 1.3, color: INK.body }}>{live.mixText ?? DASH}</span>
            <span style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.35, color: INK.muted }}>{t('universe.registry.mixSub')}</span>
          </div>
        </div>
      </HoloCard>

      <HoloCard title={t('universe.stocks.title')} accent={rows.length ? `${rows.length}` : undefined} accentTone="ink" bar="lilac">
        {rows.length > 0 && (
          <AssetFilterBar query={query} onChange={setQuery} shown={shown.length} total={rows.length} sorts={['symbol', 'name', 'price', 'change']} />
        )}
        {isMobile ? (
          loading && rows.length === 0 ? (
            <MutedWell center>{t('universe.stocks.reading')}</MutedWell>
          ) : rows.length > 0 && shown.length === 0 ? (
            <NoAssetMatch query={query} onClear={clearFilters} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {paged.visible.map((r) => {
                const p = priceOf(r);
                const why = whyOf(r);
                return (
                  <HoloCard
                    key={r.token}
                    compact
                    flat
                    title={<AssetLabel symbol={r.symbol} kind={r.kind} size={13} />}
                    accent={<HoloBadge label={oracleView(r.status).label} tone={oracleTone(r.status)} variant="solid" />}
                    style={r.active ? undefined : { opacity: 0.8 }}
                  >
                    {r.name && <span style={{ fontFamily: FONT_TEXT, fontSize: 11, color: INK.muted }}>{r.name}</span>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between' }}>
                      <StatusCell r={r} why={why} />
                      <HoloStat
                        label={p.lastClose ? t('universe.stocks.lastClose') : t('universe.cols.price')}
                        value={p.text}
                        size="md"
                        sub={changeOf(r) ? `${changeText(changeOf(r))} · ${ago(r.lastUpdatedAt)}` : ago(r.lastUpdatedAt)}
                        align="right"
                      />
                    </div>
                    <HoloList>
                      <HoloListRow label={t('universe.cols.pool')} value={poolText(r.poolKey)} />
                      <HoloListRow label={t('universe.cols.mix')} value={r.defaultBps ? `${formatBps(r.defaultBps)}%` : DASH} />
                      <HoloListRow label={t('universe.cols.token')} value={<AddrLink address={r.token} />} right={<CopyAddress address={r.token} />} />
                    </HoloList>
                    <HoloButton size="sm" block onClick={() => setSelected(selected === r.token ? null : r.token)} aria-expanded={selected === r.token}>
                      {selected === r.token ? t('universe.stocks.hideDetails') : t('universe.stocks.details')}
                    </HoloButton>
                    {selected === r.token && <AssetDetails r={r} why={null} />}
                  </HoloCard>
                );
              })}
              <PagerRow hidden={paged.hidden} page={MOBILE_PAGE} expanded={paged.expanded} onMore={paged.more} onLess={paged.less} />
            </div>
          )
        ) : (
          <div className="su-board" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <style>{SELECTED_ROW_CSS}</style>
            {rows.length > 0 && shown.length === 0 ? (
              <NoAssetMatch query={query} onClear={clearFilters} />
            ) : (
              <HoloTable
                ariaLabel={t('universe.stocks.tableAria')}
                columns={columns(t, whyOf, changeOf)}
                rows={shown}
                rowKey={(r) => r.token}
                selectedKey={selected}
                onSelectRow={(r) => setSelected(selected === r.token ? null : r.token)}
                loading={loading && rows.length === 0}
                minWidth={1000}
                maxHeight={620}
                emptyMessage={t('universe.stocks.empty')}
              />
            )}
            {selectedRow ? (
              <HoloCard
                title={t('universe.stocks.detailsTitle', { symbol: selectedRow.symbol })}
                compact
                flat
                onClose={() => setSelected(null)}
                closeLabel={t('universe.stocks.closeDetails')}
              >
                <AssetDetails r={selectedRow} why={whyOf(selectedRow)} />
              </HoloCard>
            ) : (
              <Hint>{t('universe.stocks.selectHint')}</Hint>
            )}
          </div>
        )}
      </HoloCard>

      <HoloNotice tone="info" title={t('universe.about.title')}>
        {t('universe.about.body')}
      </HoloNotice>

      <CtaRow>
        <HoloLinkButton to="/" variant="primary" size="lg">
          {t('universe.cta.build')}
        </HoloLinkButton>
        <HoloLinkButton to="/datalayer" size="lg">
          {t('universe.cta.detail')}
        </HoloLinkButton>
      </CtaRow>
    </HoloPageWindow>
  );
}
