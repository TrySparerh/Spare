/**
 * /docs — How Spare works.
 *
 * One long page with a sticky section nav. Live values come straight from
 * Robinhood Chain through src/lib/spare-chain (no backend): sweep threshold,
 * fee and its ceiling, the stock universe with oracle status, the eligibility
 * gate and a bytecode check per contract. When a read fails the documented
 * value from the spec is shown and labelled as such.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useReadContracts } from 'wagmi';
import {
  Addr,
  Bullets,
  Code,
  Ctas,
  DataTable,
  DocSection,
  Faq,
  GlassCard,
  Grid,
  H3,
  LinkButton,
  P,
  PublicShell,
  SpareContractsTable,
  StatTile,
  Steps,
  useSectionSpy,
  type PublicSidebarSection,
} from '@/components/public/PublicShell';
import {
  HoloBadge,
  HoloInput,
  HoloLabel,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloSegmented,
  HoloStat,
  HoloText,
} from '@/components/retro/holo';
import { useSpareDeployment, useSweepParams, useUniverse, oracleView, type UniverseAsset } from '@/lib/spare-chain/hooks';
import { electionRegistryAbi, screeningGateAbi, sweepExecutorAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, sameAddress } from '@/lib/spare-chain/addresses';
import { standbyReason, standbyText } from '@/lib/spare-chain/universe';
import { AssetLabel, PagerRow, usePaged } from '@/components/retro/apps/assetUi';
import { SPARE_RISK_KEYS } from '@/components/public/risks';
import { Trans, tKey, useLang, useTranslation } from '@/i18n';
import {
  MULTIPLIER_VALUES,
  ROUND_TO_VALUES,
  formatBps,
  formatUsd,
  parseUsd,
  roundUpDelta,
  type Multiplier,
  type RoundTo,
} from '@/lib/spare';

const OWNER = '0x56B67D71039365083727b661Dbe9Bdb7f7D15189';
const KEEPER = '0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03';

const SIDEBAR: PublicSidebarSection[] = [
  {
    label: tKey('docs.nav.start'),
    items: [
      { id: 'overview', label: tKey('docs.nav.overview') },
      { id: 'quickstart', label: tKey('docs.nav.quickstart') },
      { id: 'payments', label: tKey('payments.title') },
    ],
  },
  {
    label: tKey('docs.nav.using'),
    items: [
      { id: 'link', label: tKey('docs.nav.link') },
      { id: 'rules', label: tKey('docs.nav.rules') },
      { id: 'mix', label: tKey('docs.nav.mix') },
      { id: 'sweep', label: tKey('docs.nav.sweep') },
      { id: 'balance', label: tKey('docs.nav.balance') },
      { id: 'fund', label: tKey('shell:appNames.fund-wallet') },
    ],
  },
  {
    label: tKey('docs.nav.money'),
    items: [
      { id: 'fees', label: tKey('docs.nav.fees') },
      { id: 'limits', label: tKey('docs.nav.limits') },
    ],
  },
  {
    label: tKey('docs.nav.trust'),
    items: [
      { id: 'safety', label: tKey('docs.nav.safety') },
      { id: 'risks', label: tKey('docs.nav.risks') },
      { id: 'eligibility', label: tKey('docs.nav.eligibility') },
      { id: 'contracts', label: tKey('docs.nav.contracts') },
    ],
  },
  {
    label: tKey('docs.nav.help'),
    items: [
      { id: 'faq', label: tKey('docs.nav.faq') },
      { id: 'glossary', label: tKey('docs.nav.glossary') },
    ],
  },
];

const SECTION_IDS = SIDEBAR.flatMap((g) => g.items.map((i) => i.id));

/** The sidebar with its keys translated (the labels in SIDEBAR are pages-a keys). */
function useSidebar(): PublicSidebarSection[] {
  const { t } = useTranslation('pages-a');
  const lang = useLang();
  return useMemo(
    () => SIDEBAR.map((g) => ({ label: t(g.label), items: g.items.map((i) => ({ id: i.id, label: t(i.label) })) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: retranslate on a language switch
    [t, lang],
  );
}

const BOLD = { b: <strong /> };

/** <Code> for <Trans> (Trans supplies the children from the translation). */
function CodeTag({ children }: { children?: ReactNode }) {
  return <Code>{children}</Code>;
}

/* ───────────────────────────── live reads ───────────────────────────── */

type LiveState = 'live' | 'loading' | 'fallback';

/** Sub-line under a live value (pages-a keys; translate at render). */
const LIVE_SUB: Record<LiveState, string> = {
  live: tKey('docs.live.live'),
  loading: tKey('docs.live.loading'),
  fallback: tKey('docs.live.fallback'),
};

function useDocsLive() {
  const dep = useSpareDeployment();
  const on = dep.deployed;
  const sweep = useSweepParams(on);
  const uni = useUniverse({ enabled: on });
  const extra = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'MAX_FEE_BPS', chainId: SPARE_CHAIN_ID },
      { address: SPARE.ScreeningGate, abi: screeningGateAbi, functionName: 'enforced', chainId: SPARE_CHAIN_ID },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'defaultMix', chainId: SPARE_CHAIN_ID },
    ] as const,
    query: { enabled: on, refetchInterval: 60_000 },
  });

  const booting = dep.checking;
  const state = (ok: boolean, loading: boolean): LiveState => (ok ? 'live' : booting || loading ? 'loading' : 'fallback');

  const params = sweep.params;
  const paramsState = state(!!params, sweep.isLoading);
  const threshold = params ? formatUsd(params.threshold) : '$5.00';
  const fee = params ? `${formatBps(params.feeBps)}%` : '0.25%';

  // Details read = every token's registry entry came back (an unread entry would look "inactive").
  const assetsRead = !uni.isLoading && !uni.error && uni.assets.length > 0 && uni.assets.every((a) => a.feed !== undefined);
  const universeState = state(assetsRead, uni.isLoading);
  const active = uni.assets.filter((a) => a.active);

  const maxFeeRaw = extra.data?.[0]?.status === 'success' ? Number(extra.data[0].result) : null;
  const enforcedRaw = extra.data?.[1]?.status === 'success' ? (extra.data[1].result as boolean) : null;
  const defaultMix = extra.data?.[2]?.status === 'success' ? (extra.data[2].result as readonly { asset: string; bps: number }[]) : [];
  const extraState = state(maxFeeRaw !== null, extra.isLoading);

  return {
    paramsState,
    threshold,
    fee,
    paused: params?.paused ?? null,
    universeState,
    assets: uni.assets,
    defaultMix,
    activeCount: assetsRead ? String(active.length) : '—',
    maxFee: maxFeeRaw !== null ? `${formatBps(maxFeeRaw)}%` : '1%',
    maxFeeState: extraState,
    enforced: enforcedRaw,
    enforcedState: state(enforcedRaw !== null, extra.isLoading),
  };
}

