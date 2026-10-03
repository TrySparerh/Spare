/**
 * HoloNotice — a Win98 message box, pastel edition: pixel icon tile + title +
 * copy (+ optional action). For status messages: info, warnings, errors, success.
 *
 *   <HoloNotice tone="warn" title="Wrong network">Your wallet is on chain 1…</HoloNotice>
 *   <HoloNotice tone="error" compact>Could not read the rule: …</HoloNotice>
 */
import type { CSSProperties, ReactNode } from 'react';
import { HoloMessageIcon, type HoloMessageKind } from './HoloGlyphs';
import { FONT_CHROME, FONT_TEXT, HOLO, INK_ON_LIGHT } from './tokens';

export interface HoloNoticeProps {
  tone?: HoloMessageKind;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons / links on the right (wraps below on narrow widths). */
  action?: ReactNode;
  /** Replace the pixel icon. Pass null to hide it. */
  icon?: ReactNode | null;
  /** Single-line density for inline warnings. */
  compact?: boolean;
  /** 'status' (polite, default) · 'alert' (assertive — errors that block an action) · 'none'. */
  live?: 'status' | 'alert' | 'none';
  style?: CSSProperties;
}

const BG: Record<HoloMessageKind, string> = {
  info: 'linear-gradient(135deg, #FFFFFF 0%, #F3EEFF 60%, #E8E2FF 100%)',
  warn: 'linear-gradient(135deg, #FFFDF6 0%, #FFF1DC 60%, #FFE6C7 100%)',
  error: 'linear-gradient(135deg, #FFFBFC 0%, #FFE6EE 60%, #FFD6E3 100%)',
  success: 'linear-gradient(135deg, #FBFFFD 0%, #E3FBF1 60%, #D2F6E8 100%)',
};

const STRIPE: Record<HoloMessageKind, string> = {
  info: HOLO.lilac,
  warn: HOLO.warnFill,
  error: HOLO.badFill,
  success: HOLO.goodFill,
};

const TITLE_INK: Record<HoloMessageKind, string> = {
  info: HOLO.ink,
  warn: HOLO.warnInk,
  error: HOLO.badInk,
  success: HOLO.goodInk,
};

export function HoloNotice({ tone = 'info', title, children, action, icon, compact = false, live = 'status', style }: HoloNoticeProps) {
  const role = live === 'none' ? undefined : live;
  return (
    <div
      role={role}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: compact ? 'center' : 'flex-start',
        flexWrap: 'wrap',
        gap: compact ? 8 : 12,
        padding: compact ? '6px 10px 6px 12px' : '10px 12px 10px 14px',
        background: BG[tone],
        border: `2px solid ${HOLO.ink}`,
        boxShadow: `inset 4px 0 0 0 ${STRIPE[tone]}, inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.18)`,
        ...INK_ON_LIGHT,
        minWidth: 0,
        ...style,
      }}
    >
      {icon !== null && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon ?? <HoloMessageIcon kind={tone} size={compact ? 20 : 28} />}</span>}
      <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {title && (
          <div style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: compact ? 17 : 19, lineHeight: 1.05, color: TITLE_INK[tone] }}>{title}</div>
        )}
        {children && <div style={{ fontFamily: FONT_TEXT, fontSize: compact ? 11.5 : 12, lineHeight: 1.55, color: HOLO.ink }}>{children}</div>}
      </div>
      {action && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

export default HoloNotice;
