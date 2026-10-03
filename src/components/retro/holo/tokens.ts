/**
 * Spare Holo — design tokens.
 *
 * The look: pastel sky (peach -> cream -> pink ->
 * lilac -> periwinkle), holographic chrome accents, chunky pixel headlines with
 * an iridescent fill and a deep-indigo outline, Win98 bevels rendered in pastel,
 * and deep-indigo "screens" / chips for data and emphasis.
 *
 * Everything here is a plain value (hex strings, CSS strings, style objects) so
 * it can be used from inline styles, template strings and CSS-in-TS alike.
 * Anything that needs :hover / :active / @media lives in ./holo.css.
 */
import type { CSSProperties } from 'react';

/* ─────────────────────────────── colour ─────────────────────────────── */

export const HOLO = {
  /* pastel sky — the brand gradient stops */
  cream: '#FFF1E6',
  peach: '#FFD9C2',
  pink: '#FFB8E0',
  lilac: '#C9B6FF',
  periwinkle: '#9FB4FF',
  /* iridescent tints (the sheen inside chrome and holo type) */
  butter: '#FFF1B8',
  gold: '#FFE0A3',
  sky: '#BDEBFF',
  mint: '#BFF5E1',
  white: '#FFFFFF',

  /* surfaces */
  paper: '#FFFDFB',          // input / table well
  face: '#F4EEFF',           // default control face (lilac-white)
  faceDeep: '#E6DCFF',       // pressed / selected face
  frame: '#EFE8FF',          // window + taskbar chrome face

  /* ink — deep indigo for all text on pastel */
  ink: '#2A1B6E',
  inkSoft: '#4B36B8',        // labels, secondary emphasis   (>= 6.9:1 on face)
  inkMuted: '#5140B8',       // hints, captions              (>= 4.8:1 on the canvas)
  inkFaint: '#9A8BE0',       // dividers, punctuation only — never body copy

  /* bevel */
  bevelHi: '#FFFFFF',
  bevelMid: '#F7F2FF',
  bevelLo: '#A897EC',
  bevelHard: '#2A1B6E',

  /* screens — deep-indigo wells for data, chips and emphasis */
  screen: '#1B1450',
  screenDeep: '#140E3E',
  screenRaised: '#241B63',
  screenLine: '#3A2F8C',
  onScreen: '#FFF6EE',
  onScreenMuted: '#CBBEFF',
  onScreenSubtle: '#A597E6',

  /* semantic — "ink" reads on pastel, "lit" reads on screens, "fill" is a bar / dot colour */
  goodInk: '#075E41',
  goodLit: '#7CF5C8',
  goodFill: '#6EE7B7',
  warnInk: '#8A3D00',
  warnLit: '#FFD37A',
  warnFill: '#FFCB6B',
  badInk: '#A0104A',
  badLit: '#FF8FB0',
  badFill: '#FF7FA3',
  infoInk: '#3F2FB0',
  infoLit: '#D9CCFF',
  infoFill: '#B9A6FF',
  link: '#4B32C8',
  linkLit: '#D9CCFF',
} as const;

export type HoloTone = 'holo' | 'ink' | 'good' | 'warn' | 'bad' | 'info' | 'muted';

/** Text colour for a tone on a pastel surface. */
export function holoInk(t: HoloTone): string {
  switch (t) {
    case 'good': return HOLO.goodInk;
    case 'warn': return HOLO.warnInk;
    case 'bad': return HOLO.badInk;
    case 'info': return HOLO.infoInk;
    case 'muted': return HOLO.inkMuted;
    default: return HOLO.ink;
  }
}

/** Text colour for a tone on a deep-indigo screen. */
export function holoLit(t: HoloTone): string {
  switch (t) {
    case 'good': return HOLO.goodLit;
    case 'warn': return HOLO.warnLit;
    case 'bad': return HOLO.badLit;
    case 'info': return HOLO.infoLit;
    case 'muted': return HOLO.onScreenMuted;
    default: return HOLO.onScreen;
  }
}

