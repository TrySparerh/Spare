/**
 * Type atoms.
 *
 *   <HoloLabel>Round up to</HoloLabel>            pixel caps eyebrow / field label
 *   <HoloText tone="muted" size="sm">…</HoloText>  poster body mono
 *   <HoloDivider />  <HoloDivider variant="checker" />
 *
 * All colours come from INK.*, so they read on pastel surfaces and screens alike.
 */
import type { CSSProperties, ElementType, ReactNode } from 'react';
import { FONT_CHROME, FONT_PIXEL, FONT_TEXT, HOLO, INK, TEXTURE, inkFor, type HoloTone } from './tokens';

export interface HoloLabelProps {
  children: ReactNode;
  /** 'pixel' Silkscreen caps (default) · 'chrome' Jersey 10 (sentence case, e.g. "Round-up rule"). */
  font?: 'pixel' | 'chrome';
  tone?: HoloTone;
  as?: ElementType;
  htmlFor?: string;
  style?: CSSProperties;
}

export function HoloLabel({ children, font = 'pixel', tone, as: Tag = 'span', htmlFor, style }: HoloLabelProps) {
  const pixel = font === 'pixel';
  return (
    <Tag
      htmlFor={htmlFor}
      style={{
        fontFamily: pixel ? FONT_PIXEL : FONT_CHROME,
        fontWeight: 400,
        fontSize: pixel ? 10.5 : 17,
        letterSpacing: pixel ? 1 : 0.2,
        textTransform: pixel ? 'uppercase' : undefined,
        lineHeight: pixel ? 1.25 : 1.1,
        color: tone ? inkFor(tone) : INK.soft,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

export interface HoloTextProps {
  children: ReactNode;
  tone?: HoloTone;
  /** xs 10.5 · sm 11.5 · md 12.5 (default) · lg 15 */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  bold?: boolean;
  as?: ElementType;
  style?: CSSProperties;
}

const TEXT_SIZE = { xs: 10.5, sm: 11.5, md: 12.5, lg: 15 } as const;

export function HoloText({ children, tone = 'ink', size = 'md', bold = false, as: Tag = 'p', style }: HoloTextProps) {
  return (
    <Tag
      style={{
        margin: 0,
        fontFamily: FONT_TEXT,
        fontSize: TEXT_SIZE[size],
        fontWeight: bold ? 700 : 400,
        lineHeight: 1.55,
        color: inkFor(tone),
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

export interface HoloDividerProps {
  /** 'dashed' pixel rule (default) · 'etched' Win98 groove · 'checker' indigo/white band (poster strip). */
  variant?: 'dashed' | 'etched' | 'checker';
  /** Optional caption centred on the rule. */
  label?: ReactNode;
  style?: CSSProperties;
}

export function HoloDivider({ variant = 'dashed', label, style }: HoloDividerProps) {
  const rule: CSSProperties =
    variant === 'checker'
      ? { height: 6, background: `${TEXTURE.checker} 0 0 / 6px 6px`, opacity: 0.85 }
      : variant === 'etched'
      ? { height: 2, background: HOLO.bevelLo, boxShadow: '0 1px 0 0 #FFFFFF' }
      : { height: 1, backgroundImage: `linear-gradient(90deg, ${HOLO.inkFaint} 50%, transparent 50%)`, backgroundSize: '4px 1px' };
  if (!label) return <div role="separator" style={{ ...rule, flexShrink: 0, ...style }} />;
  return (
    <div role="separator" style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
      <div style={{ ...rule, flex: 1 }} />
      <HoloLabel>{label}</HoloLabel>
      <div style={{ ...rule, flex: 1 }} />
    </div>
  );
}
