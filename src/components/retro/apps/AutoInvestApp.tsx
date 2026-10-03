/**
 * AutoInvestApp — when the keeper will sweep this account, and why (or why not).
 *
 * All from Robinhood Chain:
 *   SweepExecutor  threshold(), feeBps(), epochLength(), currentEpoch(), paused(),
 *                  sweptEpoch(account)   (== currentEpoch when swept this epoch)
 *   CashPark       valueOf / pending / units(account), adapter(), isFresh()
 *   ScreeningGate  isEligible(account), enforced()
 *   ElectionRegistry mixOf(account) + StockRouter.oracleStatus per leg
 *
 * `sweep()` is keeper-only on-chain, so there is deliberately no button: the
 * keeper sweeps every eligible account once per epoch (epoch =
 * floor(ts / epochLength) + 1) once its spare reaches the threshold.
 *
 * The verdict mirrors the keeper's own gate: it holds the WHOLE account while
 * any ACTIVE leg's oracle is not OK; a deactivated leg does not block — the
 * executor safe-settles it to USDG. "Swept this epoch" is checked against the
 * sweep's receipt, because a sweep whose every leg deferred bought nothing.
 * A connected spending wallet sees the account it feeds (useSpareAccount).
 *
 * Presentation: Spare Holo (an "Auto-buy threshold  $5  [Confirm]" dialog card).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { cashParkAbi, electionRegistryAbi, ruleRegistryAbi, screeningGateAbi, sweepExecutorAbi } from '@/lib/spare-chain/abis';
import { BLOCKS_PER_SECOND, findEpochSweep } from '@/lib/spare-chain/activity';
import { SPARE, SPARE_CHAIN_ID, sameAddress, symbolOf } from '@/lib/spare-chain/addresses';
import { collectionState } from '@/lib/spare-chain/consent';
import { humanizeError } from '@/lib/spare-chain/errors';
import { oracleView, usePullConsent, useSpareDeployment, useSweepParams, useUniverse, type UniverseAsset } from '@/lib/spare-chain/hooks';
import { formatBps, formatUsd, pctOf, roundUpDelta, type ChainRule } from '@/lib/spare';
import { WalletPicker } from '@/components/retro/WalletPicker';
import { Trans, getT, tKey, useTranslation } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  FONT_PIXEL, FONT_TEXT, INK,
  HoloBadge, HoloButton, HoloCard, HoloDivider, HoloHero, HoloMessageIcon, HoloNotice, HoloProgress, HoloScreen,
  HoloStar, HoloStat, HoloTable, HoloText, HoloTitle,
  type HoloColumn, type HoloMessageKind, type HoloTone,
} from '@/components/retro/holo';
import { AppCanvas, DeployingNotice, Hint, MutedWell, SpareGate, WithSpareAccount } from './spare/SpareUi';
import { HINT, ROW, type Tone } from './spare/styles';

const chainId = SPARE_CHAIN_ID;
const tf = getT('apps-b');

/** Win98 data tones (up · down · warn · info · mono · muted) → Holo tones. */
const holoTone = (t: Tone): HoloTone => (t === 'up' ? 'good' : t === 'down' ? 'bad' : t === 'mono' ? 'ink' : t);

/** Two cards side by side on a wide window, stacked at phone width. Both cards fill the row height. */
const PAIR: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(270px, 100%), 1fr))',
  gap: 12,
  alignItems: 'stretch',
};
/** Card body that grows with a stretched PAIR row, so the frame and dither drift reach the bottom. */
const FILL_BODY: CSSProperties = { flex: 1 };

/** "1 linked wallet" / "2 linked wallets": a count with a real plural. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Copy from the chain libs still carries lazy "N noun(s)" counts
 * ("1 linked wallet(s), all authorized."): print them as real plurals. Matches a
 * count, an optional one-word qualifier and the noun; leaves everything else as is.
 */
function tidyCounts(text: string): string {
  return text.replace(/\b(\d+) ((?:[A-Za-z-]+ )?)([A-Za-z-]+)\(s\)/g, (_m, n: string, qualifier: string, noun: string) =>
    plural(Number(n), `${qualifier}${noun}`),
  );
}

