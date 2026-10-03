/**
 * Recycle Bin — the empty, joke window. There is nothing to restore: Spare
 * keeps no files, and everything Spare does is on Robinhood Chain for good.
 */
import { useWindowManager } from '../WindowManager';
import { useIsMobileNow } from '@/hooks/use-mobile';
import { phoneIconSrc } from '@/lib/phoneIcons';
import { tKey, useTranslation } from '@/i18n';
import {
  FONT_TEXT,
  INK,
  HoloButton,
  HoloCard,
  HoloPanel,
  HoloStat,
  HoloTitle,
  HoloWindowBody,
} from '@/components/retro/holo';

export function RecycleBinApp() {
  const { t } = useTranslation('apps-b');
  const wm = useWindowManager();
  // Phones only: the 128 px copy instead of the 1254 px original.
  const binIcon = phoneIconSrc('/icons/recycle-bin.png', useIsMobileNow());
  return (
    <HoloWindowBody padding={12} gap={10}>
      {/* i18n-ignore: a Win98 path, the same in every language */}
      <HoloCard title="C:\Recycled" icon={binIcon} accent={t('recycleBin.objects0')} accentTone="muted">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '14px 8px', textAlign: 'center' }}>
          <img src={binIcon} alt="" width={64} height={64} style={{ imageRendering: 'pixelated', opacity: 0.6 }} />
          <HoloTitle as="div" size="sm" align="center">
            {t('recycleBin.empty')}
          </HoloTitle>
          <span style={{ fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.5, color: INK.muted, maxWidth: 300 }}>
            {t('recycleBin.body')}
          </span>
        </div>
      </HoloCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {[
          { k: tKey('recycleBin.stats.objects'), v: '0' },
          { k: tKey('recycleBin.stats.size'), v: '0 B' },
          { k: tKey('recycleBin.stats.free'), v: '∞' },
        ].map((s) => (
          <HoloPanel key={s.k} variant="sunken" padding="6px 8px">
            <HoloStat label={t(s.k)} value={s.v} size="sm" align="center" />
          </HoloPanel>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
        <HoloButton size="sm" disabled>
          {t('recycleBin.emptyBtn')}
        </HoloButton>
        <HoloButton size="sm" disabled>
          {t('recycleBin.restoreAll')}
        </HoloButton>
        <div style={{ flex: 1 }} />
        <HoloButton size="sm" onClick={() => wm.closeApp('recycle-bin')}>
          {t('shell:common.close')}
        </HoloButton>
      </div>
    </HoloWindowBody>
  );
}

export default RecycleBinApp;
