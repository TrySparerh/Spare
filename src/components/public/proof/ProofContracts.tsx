/**
 * The ten contracts: Blockscout link, deploy block + creation tx (from the
 * committed creation record), live bytecode check, and a live Sourcify
 * verdict per address, including which source file Sourcify matched.
 */
import { Addr, DataTable, DocSection, P } from '@/components/public/PublicShell';
import { HoloBadge, INK } from '@/components/retro/holo';
import { DEPLOYMENT_RECORD, SPARE_CONTRACTS } from '@/components/public/live/addressBook';
import { useSpareBytecode } from '@/components/public/PublicShell';
import { txUrl } from '@/lib/spare-chain/addresses';
import { Trans, formatDateTime, useTranslation } from '@/i18n';
import creation from '../../../../contracts/deployments/4663-contracts.json';
import { CodeBadge, Ext, RepoLink, SourceTag, SourcifyBadge, TAGS } from './ProofAtoms';
import { blockNo, isVerified, shortCompiler, type SourcifyView } from './proofLogic';
import type { useSourcify } from './useProofData';

interface CreationEntry {
  name: string;
  source: string;
  address: string;
  creationTx: string;
  block: number;
}

const RECORD = creation as unknown as {
  compiler: { solc: string; viaIR: boolean; optimizer: { enabled: boolean; runs: number } };
  contracts: CreationEntry[];
};

const byName = new Map(RECORD.contracts.map((c) => [c.name, c]));
const firstBlock = Math.min(...RECORD.contracts.map((c) => c.block));

/** contracts/addresses/4663.json deployedAt (unix seconds). */
const DEPLOYED_AT_SEC = Number((DEPLOYMENT_RECORD as { deployedAt?: number }).deployedAt ?? 0);

export function ProofContracts({
  id,
  kicker,
  label,
  sourcify,
}: {
  id: string;
  kicker: string;
  label: string;
  sourcify: ReturnType<typeof useSourcify>;
}) {
  const { t } = useTranslation('proof');
  const code = useSpareBytecode();
  const verified = SPARE_CONTRACTS.filter((c) => isVerified(sourcify.byAddress.get(c.address.toLowerCase()))).length;
  const answered = SPARE_CONTRACTS.filter((c) => sourcify.byAddress.has(c.address.toLowerCase())).length;
  const date = formatDateTime(DEPLOYED_AT_SEC * 1000, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

  const sourceCell = (name: string, address: string) => {
    const v: SourcifyView | undefined = sourcify.byAddress.get(address.toLowerCase());
    const expected = byName.get(name)?.source ?? null;
    const matched = v?.qualifiedName ?? null;
    const mismatch = isVerified(v) && !!expected && !!matched && matched !== expected;
    return (
      <span className="pf-stack">
        <span>
          <SourcifyBadge view={v} address={address} />
        </span>
        {isVerified(v) && matched && !mismatch && (
          <span className="pf-small" translate="no">
            {t('contracts.verifiedAs', { name: matched, version: shortCompiler(v?.compilerVersion) ?? '—' })}
          </span>
        )}
        {mismatch && (
          <span className="pf-small" style={{ color: INK.bad }} translate="no">
            {t('contracts.nameMismatch', { name: matched, expected })}
          </span>
        )}
      </span>
    );
  };

  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <P>{t('contracts.intro', { date: `${date} UTC`, block: blockNo(firstBlock) })}</P>

      <div className="pf-row">
        <SourceTag kind="live" />
        {answered < SPARE_CONTRACTS.length ? (
          <HoloBadge label={t('hero.verifying')} tone="muted" pulse />
        ) : (
          <HoloBadge
            label={t('contracts.summary', { n: verified, total: SPARE_CONTRACTS.length })}
            tone={verified === SPARE_CONTRACTS.length ? 'good' : 'warn'}
            variant="fill"
          />
        )}
      </div>

      <DataTable
        head={[t('contracts.head.contract'), t('contracts.head.address'), t('contracts.head.deployed'), t('contracts.head.bytecode'), t('contracts.head.source')]}
        minWidth={760}
        stack
        rowKey={(_, i) => SPARE_CONTRACTS[i].name}
        rows={SPARE_CONTRACTS.map((c) => {
          const rec = byName.get(c.name);
          return [
            <strong key="n" translate="no">
              {c.name}
            </strong>,
            <Addr key="a" address={c.address} />,
            rec ? (
              <span key="b" className="pf-stack">
                <span className="pf-mono">#{blockNo(rec.block)}</span>
                <Ext href={txUrl(rec.creationTx)}>{t('contracts.tx')} ↗</Ext>
              </span>
            ) : (
              '—'
            ),
            <CodeBadge key="c" ok={code.data?.[c.name]} loading={code.isLoading} />,
            <span key="s">{sourceCell(c.name, c.address)}</span>,
          ];
        })}
        caption={t('contracts.caption')}
      />

      <div className="pf-row">
        <SourceTag kind="record" />
        <span className="pf-small">
          {t('contracts.compiler', {
            solc: shortCompiler(RECORD.compiler.solc) ?? RECORD.compiler.solc,
            runs: RECORD.compiler.optimizer.runs,
          })}
        </span>
      </div>

      <p className="pf-small">{t('contracts.matchNote')}</p>

      <P>
        <Trans t={t} i18nKey="contracts.reproduce" components={TAGS} />{' '}
        <RepoLink path="contracts/scripts/verify-blockscout.sh">{t('contracts.reproduceLink')}</RepoLink>{' '}
        <RepoLink path="contracts/deployments/4663-contracts.json">{t('contracts.recordLink')}</RepoLink>
      </P>
    </DocSection>
  );
}
