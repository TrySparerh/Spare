/**
 * StockMixApp — which tokenized stocks each sweep buys, on-chain.
 *
 *   AssetRegistry.tokens()/get()/isEligible()  the eligible universe
 *   StockRouter.oracleStatus(token)            live guarded price + status
 *   ElectionRegistry.mixOf / hasOwnMix / defaultMix
 *   ElectionRegistry.setMix(Leg[]) / clearMix()
 *
 * A mix is ≤ MAX_LEGS legs of registry-ACTIVE assets whose bps total exactly
 * 10000; the draft is validated with the contract's own rules before sending.
 * clearMix() drops the account back to the default mix. A feed only turns
 * STALE once its last answer is older than heartbeat + 1h (OracleGuard) —
 * ~25h after Friday's last update for a daily feed — so a sweep can still run
 * against Friday's close until then (bounded by the oracle band). Once STALE
 * the sweep waits; it never pays out USDG for a market being shut.
 * A connected spending wallet sees the mix of the account it feeds, read-only.
 *
 * The universe is whatever the registry holds (dozens of assets): the list
 * has search, a stocks / ETFs and active / standby filter, sorting by ticker,
 * name, price or ~1 day change, and standby assets say why (measured live
 * through their pinned pool). Every asset keeps one colour everywhere
 * (assetColor, from its ticker).
 *
 * Presentation: Spare Holo (a "Your stock mix  SPY NVDA  [Save]" dialog card).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Trans, formatDateTime, useTranslation } from '@/i18n';
import { useAccount, useReadContracts } from 'wagmi';
import { type Address } from 'viem';
import { electionRegistryAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, sameAddress, shortAddr, symbolOf } from '@/lib/spare-chain/addresses';
import { humanizeError } from '@/lib/spare-chain/errors';
import { oraclePriceOf, oracleView, txStep, useSpareDeployment, useSpareTx, useSweepParams, useUniverse, type UniverseAsset } from '@/lib/spare-chain/hooks';
import {
  assetColor,
  filterAssets,
  sortAssets,
  standbyReason,
  standbyText,
  useDayChanges,
  useStandbyMeasurements,
  type DayChange,
} from '@/lib/spare-chain/universe';
import {
  BPS_TOTAL, balanceBps, bpsTotal, feeOf, formatBps, formatFixed, formatUsd, parsePct, splitByBps, validateMix,
} from '@/lib/spare';
import { WalletPicker } from '@/components/retro/WalletPicker';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  BEVEL_WELL, FONT_TEXT, HOLO, INK, TEXTURE,
  HoloBadge, HoloButton, HoloCard, HoloChip, HoloHero, HoloInput, HoloLabel, HoloList, HoloListRow, HoloNotice,
  HoloProgress, HoloStar, HoloStat, HoloTable, HoloText, HoloTitle,
  type HoloColumn, type HoloTone,
} from '@/components/retro/holo';
import { AppCanvas, ChainNote, DeployingNotice, Hint, MutedWell, SpareGate, TxStatus, WithSpareAccount } from './spare/SpareUi';
import { HINT, ROW } from './spare/styles';
import { AssetFilterBar, AssetLabel, NoAssetMatch, PagerRow, useAssetQuery, usePaged } from './assetUi';

const chainId = SPARE_CHAIN_ID;

/** An asset's colour (swatch, composition bar, legend): one per ticker, the same in every window. */
const legFill = (asset: string) => assetColor(symbolOf(asset));
/** Rows per page in the phone list before "show more". */
const MOBILE_PAGE = 12;
/** Quick-add chips shown before the search narrows them. */
const QUICK_ADD = 8;

/** Oracle / registry tones (up · warn · down · muted) → Holo tones. */
const holoTone = (t: 'up' | 'down' | 'warn' | 'muted' | 'info'): HoloTone => (t === 'up' ? 'good' : t === 'down' ? 'bad' : t);

/** Two cards side by side on a wide window, stacked at phone width. Both cards fill the row height. */
const PAIR: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(270px, 100%), 1fr))',
  gap: 12,
  alignItems: 'stretch',
};
/** Card body that grows with a stretched PAIR row, so the frame and dither drift reach the bottom. */
const FILL_BODY: CSSProperties = { flex: 1 };

type ChainLeg = { asset: Address; bps: number };
type DraftLeg = { asset: Address; text: string };

const fmtPrice = (p1e18: bigint) => `$${formatFixed(p1e18, 18, 2)}`;

function legsFromChain(legs: readonly { asset: Address; bps: number }[] | undefined): DraftLeg[] {
  return (legs ?? []).map((l) => ({ asset: l.asset, text: formatBps(Number(l.bps)) }));
}

