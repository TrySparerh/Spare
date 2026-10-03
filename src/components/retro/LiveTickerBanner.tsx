/**
 * LiveTickerBanner — the slim deep-indigo tape across the top of the desktop.
 *
 * The Spare stock tape: each active stock in the universe with its price, read
 * straight from Robinhood Chain (AssetRegistry + StockRouter + Chainlink, via
 * useStockBoard). However many assets the registry activates, they all ride
 * the loop (it slows with the count), each with its own colour dot. The chip on the left says LIVE while any stock's oracle is
 * OK and MARKET CLOSED when every feed is STALE (the US-equities 24/5 session
 * is closed and the tape shows last closes). Until the chain answers the
 * tape says so, and a stock with no price reads "—".
 */
import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { fmtUsd, useStockBoard, type MarketState, type StockRow } from '@/lib/stockBoard';
import { tKey, useTranslation } from '@/i18n';
import { assetColor } from '@/lib/spare-chain/universe';
import { FONT_PIXEL, FONT_TEXT, GRADIENT, HOLO, TEXTURE } from './holo/tokens';

/** `label` and `title` are shell i18n keys, translated at render. */
const CHIP: Record<MarketState | 'loading' | 'offline', { label: string; dot: string; title: string }> = {
  open: { label: tKey('common.liveData'), dot: HOLO.goodFill, title: tKey('ticker.title.open') },
  closed: {
    label: tKey('ticker.chip.marketClosed'),
    dot: HOLO.warnFill,
    title: tKey('ticker.title.closed'),
  },
  mixed: { label: tKey('common.liveData'), dot: HOLO.warnFill, title: tKey('ticker.title.mixed') },
  unknown: { label: tKey('ticker.chip.spare'), dot: HOLO.inkFaint, title: tKey('ticker.title.reading') },
  loading: { label: tKey('ticker.chip.spare'), dot: HOLO.inkFaint, title: tKey('ticker.title.reading') },
  offline: { label: tKey('common.offline'), dot: HOLO.badFill, title: tKey('ticker.title.offline') },
};

interface TapeItem {
  key: string;
  sym: string;
  price: string;
  tone: 'live' | 'close' | 'none';
  title: string;
}

function toItem(r: StockRow, t: TFunction): TapeItem {
  const tone: TapeItem['tone'] = r.price == null ? 'none' : r.priceIsLive ? 'live' : 'close';
  const priceKind = r.priceIsLive ? t('ticker.price.live') : r.price != null ? t('ticker.price.lastClose') : t('ticker.price.none');
  return {
    key: r.token,
    sym: r.symbol,
    price: fmtUsd(r.price),
    tone,
    title: `${r.symbol}${r.name ? ` · ${r.name}` : ''} · ${priceKind} · ${t('ticker.oracle', { status: r.oracle.label })}`,
  };
}

const ITEM: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  marginRight: 18,
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  fontSize: 12,
  lineHeight: 1,
};

export function LiveTickerBanner() {
  const { t } = useTranslation('shell');
  const board = useStockBoard();
  const active = board.rows.filter((r) => r.active);
  const state: keyof typeof CHIP = active.length
    ? board.market
    : board.error
    ? 'offline'
    : 'loading';
  const chip = { ...CHIP[state], label: t(CHIP[state].label), title: t(CHIP[state].title) };

  let items: TapeItem[] = active.map((r) => toItem(r, t));
  if (items.length === 0) {
    items = [
      {
        key: 'status',
        sym: 'SPARE',
        price: board.error ? t('ticker.pricesUnavailable') : t('ticker.readingPrices'),
        tone: 'none',
        title: chip.title,
      },
    ];
  }
  // One "set" must be at least as wide as a big screen so the loop never shows
  // a gap; the track holds two identical sets and scrolls by exactly one.
  const reps = Math.max(1, Math.ceil(12 / items.length));
  const set = Array.from({ length: reps }, () => items).flat();
  const cycleSec = Math.max(24, set.length * 3.2);

  return (
    <div
      data-live-ticker
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99, /* under the StartMenu (200) but above desktop icons */
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <div
          role="marquee"
          aria-label={t('ticker.aria', { label: chip.label, list: active.map((r) => `${r.symbol} ${fmtUsd(r.price)}`).join(', ') || chip.title })}
          style={{
            height: 28,
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen}`,
          }}
        >
          <div
            data-ticker-label
            title={chip.title}
            style={{
              background: GRADIENT.chrome,
              color: HOLO.ink,
              fontFamily: FONT_PIXEL,
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: 1.2,
              padding: '0 9px',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              zIndex: 2,
              whiteSpace: 'nowrap',
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, background: chip.dot, boxShadow: `0 0 0 1px ${HOLO.ink}` }} />
            {chip.label}
          </div>
          {/* Spacer outside the animated track so -50% lines up with the duplicate set. */}
          <div style={{ width: 14, height: '100%', flexShrink: 0 }} />
          <div
            aria-hidden
            className="spare-tape"
            style={{
              display: 'flex',
              animation: `win98-tick ${cycleSec}s linear infinite`,
              whiteSpace: 'nowrap',
              willChange: 'transform',
            }}
          >
            {[...set, ...set].map((it, i) => (
              <span key={`${it.key}-${i}`} style={ITEM} title={it.title}>
                {it.key !== 'status' && (
                  <span aria-hidden style={{ width: 7, height: 7, flexShrink: 0, background: assetColor(it.sym), boxShadow: `0 0 0 1px ${HOLO.screenLine}` }} />
                )}
                <span style={{ color: HOLO.lilac, letterSpacing: 1 }}>{it.sym}</span>
                <span style={{ color: it.tone === 'none' ? HOLO.onScreenSubtle : HOLO.onScreen }}>{it.price}</span>
                {it.tone === 'close' && (
                  <span style={{ fontFamily: FONT_PIXEL, fontSize: 9, letterSpacing: 1, color: HOLO.warnLit }}>{t('ticker.lastCloseTag')}</span>
                )}
                <span aria-hidden style={{ color: HOLO.screenLine }}>✦</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default LiveTickerBanner;
