/**
 * /flywheel — the Spare loop.
 *
 *   Pay → Round up → Invest → Fee → $SPARE → Boost → (back to Pay)
 *
 * The first four steps are live on Robinhood Chain and each carries a live
 * number read straight from the contracts (Linked − Unlinked, Σ Accrued,
 * Σ AssetSwept.usdgIn, FeeVault's USDG). $SPARE and Boost are S3: planned,
 * not live, and they say so. No price, supply, yield or tiers anywhere.
 *
 * Text: pages-b namespace (`flywheel.*`).
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  FONT_PIXEL,
  FONT_TEXT,
  HOLO,
  HoloBadge,
  HoloCard,
  HoloHero,
  HoloNotice,
  HoloStar,
  HoloTable,
  INK,
  type HoloColumn,
} from '@/components/retro/holo';
import { DeployingNotice, Hint } from '@/components/retro/apps/spare/SpareUi';
import { CtaRow, HoloLinkButton, HoloPageWindow, usePageMeta } from '@/components/public/HoloPageWindow';
import { useSpareDeployment } from '@/lib/spare-chain/hooks';
import { linkedNow, useFeeVault, useProtocolLedger } from '@/lib/spare-chain/protocol-stats';
import { formatUsd } from '@/lib/spare';
import { tKey, useTranslation } from '@/i18n';

const DASH = '—';

interface Step {
  n: number;
  title: string;
  body: string;
  live: boolean;
  icon: string;
  /** Live number line, or the "not live" note. */
  value: ReactNode;
}

/* ---------------------------------- ring ---------------------------------- */

/** Node angles (degrees, clockwise from 12 o'clock). */
const ANGLES = [-90, -30, 30, 90, 150, 210];
/** Ellipse radii in % of the ring box. */
const RX = 35;
const RY = 37;

function pos(deg: number): { left: string; top: string } {
  const r = (deg * Math.PI) / 180;
  return { left: `${50 + RX * Math.cos(r)}%`, top: `${50 + RY * Math.sin(r)}%` };
}

function StepCard({ step }: { step: Step }) {
  const { t } = useTranslation('pages-b');
  return (
    <HoloCard
      compact
      title={`${step.n} · ${step.title}`}
      icon={step.icon}
      accent={step.live ? t('flywheel.live') : 'S3'}
      accentTone={step.live ? 'good' : 'warn'}
      bar={step.live ? 'holo' : 'lilac'}
      style={step.live ? undefined : { borderStyle: 'dashed' }}
    >
      <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.5, color: INK.body }}>{step.body}</p>
      <div
        style={{
          fontFamily: FONT_TEXT,
          fontWeight: 700,
          fontSize: 13,
          lineHeight: 1.3,
          color: step.live ? INK.body : INK.warn,
          overflowWrap: 'anywhere',
        }}
      >
        {step.value}
      </div>
    </HoloCard>
  );
}

function Chevron({ deg }: { deg: number }) {
  const r = (deg * Math.PI) / 180;
  const p = { left: `${50 + RX * Math.cos(r)}%`, top: `${50 + RY * Math.sin(r)}%` };
  return (
    <svg
      aria-hidden
      className="fw-chev"
      width="14"
      height="14"
      viewBox="0 0 7 7"
      shapeRendering="crispEdges"
      style={{ ...p, transform: `translate(-50%, -50%) rotate(${deg + 90}deg)` }}
    >
      <path d="M1 0h2v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-2v-1h1v-1h1v-1h1v-1h-1v-1h-1v-1h-1z" fill={HOLO.ink} />
    </svg>
  );
}

function Ring({ steps }: { steps: Step[] }) {
  const { t } = useTranslation('pages-b');
  return (
    <div className="fw-ring" role="list" aria-label={t('flywheel.ring.aria')}>
      <svg className="fw-orbit" aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* live half: Pay → Round up → Invest → Fee (right side) */}
        <path d={`M50 ${50 - RY} A${RX} ${RY} 0 0 1 50 ${50 + RY}`} fill="none" stroke={HOLO.ink} strokeWidth="3" vectorEffect="non-scaling-stroke" />
        {/* planned half: Fee → $SPARE → Boost → Pay (left side) */}
        <path
          d={`M50 ${50 + RY} A${RX} ${RY} 0 0 1 50 ${50 - RY}`}
          fill="none"
          stroke={HOLO.inkSoft}
          strokeWidth="3"
          strokeDasharray="6 6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {[-60, 0, 60, 120, 180, 240].map((d) => (
        <Chevron key={d} deg={d} />
      ))}
      <div className="fw-core" aria-hidden>
        <HoloStar size={84} animated />
        <span className="fw-core__label">{t('flywheel.ring.core')}</span>
      </div>
      {steps.map((s, i) => (
        <div key={s.n} role="listitem" className="fw-node" style={pos(ANGLES[i])}>
          <StepCard step={s} />
        </div>
      ))}
    </div>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  const { t } = useTranslation('pages-b');
  return (
    <ol className="fw-list" aria-label={t('flywheel.ring.aria')}>
      {steps.map((s, i) => (
        <li key={s.n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <StepCard step={s} />
          <div aria-hidden className="fw-list__arrow">
            {i < steps.length - 1 ? '▼' : t('flywheel.ring.back')}
          </div>
        </li>
      ))}
    </ol>
  );
}

