/**
 * LetterIcon — a letter tile that stands in for a custom 8-bit pixel icon.
 * Every spot that will eventually hold a custom icon
 * renders <LetterIcon letter="X" /> for now. Grep for "LetterIcon" to find
 * all swap targets.
 *
 * Variants:
 *   size:  'sm' (16px) | 'md' (32px) | 'lg' (48px) | 'xl' (64px)
 *   tone:  'cyan' | 'amber' | 'green' | 'red' | 'magenta' | 'mono' | 'blue'
 */
import { CSSProperties } from 'react';

type Size = 'sm' | 'md' | 'lg' | 'xl';
type Tone = 'cyan' | 'amber' | 'green' | 'red' | 'magenta' | 'mono' | 'blue';

const SIZE_PX: Record<Size, number> = { sm: 16, md: 32, lg: 48, xl: 64 };
// Spare Holo: every tile is a deep-indigo screen; the letter carries the tone
// in a pastel-lit colour.
const TONE_FG: Record<Tone, string> = {
  cyan: '#BDEBFF',
  amber: '#FFD37A',
  green: '#7CF5C8',
  red: '#FF8FB0',
  magenta: '#FFB8E0',
  mono: '#FFF6EE',
  blue: '#C9B6FF',
};
const TONE_BG: Record<Tone, string> = {
  cyan: '#1B1450',
  amber: '#1B1450',
  green: '#1B1450',
  red: '#1B1450',
  magenta: '#1B1450',
  mono: '#1B1450',
  blue: '#1B1450',
};

interface LetterIconProps {
  letter: string;
  size?: Size;
  tone?: Tone;
  style?: CSSProperties;
}

export function LetterIcon({ letter, size = 'lg', tone = 'cyan', style }: LetterIconProps) {
  const px = SIZE_PX[size];
  return (
    <div
      style={{
        width: px,
        height: px,
        background: TONE_BG[tone],
        boxShadow:
          'inset -1px -1px 0 0 #2A1B6E, inset 1px 1px 0 0 #ffffff, inset -2px -2px 0 0 #A897EC, inset 2px 2px 0 0 #F7F2FF',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'VT323, "Courier New", monospace',
        fontSize: Math.round(px * 0.65),
        color: TONE_FG[tone],
        textShadow: `1px 1px 0 #2A1B6E`,
        lineHeight: 1,
        userSelect: 'none',
        flexShrink: 0,
        ...style,
      }}
    >
      {letter.charAt(0).toUpperCase()}
    </div>
  );
}

export default LetterIcon;
