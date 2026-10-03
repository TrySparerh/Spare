/**
 * HoloStat — a big number with a pixel label ("$3.75", "5x", "SPY 42%").
 * lg / xl render the number as a holographic poster numeral (HoloTitle
 * treatment); sm / md render it in bold poster mono, which stays calm in dense rows.
 *
 *   <HoloStat label="Spare balance" value="$12.40" size="xl" sub="USDG · on-chain" />
 */
import type { CSSProperties, ReactNode } from 'react';
import { HoloTitle } from './HoloTitle';
import { FONT_PIXEL, FONT_TEXT, INK, inkFor, type HoloTone } from './tokens';

export interface HoloStatProps {
  label: ReactNode;
  value: ReactNode;
  /** Line under the value (source, unit, delta). */
  sub?: ReactNode;
  /** 'holo' (default) · good / warn / bad tint the numeral · 'ink' plain indigo. */
  tone?: HoloTone;
  /** sm 14 · md 20 (mono) · lg 24 · xl 32 (holo display). Default 'lg'. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  align?: 'left' | 'center' | 'right';
  /** Tone for the sub line. Default muted. */
  subTone?: HoloTone;
  style?: CSSProperties;
}

export function HoloStat({ label, value, sub, tone = 'holo', size = 'lg', align = 'left', subTone = 'muted', style }: HoloStatProps) {
  const holoNumeral = size === 'lg' || size === 'xl';
  const fill = tone === 'good' || tone === 'warn' || tone === 'bad' ? tone : tone === 'ink' ? 'ink' : 'holo';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: holoNumeral ? 4 : 3,
        // Numbers never break across lines; the stat keeps its numeral's width.
        flexShrink: 0,
        maxWidth: '100%',
        textAlign: align,
        alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: FONT_PIXEL,
          fontSize: size === 'sm' ? 9.5 : 10.5,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: INK.soft,
          lineHeight: 1.2,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      {holoNumeral ? (
        <HoloTitle as="div" size={size === 'xl' ? 'lg' : 'md'} fill={fill} style={{ textTransform: 'none', marginLeft: -3, whiteSpace: 'nowrap', overflowWrap: 'normal', maxWidth: 'none' }}>
          {value}
        </HoloTitle>
      ) : (
        <div
          style={{
            fontFamily: FONT_TEXT,
            fontWeight: 700,
            fontSize: size === 'sm' ? 14 : 20,
            lineHeight: 1.1,
            color: tone === 'holo' ? INK.body : inkFor(tone),
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </div>
      )}
      {sub != null && sub !== false && (
        <div style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.35, color: inkFor(subTone) }}>{sub}</div>
      )}
    </div>
  );
}

export default HoloStat;
