/**
 * "Run it yourself": replay the money path on a local fork of mainnet. The
 * command lives in PROVE_COMMAND (proofLogic.ts); the clone line appears only
 * once SPARE_REPO_URL is set.
 */
import { Bullets, CodeBlock, DocSection, GlassCard, P } from '@/components/public/PublicShell';
import { HoloNotice } from '@/components/retro/holo';
import { tKey, useTranslation } from '@/i18n';
import { SPARE_REPO_URL, repoIsSet, runCommands } from './proofLogic';

const CHECKS = [
  tKey('run.checks.accrual'),
  tKey('run.checks.buys'),
  tKey('run.checks.delivery'),
  tKey('run.checks.claim'),
  tKey('run.checks.exit'),
];

export function ProofRun({ id, kicker, label }: { id: string; kicker: string; label: string }) {
  const { t } = useTranslation('proof');
  const code = runCommands(SPARE_REPO_URL).join('\n');
  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <P>{t('run.intro')}</P>
      <P>{t('run.needs')}</P>
      {!repoIsSet() && (
        <HoloNotice tone="info" compact>
          {t('run.noRepo')}
        </HoloNotice>
      )}
      <CodeBlock code={code} title={t('run.codeTitle')} />
      <GlassCard title={t('run.checksTitle')} bar="lilac">
        <Bullets items={CHECKS.map((k) => t(k))} />
        <P>{t('run.output')}</P>
      </GlassCard>
    </DocSection>
  );
}
