/**
 * AFTER HOURS — stock tokens trade around the clock on Robinhood Chain, but
 * Chainlink's stock prices follow the US-equities 24/5 session (Sunday 20:00
 * to Friday 20:00 ET). This desk puts the two side by side for every stock in
 * Spare's universe:
 *
 *   on-chain   what $100 of USDG buys right now through the Uniswap v4 pool
 *              Spare pins for that stock (V4Quoter, eth_call)
 *   Chainlink  the feed's price — the last close while the session is closed
 *   gap        on-chain vs Chainlink (premium / discount)
 *   depth      price impact from a $5 probe to $100 — a thin pool's gap is
 *              noise, not a signal
 *
 * Everything is read straight from Robinhood Chain; no wallet, no backend.
 * Anything the chain doesn't answer reads "—". This is information, not
 * advice, and Spare's own sweeps never buy while the session is closed.
 *
 * The tape covers every registered asset (quotes batched through Multicall3),
 * with search, a stocks / ETFs and active / standby filter, sorting (biggest
 * gap first by default) and a scrolling table.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { currentLang, getT, useTranslation } from '@/i18n';
import {
  equitySessionOpenedAt,
  fmtPct,
  fmtUsd,
  gapPct,
  nextSessionOpen,
  useStockBoard,
  useStockQuotes,
  type StockQuote,
  type StockRow,
} from '@/lib/stockBoard';
import {
  BEVEL_WELL,
  FONT_CHROME,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloNotice,
  HoloPanel,
  HoloProgress,
  HoloStat,
  HoloTable,
  HoloWindowBody,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';
import { Hint } from './spare/SpareUi';
import { HINT, ROW } from './spare/styles';
import { MarketBadge, STOCK_TOKEN_NOTE } from './markets';
import { AssetFilterBar, AssetSwatch, KindTag, NoAssetMatch, useAssetQuery } from './assetUi';
import { filterAssets, sortAssets, type AssetKind } from '@/lib/spare-chain/universe';

const tf = getT('apps-b');

/** Depth from the $5 → $100 price impact. `label` is translated; compare `level`. */
function depthOf(impactPct: number | null): { level: 'none' | 'deep' | 'ok' | 'thin'; label: string; tone: HoloTone } {
  if (impactPct == null) return { level: 'none', label: tf('afterHours.depth.noQuote'), tone: 'muted' };
  if (impactPct <= 0.3) return { level: 'deep', label: tf('afterHours.depth.deep'), tone: 'good' };
  if (impactPct <= 1.5) return { level: 'ok', label: tf('afterHours.depth.ok'), tone: 'warn' };
  return { level: 'thin', label: tf('afterHours.depth.thin'), tone: 'bad' };
}

type TapeRow = {
  [key: string]: unknown;
  token: string;
  symbol: string;
  name: string | null;
  kind: AssetKind;
  active: boolean;
  onchain: number | null;
  reference: number | null;
  referenceIsLive: boolean;
  gap: number | null;
  impact: number | null;
};

function toTapeRow(r: StockRow, q: StockQuote | undefined): TapeRow {
  const reference = r.lastPrice ?? r.price;
  const onchain = q?.fill ?? null;
  return {
    token: r.token,
    symbol: r.symbol,
    name: r.name,
    kind: r.kind,
    active: r.active,
    onchain,
    reference,
    referenceIsLive: r.priceIsLive,
    gap: gapPct(onchain, reference),
    impact: q?.impactPct ?? null,
  };
}

/* ─────────────────────────────── table cells ───────────────────────────────
 * The table is a pastel paper well, so cells use the fixed pastel inks.     */

