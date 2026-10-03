/**
 * RoundUpRulesApp — the account's round-up rule, read from and written to
 * RuleRegistry on Robinhood Chain.
 *
 *   ruleOf(account)  -> { roundTo 1|5|10, multiplier 1..5, weeklyCap (USDG 6dp), enabled }
 *   setRule(roundTo, multiplier, weeklyCap, enabled)
 *
 * The editor holds a local DRAFT seeded from the chain; nothing changes until
 * "Save rule" confirms. The weekly cap is typed in dollars and converted to
 * base units with string/bigint math (never a float): cap 0 disables accrual.
 * pulledLast7Days / remainingWeeklyCap come from SweepExecutor's rolling
 * 7-day window. The worked example runs the same integer round-up as
 * contracts/src/libraries/RoundUp.sol.
 *
 * "ROUND-UPS ON" is only claimed when something is actually collected: the
 * rule is on AND at least one linked wallet has both pull approvals live
 * (consent.collectionState). A connected spending wallet sees the rule of the
 * account it feeds, read-only.
 *
 * Presentation: Spare Holo ("TURBO ROUND-UPS" hero). Without a wallet the
 * window shows a clearly-labelled, client-side example of the rule and a
 * connect prompt — never live numbers.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { useAccount, useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { ruleRegistryAbi, sweepExecutorAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, shortAddr } from '@/lib/spare-chain/addresses';
import { collectionState } from '@/lib/spare-chain/consent';
import { humanizeError } from '@/lib/spare-chain/errors';
import { txStep, usePullConsent, useSpareDeployment, useSpareTx, useSweepParams } from '@/lib/spare-chain/hooks';
import {
  MAX_UINT64,
  MULTIPLIER_VALUES,
  ROUND_TO_VALUES,
  USDG_UNIT,
  formatUsd,
  parseUsd,
  pctOf,
  roundUpDelta,
  ruleIsActive,
  ruleIsSet,
  usdToInput,
  type ChainRule,
  type Multiplier,
  type RoundTo,
} from '@/lib/spare';
import { WalletPicker } from '@/components/retro/WalletPicker';
import {
  BEVEL_RAISED,
  BEVEL_WELL,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  INK_ON_LIGHT,
  TEXTURE,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloChip,
  HoloDivider,
  HoloHero,
  HoloInput,
  HoloLabel,
  HoloPanel,
  HoloProgress,
  HoloSegmented,
  HoloSparkle,
  HoloStar,
  HoloStat,
  HoloText,
  HoloTitle,
  HoloToggle,
  HoloWindowBody,
  inkFor,
  pixelPath,
  type HoloTone,
} from '@/components/retro/holo';
import { ChainNote, DeployingNotice, Hint, MutedWell, SpareGate, TxStatus, WithSpareAccount } from './spare/SpareUi';
import { HINT, NOTE, ROW, STACK } from './spare/styles';

const chainId = SPARE_CHAIN_ID;
const CAP_PRESETS = [10n, 25n, 50n, 100n].map((d) => d * USDG_UNIT);

/* ─────────────────────────────── local atoms ─────────────────────────────── */

/** Win98 data tones -> Holo tones. */
const TONE_MAP: Record<string, HoloTone> = { up: 'good', down: 'bad', warn: 'warn', info: 'info', mono: 'ink', muted: 'muted' };
const holoTone = (t: string): HoloTone => TONE_MAP[t] ?? 'info';

type TFn = ReturnType<typeof useTranslation>['t'];

/** Built at render so the hints follow the live language. */
const multiplierOptions = (t: TFn) =>
  MULTIPLIER_VALUES.map((m) => ({
    value: m,
    label: `${m}×`,
    hint: m === 1 ? t('roundUpRules.multiplier.none') : t('roundUpRules.multiplier.times', { m }),
  }));

/** Crisp pixel icon from '1'/'0' rows. */
function Px({ rows, scale = 2, color = HOLO.ink }: { rows: readonly string[]; scale?: number; color?: string }) {
  const w = rows[0].length;
  const h = rows.length;
  return (
    <svg aria-hidden focusable="false" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" style={{ display: 'block', flexShrink: 0 }}>
      <path d={pixelPath(rows)} fill={color} />
    </svg>
  );
}

