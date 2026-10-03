/**
 * /proof — what Spare built and how anyone can check it.
 *
 * For a skeptical reader (or their AI) deciding whether Spare is real: the
 * architecture and money path, the ten contracts with live Sourcify
 * verification, who controls what (read live, including the single owner
 * key), the safety rails with their live on-chain values, liveness of the
 * system, how to replay the money path on a local fork, and the audit record.
 *
 * Every LIVE value is read in the browser from Robinhood Chain (public RPC),
 * Sourcify or the Spare API; a read that fails shows "—", never a fallback
 * number. No usage figures, no wallet activity, no user addresses: only the
 * protocol's own contracts and role holders.
 *
 * Text: the `proof` namespace. Section pieces: src/components/public/proof/.
 */
import { PublicShell, useSectionSpy, type PublicSidebarSection } from '@/components/public/PublicShell';
import { HoloBadge } from '@/components/retro/holo';
import { SPARE_CONTRACTS } from '@/components/public/live/addressBook';
import { useUniverse } from '@/lib/spare-chain/hooks';
import { tKey, useTranslation } from '@/i18n';
import { PROOF_CSS } from '@/components/public/proof/proofStyles';
import { ProofArchitecture } from '@/components/public/proof/ProofArchitecture';
import { ProofContracts } from '@/components/public/proof/ProofContracts';
import { ProofControl } from '@/components/public/proof/ProofControl';
import { ProofRails } from '@/components/public/proof/ProofRails';
import { ProofStatus } from '@/components/public/proof/ProofStatus';
import { ProofRun } from '@/components/public/proof/ProofRun';
import { ProofAudit } from '@/components/public/proof/ProofAudit';
import { useDuration } from '@/components/public/proof/ProofAtoms';
import { isVerified, summarizeRoles } from '@/components/public/proof/proofLogic';
import { useController, useProofHealth, useRailReads, useRoleReads, useSourcify } from '@/components/public/proof/useProofData';

/** Sidebar model: keys translated at render. */
const NAV: { label: string; items: { id: string; label: string; kicker: string }[] }[] = [
  {
    label: tKey('nav.group.built'),
    items: [
      { id: 'architecture', label: tKey('nav.architecture'), kicker: tKey('arch.kicker') },
      { id: 'contracts', label: tKey('nav.contracts'), kicker: tKey('contracts.kicker') },
    ],
  },
  {
    label: tKey('nav.group.trust'),
    items: [
      { id: 'control', label: tKey('nav.control'), kicker: tKey('control.kicker') },
      { id: 'rails', label: tKey('nav.rails'), kicker: tKey('rails.kicker') },
    ],
  },
  {
    label: tKey('nav.group.check'),
    items: [
      { id: 'status', label: tKey('nav.status'), kicker: tKey('status.kicker') },
      { id: 'run', label: tKey('nav.run'), kicker: tKey('run.kicker') },
      { id: 'audit', label: tKey('nav.audit'), kicker: tKey('audit.kicker') },
    ],
  },
];
const IDS = NAV.flatMap((g) => g.items.map((i) => i.id));
const ITEM = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i])));

const CONTRACT_ADDRESSES = SPARE_CONTRACTS.map((c) => c.address);

export default function Proof() {
  const { t } = useTranslation('proof');
  const [active, select] = useSectionSpy(IDS);
  const dur = useDuration();

  const sourcify = useSourcify(CONTRACT_ADDRESSES);
  const roles = useRoleReads();
  const summary = summarizeRoles(roles.rows);
  const ownerCtl = useController(summary.owner);
  const pauserCtl = useController(summary.pauser);
  const rails = useRailReads();
  const universe = useUniverse({ enabled: true });
  const { health, checking } = useProofHealth();

  const sidebar: PublicSidebarSection[] = NAV.map((g) => ({ label: t(g.label), items: g.items.map((i) => ({ id: i.id, label: t(i.label) })) }));
  const sec = (id: string) => ({ id, label: t(ITEM[id].label), kicker: t(ITEM[id].kicker) });

  // Hero: the four answers a skeptic wants first, each one live or plainly static.
  const verified = CONTRACT_ADDRESSES.filter((a) => isVerified(sourcify.byAddress.get(a.toLowerCase()))).length;
  const allAnswered = CONTRACT_ADDRESSES.every((a) => sourcify.byAddress.has(a.toLowerCase()));
  const ov = ownerCtl.view;
  const ownerBadge =
    ov?.kind === 'eoa'
      ? { label: t('hero.ownerEoa'), tone: 'warn' as const }
      : ov?.kind === 'timelock'
        ? { label: t('hero.ownerTimelock', { delay: dur(ov.minDelaySec ?? 0) }), tone: 'good' as const }
        : ov?.kind === 'safe'
          ? { label: t('hero.ownerSafe', { threshold: ov.threshold ?? '—', owners: ov.owners ?? '—' }), tone: 'info' as const }
          : ov?.kind === 'contract'
            ? { label: t('hero.ownerContract'), tone: 'info' as const }
            : { label: t('hero.ownerChecking'), tone: 'muted' as const };

  return (
    <PublicShell
      pageTitle={t('meta.pageTitle')}
      metaDescription={t('meta.description')}
      kicker={t('meta.kicker')}
      title={t('meta.title')}
      subtitle={t('meta.subtitle')}
      heroSeed={17}
      sidebar={sidebar}
      activeId={active}
      onSelect={select}
      heroExtra={
        <div className="pf-herobadges">
          {allAnswered ? (
            <HoloBadge
              label={t('hero.verified', { n: verified, total: CONTRACT_ADDRESSES.length })}
              tone={verified === CONTRACT_ADDRESSES.length ? 'good' : 'warn'}
              variant="fill"
            />
          ) : (
            <HoloBadge label={t('hero.verifying')} tone="muted" pulse />
          )}
          <HoloBadge label={ownerBadge.label} tone={ownerBadge.tone} variant="fill" pulse={ownerBadge.tone === 'muted'} />
          <HoloBadge label={t('hero.exit')} tone="good" variant="fill" />
          <HoloBadge label={t('hero.noHumanAudit')} tone="warn" variant="fill" />
        </div>
      }
    >
      <style>{PROOF_CSS}</style>
      <ProofArchitecture {...sec('architecture')} />
      <ProofContracts {...sec('contracts')} sourcify={sourcify} />
      <ProofControl {...sec('control')} roles={roles} ownerCtl={ownerCtl} pauserCtl={pauserCtl} assets={universe.assets} />
      <ProofRails {...sec('rails')} rails={rails} assets={universe.assets} />
      <ProofStatus {...sec('status')} health={health} checking={checking} assets={universe.assets} universeLoading={universe.isLoading} />
      <ProofRun {...sec('run')} />
      <ProofAudit {...sec('audit')} />
    </PublicShell>
  );
}
