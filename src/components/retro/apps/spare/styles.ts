/**
 * Layout / type atoms shared by the Spare apps (kept apart from components for fast refresh).
 *
 * Colours come from the Holo ink context (INK.*), so the same HINT or
 * KEY_LABEL reads indigo on a pastel surface and cream / lilac inside a
 * deep-indigo screen (MutedWell, HoloScreen).
 */
import type { CSSProperties } from 'react';
import { FONT_CHROME, FONT_TEXT, INK } from '@/components/retro/holo/tokens';

/**
 * Status tone an app derives for a row or check before it picks a HoloTone:
 * up → good, down → bad, mono → ink; the rest keep their name.
 */
export type Tone = 'up' | 'down' | 'warn' | 'info' | 'mono' | 'muted';

export const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
export const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
/** Field label ("ROUND UP TO"). Pixel UI sans, full-strength ink. */
export const KEY_LABEL: CSSProperties = {
  fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 17, color: INK.body, letterSpacing: 0.6, minWidth: 104, lineHeight: 1.1,
};
/** Explanatory copy. Poster mono, muted ink. */
export const HINT: CSSProperties = {
  fontFamily: FONT_TEXT, fontWeight: 400, fontSize: 11, color: INK.muted, letterSpacing: 0, lineHeight: 1.55,
};
/** Needs-attention copy. Poster mono, warn ink. */
export const NOTE: CSSProperties = {
  fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 11.5, color: INK.warn, letterSpacing: 0, lineHeight: 1.55,
};