const PX_BARS = ['000000011', '000000011', '000110011', '000110011', '110110011', '110110011', '110110011', '110110011'];
const PX_WALLET = ['0111111100', '1000000010', '1111111111', '1000000001', '1000001111', '1000001011', '1000001111', '1111111111'];
const PX_LOCK = ['00111100', '01000010', '01000010', '11111111', '11111111', '11100111', '11100111', '11111111'];

/** The little icon + caption strip ("1x to 5x | Wallet native | …"). */
function FeatureStrip({ items }: { items: { icon: readonly string[]; text: ReactNode }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: 6, marginTop: 2 }}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: i ? '0 12px' : '0 12px 0 0',
            borderLeft: i ? `1px solid ${HOLO.ink}` : 'none',
          }}
        >
          <Px rows={it.icon} />
          <span style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.25, color: HOLO.ink }}>{it.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Field label above a control. */
function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <HoloLabel as={htmlFor ? 'label' : 'span'} htmlFor={htmlFor} font="chrome" style={{ fontSize: 18, color: INK.body }}>
      {children}
    </HoloLabel>
  );
}

/** One receipt tile: label + value. `hot` = the chrome "spare" tile with a holo numeral. */
function Tile({ label, value, tone, hot = false }: { label: ReactNode; value: string; tone?: HoloTone; hot?: boolean }) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        minWidth: 0,
        padding: '8px 10px 9px',
        background: hot ? `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.chrome}` : HOLO.paper,
        boxShadow: hot ? `0 0 0 1px ${HOLO.ink}, ${BEVEL_RAISED}, 3px 3px 0 0 rgba(42,27,110,.22)` : BEVEL_WELL,
        ...INK_ON_LIGHT,
      }}
    >
      {hot && <HoloSparkle size={11} style={{ position: 'absolute', top: 4, right: 4 }} />}
      <HoloLabel style={{ fontSize: 10 }}>{label}</HoloLabel>
      {hot ? (
        <HoloTitle as="div" size={value.length > 7 ? 'xs' : 'sm'} style={{ textTransform: 'none' }}>
          {value}
        </HoloTitle>
      ) : (
        <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 15, lineHeight: 1.2, color: tone ? inkFor(tone) : INK.body, overflowWrap: 'anywhere' }}>
          {value}
        </span>
      )}
    </div>
  );
}

const TILE_GRID: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 8 };

/*
 * Staircase pads. Every pad is a chrome platform: a hard 1px indigo keyline,
 * a lilac bevel, a lit top face and a light beam down the middle. Idle pads
 * wear quiet lilac chrome; the active pad wears full iridescent chrome, a pink
 * bloom and a sparkle.
 */
const PAD_IDLE_CHROME = 'linear-gradient(135deg, #FFFFFF 0%, #EEE6FF 24%, #D8CAFF 50%, #E2ECFF 74%, #F4EEFF 100%)';
const PAD_IDLE_BEAM = 'linear-gradient(90deg, transparent 38%, rgba(255,255,255,.45) 50%, transparent 62%)';
const PAD_ON_BEAM = 'linear-gradient(90deg, transparent 34%, rgba(255,255,255,.7) 50%, transparent 66%)';
const PAD_IDLE_SHADOW = `0 0 0 1px ${HOLO.ink}, inset 1px 1px 0 0 #FFFFFF, inset -1px -1px 0 0 ${HOLO.bevelLo}, inset -2px -2px 0 0 ${HOLO.lilac}, 2px 2px 0 0 rgba(42,27,110,.18)`;
const PAD_ON_SHADOW = `0 0 0 1px ${HOLO.ink}, ${BEVEL_RAISED}, 3px 3px 0 0 rgba(42,27,110,.28), 0 0 10px 0 rgba(255,160,215,.6)`;
/** The platform's lit top face (sits inside the keyline, above an edge line). */
const PAD_TOP_IDLE = 'linear-gradient(90deg, #FFFFFF 0%, #F7F2FF 55%, #FFFFFF 100%)';
const PAD_TOP_ON = 'linear-gradient(90deg, #FFFFFF 0%, #FFF1E6 35%, #FFE3F4 65%, #FFFFFF 100%)';

