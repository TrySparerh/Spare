/**
 * HoloProgress — Win98 segmented progress bar with a holographic fill that
 * snaps to whole blocks. Indeterminate mode runs a block of segments across
 * (for "waiting for the chain" states).
 *
 *   <HoloProgress value={62} label="Weekly cap used" showValue />
 *   <HoloProgress indeterminate label="Confirming…" />
 */
import type { CSSProperties, ReactNode } from 'react';
import { FONT_PIXEL, FONT_TEXT, GRADIENT, HOLO, INK, type HoloTone } from './tokens';

export interface HoloProgressProps {
  /** 0..100. Ignored when indeterminate. */
  value?: number;
  /** Number of blocks. Default 20. */
  segments?: number;
  /** 'holo' (default) · good · warn · bad. */
  tone?: HoloTone;
  /** Bar height in px. Default 16. */
  height?: number;
  /** Label above the bar (left). */
  label?: ReactNode;
  /** Print the percentage (or pass a node to print instead) above the bar (right). */
  showValue?: boolean | ReactNode;
  indeterminate?: boolean;
  /** Deep-indigo track for use on screens. */
  onScreen?: boolean;
  /** Accessible name when there's no visible label. */
  ariaLabel?: string;
  style?: CSSProperties;
}

function fillFor(t: HoloTone): string {
  if (t === 'good') return GRADIENT.meterGood;
  if (t === 'warn') return GRADIENT.meterWarn;
  if (t === 'bad') return GRADIENT.meterBad;
  return GRADIENT.meter;
}

export function HoloProgress({
  value = 0,
  segments = 20,
  tone = 'holo',
  height = 16,
  label,
  showValue = false,
  indeterminate = false,
  onScreen = false,
  ariaLabel,
  style,
}: HoloProgressProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const filled = Math.round((pct / 100) * segments);
  const snapped = (filled / segments) * 100;
  const track = onScreen ? HOLO.screenDeep : HOLO.paper;
  // Gaps between blocks, drawn in the track colour over the continuous fill.
  const gaps = `repeating-linear-gradient(90deg, transparent 0, transparent calc(${100 / segments}% - 2px), ${track} calc(${100 / segments}% - 2px), ${track} ${100 / segments}%)`;
  const valueText = typeof showValue === 'boolean' ? `${Math.round(pct)}%` : showValue;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, ...style }}>
      {(label || showValue) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          {label ? (
            <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: INK.soft }}>{label}</span>
          ) : (
            <span />
          )}
          {showValue && !indeterminate && (
            <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 12, color: INK.body }}>{valueText}</span>
          )}
        </div>
      )}
      <div
        className={`holo-progress${onScreen ? ' holo-progress--screen' : ''}`}
        role="progressbar"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : Math.round(pct)}
        aria-busy={indeterminate || undefined}
        style={{ height }}
      >
        <div className="holo-progress__track" style={{ background: track }}>
          {indeterminate ? (
            <div className="holo-progress__runner" style={{ background: fillFor(tone), boxShadow: 'inset 0 1px 0 rgba(255,255,255,.7)' }} />
          ) : (
            <div
              className="holo-progress__fill"
              style={{
                width: `${snapped}%`,
                background: fillFor(tone),
                backgroundSize: `${snapped > 0 ? (100 / snapped) * 100 : 100}% 100%`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,.7), inset 0 -1px 0 rgba(42,27,110,.25)',
              }}
            />
          )}
          <div className="holo-progress__gaps" style={{ background: gaps }} />
        </div>
      </div>
    </div>
  );
}

export default HoloProgress;