/** `compact`: the unspaced form for big stat numerals (identical in English). */
function fmtDuration(secs: number, compact = false): string {
  if (secs <= 0) return tf('shared.dur.now');
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return compact ? tf('shared.dur.hmShort', { h, m: mm }) : tf('shared.dur.hm', { h, m: mm });
  return compact ? tf('shared.dur.msShort', { m, s: ss }) : tf('shared.dur.ms', { m, s: ss });
}

/** One qualitative policy clause: a deep-indigo "ROUND UP" style tag + the rule. */
function PolicyLine({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div role="listitem" className="holo-list__row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: '5px 12px' }}>
      <span style={{ flex: '0 0 104px' }}>
        <HoloBadge label={term} variant="solid" />
      </span>
      <span style={{ flex: '1 1 240px', minWidth: 0, fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.55, color: INK.body }}>{children}</span>
    </div>
  );
}

const ICON_FOR: Record<HoloTone, HoloMessageKind> = {
  good: 'success', warn: 'warn', bad: 'error', info: 'info', muted: 'info', ink: 'info', holo: 'info',
};

/** One line of the "will I be swept" checklist. */
function Check({ ok, label, detail, tone }: { ok: boolean | null; label: string; detail: ReactNode; tone?: Tone }) {
  const tn: Tone = tone ?? (ok == null ? 'muted' : ok ? 'up' : 'warn');
  const ht = holoTone(tn);
  return (
    <div role="listitem" className="holo-list__row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: '5px 10px' }}>
      <span style={{ flex: '0 0 214px', maxWidth: '100%', display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <HoloMessageIcon kind={ICON_FOR[ht]} size={18} />
        <HoloBadge label={label} tone={ht} />
      </span>
      <span style={{ flex: '1 1 220px', minWidth: 0, fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.5, color: INK.body, paddingTop: 2 }}>{detail}</span>
    </div>
  );
}

/** The no-wallet call to action: holographic mark, one line of why, one big button. */
function ConnectCard({ why }: { why: ReactNode }) {
  const { t } = useTranslation('apps-b');
  const [open, setOpen] = useState(false);
  return (
    <HoloCard title={t('shell:common.wallet')} accent={t('shell:common.notConnected')} accentTone="warn" bar="lilac" bodyStyle={FILL_BODY}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <HoloStar size={64} />
        <div style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <HoloTitle as="h2" size="sm">{t('shell:common.connectWallet')}</HoloTitle>
          <HoloText size="sm">{why}</HoloText>
        </div>
      </div>
      <div style={ROW}>
        <HoloButton variant="primary" size="lg" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? t('shell:common.hideWallets') : t('shell:common.connectWallet')}
        </HoloButton>
        <span style={HINT}>{t('shell:common.walletPillHint')}</span>
      </div>
      {open && <WalletPicker variant="holo" onClose={() => setOpen(false)} />}
    </HoloCard>
  );
}

/* ── the disconnected example: sample payments rounding up toward a sample threshold ── */

const EXAMPLE_THRESHOLD = 5_000_000n; // $5 example auto-buy threshold
/** `what` is an apps-b key (unique, so it doubles as the row key). */
const EXAMPLE_PAYMENTS: { what: string; amount: bigint }[] = [
  { what: tKey('autoInvest.example.items.coffee'), amount: 3_750_000n },
  { what: tKey('autoInvest.example.items.lunch'), amount: 12_400_000n },
  { what: tKey('autoInvest.example.items.ride'), amount: 7_150_000n },
  { what: tKey('autoInvest.example.items.groceries'), amount: 23_300_000n },
  { what: tKey('autoInvest.example.items.books'), amount: 9_050_000n },
];
type ExampleRow = { what: string; paid: bigint; to: bigint; spare: bigint } & Record<string, unknown>;
// Same arithmetic as RoundUp.sol: a $1 round-up at 1×.
const EXAMPLE_ROWS: ExampleRow[] = EXAMPLE_PAYMENTS.map((p) => {
  const spare = roundUpDelta(p.amount, 1, 1);
  return { what: p.what, paid: p.amount, to: p.amount + spare, spare };
});
const EXAMPLE_PARKED = EXAMPLE_ROWS.reduce((s, r) => s + r.spare, 0n);

/** Column labels are translated at render (the `t` of the card that shows them). */
function exampleCols(): HoloColumn<ExampleRow>[] {
  return [
    { key: 'what', label: tf('autoInvest.example.cols.payment'), width: 'minmax(72px, 1fr)', render: (r) => tf(r.what) },
    { key: 'paid', label: tf('autoInvest.example.cols.paid'), width: 66, align: 'right', render: (r) => formatUsd(r.paid) },
    { key: 'to', label: tf('autoInvest.example.cols.roundsTo'), width: 90, align: 'right', render: (r) => formatUsd(r.to) },
    { key: 'spare', label: tf('autoInvest.example.cols.spare'), width: 70, align: 'right', render: (r) => <strong>+{formatUsd(r.spare)}</strong> },
  ];
}

function ExampleSweepCard() {
  const { t } = useTranslation('apps-b');
  return (
    <HoloCard
      title={t('autoInvest.example.title')}
      icon="/icons/spare/auto-invest.png"
      accent={t('shell:common.example')}
      accentTone="ink"
      bodyStyle={FILL_BODY}
    >
      <HoloText size="sm" tone="muted">{t('autoInvest.example.note')}</HoloText>
      <HoloTable columns={exampleCols()} rows={EXAMPLE_ROWS} rowKey={(r) => r.what} dense minWidth={300} ariaLabel={t('autoInvest.example.aria')} />
      <HoloProgress
        value={pctOf(EXAMPLE_PARKED, EXAMPLE_THRESHOLD)}
        segments={20}
        label={t('autoInvest.example.parked')}
        showValue={`${formatUsd(EXAMPLE_PARKED)} / ${formatUsd(EXAMPLE_THRESHOLD)}`}
      />
      <HoloText size="sm">{t('autoInvest.example.toGo', { amount: formatUsd(EXAMPLE_THRESHOLD - EXAMPLE_PARKED) })}</HoloText>
    </HoloCard>
  );
}

/** How one mix leg stands against the keeper's gate. */
type LegState = 'live' | 'waiting' | 'delisted' | 'unknown';

function legState(asset: UniverseAsset | undefined): LegState {
  if (!asset) return 'unknown';
  // Deactivated: the executor safe-settles it to USDG before any oracle check.
  if (!asset.active) return 'delisted';
  if (asset.status == null) return 'unknown';
  return asset.status === 0 ? 'live' : 'waiting';
}

/** The keeper's standing rules — static copy, with the live fee once it is read. */
function PolicyCard({ feeBps }: { feeBps?: number }) {
  const { t } = useTranslation('apps-b');
  return (
    <HoloCard title={t('autoInvest.policy.title')} accent={t('autoInvest.policy.accent')} accentTone="info" bar="lilac">
      <div className="holo-list" role="list" aria-label={t('autoInvest.policy.aria')}>
        <PolicyLine term={t('autoInvest.policy.venue.term')}>{t('autoInvest.policy.venue.body')}</PolicyLine>
        <PolicyLine term={t('autoInvest.policy.price.term')}>{t('autoInvest.policy.price.body')}</PolicyLine>
        <PolicyLine term={t('autoInvest.policy.waiting.term')}>{t('autoInvest.policy.waiting.body')}</PolicyLine>
        <PolicyLine term={t('autoInvest.policy.deferred.term')}>{t('autoInvest.policy.deferred.body')}</PolicyLine>
        <PolicyLine term={t('autoInvest.policy.delisted.term')}>{t('autoInvest.policy.delisted.body')}</PolicyLine>
        <PolicyLine term={t('autoInvest.policy.fee.term')}>
          {feeBps != null ? t('autoInvest.policy.fee.rate', { fee: `${formatBps(feeBps)}%` }) : t('autoInvest.policy.fee.small')}
        </PolicyLine>
        <PolicyLine term={t('autoInvest.policy.delivery.term')}>{t('autoInvest.policy.delivery.body')}</PolicyLine>
      </div>
    </HoloCard>
  );
}

export function AutoInvestApp() {
  const { t } = useTranslation('apps-b');
  const isMobile = useIsMobile();
  const { isConnected } = useAccount();
  const { deployed, checking, error } = useSpareDeployment();
  // No wallet and nothing on-chain yet: show how a sweep fills, plus the deploying notice.
  const preDeploy = !isConnected && !deployed && !checking;
  return (
    <AppCanvas>
      <HoloHero
        art="/icons/spare/auto-invest.png"
        kicker={t('autoInvest.hero.kicker')}
        title={t('shell:appNames.auto-invest')}
        subtitle={t('autoInvest.hero.subtitle')}
        description={t('autoInvest.hero.description')}
        aside={<HoloBadge label={t('autoInvest.hero.badge')} variant="solid" />}
        compact={isMobile}
        size="lg"
        seed={47}
      />
      {preDeploy ? (
        <>
          <div style={PAIR}>
            <ExampleSweepCard />
            <ConnectCard why={t('autoInvest.connectWhy')} />
          </div>
          <DeployingNotice checking={false} error={error} />
          <PolicyCard />
        </>
      ) : (
        <SpareGate>
          <WithSpareAccount what={t('autoInvest.what')}>
            {(v) => <AutoInvestBody account={v.account} />}
          </WithSpareAccount>
        </SpareGate>
      )}
    </AppCanvas>
  );
}

function AutoInvestBody({ account }: { account?: Address }) {
  const { t } = useTranslation('apps-b');
  const me = account;
  const isConnected = !!account;
  const client = usePublicClient({ chainId });
  const { params, error: paramsError } = useSweepParams(true);
  const { assets } = useUniverse({ enabled: isConnected });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const acct = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'sweptEpoch', args: [me!], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'valueOf', args: [me!], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'pending', args: [me!], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'units', args: [me!], chainId },
      { address: SPARE.ScreeningGate, abi: screeningGateAbi, functionName: 'isEligible', args: [me!], chainId },
      { address: SPARE.ScreeningGate, abi: screeningGateAbi, functionName: 'enforced', chainId },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'mixOf', args: [me!], chainId },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'hasOwnMix', args: [me!], chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'ruleOf', args: [me!], chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'walletsOf', args: [me!], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'adapter', chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'isFresh', chainId },
    ],
    query: { enabled: !!me, refetchInterval: 30_000 },
  });

  const threshold = params?.threshold ?? 0n;
  const epochLength = params?.epochLength ?? 86_400n;
  const currentEpoch = params?.currentEpoch ?? 0n;
  // Epoch k covers [(k-1)·L, k·L): the next one opens at currentEpoch · L.
  const nextOpens = Number(currentEpoch * epochLength);
  const secsToNext = Math.max(0, nextOpens - now);
  // Share of the current epoch already elapsed (display only).
  const epochSecs = Number(epochLength);
  const epochPct = epochSecs > 0 ? Math.min(100, Math.max(0, ((epochSecs - secsToNext) / epochSecs) * 100)) : 0;

  const d = acct.data;
  const sweptEpoch = d?.[0];
  const value = d?.[1] ?? 0n;
  const pending = d?.[2] ?? 0n;
  const units = d?.[3] ?? 0n;
  const screened = d?.[4];
  const enforced = d?.[5];
  const mix = (d?.[6] ?? []) as readonly { asset: Address; bps: number }[];
  const hasOwn = d?.[7];
  const rule: ChainRule | undefined = d ? { roundTo: Number(d[8].roundTo), multiplier: Number(d[8].multiplier), weeklyCap: BigInt(d[8].weeklyCap), enabled: d[8].enabled } : undefined;
  const wallets = d?.[9] as readonly Address[] | undefined;
  const adapter = d?.[10] as Address | undefined;
  const fresh = d?.[11];
  const { consents } = usePullConsent(wallets, rule?.weeklyCap);
  const collection = collectionState(rule, consents);

  const sweptThisEpoch = sweptEpoch != null && currentEpoch > 0n && sweptEpoch === currentEpoch;
  const overThreshold = threshold > 0n && value >= threshold;
  const legs = mix.map((l) => {
    const asset = assets.find((a) => sameAddress(a.token, l.asset));
    return { leg: l, asset, state: legState(asset) };
  });
  // The keeper holds the whole account while ANY active leg cannot trade.
  const legsWaiting = legs.filter((x) => x.state === 'waiting');
  const legsUnknown = legs.filter((x) => x.state === 'unknown');

  // sweptEpoch is set before any leg settles: read the sweep's receipt to see
  // whether anything was actually bought (or safe-settled) this epoch.
  const outcomeQ = useQuery({
    queryKey: ['spare', 'epochSweep', me ?? '', currentEpoch.toString()],
    enabled: !!client && !!me && sweptThisEpoch && epochLength > 0n,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const head = await client!.getBlock();
      const epochStart = (currentEpoch - 1n) * epochLength;
      const secsBack = head.timestamp > epochStart ? head.timestamp - epochStart : 0n;
      // ~10 blocks/s plus 10 minutes of slack; the scan stops at the first hit.
      const back = (secsBack + 600n) * BLOCKS_PER_SECOND;
      const from = head.number > back ? head.number - back : 0n;
      return findEpochSweep(client!, me!, currentEpoch, from, head.number, signal);
    },
  });
  const outcome = sweptThisEpoch ? outcomeQ.data ?? null : null;
  const allDeferred = !!outcome && outcome.withdrawn > 0n && outcome.settled === 0n;

  const parkLabel = !adapter
    ? '—'
    : sameAddress(adapter, SPARE.UsdgParkAdapter)
    ? t('autoInvest.park.usdg')
    : sameAddress(adapter, SPARE.SgovParkAdapter)
    ? t('autoInvest.park.sgov')
    : t('shared.customAdapter');

  let verdict: { text: string; tone: Tone };
  if (!params) verdict = { text: t('shared.reading'), tone: 'muted' };
  else if (params.paused) verdict = { text: t('autoInvest.verdict.paused'), tone: 'down' };
  else if (!me) verdict = { text: t('autoInvest.verdict.connect'), tone: 'muted' };
  else if (!d) verdict = { text: t('shared.reading'), tone: 'muted' };
  else if (sweptThisEpoch)
    verdict = allDeferred ? { text: t('autoInvest.verdict.attemptedDeferred'), tone: 'warn' } : { text: t('autoInvest.verdict.swept'), tone: 'up' };
  else if (!overThreshold) verdict = { text: t('autoInvest.verdict.below'), tone: 'info' };
  else if (screened === false) verdict = { text: t('autoInvest.verdict.notEligible'), tone: 'down' };
  else if (mix.length === 0) verdict = { text: t('autoInvest.verdict.noMix'), tone: 'warn' };
  else if (legsWaiting.length > 0) verdict = { text: t('autoInvest.verdict.waits'), tone: 'warn' };
  else if (legsUnknown.length > 0) verdict = { text: t('autoInvest.verdict.checking'), tone: 'muted' };
  else verdict = { text: t('autoInvest.verdict.due'), tone: 'up' };

  const nextIn = fmtDuration(secsToNext);
  const epochNo = currentEpoch.toString();
  let sweptDetail: string;
  if (!sweptThisEpoch) {
    sweptDetail = sweptEpoch && sweptEpoch > 0n ? t('autoInvest.swept.last', { epoch: sweptEpoch.toString() }) : t('autoInvest.swept.never');
  } else if (allDeferred && outcome) {
    const why = outcome.deferredLegs
      .map((l) =>
        l.status === 0
          ? t('autoInvest.swept.legSwapFail', { sym: symbolOf(l.asset) })
          : t('autoInvest.swept.legStatus', { sym: symbolOf(l.asset), status: oracleView(l.status).label.toLowerCase() }),
      )
      .join(t('shared.listSep'));
    sweptDetail = t('autoInvest.swept.allDeferred', { epoch: epochNo, why, amount: formatUsd(outcome.deferred), next: nextIn });
  } else if (outcome) {
    sweptDetail =
      outcome.deferred > 0n
        ? t('autoInvest.swept.settledDeferred', { epoch: epochNo, settled: formatUsd(outcome.settled), deferred: formatUsd(outcome.deferred), next: nextIn })
        : t('autoInvest.swept.settled', { epoch: epochNo, settled: formatUsd(outcome.settled), next: nextIn });
  } else {
    sweptDetail = outcomeQ.isFetching
      ? t('autoInvest.swept.checking', { epoch: epochNo, next: nextIn })
      : t('autoInvest.swept.plain', { epoch: epochNo, next: nextIn });
  }

  const verdictTone = holoTone(verdict.tone);
  const verdictFill = verdictTone === 'good' ? 'good' : verdictTone === 'warn' ? 'warn' : verdictTone === 'bad' ? 'bad' : 'holo';

  return (
    <>
      {paramsError && (
        <HoloNotice tone="error" compact title={t('autoInvest.engine.readFail')}>{humanizeError(paramsError)}</HoloNotice>
      )}

      {/* ─── The engine: protocol-wide, readable without a wallet ─── */}
      <HoloCard
        title={t('autoInvest.engine.title')}
        icon="/icons/spare/auto-invest.png"
        accent={params ? (params.paused ? t('shell:common.paused') : t('shell:common.live')) : t('shared.reading')}
        accentTone={params ? (params.paused ? 'bad' : 'good') : 'muted'}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '14px 28px' }}>
          <HoloStat label={t('autoInvest.engine.sweepsAt')} value={params ? formatUsd(threshold) : '—'} size="xl" sub={t('autoInvest.engine.sweepsAtSub')} />
          <div style={{ flex: '1 1 260px', minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: '12px 16px' }}>
            <HoloStat label={t('autoInvest.engine.fee')} value={params ? `${formatBps(params.feeBps)}%` : '—'} size="md" />
            <HoloStat label={t('autoInvest.engine.epoch')} value={params ? `#${currentEpoch.toString()}` : '—'} size="md" />
            <HoloStat label={t('autoInvest.engine.epochLength')} value={params ? fmtDuration(Number(epochLength), true) : '—'} size="md" />
            <HoloStat label={t('autoInvest.engine.nextEpochIn')} value={params ? fmtDuration(secsToNext, true) : '—'} size="md" tone="info" />
          </div>
        </div>
        {params && (
          <HoloProgress
            value={epochPct}
            segments={24}
            height={14}
            label={t('autoInvest.engine.epochNo', { epoch: epochNo })}
            showValue={t('autoInvest.engine.nextIn', { time: nextIn })}
            ariaLabel={t('autoInvest.engine.epochAria')}
          />
        )}
        <Hint>
          <Trans
            t={t}
            i18nKey="autoInvest.engine.hint"
            components={{ code: <code style={{ fontFamily: FONT_TEXT, fontWeight: 700, color: INK.info }} /> }}
          />
        </Hint>
      </HoloCard>

      {!isConnected ? (
        <div style={PAIR}>
          <ExampleSweepCard />
          <ConnectCard why={t('autoInvest.connectWhy')} />
        </div>
      ) : (
        <HoloCard title={t('autoInvest.account.title')} icon="/icons/spare/spare-balance.png" accent={verdict.text} accentTone={verdictTone}>
          {acct.error ? (
            <MutedWell>{t('autoInvest.account.readFail', { error: humanizeError(acct.error) })}</MutedWell>
          ) : !d ? (
            <MutedWell>{t('autoInvest.account.reading')}</MutedWell>
          ) : (
            <>
              {/* parked spare vs threshold, with the keeper's verdict on a screen */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: '12px 20px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '10px 22px' }}>
                  <HoloStat label={t('autoInvest.account.parked')} value={formatUsd(value)} size="xl" tone={overThreshold ? 'good' : 'holo'} />
                  <HoloStat label={t('autoInvest.account.threshold')} value={formatUsd(threshold)} size="md" style={{ paddingBottom: 6 }} />
                </div>
                <HoloScreen padding="10px 12px" style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }}>
                  <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: INK.soft }}>
                    {t('autoInvest.account.verdictLabel')}
                  </span>
                  <HoloTitle as="div" size="sm" fill={verdictFill}>{verdict.text}</HoloTitle>
                  <span style={{ ...HINT, color: INK.soft }}>{t('autoInvest.account.nextEpochIn', { time: nextIn })}</span>
                </HoloScreen>
              </div>
              <HoloProgress
                value={pctOf(value, threshold)}
                tone={overThreshold ? 'good' : 'holo'}
                segments={24}
                height={18}
                ariaLabel={t('autoInvest.account.progressAria')}
              />
              <div style={{ ...HINT, marginTop: -4 }}>
                {overThreshold ? t('autoInvest.account.atThreshold') : t('autoInvest.account.toGo', { amount: formatUsd(threshold - value) })}
                {units > 0n ? t('autoInvest.account.pendingUnits', { amount: formatUsd(pending) }) : ''}
              </div>

              <HoloDivider label={t('autoInvest.account.checklist')} />

              <div className="holo-list" role="list" aria-label={t('autoInvest.account.checklist')}>
                <Check
                  ok={!params?.paused}
                  label={params?.paused ? t('shell:common.paused') : t('autoInvest.check.engineLive')}
                  detail={params?.paused ? t('autoInvest.check.pausedDetail') : t('autoInvest.check.liveDetail')}
                />
                <Check
                  ok={overThreshold}
                  label={overThreshold ? t('autoInvest.check.thresholdMet') : t('autoInvest.verdict.below')}
                  tone={overThreshold ? 'up' : 'info'}
                  detail={
                    overThreshold
                      ? t('autoInvest.check.thresholdMetDetail', { value: formatUsd(value), threshold: formatUsd(threshold) })
                      : t('autoInvest.check.belowDetail', { threshold: formatUsd(threshold) })
                  }
                />
                <Check
                  ok={!sweptThisEpoch}
                  label={!sweptThisEpoch ? t('autoInvest.check.notSwept') : allDeferred ? t('autoInvest.check.deferredEpoch') : t('autoInvest.verdict.swept')}
                  tone={!sweptThisEpoch ? 'muted' : allDeferred ? 'warn' : 'up'}
                  detail={sweptDetail}
                />
                <Check
                  ok={screened ?? null}
                  label={screened ? t('autoInvest.check.eligible') : t('autoInvest.check.notCleared')}
                  tone={screened ? 'up' : 'down'}
                  detail={
                    enforced
                      ? screened
                        ? t('autoInvest.check.screenOk')
                        : t('autoInvest.check.screenBlocked')
                      : t('autoInvest.check.screenOff')
                  }
                />
                <Check
                  ok={mix.length > 0}
                  label={mix.length ? (hasOwn ? t('autoInvest.check.ownMix') : t('autoInvest.check.defaultMix')) : t('autoInvest.verdict.noMix')}
                  tone={mix.length ? 'up' : 'warn'}
                  detail={mix.length ? mix.map((l) => `${symbolOf(l.asset)} ${formatBps(Number(l.bps))}%`).join(' · ') : t('autoInvest.check.noMixDetail')}
                />
                {legs.map(({ leg, asset, state }) => {
                  const sym = symbolOf(leg.asset);
                  if (state === 'delisted') {
                    return (
                      <Check
                        key={leg.asset}
                        ok={null}
                        label={t('autoInvest.check.delisted', { sym })}
                        tone="down"
                        detail={t('autoInvest.check.delistedDetail')}
                      />
                    );
                  }
                  if (state === 'unknown') {
                    return (
                      <Check
                        key={leg.asset}
                        ok={null}
                        label={`${sym} —`}
                        tone="muted"
                        detail={asset ? t('autoInvest.check.unknownRouter') : t('autoInvest.check.unknownRegistry')}
                      />
                    );
                  }
                  const v = oracleView(asset?.status ?? null);
                  return (
                    <Check
                      key={leg.asset}
                      ok={state === 'live'}
                      label={`${sym} ${v.label}`}
                      tone={v.tone}
                      detail={state === 'waiting' ? t('autoInvest.check.waitingDetail', { detail: v.detail }) : v.detail}
                    />
                  );
                })}
                <Check
                  ok={collection.collecting}
                  label={collection.label}
                  tone={collection.tone}
                  detail={tidyCounts(collection.detail)}
                />
              </div>
              <span style={HINT}>
                {fresh === false ? t('autoInvest.account.parkInStale', { park: parkLabel }) : t('autoInvest.account.parkIn', { park: parkLabel })}
              </span>
            </>
          )}
        </HoloCard>
      )}

      <PolicyCard feeBps={params?.feeBps} />
    </>
  );
}

export default AutoInvestApp;
