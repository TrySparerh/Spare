/**
 * SpareActivityApp — this account's on-chain history, newest first.
 *
 * Rows are decoded event logs (see lib/spare-chain/activity.ts): accruals,
 * sweeps, deliveries, deferrals, safe-settlements, claims and exits from
 * SweepExecutor + CashPark, plus rule / link / mix changes from the two
 * registries. Logs are fetched with eth_getLogs in ≤ 50,000-block chunks from
 * the deployment's startBlock; the first scan covers the last ~7 days
 * (~10 blocks/s) and "Load older" pages back a week at a time. Every row links
 * to its transaction on Blockscout.
 *
 * Two things the raw events hide are made explicit:
 *   * An Accrued window moves the wallet's cursor even when it pulled less
 *     than the payments in it were owed (or $0). Each window is re-priced from
 *     the wallet's own outgoing USDG transfers (activity.auditAccruals), so a
 *     short or $0 pull reads as NOT COLLECTED / PARTIAL instead of vanishing.
 *   * AccountSwept.usdg is what LEFT the park; legs that Deferred in the same
 *     tx put it straight back. "Swept" totals are net of those deferrals, and a
 *     sweep whose every leg deferred reads as ATTEMPTED.
 *
 * Presentation is Spare Holo ("Read your own book"): a poster header, an
 * illustrated example for visitors without a wallet (clearly labelled, never
 * live numbers), and pastel dialog cards + holographic numerals once connected.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, usePublicClient, useReadContracts } from 'wagmi';
import { type Address, type Hash, type Hex } from 'viem';
import {
  WEEK_BLOCKS,
  auditAccruals,
  blockTimes,
  dedupeBookkeeping,
  exclusionSet,
  fillsForTx,
  olderWindow,
  scanAccountActivity,
  sortNewestFirst,
  type AccrualAudit,
  type ActivityEvent,
  type AssetFill,
  type AuditRule,
} from '@/lib/spare-chain/activity';
import { ruleRegistryAbi } from '@/lib/spare-chain/abis';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, START_BLOCK, STOCK_DECIMALS, sameAddress, shortAddr, symbolOf, txUrl } from '@/lib/spare-chain/addresses';
import { decodeRevertData, humanizeError } from '@/lib/spare-chain/errors';
import { oracleView, useSpareDeployment } from '@/lib/spare-chain/hooks';
import { formatBps, formatToken, formatUsd } from '@/lib/spare';
import { WalletPicker } from '@/components/retro/WalletPicker';
import { Trans, currentLang, getT, tKey, useLang, useTranslation } from '@/i18n';
import { useAssetNames } from '@/lib/spare-chain/universe';
import {
  FONT_PIXEL,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  INK_ON_LIGHT,
  TEXTURE,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloLabel,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloPanel,
  HoloProgress,
  HoloScreen,
  HoloSegmented,
  HoloSparkles,
  HoloStat,
  HoloTable,
  HoloText,
  HoloTitle,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';
import { AppCanvas, DeployingNotice, Hint, WithSpareAccount } from './spare/SpareUi';
import { HINT, ROW, type Tone } from './spare/styles';

const tf = getT('apps-b');

type Filter = 'all' | 'roundups' | 'sweeps' | 'money' | 'settings';

/** [id, label (apps-b key), event names]. */
const FILTERS: Array<[Filter, string, readonly string[] | null]> = [
  ['all', tKey('activity.filter.all'), null],
  ['roundups', tKey('activity.filter.roundups'), ['Accrued', 'AccrualSkipped', 'Credited']],
  ['sweeps', tKey('activity.filter.sweeps'), ['AccountSwept', 'Delivered', 'DeliveryHeld', 'Deferred', 'SafeSettled', 'WithdrawnForSweep', 'Returned']],
  ['money', tKey('activity.filter.money'), ['Claimed', 'Exited', 'ExitUnitsKept']],
  ['settings', tKey('activity.filter.settings'), ['RuleSet', 'Linked', 'Unlinked', 'MixSet', 'MixCleared']],
];

/** USDG with cents, or all 6 decimals when there is a sub-cent tail. */
const usd = (v: bigint) => formatUsd(v, v % 10_000n === 0n ? 2 : 6);
const tokenAmt = (token: string, v: bigint) =>
  sameAddress(token, EXTERNAL.USDG) ? usd(v) : `${formatToken(v, STOCK_DECIMALS, 6)} ${symbolOf(token)}`;

function ago(tsSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - tsSec);
  if (s < 60) return tf('activity.ago.s', { n: s });
  if (s < 3600) return tf('activity.ago.m', { n: Math.floor(s / 60) });
  if (s < 172_800) return tf('activity.ago.h', { n: Math.floor(s / 3600) });
  return tf('activity.ago.d', { n: Math.floor(s / 86_400) });
}

/** A full local date-time: the browser's own format in English (unchanged), the chosen language otherwise. */
function localDateTime(ms: number): string {
  const lang = currentLang();
  return lang === 'en' ? new Date(ms).toLocaleString() : new Date(ms).toLocaleString(lang);
}

/** Event tones → Holo tones. */
const HOLO_TONE: Record<Tone, HoloTone> = { up: 'good', down: 'bad', warn: 'warn', info: 'info', mono: 'ink', muted: 'muted' };

