/**
 * My Spare — the folder window: one "drive" per Spare app. Each drive uses the
 * matching app's real icon from the window registry, so the pixel art matches
 * the desktop and the Start menu.
 */
import { tKey, useTranslation } from '@/i18n';
import { AppIcon } from '../AppIcon';
import { useWindowManager } from '../WindowManager';
import {
  FONT_CHROME,
  FONT_PIXEL,
  FONT_TEXT,
  HOLO,
  INK,
  HoloBadge,
  HoloCard,
  HoloWindowBody,
} from '@/components/retro/holo';

interface Drive {
  letter: string;
  /** i18n key: the app's shared name (shell:appNames.*). */
  label: string;
  /** i18n key (apps-b). */
  description: string;
  appId: string;
}

const DRIVES: Drive[] = [
  { letter: 'A:', label: tKey('shell:appNames.fund-wallet'), description: tKey('mySpare.desc.fundWallet'), appId: 'fund-wallet' },
  { letter: 'C:', label: tKey('shell:appNames.spare-balance'), description: tKey('mySpare.desc.spareBalance'), appId: 'spare-balance' },
  { letter: 'D:', label: tKey('shell:appNames.link-wallet'), description: tKey('mySpare.desc.linkWallet'), appId: 'link-wallet' },
  { letter: 'E:', label: tKey('shell:appNames.roundup-rules'), description: tKey('mySpare.desc.roundupRules'), appId: 'roundup-rules' },
  { letter: 'F:', label: tKey('shell:appNames.stock-mix'), description: tKey('mySpare.desc.stockMix'), appId: 'stock-mix' },
  { letter: 'G:', label: tKey('shell:appNames.auto-invest'), description: tKey('mySpare.desc.autoInvest'), appId: 'auto-invest' },
  { letter: 'H:', label: tKey('shell:appNames.spare-activity'), description: tKey('mySpare.desc.activity'), appId: 'spare-activity' },
  { letter: 'V:', label: tKey('shell:appNames.viewing-key'), description: tKey('mySpare.desc.viewingKey'), appId: 'viewing-key' },
];

export function MySpareApp() {
  const { t } = useTranslation('apps-b');
  const wm = useWindowManager();

  // Resolve each drive to its AppDescriptor — that's where the icon comes from.
  const drives = DRIVES.map((d) => ({ drive: d, app: wm.apps.find((a) => a.id === d.appId) })).filter(
    (x): x is { drive: Drive; app: NonNullable<typeof x.app> } => !!x.app,
  );

  return (
    <HoloWindowBody padding={12} gap={10}>
      <HoloCard
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <img src="/icons/spare-logo.png" alt="" width={16} height={16} style={{ display: 'block' }} />
            {t('shell:appNames.my-spare')}
          </span>
        }
        accent={t('mySpare.drives', { count: drives.length })}
        accentTone="info"
        compact
      >
        <span style={{ fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.5, color: INK.muted }}>
          {t('mySpare.tagline')}
        </span>
      </HoloCard>

      <div
        role="list"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(150px, 100%), 1fr))',
          gap: 10,
        }}
      >
        {drives.map(({ drive, app }) => (
          <button
            key={drive.letter}
            role="listitem"
            type="button"
            onClick={() => wm.openApp(drive.appId)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '10px 8px',
              background: 'rgba(255,255,255,.55)',
              border: 0,
              boxShadow: `inset 0 0 0 1px ${HOLO.bevelLo}, 2px 2px 0 0 rgba(42,27,110,.12)`,
              cursor: 'pointer',
              textAlign: 'center',
              color: HOLO.ink,
            }}
          >
            <AppIcon app={app} size={48} letterSize="lg" />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
              <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, lineHeight: 1.05 }}>{t(drive.label)}</span>
              <HoloBadge label={drive.letter} variant="solid" />
              <span style={{ fontFamily: FONT_TEXT, fontSize: 10.5, lineHeight: 1.35, color: HOLO.inkMuted }}>{t(drive.description)}</span>
            </span>
          </button>
        ))}
      </div>

      <span style={{ fontFamily: FONT_PIXEL, fontSize: 9.5, letterSpacing: 1, color: INK.muted, textAlign: 'center' }}>
        {/* i18n-ignore: chain name and id, never translated */}
        ROBINHOOD CHAIN · 4663
      </span>
    </HoloWindowBody>
  );
}

export default MySpareApp;
