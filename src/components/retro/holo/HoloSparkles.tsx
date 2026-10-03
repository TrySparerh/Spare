/**
 * Decorative brand glyphs — all aria-hidden, all pointer-events: none.
 *
 *   <HoloSparkle />        one four-point sparkle (✦)
 *   <HoloSparkles />       a seeded scatter of sparkles filling its parent
 *   <HoloStar />           the Spare mark (sparkle + orbital arcs) in holographic chrome
 */
import { useId, useMemo, type CSSProperties } from 'react';
import { HOLO, SPARKLE_PATH } from './tokens';

/* ─────────────────────────────── sparkle ─────────────────────────────── */

export interface HoloSparkleProps {
  /** Pixel size of the glyph box. Default 14. */
  size?: number;
  /** Fill colour. Default white. */
  color?: string;
  /** Soft glow behind the glyph. Default true. */
  glow?: boolean;
  /** Gentle twinkle (disabled under prefers-reduced-motion). */
  twinkle?: boolean;
  /** Animation delay in seconds when twinkling. */
  delay?: number;
  style?: CSSProperties;
}

export function HoloSparkle({ size = 14, color = HOLO.white, glow = true, twinkle = false, delay = 0, style }: HoloSparkleProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={twinkle ? 'holo-sparkle--twinkle' : undefined}
      style={{
        display: 'inline-block',
        flexShrink: 0,
        pointerEvents: 'none',
        overflow: 'visible',
        filter: glow ? 'drop-shadow(0 0 3px rgba(255,255,255,.95)) drop-shadow(0 0 6px rgba(201,182,255,.9))' : undefined,
        animationDelay: twinkle ? `${delay}s` : undefined,
        ...style,
      }}
    >
      <path d={SPARKLE_PATH} fill={color} />
      <circle cx="12" cy="12" r="1.8" fill={HOLO.lilac} />
    </svg>
  );
}

/* ─────────────────────────────── scatter ─────────────────────────────── */

export interface HoloSparklesProps {
  /** How many sparkles. Default 7. */
  count?: number;
  /** Seed for the deterministic layout (same seed, same layout). */
  seed?: number;
  /** Size range in px. Default [6, 16]. */
  sizes?: [number, number];
  color?: string;
  twinkle?: boolean;
  /** Keep sparkles out of a central band so they don't sit on the copy. 0..0.8. */
  avoidCenter?: number;
  style?: CSSProperties;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Fills its (position: relative) parent with a scatter of sparkles. Decorative only. */
export function HoloSparkles({ count = 7, seed = 7, sizes = [6, 16], color, twinkle = true, avoidCenter = 0, style }: HoloSparklesProps) {
  const pts = useMemo(() => {
    const r = rng(seed);
    const out: { x: number; y: number; s: number; d: number }[] = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 20) {
      const x = r() * 96 + 2;
      const y = r() * 90 + 4;
      if (avoidCenter > 0) {
        const dx = Math.abs(x - 50) / 50;
        const dy = Math.abs(y - 50) / 50;
        if (dx < avoidCenter && dy < avoidCenter) continue;
      }
      out.push({ x, y, s: sizes[0] + r() * (sizes[1] - sizes[0]), d: r() * 2.6 });
    }
    return out;
  }, [count, seed, sizes, avoidCenter]);

  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', ...style }}>
      {pts.map((p, i) => (
        <HoloSparkle
          key={i}
          size={Math.round(p.s)}
          color={color}
          twinkle={twinkle}
          delay={p.d}
          style={{ position: 'absolute', left: `${p.x}%`, top: `${p.y}%`, transform: 'translate(-50%, -50%)' }}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────────── the mark ─────────────────────────────── */

export interface HoloStarProps {
  /** Pixel size. Default 96. */
  size?: number;
  /** Slow sheen rotation of the chrome gradient. */
  animated?: boolean;
  /** Draw the thin indigo keyline that keeps the chrome legible on pastel. Default true. */
  keyline?: boolean;
  /** Accessible label; omit for decorative use (aria-hidden). */
  title?: string;
  style?: CSSProperties;
}

/**
 * The Spare mark — four-point sparkle crossed by orbital arcs (public/brand/spare-mark.svg),
 * rendered in holographic chrome.
 */
export function HoloStar({ size = 96, animated = false, keyline = true, title, style }: HoloStarProps) {
  const uid = useId().replace(/:/g, '');
  const g = `hs-g-${uid}`;
  const sheen = `hs-s-${uid}`;
  const decorative = !title;
  const sparkle = 'M 256 14 Q 268 244 430 256 Q 268 268 256 498 Q 244 268 82 256 Q 244 244 256 14 Z';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={title}
      focusable="false"
      style={{ display: 'block', flexShrink: 0, overflow: 'visible', filter: 'drop-shadow(3px 4px 0 rgba(42,27,110,.28))', ...style }}
    >
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          {/* chrome: bright gold / pink / cyan sheen with violet reflections for depth */}
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset=".14" stopColor="#FFCF7A" />
          <stop offset=".3" stopColor="#FF9FD6" />
          <stop offset=".42" stopColor="#7B63E0" />
          <stop offset=".52" stopColor="#FFFFFF" />
          <stop offset=".64" stopColor="#8FDFFF" />
          <stop offset=".78" stopColor="#A58BFF" />
          <stop offset=".9" stopColor="#FFE3C4" />
          <stop offset="1" stopColor="#FFFFFF" />
          {animated && (
            <animateTransform attributeName="gradientTransform" type="rotate" from="0 .5 .5" to="360 .5 .5" dur="9s" repeatCount="indefinite" />
          )}
        </linearGradient>
        <radialGradient id={sheen} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity=".95" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      {title && <title>{title}</title>}
      <g fill="none" strokeLinecap="round">
        {keyline && (
          <g stroke={HOLO.ink} strokeOpacity=".8">
            <path d="M 118 300 A 190 190 0 0 1 404 150" strokeWidth="21" />
            <path d="M 394 212 A 190 190 0 0 1 108 362" strokeWidth="21" />
            <path d="M 176 286 A 112 112 0 0 1 330 168" strokeWidth="17" />
            <path d="M 336 226 A 112 112 0 0 1 182 344" strokeWidth="17" />
          </g>
        )}
        <g stroke={`url(#${g})`}>
          <path d="M 118 300 A 190 190 0 0 1 404 150" strokeWidth="13" />
          <path d="M 394 212 A 190 190 0 0 1 108 362" strokeWidth="13" />
          <path d="M 176 286 A 112 112 0 0 1 330 168" strokeWidth="10" />
          <path d="M 336 226 A 112 112 0 0 1 182 344" strokeWidth="10" />
        </g>
      </g>
      <g transform="rotate(45 256 256)">
        <path d={sparkle} fill={`url(#${g})`} stroke={keyline ? HOLO.ink : 'none'} strokeOpacity=".8" strokeWidth="6" strokeLinejoin="round" />
        <path
          d={sparkle}
          fill={`url(#${g})`}
          stroke={keyline ? HOLO.ink : 'none'}
          strokeOpacity=".8"
          strokeWidth="12"
          strokeLinejoin="round"
          transform="translate(92 96) scale(0.34) translate(-172 -178)"
        />
      </g>
      <circle cx="256" cy="256" r="46" fill={`url(#${sheen})`} />
    </svg>
  );
}