type DocsLive = ReturnType<typeof useDocsLive>;

/* ───────────────────────────── small pieces ───────────────────────────── */

function LiveTag({ state }: { state: LiveState }) {
  const { t } = useTranslation('pages-a');
  if (state === 'live') return <HoloBadge label={t('docs.liveTag.live')} tone="good" pulse />;
  if (state === 'loading') return <HoloBadge label={t('docs.liveTag.reading')} tone="muted" pulse />;
  return <HoloBadge label={t('docs.liveTag.documented')} tone="warn" title={t('docs.liveTag.documentedTip')} />;
}

const ORACLE_TONE = { up: 'good', warn: 'warn', down: 'bad', muted: 'muted' } as const;

function OracleBadge({ status }: { status: number | null }) {
  const { t } = useTranslation('pages-a');
  const v = oracleView(status);
  const label = status === 1 ? t('docs.oracle.marketClosed') : v.label === '—' ? t('docs.oracle.unknown') : v.label;
  return <HoloBadge label={label} tone={ORACLE_TONE[v.tone]} title={v.detail} />;
}

/** Rows before "show more": the universe grows with the registry. */
const UNIVERSE_PAGE = 12;

function MixUniverse({ live }: { live: DocsLive }) {
  const { t } = useTranslation('pages-a');
  const rows = [...live.assets].sort((a, b) => Number(b.active) - Number(a.active) || a.symbol.localeCompare(b.symbol));
  const paged = usePaged(rows, UNIVERSE_PAGE, String(rows.length));
  const weightOf = (a: UniverseAsset) => {
    const leg = live.defaultMix.find((l) => sameAddress(l.asset, a.token));
    return leg ? `${formatBps(Number(leg.bps))}%` : '—';
  };
  if (live.universeState === 'loading') {
    return (
      <HoloText tone="muted" size="sm">
        {t('docs.universe.reading')}
      </HoloText>
    );
  }
  if (live.universeState === 'fallback') {
    return (
      <HoloNotice tone="warn" compact title={t('docs.universe.fallbackTitle')}>
        {t('docs.universe.fallbackBody')}
      </HoloNotice>
    );
  }
  return (
    <>
      <DataTable
        head={[t('docs.universe.headStock'), t('docs.universe.headStatus'), t('docs.universe.headOracle'), t('docs.universe.headDefaultMix')]}
        minWidth={420}
        stack
        rowKey={(_, i) => paged.visible[i].token}
        rows={paged.visible.map((a: UniverseAsset) => [
          <AssetLabel key="s" symbol={a.symbol} name={a.name} kind={a.kind} size={12.5} />,
          a.active ? (
            <HoloBadge key="st" label={t('common.active')} tone="good" />
          ) : (
            <span key="st" style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <HoloBadge label={t('common.inactive')} tone="muted" />
              {/* standbyText speaks the live language (shell assets.standby.*) */}
              <HoloText as="span" tone="muted" size="xs">{standbyText(standbyReason(a))}</HoloText>
            </span>
          ),
          <OracleBadge key="o" status={a.status} />,
          weightOf(a),
        ])}
      />
      <PagerRow hidden={paged.hidden} page={UNIVERSE_PAGE} expanded={paged.expanded} onMore={paged.more} onLess={paged.less} />
    </>
  );
}