/**
 * The TURBO ROUND-UPS staircase: one chrome pad per multiplier, taller as it
 * climbs, with the spare that multiplier would capture. The active pad is lit.
 */
function TurboStairs({ steps, active, caption }: { steps: { m: number; value: string }[]; active: number; caption: string }) {
  const { t } = useTranslation('apps-a');
  return (
    <HoloPanel variant="sunken" texture="halftone" padding="10px 10px 8px" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <HoloLabel style={{ fontSize: 10 }}>{caption}</HoloLabel>
      {/* minHeight fits the tallest column (5x pad + the larger active label), so
          switching the multiplier never makes the panel jump. */}
      <div
        role="img"
        aria-label={t('roundUpRules.stairsAria', { caption, steps: steps.map((s) => `${s.m}× ${s.value}`).join(', ') })}
        style={{ display: 'flex', alignItems: 'flex-end', gap: 7, minHeight: 146, padding: '0 2px 0 1px' }}
      >
        {steps.map((s) => {
          const on = s.m === active;
          return (
            <div key={s.m} style={{ flex: '1 1 0', minWidth: 40, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
              {/* Active: the 16px face (2px outline stays crisp); idle: 12px indigo letters. */}
              <HoloTitle
                as="span"
                size={on ? 'sm' : 'xs'}
                fill={on ? 'holo' : 'ink'}
                align="center"
                style={{ textTransform: 'none', marginBottom: on ? 4 : 2 }}
              >
                {`${s.m}x`}
              </HoloTitle>
              <div
                style={{
                  position: 'relative',
                  height: 14 + s.m * 15,
                  background: on
                    ? `${PAD_ON_BEAM}, ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.chrome}`
                    : `${PAD_IDLE_BEAM}, ${TEXTURE.dither} 0 0 / 4px 4px, ${PAD_IDLE_CHROME}`,
                  boxShadow: on ? PAD_ON_SHADOW : PAD_IDLE_SHADOW,
                }}
              >
                <div
                  aria-hidden
                  style={{
                    position: 'absolute',
                    top: 1,
                    left: 1,
                    right: 2,
                    height: 6,
                    background: on ? PAD_TOP_ON : PAD_TOP_IDLE,
                    boxShadow: `0 1px 0 0 ${on ? HOLO.ink : HOLO.bevelLo}`,
                  }}
                />
                {on && <HoloSparkle size={10} twinkle style={{ position: 'absolute', top: 10, right: 4 }} />}
              </div>
              <span
                title={s.value}
                style={{
                  marginTop: 1,
                  fontFamily: FONT_TEXT,
                  fontWeight: 700,
                  fontSize: 10.5,
                  textAlign: 'center',
                  color: on ? INK.body : INK.muted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {s.value}
              </span>
            </div>
          );
        })}
      </div>
    </HoloPanel>
  );
}

/** Big connect call-to-action (same wallet picker the tray uses). */
function ConnectCard({ why }: { why: ReactNode }) {
  const { t } = useTranslation('apps-a');
  const [open, setOpen] = useState(false);
  return (
    <HoloCard title={t('shell:common.wallet')} accent={t('shell:common.notConnected')} accentTone="warn" bar="lilac">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <HoloStar size={64} />
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
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

/* ─────────────────────────────────── app ─────────────────────────────────── */

interface Draft {
  roundTo: RoundTo;
  multiplier: Multiplier;
  capText: string;
  enabled: boolean;
}

function draftFrom(rule: ChainRule | undefined): Draft {
  if (!rule || !ruleIsSet(rule)) return { roundTo: 1, multiplier: 1, capText: '', enabled: true };
  return {
    roundTo: rule.roundTo as RoundTo,
    multiplier: rule.multiplier as Multiplier,
    capText: usdToInput(rule.weeklyCap),
    enabled: rule.enabled,
  };
}

export function RoundUpRulesApp() {
  const { t } = useTranslation('apps-a');
  const { isConnected } = useAccount();
  return (
    <HoloWindowBody gap={14}>
      <HoloHero
        art="/icons/spare/roundup-rules.png"
        kicker={t('roundUpRules.hero.kicker')}
        title={t('shell:appNames.roundup-rules')}
        subtitle={t('roundUpRules.hero.subtitle')}
        description={t('roundUpRules.hero.description')}
        aside={<HoloBadge label={t('shell:common.onChain')} variant="solid" />}
        seed={18}
        compact={isConnected}
      >
        {!isConnected && (
          <FeatureStrip
            items={[
              { icon: PX_BARS, text: t('roundUpRules.features.range') },
              { icon: PX_WALLET, text: t('roundUpRules.features.native') },
              { icon: PX_LOCK, text: t('roundUpRules.features.cap') },
            ]}
          />
        )}
      </HoloHero>
      {isConnected ? (
        <SpareGate needsWallet why={t('roundUpRules.connectWhy')}>
          <WithSpareAccount what={t('roundUpRules.what')}>
            {(v) => (v.account ? <RulesBody account={v.account} readOnly={v.isSpendingWallet} /> : null)}
          </WithSpareAccount>
        </SpareGate>
      ) : (
        <RulesSignedOut />
      )}
    </HoloWindowBody>
  );
}

/* ───────────────────────────── no wallet: preview ─────────────────────────── */

const EXAMPLE_PAYMENT = 3_750_000n; // $3.75

function RulesSignedOut() {
  const { t } = useTranslation('apps-a');
  const { deployed, checking, error } = useSpareDeployment();
  const [roundTo, setRoundTo] = useState<RoundTo>(1);
  const [multiplier, setMultiplier] = useState<Multiplier>(1);
  const delta = roundUpDelta(EXAMPLE_PAYMENT, roundTo, 1);
  const spare = roundUpDelta(EXAMPLE_PAYMENT, roundTo, multiplier);
  const steps = MULTIPLIER_VALUES.map((m) => ({ m, value: formatUsd(roundUpDelta(EXAMPLE_PAYMENT, roundTo, m)) }));

  return (
    <>
      <HoloCard title={t('roundUpRules.ruleTitle')} accent={t('shell:common.example')} accentTone="ink">
        <HoloText size="sm" tone="muted">
          {t('roundUpRules.example.intro', { payment: formatUsd(EXAMPLE_PAYMENT) })}
        </HoloText>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14, alignItems: 'start' }}>
          <div style={{ ...STACK, gap: 8 }}>
            <FieldLabel>{t('roundUpRules.roundUpTo')}</FieldLabel>
            <HoloSegmented value={roundTo} onChange={setRoundTo} options={ROUND_TO_VALUES} format={(v) => `$${v}`} size="lg" ariaLabel={t('roundUpRules.example.roundAria')} />
            <FieldLabel>{t('roundUpRules.multiplierLabel')}</FieldLabel>
            <HoloSegmented value={multiplier} onChange={setMultiplier} options={multiplierOptions(t)} ariaLabel={t('roundUpRules.example.multiplierAria')} />
          </div>
          <TurboStairs steps={steps} active={multiplier} caption={t('roundUpRules.example.caption', { payment: formatUsd(EXAMPLE_PAYMENT) })} />
        </div>
        <div style={TILE_GRID}>
          <Tile label={t('roundUpRules.payment')} value={formatUsd(EXAMPLE_PAYMENT)} />
          <Tile label={t('roundUpRules.example.next', { roundTo })} value={formatUsd(EXAMPLE_PAYMENT + delta)} />
          <Tile label={t('roundUpRules.example.roundUp')} value={formatUsd(delta)} tone="info" />
          <Tile label={t('roundUpRules.example.spare', { m: multiplier })} value={formatUsd(spare)} hot />
        </div>
        <span style={HINT}>
          {t('roundUpRules.example.note')}
        </span>
      </HoloCard>
      {!deployed && !checking && <DeployingNotice checking={false} error={error} />}
      <ConnectCard why={t('roundUpRules.connectWhy')} />
    </>
  );
}

/* ───────────────────────────── connected: editor ──────────────────────────── */

function RulesBody({ account, readOnly }: { account: Address; readOnly: boolean }) {
  const { t } = useTranslation('apps-a');
  const me = account;
  const tx = useSpareTx();
  const { params } = useSweepParams(true);

  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'ruleOf', args: [me], chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'activeSince', args: [me], chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'walletsOf', args: [me], chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'pulledLast7Days', args: [me], chainId },
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'remainingWeeklyCap', args: [me], chainId },
    ],
    query: { enabled: !!me, refetchInterval: 30_000 },
  });

  const onchain: ChainRule | undefined = reads.data
    ? {
        roundTo: Number(reads.data[0].roundTo),
        multiplier: Number(reads.data[0].multiplier),
        weeklyCap: BigInt(reads.data[0].weeklyCap),
        enabled: reads.data[0].enabled,
      }
    : undefined;
  const activeSince = reads.data?.[1];
  const wallets = reads.data?.[2] as readonly Address[] | undefined;
  const walletCount = wallets?.length ?? 0;
  const { consents } = usePullConsent(wallets, onchain?.weeklyCap);
  const collection = collectionState(onchain, consents);
  const pulled = reads.data?.[3] ?? 0n;
  const remaining = reads.data?.[4] ?? 0n;

  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined));
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  const [sample, setSample] = useState('4.30');

  // Seed the draft from the chain on first read, after a different wallet
  // connects, and after our own save lands — never over unsaved edits.
  const chainKey = onchain ? `${me}:${onchain.roundTo}:${onchain.multiplier}:${onchain.weeklyCap}:${onchain.enabled}` : null;
  const draftCap = parseUsd(draft.capText);
  const dirty =
    !!onchain &&
    (!ruleIsSet(onchain) ||
      draft.roundTo !== onchain.roundTo ||
      draft.multiplier !== onchain.multiplier ||
      draftCap !== onchain.weeklyCap ||
      draft.enabled !== onchain.enabled);
  useEffect(() => {
    if (!chainKey || chainKey === seededFrom) return;
    const sameWallet = seededFrom?.startsWith(`${me}:`);
    if (sameWallet && dirty && tx.state.phase !== 'confirmed') return;
    setDraft(draftFrom(onchain));
    setSeededFrom(chainKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, me, tx.state.phase]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const capInvalid = draft.capText.trim() !== '' && draftCap === null;
  const capTooBig = draftCap !== null && draftCap > MAX_UINT64;
  const capMissing = draft.capText.trim() === '';
  const canSave = !readOnly && !!onchain && dirty && !capInvalid && !capTooBig && !capMissing && !tx.busy;

  const save = () => {
    if (draftCap === null) return;
    tx.run([txStep(t('roundUpRules.tx.save'), {
      address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'setRule',
      args: [draft.roundTo, draft.multiplier, draftCap, draft.enabled],
    })]);
  };

  const pauseNow = () => {
    if (!onchain || !ruleIsSet(onchain)) return;
    tx.run([txStep(t('roundUpRules.tx.pause'), {
      address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'setRule',
      args: [onchain.roundTo, onchain.multiplier, onchain.weeklyCap, false],
    })]);
  };

  /* ── worked example (draft rule, integer math) ── */
  const amount = parseUsd(sample);
  const boundaryDelta = amount == null ? 0n : roundUpDelta(amount, draft.roundTo, 1);
  const captured = amount == null ? 0n : roundUpDelta(amount, draft.roundTo, draft.multiplier);
  const onBoundary = amount != null && amount > 0n && boundaryDelta === 0n;
  const threshold = params?.threshold ?? null;
  const paymentsToSweep = threshold && captured > 0n ? (threshold + captured - 1n) / captured : null;

  // An active rule reads ON only while some linked wallet can really be pulled from.
  // collection.label / collection.detail come from lib/spare-chain/consent.ts, already in the live language.
  const status = !onchain
    ? t('roundUpRules.status.reading')
    : !ruleIsSet(onchain)
      ? t('roundUpRules.status.noRuleYet')
      : ruleIsActive(onchain)
        ? collection.label
        : t('roundUpRules.status.paused');
  const statusTone = !onchain ? 'muted' : !ruleIsSet(onchain) ? 'warn' : ruleIsActive(onchain) ? collection.tone : 'down';
  const capOnChain = onchain?.weeklyCap ?? 0n;
  const ruleSet = !!onchain && ruleIsSet(onchain);
  const exact = (v: bigint) => formatUsd(v, v % 10_000n === 0n ? 2 : 6);

  return (
    <>
      <ChainNote />
      {reads.error && <Hint warn>{t('roundUpRules.readError', { error: humanizeError(reads.error) })}</Hint>}

      {/* ─── The rule as it stands on-chain ─── */}
      <HoloCard title={t('roundUpRules.onChain.title')} icon={<Px rows={PX_BARS} />} accent={status} accentTone={holoTone(statusTone)}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 28px', alignItems: 'flex-start' }}>
          <HoloStat size="lg" label={t('roundUpRules.roundUpTo')} value={!onchain ? '…' : ruleSet ? `$${onchain.roundTo}` : '—'} tone={ruleSet ? 'holo' : 'ink'} />
          <HoloStat size="lg" label={t('roundUpRules.multiplierLabel')} value={!onchain ? '…' : ruleSet ? `${onchain.multiplier}x` : '—'} tone={ruleSet ? 'holo' : 'ink'} />
          <HoloStat
            size="lg"
            label={t('roundUpRules.onChain.weeklyCap')}
            value={!onchain ? '…' : ruleSet ? formatUsd(onchain.weeklyCap) : '—'}
            sub={ruleSet ? t('roundUpRules.onChain.perRolling') : undefined}
            tone={ruleSet ? 'holo' : 'ink'}
          />
        </div>
        <div style={ROW}>
          <HoloBadge label={t('roundUpRules.onChain.badge')} tone="info" dot={false} />
          <span style={HINT}>
            {activeSince && activeSince > 0n && onchain && ruleIsActive(onchain)
              ? walletCount === 0
                ? t('roundUpRules.onChain.noWalletsSince', { block: activeSince.toLocaleString() })
                : t('roundUpRules.onChain.appliesToSince', { count: walletCount, block: activeSince.toLocaleString() })
              : walletCount === 0
                ? t('roundUpRules.onChain.noWallets')
                : t('roundUpRules.onChain.appliesTo', { count: walletCount })}
          </span>
        </div>
        {onchain && ruleIsActive(onchain) && walletCount > 0 && collection.tone === 'warn' && <Hint warn>{collection.detail}</Hint>}
      </HoloCard>

      {onchain && !ruleIsSet(onchain) && (
        <MutedWell>
          {readOnly
            ? t('roundUpRules.noRule.readOnly', { addr: shortAddr(me) })
            : t('roundUpRules.noRule.owner')}
        </MutedWell>
      )}

      {/* ─── Editor: rule + cap side by side where there is room ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 14 }}>
        <HoloCard title={t('roundUpRules.ruleTitle')} accent={`$${draft.roundTo} · ${draft.multiplier}×`} accentTone="info">
          <div style={{ ...STACK, gap: 6 }}>
            <FieldLabel>{t('roundUpRules.roundUpTo')}</FieldLabel>
            <HoloSegmented
              value={draft.roundTo}
              onChange={(v) => set({ roundTo: v })}
              options={ROUND_TO_VALUES}
              format={(v) => `$${v}`}
              size="lg"
              ariaLabel={t('roundUpRules.roundUpTo')}
            />
            <span style={HINT}>{t('roundUpRules.editor.boundaryHint')}</span>
          </div>
          <HoloDivider />
          <div style={{ ...STACK, gap: 6 }}>
            <FieldLabel>{t('roundUpRules.multiplierLabel')}</FieldLabel>
            <HoloSegmented
              value={draft.multiplier}
              onChange={(v) => set({ multiplier: v })}
              options={multiplierOptions(t)}
              ariaLabel={t('roundUpRules.multiplierLabel')}
            />
            <span style={HINT}>{t('roundUpRules.editor.multiplierHint')}</span>
          </div>
        </HoloCard>

        <HoloCard
          title={t('roundUpRules.onChain.weeklyCap')}
          accent={capOnChain > 0n ? t('roundUpRules.cap.accentOnChain', { cap: formatUsd(capOnChain) }) : t('roundUpRules.cap.accentNone')}
          accentTone={capOnChain > 0n ? 'warn' : 'muted'}
        >
          <div style={{ ...STACK, gap: 6 }}>
            <FieldLabel htmlFor="rur-weekly-cap">{t('roundUpRules.cap.label')}</FieldLabel>
            <HoloInput
              id="rur-weekly-cap"
              prefix="$"
              value={draft.capText}
              inputMode="decimal"
              onChange={(e) => set({ capText: e.target.value })}
              invalid={capInvalid || capTooBig}
              width={176}
              spellCheck={false}
            />
            {/* Presets get their own row and never wrap apart: $10 / $25 / $50 / $100 stay one strip. */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px' }}>
              <HoloLabel style={{ fontSize: 10 }}>{t('roundUpRules.cap.quickSet')}</HoloLabel>
              <div role="group" aria-label={t('roundUpRules.cap.presetsAria')} style={{ display: 'flex', flexWrap: 'nowrap', gap: 6 }}>
                {CAP_PRESETS.map((p) => (
                  <HoloChip key={p.toString()} size="sm" selected={draftCap === p} onClick={() => set({ capText: usdToInput(p) })}>
                    {formatUsd(p, 0)}
                  </HoloChip>
                ))}
              </div>
            </div>
            <span style={capInvalid || capTooBig || capMissing ? NOTE : HINT}>
              {capInvalid ? t('roundUpRules.cap.invalid')
                : capTooBig ? t('roundUpRules.cap.tooBig')
                : capMissing ? t('roundUpRules.cap.missing')
                : draftCap === 0n ? t('roundUpRules.cap.zero')
                : t('roundUpRules.cap.enforced')}
            </span>
          </div>
          <HoloDivider />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px' }}>
            <HoloStat size="md" label={t('roundUpRules.cap.pulled')} value={formatUsd(pulled)} tone="info" />
            <HoloStat size="md" label={t('roundUpRules.cap.remaining')} value={formatUsd(remaining)} tone={remaining > 0n ? 'good' : 'warn'} />
          </div>
          <HoloProgress
            value={pctOf(pulled, capOnChain)}
            tone={remaining > 0n ? 'holo' : 'warn'}
            segments={24}
            height={14}
            label={t('roundUpRules.cap.used')}
            showValue
          />
        </HoloCard>
      </div>

      <HoloCard
        title={t('roundUpRules.switch.title')}
        accent={draft.enabled ? t('roundUpRules.switch.on') : t('shell:common.paused')}
        accentTone={draft.enabled ? 'good' : 'bad'}
        compact
      >
        <HoloToggle
          checked={draft.enabled}
          onChange={() => set({ enabled: !draft.enabled })}
          label={t('roundUpRules.switch.label')}
          detail={t('roundUpRules.switch.detail')}
        />
      </HoloCard>

      {/* ─── Save bar ─── */}
      <HoloPanel variant="glass" padding="10px 12px" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <HoloBadge
          label={
            readOnly
              ? t('roundUpRules.saveBar.readOnly')
              : onchain && !ruleIsSet(onchain)
                ? t('roundUpRules.saveBar.noRule')
                : dirty
                  ? t('roundUpRules.saveBar.unsaved')
                  : t('roundUpRules.saveBar.matches')
          }
          tone={readOnly ? 'muted' : dirty ? 'warn' : 'good'}
          size="md"
        />
        {readOnly ? (
          <span style={{ ...HINT, flex: 1, minWidth: 200 }}>
            {t('roundUpRules.saveBar.readOnlyHint', { addr: shortAddr(me) })}
          </span>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        <HoloButton disabled={!dirty || tx.busy} onClick={() => setDraft(draftFrom(onchain))}>{t('roundUpRules.saveBar.revert')}</HoloButton>
        {!readOnly && onchain && ruleIsActive(onchain) && !dirty && (
          <HoloButton disabled={tx.busy} onClick={pauseNow}>{t('roundUpRules.saveBar.pauseNow')}</HoloButton>
        )}
        {!readOnly && (
          <HoloButton variant="primary" size="lg" disabled={!canSave} onClick={save}>
            {t('roundUpRules.saveBar.save')}
          </HoloButton>
        )}
      </HoloPanel>
      <TxStatus state={tx.state} onDismiss={tx.reset} />

      {/* ─── Worked example: the draft rule on the user's own number ─── */}
      <HoloCard title={t('roundUpRules.worked.title')} accent={t('roundUpRules.worked.accent')} accentTone="info">
        <span style={HINT}>{t('roundUpRules.worked.hint')}</span>
        <div style={ROW}>
          <FieldLabel htmlFor="rur-sample">{t('roundUpRules.worked.ifIPay')}</FieldLabel>
          <HoloInput
            id="rur-sample"
            prefix="$"
            value={sample}
            inputMode="decimal"
            onChange={(e) => setSample(e.target.value)}
            invalid={sample.trim() !== '' && amount == null}
            width={140}
            spellCheck={false}
          />
          <span style={HINT}>{t('roundUpRules.worked.anyAmount')}</span>
        </div>
        {amount == null ? (
          <MutedWell>{t('roundUpRules.worked.enterAmount')}</MutedWell>
        ) : (
          <>
            <div style={TILE_GRID}>
              <Tile label={t('roundUpRules.payment')} value={exact(amount)} />
              <Tile label={t('roundUpRules.worked.nextBoundary', { roundTo: draft.roundTo })} value={formatUsd(amount + boundaryDelta)} />
              <Tile label={t('roundUpRules.worked.delta')} value={exact(boundaryDelta)} tone={boundaryDelta > 0n ? 'ink' : 'muted'} />
              <Tile label={t('roundUpRules.worked.captured', { m: draft.multiplier })} value={exact(captured)} hot />
            </div>
            <TurboStairs
              steps={MULTIPLIER_VALUES.map((m) => ({ m, value: exact(roundUpDelta(amount, draft.roundTo, m)) }))}
              active={draft.multiplier}
              caption={t('roundUpRules.worked.caption', { roundTo: draft.roundTo })}
            />
            {threshold != null && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '8px 18px' }}>
                <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                  <HoloProgress
                    value={pctOf(captured, threshold)}
                    segments={24}
                    height={14}
                    label={t('roundUpRules.worked.vsThreshold')}
                    showValue={`${formatUsd(captured)} / ${formatUsd(threshold)}`}
                  />
                </div>
                <HoloStat
                  size="sm"
                  label={t('roundUpRules.worked.toReach')}
                  value={paymentsToSweep == null ? t('roundUpRules.worked.noSweep') : t('roundUpRules.worked.payments', { count: paymentsToSweep.toString() })}
                  tone={paymentsToSweep == null ? 'muted' : 'ink'}
                />
              </div>
            )}
            {onBoundary && (
              <Hint warn>
                {t('roundUpRules.worked.onBoundary', { amount: formatUsd(amount), roundTo: draft.roundTo })}
              </Hint>
            )}
            {(!draft.enabled || draftCap === 0n) && <Hint warn>{t('roundUpRules.worked.paused')}</Hint>}
            {draftCap != null && draftCap > 0n && captured > draftCap && (
              <Hint warn>{t('roundUpRules.worked.overCap', { cap: formatUsd(draftCap) })}</Hint>
            )}
            <span style={HINT}>
              {t('roundUpRules.worked.formula')}
            </span>
          </>
        )}
      </HoloCard>
    </>
  );
}

export default RoundUpRulesApp;
