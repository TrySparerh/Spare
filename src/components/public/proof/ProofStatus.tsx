/**
 * System status, liveness only: is the Spare API up and synced, what block
 * your browser sees, how many Chainlink feeds OracleGuard accepts, and the
 * active / standby universe. No usage figures and no wallet appear here; the
 * intro points to /dispatch, which has every collection and sweep.
 */
import { DocSection, GlassCard, Grid, P, StatTile } from '@/components/public/PublicShell';
import { HoloBadge } from '@/components/retro/holo';
import { useHeadBlock } from '@/components/public/live/useLiveChain';
import { oracleView, type UniverseAsset } from '@/lib/spare-chain/hooks';
import { useTranslation } from '@/i18n';
import { SourceTag } from './ProofAtoms';
import { blockNo, oracleCounts, type ProofHealth } from './proofLogic';
import { apiHost } from './useProofData';

function Chip({ symbol, status, muted = false }: { symbol: string; status: number | null; muted?: boolean }) {
  const v = oracleView(status);
  const tone = muted ? 'muted' : status === 0 ? 'ok' : status == null ? 'muted' : status === 4 ? 'bad' : 'warn';
  return (
    <span className={`pf-chip pf-chip--${tone}`} title={`${symbol} · ${v.label} · ${v.detail}`} translate="no">
      <span className="pf-chip__dot" aria-hidden />
      {symbol}
      <span className="pf-muted" style={{ fontWeight: 400 }}>
        {v.label}
      </span>
    </span>
  );
}

export function ProofStatus({
  id,
  kicker,
  label,
  health,
  checking,
  assets,
  universeLoading,
}: {
  id: string;
  kicker: string;
  label: string;
  health: ProofHealth | null;
  checking: boolean;
  assets: readonly UniverseAsset[];
  universeLoading: boolean;
}) {
  const { t } = useTranslation('proof');
  const { head, loading: headLoading } = useHeadBlock(30_000);
  const active = assets.filter((a) => a.active).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const standby = assets.filter((a) => !a.active).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const oc = oracleCounts(active.map((a) => a.status));
  const apiUp = !!health?.ok;

  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <P>{t('status.intro')}</P>
      <Grid min={170}>
        <StatTile
          label={t('status.api')}
          value={checking ? '…' : apiUp ? t('status.online') : t('status.offline')}
          tone={checking ? 'holo' : apiUp ? 'good' : 'warn'}
          sub={
            <span style={{ overflowWrap: 'anywhere' }}>
              {health
                ? t('status.apiSub', { block: blockNo(health.block), rpc: health.rpcOk === false ? t('status.rpcDown') : t('status.rpcOk') })
                : t('status.apiHost', { host: apiHost() })}
            </span>
          }
        />
        <StatTile label={t('status.head')} value={head != null ? `#${blockNo(head)}` : headLoading ? '…' : '—'} sub={t('status.headSub')} />
        <StatTile
          label={t('status.feeds')}
          value={active.length ? `${oc.ok}/${active.length}` : universeLoading ? '…' : '—'}
          tone={active.length && oc.ok === active.length ? 'good' : 'holo'}
          sub={t('status.feedsSub')}
        />
        <StatTile
          label={t('status.universe')}
          value={assets.length ? `${active.length} · ${standby.length}` : universeLoading ? '…' : '—'}
          sub={t('status.universeSub')}
        />
      </Grid>

      <div className="pf-row">
        <SourceTag kind="live" />
        {health?.sessionOpen != null && (
          <HoloBadge label={health.sessionOpen ? t('status.sessionOpen') : t('status.sessionClosed')} tone={health.sessionOpen ? 'good' : 'muted'} />
        )}
      </div>

      <GlassCard title={t('status.activeTitle', { n: active.length })} accent={active.length ? `${oc.ok}/${active.length}` : undefined} accentTone="good">
        {active.length ? (
          <div className="pf-chips">
            {active.map((a) => (
              <Chip key={a.token} symbol={a.symbol} status={a.status} />
            ))}
          </div>
        ) : (
          <P>{universeLoading ? '…' : '—'}</P>
        )}
        <p className="pf-small">{t('status.oracleNote')}</p>
      </GlassCard>

      <GlassCard title={t('status.standbyTitle', { n: standby.length })} bar="lilac">
        {standby.length ? (
          <div className="pf-chips">
            {standby.map((a) => (
              <Chip key={a.token} symbol={a.symbol} status={a.status} muted />
            ))}
          </div>
        ) : (
          <P>{universeLoading ? '…' : '—'}</P>
        )}
        <p className="pf-small">{t('status.standbyNote')}</p>
      </GlassCard>
    </DocSection>
  );
}
