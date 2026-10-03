/**
 * Tabular data.
 *
 *   <HoloTable columns={cols} rows={rows} rowKey={(r) => r.hash} />       — Win98 list view, pastel
 *   <HoloList><HoloListRow label="Round to" value="$5" /></HoloList>        — key / value rows
 *
 * It scrolls horizontally inside its well on narrow windows (set minWidth).
 *
 * Row actions stay reachable while it scrolls: the trailing column is pinned to
 * the right edge of the well when it is the row-action column — an empty
 * header or the key "action(s)" — or when it sets `pin: 'right'` (`pin: false`
 * opts out). On a wide window nothing moves; on a phone the buttons stay on
 * screen instead of behind a sideways scroll.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { FONT_CHROME, FONT_TEXT, INK, inkFor, type HoloTone } from './tokens';

export interface HoloColumn<Row> {
  key: string;
  label: ReactNode;
  /** px number or any CSS grid track ('1fr', 'minmax(0, 2fr)'). Default minmax(0, 1fr). */
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  render?: (row: Row) => ReactNode;
  /** Allow the cell to wrap instead of ellipsis. */
  wrap?: boolean;
  /**
   * Keep this (trailing) column pinned to the right edge while the table
   * scrolls sideways. Default: on for a trailing row-action column (empty
   * header, or key "action" / "actions"); pass false to opt out.
   */
  pin?: 'right' | false;
}

/** Index of the trailing column to pin right, or -1. */
function pinnedIndex<Row>(columns: HoloColumn<Row>[]): number {
  if (columns.length < 2) return -1;
  const i = columns.length - 1;
  const c = columns[i];
  if (c.pin === 'right') return i;
  if (c.pin === false) return -1;
  return c.label === '' || /^actions?$/i.test(c.key) ? i : -1;
}

export interface HoloTableProps<Row> {
  columns: HoloColumn<Row>[];
  rows: Row[];
  rowKey: (r: Row) => string | number;
  selectedKey?: string | number | null;
  onSelectRow?: (r: Row) => void;
  /** Shown when there are no rows. Default: "Nothing here yet." in the active language. */
  emptyMessage?: ReactNode;
  loading?: boolean;
  /** Tighter rows. */
  dense?: boolean;
  /** Minimum grid width before the well scrolls sideways (px). */
  minWidth?: number;
  /** Cap the height; the body scrolls with a sticky header. */
  maxHeight?: number | string;
  style?: CSSProperties;
  /** Accessible name. */
  ariaLabel?: string;
}

export function HoloTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  selectedKey = null,
  onSelectRow,
  emptyMessage,
  loading = false,
  dense = false,
  minWidth,
  maxHeight,
  style,
  ariaLabel,
}: HoloTableProps<Row>) {
  const { t } = useTranslation('shell');
  const template = columns.map((c) => (typeof c.width === 'number' ? `${c.width}px` : c.width ?? 'minmax(0, 1fr)')).join(' ');
  const pin = pinnedIndex(columns);
  return (
    <div className={`holo-table${dense ? ' holo-table--dense' : ''}`} style={{ maxHeight, ...style }} data-holo-scroll>
      <div className="holo-table__grid" role="table" aria-label={ariaLabel} style={{ minWidth }}>
        <div className="holo-table__head" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((c, i) => (
            <div key={c.key} role="columnheader" className={`holo-table__th${i === pin ? ' holo-table__pin' : ''}`} style={{ textAlign: c.align ?? 'left' }}>
              {c.label}
            </div>
          ))}
        </div>
        {loading || rows.length === 0 ? (
          <div role="row">
            <div role="cell" className="holo-table__empty">{loading ? t('common.loading') : emptyMessage ?? t('holo.tableEmpty')}</div>
          </div>
        ) : (
          rows.map((row) => {
            const k = rowKey(row);
            const sel = selectedKey !== null && selectedKey === k;
            const cls = ['holo-table__row', onSelectRow ? 'holo-table__row--click' : '', sel ? 'holo-table__row--selected' : ''].filter(Boolean).join(' ');
            return (
              <div
                key={k}
                role="row"
                aria-selected={onSelectRow ? sel : undefined}
                tabIndex={onSelectRow ? 0 : undefined}
                className={cls}
                style={{ gridTemplateColumns: template }}
                onClick={onSelectRow ? () => onSelectRow(row) : undefined}
                onKeyDown={
                  onSelectRow
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectRow(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c, i) => (
                  <div
                    key={c.key}
                    role="cell"
                    className={`holo-table__td${i === pin ? ' holo-table__pin' : ''}`}
                    style={{ textAlign: c.align ?? 'left', whiteSpace: c.wrap ? 'normal' : undefined }}
                  >
                    {c.render ? c.render(row) : String(row[c.key] ?? '')}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────── list ─────────────────────────────── */

export function HoloList({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="holo-list" role="list" style={style}>
      {children}
    </div>
  );
}

export interface HoloListRowProps {
  label: ReactNode;
  value?: ReactNode;
  /** Small line under the label. */
  hint?: ReactNode;
  /** Colours the value. */
  tone?: HoloTone;
  /** Leading icon / glyph. */
  icon?: ReactNode;
  /** Extra content after the value (a button, a badge). */
  right?: ReactNode;
  /** Makes the whole row a button. */
  onClick?: () => void;
  style?: CSSProperties;
}

export function HoloListRow({ label, value, hint, tone = 'ink', icon, right, onClick, style }: HoloListRowProps) {
  const inner = (
    <>
      {icon && <span aria-hidden style={{ display: 'inline-flex', alignSelf: 'center', flexShrink: 0 }}>{icon}</span>}
      <span className="holo-list__label">
        <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 17, color: INK.soft, lineHeight: 1.1 }}>{label}</span>
        {hint && <span style={{ display: 'block', fontFamily: FONT_TEXT, fontSize: 11, color: INK.muted, lineHeight: 1.45, marginTop: 2 }}>{hint}</span>}
      </span>
      {value != null && value !== false && (
        <span className="holo-list__value" style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13.5, color: inkFor(tone) }}>
          {value}
        </span>
      )}
      {right && <span style={{ flexShrink: 0, alignSelf: 'center' }}>{right}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" role="listitem" className="holo-list__row" onClick={onClick} style={style}>
        {inner}
      </button>
    );
  }
  return (
    <div role="listitem" className="holo-list__row" style={style}>
      {inner}
    </div>
  );
}