/** Solid fill (dots, bars, chips) for a tone. */
export function holoFill(t: HoloTone): string {
  switch (t) {
    case 'good': return HOLO.goodFill;
    case 'warn': return HOLO.warnFill;
    case 'bad': return HOLO.badFill;
    case 'info': return HOLO.infoFill;
    case 'muted': return HOLO.bevelLo;
    case 'ink': return HOLO.ink;
    default: return HOLO.lilac;
  }
}

/* ───────────────────── ink context (surface-aware text) ─────────────────────
 * Text that can land on either a pastel surface or a deep-indigo screen uses
 * INK.* — CSS custom properties with pastel-surface fallbacks. Every Holo
 * surface sets the right values for what is inside it (INK_ON_LIGHT /
 * INK_ON_SCREEN), so a hint or label reads correctly wherever it is
 * dropped.                                                                   */

export const INK = {
  body: `var(--holo-ink, ${HOLO.ink})`,
  soft: `var(--holo-ink-soft, ${HOLO.inkSoft})`,
  muted: `var(--holo-ink-muted, ${HOLO.inkMuted})`,
  good: `var(--holo-ink-good, ${HOLO.goodInk})`,
  warn: `var(--holo-ink-warn, ${HOLO.warnInk})`,
  bad: `var(--holo-ink-bad, ${HOLO.badInk})`,
  info: `var(--holo-ink-info, ${HOLO.infoInk})`,
  link: `var(--holo-ink-link, ${HOLO.link})`,
} as const;

/** Tone -> surface-aware ink. */
export function inkFor(t: HoloTone): string {
  switch (t) {
    case 'good': return INK.good;
    case 'warn': return INK.warn;
    case 'bad': return INK.bad;
    case 'info': return INK.info;
    case 'muted': return INK.muted;
    default: return INK.body;
  }
}

const cssVars = (v: Record<string, string>) => v as unknown as CSSProperties;

/** Spread on any pastel surface. */
export const INK_ON_LIGHT: CSSProperties = cssVars({
  '--holo-ink': HOLO.ink,
  '--holo-ink-soft': HOLO.inkSoft,
  '--holo-ink-muted': HOLO.inkMuted,
  '--holo-ink-good': HOLO.goodInk,
  '--holo-ink-warn': HOLO.warnInk,
  '--holo-ink-bad': HOLO.badInk,
  '--holo-ink-info': HOLO.infoInk,
  '--holo-ink-link': HOLO.link,
  color: HOLO.ink,
});

/** Spread on any deep-indigo screen. */
export const INK_ON_SCREEN: CSSProperties = cssVars({
  '--holo-ink': HOLO.onScreen,
  '--holo-ink-soft': HOLO.onScreenMuted,
  '--holo-ink-muted': HOLO.onScreenSubtle,
  '--holo-ink-good': HOLO.goodLit,
  '--holo-ink-warn': HOLO.warnLit,
  '--holo-ink-bad': HOLO.badLit,
  '--holo-ink-info': HOLO.infoLit,
  '--holo-ink-link': HOLO.linkLit,
  color: HOLO.onScreen,
});

/* ─────────────────────────────── type ─────────────────────────────── */

/*
 * Each stack reads a CSS variable defined in holo.css (:root), with the same
 * stack as its fallback. English resolves to exactly these fonts. Under
 * html[lang='zh-CN'] / html[lang='zh-TW'] holo.css redefines the variables to
 * add a Chinese face after the Latin ones (src/i18n/cjkFonts.ts), so Latin
 * glyphs keep the pixel faces and CJK glyphs get a face that has them.
 */

