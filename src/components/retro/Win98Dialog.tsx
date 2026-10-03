/**
 * Win98Dialog — modal dialog primitive in the Spare Holo skin. Centered
 * overlay, pastel bevelled frame, holo title bar, icon on the left, content +
 * buttons on the right. Used for confirms, alerts, etc.
 *
 * `title` and button labels arrive already translated (callers own their
 * strings); only the dialog's own close key is translated here.
 */
import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { LetterIcon } from './LetterIcon';
import { BEVEL_WINDOW, FONT_CHROME, FONT_TEXT, GRADIENT, HOLO, INK_ON_LIGHT, SHADOW, TEXTURE } from './holo/tokens';
import { GlyphClose } from './holo/HoloGlyphs';
import { HoloSparkles } from './holo/HoloSparkles';

interface Button {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface Win98DialogProps {
  title: string;
  iconLetter?: string;
  iconTone?: 'cyan' | 'amber' | 'green' | 'red' | 'magenta' | 'mono' | 'blue';
  /** Optional pixel-art icon. When set, replaces the LetterIcon for this dialog. */
  iconSrc?: string;
  children: ReactNode;
  buttons: Button[];
  onClose?: () => void;
  width?: number;
}

export function Win98Dialog({
  title,
  iconLetter = 'i',
  iconTone = 'cyan',
  iconSrc,
  children,
  buttons,
  onClose,
  width = 420,
}: Win98DialogProps) {
  const { t } = useTranslation('shell');
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: `${TEXTURE.dither} 0 0 / 4px 4px, rgba(42,27,110,0.28)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 12,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width,
          maxWidth: '100%',
          background: GRADIENT.face,
          boxShadow: `${BEVEL_WINDOW}, ${SHADOW.window}`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Title bar */}
        <div
          style={{
            height: 26,
            margin: '3px 3px 0 3px',
            background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar}`,
            boxShadow: `inset 0 -1px 0 0 ${HOLO.ink}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 3px 1px 7px',
          }}
        >
          <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 20, color: '#fff', textShadow: SHADOW.titleText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </span>
          <div style={{ flex: 1 }} />
          {onClose && (
            <button onClick={onClose} className="holo-winbtn holo-winbtn--close" aria-label={t('common.close')} title={t('common.close')}>
              <GlyphClose />
            </button>
          )}
        </div>

        {/* Body */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            gap: 16,
            padding: 20,
            margin: '0 3px',
            background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card}`,
            overflow: 'hidden',
            ...INK_ON_LIGHT,
          }}
        >
          <HoloSparkles count={4} seed={3} sizes={[6, 11]} avoidCenter={0.55} />
          <div style={{ flexShrink: 0, position: 'relative' }}>
            {iconSrc ? (
              <img
                src={iconSrc}
                alt=""
                width={48}
                height={48}
                style={{ imageRendering: 'pixelated', objectFit: 'contain', display: 'block', filter: 'drop-shadow(2px 2px 0 rgba(42,27,110,.25))' }}
                draggable={false}
              />
            ) : (
              <LetterIcon letter={iconLetter} tone={iconTone} size="lg" />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0, position: 'relative', fontFamily: FONT_TEXT, fontSize: 12.5, color: HOLO.ink, lineHeight: 1.55 }}>
            {children}
          </div>
        </div>

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: 8,
            padding: '12px 16px 14px 16px',
            margin: '0 3px 3px',
            background: GRADIENT.menuBar,
            boxShadow: `inset 0 1px 0 0 ${HOLO.bevelLo}`,
          }}
        >
          {buttons.map((b, i) => (
            <button
              key={i}
              onClick={b.onClick}
              autoFocus={b.primary}
              className={`holo-btn${b.primary ? ' holo-btn--primary' : ''}`}
              style={{ minWidth: 84 }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Win98Dialog;
