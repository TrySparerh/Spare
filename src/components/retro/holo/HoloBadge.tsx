/**
 * HoloBadge — a status tag (● CONFIRMED, READ-ONLY, DEPLOYING).
 * HoloChip  — a pill you can click / select / remove (SPY, NVDA, $5, ROUND UP).
 */
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { GlyphClose } from './HoloGlyphs';
import { HOLO, holoFill, holoInk, type HoloTone } from './tokens';

/* ─────────────────────────────── badge ─────────────────────────────── */

export interface HoloBadgeProps {
  label: ReactNode;
  /** Colour meaning. Default 'info'. */
  tone?: HoloTone;
  /**
   * 'soft'  — pastel chip, indigo text, coloured pixel dot (default; for pastel surfaces)
   * 'solid' — deep-indigo chip with cream pixel caps ("ROUND UP" tags; reads anywhere)
   * 'fill'  — tone-coloured chip with indigo text (loud; e.g. accent in a card bar)
   */
  variant?: 'soft' | 'solid' | 'fill';
  /** Leading pixel dot. Default true for soft, false otherwise. */
  dot?: boolean;
  /** Blink the dot (live / pending). */
  pulse?: boolean;
  size?: 'sm' | 'md';
  title?: string;
  style?: CSSProperties;
}

const SOFT_BG: Record<HoloTone, string> = {
  holo: 'linear-gradient(135deg, #FFF6DF 0%, #FFD0EA 40%, #DCCBFF 75%, #BDE6FF 100%)',
  ink: '#EFE8FF',
  good: '#E3FBF1',
  warn: '#FFF1DC',
  bad: '#FFE6EE',
  info: '#EFE8FF',
  muted: '#F4F0FF',
};

export function HoloBadge({ label, tone = 'info', variant = 'soft', dot, pulse = false, size = 'sm', title, style }: HoloBadgeProps) {
  const showDot = dot ?? variant === 'soft';
  const h = size === 'sm' ? 20 : 24;
  const fs = size === 'sm' ? 10 : 11.5;
  let bg: string;
  let fg: string;
  let edge: string;
  if (variant === 'solid') {
    bg = HOLO.ink;
    fg = HOLO.onScreen;
    edge = `inset 0 0 0 1px ${HOLO.ink}, inset 0 -2px 0 0 rgba(0,0,0,.25)`;
  } else if (variant === 'fill') {
    bg = tone === 'holo' ? SOFT_BG.holo : holoFill(tone);
    fg = HOLO.ink;
    edge = `inset 0 0 0 1px ${HOLO.ink}`;
  } else {
    bg = SOFT_BG[tone];
    fg = holoInk(tone);
    edge = `inset 0 0 0 1px ${tone === 'muted' ? HOLO.bevelLo : 'rgba(42,27,110,.55)'}`;
  }
  const dotColor = variant === 'solid' ? (tone === 'ink' || tone === 'info' ? HOLO.lilac : holoFill(tone)) : holoFill(tone === 'info' ? 'ink' : tone);
  return (
    <span
      className="holo-chip"
      title={title}
      style={{
        height: h,
        fontSize: fs,
        background: bg,
        color: fg,
        boxShadow: edge,
        ...style,
      }}
    >
      {showDot && (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            flexShrink: 0,
            background: dotColor,
            boxShadow: `0 0 0 1px ${variant === 'solid' ? 'rgba(255,255,255,.35)' : HOLO.ink}`,
            animation: pulse ? 'win98-pulse 1.1s steps(2, end) infinite' : undefined,
          }}
        />
      )}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </span>
  );
}

/* ─────────────────────────────── chip ─────────────────────────────── */

export interface HoloChipProps {
  children: ReactNode;
  /** Selected chips flip to the deep-indigo tag look. */
  selected?: boolean;
  onClick?: () => void;
  /** Shows a pixel × that calls this (the chip itself stays clickable if onClick is set). */
  onRemove?: () => void;
  /** Accessible name of the ×. Default: "Remove" in the active language. */
  removeLabel?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Leading icon / glyph. */
  icon?: ReactNode;
  title?: string;
  style?: CSSProperties;
}

export function HoloChip({ children, selected = false, onClick, onRemove, removeLabel, disabled, size = 'md', icon, title, style }: HoloChipProps) {
  const { t } = useTranslation('shell');
  const removeName = removeLabel ?? t('holo.remove');
  const h = size === 'sm' ? 22 : 28;
  const look: CSSProperties = selected
    ? { background: HOLO.ink, color: HOLO.onScreen, boxShadow: `inset 0 0 0 1px ${HOLO.ink}, 2px 2px 0 0 rgba(42,27,110,.25)` }
    : { background: 'linear-gradient(180deg, #FFFFFF 0%, #F1EAFF 100%)', color: HOLO.ink, boxShadow: `inset 0 0 0 1px ${HOLO.ink}, 2px 2px 0 0 rgba(42,27,110,.18)` };
  const base: CSSProperties = { height: h, fontSize: size === 'sm' ? 10 : 11.5, padding: size === 'sm' ? '0 7px' : '0 10px', ...look, ...style };
  const remove = onRemove && (
    <button
      type="button"
      aria-label={removeName}
      title={removeName}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      style={{ display: 'inline-flex', padding: 3, margin: '0 -4px 0 0', border: 0, background: 'none', cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <GlyphClose color={selected ? HOLO.onScreen : HOLO.ink} />
    </button>
  );
  // Clickable chip without a remove box: the chip itself is the button.
  if (onClick && !onRemove) {
    return (
      <button type="button" className="holo-chip" aria-pressed={selected} onClick={onClick} disabled={disabled} title={title} style={base}>
        {icon}
        <span>{children}</span>
      </button>
    );
  }
  // Otherwise a tag; with both actions the label and the × are sibling buttons (no nesting).
  return (
    <span className="holo-chip" title={title} style={{ ...base, opacity: disabled ? 0.5 : 1 }}>
      {icon}
      {onClick ? (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onClick}
          disabled={disabled}
          style={{ all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          {children}
        </button>
      ) : (
        <span>{children}</span>
      )}
      {remove}
    </span>
  );
}