interface Described {
  label: string;
  tone: Tone;
  detail: string;
  amount: string;
}

interface DescribeCtx {
  fills?: AssetFill[];
  /** Σ Deferred.usdg for this account in the event's tx. */
  deferredInTx?: bigint;
  /** Re-priced Accrued window, once checked. */
  audit?: AccrualAudit;
  /** The window check is still running. */
  auditPending?: boolean;
}

/* Shared detail fragments: the live describe() and the illustrated sample rows use the same wording. */
const fillsText = (fills: { sym: string; filled: boolean }[]) =>
  fills.map((x) => (x.filled ? tf('activity.d.filled', { sym: x.sym }) : tf('activity.d.legDeferred', { sym: x.sym }))).join(' · ');
const epochText = (epoch: string) => tf('activity.d.epoch', { epoch });
const deferredText = (sym: string, reason: string) => tf('activity.d.deferred', { sym, reason });
const ruleSetText = (roundTo: string, mult: string, cap: string, on: boolean) =>
  tf('activity.d.ruleSet', { roundTo, mult, cap, state: on ? tf('activity.d.ruleOn') : tf('activity.d.rulePaused') });

/** Translated at call time: rows are re-described when the language changes (see ActivityBody). */
function describe(e: ActivityEvent, ctx: DescribeCtx = {}): Described {
  const a = e.args as Record<string, never>;
  switch (e.name) {
    case 'Accrued': {
      const amount = a.amount as unknown as bigint;
      const where = tf('activity.d.where', { wallet: shortAddr(a.wallet), from: String(a.fromBlock), to: String(a.toBlock) });
      const audit = ctx.audit;
      if (amount === 0n) {
        if (audit && audit.due > 0n) {
          return {
            label: tf('activity.ev.notCollected'), tone: 'down',
            detail: tf('activity.d.notCollected', { where, payments: audit.payments, due: usd(audit.due) }),
            amount: tf('activity.d.notCollectedAmount', { due: usd(audit.due) }),
          };
        }
        if (audit) return { label: tf('activity.ev.scanned'), tone: 'muted', detail: tf('activity.d.scanned', { where }), amount: '—' };
        return {
          label: tf('activity.ev.nothingPulled'), tone: 'warn',
          detail: ctx.auditPending ? tf('activity.d.nothingPulledChecking', { where }) : tf('activity.d.nothingPulledUnknown', { where }),
          amount: usd(0n),
        };
      }
      if (audit && audit.due > amount) {
        return {
          label: tf('activity.ev.partial'), tone: 'warn',
          detail: tf('activity.d.partial', { where, short: usd(audit.due - amount), due: usd(audit.due) }),
          amount: usd(amount),
        };
      }
      return { label: tf('activity.ev.roundUp'), tone: 'info', detail: tf('activity.d.pulledFrom', { where }), amount: usd(amount) };
    }
    case 'AccrualSkipped':
      return {
        label: tf('activity.ev.skipped'), tone: 'warn',
        detail: tf('activity.d.skipped', { wallet: shortAddr(a.wallet), reason: decodeRevertData(a.reason as Hex) ?? tf('activity.d.pullReverted') }),
        amount: '—',
      };
    case 'Credited':
      return { label: tf('activity.ev.credited'), tone: 'info', detail: tf('activity.d.credited'), amount: usd(a.amount) };
    case 'AccountSwept': {
      const f = fillsText((ctx.fills ?? []).map((x) => ({ sym: symbolOf(x.asset), filled: x.kind === 'swept' })));
      const batch = f ? ` · ${tf('activity.d.batch', { fills: f })}` : '';
      const withdrawn = a.usdg as unknown as bigint;
      const def = ctx.deferredInTx ?? 0n;
      if (withdrawn > 0n && def >= withdrawn) {
        return {
          label: tf('activity.ev.attempted'), tone: 'warn',
          detail: `${tf('activity.d.attempted', { epoch: String(a.epoch), amount: usd(def) })}${batch}`,
          amount: usd(withdrawn),
        };
      }
      const split = def > 0n ? ` · ${tf('activity.d.split', { settled: usd(withdrawn - def), deferred: usd(def) })}` : '';
      return { label: tf('activity.ev.swept'), tone: 'up', detail: `${epochText(String(a.epoch))}${split}${batch}`, amount: usd(withdrawn) };
    }
    case 'Delivered':
      return { label: tf('activity.ev.delivered'), tone: 'up', detail: tf('activity.d.delivered', { sym: symbolOf(a.token) }), amount: tokenAmt(a.token, a.amount) };
    case 'DeliveryHeld':
      return { label: tf('activity.ev.claimable'), tone: 'warn', detail: tf('activity.d.claimable', { sym: symbolOf(a.token) }), amount: tokenAmt(a.token, a.amount) };
    case 'Deferred':
      return {
        label: tf('activity.ev.deferred'), tone: 'warn',
        detail: deferredText(symbolOf(a.asset), Number(a.status) === 0 ? tf('activity.d.swapNoFill') : oracleView(Number(a.status)).detail),
        amount: usd(a.usdg),
      };
    case 'SafeSettled':
      return {
        label: tf('activity.ev.safeSettled'), tone: 'down',
        detail: tf('activity.d.safeSettled', { sym: symbolOf(a.asset), reason: a.reason ? String(a.reason) : tf('activity.d.suspended') }),
        amount: usd(a.usdg),
      };
    case 'Claimed':
      return { label: tf('activity.ev.claimed'), tone: 'up', detail: tf('activity.d.claimed', { sym: symbolOf(a.token) }), amount: tokenAmt(a.token, a.amount) };
    case 'Returned':
      return { label: tf('activity.ev.returned'), tone: 'info', detail: tf('activity.d.returned'), amount: usd(a.amount) };
    case 'WithdrawnForSweep':
      return { label: tf('activity.ev.toSweep'), tone: 'info', detail: tf('activity.d.toSweep'), amount: usd(a.usdgOut) };
    case 'Exited':
      return {
        label: tf('activity.ev.exit'), tone: 'info',
        detail: (a.unitsInKind as unknown as bigint) > 0n ? tf('activity.d.exitedInKind', { units: String(a.unitsInKind) }) : tf('activity.d.exited'),
        amount: usd(a.usdgOut),
      };
    case 'ExitUnitsKept':
      return { label: tf('activity.ev.exitPartial'), tone: 'warn', detail: tf('activity.d.exitPartial', { units: String(a.units) }), amount: '—' };
    case 'RuleSet':
      return {
        label: tf('activity.ev.ruleSet'), tone: 'muted',
        detail: ruleSetText(String(a.roundTo), String(a.multiplier), formatUsd(BigInt(a.weeklyCap)), !!a.enabled),
        amount: '—',
      };
    case 'Linked':
      return { label: tf('activity.ev.linked'), tone: 'muted', detail: tf('activity.d.linked', { wallet: shortAddr(a.wallet) }), amount: '—' };
    case 'Unlinked':
      return { label: tf('activity.ev.unlinked'), tone: 'muted', detail: tf('activity.d.unlinked', { wallet: shortAddr(a.wallet) }), amount: '—' };
    case 'MixSet': {
      const legs = (e.args.legs as readonly { asset: Address; bps: number }[] | undefined) ?? [];
      return { label: tf('activity.ev.mixSet'), tone: 'muted', detail: legs.map((l) => `${symbolOf(l.asset)} ${formatBps(Number(l.bps))}%`).join(' · '), amount: '—' };
    }
    case 'MixCleared':
      return { label: tf('activity.ev.mixCleared'), tone: 'muted', detail: tf('activity.d.mixCleared'), amount: '—' };
    default:
      return { label: e.name.toUpperCase(), tone: 'muted', detail: '', amount: '—' };
  }
}

