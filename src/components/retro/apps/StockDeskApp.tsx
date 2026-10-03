/**
 * STOCK DESK — the stock universe Spare can buy, as a live board.
 *
 * Every stock registered in Spare's AssetRegistry on Robinhood Chain, as a
 * poster-style ticker card: the price (Chainlink, guarded by StockRouter's
 * oracle check; the last close while the market is closed), the ~1 day move,
 * the oracle status, the pinned Uniswap v4 pool, its default-mix weight and
 * the token address. Active stocks can go straight into your mix; standby
 * ones say why, measured live through their pinned pool.
 *
 * However many assets the registry holds: search, filter (stocks / ETFs,
 * active / standby), sort, and a "show more" pager keep the board usable.
 *
 * Public on-chain data only — no wallet and no backend, so there is no
 * connect gate here, and anything the chain doesn't answer reads "—".
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useWindowManager } from '@/components/retro/WindowManager';
import { useTranslation } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';
import { SPARE } from '@/lib/spare-chain/addresses';
import {
  filterAssets,
  sortAssets,
  standbyReason,
  standbyText,
  useDayChanges,
  useStandbyMeasurements,
  type DayChange,
} from '@/lib/spare-chain/universe';
import { fmtAgo, fmtPct, fmtUsd, useStockBoard, type StockRow } from '@/lib/stockBoard';
import {
  FONT_TEXT,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloDivider,
  HoloHero,
  HoloLabel,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloProgress,
  HoloScreen,
  HoloSparkle,
  HoloStat,
  HoloWindowBody,
  type HoloTone,
} from '@/components/retro/holo';
import { AddrLink, Hint } from './spare/SpareUi';
import { ROW } from './spare/styles';
import { MarketBadge, STOCK_TOKEN_NOTE, TokenKey, poolLabel } from './markets';
import { AssetFilterBar, AssetSwatch, KindTag, NoAssetMatch, PagerRow, useAssetQuery, usePaged } from './assetUi';

const REFRESH_SEC = 60;
/** Cards per page before "show more". */
const PAGE = 12;
const PAGE_MOBILE = 6;

/** Ticker grid: 3 across at the default window size, 2 when narrower, 1 at phone width. */
const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(250px, 100%), 1fr))',
  gap: 12,
  alignItems: 'stretch',
};

/**
 * Placeholder for the price when there is no number. Mono (HoloStat md),
 * because the holo display face turns "—" into a fat bar; the min-height
 * matches the lg holo numeral so cards stay level.
 */
function noPriceStyle(mobile: boolean): CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', verticalAlign: 'top', minHeight: mobile ? 29 : 36, fontSize: 15, letterSpacing: 0.5 };
}

function oracleTone(t: 'up' | 'warn' | 'down' | 'muted'): HoloTone {
  return t === 'up' ? 'good' : t === 'down' ? 'bad' : t === 'warn' ? 'warn' : 'muted';
}