/** Chunky pixel headline ("TURBO ROUND-UPS", "SPARE"). Caps, big sizes, numbers. */
export const FONT_DISPLAY = "var(--holo-font-display, 'Press Start 2P', 'Silkscreen', ui-monospace, monospace)";
/** Pixel caps for eyebrows, chips, sub-headlines ("ROUNDUP ENGINE", "ROUND UP"). */
export const FONT_PIXEL = "var(--holo-font-pixel, 'Silkscreen', 'Jersey 10', ui-monospace, monospace)";
/**
 * Chunky pixel UI sans — title bars, menus, buttons, labels ("Spare - Protocol", "Link Wallet").
 * Jersey 10 has ONE weight: always pair it with fontWeight 400 (faux bold smears pixels) and
 * size it big — 16–22px reads like 11–15px of a normal face. Crisp at 20px (2× its grid).
 */
export const FONT_CHROME = "var(--holo-font-chrome, 'Jersey 10', 'Silkscreen', system-ui, sans-serif)";
/** Body mono — copy, values, inputs ("Round to $1 / $5 / $10"). */
export const FONT_TEXT = "var(--holo-font-text, 'Space Mono', 'IBM Plex Mono', ui-monospace, monospace)";

/* ───────────────────────────── gradients ───────────────────────────── */

export const GRADIENT = {
  /** The full-strength brand sky. Heroes and feature tiles. */
  sky: 'linear-gradient(125deg, #FFF1E6 0%, #FFD9C2 20%, #FFB8E0 48%, #C9B6FF 74%, #9FB4FF 100%)',
  /** Softened sky for window bodies — content sits on it, so it stays light. */
  canvas: 'linear-gradient(160deg, #FFF1E7 0%, #FFE0D2 20%, #FFD0EA 46%, #E0D2FF 72%, #CBD6FF 100%)',
  /** Iridescent fill for pixel type (clip to text). */
  holoText:
    'linear-gradient(118deg, #FFFBEA 0%, #FFE7A8 12%, #FFD1EC 26%, #E6D6FF 40%, #BDEFFF 52%, #FFF7E0 62%, #FFC6E6 76%, #C9D6FF 90%, #FFFFFF 100%)',
  /** Chrome sheen for primary controls and the Start button. */
  chrome: 'linear-gradient(135deg, #FFF6DF 0%, #FFD0EA 30%, #DCCBFF 56%, #BDE6FF 80%, #FFF1E6 100%)',
  /** Quiet pastel face for secondary controls and cards. */
  face: 'linear-gradient(180deg, #FFFFFF 0%, #F7F1FF 55%, #ECE3FF 100%)',
  /** Card / dialog body. */
  card: 'linear-gradient(160deg, #FFFFFF 0%, #FFF5EE 38%, #FBEEFF 70%, #EDF1FF 100%)',
  /** Active window title bar — deep violet left (white title reads) into pink and periwinkle. */
  titleBar: 'linear-gradient(90deg, #3B2A9E 0%, #5B3FD0 30%, #9A6BE8 56%, #E58FD6 80%, #9FB4FF 100%)',
  /** Inactive window title bar. */
  titleBarIdle: 'linear-gradient(90deg, #8E84C4 0%, #B3A9DE 55%, #CFC8EE 100%)',
  /** Mini title bar on dialog cards (HoloCard). */
  cardBar: 'linear-gradient(90deg, #FFB8E0 0%, #FFD9C2 28%, #BDEBFF 62%, #9FB4FF 100%)',
  cardBarLilac: 'linear-gradient(90deg, #C9B6FF 0%, #E4D8FF 45%, #BDEBFF 100%)',
  cardBarPink: 'linear-gradient(90deg, #FF9FD2 0%, #FFC4E4 50%, #FFD9C2 100%)',
  cardBarInk: 'linear-gradient(90deg, #2A1B6E 0%, #4B36B8 60%, #6B55D8 100%)',
  /** Cream menu bar. */
  menuBar: 'linear-gradient(90deg, #FFF3EA 0%, #FFEDE6 45%, #F5EDFF 100%)',
  /** Taskbar. */
  taskbar: 'linear-gradient(180deg, #FBF7FF 0%, #EFE6FF 55%, #E4D8FF 100%)',
  /** Deep-indigo screen. */
  screen: 'linear-gradient(180deg, #221A5E 0%, #1B1450 55%, #160F45 100%)',
  /** Progress / meter fill. */
  meter: 'linear-gradient(90deg, #FFB8E0 0%, #FFD9C2 25%, #C9B6FF 55%, #9FB4FF 80%, #BDEBFF 100%)',
  meterGood: 'linear-gradient(90deg, #7CF5C8 0%, #BFF5E1 50%, #8FE8FF 100%)',
  meterWarn: 'linear-gradient(90deg, #FFE0A3 0%, #FFCB6B 60%, #FFB38A 100%)',
  meterBad: 'linear-gradient(90deg, #FFB8CC 0%, #FF7FA3 100%)',
} as const;

