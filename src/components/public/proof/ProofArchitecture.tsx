/**
 * "What was built": how to read the page, the pieces in plain words, and the
 * money path. Static copy (the contracts' roles); everything that can be
 * checked live is checked in the sections below.
 */
import { DocSection, GlassCard, P } from '@/components/public/PublicShell';
import { HoloNotice } from '@/components/retro/holo';
import { SPARE } from '@/lib/spare-chain/addresses';
import { Trans, tKey, useTranslation } from '@/i18n';
import { MoneyPath } from './MoneyPath';
import { TAGS } from './ProofAtoms';

type SpareName = keyof typeof SPARE;

/** The contracts in the order money meets them; the two park adapters share one line. */
const ONCHAIN: { names: SpareName[]; body: string }[] = [
  { names: ['RuleRegistry'], body: tKey('arch.parts.ruleRegistry') },
  { names: ['SweepExecutor'], body: tKey('arch.parts.sweepExecutor') },
  { names: ['CashPark'], body: tKey('arch.parts.cashPark') },
  { names: ['UsdgParkAdapter', 'SgovParkAdapter'], body: tKey('arch.parts.parkAdapters') },
  { names: ['StockRouter'], body: tKey('arch.parts.stockRouter') },
  { names: ['AssetRegistry'], body: tKey('arch.parts.assetRegistry') },
  { names: ['ElectionRegistry'], body: tKey('arch.parts.electionRegistry') },
  { names: ['ScreeningGate'], body: tKey('arch.parts.screeningGate') },
  { names: ['FeeVault'], body: tKey('arch.parts.feeVault') },
];

const OFFCHAIN: { name: string; body: string }[] = [
  { name: tKey('arch.keeperName'), body: tKey('arch.parts.keeper') },
  { name: tKey('arch.apiName'), body: tKey('arch.parts.api') },
];

export function ProofArchitecture({ id, kicker, label }: { id: string; kicker: string; label: string }) {
  const { t } = useTranslation('proof');
  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <HoloNotice tone="info" title={t('legend.title')} compact>
        <span className="pf-stack">
          <span>
            <Trans t={t} i18nKey="legend.live" components={TAGS} />
          </span>
          <span>
            <Trans t={t} i18nKey="legend.record" components={TAGS} />
          </span>
          <span>
            <Trans t={t} i18nKey="legend.code" components={TAGS} />
          </span>
        </span>
      </HoloNotice>

      <P>{t('arch.intro')}</P>

      <GlassCard title={t('arch.pathTitle')} bar="lilac">
        <MoneyPath />
      </GlassCard>

      <GlassCard title={t('arch.onchainTitle')} accent={t('arch.onchainAccent')} accentTone="ink">
        <ul className="pf-parts">
          {ONCHAIN.map((p) => (
            <li key={p.names.join('+')} className="pf-part">
              <span className="pf-part__name" translate="no">
                {p.names.join(' · ')}
              </span>
              <span className="pf-part__body">
                <Trans t={t} i18nKey={p.body} components={TAGS} />
              </span>
            </li>
          ))}
        </ul>
        <p className="pf-small">{t('arch.onchainNote')}</p>
      </GlassCard>

      <GlassCard title={t('arch.offchainTitle')} bar="pink">
        <ul className="pf-parts">
          {OFFCHAIN.map((p) => (
            <li key={p.name} className="pf-part">
              <span className="pf-part__name">{t(p.name)}</span>
              <span className="pf-part__body">
                <Trans t={t} i18nKey={p.body} components={TAGS} />
              </span>
            </li>
          ))}
        </ul>
      </GlassCard>

      <HoloNotice tone="warn" compact>
        {t('shell:publicFrame.footer.legal')}
      </HoloNotice>
    </DocSection>
  );
}