/* ─────────────────────────── round-up calculator ─────────────────────────── */

function RoundUpCalculator() {
  const { t } = useTranslation('pages-a');
  const [text, setText] = useState('3.75, 12.40, 7.00');
  const [roundTo, setRoundTo] = useState<RoundTo>(1);
  const [mult, setMult] = useState<Multiplier>(1);

  const { rows, bad, total } = useMemo(() => {
    const parts = text
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    const rows: { raw: string; amount: bigint; delta: bigint }[] = [];
    const bad: string[] = [];
    for (const raw of parts) {
      const amount = parseUsd(raw);
      if (amount === null || amount <= 0n) bad.push(raw);
      else rows.push({ raw, amount, delta: roundUpDelta(amount, roundTo, mult) });
    }
    return { rows, bad, total: rows.reduce((s, r) => s + r.delta, 0n) };
  }, [text, roundTo, mult]);

  return (
    <GlassCard title={t('docs.calc.title')} accent={t('docs.calc.accent')} accentTone="ink" icon="/icons/spare/roundup-rules.png">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <HoloLabel as="label" htmlFor="docs-calc-amounts">
          {t('docs.calc.amountsLabel')}
        </HoloLabel>
        <HoloInput
          id="docs-calc-amounts"
          prefix="$"
          value={text}
          onChange={(e) => setText(e.target.value)}
          inputMode="decimal"
          invalid={bad.length > 0}
          block
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <HoloLabel>{t('docs.calc.roundTo')}</HoloLabel>
          <HoloSegmented value={roundTo} onChange={setRoundTo} options={ROUND_TO_VALUES} format={(v) => `$${v}`} ariaLabel={t('docs.calc.roundToAria')} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <HoloLabel>{t('docs.calc.multiplier')}</HoloLabel>
          <HoloSegmented value={mult} onChange={setMult} options={MULTIPLIER_VALUES} format={(v) => `${v}×`} ariaLabel={t('docs.calc.multiplier')} />
        </div>
      </div>
      {bad.length > 0 && (
        <HoloNotice tone="warn" compact>
          {t('docs.calc.notAmount', { list: bad.slice(0, 4).join(', ') })}
          {bad.length > 4 ? '…' : ''}
        </HoloNotice>
      )}
      <DataTable
        head={[t('docs.calc.headPayment'), t('docs.calc.headRoundUp')]}
        align={['left', 'right']}
        rows={
          rows.length
            ? rows.map((r) => [formatUsd(r.amount), formatUsd(r.delta)])
            : [['—', '—']]
        }
      />
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <HoloStat label={t('docs.calc.total')} value={formatUsd(total)} size="lg" />
        <HoloText tone="muted" size="xs" style={{ maxWidth: 320 }}>
          {t('docs.calc.note')}
        </HoloText>
      </div>
    </GlassCard>
  );
}