const SYMBOL: CSSProperties = { fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13.5, color: HOLO.ink, letterSpacing: 0.5 };
const SUB: CSSProperties = {
  fontFamily: FONT_TEXT, fontSize: 10, color: HOLO.inkMuted, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

function StockCell({ r }: { r: TapeRow }) {
  const { t } = useTranslation('apps-b');
  return (
    <div title={r.name ?? r.symbol} style={{ lineHeight: 1.25, minWidth: 0 }}>
      <div style={{ ...SYMBOL, display: 'flex', alignItems: 'center', gap: 5 }}>
        <AssetSwatch symbol={r.symbol} size={9} />
        <span translate="no">{r.symbol}</span>
        <KindTag kind={r.kind} />
      </div>
      <div style={SUB}>{r.active ? t('afterHours.active') : t('afterHours.inactive')}</div>
    </div>
  );
}

function GapCell({ r, short }: { r: TapeRow; short: boolean }) {
  const { t } = useTranslation('apps-b');
  if (r.gap == null) return <span style={{ color: HOLO.inkMuted }}>—</span>;
  const up = r.gap >= 0;
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, color: up ? HOLO.goodInk : HOLO.badInk }}>{fmtPct(r.gap)}</div>
      <div style={SUB}>
        {short
          ? up
            ? t('afterHours.premium')
            : t('afterHours.discount')
          : up
          ? t('afterHours.onchainPremium')
          : t('afterHours.onchainDiscount')}
      </div>
    </div>
  );
}

function PriceStackCell({ r }: { r: TapeRow }) {
  const { t } = useTranslation('apps-b');
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ fontWeight: 700 }}>{fmtUsd(r.onchain)}</div>
      <div style={SUB}>
        {r.referenceIsLive ? t('afterHours.feedPrice', { price: fmtUsd(r.reference) }) : t('afterHours.closePrice', { price: fmtUsd(r.reference) })}
      </div>
    </div>
  );
}

function DepthCell({ r }: { r: TapeRow }) {
  const d = depthOf(r.impact);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
      <span style={{ fontWeight: 700 }}>{r.impact == null ? '—' : fmtPct(r.impact)}</span>
      <HoloBadge label={d.label} tone={d.tone} />
    </div>
  );
}

/** Diverging pixel bar: premium grows right in mint, discount grows left in pink, scaled to the widest gap. */
function GapBar({ value, max }: { value: number | null; max: number }) {
  const has = value != null && Number.isFinite(value);
  const w = has ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  const up = has && value >= 0;
  return (
    <div aria-hidden style={{ position: 'relative', height: 14, padding: 2, background: HOLO.paper, boxShadow: BEVEL_WELL }}>
      <div style={{ position: 'relative', height: '100%' }}>
        {has && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: up ? '50%' : undefined,
              right: up ? undefined : '50%',
              width: `${w}%`,
              background: up ? GRADIENT.meterGood : GRADIENT.meterBad,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.7), inset 0 -1px 0 rgba(42,27,110,.25)',
            }}
          />
        )}
        <div style={{ position: 'absolute', inset: 0, background: `repeating-linear-gradient(90deg, transparent 0 5px, ${HOLO.paper} 5px 6px)` }} />
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: 'calc(50% - 1px)', width: 2, background: HOLO.ink }} />
      </div>
    </div>
  );
}

function tapeColumns(maxAbs: number, mobile: boolean): HoloColumn<TapeRow>[] {
  const stock: HoloColumn<TapeRow> = { key: 'symbol', label: tf('afterHours.cols.stock'), width: mobile ? 84 : 108, render: (r) => <StockCell r={r} /> };
  const gap: HoloColumn<TapeRow> = { key: 'gap', label: tf('afterHours.cols.gap'), align: 'right', width: 'minmax(96px, 1.1fr)', render: (r) => <GapCell r={r} short={mobile} /> };
  const depth: HoloColumn<TapeRow> = { key: 'depth', label: tf('afterHours.cols.depth'), align: 'right', width: mobile ? 74 : 92, render: (r) => <DepthCell r={r} /> };
  if (mobile) {
    // Phone width: on-chain + Chainlink stack in one column so the board fits without sideways scroll.
    return [stock, { key: 'price', label: tf('afterHours.cols.onchain'), align: 'right', render: (r) => <PriceStackCell r={r} /> }, gap, depth];
  }
  return [
    stock,
    { key: 'onchain', label: tf('afterHours.cols.onchain'), align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{fmtUsd(r.onchain)}</span> },
    {
      key: 'reference',
      label: 'Chainlink',
      align: 'right',
      render: (r) => (
        <div style={{ lineHeight: 1.25 }}>
          <div style={{ color: HOLO.ink }}>{fmtUsd(r.reference)}</div>
          <div style={SUB}>{r.reference == null ? '' : r.referenceIsLive ? tf('afterHours.live') : tf('afterHours.lastClose')}</div>
        </div>
      ),
    },
    gap,
    { key: 'bar', label: tf('afterHours.cols.gap'), width: 104, render: (r) => <GapBar value={r.gap} max={maxAbs} /> },
    depth,
  ];
}