const RING_CSS = `
  .fw-ring {
    position: relative;
    width: 100%;
    max-width: 900px;
    height: 640px;
    margin: 0 auto;
  }
  .fw-orbit { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .fw-chev { position: absolute; }
  .fw-core {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .fw-core__label {
    font-family: ${FONT_PIXEL};
    font-size: 10px;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: ${HOLO.ink};
    background: ${HOLO.paper};
    box-shadow: inset 0 0 0 1px ${HOLO.ink}, 2px 2px 0 0 rgba(42,27,110,.2);
    padding: 3px 7px;
    white-space: nowrap;
  }
  .fw-node { position: absolute; width: 230px; transform: translate(-50%, -50%); }
  .fw-list { display: none; margin: 0; padding: 0; list-style: none; flex-direction: column; gap: 6px; }
  .fw-list__arrow {
    align-self: center;
    font-family: ${FONT_PIXEL};
    font-size: 12px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: ${HOLO.ink};
  }
  @media (max-width: 899px) {
    .fw-ring { display: none; }
    .fw-list { display: flex; }
  }
`;

/* --------------------------------- roles ---------------------------------- */

type RoleRow = { id: string; who: string; does: string; gets: string; live: boolean } & Record<string, unknown>;

/** Translation keys per role; the rows are built (translated) at render. */
const ROLES = [
  { id: 'saver', who: tKey('flywheel.roles.saver.who'), does: tKey('flywheel.roles.saver.does'), gets: tKey('flywheel.roles.saver.gets'), live: true },
  { id: 'sponsor', who: tKey('flywheel.roles.sponsor.who'), does: tKey('flywheel.roles.sponsor.does'), gets: tKey('flywheel.roles.sponsor.gets'), live: false },
  {
    id: 'boostPartner',
    who: tKey('flywheel.roles.boostPartner.who'),
    does: tKey('flywheel.roles.boostPartner.does'),
    gets: tKey('flywheel.roles.boostPartner.gets'),
    live: false,
  },
  { id: 'staker', who: tKey('flywheel.roles.staker.who'), does: tKey('flywheel.roles.staker.does'), gets: tKey('flywheel.roles.staker.gets'), live: false },
] as const;

/* ---------------------------------- page ---------------------------------- */

