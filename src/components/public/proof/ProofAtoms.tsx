/**
 * Small building blocks shared by the /proof sections: where a value came
 * from (LIVE / RECORD), inline code, repo links that hide while the repo URL
 * is unset, and the verification / controller badges. Text: `proof` namespace.
 */
import type { ReactNode } from 'react';
import { HoloBadge } from '@/components/retro/holo';
import { Code } from '@/components/public/PublicShell';
import { SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import { formatDate, useTranslation } from '@/i18n';
import {
  SPARE_REPO_URL,
  durationParts,
  repoLink,
  sourcifyPageUrl,
  type ControllerView,
  type SourcifyView,
} from './proofLogic';

/** Inline code (also the <c> tag inside translated sentences). */
export function C({ children }: { children?: ReactNode }) {
  return <Code>{children}</Code>;
}

/** The tags every translated sentence on the page may use. */
export const TAGS = { c: <C />, b: <strong /> };

/** Where a value came from: LIVE (read now), RECORD (a committed file) or CODE (a rule in the verified source). */
export function SourceTag({ kind }: { kind: 'live' | 'record' | 'code' }) {
  const { t } = useTranslation('proof');
  if (kind === 'live') return <HoloBadge label={t('tag.live')} tone="good" title={t('tag.liveTitle')} style={{ verticalAlign: 'middle' }} />;
  if (kind === 'code') return <HoloBadge label={t('tag.code')} tone="info" title={t('tag.codeTitle')} style={{ verticalAlign: 'middle' }} />;
  return <HoloBadge label={t('tag.record')} tone="muted" title={t('tag.recordTitle')} style={{ verticalAlign: 'middle' }} />;
}

/** An external link (new tab). */
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="pf-ext" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A link into Spare's repository; renders nothing while SPARE_REPO_URL is unset. */
export function RepoLink({ path, lines, children }: { path: string; lines?: readonly [number, number?]; children: ReactNode }) {
  const href = repoLink(SPARE_REPO_URL, path, lines);
  if (!href) return null;
  return <Ext href={href}>{children} ↗</Ext>;
}

/** Live Sourcify verdict for one address, linking to Sourcify's page for it. */
export function SourcifyBadge({ view, address }: { view: SourcifyView | undefined; address: string }) {
  const { t } = useTranslation('proof');
  const href = sourcifyPageUrl(SPARE_CHAIN_ID, address);
  let badge: ReactNode;
  if (!view) badge = <HoloBadge label={t('sourcify.checking')} tone="muted" pulse />;
  else if (view.kind === 'exact' || view.kind === 'match') {
    const when = view.verifiedAt ? formatDate(new Date(view.verifiedAt)) : null;
    badge = (
      <HoloBadge
        label={t(view.kind === 'exact' ? 'sourcify.exact' : 'sourcify.match')}
        tone="good"
        title={when ? t('sourcify.verifiedTitle', { date: when }) : undefined}
      />
    );
  } else if (view.kind === 'none') badge = <HoloBadge label={t('sourcify.none')} tone="bad" />;
  else badge = <HoloBadge label={t('sourcify.unknown')} tone="muted" title={t('sourcify.unknownTitle')} />;
  return (
    <a className="pf-badgelink" href={href} target="_blank" rel="noopener noreferrer" aria-label={t('sourcify.open')}>
      {badge}
    </a>
  );
}

/** Bytecode present at the address (live getCode). */
export function CodeBadge({ ok, loading }: { ok: boolean | null | undefined; loading: boolean }) {
  const { t } = useTranslation('proof');
  if (loading) return <HoloBadge label={t('code.checking')} tone="muted" pulse />;
  if (ok === true) return <HoloBadge label={t('code.deployed')} tone="good" />;
  if (ok === false) return <HoloBadge label={t('code.none')} tone="bad" />;
  return <HoloBadge label={t('code.unread')} tone="muted" title={t('code.unreadTitle')} />;
}

/** "48 h", "1 h 30 min", "45 s" in the live language. */
export function useDuration(): (sec: number | bigint | null | undefined) => string {
  const { t } = useTranslation('proof');
  return (sec) => {
    if (sec == null) return '—';
    const p = durationParts(sec);
    if (p.unit === 'h') return t('dur.h', { h: p.h });
    if (p.unit === 'hm') return t('dur.hm', { h: p.h, m: p.m });
    return t('dur.s', { s: p.s });
  };
}

/** SINGLE KEY / TIMELOCK / MULTISIG / CONTRACT, coloured by how much one key can do alone. */
export function ControllerBadge({ view, loading }: { view: ControllerView | null; loading: boolean }) {
  const { t } = useTranslation('proof');
  if (loading && !view) return <HoloBadge label={t('code.checking')} tone="muted" pulse />;
  switch (view?.kind) {
    case 'eoa':
      return <HoloBadge label={t('control.badge.eoa')} tone="warn" variant="fill" />;
    case 'timelock':
      return <HoloBadge label={t('control.badge.timelock')} tone="good" variant="fill" />;
    case 'safe':
      return <HoloBadge label={t('control.badge.safe')} tone="info" variant="fill" />;
    case 'contract':
      return <HoloBadge label={t('control.badge.contract')} tone="info" />;
    default:
      return <HoloBadge label={t('control.badge.unknown')} tone="muted" />;
  }
}

/** One sentence on what holds a role (from classifyController). */
export function useControllerText(): (view: ControllerView | null) => string {
  const { t } = useTranslation('proof');
  const dur = useDuration();
  return (view) => {
    switch (view?.kind) {
      case 'eoa':
        return t(view.delegated ? 'control.kind.eoaDelegated' : 'control.kind.eoa');
      case 'timelock':
        return t('control.kind.timelock', { delay: dur(view.minDelaySec ?? 0) });
      case 'safe':
        return t('control.kind.safe', { threshold: view.threshold ?? '—', owners: view.owners ?? '—' });
      case 'contract':
        return t('control.kind.contract');
      default:
        return t('control.kind.unknown');
    }
  };
}