function sameLegs(a: readonly ChainLeg[], b: readonly ChainLeg[]): boolean {
  return a.length === b.length && a.every((l, i) => sameAddress(l.asset, b[i].asset) && l.bps === b[i].bps);
}

export function StockMixApp() {
  const { t } = useTranslation('apps-a');
  const isMobile = useIsMobile();
  const { isConnected } = useAccount();
  const { deployed, checking, error } = useSpareDeployment();
  // No wallet and nothing on-chain yet: show what a mix looks like, plus the deploying notice.
  const preDeploy = !isConnected && !deployed && !checking;
  return (
    <AppCanvas>
      <HoloHero
        art="/icons/spare/stock-mix.png"
        kicker={t('stockMix.hero.kicker')}
        title={t('shell:appNames.stock-mix')}
        subtitle={t('stockMix.hero.subtitle')}
        description={t('stockMix.hero.description')}
        aside={<HoloBadge label={t('stockMix.hero.badge')} variant="solid" />}
        compact={isMobile}
        size="lg"
        seed={33}
      />
      {preDeploy ? (
        <>
          <div style={PAIR}>
            <ExampleMixCard />
            <ConnectCard why={t('stockMix.connectWhy')} />
          </div>
          <DeployingNotice checking={false} error={error} />
        </>
      ) : (
        <SpareGate>
          <WithSpareAccount what={t('stockMix.what')}>
            {(v) => <MixBody account={v.account} readOnly={v.isSpendingWallet} />}
          </WithSpareAccount>
        </SpareGate>
      )}
    </AppCanvas>
  );
}

/* ─────────────────────────────── small pieces ─────────────────────────────── */

function Swatch({ fill, size = 12 }: { fill: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flexShrink: 0,
        background: `linear-gradient(180deg, rgba(255,255,255,.65) 0 35%, transparent 35%), ${fill}`,
        boxShadow: `0 0 0 1px ${HOLO.ink}, 2px 2px 0 0 rgba(42,27,110,.22)`,
      }}
    />
  );
}

type BarLeg = { key: string; bps: number; fill: string; name: string };

/** Stacked pixel bar of a mix: each leg a pastel block, hard indigo seams, empty track = unallocated. */
function MixBar({ legs, height = 22, label }: { legs: BarLeg[]; height?: number; label: string }) {
  const funded = legs.filter((l) => l.bps > 0);
  const sum = funded.reduce((s, l) => s + l.bps, 0);
  const denom = Math.max(BPS_TOTAL, sum);
  return (
    <div
      role="img"
      aria-label={label}
      style={{ display: 'flex', height, padding: 2, minWidth: 0, background: HOLO.paper, boxShadow: BEVEL_WELL, overflow: 'hidden' }}
    >
      {funded.map((l, i) => (
        <span
          key={l.key}
          title={l.name}
          style={{
            width: `${(l.bps / denom) * 100}%`,
            height: '100%',
            flexShrink: 0,
            background: `linear-gradient(180deg, rgba(255,255,255,.7) 0 3px, transparent 3px), ${TEXTURE.dither} 0 0 / 4px 4px, ${l.fill}`,
            boxShadow: i < funded.length - 1 || sum < BPS_TOTAL ? `inset -2px 0 0 0 ${HOLO.ink}` : undefined,
          }}
        />
      ))}
    </div>
  );
}

function MixLegend({ legs }: { legs: BarLeg[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
      {legs.map((l) => (
        <span key={l.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 12.5, color: INK.body }}>
          <Swatch fill={l.fill} />
          {l.name}
        </span>
      ))}
    </div>
  );
}

/**
 * One leg's share of the mix as a segmented pixel bar, filled in that leg's own
 * pastel (the swatch / composition-bar / legend colour) rather than the generic
 * holo meter, so a row's bar ties to its slice of the mix. Same well, segment
 * snapping and gap rendering as HoloProgress (it reuses the .holo-progress CSS).
 */
