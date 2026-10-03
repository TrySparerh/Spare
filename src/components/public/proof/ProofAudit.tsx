/**
 * Audit and tests, as the repository records them: the AI-assisted audit of
 * 2026-10-02 (docs/audits/2026-10-02-ai-audit-grade.md), what changed in
 * response (CHANGELOG.md), the test numbers the report ran, and plainly: no
 * third-party human audit yet. Every number here is a RECORD from that report.
 */
import { DocSection, GlassCard, Grid, P, StatTile } from '@/components/public/PublicShell';
import { HoloBadge, HoloList, HoloListRow } from '@/components/retro/holo';
import { Trans, useTranslation } from '@/i18n';
import { RepoLink, SourceTag, TAGS } from './ProofAtoms';

/** From docs/audits/2026-10-02-ai-audit-grade.md ("Tests run", "Findings"). */
const REPORT = {
  path: 'docs/audits/2026-10-02-ai-audit-grade.md',
  grade: '5.2 / 10',
  foundryPassed: '266',
  invariants: '10',
  coverage: '92.2%',
} as const;

export function ProofAudit({ id, kicker, label }: { id: string; kicker: string; label: string }) {
  const { t } = useTranslation('proof');
  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <GlassCard title={t('audit.aiTitle')} accent={REPORT.grade} accentTone="ink">
        <P>{t('audit.p1', { grade: REPORT.grade })}</P>
        <HoloList>
          <HoloListRow label={t('audit.contractsLabel')} value={t('audit.contractsValue')} hint={t('audit.contractsHint')} />
          <HoloListRow label={t('audit.offchainLabel')} value={t('audit.offchainValue')} hint={t('audit.offchainHint')} />
          <HoloListRow label={t('audit.governanceLabel')} value={t('audit.governanceValue')} hint={t('audit.governanceHint')} />
        </HoloList>
        <P>
          <Trans t={t} i18nKey="audit.fixed" components={TAGS} />
        </P>
        <div className="pf-row">
          <SourceTag kind="record" />
          <RepoLink path={REPORT.path}>{t('audit.openReport')}</RepoLink>
          <RepoLink path="CHANGELOG.md">{t('audit.openChangelog')}</RepoLink>
          <RepoLink path="SECURITY.md">{t('audit.openSecurity')}</RepoLink>
        </div>
        <p className="pf-small">
          <Trans t={t} i18nKey="audit.where" components={TAGS} />
        </p>
      </GlassCard>

      <Grid min={170}>
        <StatTile label={t('audit.tests.foundry')} value={REPORT.foundryPassed} sub={t('audit.tests.foundrySub')} />
        <StatTile label={t('audit.tests.invariants')} value={REPORT.invariants} sub={t('audit.tests.invariantsSub')} />
        <StatTile label={t('audit.tests.coverage')} value={REPORT.coverage} sub={t('audit.tests.coverageSub')} />
      </Grid>
      <p className="pf-small">{t('audit.tests.note')}</p>

      <GlassCard title={t('audit.humanTitle')} accent={<HoloBadge label={t('audit.humanBadge')} tone="warn" variant="fill" />} bar="pink">
        <P>{t('audit.human')}</P>
      </GlassCard>
    </DocSection>
  );
}