function TickerCard({
  row,
  mobile,
  change,
  measured,
  onAddToMix,
}: {
  row: StockRow;
  mobile: boolean;
  change: DayChange | undefined;
  /** $100 shortfall vs Chainlink through the pinned pool (standby rows), null = no quote. */
  measured: number | null | undefined;
  onAddToMix: () => void;
}) {
  const { t } = useTranslation('apps-b');
  const hasPrice = row.price != null;
  const priceSub = !hasPrice
    ? t('stockDesk.card.noFeedPrice')
    : row.priceIsLive
    ? t('stockDesk.card.livePrice', { ago: fmtAgo(row.lastUpdatedAt) })
    : t('stockDesk.card.lastClose', { ago: fmtAgo(row.lastUpdatedAt) });
  // standbyText is already in the live language (shell assets.standby.*).
  const inactiveWhy = standbyText(standbyReason(row, measured));

  return (
    <HoloCard
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <AssetSwatch symbol={row.symbol} size={11} />
          <span translate="no">{row.symbol}</span>
          <KindTag kind={row.kind} />
          {row.name && <span style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}> · {row.name}</span>}
        </span>
      }
      accent={row.active ? t('stockDesk.card.active') : t('stockDesk.card.inactive')}
      accentTone={row.active ? 'good' : 'muted'}
      bodyStyle={{ flex: 1 }}
      style={row.active ? undefined : { opacity: 0.78 }}
    >
      {hasPrice ? (
        <HoloStat label={t('stockDesk.card.price')} value={fmtUsd(row.price)} size="lg" sub={priceSub} />
      ) : (
        <HoloStat label={t('stockDesk.card.price')} value={<span style={noPriceStyle(mobile)}>{t('stockDesk.card.noPrice')}</span>} size="md" tone="muted" sub={priceSub} />
      )}

      <HoloScreen padding="6px 10px">
        <HoloList>
          <HoloListRow
            label={t('stockDesk.card.oracle')}
            value={<HoloBadge label={row.oracle.label} tone={oracleTone(row.oracle.tone)} />}
            hint={row.oracle.detail}
          />
          <HoloListRow
            label={t('stockDesk.card.change')}
            value={change ? <span style={{ fontWeight: 700 }}>{fmtPct(change.pct)}</span> : '—'}
            tone={change ? (change.pct >= 0 ? 'good' : 'bad') : undefined}
            hint={change ? t('shell:assets.change.span', { h: Math.round(change.spanSec / 3600) }) : undefined}
          />
          <HoloListRow label={t('stockDesk.card.pool')} value={<span style={{ fontSize: 11 }}>{poolLabel(row.poolKey)}</span>} />
          <HoloListRow label={t('stockDesk.card.defaultMix')} value={row.defaultBps ? `${(row.defaultBps / 100).toFixed(0)}%` : '—'} />
        </HoloList>
      </HoloScreen>

      {inactiveWhy && <Hint warn>{inactiveWhy}</Hint>}

      <div style={{ ...ROW, marginTop: 'auto', justifyContent: 'space-between' }}>
        <TokenKey token={row.token} symbol={row.symbol} />
        {row.active && (
          <HoloButton size="sm" onClick={onAddToMix} icon={<HoloSparkle size={11} glow={false} />}>
            {t('stockDesk.card.addToMix')}
          </HoloButton>
        )}
      </div>
    </HoloCard>
  );
}

/** Seconds since the last successful board refresh, as a pixel bar against the 60s cycle. */
function DataAge({ updatedAt }: { updatedAt: number | null }) {
  const { t } = useTranslation('apps-b');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!updatedAt) return <HoloProgress indeterminate onScreen height={10} label={t('stockDesk.age.firstLoad')} ariaLabel={t('stockDesk.age.loadingPrices')} />;
  const age = Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <HoloProgress
      value={Math.min(100, (age / REFRESH_SEC) * 100)}
      segments={12}
      height={12}
      onScreen
      label={t('stockDesk.age.label')}
      showValue={t('stockDesk.age.value', { age, max: REFRESH_SEC })}
    />
  );
}

function DeskFeedCard({ updatedAt, onRefresh }: { updatedAt: number | null; onRefresh: () => void }) {
  const { t } = useTranslation('apps-b');
  return (
    <HoloCard title={t('stockDesk.feed.title')} bar="ink" tone="screen" bodyStyle={{ flex: 1 }}>
      <HoloList>
        <HoloListRow label={t('stockDesk.feed.universe')} value={<AddrLink address={SPARE.AssetRegistry} />} hint="AssetRegistry" />
        <HoloListRow label={t('stockDesk.feed.prices')} value="Chainlink" hint={t('stockDesk.feed.viaGuard')} />
        <HoloListRow label={t('stockDesk.feed.refresh')} value={t('stockDesk.feed.every', { n: REFRESH_SEC })} />
        <HoloListRow label={t('stockDesk.feed.updated')} value={updatedAt ? new Date(updatedAt).toLocaleTimeString('en-US', { hour12: false }) : '—'} />
      </HoloList>
      <DataAge updatedAt={updatedAt} />
      <HoloButton block onClick={onRefresh} style={{ marginTop: 'auto' }}>
        {t('shared.refresh')}
      </HoloButton>
    </HoloCard>
  );
}

