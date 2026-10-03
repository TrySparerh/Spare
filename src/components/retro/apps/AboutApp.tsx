/**
 * About Spare — the Win98 "About" box: the Spare mark and the
 * SPARE / ROUNDUP ENGINE lockup on the brand sky, beside the system
 * properties (version, network, contracts) and what Spare does.
 *
 * The two columns sit side by side at the default window and stack on narrow
 * windows / phones (flex-wrap, no media query needed).
 */
import { Fragment, type ReactNode } from 'react';
import { version as APP_VERSION } from '../../../../package.json';
import { tKey, useTranslation } from '@/i18n';
import {
  FONT_CHROME,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  INK_ON_LIGHT,
  TEXTURE,
  HoloBadge,
  HoloCard,
  HoloDivider,
  HoloSparkles,
  HoloStar,
  HoloTitle,
  HoloWindowBody,
} from '@/components/retro/holo';

const VERSION = APP_VERSION;

/** [label key, value, value is a key?] — apps-b keys, translated at render. */
const PROPERTIES: Array<[string, ReactNode, boolean]> = [
  [tKey('about.props.version'), VERSION, false],
  [tKey('about.props.network'), 'Robinhood Chain (4663)', false],
  [tKey('about.props.contracts'), tKey('about.props.deployed'), true],
  [tKey('about.props.fee'), tKey('about.props.feeValue'), true],
  [tKey('about.props.token'), tKey('about.props.tokenValue'), true],
];

const LINK = {
  color: INK.link,
  fontWeight: 700,
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
} as const;

export function AboutApp() {
  const { t } = useTranslation('apps-b');
  return (
    <HoloWindowBody padding={10} gap={8}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
        <Lockup />
        <HoloCard title={t('about.title')} compact style={{ flex: '999 1 260px' }} bodyStyle={{ gap: 8 }}>
          <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 11, lineHeight: 1.45, color: INK.soft }}>
            {t('about.meta', { version: VERSION })}
          </span>
          <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.55, color: INK.body }}>{t('about.body')}</p>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12 }}>
            {PROPERTIES.map(([k, v, isKey], i) => {
              const rule = i < PROPERTIES.length - 1 ? `1px dashed ${HOLO.inkFaint}` : 0;
              return (
                <Fragment key={k}>
                  <dt style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 16, lineHeight: 1.1, color: INK.soft, padding: '2px 0', borderBottom: rule, whiteSpace: 'nowrap' }}>
                    {t(k)}
                  </dt>
                  <dd style={{ margin: 0, fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 11, lineHeight: 1.4, color: INK.body, padding: '3px 0 2px', borderBottom: rule, overflowWrap: 'anywhere' }}>
                    {isKey && typeof v === 'string' ? t(v) : v}
                  </dd>
                </Fragment>
              );
            })}
          </dl>
        </HoloCard>
      </div>

      <HoloDivider variant="checker" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: '2px 12px' }}>
        <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 11, lineHeight: 1.5, color: INK.body }}>
          {t('about.footer')}
        </span>
        <span style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.5, color: INK.muted, display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
          <a href="/docs" target="_blank" rel="noopener noreferrer" style={LINK}>
            {t('shell:appNames.docs')}
          </a>
          <a href="https://x.com/TrySpareRH" target="_blank" rel="noopener noreferrer" style={LINK}>
            X @TrySpareRH
          </a>
          <a href="https://t.me/sparerh" target="_blank" rel="noopener noreferrer" style={LINK}>
            Telegram
          </a>
        </span>
      </div>
    </HoloWindowBody>
  );
}

/** SPARE / ROUNDUP ENGINE on the brand sky, with the holographic mark. */
function Lockup() {
  const { t } = useTranslation('apps-b');
  return (
    <div
      style={{
        flex: '1 1 164px',
        position: 'relative',
        overflow: 'hidden',
        isolation: 'isolate',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '12px 8px 16px',
        textAlign: 'center',
        background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky}`,
        border: `2px solid ${HOLO.ink}`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.9), 4px 4px 0 0 rgba(42,27,110,.22)',
        ...INK_ON_LIGHT,
      }}
    >
      <HoloSparkles count={6} seed={3} sizes={[6, 13]} />
      {/* pixel horizon: halftone drifting up from the bottom edge */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '38%',
          pointerEvents: 'none',
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,.9) 0 1.2px, transparent 1.7px), radial-gradient(circle, rgba(107,79,224,.25) 0 1px, transparent 1.5px)',
          backgroundSize: '6px 6px, 6px 6px',
          backgroundPosition: '0 0, 3px 3px',
          WebkitMaskImage: 'linear-gradient(0deg, #000 0%, transparent 100%)',
          maskImage: 'linear-gradient(0deg, #000 0%, transparent 100%)',
        }}
      />
      <div style={{ position: 'relative' }}>
        <HoloStar size={72} animated />
      </div>
      <HoloTitle as="h1" size="md" align="center">Spare</HoloTitle>
      <HoloTitle as="div" font="pixel" fill="cream" size="xs" align="center" style={{ marginTop: -4 }}>
        {t('about.engine')}
      </HoloTitle>
      <HoloBadge label={t('about.versionBadge', { version: VERSION })} variant="solid" style={{ position: 'relative', marginTop: 2 }} />
    </div>
  );
}

export default AboutApp;