const STAT_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
  gap: 10,
};

/** Word placeholder for a stat with no number (mono, level with the lg numerals). */
function placeholderStyle(mobile: boolean): CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', verticalAlign: 'top', minHeight: mobile ? 29 : 36, fontSize: 15, letterSpacing: 0.5 };
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "Sun 20:00 ET" style label for a UTC second ("周日 20:00 (ET)" in Chinese). */
function etLabel(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const lang = currentLang();
  if (lang === 'en') {
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' ET';
  }
  // Weekday and time formatted apart, so Chinese gets "周日 20:00" (ICU runs them together).
  const day = d.toLocaleString(lang, { timeZone: 'America/New_York', weekday: 'short' });
  const time = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  return tf('afterHours.et', { time: `${day} ${time}` });
}

function hoursUntil(tsSec: number, nowMs: number): string {
  const h = Math.max(0, (tsSec * 1000 - nowMs) / 3_600_000);
  return h < 1 ? tf('afterHours.inM', { n: Math.max(1, Math.round(h * 60)) }) : tf('afterHours.inH', { n: Math.round(h) });
}

export function AfterHoursApp() {
  const { t } = useTranslation('apps-b');
  const mobile = useIsMobile();
  const now = useNow();
  const board = useStockBoard();
  const quotes = useStockQuotes(board.rows);

  const nowSec = Math.floor(now / 1000);
  const sessionOpen = equitySessionOpenedAt(nowSec) !== null;
  const opensAt = sessionOpen ? null : nextSessionOpen(nowSec);

  const rows = board.rows.map((r) => toTapeRow(r, quotes.quoteOf(r.token)));
  const [query, setQuery] = useAssetQuery('spare.afterHours.query', { sort: 'gap' });
  const shown = sortAssets(filterAssets(rows, query), query.sort, {
    price: (r) => r.onchain,
    gap: (r) => r.gap,
  });
  const gapped = rows.filter((r) => r.gap != null) as (TapeRow & { gap: number })[];
  const readable = gapped.filter((r) => r.active && depthOf(r.impact).level !== 'thin');
  const nPremium = gapped.filter((r) => r.gap >= 0).length;
  const nDiscount = gapped.length - nPremium;
  const widest = readable.reduce<(TapeRow & { gap: number }) | null>((a, r) => (!a || Math.abs(r.gap) > Math.abs(a.gap) ? r : a), null);
  const maxAbs = Math.max(1, ...gapped.map((r) => Math.abs(r.gap)));

  const loading = board.isLoading || (quotes.isLoading && gapped.length === 0);
  const offline = !!board.error && board.rows.length === 0;

  const sessionBadge = (
    <HoloBadge
      label={sessionOpen ? t('afterHours.session.open') : t('afterHours.session.closed')}
      tone={sessionOpen ? 'good' : 'info'}
      variant="solid"
      dot
      size="md"
      title={t('afterHours.session.title')}
    />
  );
  const sessionLine = sessionOpen
    ? t('afterHours.session.lineOpen')
    : opensAt
    ? t('afterHours.session.lineOpens', { when: etLabel(opensAt), in: hoursUntil(opensAt, now) })
    : t('afterHours.session.lineClosed');
  const sessionHint = sessionOpen ? t('afterHours.session.hintOpen') : t('afterHours.session.hintClosed');

  return (
    <HoloWindowBody>
      <HoloHero
        art="/icons/spare/after-hours.png"
        kicker={t('afterHours.hero.kicker')}
        title={t('shell:appNames.after-hours')}
        subtitle={t('afterHours.hero.subtitle')}
        description={t('afterHours.hero.description')}
        seed={37}
      >
        <div style={{ ...ROW, marginTop: 2 }}>
          {sessionBadge}
          <MarketBadge market={board.market} loading={board.isLoading} error={board.error} />
        </div>
      </HoloHero>

      <HoloCard title={t('afterHours.session.card')}>
        <div style={{ ...ROW, gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 22, lineHeight: 1.05, color: INK.body, letterSpacing: 0.3 }}>
              {sessionLine}
            </div>
            <span style={HINT}>{sessionHint}</span>
          </div>
          <HoloButton
            onClick={() => {
              board.refetch();
              quotes.refetch();
            }}
            disabled={quotes.isFetching}
          >
            {quotes.isFetching ? t('afterHours.quoting') : t('shared.refresh')}
          </HoloButton>
        </div>
        {loading && !offline && <HoloProgress indeterminate height={10} segments={24} ariaLabel={t('afterHours.quotingAria')} />}

        {gapped.length > 0 && (
          <div style={STAT_GRID}>
            <HoloPanel variant="sunken" padding="10px 12px">
              <HoloStat label={t('afterHours.stats.premium')} value={`${nPremium}/${gapped.length}`} size="lg" sub={t('afterHours.stats.premiumSub')} />
            </HoloPanel>
            <HoloPanel variant="sunken" padding="10px 12px">
              <HoloStat label={t('afterHours.stats.discount')} value={`${nDiscount}/${gapped.length}`} size="lg" sub={t('afterHours.stats.discountSub')} />
            </HoloPanel>
            <HoloPanel variant="sunken" padding="10px 12px">
              {widest ? (
                <HoloStat
                  label={t('afterHours.stats.widest')}
                  value={fmtPct(widest.gap)}
                  tone={widest.gap >= 0 ? 'good' : 'bad'}
                  size="lg"
                  sub={`${widest.symbol} · ${depthOf(widest.impact).label}`}
                />
              ) : (
                <HoloStat
                  label={t('afterHours.stats.widest')}
                  value={<span style={placeholderStyle(mobile)}>{t('afterHours.stats.none')}</span>}
                  tone="muted"
                  size="md"
                  sub={t('afterHours.stats.noneSub')}
                />
              )}
            </HoloPanel>
          </div>
        )}
      </HoloCard>

      {offline && (
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
          {t('afterHours.noTape')}
        </HoloNotice>
      )}

      {!offline && (
        <HoloCard
          title={t('afterHours.tape.title')}
          accent={board.rows.length ? t('afterHours.tape.accent', { count: rows.length }) : t('afterHours.tape.loading')}
          accentTone={board.rows.length ? 'info' : 'warn'}
        >
          {rows.length > 0 && (
            <AssetFilterBar query={query} onChange={setQuery} shown={shown.length} total={rows.length} sorts={['gap', 'symbol', 'name', 'price']} />
          )}
          {rows.length > 0 && shown.length === 0 ? (
            <NoAssetMatch query={query} onClear={() => setQuery({ search: '', kind: 'all', state: 'all' })} />
          ) : (
            <HoloTable<TapeRow>
              columns={tapeColumns(maxAbs, mobile)}
              rows={shown}
              rowKey={(r) => r.token}
              loading={board.rows.length === 0 && board.isLoading}
              emptyMessage={t('afterHours.tape.empty')}
              minWidth={mobile ? undefined : 640}
              maxHeight={mobile ? 520 : 480}
              ariaLabel={t('afterHours.tape.aria')}
            />
          )}
          {quotes.error && <Hint warn>{t('afterHours.tape.quotesFailed')}</Hint>}
          {!mobile && gapped.length > 0 && <span style={{ ...HINT, fontSize: 10.5 }}>{t('afterHours.tape.gapBar')}</span>}
        </HoloCard>
      )}

      <HoloCard title={t('afterHours.how.title')} bar="lilac" compact>
        <span style={HINT}>{t('afterHours.how.body')}</span>
        <Hint warn>{t('afterHours.how.warn')}</Hint>
        <Hint>{t(STOCK_TOKEN_NOTE)}</Hint>
      </HoloCard>
    </HoloWindowBody>
  );
}

export default AfterHoursApp;