/* ───────────────────────────── bevels ───────────────────────────── */

/** Raised pastel bevel: white highlight, lilac shadow, 1px indigo hard edge. */
export const BEVEL_RAISED =
  'inset -1px -1px 0 0 #2A1B6E, inset 1px 1px 0 0 #FFFFFF, inset -2px -2px 0 0 #A897EC, inset 2px 2px 0 0 #F7F2FF';
/** Pressed / toggled-on. */
export const BEVEL_PRESSED =
  'inset 1px 1px 0 0 #2A1B6E, inset -1px -1px 0 0 #FFFFFF, inset 2px 2px 0 0 #A897EC, inset -2px -2px 0 0 #F7F2FF';
/** One-step sunken — status panels, tray pills. */
export const BEVEL_SUNKEN = 'inset 1px 1px 0 0 #A897EC, inset -1px -1px 0 0 #FFFFFF';
/** Two-step sunken — inputs, tables, screens. */
export const BEVEL_WELL =
  'inset 1px 1px 0 0 #A897EC, inset -1px -1px 0 0 #FFFFFF, inset 2px 2px 0 0 #2A1B6E, inset -2px -2px 0 0 #F7F2FF';
/** Window frame (outer). */
export const BEVEL_WINDOW =
  'inset -1px -1px 0 0 #2A1B6E, inset 1px 1px 0 0 #F7F2FF, inset -2px -2px 0 0 #A897EC, inset 2px 2px 0 0 #FFFFFF';

/* ───────────────────────────── shadows ───────────────────────────── */

export const SHADOW = {
  /** Hard pixel drop shadow for cards. */
  card: '4px 4px 0 0 rgba(42,27,110,.22)',
  /** Floating window: hard edge + soft lilac bloom. */
  window: '0 0 0 1px #2A1B6E, 6px 6px 0 0 rgba(42,27,110,.20), 0 18px 44px rgba(74,58,168,.28)',
  /** Popovers / menus. */
  pop: '0 0 0 1px #2A1B6E, 4px 4px 0 0 rgba(42,27,110,.25), 0 12px 30px rgba(74,58,168,.25)',
  /** White-on-indigo pixel outline for light text over busy art. */
  textOutline: '1px 0 0 #2A1B6E, -1px 0 0 #2A1B6E, 0 1px 0 #2A1B6E, 0 -1px 0 #2A1B6E, 1px 1px 0 #2A1B6E, 2px 2px 0 rgba(42,27,110,.45)',
  /** Title-bar text. */
  titleText: '1px 1px 0 #2A1B6E',
} as const;

/* ───────────────────────────── textures ───────────────────────────── */

const svg = (s: string) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;

