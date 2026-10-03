/**
 * Safety rails: each limit with the value the contracts hold right now, its
 * hard ceiling where the code has one, and the getter it was read from.
 * Rules that are not a stored value (the weekly cap is per account, exit has
 * no pause modifier) say so instead of showing a number.
 */
import type { ReactNode } from 'react';
import { Addr, DocSection, P } from '@/components/public/PublicShell';
import type { UniverseAsset } from '@/lib/spare-chain/hooks';
import { formatUsd } from '@/lib/spare';
import { Trans, useTranslation } from '@/i18n';
import { C, RepoLink, SourceTag, TAGS, useDuration } from './ProofAtoms';
import { bandGroups, blockNo, bpsPct, isZeroAddress } from './proofLogic';
import type { RailReads } from './useProofData';

/** The getters each value comes from (code, never translated). */
const SRC = {
  fee: 'SweepExecutor.feeBps() · MAX_FEE_BPS()',
  band: 'AssetRegistry.get(token).bandBps · MAX_BAND_BPS()',
  slippage: 'SweepExecutor.slippageBps() · MAX_SLIPPAGE_BPS()',
  pinned: 'AssetRegistry.get(token).poolKey',
  threshold: 'SweepExecutor.threshold()',
  epoch: 'SweepExecutor.epochLength()',
  cap: 'RuleRegistry.ruleOf(account).weeklyCap',
  finality: 'SweepExecutor.finalityBuffer()',
  exit: 'CashPark.exit()',
  paused: 'SweepExecutor.paused()',
  sequencer: 'StockRouter.sequencerFeed()',
  legs: 'ElectionRegistry.MAX_LEGS()',
} as const;

function Rail({
  name,
  value,
  bound,
  children,
  src,
  tag = 'live',
  link,
}: {
  name: string;
  value: ReactNode;
  bound?: ReactNode;
  children: ReactNode;
  src: string;
  tag?: 'live' | 'record' | 'code';
  link?: ReactNode;
}) {
  return (
    <div className="pf-rail">
      <div className="pf-rail__top">
        <span className="pf-rail__name">{name}</span>
        <SourceTag kind={tag} />
      </div>
      <div className="pf-rail__value">{value}</div>
      {bound && <div className="pf-rail__bound">{bound}</div>}
      <p className="pf-rail__body">{children}</p>
      <div className="pf-rail__src" translate="no">
        {src} {link}
      </div>
    </div>
  );
}

