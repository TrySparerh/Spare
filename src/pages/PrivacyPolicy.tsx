/**
 * /privacy — Spare Privacy Policy.
 *
 * Spare text only. No legal entity is named (none has been provided); the
 * published contact channels are X @TrySpareRH and Telegram t.me/sparerh.
 * Nothing here claims privacy that isn't built: the private path is S2.
 *
 * Text: pages-a namespace (`privacy.*`). Chinese is for convenience; LegalDoc
 * shows the English-governs notice above it.
 */
import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import { PublicShell, useSectionSpy } from '@/components/public/PublicShell';
import { LegalDoc, LLink, LList, LP, legalSidebar, type LegalSection } from '@/components/public/LegalDoc';
import { Trans, useLang, useTranslation } from '@/i18n';

const X = 'https://x.com/TrySpareRH';
const TG = 'https://t.me/sparerh';

/** Section ids (also the /privacy#… anchors). */
const IDS = ['who', 'what', 'process', 'device', 'third-parties', 'onchain', 'security', 'children', 'changes'];

const LINKS = { x: <LLink href={X} />, tg: <LLink href={TG} /> };

function buildSections(t: TFunction<'pages-a'>): LegalSection[] {
  return [
    {
      id: 'who',
      title: t('privacy.who.title'),
      body: (
        <LP>
          <Trans t={t} i18nKey="privacy.who.body" components={LINKS} />
        </LP>
      ),
    },
    {
      id: 'what',
      title: t('privacy.what.title'),
      body: <LP>{t('privacy.what.body')}</LP>,
    },
    {
      id: 'process',
      title: t('privacy.process.title'),
      body: <LList items={[t('privacy.process.i1'), t('privacy.process.i2'), t('privacy.process.i3')]} />,
    },
    {
      id: 'device',
      title: t('privacy.device.title'),
      body: <LP>{t('privacy.device.body')}</LP>,
    },
    {
      id: 'third-parties',
      title: t('privacy.thirdParties.title'),
      body: <LP>{t('privacy.thirdParties.body')}</LP>,
    },
    {
      id: 'onchain',
      title: t('privacy.onchain.title'),
      body: <LP>{t('privacy.onchain.body')}</LP>,
    },
    {
      id: 'security',
      title: t('privacy.security.title'),
      body: <LP>{t('privacy.security.body')}</LP>,
    },
    {
      id: 'children',
      title: t('privacy.children.title'),
      body: <LP>{t('privacy.children.body')}</LP>,
    },
    {
      id: 'changes',
      title: t('privacy.changes.title'),
      body: (
        <LP>
          <Trans t={t} i18nKey="privacy.changes.body" components={LINKS} />
        </LP>
      ),
    },
  ];
}

const PrivacyPolicy = () => {
  const { t } = useTranslation('pages-a');
  const lang = useLang();
  const [activeId, onSelect] = useSectionSpy(IDS);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: rebuild on a language switch
  const sections = useMemo(() => buildSections(t), [t, lang]);
  const title = t('privacy.meta.title');
  return (
    <PublicShell
      kicker={t('legal.kicker')}
      title={title}
      subtitle={t('privacy.meta.subtitle')}
      version={t('legal.version')}
      pageTitle={t('privacy.meta.pageTitle')}
      metaDescription={t('privacy.meta.description')}
      art="/icons/spare-logo.png"
      sidebar={legalSidebar(title, sections)}
      activeId={activeId}
      onSelect={onSelect}
    >
      <LegalDoc sections={sections} other={{ to: '/terms', label: t('privacy.otherLink') }} />
    </PublicShell>
  );
};

export default PrivacyPolicy;
