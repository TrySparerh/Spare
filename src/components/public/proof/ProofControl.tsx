/**
 * Who controls what, read live: the owner and pauser of the seven owned
 * contracts (and what kind of thing they are), the keeper's grants, the
 * screening switch, the three contracts with no owner at all, CashPark's
 * wiring, and the third-party hooks on pinned pools.
 */
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { Addr, DataTable, DocSection, GlassCard, Grid, P } from '@/components/public/PublicShell';
import { HoloBadge, HoloNotice } from '@/components/retro/holo';
import { KEEPER } from '@/components/public/live/addressBook';
import { SPARE, sameAddress } from '@/lib/spare-chain/addresses';
import type { UniverseAsset } from '@/lib/spare-chain/hooks';
import { Trans, useTranslation } from '@/i18n';
import { C, ControllerBadge, RepoLink, SourceTag, SourcifyBadge, TAGS, useControllerText } from './ProofAtoms';
import { hookPermissions, isVerified, isZeroAddress, summarizeRoles, type ControllerView } from './proofLogic';
import { OWNED, UNOWNED, useHookReads, useSourcify, type RoleReads } from './useProofData';

/** Code-level column heads (function names stay as they are in every language). */
const FN_HEAD = ['owner()', 'pendingOwner()', 'pauser()', 'paused()', 'isKeeper(keeper)'];
const AUTHORITY_HEAD = 'authority()';
/** Function names shown as row labels. */
const FN = { enforced: 'enforced()', attestor: 'attestor()', executor: 'executor()', adapter: 'adapter()' } as const;

function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="pf-kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const boolCode = (v: boolean | null) => (v == null ? '—' : <C>{String(v)}</C>);