export function StockDeskApp() {
  const { t } = useTranslation('apps-b');
  const wm = useWindowManager();
  const mobile = useIsMobile();
  const board = useStockBoard();
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Stamp the board whenever a fresh read lands with prices in it.
  const priced = board.rows.filter((r) => r.price != null).length;
  const signature = board.rows.map((r) => `${r.symbol}:${r.price ?? ''}:${r.status ?? ''}`).join('|');
  useEffect(() => {
    if (board.rows.length > 0) setUpdatedAt(Date.now());
  }, [signature, board.rows.length]);

  const active = board.rows.filter((r) => r.active).length;

  const [query, setQuery] = useAssetQuery('spare.stockDesk.query');
  const { changes } = useDayChanges(board.rows.map((r) => r.feed));
  const changeOf = (r: StockRow) => (r.feed ? changes.get(r.feed.toLowerCase()) : undefined);
  const measured = useStandbyMeasurements(board.rows, (tok) => board.rows.find((r) => r.token.toLowerCase() === tok.toLowerCase())?.oracle1e18);
  const shown = sortAssets(filterAssets(board.rows, query), query.sort, { price: (r) => r.price, change: (r) => changeOf(r)?.pct });
  const page = mobile ? PAGE_MOBILE : PAGE;
  const paged = usePaged(shown, page, [query.search, query.kind, query.state, query.sort].join('|'));

  return (
    <HoloWindowBody>
      <HoloHero
        art="/icons/spare/stock-desk.png"
        kicker={t('stockDesk.hero.kicker')}
        title={t('shell:appNames.stock-desk')}
        subtitle={t('stockDesk.hero.subtitle')}
        description={t('stockDesk.hero.description')}
        seed={23}
      >
        <div style={{ ...ROW, marginTop: 2 }}>
          <MarketBadge market={board.market} loading={board.isLoading} error={board.error} />
          <HoloBadge label={board.rows.length ? t('stockDesk.badge', { active, total: board.rows.length }) : t('shell:common.onChain')} variant="solid" size="md" />
        </div>
      </HoloHero>

      {board.error && board.rows.length === 0 && (
        <HoloNotice
          tone="error"
          live="alert"
          title={t('shared.readUniverseFail')}
          action={
            <HoloButton size="sm" onClick={board.refetch}>
              {t('shell:common.retry')}
            </HoloButton>
          }
        >
          {t('stockDesk.noPrices')}
        </HoloNotice>
      )}

      <HoloDivider variant="checker" label={t('stockDesk.divider')} />

      {board.rows.length > 0 && (
        <AssetFilterBar
          query={query}
          onChange={setQuery}
          shown={shown.length}
          total={board.rows.length}
          sorts={['symbol', 'name', 'price', 'change']}
        />
      )}

      <div style={GRID}>
        {board.rows.length === 0 && !board.error ? (
          <HoloCard title={t('stockDesk.loading')} accent="…" accentTone="warn">
            <HoloProgress indeterminate height={10} segments={20} ariaLabel={t('stockDesk.readingAria')} />
            <span style={{ fontFamily: FONT_TEXT, fontSize: 11.5, color: INK.muted }}>{t('stockDesk.readingRegistry')}</span>
          </HoloCard>
        ) : board.rows.length > 0 && shown.length === 0 ? (
          <div style={{ gridColumn: '1 / -1' }}>
            <NoAssetMatch query={query} onClear={() => setQuery({ search: '', kind: 'all', state: 'all' })} />
          </div>
        ) : (
          paged.visible.map((r) => (
            <TickerCard
              key={r.token}
              row={r}
              mobile={mobile}
              change={changeOf(r)}
              measured={measured.has(r.token.toLowerCase()) ? measured.get(r.token.toLowerCase()) : undefined}
              onAddToMix={() => wm.openApp('stock-mix')}
            />
          ))
        )}
        <DeskFeedCard updatedAt={priced > 0 ? updatedAt : null} onRefresh={board.refetch} />
      </div>
      <PagerRow hidden={paged.hidden} page={page} expanded={paged.expanded} onMore={paged.more} onLess={paged.less} />

      <HoloCard title={t('stockDesk.aboutTokens')} bar="lilac" compact>
        <HoloLabel>{t('shared.readFirst')}</HoloLabel>
        <Hint>{t(STOCK_TOKEN_NOTE)}</Hint>
      </HoloCard>
    </HoloWindowBody>
  );
}

export default StockDeskApp;
