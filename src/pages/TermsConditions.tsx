/**
 * /terms — Spare Terms of Use.
 *
 * Spare text only. No legal entity is named and no governing-law
 * jurisdiction has been chosen yet, so the terms state neither; the
 * published contact channels are X @TrySpareRH and Telegram t.me/sparerh.
 * The risks section renders the Docs risks list verbatim (components/public/risks.ts).
 *
 * Text: pages-a namespace (`terms.*`, risks in `risks.items.*`). Chinese is for
 * convenience; LegalDoc shows the English-governs notice above it.
 */
import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import { PublicShell, useSectionSpy } from '@/components/public/PublicShell';
import { LegalDoc, LLink, LList, LP, legalSidebar, type LegalSection } from '@/components/public/LegalDoc';
import { addressUrl, shortAddr } from '@/lib/spare-chain/addresses';
import { SPARE_OWNER, SPARE_RISK_KEYS } from '@/components/public/risks';
import { Trans, useLang, useTranslation } from '@/i18n';

const X = 'https://x.com/TrySpareRH';
const TG = 'https://t.me/sparerh';

/** Section ids (also the /terms#… anchors). */
const IDS = [
  'agreement',
  'eligibility',
  'what',
  'authorisations',
  'fees',
  'execution',
  'risks',
  'third-party',
  'spare-token',
  'prohibited',
  'ip',
  'disclaimers',
  'liability',
  'changes',
  'law',
  'contact',
];

const LINKS = { x: <LLink href={X} />, tg: <LLink href={TG} /> };
const BOLD = { b: <strong /> };

function buildSections(t: TFunction<'pages-a'>): LegalSection[] {
  /**
   * Risks — rendered from the same keys as Docs §risks (verbatim), so the
   * audit and admin-key wording is identical on
   * both pages. Edit the text in the pages-a dictionaries (`risks.items.*`) only.
   */
  const risks = [
    ...SPARE_RISK_KEYS.map((k) => <Trans key={k} t={t} i18nKey={k} components={BOLD} />),
    <Trans
      key="owner"
      t={t}
      i18nKey="terms.risks.owner"
      values={{ address: shortAddr(SPARE_OWNER) }}
      components={{ owner: <LLink href={addressUrl(SPARE_OWNER)} /> }}
    />,
  ];
  const plain = (id: string, title: string, body: string): LegalSection => ({ id, title, body: <LP>{body}</LP> });

  return [
    plain('agreement', t('terms.agreement.title'), t('terms.agreement.body')),
    plain('eligibility', t('terms.eligibility.title'), t('terms.eligibility.body')),
    plain('what', t('terms.what.title'), t('terms.what.body')),
    plain('authorisations', t('terms.authorisations.title'), t('terms.authorisations.body')),
    plain('fees', t('terms.fees.title'), t('terms.fees.body')),
    plain('execution', t('terms.execution.title'), t('terms.execution.body')),
    { id: 'risks', title: t('terms.risks.title'), body: <LList items={risks} /> },
    plain('third-party', t('terms.thirdParty.title'), t('terms.thirdParty.body')),
    plain('spare-token', '$SPARE', t('terms.spareToken.body')),
    plain('prohibited', t('terms.prohibited.title'), t('terms.prohibited.body')),
    plain('ip', t('terms.ip.title'), t('terms.ip.body')),
    plain('disclaimers', t('terms.disclaimers.title'), t('terms.disclaimers.body')),
    plain('liability', t('terms.liability.title'), t('terms.liability.body')),
    plain('changes', t('terms.changes.title'), t('terms.changes.body')),
    plain('law', t('terms.law.title'), t('terms.law.body')),
    {
      id: 'contact',
      title: t('terms.contact.title'),
      body: (
        <LP>
          <Trans t={t} i18nKey="terms.contact.body" components={LINKS} />
        </LP>
      ),
    },
  ];
}

const TermsConditions = () => {
  const { t } = useTranslation('pages-a');
  const lang = useLang();
  const [activeId, onSelect] = useSectionSpy(IDS);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: rebuild on a language switch
  const sections = useMemo(() => buildSections(t), [t, lang]);
  const title = t('terms.meta.title');
  return (
    <PublicShell
      kicker={t('legal.kicker')}
      title={title}
      subtitle={t('terms.meta.subtitle')}
      version={t('legal.version')}
      pageTitle={t('terms.meta.pageTitle')}
      metaDescription={t('terms.meta.description')}
      art="/icons/spare-logo.png"
      sidebar={legalSidebar(title, sections)}
      activeId={activeId}
      onSelect={onSelect}
    >
      <LegalDoc sections={sections} other={{ to: '/privacy', label: t('terms.otherLink') }} />
    </PublicShell>
  );
};

export default TermsConditions;