export const TEXTURE = {
  /** 50% ordered dither in faint indigo (4px tile). */
  dither: svg(
    "<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'><rect width='1' height='1' fill='#2A1B6E' fill-opacity='.07'/><rect x='2' y='2' width='1' height='1' fill='#2A1B6E' fill-opacity='.07'/></svg>",
  ),
  /** Light dither (white pixels) for dark screens and title bars. */
  ditherLight: svg(
    "<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'><rect width='1' height='1' fill='#FFFFFF' fill-opacity='.09'/><rect x='2' y='2' width='1' height='1' fill='#FFFFFF' fill-opacity='.09'/></svg>",
  ),
  /** Halftone dots (6px grid). */
  halftone: 'radial-gradient(circle, rgba(42,27,110,.16) 0 1px, transparent 1.6px)',
  halftoneSize: '6px 6px',
  /** Indigo/white checker strip (HoloDivider variant="checker"). */
  checker: svg(
    "<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' shape-rendering='crispEdges'><rect width='6' height='6' fill='#2A1B6E'/><rect x='6' y='6' width='6' height='6' fill='#2A1B6E'/><rect x='6' width='6' height='6' fill='#FFFFFF'/><rect y='6' width='6' height='6' fill='#FFFFFF'/></svg>",
  ),
  /** Faint pixel grid for screens — a complete background layer list (size included). */
  gridLayers:
    'linear-gradient(rgba(201,182,255,.08) 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(90deg, rgba(201,182,255,.08) 1px, transparent 1px) 0 0 / 8px 8px',
} as const;

/* ───────────────────────────── glyph art ───────────────────────────── */

/** Four-point sparkle path in a 24x24 box (a concave "✦"). */
export const SPARKLE_PATH =
  'M12 0 C12.7 7.4 16.6 11.3 24 12 C16.6 12.7 12.7 16.6 12 24 C11.3 16.6 7.4 12.7 0 12 C7.4 11.3 11.3 7.4 12 0 Z';

/** Sparkle as a CSS background image (white with a lilac core). */
export function sparkleUrl(fill = '#FFFFFF', core = '#C9B6FF'): string {
  return svg(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${SPARKLE_PATH}' fill='${fill}'/><circle cx='12' cy='12' r='2' fill='${core}'/></svg>`,
  );
}

/** Turn rows of '1'/'0' into crisp SVG path data (one 1x1 square per '1'). */
export function pixelPath(rows: readonly string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x} ${y}h1v1h-1z`;
  });
  return d;
}

/** Win98 close glyph, 8x7. */
export const PIXEL_X_PATH = pixelPath(['11000011', '01100110', '00111100', '00011000', '00111100', '01100110', '11000011']);
/** Checkmark, 7x7. */
export const PIXEL_CHECK_PATH = pixelPath(['0000001', '0000011', '1000111', '1101110', '1111100', '0111000', '0010000']);
/** Minimise bar, 8x2 (drawn at the bottom of an 8x7 box by the caller). */
export const PIXEL_MIN_PATH = pixelPath(['11111111', '11111111']);
/** Down-pointing arrow, 7x4 (select boxes, disclosure). */
export const PIXEL_ARROW_DOWN_PATH = pixelPath(['1111111', '0111110', '0011100', '0001000']);

/* ───────────────────────────── spacing ───────────────────────────── */

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Ready-made style fragments. */
export const HOLO_STYLE = {
  /** A deep-indigo "screen" well. */
  screen: {
    background: `${TEXTURE.ditherLight}, ${GRADIENT.screen}`,
    boxShadow: BEVEL_WELL,
    ...INK_ON_SCREEN,
  } as CSSProperties,
  /** A pastel sunken well. */
  well: {
    background: HOLO.paper,
    boxShadow: BEVEL_WELL,
    ...INK_ON_LIGHT,
  } as CSSProperties,
  /** Body copy. */
  text: { fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.55, color: INK.body } as CSSProperties,
  /** Small caps label. */
  label: {
    fontFamily: FONT_PIXEL,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: INK.soft,
    lineHeight: 1.2,
  } as CSSProperties,
} as const;
