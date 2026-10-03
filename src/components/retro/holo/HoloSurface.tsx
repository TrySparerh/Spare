/**
 * Surfaces.
 *
 *   <HoloWindowBody>  the pastel canvas an app paints edge to edge inside its window
 *   <HoloPanel>       a plain block: raised / sunken / glass / flat, light or screen
 *   <HoloScreen>      a deep-indigo "monitor" well for dense data
 *
 * Every surface sets the ink context (INK_ON_LIGHT / INK_ON_SCREEN) so INK.* text
 * and the Spare kit atoms read correctly on it.
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  BEVEL_RAISED,
  BEVEL_WELL,
  GRADIENT,
  HOLO,
  INK_ON_LIGHT,
  INK_ON_SCREEN,
  TEXTURE,
  sparkleUrl,
} from './tokens';

/* ───────────────────────────── window body ───────────────────────────── */

export interface HoloWindowBodyProps {
  children: ReactNode;
  /** Two faint sparkles pinned in the top-right corner + the halftone horizon. Default true. */
  sparkles?: boolean;
  /** Content padding in px (default 14, 10 on mobile via CSS). */
  padding?: number;
  /** Gap between stacked children. Default 12. */
  gap?: number;
  style?: CSSProperties;
}

/** The app canvas. Use once, as the root of an app window's content. */
export function HoloWindowBody({ children, sparkles = true, padding, gap, style }: HoloWindowBodyProps) {
  const layers = [
    sparkles ? `${sparkleUrl()} right 22px top 14px / 14px 14px no-repeat` : null,
    sparkles ? `${sparkleUrl('#FFFFFF', '#FFB8E0')} right 46px top 34px / 8px 8px no-repeat` : null,
    `${TEXTURE.dither} 0 0 / 4px 4px repeat`,
    GRADIENT.canvas,
  ].filter(Boolean);
  return (
    <div
      className="holo-canvas"
      style={{
        background: layers.join(', '),
        ...INK_ON_LIGHT,
        padding,
        gap,
        ...style,
      }}
    >
      {/* pixel horizon: halftone drifting up from the bottom edge (behind content) */}
      <div aria-hidden className="holo-canvas__horizon" />
      {children}
    </div>
  );
}

/* ─────────────────────────────── panel ─────────────────────────────── */

export interface HoloPanelProps {
  children: ReactNode;
  /** raised (bevel out) · sunken (bevel in) · glass (frosted card on busy art) · flat (keyline only). Default 'raised'. */
  variant?: 'raised' | 'sunken' | 'glass' | 'flat';
  /** 'light' pastel (default) or 'screen' deep indigo. */
  tone?: 'light' | 'screen';
  /** Overlay texture. Default 'dither'. */
  texture?: 'dither' | 'halftone' | 'grid' | 'none';
  /** Padding in px or CSS. Default 12. */
  padding?: number | string;
  /** Stack children in a column with this gap. */
  gap?: number;
  style?: CSSProperties;
  className?: string;
  /** Pass-through for data-* hooks / aria. */
  role?: string;
  'aria-label'?: string;
}

export function HoloPanel({
  children,
  variant = 'raised',
  tone = 'light',
  texture = 'dither',
  padding = 12,
  gap,
  style,
  className,
  role,
  'aria-label': ariaLabel,
}: HoloPanelProps) {
  const screen = tone === 'screen';
  const tex =
    texture === 'none'
      ? null
      : texture === 'halftone'
      ? `${TEXTURE.halftone} 0 0 / ${TEXTURE.halftoneSize}`
      : texture === 'grid'
      ? TEXTURE.gridLayers
      : `${screen ? TEXTURE.ditherLight : TEXTURE.dither} 0 0 / 4px 4px`;

  let base: string;
  let shadow: string | undefined;
  let extra: CSSProperties = {};
  if (screen) {
    base = GRADIENT.screen;
    shadow = variant === 'raised' ? `0 0 0 1px ${HOLO.ink}, ${BEVEL_RAISED}` : BEVEL_WELL;
  } else if (variant === 'sunken') {
    base = HOLO.paper;
    shadow = BEVEL_WELL;
  } else if (variant === 'glass') {
    base = 'rgba(255,255,255,.72)';
    shadow = `0 0 0 2px ${HOLO.ink}, inset 0 0 0 1px #FFFFFF, 4px 4px 0 0 rgba(42,27,110,.2)`;
    extra = { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' };
  } else if (variant === 'flat') {
    base = GRADIENT.card;
    shadow = `inset 0 0 0 1px ${HOLO.bevelLo}`;
  } else {
    base = GRADIENT.face;
    shadow = BEVEL_RAISED;
  }

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={className}
      style={{
        position: 'relative',
        background: tex ? `${tex}, ${base}` : base,
        boxShadow: shadow,
        padding,
        minWidth: 0,
        ...(screen ? INK_ON_SCREEN : INK_ON_LIGHT),
        ...(gap != null ? { display: 'flex', flexDirection: 'column', gap } : null),
        ...extra,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────── screen ─────────────────────────────── */

export interface HoloScreenProps {
  children: ReactNode;
  padding?: number | string;
  /** Centre the content (empty states). */
  center?: boolean;
  /** Faint pixel grid instead of dither. */
  grid?: boolean;
  style?: CSSProperties;
}

/** Deep-indigo sunken screen. Text inside: INK.* or HOLO.onScreen*. */
export function HoloScreen({ children, padding = '10px 12px', center = false, grid = false, style }: HoloScreenProps) {
  return (
    <HoloPanel
      tone="screen"
      variant="sunken"
      texture={grid ? 'grid' : 'dither'}
      padding={padding}
      style={{ textAlign: center ? 'center' : undefined, ...style }}
    >
      {children}
    </HoloPanel>
  );
}