export function ProofControl({
  id,
  kicker,
  label,
  roles,
  ownerCtl,
  pauserCtl,
  assets,
}: {
  id: string;
  kicker: string;
  label: string;
  roles: RoleReads;
  ownerCtl: { view: ControllerView | null; loading: boolean };
  pauserCtl: { view: ControllerView | null; loading: boolean };
  assets: readonly UniverseAsset[];
}) {
  const { t } = useTranslation('proof');
  const ctlText = useControllerText();
  const s = summarizeRoles(roles.rows);
  const dash = roles.loading ? '…' : '—';
  const total = OWNED.length;
  const samePauser = !!s.owner && !!s.pauser && sameAddress(s.owner, s.pauser);

  const hooked = assets.filter((a) => a.hooked && a.poolKey && !isZeroAddress(a.poolKey.hooks));
  const hookAddrs = [...new Set(hooked.map((a) => (a.poolKey!.hooks as Address).toLowerCase()))] as Address[];
  const hookSrc = useSourcify(hookAddrs);
  const hookReads = useHookReads(hookAddrs);

  const adapterLine = !roles.adapter
    ? dash
    : sameAddress(roles.adapter, SPARE.UsdgParkAdapter)
      ? t('control.adapterUsdg')
      : sameAddress(roles.adapter, SPARE.SgovParkAdapter)
        ? t('control.adapterSgov')
        : t('control.adapterOther');

  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <P>{t('control.intro', { n: total })}</P>
      {roles.failed && (
        <HoloNotice tone="warn" compact>
          {t('control.readFailed')}
        </HoloNotice>
      )}

      <Grid min={300}>
        {/* owner */}
        <GlassCard title={t('control.ownerTitle')} accent={<ControllerBadge view={ownerCtl.view} loading={ownerCtl.loading || roles.loading} />}>
          <Kv
            rows={[
              [t('control.address'), s.owner ? <Addr address={s.owner} full /> : s.ownerMixed ? t('control.ownerMixed') : dash],
              [t('control.what'), s.owner ? ctlText(ownerCtl.view) : dash],
              [t('control.scope'), s.ownerCount ? t('control.ownerOf', { n: s.ownerCount, total }) : dash],
              [t('control.pendingLabel'), s.pending.length ? t('control.pendingCount', { n: s.pending.length }) : roles.loading ? dash : t('control.none')],
            ]}
          />
          {ownerCtl.view?.kind === 'eoa' && (
            <HoloNotice tone="warn" compact>
              <Trans t={t} i18nKey="control.ownerEoaNote" components={TAGS} />
            </HoloNotice>
          )}
          {ownerCtl.view?.kind === 'timelock' && <p className="pf-small">{t('control.ownerTimelockNote')}</p>}
          {s.pending.length > 0 && (
            <HoloNotice tone="info" compact>
              {t('control.pending', { addr: s.pending[0].address, n: s.pending.length })}
            </HoloNotice>
          )}
          <div className="pf-row">
            <SourceTag kind="live" />
            <RepoLink path="docs/GOVERNANCE.md">{t('control.governanceDoc')}</RepoLink>
            <RepoLink path="docs/ROLES.md">{t('control.rolesDoc')}</RepoLink>
          </div>
        </GlassCard>

        {/* pauser */}
        <GlassCard title={t('control.pauserTitle')} accent={<ControllerBadge view={pauserCtl.view} loading={pauserCtl.loading || roles.loading} />} bar="lilac">
          <Kv
            rows={[
              [t('control.address'), s.pauser ? <Addr address={s.pauser} full /> : s.pauserMixed ? t('control.pauserMixed') : dash],
              [t('control.what'), samePauser ? t('control.sameAsOwner') : s.pauser ? ctlText(pauserCtl.view) : dash],
              [
                t('control.pausedNow'),
                roles.loading ? dash : s.paused.length ? <span translate="no">{s.paused.join(', ')}</span> : t('control.pausedNone', { total }),
              ],
            ]}
          />
          <p className="pf-small">
            <Trans t={t} i18nKey="control.pauserBody" components={TAGS} />
          </p>
          <div className="pf-row">
            <SourceTag kind="live" />
          </div>
        </GlassCard>

        {/* keeper */}
        <GlassCard title={t('control.keeperTitle')} bar="lilac">
          <Kv
            rows={[
              [t('control.address'), <Addr key="k" address={KEEPER} full />],
              [
                t('control.keeperOnLabel'),
                roles.loading ? dash : s.keeperOn.length ? <span translate="no">{s.keeperOn.join(', ')}</span> : t('control.keeperNone'),
              ],
            ]}
          />
          <p className="pf-small">{t('control.keeperBody')}</p>
          <div className="pf-row">
            <SourceTag kind="record" />
            <span className="pf-small">{t('control.keeperSource')}</span>
          </div>
        </GlassCard>

        {/* screening */}
        <GlassCard title={t('control.screeningTitle')} bar="lilac">
          <Kv
            rows={[
              [<C key="e">{FN.enforced}</C>, boolCode(roles.enforced)],
              [<C key="a">{FN.attestor}</C>, roles.attestor ? (s.owner && sameAddress(roles.attestor, s.owner) ? t('control.sameAsOwner') : <Addr address={roles.attestor} />) : dash],
            ]}
          />
          <p className="pf-small">{roles.enforced === true ? t('control.screeningOn') : roles.enforced === false ? t('control.screeningOff') : dash}</p>
          <div className="pf-row">
            <SourceTag kind="live" />
          </div>
        </GlassCard>

        {/* no owner */}
        <GlassCard title={t('control.noOwnerTitle')} bar="pink">
          <ul className="pf-checklist">
            {UNOWNED.map((n) => {
              const v = roles.noOwner[n];
              return (
                <li key={n}>
                  <span className="pf-row">
                    <strong translate="no">{n}</strong>
                    {v === true ? (
                      <HoloBadge label={t('control.noOwnerYes')} tone="good" />
                    ) : v === false ? (
                      <HoloBadge label={t('control.noOwnerNo')} tone="bad" />
                    ) : (
                      <HoloBadge label={roles.loading ? t('code.checking') : t('code.unread')} tone="muted" pulse={roles.loading} />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="pf-small">
            <Trans t={t} i18nKey="control.noOwnerBody" components={TAGS} />
          </p>
          <div className="pf-row">
            <SourceTag kind="live" />
          </div>
        </GlassCard>

        {/* CashPark wiring */}
        <GlassCard title={t('control.wiringTitle')} bar="pink">
          <Kv
            rows={[
              [
                <C key="x">{FN.executor}</C>,
                !roles.executor ? (
                  dash
                ) : sameAddress(roles.executor, SPARE.SweepExecutor) ? (
                  <HoloBadge label={t('control.executorOk')} tone="good" />
                ) : (
                  <span className="pf-stack">
                    <HoloBadge label={t('control.executorBad')} tone="bad" variant="fill" />
                    <Addr address={roles.executor} />
                  </span>
                ),
              ],
              [<C key="d">{FN.adapter}</C>, adapterLine],
            ]}
          />
          <p className="pf-small">
            <Trans t={t} i18nKey="control.wiringBody" components={TAGS} />
          </p>
          <div className="pf-row">
            <SourceTag kind="live" />
          </div>
        </GlassCard>
      </Grid>

      {/* per contract */}
      <DataTable
        head={[t('control.head.contract'), ...FN_HEAD]}
        minWidth={720}
        stack
        rowKey={(_, i) => roles.rows[i].name}
        rows={roles.rows.map((r) => [
          <strong key="n" translate="no">
            {r.name}
          </strong>,
          r.owner ? <Addr key="o" address={r.owner} /> : dash,
          r.pendingOwner == null ? dash : isZeroAddress(r.pendingOwner) ? t('control.none') : <Addr key="p" address={r.pendingOwner} />,
          r.pauser ? <Addr key="u" address={r.pauser} /> : dash,
          boolCode(r.paused),
          boolCode(r.keeper),
        ])}
        caption={t('control.tableCaption')}
      />

      {/* third-party hooks */}
      <GlassCard title={t('hooks.title')} accent={hooked.length ? String(hooked.length) : undefined} accentTone="warn" bar="pink">
        {hooked.length === 0 ? (
          <P>{assets.length ? t('hooks.none') : '…'}</P>
        ) : (
          <>
            <P>{t('hooks.intro', { n: hooked.length })}</P>
            <DataTable
              head={[t('hooks.head.stock'), t('hooks.head.hook'), t('hooks.head.verified'), t('hooks.head.permissions'), AUTHORITY_HEAD]}
              minWidth={760}
              stack
              rowKey={(_, i) => hooked[i].token}
              rows={hooked.map((a) => {
                const hook = a.poolKey!.hooks as Address;
                const perms = hookPermissions(hook);
                const v = hookSrc.byAddress.get(hook.toLowerCase());
                const auth = hookReads.authority.get(hook.toLowerCase());
                return [
                  <strong key="s" translate="no">
                    {a.symbol}
                  </strong>,
                  <Addr key="h" address={hook} />,
                  <span key="v" className="pf-stack">
                    <span>
                      <SourcifyBadge view={v} address={hook} />
                    </span>
                    {isVerified(v) && v?.qualifiedName && (
                      <span className="pf-small" translate="no">
                        {v.qualifiedName}
                      </span>
                    )}
                  </span>,
                  <span key="p" className="pf-stack">
                    <span className="pf-mono" translate="no">
                      {perms.flags.join(', ') || '—'}
                    </span>
                    <span className="pf-small">{perms.returnsDelta ? t('hooks.delta') : t('hooks.noDelta')}</span>
                  </span>,
                  auth ? <Addr key="a" address={auth} /> : hookReads.loading ? '…' : '—',
                ];
              })}
            />
            <p className="pf-small">{t('hooks.authorityHint')}</p>
            <div className="pf-row">
              <SourceTag kind="live" />
              <RepoLink path="contracts/config/4663.json">{t('hooks.configLink')}</RepoLink>
            </div>
          </>
        )}
      </GlassCard>
    </DocSection>
  );
}