type Row = { id: string; e: ActivityEvent; d: Described; ts?: number } & Record<string, unknown>;

/* ─────────────────────────── local presentation atoms ─────────────────────────── */

/** A small sky tile: brand sky + dither, 2px indigo frame, white keyline. */
const SKY_SURFACE: CSSProperties = {
  background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky}`,
  border: `2px solid ${HOLO.ink}`,
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.9), 3px 3px 0 0 rgba(42,27,110,.2)',
  ...INK_ON_LIGHT,
};

/**
 * Big holographic numeral on a sky tile. The numeral shrinks with the tile
 * (container units), so long 6-decimal amounts never spill at 375px.
 */
function PosterStat({ label, value, sub, fill = 'holo', seed = 3 }: {
  label: string;
  value: string;
  sub?: ReactNode;
  fill?: 'holo' | 'good' | 'warn' | 'bad' | 'ink';
  seed?: number;
}) {
  const chars = Math.max(5, value.length) * 1.04;
  return (
    <div style={{ position: 'relative', overflow: 'hidden', isolation: 'isolate', minWidth: 0, padding: '10px 12px 12px', containerType: 'inline-size', ...SKY_SURFACE }}>
      <HoloSparkles count={3} seed={seed} sizes={[6, 11]} />
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <HoloLabel tone="ink">{label}</HoloLabel>
        <HoloTitle
          as="div"
          size="md"
          fill={fill}
          title={value}
          style={{ textTransform: 'none', whiteSpace: 'nowrap', overflowWrap: 'normal', fontSize: `min(26px, calc((100cqi - 10px) / ${chars.toFixed(2)}))` }}
        >
          {value}
        </HoloTitle>
        {sub && <span style={{ ...HINT, color: INK.soft }}>{sub}</span>}
      </div>
    </div>
  );
}

/**
 * Width (px) of a table column holding one soft HoloBadge per row, sized to the
 * longest label so no badge is ever clipped by the cell (the cell is
 * overflow:hidden, so an over-wide badge loses its right edge and reads as running
 * into the next column). Badge label: Silkscreen Bold 10px + .08em tracking,
 * ≈9.2px per glyph measured — budget 9.6. Chrome: 2×8px chip padding, 7px dot +
 * 5px gap, 2×8px cell padding, plus a few px of slack for font hinting.
 */
function badgeColumnWidth(labels: readonly string[]): number {
  const longest = labels.reduce((n, l) => Math.max(n, glyphWidth(l)), 'EVENT'.length);
  return Math.ceil(longest * 9.6) + 16 + 12 + 16 + 6;
}

/** Label length in Latin-glyph units: a CJK glyph (10px + tracking) is ≈1.2 Silkscreen glyphs. */
function glyphWidth(label: string): number {
  let n = 0;
  for (const ch of label) n += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1.2 : 1;
  return n;
}

/** Event badge for a table cell: never wider than the cell (ellipsis inside the chip as a last resort). */
function EventBadge({ label, tone }: { label: string; tone: Tone }) {
  return <HoloBadge label={label} tone={HOLO_TONE[tone]} title={label} style={{ maxWidth: '100%', verticalAlign: 'middle' }} />;
}

/** Small readout in a sunken paper well (dense values). */
function WellStat({ label, value, tone }: { label: string; value: string; tone: HoloTone }) {
  return (
    <HoloPanel variant="sunken" texture="none" padding="8px 10px">
      <HoloStat label={label} value={value} tone={tone} size="md" style={{ width: '100%' }} />
    </HoloPanel>
  );
}

/* ─────────────────────────────────── the app ─────────────────────────────────── */

export function SpareActivityApp() {
  const { t } = useTranslation('apps-b');
  // Same gate as SpareGate(needsWallet): contracts first, then a wallet.
  const { deployed, checking, error } = useSpareDeployment();
  const { isConnected } = useAccount();
  const live = deployed && isConnected;
  return (
    <AppCanvas>
      <HoloHero
        art="/icons/spare/spare-activity.png"
        kicker={t('activity.hero.kicker')}
        title={t('shell:appNames.spare-activity')}
        subtitle={t('activity.hero.subtitle')}
        description={live ? undefined : t('activity.hero.description')}
        aside={
          <>
            {/* i18n-ignore: the chain's name is never translated */}
            <HoloBadge label="ROBINHOOD CHAIN" tone="good" variant="solid" dot />
            <HoloBadge label={t('activity.hero.noIndexer')} tone="info" />
          </>
        }
        compact={live}
        seed={23}
      />
      {!deployed ? (
        <>
          <DeployingNotice checking={checking} error={error} />
          <ActivityPreview />
        </>
      ) : !isConnected ? (
        <>
          <ConnectCta />
          <ActivityPreview />
        </>
      ) : (
        <WithSpareAccount what={t('activity.what')}>
          {(v) => (v.account ? <ActivityBody account={v.account} /> : null)}
        </WithSpareAccount>
      )}
    </AppCanvas>
  );
}

/* ─────────────────────────── disconnected: CTA + example ─────────────────────────── */

function ConnectCta() {
  const { t } = useTranslation('apps-b');
  const [open, setOpen] = useState(false);
  return (
    <HoloCard title={t('shell:common.wallet')} accent={t('shell:common.notConnected')} accentTone="warn">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <HoloTitle as="h2" size="sm">{t('activity.connectTitle')}</HoloTitle>
          <HoloText size="md">{t('activity.why')}</HoloText>
        </div>
        <HoloButton variant="primary" size="lg" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? t('shell:common.hideWallets') : t('shell:common.connectWallet')}
        </HoloButton>
      </div>
      <span style={HINT}>{t('shell:common.walletPillHint')}</span>
      {open && <WalletPicker variant="holo" onClose={() => setOpen(false)} />}
    </HoloCard>
  );
}

type SampleRow = { id: string; when: string; label: string; tone: Tone; detail: string; amount: string } & Record<string, unknown>;

/** Made-up rows that mirror the real table's wording (built from the same keys). Never shown as live data. */
function sampleRows(): SampleRow[] {
  // Placeholder names, not tickers: the example must not look like a recommendation or live data.
  const stockA = tf('shared.stockA');
  const stockB = tf('shared.stockB');
  return [
    { id: 's1', when: tf('activity.ago.h', { n: 2 }), label: tf('activity.ev.roundUp'), tone: 'info', detail: tf('activity.sample.pulledYours'), amount: '$1.35' },
    {
      id: 's2', when: tf('activity.ago.d', { n: 1 }), label: tf('activity.ev.swept'), tone: 'up',
      detail: `${epochText('12')} · ${tf('activity.d.batch', { fills: fillsText([{ sym: stockA, filled: true }, { sym: stockB, filled: true }]) })}`,
      amount: '$5.00',
    },
    { id: 's3', when: tf('activity.ago.d', { n: 3 }), label: tf('activity.ev.deferred'), tone: 'warn', detail: deferredText(stockB, tf('activity.d.swapNoFill')), amount: '$2.00' },
    { id: 's4', when: tf('activity.ago.d', { n: 6 }), label: tf('activity.ev.ruleSet'), tone: 'muted', detail: ruleSetText('1', '1', '$25.00', true), amount: '—' },
  ];
}

function sampleCols(rows: SampleRow[]): HoloColumn<SampleRow>[] {
  return [
    { key: 'when', label: tf('activity.cols.when'), width: 78 },
    { key: 'label', label: tf('activity.cols.event'), width: badgeColumnWidth(rows.map((r) => r.label)), render: (r) => <EventBadge label={r.label} tone={r.tone} /> },
    { key: 'detail', label: tf('activity.cols.detail'), render: (r) => <span title={r.detail}>{r.detail}</span> },
    { key: 'amount', label: tf('activity.cols.amount'), width: 86, align: 'right', render: (r) => <strong>{r.amount}</strong> },
  ];
}

/** label / text are apps-b keys. */
const KINDS: Array<{ label: string; tone: HoloTone; text: string }> = [
  { label: tKey('activity.filter.roundups'), tone: 'info', text: tKey('activity.kinds.roundups') },
  { label: tKey('activity.filter.sweeps'), tone: 'good', text: tKey('activity.kinds.sweeps') },
  { label: tKey('activity.filter.money'), tone: 'warn', text: tKey('activity.kinds.money') },
  { label: tKey('activity.filter.settings'), tone: 'muted', text: tKey('activity.kinds.settings') },
];

function ActivityPreview() {
  const { t } = useTranslation('apps-b');
  const rows = sampleRows();
  return (
    <HoloCard title={t('activity.preview.title')} accent={t('shell:common.example')} accentTone="warn" bar="lilac">
      <HoloText size="sm" tone="muted">{t('activity.preview.note')}</HoloText>
      <RoundUpMath />
      <HoloTable columns={sampleCols(rows)} rows={rows} rowKey={(r) => r.id} dense minWidth={520} ariaLabel={t('activity.preview.aria')} />
      <HoloLabel>{t('activity.preview.logged')}</HoloLabel>
      {/* Four kinds → 2×2, never 3+1: each track is at least (just under) half the row, so
          at most two fit, and at least 260px, so it drops to one column below ~528px (375px
          windows). The -1px keeps two tracks + gap from rounding past the row width. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, max(260px, calc((100% - 8px) / 2 - 1px))), 1fr))', gap: 8 }}>
        {KINDS.map((k) => (
          <div
            key={k.label}
            style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', background: 'rgba(255,255,255,.62)', boxShadow: `inset 0 0 0 1px ${HOLO.bevelLo}` }}
          >
            <HoloBadge label={t(k.label)} tone={k.tone} variant="solid" dot style={{ alignSelf: 'flex-start' }} />
            <span style={{ ...HINT, color: INK.body }}>{t(k.text)}</span>
          </div>
        ))}
      </div>
    </HoloCard>
  );
}

/** "$3.75 → $4.00 = $0.25 spare" — the round-up idea in one strip. */
function RoundUpMath() {
  const { t } = useTranslation('apps-b');
  const op: CSSProperties = { fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 20, color: INK.body, lineHeight: 1 };
  return (
    <div
      role="img"
      aria-label={t('activity.math.aria')}
      style={{ position: 'relative', overflow: 'hidden', isolation: 'isolate', padding: '10px 12px', ...SKY_SURFACE }}
    >
      <HoloSparkles count={5} seed={9} sizes={[6, 12]} />
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 10px' }}>
        <MathTerm label={t('activity.math.youPay')} value="$3.75" />
        <span aria-hidden style={op}>→</span>
        <MathTerm label={t('activity.math.roundTo')} value="$4.00" />
        <span aria-hidden style={op}>=</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <HoloLabel tone="ink">{t('activity.math.spare')}</HoloLabel>
          <HoloTitle as="div" size="md" style={{ textTransform: 'none', whiteSpace: 'nowrap' }}>$0.25</HoloTitle>
        </div>
        <div style={{ flex: 1 }} />
        <HoloBadge label={t('activity.math.badge')} variant="solid" />
      </div>
    </div>
  );
}

function MathTerm({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '5px 9px 6px', background: 'rgba(255,255,255,.82)', boxShadow: `0 0 0 1px ${HOLO.ink}, 2px 2px 0 0 rgba(42,27,110,.2)`, ...INK_ON_LIGHT }}>
      <span style={{ fontFamily: FONT_PIXEL, fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: INK.soft, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 17, lineHeight: 1, color: INK.body }}>{value}</span>
    </div>
  );
}

/* ──────────────────────────────── connected ──────────────────────────────── */

function ActivityBody({ account }: { account: Address }) {
  const { t } = useTranslation('apps-b');
  // Rows are described (translated) inside memos: re-describe them when the
  // language changes, and when the registry read names the tokens in them.
  const lang = useLang();
  const names = useAssetNames();
  const me = account;
  const client = usePublicClient({ chainId: SPARE_CHAIN_ID });
  // Current rule + wallets: the fallback rule and the "own wallets" exclusion
  // when re-pricing Accrued windows.
  const acctReads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'ruleOf', args: [me], chainId: SPARE_CHAIN_ID },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'walletsOf', args: [me], chainId: SPARE_CHAIN_ID },
    ],
    query: { refetchInterval: 60_000 },
  });
  const currentRule: AuditRule | null = acctReads.data
    ? { roundTo: Number(acctReads.data[0].roundTo), multiplier: Number(acctReads.data[0].multiplier) }
    : null;
  const currentWallets = (acctReads.data?.[1] ?? []) as readonly Address[];
  const acctKey = acctReads.data ? `${currentRule?.roundTo}:${currentRule?.multiplier}:${currentWallets.join(',')}` : null;

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [times, setTimes] = useState<Map<bigint, number>>(new Map());
  const [fills, setFills] = useState<Map<string, AssetFill[]>>(new Map());
  const [scannedFrom, setScannedFrom] = useState<bigint | null>(null);
  const [scannedTo, setScannedTo] = useState<bigint | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const busy = progress !== null;

  /** Scan [from, to], merge into what we have, then fill in times + sweep fills. */
  const scan = useCallback(
    async (from: bigint, to: bigint, mode: 'replace' | 'merge') => {
      if (!client) return;
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      setError(null);
      setProgress({ done: 0, total: 1 });
      try {
        const found = await scanAccountActivity(client, me, from, to, {
          signal: ctl.signal,
          onProgress: (done, total) => { if (!ctl.signal.aborted) setProgress({ done, total }); },
        });
        if (ctl.signal.aborted) return;
        setEvents((prev) => {
          const map = new Map((mode === 'replace' ? [] : prev).map((e) => [e.id, e]));
          for (const e of found) map.set(e.id, e);
          return sortNewestFirst([...map.values()]);
        });
        setScannedFrom((f) => (mode === 'replace' || f == null || from < f ? from : f));
        setScannedTo((prevTo) => (mode === 'replace' || prevTo == null || to > prevTo ? to : prevTo));
        setProgress(null);

        // Timestamps for every shown block, and per-asset fills for sweeps.
        const shown = dedupeBookkeeping(found);
        const bt = await blockTimes(client, shown.map((e) => e.blockNumber));
        if (ctl.signal.aborted) return;
        setTimes((prev) => new Map([...prev, ...bt]));
        const sweeps = [...new Set(shown.filter((e) => e.name === 'AccountSwept').map((e) => e.txHash))].slice(0, 25);
        const got = await Promise.all(sweeps.map(async (h) => [h, await fillsForTx(client, h as Hash).catch(() => [])] as const));
        if (ctl.signal.aborted) return;
        setFills((prev) => new Map([...prev, ...got]));
      } catch (e) {
        if (ctl.signal.aborted) return;
        setProgress(null);
        setError(humanizeError(e));
      }
    },
    [client, me],
  );

  const loadLatest = useCallback(async () => {
    if (!client) return;
    try {
      const head = await client.getBlockNumber();
      const from = head - WEEK_BLOCKS + 1n < START_BLOCK ? START_BLOCK : head - WEEK_BLOCKS + 1n;
      await scan(from, head, 'replace');
    } catch (e) {
      setError(humanizeError(e));
    }
  }, [client, scan]);

  const refresh = async () => {
    if (!client || scannedTo == null) return loadLatest();
    try {
      const head = await client.getBlockNumber();
      if (head > scannedTo) await scan(scannedTo + 1n, head, 'merge');
    } catch (e) {
      setError(humanizeError(e));
    }
  };

  const older = scannedFrom != null ? olderWindow(scannedFrom) : null;
  const loadOlder = () => { if (older) void scan(older.from, older.to, 'merge'); };

  // New account (or first mount): start over.
  useEffect(() => {
    setEvents([]);
    setTimes(new Map());
    setFills(new Map());
    setScannedFrom(null);
    setScannedTo(null);
    setSelected(null);
    void loadLatest();
    return () => abort.current?.abort();
  }, [loadLatest]);

  const visible = useMemo(() => dedupeBookkeeping(events), [events]);

  /* ── re-price Accrued windows: did the pull match what the payments owed? ── */
  const [audits, setAudits] = useState<Map<string, AccrualAudit>>(new Map());
  const [auditing, setAuditing] = useState(false);
  useEffect(() => {
    if (!client || !acctReads.data || busy) return;
    const pending = visible.filter((e) => e.name === 'Accrued' && !audits.has(e.id));
    if (pending.length === 0) {
      setAuditing(false);
      return;
    }
    // The rule the keeper priced with: the latest RuleSet before the accrual;
    // with none loaded, the current rule — unless a later RuleSet shows it changed.
    const ruleSets = visible.filter((e) => e.name === 'RuleSet'); // newest first
    const ruleAt = (block: bigint): AuditRule | null => {
      const before = ruleSets.find((e) => e.blockNumber < block);
      if (before) return { roundTo: Number(before.args.roundTo), multiplier: Number(before.args.multiplier) };
      if (ruleSets.length > 0) return null;
      return currentRule;
    };
    const linkedEver = [
      ...currentWallets,
      ...visible.filter((e) => e.name === 'Linked' || e.name === 'Unlinked').map((e) => String(e.args.wallet)),
    ];
    const ctl = new AbortController();
    setAuditing(true);
    auditAccruals(client, pending, exclusionSet(me, linkedEver), ruleAt, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setAudits((prev) => new Map([...prev, ...res]));
      })
      .catch(() => { /* rows stay "could not check" */ })
      .finally(() => { if (!ctl.signal.aborted) setAuditing(false); });
    return () => ctl.abort();
    // `audits` is deliberately not a dependency: a finished audit must not re-trigger itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, visible, acctKey, busy, me]);

  const deferredByTx = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const e of visible) if (e.name === 'Deferred') m.set(e.txHash, (m.get(e.txHash) ?? 0n) + (e.args.usdg as bigint));
    return m;
  }, [visible]);

  /** A $0 accrual whose window held no payments: a pure cursor advance, hidden. */
  const isIdleAdvance = useCallback(
    (e: ActivityEvent) => e.name === 'Accrued' && (e.args.amount as bigint) === 0n && audits.get(e.id)?.due === 0n,
    [audits],
  );
  const idleAdvances = visible.filter(isIdleAdvance).length;
  const auditPending = auditing || (!acctReads.data && !acctReads.error);

  /** Every shown event, described — before the filter, so the Event column is sized once per load. */
  const described: Row[] = useMemo(
    () =>
      visible
        .filter((e) => !isIdleAdvance(e))
        .map((e) => ({
          id: e.id,
          e,
          d: describe(e, { fills: fills.get(e.txHash), deferredInTx: deferredByTx.get(e.txHash), audit: audits.get(e.id), auditPending }),
          ts: times.get(e.blockNumber),
        })),
    // `lang`: describe() translates, so a language switch must re-describe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, fills, times, audits, auditPending, deferredByTx, isIdleAdvance, lang, names],
  );

  const rows: Row[] = useMemo(() => {
    const want = FILTERS.find(([k]) => k === filter)?.[2] ?? null;
    return want ? described.filter((r) => want.includes(r.e.name)) : described;
  }, [described, filter]);

  // Fit the longest badge in the loaded window ("NOTHING PULLED" needs ~185px) —
  // stable across filters so the columns don't jump when you switch.
  const eventColWidth = useMemo(() => badgeColumnWidth(described.map((r) => r.d.label)), [described]);

  /** Events per filter (same rules as `rows`), shown on the filter keys. */
  const kindCounts = useMemo(() => {
    const shown = visible.filter((e) => !isIdleAdvance(e));
    const out = {} as Record<Filter, number>;
    for (const [k, , names] of FILTERS) out[k] = names ? shown.filter((e) => names.includes(e.name)).length : shown.length;
    return out;
  }, [visible, isIdleAdvance]);

  const totals = useMemo(() => {
    let pulled = 0n, withdrawn = 0n, deferredUsdg = 0n, deferred = 0, missed = 0n;
    for (const e of visible) {
      if (e.name === 'Accrued') {
        const amt = e.args.amount as bigint;
        pulled += amt;
        const au = audits.get(e.id);
        if (au && au.due > amt) missed += au.due - amt;
      }
      if (e.name === 'AccountSwept') withdrawn += e.args.usdg as bigint;
      if (e.name === 'Deferred') {
        deferred += 1;
        deferredUsdg += e.args.usdg as bigint;
      }
    }
    // Deferred USDG went straight back to the park in the same tx and is
    // withdrawn again by a later sweep — count it once, when it settles.
    const swept = withdrawn > deferredUsdg ? withdrawn - deferredUsdg : 0n;
    return { pulled, swept, deferred, missed };
  }, [visible, audits]);

  const selectedRow = rows.find((r) => r.id === selected);
  const selectedFills = selectedRow && selectedRow.e.name === 'AccountSwept' ? fills.get(selectedRow.e.txHash) : undefined;

  const cols: HoloColumn<Row>[] = [
    {
      key: 'ts', label: t('activity.cols.when'), width: 96,
      render: (r) =>
        r.ts ? (
          <span title={localDateTime(r.ts * 1000)}>{ago(r.ts)}</span>
        ) : (
          <span title={t('activity.body.blockTitle', { n: r.e.blockNumber.toString() })}>#{r.e.blockNumber.toString()}</span>
        ),
    },
    { key: 'label', label: t('activity.cols.event'), width: eventColWidth, render: (r) => <EventBadge label={r.d.label} tone={r.d.tone} /> },
    { key: 'detail', label: t('activity.cols.detail'), render: (r) => <span title={r.d.detail}>{r.d.detail}</span> },
    { key: 'amount', label: t('activity.cols.amount'), width: 150, align: 'right', render: (r) => <span style={{ fontWeight: 700 }}>{r.d.amount}</span> },
    {
      key: 'tx', label: t('activity.cols.tx'), width: 92,
      render: (r) => (
        <a
          href={txUrl(r.e.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => ev.stopPropagation()}
          title={r.e.txHash}
          // `inherit` keeps the link readable on zebra rows and on the indigo selected row.
          style={{ color: 'inherit', fontFamily: FONT_TEXT, fontWeight: 700, textDecorationLine: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}
        >
          {r.e.txHash.slice(0, 8)}↗
        </a>
      ),
    },
  ];

  const windowText = scannedFrom != null && scannedTo != null
    ? t('activity.body.window', { from: scannedFrom.toLocaleString(), to: scannedTo.toLocaleString() })
    : t('activity.body.scanning');

  const status = busy ? t('activity.body.statusScanning') : error ? t('activity.body.statusError') : t('shell:common.onChain');
  const statusTone: HoloTone = error ? 'bad' : busy ? 'warn' : 'good';

  return (
    <>
      <HoloCard
        title={t('activity.body.title')}
        icon="/icons/spare/spare-activity.png"
        accent={<HoloBadge label={status} tone={statusTone} variant="solid" dot pulse={busy} />}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
          <PosterStat label={t('activity.body.pulled')} value={usd(totals.pulled)} sub={t('activity.body.pulledSub')} seed={5} />
          <PosterStat label={t('activity.body.swept')} value={usd(totals.swept)} fill="good" sub={t('activity.body.sweptSub')} seed={8} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <WellStat
            label={t('activity.body.notCollected')}
            value={auditPending && totals.missed === 0n ? '…' : totals.missed > 0n ? `≈${usd(totals.missed)}` : usd(0n)}
            tone={totals.missed > 0n ? 'bad' : 'muted'}
          />
          <WellStat label={t('activity.body.deferredLegs')} value={String(totals.deferred)} tone={totals.deferred ? 'warn' : 'muted'} />
          <WellStat label={t('activity.body.events')} value={String(visible.length - idleAdvances)} tone="ink" />
        </div>
        {busy && progress && (
          <HoloProgress
            value={(progress.done / Math.max(1, progress.total)) * 100}
            segments={30}
            height={14}
            label={t('activity.body.scanLabel')}
            showValue={t('activity.body.chunks', { done: progress.done, total: progress.total })}
          />
        )}
        {error && (
          <HoloNotice tone="error" title={t('activity.body.scanFailed')} live="alert" compact>
            {error}
          </HoloNotice>
        )}
        <span style={HINT}>{t('activity.body.totalsHint', { window: windowText })}</span>
      </HoloCard>

      <HoloCard
        title={t('activity.log.title')}
        bar="lilac"
        accent={
          auditPending ? (
            <HoloBadge label={t('activity.log.checking')} tone="warn" pulse />
          ) : (
            <HoloBadge label={t('activity.log.rowsBadge', { count: rows.length })} tone="ink" dot={false} />
          )
        }
      >
        <div style={{ ...ROW, gap: 10 }}>
          <HoloLabel>{t('activity.log.filter')}</HoloLabel>
          <HoloSegmented
            size="sm"
            value={filter}
            onChange={setFilter}
            ariaLabel={t('activity.log.filterAria')}
            options={FILTERS.map(([k, l]) => ({
              value: k,
              label: (
                <>
                  {t(l)}
                  <span style={{ marginLeft: 5, fontWeight: 400, opacity: 0.8 }}>{kindCounts[k]}</span>
                </>
              ),
            }))}
          />
          <div style={{ flex: 1 }} />
          <HoloButton size="sm" onClick={() => void refresh()} disabled={busy}>{t('activity.log.refresh')}</HoloButton>
        </div>

        <HoloTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          selectedKey={selected}
          onSelectRow={(r) => setSelected(r.id === selected ? null : r.id)}
          loading={busy && events.length === 0}
          // When 96 + Event + Amount 150 + Tx 92, leaving Detail at least 200px before the well scrolls sideways.
          minWidth={Math.max(700, 96 + eventColWidth + 150 + 92 + 200)}
          ariaLabel={t('activity.log.aria')}
          style={{ minHeight: 190 }}
          emptyMessage={
            error ? t('activity.log.emptyError')
              : filter === 'all' ? t('activity.log.emptyAll')
              : t('activity.log.emptyKind')
          }
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={HINT}>
            {t('activity.log.rows', { count: rows.length })}
            {idleAdvances ? ` · ${t('activity.log.idle', { count: idleAdvances })}` : ''}
            {auditPending ? ` · ${t('activity.log.checkingWindows')}` : ''}
          </span>
          {older ? (
            <HoloButton size="sm" disabled={busy} onClick={loadOlder}>{t('activity.log.older')}</HoloButton>
          ) : scannedFrom != null ? (
            <span style={HINT}>{t('activity.log.reachedStart')}</span>
          ) : null}
        </div>
      </HoloCard>

      {selectedRow && (
        <HoloCard
          title={t('activity.selected.title')}
          accent={selectedRow.d.label}
          accentTone={HOLO_TONE[selectedRow.d.tone]}
          onClose={() => setSelected(null)}
          closeLabel={t('activity.selected.clear')}
          compact
        >
          <HoloText size="md">{selectedRow.d.detail}</HoloText>
          <HoloList>
            <HoloListRow label={t('activity.selected.block')} value={selectedRow.e.blockNumber.toLocaleString()} />
            {selectedRow.ts ? <HoloListRow label={t('activity.selected.time')} value={localDateTime(selectedRow.ts * 1000)} /> : null}
            <HoloListRow
              label={t('activity.selected.tx')}
              value={
                <a
                  href={txUrl(selectedRow.e.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: INK.link, fontSize: 12, textDecorationLine: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, overflowWrap: 'anywhere' }}
                >
                  {selectedRow.e.txHash} ↗
                </a>
              }
            />
          </HoloList>
          {selectedFills && selectedFills.length > 0 && (
            <HoloScreen>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.5, color: INK.body }}>
                <span style={{ ...HINT }}>{t('activity.selected.fillsIntro')}</span>
                {selectedFills.map((f, i) => (
                  <span key={`${f.asset}${i}`}>
                    {f.kind === 'swept' ? (
                      <Trans
                        t={t}
                        i18nKey="activity.selected.fillSwept"
                        values={{ sym: symbolOf(f.asset), in: usd(f.usdgIn), fee: usd(f.fee), out: formatToken(f.tokensOut, STOCK_DECIMALS, 6) }}
                        components={{ b: <strong style={{ color: INK.good }} /> }}
                      />
                    ) : (
                      <Trans
                        t={t}
                        i18nKey="activity.selected.fillDeferred"
                        values={{ sym: symbolOf(f.asset), in: usd(f.usdgIn) }}
                        components={{ b: <strong style={{ color: INK.warn }} /> }}
                      />
                    )}
                  </span>
                ))}
              </div>
            </HoloScreen>
          )}
        </HoloCard>
      )}

      <Hint>{t('activity.footer')}</Hint>
    </>
  );
}

export default SpareActivityApp;