export function ProofRails({ id, kicker, label, rails, assets }: { id: string; kicker: string; label: string; rails: RailReads; assets: readonly UniverseAsset[] }) {
  const { t } = useTranslation('proof');
  const dur = useDuration();
  const dash = rails.loading ? '…' : '—';
  const active = assets.filter((a) => a.active);
  const pinned = active.filter((a) => !!a.poolKey).length;
  const groups = bandGroups(assets);

  return (
    <DocSection id={id} label={label} kicker={kicker}>
      <P>{t('rails.intro')}</P>
      <div className="pf-rails">
        <Rail
          name={t('rails.fee.name')}
          value={rails.feeBps == null ? dash : t('rails.pctBps', { pct: bpsPct(rails.feeBps), bps: rails.feeBps })}
          bound={rails.maxFeeBps != null ? t('rails.ceiling', { max: bpsPct(rails.maxFeeBps) }) : undefined}
          src={SRC.fee}
          link={<RepoLink path="contracts/src/SweepExecutor.sol" lines={[102, 103]}>{t('common.source')}</RepoLink>}
        >
          {t('rails.fee.body')}
        </Rail>

        <Rail
          name={t('rails.band.name')}
          value={
            groups.length === 0 ? (
              assets.length ? '—' : dash
            ) : (
              <span className="pf-stack">
                {groups.map((g, i) => (
                  <span key={g.bandBps}>
                    {t('rails.band.group', { pct: bpsPct(g.bandBps), n: g.symbols.length, total: active.length })}
                    {i > 0 && (
                      <span className="pf-small" translate="no">
                        {' '}
                        ({g.symbols.join(', ')})
                      </span>
                    )}
                  </span>
                ))}
              </span>
            )
          }
          bound={rails.maxBandBps != null ? t('rails.ceiling', { max: bpsPct(rails.maxBandBps) }) : undefined}
          src={SRC.band}
          link={<RepoLink path="contracts/src/StockRouter.sol" lines={[135, 136]}>{t('common.source')}</RepoLink>}
        >
          {t('rails.band.body')}
        </Rail>

        <Rail
          name={t('rails.slippage.name')}
          value={rails.slippageBps == null ? dash : t('rails.pctBps', { pct: bpsPct(rails.slippageBps), bps: rails.slippageBps })}
          bound={rails.maxSlippageBps != null ? t('rails.ceiling', { max: bpsPct(rails.maxSlippageBps) }) : undefined}
          src={SRC.slippage}
          link={<RepoLink path="contracts/src/SweepExecutor.sol" lines={[362, 364]}>{t('common.source')}</RepoLink>}
        >
          {t('rails.slippage.body')}
        </Rail>

        <Rail
          name={t('rails.pinned.name')}
          value={active.length ? t('rails.pinned.value', { n: pinned, total: active.length }) : dash}
          src={SRC.pinned}
        >
          {t('rails.pinned.body')}
        </Rail>

        <Rail name={t('rails.threshold.name')} value={rails.threshold == null ? dash : formatUsd(rails.threshold)} src={SRC.threshold}>
          {t('rails.threshold.body')}
        </Rail>

        <Rail
          name={t('rails.epoch.name')}
          value={rails.epochLength == null ? dash : t('rails.epoch.value', { dur: dur(rails.epochLength) })}
          src={SRC.epoch}
        >
          {t('rails.epoch.body')}
        </Rail>

        <Rail
          name={t('rails.cap.name')}
          value={t('rails.cap.value')}
          src={SRC.cap}
          tag="code"
          link={<RepoLink path="contracts/src/SweepExecutor.sol" lines={[234, 240]}>{t('common.source')}</RepoLink>}
        >
          <Trans t={t} i18nKey="rails.cap.body" components={TAGS} />
        </Rail>

        <Rail
          name={t('rails.finality.name')}
          value={rails.finalityBuffer == null ? dash : t('rails.finality.value', { n: blockNo(rails.finalityBuffer) })}
          src={SRC.finality}
        >
          {t('rails.finality.body')}
        </Rail>

        <Rail
          name={t('rails.exit.name')}
          value={rails.parkPaused == null ? dash : <C>{`CashPark.paused() = ${String(rails.parkPaused)}`}</C>}
          src={SRC.exit}
          link={<RepoLink path="contracts/src/CashPark.sol" lines={[162, 168]}>{t('common.source')}</RepoLink>}
        >
          <Trans t={t} i18nKey="rails.exit.body" components={TAGS} />
        </Rail>

        <Rail
          name={t('rails.paused.name')}
          value={rails.sweepPaused == null ? dash : rails.sweepPaused ? t('rails.paused.paused') : t('rails.paused.running')}
          src={SRC.paused}
        >
          {t('rails.paused.body')}
        </Rail>

        <Rail
          name={t('rails.sequencer.name')}
          value={rails.sequencerFeed == null ? dash : isZeroAddress(rails.sequencerFeed) ? t('rails.sequencer.off') : <Addr address={rails.sequencerFeed} />}
          src={SRC.sequencer}
        >
          {rails.sequencerFeed && !isZeroAddress(rails.sequencerFeed) ? t('rails.sequencer.bodyOn') : t('rails.sequencer.bodyOff')}
        </Rail>

        <Rail name={t('rails.legs.name')} value={rails.maxLegs == null ? dash : t('rails.legs.value', { n: rails.maxLegs })} src={SRC.legs}>
          {t('rails.legs.body')}
        </Rail>
      </div>
    </DocSection>
  );
}
