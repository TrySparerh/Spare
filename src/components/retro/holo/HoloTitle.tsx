/**
 * HoloTitle — the headline style: chunky pixel caps with an iridescent fill,
 * a deep-indigo outline + extrusion and a cream rim ("TURBO ROUND-UPS", "SPARE").
 *
 * Drawn as two stacked copies of the text: the base copy carries the outline
 * (text-shadow) and is the one assistive tech reads; the fill copy on top is
 * aria-hidden and clipped to the holographic gradient. Styles in holo.css.
 *
 * Money reads unambiguously: every decimal point that sits between two digits
 * ("$5.00", "0.25", "1.5x") is wrapped in .holo-title__dot, which keeps the
 * outline but drops the extrusion + rim that otherwise smear Press Start 2P's
 * baseline square into a "," — so $5.00 never reads as $5,00.
 *
 * Chinese: each run of CJK characters is wrapped in .holo-title__cjk. Press
 * Start 2P draws its caps high above the baseline while a CJK face centres
 * lower, so in "欢迎来到 SPARE" the Chinese would sag; holo.css lifts the run
 * and gives the outlined glyphs a little air. English text never contains a
 * CJK character, so English titles render exactly as before.
 */
import { Fragment, isValidElement, type CSSProperties, type ElementType, type ReactNode } from 'react';

export type HoloTitleSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface HoloTitleProps {
  children: ReactNode;
  /** xs 12 · sm 16 · md 24 · lg 32 · xl 44 px (display face; smaller on mobile). Default 'lg'. */
  size?: HoloTitleSize;
  /** 'display' = Press Start 2P (headlines, numbers); 'pixel' = Silkscreen (sub-headlines). */
  font?: 'display' | 'pixel';
  /** 'holo' iridescent (default) · 'cream' (ROUNDUP ENGINE) · 'ink' (indigo letters, white outline) · tone fills. */
  fill?: 'holo' | 'cream' | 'ink' | 'good' | 'warn' | 'bad';
  /** Slow sheen drift across the fill. Off under prefers-reduced-motion. */
  shimmer?: boolean;
  /** Element to render. Default 'h2'. */
  as?: ElementType;
  align?: 'left' | 'center' | 'right';
  /** Override the outline colour (default deep indigo). */
  outline?: string;
  style?: CSSProperties;
  className?: string;
  title?: string;
}

export function HoloTitle({
  children,
  size = 'lg',
  font = 'display',
  fill = 'holo',
  shimmer = false,
  as: Tag = 'h2',
  align,
  outline,
  style,
  className,
  title,
}: HoloTitleProps) {
  const cls = [
    'holo-title',
    `holo-title--${size}`,
    font === 'pixel' ? 'holo-title--pixel' : '',
    fill !== 'holo' ? `holo-title--fill-${fill}` : '',
    shimmer ? 'holo-title--shimmer' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const vars = outline ? ({ ['--ht-line' as string]: outline } as CSSProperties) : undefined;
  // Both copies get the same markup so the fill stays pixel-aligned with the outline.
  const text = markText(children);
  return (
    <Tag className={cls} title={title} style={{ textAlign: align, alignSelf: align === 'center' ? 'center' : undefined, ...vars, ...style }}>
      <span className="holo-title__base">{text}</span>
      <span className="holo-title__fill" aria-hidden>
        {text}
      </span>
    </Tag>
  );
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** CJK ideographs, CJK symbols/punctuation and full-width forms (，。：！？（）). */
const CJK_RUN = /([\u2E80-\u2FFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]+)/;

/** Wraps each decimal point between two digits in <span class="holo-title__dot">. */
function markDecimals(node: string): ReactNode {
  const parts: ReactNode[] = [];
  let from = 0;
  for (let i = 1; i < node.length - 1; i++) {
    if (node[i] === '.' && isDigit(node[i - 1]) && isDigit(node[i + 1])) {
      parts.push(
        node.slice(from, i),
        <span key={i} className="holo-title__dot">
          .
        </span>,
      );
      from = i + 1;
    }
  }
  if (parts.length === 0) return node;
  parts.push(node.slice(from));
  return parts;
}

/**
 * Marks decimal points (.holo-title__dot) and CJK runs (.holo-title__cjk).
 * Walks strings, numbers, arrays and fragments; any other element is left as is.
 * The text content is unchanged, so assistive tech still reads "$5.00".
 */
function markText(node: ReactNode): ReactNode {
  if (typeof node === 'number') return markText(String(node));
  if (typeof node === 'string') {
    if (!CJK_RUN.test(node)) return markDecimals(node);
    // split() with a capture group: odd indices are the CJK runs.
    return node.split(CJK_RUN).map((part, i) =>
      i % 2 === 1 ? (
        <span key={i} className="holo-title__cjk">
          {part}
        </span>
      ) : (
        <Fragment key={i}>{markDecimals(part)}</Fragment>
      ),
    );
  }
  if (Array.isArray(node)) return node.map((n, i) => <Fragment key={i}>{markText(n)}</Fragment>);
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) {
    return <Fragment key={node.key ?? undefined}>{markText(node.props.children)}</Fragment>;
  }
  return node;
}

export default HoloTitle;
