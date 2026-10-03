/**
 * HoloHero — the header an app opens with: brand-sky gradient, a
 * halftone planet with an orbit, sparkles, holographic art on the left, a big
 * pixel headline, a cream pixel sub-headline and one line of plain copy.
 *
 *   <HoloHero
 *     art="/icons/spare/roundup-rules.png"
 *     kicker="Round-up engine"
 *     title="Round-Up Rules"
 *     subtitle="Round to $1 / $5 / $10"
 *     description="Every eligible payment rounds up into your investing balance."
 *     aside={<HoloBadge label="ON-CHAIN" variant="solid" />}
 *   />
 */
import { useId, type CSSProperties, type ReactNode } from 'react';
import { HoloSparkles, HoloStar } from './HoloSparkles';
import { HoloTitle } from './HoloTitle';
import { GRADIENT, HOLO, TEXTURE } from './tokens';

export interface HoloHeroProps {
  title: ReactNode;
  /** Small pixel-caps line above the title ("FROM PAYMENTS TO STOCKS"). */
  kicker?: ReactNode;
  /** Cream pixel sub-headline under the title ("ROUNDUP ENGINE"). */
  subtitle?: ReactNode;
  /** One or two lines of body copy. */
  description?: ReactNode;
  /** Image src (e.g. '/icons/spare/stock-mix.png'), a node, or null for none. Default: the holographic Spare mark. */
  art?: string | ReactNode | null;
  /** Right column: badges, a stat, a button. Wraps under the copy on mobile. */
  aside?: ReactNode;
  /** Anything under the description (chips, a segmented control). */
  children?: ReactNode;
  /** Title size. Default 'lg' ('md' when compact). */
  size?: 'md' | 'lg' | 'xl';
  /** Shorter banner for secondary screens. */
  compact?: boolean;
  /** Decorative sparkles. Default true. */
  sparkles?: boolean;
  /** Planet + orbit art in the background. Default true. */
  planet?: boolean;
  /** Seed for the sparkle scatter, so each app gets its own sky. */
  seed?: number;
  /** Headline shimmer. Default false. */
  shimmer?: boolean;
  style?: CSSProperties;
}

function HeroBackdrop({ planet }: { planet: boolean }) {
  const uid = useId().replace(/:/g, '');
  const dots = `hh-dots-${uid}`;
  const glow = `hh-glow-${uid}`;
  const body = `hh-body-${uid}`;
  const fade = `hh-fade-${uid}`;
  return (
    <svg aria-hidden focusable="false" width="100%" height="100%" preserveAspectRatio="xMaxYMid slice" viewBox="0 0 600 200" style={{ position: 'absolute', inset: 0, display: 'block' }}>
      <defs>
        <pattern id={dots} width="5" height="5" patternUnits="userSpaceOnUse">
          <rect width="2" height="2" fill="#FFFFFF" fillOpacity=".55" />
        </pattern>
        <radialGradient id={glow} cx=".78" cy=".45" r=".45">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity=".7" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={body} cx=".38" cy=".32" r=".75">
          <stop offset="0" stopColor="#FFF1E6" />
          <stop offset=".35" stopColor="#FFB8E0" />
          <stop offset=".7" stopColor="#C9B6FF" />
          <stop offset="1" stopColor="#9FB4FF" />
        </radialGradient>
        <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity=".55" />
        </linearGradient>
      </defs>
      <rect width="600" height="200" fill={`url(#${glow})`} />
      {planet && (
        <g>
          <circle cx="492" cy="96" r="78" fill={`url(#${body})`} opacity=".9" />
          <circle cx="492" cy="96" r="78" fill={`url(#${dots})`} opacity=".7" />
          <circle cx="492" cy="96" r="78" fill="none" stroke="#FFFFFF" strokeOpacity=".8" strokeWidth="2" />
          <ellipse cx="492" cy="104" rx="150" ry="26" fill="none" stroke="#FFFFFF" strokeOpacity=".85" strokeWidth="1.6" strokeDasharray="2 5" transform="rotate(-12 492 104)" />
          <circle cx="592" cy="186" r="16" fill={`url(#${body})`} opacity=".8" />
        </g>
      )}
      {/* pixel horizon: a few rows of dither fading up from the bottom */}
      <rect y="150" width="600" height="50" fill={`url(#${fade})`} />
      <rect y="184" width="600" height="16" fill={`url(#${dots})`} opacity=".7" />
    </svg>
  );
}

export function HoloHero({
  title,
  kicker,
  subtitle,
  description,
  art,
  aside,
  children,
  size,
  compact = false,
  sparkles = true,
  planet = true,
  seed = 11,
  shimmer = false,
  style,
}: HoloHeroProps) {
  const titleSize = size ?? (compact ? 'md' : 'lg');
  const artNode =
    art === null ? null : art === undefined ? (
      <HoloStar size={compact ? 60 : 88} />
    ) : typeof art === 'string' ? (
      <img src={art} alt="" draggable={false} />
    ) : (
      art
    );
  return (
    <header
      className={`holo-hero${compact ? ' holo-hero--compact' : ''}`}
      style={{
        background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky}`,
        color: HOLO.ink,
        ...style,
      }}
    >
      <div className="holo-hero__bg">
        <HeroBackdrop planet={planet} />
        {sparkles && <HoloSparkles count={compact ? 5 : 8} seed={seed} sizes={[6, compact ? 12 : 16]} />}
      </div>
      {artNode && <div className="holo-hero__art">{artNode}</div>}
      <div className="holo-hero__text">
        {kicker && <div className="holo-hero__kicker">{kicker}</div>}
        <HoloTitle as="h1" size={titleSize} shimmer={shimmer}>
          {title}
        </HoloTitle>
        {subtitle && (
          <HoloTitle as="div" font="pixel" fill="cream" size="xs" style={{ marginTop: -2 }}>
            {subtitle}
          </HoloTitle>
        )}
        {description && <p className="holo-hero__desc">{description}</p>}
        {children}
      </div>
      {aside && <div className="holo-hero__aside">{aside}</div>}
    </header>
  );
}

export default HoloHero;