export default function Flywheel() {
  const { t } = useTranslation('pages-b');
  usePageMeta(t('flywheel.meta.title'), t('flywheel.meta.description'));

  const deployment = useSpareDeployment();
  const deployed = deployment.deployed;
  const vault = useFeeVault(deployed);
  const { ledger, loading, error } = useProtocolLedger(deployed);

  const pending = deployment.checking || (deployed && loading);
  const ledgerValue = (render: () => string): string => {
    if (ledger) return render();
    if (pending) return t('flywheel.value.reading');
    return error ? t('flywheel.value.unavailable') : DASH;
  };
  const linked = ledger ? linkedNow(ledger) : null;

  const steps: Step[] = [
    {
      n: 1,
      title: t('flywheel.steps.pay.title'),
      body: t('flywheel.steps.pay.body'),
      live: true,
      icon: '/icons/spare/link-wallet.png',
      value: ledgerValue(() => (linked === 1 ? t('flywheel.steps.pay.valueOne', { n: linked }) : t('flywheel.steps.pay.valueMany', { n: linked }))),
    },
    {
      n: 2,
      title: t('flywheel.steps.roundUp.title'),
      body: t('flywheel.steps.roundUp.body'),
      live: true,
      icon: '/icons/spare/roundup-rules.png',
      value: ledgerValue(() => t('flywheel.steps.roundUp.value', { amount: formatUsd(ledger!.collectedUsdg) })),
    },
    {
      n: 3,
      title: t('flywheel.steps.invest.title'),
      body: t('flywheel.steps.invest.body'),
      live: true,
      icon: '/icons/spare/auto-invest.png',
      value: ledgerValue(() => t('flywheel.steps.invest.value', { amount: formatUsd(ledger!.convertedUsdg) })),
    },
    {
      n: 4,
      title: t('flywheel.steps.fee.title'),
      body: t('flywheel.steps.fee.body'),
      live: true,
      icon: '/icons/spare/spare-balance.png',
      value:
        vault.usdg !== null
          ? t('flywheel.steps.fee.value', { amount: formatUsd(vault.usdg) })
          : pending || vault.loading
          ? t('flywheel.value.reading')
          : t('flywheel.value.unavailable'),
    },
    {
      n: 5,
      title: '$SPARE',
      body: t('flywheel.steps.spare.body'),
      live: false,
      icon: '/icons/spare-logo.png',
      value: t('flywheel.value.notLive'),
    },
    {
      n: 6,
      title: t('flywheel.steps.boost.title'),
      body: t('flywheel.steps.boost.body'),
      live: false,
      icon: '/icons/spare/fund-wallet.png',
      value: t('flywheel.value.notLive'),
    },
  ];

  const heroBadge = pending ? (
    <HoloBadge label={t('common.readingBadge')} variant="solid" />
  ) : ledger ? (
    <HoloBadge label={t('flywheel.fourOfSix')} tone="good" variant="solid" pulse />
  ) : (
    <HoloBadge label={t('flywheel.fourOfSix')} tone="good" variant="solid" />
  );

  const roleRows: RoleRow[] = ROLES.map((r) => ({ id: r.id, who: t(r.who), does: t(r.does), gets: t(r.gets), live: r.live }));
  const roleColumns: HoloColumn<RoleRow>[] = [
    { key: 'who', label: t('flywheel.roles.cols.participant'), width: 130, render: (r) => <strong>{r.who}</strong> },
    { key: 'does', label: t('flywheel.roles.cols.does'), wrap: true },
    { key: 'gets', label: t('flywheel.roles.cols.gets'), wrap: true },
    {
      key: 'live',
      label: t('flywheel.roles.cols.status'),
      width: 90,
      pin: false,
      render: (r) => <HoloBadge label={r.live ? t('flywheel.live') : 'S3'} tone={r.live ? 'good' : 'warn'} />,
    },
  ];

  return (
    <HoloPageWindow exeTitle={t('flywheel.exeTitle')} icon="/icons/spare/auto-invest.png" banner={t('flywheel.banner')} current="/flywheel">
      <HoloHero
        art="/icons/spare/auto-invest.png"
        kicker={t('flywheel.hero.kicker')}
        title={t('flywheel.hero.title')}
        description={t('flywheel.hero.description')}
        aside={heroBadge}
        seed={47}
      />

      {!deployed && !deployment.checking && <DeployingNotice checking={false} error={deployment.error} />}

      <HoloCard title={t('flywheel.loop.title')} icon="/icons/spare/auto-invest.png" accent={t('flywheel.loop.accent')} accentTone="info">
        <Ring steps={steps} />
        <StepList steps={steps} />
        <style>{RING_CSS}</style>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Legend solid label={t('flywheel.loop.legendLive')} />
          <Legend label={t('flywheel.loop.legendPlanned')} />
        </div>
        <Hint>{ledger ? t('flywheel.loop.hintBlock', { block: ledger.scannedTo.toLocaleString('en-US') }) : t('flywheel.loop.hint')}</Hint>
      </HoloCard>

      <HoloCard title={t('flywheel.roles.title')} bar="lilac">
        <HoloTable ariaLabel={t('flywheel.roles.title')} columns={roleColumns} rows={roleRows} rowKey={(r) => r.id} minWidth={620} />
      </HoloCard>

      <HoloNotice tone="info" title={t('flywheel.notice.title')}>
        {t('flywheel.notice.body')}
      </HoloNotice>

      <CtaRow>
        <HoloLinkButton to="/" variant="primary" size="lg">
          {t('common.startRoundingUp')}
        </HoloLinkButton>
        <HoloLinkButton to="/buyback" size="lg">
          {t('flywheel.cta.feesGo')}
        </HoloLinkButton>
      </CtaRow>
    </HoloPageWindow>
  );
}

function Legend({ solid = false, label }: { solid?: boolean; label: string }) {
  const line: CSSProperties = {
    display: 'inline-block',
    width: 28,
    height: 0,
    borderTop: `3px ${solid ? 'solid' : 'dashed'} ${solid ? HOLO.ink : HOLO.inkSoft}`,
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONT_TEXT, fontSize: 11.5, color: INK.muted }}>
      <span aria-hidden style={line} />
      {label}
    </span>
  );
}
