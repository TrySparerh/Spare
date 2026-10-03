/**
 * HoloCard — a small Win98-style dialog card: a 2px indigo frame with a white
 * inner keyline, a pastel mini title bar, a pastel body with a dither drift in
 * the corner, and an optional footer row of buttons.
 *
 * The bar's right corner holds a real [×] button only when `onClose` is passed.
 * Otherwise it carries a small outlined sparkle, an ornament that can't be
 * mistaken for a control.
 *
 *   <HoloCard title="Round-up rule" accent="$5 · 2×">…</HoloCard>
 *   <HoloCard title="Readiness" tone="screen">…dense data on deep indigo…</HoloCard>
 */
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { HoloBadge } from './HoloBadge';
import { GlyphClose } from './HoloGlyphs';
import { GRADIENT, HOLO, INK_ON_LIGHT, INK_ON_SCREEN, SPARKLE_PATH, TEXTURE, type HoloTone } from './tokens';

export interface HoloCardProps {
  /** Text in the mini title bar. Omit for a bare bar. */
  title?: ReactNode;
  /** Small icon before the title: an image src or any node. */
  icon?: string | ReactNode;
  /** Right-side status tag in the bar (string renders as a HoloBadge). */
  accent?: ReactNode;
  accentTone?: HoloTone;
  /** Renders a real [×] close button in the bar. Without it the corner shows a decorative sparkle. */
  onClose?: () => void;
  /** Accessible name of the [×]. Default: "Close" in the active language. */
  closeLabel?: string;
  /** Show the corner piece at all (the [×] with `onClose`, the sparkle without). Default true. */
  closeBox?: boolean;
  /** Bar gradient. 'holo' pink→peach→sky→periwinkle (default) · 'lilac' · 'pink' · 'ink' (dark, white title). */
  bar?: 'holo' | 'lilac' | 'pink' | 'ink';
  /** Body: pastel 'light' (default) or deep-indigo 'screen' for dense data. */
  tone?: 'light' | 'screen';
  /** Tighter padding. */
  compact?: boolean;
  /** Drop the hard pixel shadow (for cards nested in cards). */
  flat?: boolean;
  /** Buttons row under the body, right-aligned. */
  footer?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  /** Landmark label when there's no visible title. */
  'aria-label'?: string;
}

const BAR: Record<NonNullable<HoloCardProps['bar']>, string> = {
  holo: GRADIENT.cardBar,
  lilac: GRADIENT.cardBarLilac,
  pink: GRADIENT.cardBarPink,
  ink: GRADIENT.cardBarInk,
};

export function HoloCard({
  title,
  icon,
  accent,
  accentTone = 'info',
  onClose,
  closeLabel,
  closeBox = true,
  bar = 'holo',
  tone = 'light',
  compact = false,
  flat = false,
  footer,
  children,
  style,
  bodyStyle,
  'aria-label': ariaLabel,
}: HoloCardProps) {
  const { t } = useTranslation('shell');
  const closeName = closeLabel ?? t('common.close');
  const screen = tone === 'screen';

  const inkBar = bar === 'ink';
  const cls = ['holo-card', compact ? 'holo-card--compact' : '', flat ? 'holo-card--flat' : '', screen ? 'holo-card--screen' : ''].filter(Boolean).join(' ');

  return (
    <section
      className={cls}
      aria-label={ariaLabel}
      style={{
        ...(screen ? { background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen}` } : null),
        ...style,
      }}
    >
      <div
        className="holo-card__bar"
        style={{
          background: `${inkBar ? TEXTURE.ditherLight : TEXTURE.dither} right center / 4px 4px, ${BAR[bar]}`,
          color: inkBar ? '#FFFFFF' : HOLO.ink,
          textShadow: inkBar ? '1px 1px 0 #2A1B6E' : undefined,
        }}
      >
        {icon &&
          (typeof icon === 'string' ? (
            <img src={icon} alt="" width={16} height={16} style={{ imageRendering: 'pixelated', objectFit: 'contain', flexShrink: 0 }} draggable={false} />
          ) : (
            <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
          ))}
        {title ? <span className="holo-card__title">{title}</span> : <span style={{ flex: 1 }} />}
        {title && <span style={{ flex: 1 }} />}
        {accent != null && accent !== false &&
          (typeof accent === 'string' || typeof accent === 'number' ? (
            <HoloBadge label={accent} tone={accentTone} variant={inkBar ? 'fill' : 'solid'} dot={accentTone !== 'info' && accentTone !== 'ink'} />
          ) : (
            accent
          ))}
        {closeBox &&
          (onClose ? (
            <button type="button" className="holo-card__close" onClick={onClose} aria-label={closeName} title={closeName}>
              <GlyphClose />
            </button>
          ) : (
            <CardOrnament />
          ))}
      </div>
      <div className="holo-card__body" style={{ ...(screen ? INK_ON_SCREEN : INK_ON_LIGHT), ...bodyStyle }}>
        {children}
      </div>
      {footer && <div className="holo-card__footer">{footer}</div>}
    </section>
  );
}

/** Decorative corner sparkle: white with an indigo pixel keyline, readable on every bar. */
function CardOrnament() {
  return (
    <svg className="holo-card__ornament" aria-hidden focusable="false" width={13} height={13} viewBox="-2 -2 28 28">
      <path d={SPARKLE_PATH} fill="#FFFFFF" stroke={HOLO.ink} strokeWidth={2.4} strokeLinejoin="round" paintOrder="stroke" />
      <circle cx="12" cy="12" r="2.2" fill={HOLO.pink} />
    </svg>
  );
}

export default HoloCard;