/* ───────────────────────────────── page ───────────────────────────────── */

/** Safety rails: "<b>Lead.</b> rest" keys. */
const SAFETY = [
  tKey('docs.safety.pinned'),
  tKey('docs.safety.oracle'),
  tKey('docs.safety.quote'),
  tKey('docs.safety.caps'),
  tKey('docs.safety.noDouble'),
  tKey('docs.safety.daily'),
  tKey('docs.safety.exit'),
];

/** "What counts as a payment" exclusions (the Whitepaper lists the same keys). */
const PAYMENT_EXCLUSIONS = [
  tKey('payments.excluded.sameAccount'),
  tKey('payments.excluded.toAccount'),
  tKey('payments.excluded.toContracts'),
  tKey('payments.excluded.swaps'),
  tKey('payments.excluded.otherTokens'),
  tKey('payments.excluded.beforeLink'),
];

export default function Docs() {
  const { t } = useTranslation('pages-a');
  const [active, select] = useSectionSpy(SECTION_IDS);
  const sidebar = useSidebar();
  const live = useDocsLive();
  const noFee = t('docs.sweep.noFee');

  return (
    <PublicShell
      pageTitle={t('docs.meta.pageTitle')}
      metaDescription={t('docs.meta.description')}
      kicker={t('docs.meta.kicker')}
      title={t('docs.meta.title')}
      subtitle={t('docs.meta.subtitle')}
      version="S1"
      art="/icons/spare/roundup-rules.png"
      heroSeed={5}
      sidebar={sidebar}
      activeId={active}
      onSelect={select}
    >
      {/* ── Start here ─────────────────────────────────────────── */}
      <DocSection id="overview" label={t('docs.nav.overview')} kicker={t('docs.nav.start')}>
        <GlassCard title="Spare" icon="/icons/spare-logo.png">
          <H3>{t('docs.overview.heading')}</H3>
          <P>{t('docs.overview.p1')}</P>
          <P>{t('docs.overview.p2')}</P>
        </GlassCard>
        <Grid min={150}>
          <StatTile label={t('docs.overview.statRoundTo')} value="$1 · $5 · $10" sub={t('docs.overview.statRoundToSub')} />
          <StatTile label={t('docs.overview.statSweepAt')} value={live.threshold} sub={t(LIVE_SUB[live.paramsState])} loading={live.paramsState === 'loading'} />
          <StatTile label={t('docs.overview.statFee')} value={live.fee} sub={t(LIVE_SUB[live.paramsState])} loading={live.paramsState === 'loading'} />
          <StatTile
            label={t('docs.overview.statStocks')}
            value={live.activeCount}
            sub={t(LIVE_SUB[live.universeState])}
            loading={live.universeState === 'loading'}
          />
        </Grid>
        <GlassCard title={t('docs.overview.exampleTitle')} bar="lilac" accent="$3.75 → $0.25" accentTone="ink">
          <P>{t('docs.overview.example')}</P>
        </GlassCard>
        <Ctas>
          <LinkButton to="/" variant="primary">
            {t('common.openSpare')}
          </LinkButton>
          <LinkButton to="/universe">{t('docs.overview.seeStocks')}</LinkButton>
        </Ctas>
      </DocSection>

      <DocSection id="quickstart" label={t('docs.quickstart.label')} kicker={t('docs.nav.quickstart')}>
        <GlassCard title={t('docs.nav.quickstart')} icon="/icons/spare/link-wallet.png">
          <Steps
            items={[
              <Trans key="1" t={t} i18nKey="docs.quickstart.s1" components={BOLD} />,
              <Trans key="2" t={t} i18nKey="docs.quickstart.s2" components={BOLD} />,
              <Trans key="3" t={t} i18nKey="docs.quickstart.s3" components={BOLD} />,
              <Trans key="4" t={t} i18nKey="docs.quickstart.s4" components={BOLD} />,
              <Trans key="5" t={t} i18nKey="docs.quickstart.s5" components={BOLD} />,
            ]}
          />
          <P>{t('docs.quickstart.after')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="payments" label={t('payments.title')}>
        <GlassCard title={t('docs.payments.cardTitle')} bar="lilac">
          <P>{t('payments.definition')}</P>
          <H3>{t('docs.payments.notCounted')}</H3>
          <Bullets items={PAYMENT_EXCLUSIONS.map((k) => t(k))} />
        </GlassCard>
      </DocSection>

      {/* ── Using Spare ─────────────────────────────────────────── */}
      <DocSection id="link" label={t('docs.nav.link')} kicker={t('docs.nav.using')}>
        <GlassCard title={t('shell:appNames.link-wallet')} icon="/icons/spare/link-wallet.png">
          <P>{t('docs.link.p1')}</P>
          <P>{t('docs.link.p2')}</P>
          <P>{t('docs.link.p3')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="rules" label={t('docs.nav.rules')}>
        <GlassCard title={t('shell:appNames.roundup-rules')} icon="/icons/spare/roundup-rules.png">
          <P>
            <Trans t={t} i18nKey="docs.rules.formula" components={{ code: <CodeTag /> }} />
          </P>
          <DataTable
            head={[
              t('docs.rules.headPayment'),
              t('docs.rules.headTo', { amount: '$1' }),
              t('docs.rules.headTo', { amount: '$5' }),
              t('docs.rules.headTo', { amount: '$10' }),
              t('docs.rules.headToTurbo', { amount: '$1' }),
              t('docs.rules.headToTurbo', { amount: '$5' }),
              t('docs.rules.headToTurbo', { amount: '$10' }),
            ]}
            align={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
            minWidth={560}
            rows={[
              ['$3.75', '$0.25', '$1.25', '$6.25', '$0.75', '$3.75', '$18.75'],
              ['$12.40', '$0.60', '$2.60', '$7.60', '$1.80', '$7.80', '$22.80'],
              ['$7.00', '$0.00', '$3.00', '$3.00', '$0.00', '$9.00', '$9.00'],
            ]}
          />
          <P>{t('docs.rules.cap')}</P>
          <P>{t('docs.rules.off')}</P>
        </GlassCard>
        <RoundUpCalculator />
      </DocSection>

      <DocSection id="mix" label={t('docs.nav.mix')}>
        <GlassCard title={t('shell:appNames.stock-mix')} icon="/icons/spare/stock-mix.png" accent={<LiveTag state={live.universeState} />}>
          <P>{t('docs.mix.body')}</P>
          <MixUniverse live={live} />
          <Ctas>
            <LinkButton to="/universe" size="sm">
              {t('docs.mix.cta')}
            </LinkButton>
          </Ctas>
        </GlassCard>
      </DocSection>

      <DocSection id="sweep" label={t('docs.nav.sweep')}>
        <GlassCard title={t('shell:appNames.auto-invest')} icon="/icons/spare/auto-invest.png" accent={<LiveTag state={live.paramsState} />}>
          <Steps
            items={[
              t('docs.sweep.s1', { threshold: live.threshold }),
              t('docs.sweep.s2'),
              t('docs.sweep.s3'),
              t('docs.sweep.s4'),
              t('docs.sweep.s5'),
            ]}
          />
          {live.paused === true && (
            <HoloNotice tone="warn" compact title={t('docs.sweep.pausedTitle')}>
              {t('docs.sweep.pausedBody')}
            </HoloNotice>
          )}
        </GlassCard>
        <H3>{t('docs.sweep.outcomes')}</H3>
        <Grid min={210}>
          <GlassCard title={t('docs.sweep.boughtTitle')} accent={t('docs.sweep.boughtAccent')} accentTone="good" bar="holo">
            <P>{t('docs.sweep.boughtBody')}</P>
          </GlassCard>
          <GlassCard title={t('docs.sweep.deferredTitle')} accent={noFee} accentTone="warn" bar="lilac">
            <P>{t('docs.sweep.deferredBody')}</P>
          </GlassCard>
          <GlassCard title={t('docs.sweep.safeTitle')} accent={noFee} accentTone="info" bar="pink">
            <P>{t('docs.sweep.safeBody')}</P>
          </GlassCard>
        </Grid>
        <P>{t('docs.sweep.claim')}</P>
      </DocSection>

      <DocSection id="balance" label={t('docs.nav.balance')}>
        <GlassCard title={t('shell:appNames.spare-balance')} icon="/icons/spare/spare-balance.png">
          <P>{t('docs.balance.p1')}</P>
          <P>
            <Trans t={t} i18nKey="docs.balance.p2" components={BOLD} />
          </P>
          <P>{t('docs.balance.p3')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="fund" label={t('shell:appNames.fund-wallet')}>
        <GlassCard title={t('shell:appNames.fund-wallet')} icon="/icons/spare/fund-wallet.png">
          <P>{t('docs.fund.p1')}</P>
          <P>{t('docs.fund.p2')}</P>
          <P>{t('docs.fund.p3')}</P>
          <Ctas>
            <LinkButton href="https://docs.robinhood.com/chain/bridging/" size="sm">
              {t('docs.fund.guide')}
            </LinkButton>
          </Ctas>
        </GlassCard>
      </DocSection>

      {/* ── Money ─────────────────────────────────────────────── */}
      <DocSection id="fees" label={t('docs.nav.fees')} kicker={t('docs.nav.money')}>
        <DataTable
          head={[t('docs.fees.headWhat'), t('docs.fees.headFee'), t('docs.fees.headTo')]}
          minWidth={560}
          stack
          rows={[
            [t('docs.fees.conversion'), t('docs.fees.conversionFee'), 'FeeVault'],
            [t('docs.fees.swap'), t('docs.fees.swapFee'), 'FeeVault'],
            [t('docs.fees.deferred'), t('docs.fees.none'), '—'],
            [t('docs.fees.account'), t('docs.fees.none'), '—'],
            [t('docs.fees.pool'), t('docs.fees.poolFee'), t('docs.fees.lps')],
            [t('docs.fees.gas'), t('docs.fees.gasFee'), t('docs.fees.network')],
          ]}
        />
        <GlassCard title={t('docs.fees.ceilingTitle')} bar="lilac" accent={<LiveTag state={live.maxFeeState} />}>
          <P>{t('docs.fees.ceilingBody')}</P>
          <HoloList>
            {/* i18n-ignore: contract function name */}
            <HoloListRow label={t('docs.fees.now')} value={live.fee} hint="SweepExecutor.feeBps()" />
            {/* i18n-ignore: contract function name */}
            <HoloListRow label={t('docs.fees.ceiling')} value={live.maxFee} hint="SweepExecutor.MAX_FEE_BPS()" />
          </HoloList>
        </GlassCard>
      </DocSection>

      <DocSection id="limits" label={t('docs.nav.limits')}>
        <GlassCard title={t('docs.limits.title')} icon="/icons/spare/spare-activity.png">
          <HoloList>
            <HoloListRow label={t('docs.limits.roundTo')} value="$1 / $5 / $10" />
            <HoloListRow label={t('docs.limits.multiplier')} value="1× – 5×" />
            <HoloListRow label={t('docs.limits.wallets')} value={t('docs.limits.walletsValue')} />
            <HoloListRow label={t('docs.limits.cap')} value={t('docs.limits.capValue')} />
            <HoloListRow label={t('docs.limits.threshold')} value={live.threshold} hint={t(LIVE_SUB[live.paramsState])} />
            <HoloListRow label={t('docs.limits.sweeps')} value={t('docs.limits.sweepsValue')} />
            <HoloListRow label={t('docs.limits.counts')} value={t('docs.limits.countsValue')} />
            <HoloListRow label={t('docs.limits.perMix')} value={t('docs.limits.perMixValue')} />
          </HoloList>
        </GlassCard>
      </DocSection>

      {/* ── Trust ─────────────────────────────────────────────── */}
      <DocSection id="safety" label={t('docs.nav.safety')} kicker={t('docs.nav.trust')}>
        <GlassCard title={t('docs.nav.safety')} bar="lilac">
          <Bullets items={SAFETY.map((k) => <Trans key={k} t={t} i18nKey={k} components={BOLD} />)} />
        </GlassCard>
        <GlassCard title={t('docs.safety.collectionTitle')} icon="/icons/spare/spare-activity.png">
          <H3>{t('docs.safety.verifiedHeading')}</H3>
          <P>{t('docs.safety.verifiedBody')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="risks" label={t('docs.nav.risks')}>
        <GlassCard title={t('docs.risks.cardTitle')} bar="pink" accent={t('docs.risks.accent')} accentTone="warn">
          {/* Shared with /terms §Risks (verbatim) — edit risks.items.* in the pages-a dictionaries. */}
          <Bullets items={SPARE_RISK_KEYS.map((k) => <Trans key={k} t={t} i18nKey={k} components={BOLD} />)} />
          <HoloList>
            <HoloListRow label={t('docs.risks.owner')} value={<Addr address={OWNER} />} hint={t('docs.risks.ownerHint')} />
            <HoloListRow label={t('docs.risks.keeper')} value={<Addr address={KEEPER} />} hint={t('docs.risks.keeperHint')} />
          </HoloList>
        </GlassCard>
      </DocSection>

      <DocSection id="eligibility" label={t('docs.nav.eligibility')}>
        <GlassCard
          title={t('docs.eligibility.title')}
          bar="lilac"
          accent={
            live.enforcedState === 'live' ? (
              <HoloBadge
                label={t('docs.eligibility.gateBadge', { state: live.enforced ? t('docs.eligibility.on') : t('docs.eligibility.off') })}
                tone={live.enforced ? 'good' : 'warn'}
                variant="solid"
              />
            ) : (
              <LiveTag state={live.enforcedState} />
            )
          }
        >
          <P>{t('docs.eligibility.body')}</P>
          <HoloList>
            <HoloListRow
              label={t('docs.eligibility.gate')}
              value={
                live.enforcedState === 'live'
                  ? live.enforced
                    ? t('docs.eligibility.on')
                    : t('docs.eligibility.off')
                  : live.enforcedState === 'loading'
                    ? '…'
                    : '—'
              }
              hint={live.enforcedState === 'fallback' ? t('docs.eligibility.hintFallback') : t('docs.eligibility.hintLive')}
            />
          </HoloList>
        </GlassCard>
      </DocSection>

      <DocSection id="contracts" label={t('docs.nav.contracts')}>
        <P>{t('docs.contracts.body')}</P>
        <SpareContractsTable />
        <Ctas>
          <LinkButton to="/devtools">{t('docs.contracts.cta')}</LinkButton>
        </Ctas>
      </DocSection>

      {/* ── Help ─────────────────────────────────────────────── */}
      <DocSection id="faq" label={t('docs.nav.faq')} kicker={t('docs.nav.help')}>
        <Faq
          items={[
            { q: t('docs.faq.account.q'), a: t('docs.faq.account.a') },
            { q: t('docs.faq.saturday.q'), a: t('docs.faq.saturday.a') },
            { q: t('docs.faq.noRoundUp.q'), a: t('docs.faq.noRoundUp.a') },
            {
              q: t('docs.faq.where.q'),
              a: <Trans t={t} i18nKey="docs.faq.where.a" components={{ universe: <Link to="/universe" /> }} />,
            },
            { q: t('docs.faq.cap.q'), a: t('docs.faq.cap.a') },
            { q: t('docs.faq.stop.q'), a: t('docs.faq.stop.a') },
            { q: t('docs.faq.private.q'), a: t('docs.faq.private.a') },
            { q: t('docs.faq.interest.q'), a: t('docs.faq.interest.a') },
            {
              q: t('docs.faq.token.q'),
              a: <Trans t={t} i18nKey="docs.faq.token.a" components={{ roadmap: <Link to="/roadmap" /> }} />,
            },
          ]}
        />
      </DocSection>

      <DocSection id="glossary" label={t('docs.nav.glossary')}>
        <DataTable
          head={[t('docs.glossary.headSay'), t('docs.glossary.headMeaning')]}
          minWidth={480}
          stack
          rows={GLOSSARY.map(([term, meaning]) => [<strong key="t">{t(term)}</strong>, typeof meaning === 'string' ? t(meaning) : meaning])}
        />
      </DocSection>
    </PublicShell>
  );
}

/** [term key, meaning key | node]: pages-a keys, translated at render. */
const GLOSSARY: [string, ReactNode][] = [
  [tKey('docs.glossary.items.account.term'), tKey('docs.glossary.items.account.meaning')],
  [tKey('docs.glossary.items.spending.term'), tKey('docs.glossary.items.spending.meaning')],
  [tKey('docs.glossary.items.roundUp.term'), <Code key="c">(roundTo − amount mod roundTo) × multiplier</Code>], // i18n-ignore: code
  [tKey('docs.glossary.items.turbo.term'), tKey('docs.glossary.items.turbo.meaning')],
  [tKey('docs.glossary.items.spare.term'), tKey('docs.glossary.items.spare.meaning')],
  [tKey('docs.glossary.items.cap.term'), tKey('docs.glossary.items.cap.meaning')],
  [tKey('docs.glossary.items.mix.term'), tKey('docs.glossary.items.mix.meaning')],
  [tKey('docs.glossary.items.sweep.term'), tKey('docs.glossary.items.sweep.meaning')],
  [tKey('docs.glossary.items.deferred.term'), tKey('docs.glossary.items.deferred.meaning')],
  [tKey('docs.glossary.items.safeSettled.term'), tKey('docs.glossary.items.safeSettled.meaning')],
  [tKey('docs.glossary.items.keeper.term'), tKey('docs.glossary.items.keeper.meaning')],
  [tKey('docs.glossary.items.fund.term'), tKey('docs.glossary.items.fund.meaning')],
  [tKey('docs.glossary.items.universe.term'), tKey('docs.glossary.items.universe.meaning')],
  [tKey('docs.glossary.items.mcp.term'), tKey('docs.glossary.items.mcp.meaning')],
];
