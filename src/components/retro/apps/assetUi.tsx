/**
 * Shared pieces for every screen that lists the asset universe (Stock Mix,
 * Stock Desk, After Hours, Portfolio X-Ray, the /universe page): the
 * per-asset colour swatch, the ETF tag, the search / type / status / sort
 * bar, and a "show more" pager so a 50-asset list stays usable on a phone.
 *
 * The universe itself comes from the chain (lib/spare-chain/universe.ts);
 * nothing here knows a ticker. Text: shell `assets.*`.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  assetColor,
  DEFAULT_ASSET_QUERY,
  type AssetKind,
  type AssetQuery,
  type KindFilter,
  type SortKey,
  type StateFilter,
} from '@/lib/spare-chain/universe';
import { FONT_PIXEL, FONT_TEXT, HOLO, INK, HoloButton, HoloInput, HoloSegmented, HoloSelect } from '@/components/retro/holo';

/** A pastel square in the asset's own colour (deterministic from the ticker). */
export function AssetSwatch({ symbol, size = 12, style }: { symbol: string; size?: number; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flexShrink: 0,
        background: `linear-gradient(180deg, rgba(255,255,255,.65) 0 35%, transparent 35%), ${assetColor(symbol)}`,
        boxShadow: `0 0 0 1px ${HOLO.ink}, 2px 2px 0 0 rgba(42,27,110,.22)`,
        ...style,
      }}
    />
  );
}

/** "ETF" next to a fund's ticker; nothing for a single stock. */
export function KindTag({ kind }: { kind: AssetKind }) {
  const { t } = useTranslation('shell');
  if (kind !== 'etf') return null;
  return (
    <span
      title={t('assets.kind.etf')}
      style={{
        display: 'inline-block',
        padding: '0 4px',
        fontFamily: FONT_PIXEL,
        fontSize: 9,
        lineHeight: '14px',
        letterSpacing: 0.8,
        color: HOLO.ink,
        background: HOLO.sky,
        boxShadow: `inset 0 0 0 1px ${HOLO.inkFaint}`,
        verticalAlign: 'middle',
        whiteSpace: 'nowrap',
      }}
    >
      {t('assets.kind.etfTag')}
    </span>
  );
}

/** Ticker with its swatch and ETF tag; the name underneath when given. */
export function AssetLabel({ symbol, name, kind, size = 13, swatch = true }: { symbol: string; name?: string | null; kind?: AssetKind; size?: number; swatch?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, maxWidth: '100%' }} title={name ?? symbol}>
      {swatch && <AssetSwatch symbol={symbol} size={Math.round(size * 0.85)} />}
      <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <strong translate="no" style={{ fontFamily: FONT_TEXT, fontSize: size, color: INK.body, whiteSpace: 'nowrap' }}>
            {symbol}
          </strong>
          {kind && <KindTag kind={kind} />}
        </span>
        {name && (
          <span style={{ fontFamily: FONT_TEXT, fontSize: 10.5, color: INK.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
        )}
      </span>
    </span>
  );
}

/** Search / filter / sort state, remembered per viewer when `storageKey` is given. */
export function useAssetQuery(storageKey?: string, initial: Partial<AssetQuery> = {}) {
  const [q, setQ] = useState<AssetQuery>(() => {
    const base = { ...DEFAULT_ASSET_QUERY, ...initial };
    if (!storageKey) return base;
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as Partial<AssetQuery> | null;
      // The search box is not remembered: a stale search would hide assets on the next visit.
      return saved ? { ...base, kind: saved.kind ?? base.kind, state: saved.state ?? base.state, sort: saved.sort ?? base.sort } : base;
    } catch {
      return base;
    }
  });
  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ kind: q.kind, state: q.state, sort: q.sort }));
    } catch {
      /* storage blocked: the choice just isn't remembered */
    }
  }, [storageKey, q.kind, q.state, q.sort]);
  return [q, (patch: Partial<AssetQuery>) => setQ((prev) => ({ ...prev, ...patch }))] as const;
}

const BAR: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 };

/**
 * The asset list toolbar. `sorts` picks which sort keys to offer (price /
 * change only where the screen has them); `showState` adds Active / Standby.
 */
