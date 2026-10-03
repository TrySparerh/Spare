/**
 * SpareWelcome — the first-run dialog on the Spare desktop (phones and
 * desktop). It offers to start setting up round-ups (Link Wallet is step one)
 * or to look around, and says plainly that $SPARE isn't live yet.
 *
 * Retro only shows it to a visitor without a round-up rule on-chain; a wallet
 * that already has one boots straight into Spare Balance instead.
 *
 * The i18n example in src/i18n/README.md: every visible string, tooltip and
 * aria-label comes from the `shell` namespace; brand and token names ($SPARE)
 * stay literal.
 */
import { SPARE_CA } from '@/lib/config';
import { useTranslation } from '@/i18n';
import { Win98Dialog } from './Win98Dialog';
import { FONT_PIXEL, FONT_TEXT, GRADIENT, HOLO, TEXTURE } from './holo/tokens';
import { HoloTitle } from './holo/HoloTitle';

interface SpareWelcomeProps {
  /** "Set up round-ups": open Link Wallet. */
  onSetUp: () => void;
  /** "Look around" or the close box. */
  onClose: () => void;
  width?: number;
}

export function SpareWelcome({ onSetUp, onClose, width = 460 }: SpareWelcomeProps) {
  const { t } = useTranslation('shell');
  const soonTooltip = t('common.spareSoonTooltip');
  return (
    <Win98Dialog
      title={t('welcome.title')}
      iconSrc="/icons/spare-logo.png"
      width={width}
      onClose={onClose}
      buttons={[
        { label: t('welcome.setUp'), primary: true, onClick: onSetUp },
        { label: t('welcome.lookAround'), onClick: onClose },
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <HoloTitle as="div" size="sm">
          {t('welcome.title')}
        </HoloTitle>
        <div style={{ fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.55, color: HOLO.ink }}>{t('welcome.body')}</div>
        {!SPARE_CA && (
          <div
            title={soonTooltip}
            aria-label={t('welcome.spareSoonAria', { tooltip: soonTooltip })}
            style={{
              marginTop: 2,
              background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen}`,
              boxShadow: `0 0 0 2px ${HOLO.ink}, inset 0 0 0 1px ${HOLO.screenLine}`,
              padding: '8px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              cursor: 'default',
            }}
          >
            <span style={{ color: HOLO.onScreenSubtle, fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1 }}>$SPARE</span>
            <span style={{ flex: 1, color: HOLO.lilac, fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13, letterSpacing: 0.5 }}>
              {t('common.soon')}
            </span>
            <span style={{ color: HOLO.onScreenSubtle, fontFamily: FONT_TEXT, fontSize: 10.5, lineHeight: 1.35, textAlign: 'right' }}>
              {t('welcome.spareNotLive')}
            </span>
          </div>
        )}
      </div>
    </Win98Dialog>
  );
}

export default SpareWelcome;