function LegShareBar({ pct, fill, segments = 10, height = 12, ariaLabel }: { pct: number; fill: string; segments?: number; height?: number; ariaLabel: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const snapped = (Math.round((v / 100) * segments) / segments) * 100;
  const step = 100 / segments;
  const gaps = `repeating-linear-gradient(90deg, transparent 0, transparent calc(${step}% - 2px), ${HOLO.paper} calc(${step}% - 2px), ${HOLO.paper} ${step}%)`;
  return (
    <div
      className="holo-progress"
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      style={{ height }}
    >
      <div className="holo-progress__track" style={{ background: HOLO.paper }}>
        <div
          className="holo-progress__fill"
          style={{
            width: `${snapped}%`,
            background: `linear-gradient(180deg, rgba(255,255,255,.7) 0 2px, transparent 2px), ${TEXTURE.dither} 0 0 / 4px 4px, ${fill}`,
            boxShadow: 'inset 0 -1px 0 rgba(42,27,110,.25)',
          }}
        />
        <div className="holo-progress__gaps" style={{ background: gaps }} />
      </div>
    </div>
  );
}

/** The no-wallet call to action: holographic mark, one line of why, one big button. */
function ConnectCard({ why }: { why: ReactNode }) {
  const { t } = useTranslation('apps-a');
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

/** Shown only when the chain has no default mix to show: what a mix looks like, clearly an example. */
function ExampleMixCard() {
  const { t } = useTranslation('apps-a');
  const EXAMPLE_LEGS: BarLeg[] = [
    { key: 'ex-a', bps: 6000, fill: assetColor('A'), name: t('stockMix.example.legA', { pct: 60 }) },
    { key: 'ex-b', bps: 4000, fill: assetColor('B'), name: t('stockMix.example.legB', { pct: 40 }) },
  ];
  return (
    <HoloCard title={t('stockMix.example.title')} icon="/icons/spare/stock-mix.png" accent={t('shell:common.example')} accentTone="ink" bodyStyle={FILL_BODY}>
      <div style={{ ...ROW, gap: 6 }}>
        {EXAMPLE_LEGS.map((l) => (
          <HoloChip key={l.key} selected icon={<Swatch fill={l.fill} size={10} />}>{l.name}</HoloChip>
        ))}
      </div>
      <MixBar legs={EXAMPLE_LEGS} label={t('stockMix.example.barAria')} />
      <HoloText size="sm" tone="muted">
        {t('stockMix.example.body')}
      </HoloText>
    </HoloCard>
  );
}

function ChangeLine({ change }: { change: DayChange | undefined }) {
  const { t } = useTranslation('apps-a');
  if (!change) return null;
  const up = change.pct >= 0;
  return (
    <span
      title={t('shell:assets.change.title')}
      style={{ display: 'block', fontSize: 10.5, fontWeight: 700, color: up ? INK.good : INK.bad, whiteSpace: 'nowrap' }}
    >
      {`${up ? '+' : '−'}${Math.abs(change.pct).toFixed(2)}%`}
    </span>
  );
}

function PriceCell({ a, change }: { a: UniverseAsset; change?: DayChange }) {
  const { t } = useTranslation('apps-a');
  if (a.status === 0 && a.price1e18 > 0n) {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span style={{ fontWeight: 700 }}>{fmtPrice(a.price1e18)}</span>
        <ChangeLine change={change} />
      </span>
    );
  }
  if (a.lastPrice1e18) {
    const when = a.lastUpdatedAt ? formatDateTime(a.lastUpdatedAt * 1000, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span title={t('stockMix.price.lastTitle', { when })} style={{ color: INK.muted }}>
          {t('stockMix.price.last', { price: fmtPrice(a.lastPrice1e18) })}
        </span>
        <ChangeLine change={change} />
      </span>
    );
  }
  return <span style={{ color: INK.muted }}>—</span>;
}

/* ─────────────────────────────────── body ─────────────────────────────────── */

function MixBody({ account, readOnly }: { account?: Address; readOnly: boolean }) {
  const { t } = useTranslation('apps-a');
  const me = account;
  const isConnected = !!account;
  const isMobile = useIsMobile();
  const tx = useSpareTx();
  const { params } = useSweepParams(true);
  const { assets, isLoading: uniLoading, error: uniError } = useUniverse({ enabled: true, withFeedPrices: true });
  const [query, setQuery] = useAssetQuery('spare.stockMix.query');
  const [addSearch, setAddSearch] = useState('');
  const { changes } = useDayChanges(assets.map((a) => a.feed));
  const changeOf = (a: UniverseAsset) => (a.feed ? changes.get(a.feed.toLowerCase()) : undefined);
  const measured = useStandbyMeasurements(assets, (tok) => {
    const a = assets.find((x) => sameAddress(x.token, tok));
    return a ? oraclePriceOf(a) : null;
  });
  const usd = (p: bigint | null) => (p == null ? null : Number(p) / 1e18);

  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'defaultMix', chainId },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'mixOf', args: [me ?? SPARE.ElectionRegistry], chainId },
      { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'hasOwnMix', args: [me ?? SPARE.ElectionRegistry], chainId },
    ],
    query: { refetchInterval: 60_000 },
  });
  const defaultMix = (reads.data?.[0] ?? []) as readonly ChainLeg[];
  const mix = (me ? reads.data?.[1] : undefined) as readonly ChainLeg[] | undefined;
  const hasOwn = me ? !!reads.data?.[2] : false;
  const chainLegs: ChainLeg[] = (mix ?? defaultMix).map((l) => ({ asset: l.asset, bps: Number(l.bps) }));

  const [draft, setDraft] = useState<DraftLeg[]>([]);
  const [seed, setSeed] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const draftLegs: ChainLeg[] = draft.map((d) => ({ asset: d.asset, bps: parsePct(d.text) ?? -1 }));
  const dirty = !sameLegs(draftLegs, chainLegs);
  const seedKey = reads.data ? `${me ?? ''}:${chainLegs.map((l) => `${l.asset}${l.bps}`).join(',')}` : null;

  // Seed from the chain on first read / wallet change / after our own save.
  useEffect(() => {
    if (!seedKey || seedKey === seed) return;
    const sameWallet = seed?.startsWith(`${me ?? ''}:`);
    if (sameWallet && dirty && tx.state.phase !== 'confirmed') return;
    setDraft(legsFromChain(chainLegs));
    setSeed(seedKey);
    setConfirmClear(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, me, tx.state.phase]);

  const maxLegs = params?.maxLegs ?? 6;
  const eligible = (a: string) => !!assets.find((x) => sameAddress(x.token, a))?.active;
  const invalidText = draft.some((d) => parsePct(d.text) == null);
  // validateMix's sentences come from lib/spare.ts, already in the live language (shell mixRules.*).
  const problem = invalidText ? t('stockMix.weightInvalid') : validateMix(draftLegs, { maxLegs, isEligible: eligible, nameOf: symbolOf });
  const total = bpsTotal(draftLegs.map((l) => ({ bps: Math.max(0, l.bps) })));

  const setText = (asset: Address, text: string) => setDraft((d) => d.map((l) => (sameAddress(l.asset, asset) ? { ...l, text } : l)));
  const bump = (asset: Address, delta: number) =>
    setDraft((d) => d.map((l) => {
      if (!sameAddress(l.asset, asset)) return l;
      const cur = parsePct(l.text) ?? 0;
      return { ...l, text: formatBps(Math.min(BPS_TOTAL, Math.max(0, cur + delta))) };
    }));
  const add = (asset: Address) =>
    setDraft((d) => {
      if (d.some((l) => sameAddress(l.asset, asset)) || d.length >= maxLegs) return d;
      const used = bpsTotal(d.map((l) => ({ bps: parsePct(l.text) ?? 0 })));
      return [...d, { asset, text: formatBps(Math.max(0, BPS_TOTAL - used)) }];
    });
  const remove = (asset: Address) => setDraft((d) => d.filter((l) => !sameAddress(l.asset, asset)));
  const balance = () =>
    setDraft((d) => balanceBps(d.map((l) => ({ asset: l.asset, bps: parsePct(l.text) ?? 0 }))).map((l) => ({ asset: l.asset, text: formatBps(l.bps) })));

  const save = () => {
    if (problem) return;
    tx.run([txStep(t('stockMix.tx.save'), {
      address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'setMix',
      args: [draftLegs.map((l) => ({ asset: l.asset, bps: l.bps }))],
    })]);
  };
  const clear = () => {
    setConfirmClear(false);
    tx.run([txStep(t('stockMix.tx.revertDefault'), { address: SPARE.ElectionRegistry, abi: electionRegistryAbi, functionName: 'clearMix' })]);
  };

  /* ── preview at the on-chain threshold, split exactly like SweepExecutor ── */
  const threshold = params?.threshold ?? 0n;
  const feeBps = params?.feeBps ?? 0;
  const preview = useMemo(
    () => (problem || threshold === 0n ? [] : splitByBps(threshold, draftLegs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [problem, threshold, JSON.stringify(draftLegs)],
  );
  const fillOf = (asset: string) => legFill(asset);

  /* ── universe: one set of cell renderers, shown as a table (desktop) or stacked rows (phone) ── */
  const shown = sortAssets(filterAssets(assets, query), query.sort, {
    price: (a) => usd(oraclePriceOf(a)),
    change: (a) => changeOf(a)?.pct,
  });
  const resetKey = [query.search, query.kind, query.state, query.sort].join('|');
  const paged = usePaged(shown, MOBILE_PAGE, resetKey);
  const whyStandby = (a: UniverseAsset) =>
    // standbyText speaks the live language (shell assets.standby.*).
    standbyText(standbyReason(a, measured.has(a.token.toLowerCase()) ? measured.get(a.token.toLowerCase()) : undefined));
  const assetName = (a: UniverseAsset) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, minWidth: 0, maxWidth: '100%' }}>
      <span style={a.active ? undefined : { opacity: 0.6 }}>
        <AssetLabel symbol={a.symbol} name={a.name} kind={a.kind} />
      </span>
      {!a.active && <span style={{ color: INK.muted, fontSize: 10.5, lineHeight: 1.35, whiteSpace: 'normal' }}>{whyStandby(a)}</span>}
    </span>
  );
  const oracleBadge = (a: UniverseAsset) => {
    // oracleView's label / detail come from lib/spare-chain/hooks.ts, already in the live language.
    const v = oracleView(a.status);
    return <span title={v.detail}><HoloBadge label={v.label} tone={holoTone(v.tone)} /></span>;
  };
  const registryBadge = (a: UniverseAsset) => (
    <HoloBadge label={a.active ? t('stockMix.registry.eligible') : t('stockMix.registry.inactive')} tone={a.active ? 'good' : 'muted'} dot={false} />
  );
  const assetAction = (a: UniverseAsset) => {
    const inMix = draft.some((l) => sameAddress(l.asset, a.token));
    if (!a.active) {
      return <span title={whyStandby(a) ?? t('stockMix.registry.inactiveTitle')} style={{ color: INK.muted, fontSize: 11 }}>{t('stockMix.registry.notElectable')}</span>;
    }
    return (
      <HoloButton size="sm" disabled={!isConnected || inMix || draft.length >= maxLegs} onClick={() => add(a.token)}>
        {inMix ? t('stockMix.registry.inMix') : t('stockMix.registry.add')}
      </HoloButton>
    );
  };

  type UniRow = UniverseAsset & Record<string, unknown>;
  // Standby assets read greyed out (with their reason); only active ones can be added.
  const dim = (a: UniverseAsset, node: ReactNode) => (a.active ? node : <span style={{ opacity: 0.6 }}>{node}</span>);
  const uniCols: HoloColumn<UniRow>[] = [
    { key: 'symbol', label: t('stockMix.cols.asset'), width: 'minmax(170px, 1.6fr)', wrap: true, render: assetName },
    { key: 'price', label: t('stockMix.cols.oraclePrice'), width: 130, align: 'right', render: (a) => dim(a, <PriceCell a={a} change={changeOf(a)} />) },
    { key: 'status', label: t('stockMix.cols.oracle'), width: 128, render: (a) => dim(a, oracleBadge(a)) },
    { key: 'active', label: t('stockMix.cols.registry'), width: 106, render: registryBadge },
    { key: 'add', label: '', width: 118, align: 'right', wrap: true, render: assetAction },
  ];

  const clearFilters = () => setQuery({ search: '', kind: 'all', state: 'all' });

  /* Phone: no sideways scroll. Each asset is a two-line row: name + price, then badges + action. */
  const universeList = uniLoading && assets.length === 0 ? (
    <div className="holo-table__empty">{t('shell:common.loading')}</div>
  ) : assets.length === 0 ? (
    <div className="holo-table__empty">{t('stockMix.universe.empty')}</div>
  ) : shown.length === 0 ? (
    <NoAssetMatch query={query} onClear={clearFilters} />
  ) : (
    <div role="list" aria-label={t('stockMix.universe.aria')}>
      {paged.visible.map((a, i) => (
        <div
          key={a.token}
          role="listitem"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 8px 9px',
            borderBottom: i < paged.visible.length - 1 ? '1px dashed rgba(154,139,224,.7)' : undefined,
            background: i % 2 === 0 ? '#FFF6F0' : undefined,
            opacity: a.active ? 1 : 0.72,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, fontFamily: FONT_TEXT, fontSize: 12, color: INK.body }}>
            <span style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>{assetName(a)}</span>
            <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}><PriceCell a={a} change={changeOf(a)} /></span>
          </div>
          <div style={{ ...ROW, gap: 6 }}>
            {oracleBadge(a)}
            {registryBadge(a)}
            <span style={{ flex: 1 }} />
            {assetAction(a)}
          </div>
        </div>
      ))}
    </div>
  );

  const funded = draftLegs.filter((l) => l.bps > 0);
  const barLegs: BarLeg[] = funded.map((l) => ({ key: l.asset, bps: l.bps, fill: fillOf(l.asset), name: `${symbolOf(l.asset)} ${formatBps(l.bps)}%` }));
  const defaultBar: BarLeg[] = defaultMix.map((l) => ({ key: l.asset, bps: Number(l.bps), fill: legFill(l.asset), name: `${symbolOf(l.asset)} ${formatBps(Number(l.bps))}%` }));
  const addable = sortAssets(
    assets.filter((a) => a.active && !draft.some((l) => sameAddress(l.asset, a.token))),
    'symbol',
  );
  // Default-mix assets first (the usual picks), then A→Z; the search box narrows the rest.
  const inDefault = (a: UniverseAsset) => defaultMix.some((l) => sameAddress(l.asset, a.token));
  const addMatches = filterAssets(addable, { search: addSearch, kind: 'all', state: 'all' }).sort((a, b) => Number(inDefault(b)) - Number(inDefault(a)));
  const addChips = addMatches.slice(0, QUICK_ADD);
  const totalOk = total === BPS_TOTAL;

  /* ── cards ── */

  const universeCard = (
    <HoloCard
      title={t('stockMix.universe.title')}
      icon="/icons/spare/stock-desk.png"
      accent={
        uniLoading
          ? t('stockMix.universe.reading')
          : t('stockMix.universe.count', { eligible: assets.filter((a) => a.active).length, registered: assets.length })
      }
      accentTone="info"
      bar="lilac"
    >
      {assets.length > 0 && (
        <AssetFilterBar query={query} onChange={setQuery} shown={shown.length} total={assets.length} sorts={['symbol', 'name', 'price', 'change']} />
      )}
      {isMobile ? (
        <>
          <div style={{ background: HOLO.paper, boxShadow: BEVEL_WELL, padding: 2, minWidth: 0 }}>{universeList}</div>
          <PagerRow hidden={paged.hidden} page={MOBILE_PAGE} expanded={paged.expanded} onMore={paged.more} onLess={paged.less} />
        </>
      ) : assets.length > 0 && shown.length === 0 ? (
        <NoAssetMatch query={query} onClear={clearFilters} />
      ) : (
        <HoloTable
          columns={uniCols}
          rows={shown as UniRow[]}
          rowKey={(a) => a.token}
          loading={uniLoading && assets.length === 0}
          emptyMessage={t('stockMix.universe.empty')}
          minWidth={640}
          maxHeight={460}
          ariaLabel={t('stockMix.universe.aria')}
        />
      )}
      <Hint>
        <Trans t={t} i18nKey="stockMix.universe.staleNote" components={{ warn: <span style={{ color: INK.warn, fontWeight: 700 }} /> }} />
      </Hint>
    </HoloCard>
  );

  const previewCard = (
    <HoloCard
      title={t('stockMix.preview.title')}
      accent={threshold ? t('stockMix.preview.accent', { threshold: formatUsd(threshold) }) : t('stockMix.preview.accentUnread')}
      accentTone="info"
    >
      {preview.length === 0 ? (
        <MutedWell>{problem ? t('stockMix.preview.fixMix') : t('stockMix.preview.readingThreshold')}</MutedWell>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 20px' }}>
            <HoloStat label={t('stockMix.preview.oneSweep')} value={formatUsd(threshold)} size="lg" sub={t('stockMix.preview.onChainThreshold')} />
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <MixBar legs={barLegs} height={18} label={t('stockMix.preview.splitAria', { legs: barLegs.map((l) => l.name).join(', ') })} />
            </div>
          </div>
          <HoloList>
            {preview.map(({ leg, amount }) => (
              <HoloListRow
                key={leg.asset}
                icon={<Swatch fill={fillOf(leg.asset)} />}
                label={symbolOf(leg.asset)}
                value={formatUsd(amount)}
                right={<span style={{ ...HINT, whiteSpace: 'nowrap' }}>{t('stockMix.preview.fee', { fee: formatUsd(feeOf(amount, feeBps), 4) })}</span>}
              />
            ))}
          </HoloList>
          <span style={HINT}>
            {t('stockMix.preview.note', { fee: formatBps(feeBps) })}
          </span>
        </>
      )}
    </HoloCard>
  );

  /* weights editor row widths (the header row mirrors them on desktop) */
  // On a phone each leg wraps to three lines: asset + weight / share bar / amount + remove.
  const COL_ASSET = '0 0 92px';
  const COL_WEIGHT = '0 0 150px';
  const COL_SHARE = isMobile ? '1 1 100%' : '1 1 110px';
  const COL_AMT = isMobile ? '1 1 auto' : '0 0 92px';
  const COL_RM = '0 0 80px';

  return (
    <>
      <ChainNote />
      {(reads.error || uniError) && (
        <HoloNotice tone="error" compact title={t('stockMix.readFailed')}>{humanizeError(reads.error ?? uniError)}</HoloNotice>
      )}

      {!isConnected ? (
        <>
          <div style={PAIR}>
            {!reads.isLoading && defaultMix.length === 0 ? (
              <ExampleMixCard />
            ) : (
              <HoloCard
                title={t('stockMix.defaultMix.title')}
                icon="/icons/spare/stock-mix.png"
                accent={t('stockMix.defaultMix.badge')}
                accentTone="muted"
                bodyStyle={FILL_BODY}
              >
                <HoloText size="sm" bold>{t('stockMix.defaultMix.usedWhen')}</HoloText>
                {reads.isLoading ? (
                  <Hint>{t('stockMix.defaultMix.reading')}</Hint>
                ) : (
                  <>
                    <div style={{ ...ROW, gap: 6 }}>
                      {defaultBar.map((l) => (
                        <HoloChip key={l.key} selected icon={<Swatch fill={l.fill} size={10} />}>{l.name}</HoloChip>
                      ))}
                    </div>
                    <MixBar legs={defaultBar} label={t('stockMix.defaultMix.barAria', { legs: defaultBar.map((l) => l.name).join(', ') })} />
                    <HoloText size="sm" tone="muted">
                      {t('stockMix.defaultMix.body')}
                    </HoloText>
                  </>
                )}
              </HoloCard>
            )}
            <ConnectCard why={t('stockMix.connectWhy')} />
          </div>
          {previewCard}
          {universeCard}
        </>
      ) : (
        <>
          <HoloCard
            title={t('stockMix.yourMix.title')}
            icon="/icons/spare/stock-mix.png"
            accent={reads.isLoading ? t('stockMix.yourMix.reading') : hasOwn ? t('stockMix.yourMix.own') : t('stockMix.yourMix.usingDefault')}
            accentTone={hasOwn ? 'good' : 'muted'}
          >
            {/* summary: total weight as a poster numeral, legs, balance */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px 18px', flexWrap: 'wrap' }}>
              <HoloStat
                label={t('stockMix.yourMix.totalWeight')}
                value={`${formatBps(total)}%`}
                size="lg"
                tone={totalOk ? 'good' : 'warn'}
                sub={totalOk ? t('stockMix.yourMix.complete') : t('stockMix.yourMix.mustTotal')}
                subTone={totalOk ? 'good' : 'warn'}
              />
              <div style={{ ...ROW, gap: 6, paddingBottom: 4 }}>
                <HoloBadge label={t('stockMix.yourMix.legs', { n: draft.length, max: maxLegs })} tone="info" dot={false} />
                {!hasOwn && <HoloBadge label={t('stockMix.defaultMix.badge')} tone="muted" dot={false} />}
              </div>
              <div style={{ flex: 1 }} />
              <HoloButton disabled={draft.length === 0 || total === BPS_TOTAL} onClick={balance}>{t('stockMix.yourMix.balance')}</HoloButton>
            </div>
            <HoloProgress value={total / 100} segments={20} height={12} tone={totalOk ? 'good' : 'warn'} ariaLabel={t('stockMix.yourMix.totalWeight')} />

            {/* quick add from the eligible universe: the usual picks, a search for the rest */}
            {addable.length > 0 && !readOnly && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ ...ROW, gap: 6 }}>
                  <HoloLabel>{t('stockMix.yourMix.add')}</HoloLabel>
                  {addable.length > QUICK_ADD && (
                    <HoloInput
                      type="search"
                      inputSize="sm"
                      value={addSearch}
                      onChange={(e) => setAddSearch(e.target.value)}
                      placeholder={t('stockMix.yourMix.findPlaceholder', { n: addable.length })}
                      aria-label={t('stockMix.yourMix.findAria')}
                      fieldStyle={{ flex: isMobile ? '1 1 100%' : '0 1 220px', minWidth: 0 }}
                    />
                  )}
                </div>
                <div style={{ ...ROW, gap: 6 }}>
                  {addChips.map((a) => (
                    <HoloChip
                      key={a.token}
                      size="sm"
                      icon={<Swatch fill={assetColor(a.symbol)} size={9} />}
                      onClick={() => add(a.token)}
                      disabled={!isConnected || draft.length >= maxLegs}
                      title={t('stockMix.yourMix.addTitle', { sym: a.name ? `${a.symbol} · ${a.name}` : a.symbol })}
                    >
                      + {a.symbol}
                    </HoloChip>
                  ))}
                  {addMatches.length > addChips.length && (
                    <span style={{ ...HINT, whiteSpace: 'nowrap' }}>{t('stockMix.yourMix.moreToFind', { n: addMatches.length - addChips.length })}</span>
                  )}
                  {addMatches.length === 0 && <span style={HINT}>{t('stockMix.yourMix.noMatch')}</span>}
                </div>
              </div>
            )}

            {draft.length === 0 ? (
              <MutedWell>{t('stockMix.yourMix.noLegs')}</MutedWell>
            ) : (
              <div style={{ background: HOLO.paper, boxShadow: BEVEL_WELL, padding: '2px 4px' }}>
                {!isMobile && (
                  <div style={{ display: 'flex', gap: 12, padding: '6px 8px 4px', borderBottom: `2px solid ${HOLO.ink}` }}>
                    <HoloLabel style={{ flex: COL_ASSET }}>{t('stockMix.cols.asset')}</HoloLabel>
                    <HoloLabel style={{ flex: COL_WEIGHT }}>{t('stockMix.yourMix.weight')}</HoloLabel>
                    <HoloLabel style={{ flex: COL_SHARE }}>{t('stockMix.yourMix.share')}</HoloLabel>
                    <HoloLabel style={{ flex: COL_AMT, textAlign: 'right' }}>{t('stockMix.yourMix.atThreshold')}</HoloLabel>
                    <span style={{ flex: COL_RM }} />
                  </div>
                )}
                <div role="list" aria-label={t('stockMix.yourMix.legsAria')}>
                  {draft.map((l, i) => {
                    const sym = symbolOf(l.asset);
                    const bps = parsePct(l.text);
                    const leg = preview.find((p) => sameAddress(p.leg.asset, l.asset));
                    return (
                      <div
                        key={l.asset}
                        role="listitem"
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: '8px 12px',
                          padding: '8px',
                          borderBottom: i < draft.length - 1 ? '1px dashed rgba(154,139,224,.7)' : undefined,
                          background: i % 2 === 0 ? '#FFF6F0' : undefined,
                        }}
                      >
                        <span style={{ flex: COL_ASSET, display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <Swatch fill={legFill(l.asset)} size={14} />
                          <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 14, color: INK.body, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sym}</span>
                        </span>
                        <span style={{ flex: COL_WEIGHT, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <HoloButton size="sm" title="-5%" aria-label={`${sym} −5%`} onClick={() => bump(l.asset, -500)}>−</HoloButton>
                          <HoloInput
                            inputSize="sm"
                            width={78}
                            suffix="%"
                            value={l.text}
                            inputMode="decimal"
                            invalid={bps == null}
                            aria-label={t('stockMix.yourMix.weightAria', { sym })}
                            onChange={(e) => setText(l.asset, e.target.value)}
                          />
                          <HoloButton size="sm" title="+5%" aria-label={`${sym} +5%`} onClick={() => bump(l.asset, 500)}>+</HoloButton>
                        </span>
                        <span style={{ flex: COL_SHARE, minWidth: 0 }}>
                          <LegShareBar pct={(bps ?? 0) / 100} fill={legFill(l.asset)} ariaLabel={t('stockMix.yourMix.shareAria', { sym })} />
                        </span>
                        <span style={{ flex: COL_AMT, textAlign: isMobile ? 'left' : 'right', fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13, color: INK.body, whiteSpace: 'nowrap' }}>
                          {leg ? formatUsd(leg.amount) : '—'}
                          {isMobile && <span style={{ ...HINT, fontWeight: 400 }}> {t('stockMix.yourMix.atThresholdInline')}</span>}
                        </span>
                        <span style={{ flex: COL_RM, display: 'flex', justifyContent: 'flex-end' }}>
                          <HoloButton size="sm" onClick={() => remove(l.asset)}>{t('stockMix.yourMix.remove')}</HoloButton>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {funded.length > 0 && (
              <>
                <MixBar legs={barLegs} label={t('stockMix.yourMix.barAria', { legs: barLegs.map((l) => l.name).join(', ') })} />
                <MixLegend legs={barLegs} />
              </>
            )}

            {readOnly ? (
              <Hint>
                {hasOwn
                  ? t('stockMix.yourMix.readOnlyOwn', { addr: me ? shortAddr(me) : '' })
                  : t('stockMix.yourMix.readOnlyDefault', { addr: me ? shortAddr(me) : '' })}
              </Hint>
            ) : (
              <Hint warn={!!problem && dirty}>
                {dirty
                  ? problem ?? t('stockMix.yourMix.valid')
                  : hasOwn
                    ? t('stockMix.yourMix.matches')
                    : t('stockMix.yourMix.isDefault')}
              </Hint>
            )}
            <div style={{ ...ROW, justifyContent: 'flex-end' }}>
              <HoloButton disabled={!dirty || tx.busy} onClick={() => setDraft(legsFromChain(chainLegs))}>{t('stockMix.yourMix.revert')}</HoloButton>
              {!readOnly && hasOwn && (confirmClear ? (
                <>
                  <HoloButton variant="danger" disabled={tx.busy} onClick={clear}>{t('stockMix.yourMix.confirmClear')}</HoloButton>
                  <HoloButton onClick={() => setConfirmClear(false)}>{t('shell:common.cancel')}</HoloButton>
                </>
              ) : (
                <HoloButton disabled={tx.busy} onClick={() => setConfirmClear(true)}>{t('stockMix.yourMix.clear')}</HoloButton>
              ))}
              {!readOnly && <HoloButton variant="primary" disabled={!dirty || !!problem || tx.busy} onClick={save}>{t('stockMix.yourMix.save')}</HoloButton>}
            </div>
            <TxStatus state={tx.state} onDismiss={tx.reset} />
          </HoloCard>
          {previewCard}
          {universeCard}
        </>
      )}
    </>
  );
}

export default StockMixApp;