export function AssetFilterBar({
  query,
  onChange,
  shown,
  total,
  sorts = ['symbol', 'name'],
  showState = true,
  showKind = true,
  extra,
}: {
  query: AssetQuery;
  onChange: (patch: Partial<AssetQuery>) => void;
  shown: number;
  total: number;
  sorts?: readonly SortKey[];
  showState?: boolean;
  showKind?: boolean;
  extra?: ReactNode;
}) {
  const { t } = useTranslation('shell');
  const mobile = useIsMobile();
  const sortLabel: Record<SortKey, string> = {
    symbol: t('assets.filter.sort.symbol'),
    name: t('assets.filter.sort.name'),
    price: t('assets.filter.sort.price'),
    change: t('assets.filter.sort.change'),
    gap: t('assets.filter.sort.gap'),
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={BAR}>
        <HoloInput
          type="search"
          inputSize="sm"
          value={query.search}
          onChange={(e) => onChange({ search: e.target.value })}
          placeholder={t('assets.filter.search')}
          aria-label={t('assets.filter.searchAria')}
          fieldStyle={{ flex: mobile ? '1 1 100%' : '1 1 200px', minWidth: 0 }}
          suffix={
            query.search ? (
              <button
                type="button"
                onClick={() => onChange({ search: '' })}
                aria-label={t('assets.filter.clear')}
                style={{ border: 0, background: 'transparent', color: INK.muted, cursor: 'pointer', padding: 0, fontFamily: FONT_TEXT, fontSize: 13 }}
              >
                ×
              </button>
            ) : undefined
          }
        />
        {sorts.length > 1 && (
          <HoloSelect
            inputSize="sm"
            value={query.sort}
            aria-label={t('assets.filter.sortAria')}
            onChange={(e) => onChange({ sort: e.target.value as SortKey })}
            options={sorts.map((s) => ({ value: s, label: sortLabel[s] }))}
            fieldStyle={{ flex: mobile ? '1 1 140px' : '0 0 auto' }}
          />
        )}
        {extra}
      </div>
      {(showKind || showState) && (
        <div style={{ ...BAR, justifyContent: 'space-between' }}>
          <div style={BAR}>
            {showKind && (
              <HoloSegmented<KindFilter>
                size="sm"
                value={query.kind}
                onChange={(v) => onChange({ kind: v })}
                ariaLabel={t('assets.filter.kindAria')}
                options={[
                  { value: 'all', label: t('assets.filter.all') },
                  { value: 'stock', label: t('assets.filter.stocks') },
                  { value: 'etf', label: t('assets.filter.etfs') },
                ]}
              />
            )}
            {showState && (
              <HoloSegmented<StateFilter>
                size="sm"
                value={query.state}
                onChange={(v) => onChange({ state: v })}
                ariaLabel={t('assets.filter.stateAria')}
                options={[
                  { value: 'all', label: t('assets.filter.all') },
                  { value: 'active', label: t('assets.filter.active') },
                  { value: 'standby', label: t('assets.filter.standby') },
                ]}
              />
            )}
          </div>
          <span aria-live="polite" style={{ fontFamily: FONT_TEXT, fontSize: 11, color: INK.muted, whiteSpace: 'nowrap' }}>
            {t('assets.filter.showing', { shown, total })}
          </span>
        </div>
      )}
    </div>
  );
}

/** Shown when the filters leave nothing. */
export function NoAssetMatch({ query, onClear }: { query: AssetQuery; onClear: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <div className="holo-table__empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <span>{query.search.trim() ? t('assets.filter.none', { search: query.search.trim() }) : t('assets.filter.noneFiltered')}</span>
      <HoloButton size="sm" onClick={onClear}>
        {t('assets.filter.reset')}
      </HoloButton>
    </div>
  );
}

/**
 * First `page` items, growing by `page` per "show more"; resets when `resetKey`
 * changes (a new search or filter starts from the top again).
 */
export function usePaged<T>(list: readonly T[], page: number, resetKey: string) {
  const [n, setN] = useState(page);
  useEffect(() => setN(page), [resetKey, page]);
  const visible = list.slice(0, n);
  return { visible, hidden: Math.max(0, list.length - n), more: () => setN((x) => x + page), less: () => setN(page), expanded: n > page };
}

/** The "show N more / show fewer" row under a paged list. */
export function PagerRow({ hidden, page, expanded, onMore, onLess }: { hidden: number; page: number; expanded: boolean; onMore: () => void; onLess: () => void }) {
  const { t } = useTranslation('shell');
  if (hidden === 0 && !expanded) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
      {hidden > 0 && (
        <HoloButton size="sm" onClick={onMore}>
          {t('assets.filter.more', { n: Math.min(page, hidden) })}
        </HoloButton>
      )}
      {expanded && (
        <HoloButton size="sm" variant="ghost" onClick={onLess}>
          {t('assets.filter.less')}
        </HoloButton>
      )}
    </div>
  );
}
