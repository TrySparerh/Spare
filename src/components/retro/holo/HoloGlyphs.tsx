/**
 * Crisp pixel glyphs used by the kit (close ×, check, minimise, arrow) and the
 * Win98-style message icons (info / warn / error / success).
 */
import type { CSSProperties } from 'react';
import { HOLO, PIXEL_ARROW_DOWN_PATH, PIXEL_CHECK_PATH, PIXEL_MIN_PATH, PIXEL_X_PATH, pixelPath } from './tokens';

interface GlyphProps {
  /** Pixel scale (1 = one CSS px per glyph pixel). Default 1. */
  scale?: number;
  color?: string;
  style?: CSSProperties;
}

function Pixel({ w, h, d, scale = 1, color = HOLO.ink, style }: GlyphProps & { w: number; h: number; d: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={w * scale}
      height={h * scale}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      <path d={d} fill={color} />
    </svg>
  );
}

export const GlyphClose = (p: GlyphProps) => <Pixel w={8} h={7} d={PIXEL_X_PATH} {...p} />;
export const GlyphCheck = (p: GlyphProps) => <Pixel w={7} h={7} d={PIXEL_CHECK_PATH} {...p} />;
export const GlyphMin = (p: GlyphProps) => <Pixel w={8} h={2} d={PIXEL_MIN_PATH} {...p} />;
export const GlyphArrowDown = (p: GlyphProps) => <Pixel w={7} h={4} d={PIXEL_ARROW_DOWN_PATH} {...p} />;

const MAX_PATH = pixelPath(['111111111', '111111111', '100000001', '100000001', '100000001', '100000001', '100000001', '111111111']);
const RESTORE_PATH = pixelPath(['001111111', '001111111', '001000001', '111111101', '111111101', '100000101', '100000111', '100000100', '111111100']);
export const GlyphMax = (p: GlyphProps) => <Pixel w={9} h={8} d={MAX_PATH} {...p} />;
export const GlyphRestore = (p: GlyphProps) => <Pixel w={9} h={9} d={RESTORE_PATH} {...p} />;

/* ─── 7x7 pixel pictograms (menus, tray keys) — draw at scale 2 ─── */

export type PixelGlyphKind = 'globe' | 'doc' | 'flag' | 'mail' | 'prompt' | 'spark' | 'window' | 'grid' | 'power';

const PICTO: Record<PixelGlyphKind, string[]> = {
  globe: ['0011100', '0101010', '1001001', '1111111', '1001001', '0101010', '0011100'],
  doc: ['1111110', '1000011', '1011101', '1000001', '1011101', '1000001', '1111111'],
  flag: ['1100000', '1111100', '1111110', '1111100', '1000000', '1000000', '1000000'],
  mail: ['0000000', '1111111', '1100011', '1010101', '1001001', '1000001', '1111111'],
  prompt: ['1000000', '0100000', '0010000', '0100000', '1000000', '0000000', '0001111'],
  spark: ['0001000', '0001000', '0011100', '1111111', '0011100', '0001000', '0001000'],
  window: ['1111111', '1111111', '1000001', '1000001', '1000001', '1000001', '1111111'],
  grid: ['1110111', '1010101', '1110111', '0000000', '1110111', '1010101', '1110111'],
  power: ['0001000', '0101010', '1001001', '1001001', '1000001', '0100010', '0011100'],
};
const PICTO_PATH = Object.fromEntries(
  (Object.keys(PICTO) as PixelGlyphKind[]).map((k) => [k, pixelPath(PICTO[k])]),
) as Record<PixelGlyphKind, string>;

/** A 7x7 pixel pictogram (globe, doc, flag, mail, prompt, spark, window, grid, power). */
export function PixelGlyph({ kind, ...p }: GlyphProps & { kind: PixelGlyphKind }) {
  return <Pixel w={7} h={7} d={PICTO_PATH[kind]} {...p} />;
}

export const GlyphGlobe = (p: GlyphProps) => <PixelGlyph kind="globe" {...p} />;

/**
 * A small chrome key holding an indigo pictogram — the on-brand replacement for
 * letter tiles in menus (Start menu Web rows, Shut Down).
 */
export function HoloGlyphTile({ kind, size = 20, style }: { kind: PixelGlyphKind; size?: number; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #FFF6DF 0%, #FFD0EA 30%, #DCCBFF 56%, #BDE6FF 80%, #FFF1E6 100%)',
        boxShadow: `0 0 0 1px ${HOLO.ink}, inset 1px 1px 0 0 #FFFFFF, inset -1px -1px 0 0 ${HOLO.bevelLo}`,
        ...style,
      }}
    >
      {/* whole-pixel scale so the pictogram stays crisp: 18px -> 1x, 20 -> 2x, 48 -> 4x, 64 -> 6x */}
      <PixelGlyph kind={kind} scale={Math.max(1, Math.floor(size / 10))} />
    </span>
  );
}

/* ─── message icons (16x16 pixel art, drawn at 2x by default) ─── */

export type HoloMessageKind = 'info' | 'warn' | 'error' | 'success';

const ICON_BG: Record<HoloMessageKind, string> = {
  info: '#C9B6FF',
  warn: '#FFCB6B',
  error: '#FF7FA3',
  success: '#6EE7B7',
};

const ICON_MARK: Record<HoloMessageKind, string[]> = {
  info: ['00000000', '00011000', '00011000', '00000000', '00111000', '00011000', '00011000', '00011000', '00011000', '00111100'],
  warn: ['00011000', '00011000', '00011000', '00011000', '00011000', '00011000', '00000000', '00011000', '00011000', '00000000'],
  error: ['00000000', '01100110', '01111110', '00111100', '00011000', '00111100', '01111110', '01100110', '00000000', '00000000'],
  success: ['00000000', '00000011', '00000111', '00001110', '11011100', '11111000', '01110000', '00100000', '00000000', '00000000'],
};

/** Win98 message-box icon, pastel edition: a chunky tile with an indigo mark. */
export function HoloMessageIcon({ kind, size = 28 }: { kind: HoloMessageKind; size?: number }) {
  const mark = pixelPath(ICON_MARK[kind]);
  return (
    <svg aria-hidden focusable="false" width={size} height={size} viewBox="0 0 14 14" shapeRendering="crispEdges" style={{ display: 'block', flexShrink: 0 }}>
      {/* chamfered tile with a hard indigo edge */}
      <path d="M2 0h10v1h1v1h1v10h-1v1h-1v1H2v-1H1v-1H0V2h1V1h1z" fill={HOLO.ink} />
      <path d="M2 1h10v1h1v10h-1v1H2v-1H1V2h1z" fill={ICON_BG[kind]} />
      <path d="M2 1h10v1H2zM1 2h1v3H1z" fill="#FFFFFF" fillOpacity=".85" />
      <g transform="translate(3 2)">
        <path d={mark} fill={HOLO.ink} />
      </g>
    </svg>
  );
}
