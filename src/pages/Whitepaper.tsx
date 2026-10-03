/**
 * /whitepaper — the Spare design paper.
 *
 * Long-form, one scrolling page with a sticky section nav. Live values:
 *   · chain (direct, via src/lib/spare-chain): contract bytecode, conversion
 *     fee, FeeVault USDG / WETH balances
 *   · Spare API (optional): all-time conversion fees and converted volume
 *     (GET /api/spare/fees needs an event scan). Until the API answers these
 *     read "—" / "unavailable".
 */
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient, useReadContracts } from 'wagmi';
import { erc20Abi } from 'viem';
import {
  Addr,
  Bullets,
  Code,
  Ctas,
  DataTable,
  DocSection,
  GlassCard,
  Grid,
  H3,
  LinkButton,
  P,
  PublicShell,
  SpareContractsTable,
  StatTile,
  useSectionSpy,
  type PublicSidebarSection,
} from '@/components/public/PublicShell';
import { HoloBadge, HoloLabel, HoloList, HoloListRow, HoloNotice, HoloText } from '@/components/retro/holo';
import { oraclePriceOf, useSpareDeployment, useSweepParams, useUniverse } from '@/lib/spare-chain/hooks';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import { quoteMany, shortfallPct, type QuoteRequest } from '@/lib/spare-chain/universe';
import { AssetLabel, PagerRow, usePaged } from '@/components/retro/apps/assetUi';
import { V4_QUOTER, WETH } from '@/lib/spare-chain/fund-swap';
import { formatBps, formatToken, formatUsd } from '@/lib/spare';
import { API_BASE } from '@/lib/config';
import { useSpareApi } from '@/components/public/live/spareApi';
import { Trans, tKey, useLang, useTranslation } from '@/i18n';

/** Section nav; labels are pages-a keys ('$SPARE' is a literal, never translated). */
const SIDEBAR: PublicSidebarSection[] = [
  {
    label: tKey('whitepaper.nav.intro'),
    items: [
      { id: 'abstract', label: tKey('whitepaper.nav.abstract') },
      { id: 'summary', label: tKey('whitepaper.nav.summary') },
      { id: 'problem', label: tKey('whitepaper.nav.problem') },
      { id: 'whynow', label: tKey('whitepaper.nav.whynow') },
    ],
  },
  {
    label: tKey('whitepaper.nav.design'),
    items: [
      { id: 'laws', label: tKey('whitepaper.nav.laws') },
      { id: 'architecture', label: tKey('whitepaper.nav.architecture') },
      { id: 'accrual', label: tKey('whitepaper.nav.accrual') },
      { id: 'execution', label: tKey('whitepaper.nav.execution') },
      { id: 'parking', label: tKey('whitepaper.nav.parking') },
      { id: 'units', label: tKey('whitepaper.nav.units') },
    ],
  },
  {
    label: tKey('whitepaper.nav.economics'),
    items: [
      { id: 'fees', label: tKey('whitepaper.nav.fees') },
      { id: 'token', label: '$SPARE' },
    ],
  },
  {
    label: tKey('whitepaper.nav.closing'),
    items: [
      { id: 'privacy', label: tKey('whitepaper.nav.privacy') },
      { id: 'roadmap', label: tKey('whitepaper.nav.roadmap') },
      { id: 'boundaries', label: tKey('whitepaper.nav.boundaries') },
      { id: 'disclaimers', label: tKey('whitepaper.nav.disclaimers') },
    ],
  },
];

const SECTION_IDS = SIDEBAR.flatMap((g) => g.items.map((i) => i.id));

/** The sidebar with its keys translated. */
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

/* ───────────────────────────── live data ───────────────────────────── */

/** The `spare_fees` REST mirror — only the fields this page renders. */
interface SpareFeesResponse {
  feeBps: number;
  maxFeeBps: number;
  conversionFeesAllTimeUsd: string | number | null;
  convertedAllTimeUsd: string | number | null;
  allTimeComplete?: boolean;
}

async function fetchSpareApi(path: string, timeoutMs = 8000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    window.clearTimeout(timer);
  }
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isUsdField = (v: unknown) => v === null || isFiniteNum(v) || (typeof v === 'string' && v.trim() !== '');

/**
 * Accept only a `spare_fees` document: numeric feeBps/maxFeeBps, both all-time
 * fields present, and — once the chain has answered — feeBps equal to the live
 * SweepExecutor.feeBps(). Anything else (another service at API_BASE, a stale
 * backend) is "not the Spare API" and renders nothing.
 */
function parseSpareFees(j: unknown, onChainFeeBps: number | null): SpareFeesResponse | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (!isFiniteNum(o.feeBps) || !isFiniteNum(o.maxFeeBps)) return null;
  if (!isUsdField(o.conversionFeesAllTimeUsd) || !isUsdField(o.convertedAllTimeUsd)) return null;
  if (onChainFeeBps !== null && o.feeBps !== onChainFeeBps) return null;
  return {
    feeBps: o.feeBps,
    maxFeeBps: o.maxFeeBps,
    conversionFeesAllTimeUsd: o.conversionFeesAllTimeUsd as string | number | null,
    convertedAllTimeUsd: o.convertedAllTimeUsd as string | number | null,
    allTimeComplete: typeof o.allTimeComplete === 'boolean' ? o.allTimeComplete : undefined,
  };
}

/** API dollar string -> "$1,234.56"; anything unreadable -> null (rendered as "—"). */
function apiUsd(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function FeesLive() {
  const { t } = useTranslation('pages-a');
  const dep = useSpareDeployment();
  const sweep = useSweepParams(dep.deployed);
  const vault = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: EXTERNAL.USDG, abi: erc20Abi, functionName: 'balanceOf', args: [SPARE.FeeVault], chainId: SPARE_CHAIN_ID },
      { address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [SPARE.FeeVault], chainId: SPARE_CHAIN_ID },
    ] as const,
    query: { refetchInterval: 60_000 },
  });
  // All-time totals come from the Spare API — but only once /health has
  // answered as `service: "spare-api"`; any other host at API_BASE is ignored.
  const { status: apiStatus, checking: apiChecking } = useSpareApi();
  const apiOnline = apiStatus?.online === true;
  const api = useQuery({
    queryKey: ['spare-api', 'fees', API_BASE],
    queryFn: () => fetchSpareApi('/api/spare/fees'),
    enabled: apiOnline,
    retry: 1,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const reading = vault.isLoading || dep.checking;
  const usdg = vault.data?.[0]?.status === 'success' ? formatUsd(vault.data[0].result as bigint) : null;
  const weth = vault.data?.[1]?.status === 'success' ? `${formatToken(vault.data[1].result as bigint, 18, 6)} WETH` : null;
  const fee = sweep.params ? `${formatBps(sweep.params.feeBps)}%` : null;

  const fees = apiOnline && api.data !== undefined ? parseSpareFees(api.data, sweep.params?.feeBps ?? null) : null;
  const feesAll = fees ? apiUsd(fees.conversionFeesAllTimeUsd) : null;
  const converted = fees ? apiUsd(fees.convertedAllTimeUsd) : null;
  const apiAsking = apiChecking || (apiOnline && api.isLoading);
  const apiDown = !apiAsking && !fees;
  const apiSub = apiAsking
    ? t('whitepaper.feesLive.apiAsking')
    : apiDown
      ? t('whitepaper.feesLive.apiDown')
      : fees?.allTimeComplete === false
        ? t('whitepaper.feesLive.apiCatchingUp')
        : 'Spare API · Σ AssetSwept';
  const unavailable = t('common.liveReadUnavailable');

  return (
    <GlassCard
      title={t('whitepaper.feesLive.title')}
      icon="/icons/spare/spare-balance.png"
      accent={<Addr address={SPARE.FeeVault} label="FeeVault ↗" />}
    >
      <HoloLabel>{t('whitepaper.feesLive.onChainNow')}</HoloLabel>
      <Grid min={180}>
        <StatTile label={t('whitepaper.feesLive.conversionFee')} value={fee ?? (reading || sweep.isLoading ? '…' : '—')} sub={fee ? 'SweepExecutor.feeBps()' : unavailable} />
        <StatTile label="FeeVault USDG" value={usdg ?? (reading ? '…' : '—')} sub={usdg ? t('whitepaper.feesLive.usdgSub') : unavailable} />
        <StatTile label="FeeVault WETH" value={weth ?? (reading ? '…' : '—')} sub={weth ? t('whitepaper.feesLive.wethSub') : unavailable} />
      </Grid>
      <HoloLabel>{t('whitepaper.feesLive.allTime')}</HoloLabel>
      <Grid min={180}>
        <StatTile label={t('whitepaper.feesLive.feesAllTime')} value={feesAll ?? (apiAsking ? '…' : '—')} sub={apiSub} />
        <StatTile label={t('whitepaper.feesLive.convertedAllTime')} value={converted ?? (apiAsking ? '…' : '—')} sub={apiSub} />
      </Grid>
      {apiDown && (
        <HoloNotice tone="info" compact title={t('whitepaper.feesLive.apiNeededTitle')}>
          {t('whitepaper.feesLive.apiNeededBody')}
        </HoloNotice>
      )}
      <HoloText tone="muted" size="xs">
        {t('whitepaper.feesLive.wethNote')}
      </HoloText>
    </GlassCard>
  );
}

/* ─────────────────────────── measured fills, live ─────────────────────────── */

/** $5 and $100, the sizes every asset is checked at before activation. */
const FILL_SIZES = [5_000_000n, 100_000_000n] as const;
const FILLS_PAGE = 12;

/** "−0.09%" (fewer tokens than Chainlink) / "+0.04%" (more), or "—". */
function fillText(shortfall: number | null | undefined): string {
  if (shortfall == null || !Number.isFinite(shortfall)) return '—';
  const v = -shortfall;
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
}

/**
 * Every registered asset's pinned pool, quoted now on the V4Quoter at $5 and
 * $100 and compared with its Chainlink price (one batched read for them all).
 * Replaces a table of numbers measured once at launch: the universe grows, so
 * the page reads the chain instead of quoting a snapshot.
 */
function LiveFills() {
  const { t } = useTranslation('pages-a');
  const dep = useSpareDeployment();
  const client = usePublicClient({ chainId: SPARE_CHAIN_ID });
  const uni = useUniverse({ enabled: dep.deployed, withFeedPrices: true });
  const rows = [...uni.assets].sort((a, b) => Number(b.active) - Number(a.active) || a.symbol.localeCompare(b.symbol));
  const pooled = rows.filter((a) => a.poolKey);
  const quotes = useQuery({
    queryKey: ['whitepaper', 'fills', pooled.map((a) => a.token).join(',')],
    enabled: !!client && pooled.length > 0,
    staleTime: 120_000,
    queryFn: async () => {
      const reqs: QuoteRequest[] = pooled.flatMap((a) => FILL_SIZES.map((usdgIn) => ({ poolKey: a.poolKey!, usdgIn })));
      const outs = await quoteMany(client!, reqs);
      return new Map(pooled.map((a, i) => [a.token.toLowerCase(), FILL_SIZES.map((_, k) => outs[i * FILL_SIZES.length + k])]));
    },
  });
  const paged = usePaged(rows, FILLS_PAGE, String(rows.length));

  if (uni.isLoading || dep.checking) return <HoloText tone="muted" size="sm">{t('whitepaper.execution.reading')}</HoloText>;
  if (rows.length === 0) return <HoloText tone="muted" size="sm">{t('common.liveReadUnavailable')}</HoloText>;

  const poolText = (a: (typeof rows)[number]) => {
    if (!a.poolKey) return '—';
    const fee = Number(a.poolKey.fee) === 0x800000 ? t('whitepaper.execution.dynamicFee') : `${(Number(a.poolKey.fee) / 10_000).toFixed(2)}%`;
    return a.hooked ? t('whitepaper.execution.hookedFee', { fee }) : t('whitepaper.execution.hookless', { fee });
  };
  const gapText = (a: (typeof rows)[number]) => {
    const outs = quotes.data?.get(a.token.toLowerCase());
    const oracle = oraclePriceOf(a);
    if (!outs) return quotes.isLoading ? '…' : '—';
    const [s5, s100] = FILL_SIZES.map((usdgIn, k) => shortfallPct(usdgIn, outs[k], oracle));
    return t('whitepaper.execution.gapAt', { a: fillText(s5), b: fillText(s100) });
  };

  return (
    <>
      <DataTable
        head={[t('whitepaper.execution.headStock'), t('whitepaper.execution.headPool'), t('whitepaper.execution.headGap'), t('whitepaper.execution.headStatus')]}
        minWidth={560}
        stack
        caption={t('whitepaper.execution.caption')}
        rowKey={(_, i) => paged.visible[i].token}
        rows={paged.visible.map((a) => [
          <AssetLabel key="a" symbol={a.symbol} kind={a.kind} size={12.5} />,
          poolText(a),
          gapText(a),
          a.active ? (
            <HoloBadge key="s" label={t('common.active')} tone="good" />
          ) : (
            <HoloBadge key="s" label={t('common.inactive')} tone="muted" />
          ),
        ])}
      />
      <PagerRow hidden={paged.hidden} page={FILLS_PAGE} expanded={paged.expanded} onMore={paged.more} onLess={paged.less} />
    </>
  );
}

/* ───────────────────────────── diagrams ───────────────────────────── */

/** step/what are pages-a keys; where is a key (whereIsKey) or a contract name, kept literal. */
const FLOW: { id: string; step: string; what: string; where: string; whereIsKey?: boolean }[] = [
  { id: 'pay', step: tKey('whitepaper.flow.pay.step'), what: tKey('whitepaper.flow.pay.what'), where: tKey('whitepaper.flow.yourWallet'), whereIsKey: true },
  { id: 'collect', step: tKey('whitepaper.flow.collect.step'), what: tKey('whitepaper.flow.collect.what'), where: 'SweepExecutor' },
  { id: 'park', step: tKey('whitepaper.flow.park.step'), what: tKey('whitepaper.flow.park.what'), where: 'CashPark' },
  { id: 'sweep', step: tKey('whitepaper.flow.sweep.step'), what: tKey('whitepaper.flow.sweep.what'), where: tKey('whitepaper.flow.keeper'), whereIsKey: true },
  { id: 'buy', step: tKey('whitepaper.flow.buy.step'), what: tKey('whitepaper.flow.buy.what'), where: 'StockRouter' },
  { id: 'deliver', step: tKey('whitepaper.flow.deliver.step'), what: tKey('whitepaper.flow.deliver.what'), where: tKey('whitepaper.flow.yourWallet'), whereIsKey: true },
];

function FlowDiagram() {
  const { t } = useTranslation('pages-a');
  return (
    <>
    <style>{FLOW_CSS}</style>
    <ol className="wp-flow" aria-label={t('whitepaper.flow.aria')}>
      {FLOW.map((f, i) => (
        <li key={f.id} className="wp-flow__node">
          <span className="wp-flow__n" aria-hidden>
            {i + 1}
          </span>
          <span className="wp-flow__step">{t(f.step)}</span>
          <span className="wp-flow__what">{t(f.what)}</span>
          <span className="wp-flow__where">{f.whereIsKey ? t(f.where) : f.where}</span>
        </li>
      ))}
    </ol>
    </>
  );
}

const FLOW_CSS = `
.wp-flow { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 18px; }
.wp-flow__node {
  position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0;
  padding: 10px 10px 12px; border: 2px solid #2A1B6E;
  background: linear-gradient(160deg, #FFFFFF 0%, #FFF5EE 38%, #FBEEFF 70%, #EDF1FF 100%);
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.2);
}
.wp-flow__node:not(:last-child)::after {
  content: ''; position: absolute; top: 50%; right: -17px; width: 14px; height: 12px; margin-top: -6px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 7 6' shape-rendering='crispEdges'%3E%3Cpath fill='%232A1B6E' d='M0 2h4v2H0zM4 0h1v6H4zM5 1h1v4H5zM6 2h1v2H6z'/%3E%3C/svg%3E") center / contain no-repeat;
}
.wp-flow__n {
  width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%); color: #FFF6EE;
  font-family: var(--holo-font-display); font-size: 10px; box-shadow: inset 1px 1px 0 #7B63E0;
}
.wp-flow__step { font-family: var(--holo-font-chrome); font-size: 21px; line-height: 1; color: #2A1B6E; }
.wp-flow__what { font-family: var(--holo-font-text); font-size: 11.5px; line-height: 1.45; color: #2A1B6E; }
.wp-flow__where { margin-top: auto; font-family: var(--holo-font-pixel); font-weight: 700; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: #4B36B8; }
@media (max-width: 1100px) {
  .wp-flow { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .wp-flow__node:nth-child(3)::after { display: none; }
}
@media (max-width: 767px) {
  .wp-flow { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .wp-flow__node { display: grid; grid-template-columns: 26px 1fr; column-gap: 10px; row-gap: 2px; }
  .wp-flow__n { grid-row: span 3; }
  .wp-flow__where { margin-top: 2px; }
  .wp-flow__node:not(:last-child)::after, .wp-flow__node:nth-child(3)::after {
    display: block; top: auto; bottom: -16px; right: auto; left: 22px; margin-top: 0; transform: rotate(90deg);
  }
}
`;

/** The owner's laws: law / note / status are pages-a keys. */
const LAWS: { id: string; law: string; status: string; tone: 'good' | 'info' | 'warn'; note?: string }[] = [
  { id: 'l1', law: tKey('whitepaper.laws.l1'), status: tKey('whitepaper.laws.live'), tone: 'good' },
  { id: 'l2', law: tKey('whitepaper.laws.l2'), status: tKey('whitepaper.laws.live'), tone: 'good' },
  { id: 'l3', law: tKey('whitepaper.laws.l3'), status: tKey('whitepaper.laws.live'), tone: 'good', note: tKey('whitepaper.laws.l3Note') },
  { id: 'l4', law: tKey('whitepaper.laws.l4'), status: tKey('whitepaper.laws.live'), tone: 'good', note: tKey('whitepaper.laws.l4Note') },
  { id: 'l5', law: tKey('whitepaper.laws.l5'), status: tKey('whitepaper.laws.live'), tone: 'good', note: tKey('whitepaper.laws.l5Note') },
  { id: 'l6', law: tKey('whitepaper.laws.l6'), status: tKey('whitepaper.laws.thisSite'), tone: 'info', note: tKey('whitepaper.laws.l6Note') },
];

type StageStatus = 'LIVE' | 'IN PROGRESS' | 'PLANNED';

/** Roadmap stages: title / line are pages-a keys; status picks the chip. */
const STAGES: { q: string; title: string; status: StageStatus; line: string }[] = [
  { q: 'S1', title: tKey('whitepaper.stages.s1Live.title'), status: 'LIVE', line: tKey('whitepaper.stages.s1Live.line') },
  { q: 'S1', title: tKey('whitepaper.stages.s1Hardening.title'), status: 'IN PROGRESS', line: tKey('whitepaper.stages.s1Hardening.line') },
  { q: 'S2', title: tKey('whitepaper.stages.s2.title'), status: 'PLANNED', line: tKey('whitepaper.stages.s2.line') },
  { q: 'S3', title: tKey('whitepaper.stages.s3.title'), status: 'PLANNED', line: tKey('whitepaper.stages.s3.line') },
  { q: 'S4', title: tKey('whitepaper.stages.s4.title'), status: 'PLANNED', line: tKey('whitepaper.stages.s4.line') },
];

const STAGE_TONE = { LIVE: 'good', 'IN PROGRESS': 'warn', PLANNED: 'info' } as const;
const STAGE_LABEL: Record<StageStatus, string> = {
  LIVE: tKey('whitepaper.stages.live'),
  'IN PROGRESS': tKey('whitepaper.stages.inProgress'),
  PLANNED: tKey('whitepaper.stages.planned'),
};

/** Collection bounds (keys with <code> tags). */
const ACCRUAL_BOUNDS = [
  tKey('whitepaper.accrual.b1'),
  tKey('whitepaper.accrual.b2'),
  tKey('whitepaper.accrual.b3'),
  tKey('whitepaper.accrual.b4'),
  tKey('whitepaper.accrual.b5'),
];

/** "What counts as a payment" exclusions (the same keys as Docs). */
const PAYMENT_EXCLUSIONS = [
  tKey('payments.excluded.sameAccount'),
  tKey('payments.excluded.toAccount'),
  tKey('payments.excluded.toContracts'),
  tKey('payments.excluded.swaps'),
  tKey('payments.excluded.otherTokens'),
  tKey('payments.excluded.beforeLink'),
];

/** Execution rules (keys with a <b> lead). */
const EXECUTION_RULES = [
  tKey('whitepaper.execution.b1'),
  tKey('whitepaper.execution.b2'),
  tKey('whitepaper.execution.b3'),
  tKey('whitepaper.execution.b4'),
  tKey('whitepaper.execution.b5'),
];

const BOUNDARIES = [
  tKey('whitepaper.boundaries.b1'),
  tKey('whitepaper.boundaries.b2'),
  tKey('whitepaper.boundaries.b3'),
  tKey('whitepaper.boundaries.b4'),
  tKey('whitepaper.boundaries.b5'),
];

/* ───────────────────────────────── page ───────────────────────────────── */

export default function Whitepaper() {
  const { t } = useTranslation('pages-a');
  const [active, select] = useSectionSpy(SECTION_IDS);
  const sidebar = useSidebar();
  const code = { code: <CodeTag /> };

  return (
    <PublicShell
      pageTitle={t('whitepaper.meta.pageTitle')}
      metaDescription={t('whitepaper.meta.description')}
      kicker={t('whitepaper.meta.kicker')}
      title="Spare"
      subtitle={t('whitepaper.meta.subtitle')}
      version="S1"
      heroSize="xl"
      heroSeed={23}
      heroAside={<HoloBadge label={t('whitepaper.meta.date')} tone="ink" />}
      sidebar={sidebar}
      activeId={active}
      onSelect={select}
    >
      {/* ── Introduction ───────────────────────────────────────── */}
      <DocSection id="abstract" label={t('whitepaper.nav.abstract')} kicker={t('whitepaper.nav.intro')}>
        <GlassCard title={t('whitepaper.nav.abstract')} icon="/icons/spare-logo.png">
          <P>{t('whitepaper.abstract.p1')}</P>
          <P>{t('whitepaper.abstract.p2')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="summary" label={t('whitepaper.nav.summary')}>
        <Grid min={230}>
          <GlassCard title={t('whitepaper.summary.product.title')} bar="holo">
            <P>{t('whitepaper.summary.product.body')}</P>
          </GlassCard>
          <GlassCard title={t('whitepaper.summary.custody.title')} bar="lilac">
            <P>{t('whitepaper.summary.custody.body')}</P>
          </GlassCard>
          <GlassCard title={t('whitepaper.nav.execution')} bar="holo">
            <P>{t('whitepaper.summary.execution.body')}</P>
          </GlassCard>
          <GlassCard title={t('whitepaper.summary.trust.title')} bar="lilac">
            <P>{t('whitepaper.summary.trust.body')}</P>
          </GlassCard>
          <GlassCard title={t('whitepaper.nav.fees')} bar="holo">
            <P>{t('whitepaper.summary.fees.body')}</P>
          </GlassCard>
          <GlassCard title={t('whitepaper.summary.token.title')} bar="pink" accent="S3" accentTone="ink">
            <P>{t('whitepaper.summary.token.body')}</P>
          </GlassCard>
          <GlassCard title={t('whitepaper.summary.privacy.title')} bar="pink" accent="S2" accentTone="ink">
            <P>{t('whitepaper.summary.privacy.body')}</P>
          </GlassCard>
        </Grid>
      </DocSection>

      <DocSection id="problem" label={t('whitepaper.nav.problem')}>
        <GlassCard title={t('whitepaper.nav.problem')} bar="lilac">
          <H3>{t('whitepaper.problem.heading')}</H3>
          <P>{t('whitepaper.problem.body')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="whynow" label={t('whitepaper.nav.whynow')}>
        <GlassCard title={t('whitepaper.nav.whynow')} icon="/icons/spare/stock-desk.png">
          <P>{t('whitepaper.whynow.p1')}</P>
          <P>{t('whitepaper.whynow.p2')}</P>
        </GlassCard>
      </DocSection>

      {/* ── Design ─────────────────────────────────────────────── */}
      <DocSection id="laws" label={t('whitepaper.nav.laws')} kicker={t('whitepaper.nav.design')}>
        <P>{t('whitepaper.laws.intro')}</P>
        <Grid min={260}>
          {LAWS.map((l, i) => (
            <GlassCard key={l.id} title={t('whitepaper.laws.title', { n: i + 1 })} accent={t(l.status)} accentTone={l.tone} bar={i % 2 ? 'lilac' : 'holo'}>
              <P>{t(l.law)}</P>
              {l.note && (
                <HoloText tone="muted" size="sm">
                  {t(l.note)}
                </HoloText>
              )}
            </GlassCard>
          ))}
        </Grid>
      </DocSection>

      <DocSection id="architecture" label={t('whitepaper.nav.architecture')}>
        <FlowDiagram />
        <SpareContractsTable />
        <GlassCard title={t('whitepaper.architecture.offChainTitle')} icon="/icons/spare/auto-invest.png">
          <P>{t('whitepaper.architecture.offChainBody')}</P>
          <P>{t('whitepaper.architecture.deps')}</P>
          <HoloList>
            <HoloListRow label="USDG" value={<Addr address={EXTERNAL.USDG} />} hint={t('whitepaper.architecture.usdgHint')} />
            <HoloListRow label="Permit2" value={<Addr address={EXTERNAL.Permit2} />} />
            <HoloListRow label="Uniswap v4 PoolManager" value={<Addr address={EXTERNAL.PoolManager} />} />
            <HoloListRow label="Uniswap V4Quoter" value={<Addr address={V4_QUOTER} />} />
            <HoloListRow label={t('whitepaper.architecture.feeds')} value={<Link to="/universe">{t('whitepaper.architecture.universeLink')}</Link>} />
          </HoloList>
        </GlassCard>
      </DocSection>

      <DocSection id="accrual" label={t('whitepaper.nav.accrual')}>
        <GlassCard title={t('whitepaper.accrual.title')} icon="/icons/spare/spare-activity.png" accent={t('whitepaper.accrual.accent')} accentTone="ink">
          <P>{t('whitepaper.accrual.intro')}</P>
          <Bullets items={ACCRUAL_BOUNDS.map((k) => <Trans key={k} t={t} i18nKey={k} components={code} />)} />
          <P>{t('whitepaper.accrual.outro')}</P>
        </GlassCard>
        <Grid min={260}>
          <GlassCard title={t('payments.title')} bar="lilac">
            <P>{t('whitepaper.accrual.paymentsIntro')}</P>
            <Bullets items={PAYMENT_EXCLUSIONS.map((k) => t(k))} />
          </GlassCard>
          <GlassCard title={t('whitepaper.accrual.mathTitle')} bar="holo">
            <P>
              <Trans t={t} i18nKey="whitepaper.accrual.math" components={code} />
            </P>
            <P>{t('whitepaper.accrual.acceptance')}</P>
          </GlassCard>
        </Grid>
      </DocSection>

      <DocSection id="execution" label={t('whitepaper.nav.execution')}>
        <GlassCard title={t('whitepaper.execution.title')} icon="/icons/spare/stock-mix.png">
          <Bullets items={EXECUTION_RULES.map((k) => <Trans key={k} t={t} i18nKey={k} components={BOLD} />)} />
        </GlassCard>
        <H3>{t('whitepaper.execution.fillsHeading')}</H3>
        <LiveFills />
      </DocSection>

      <DocSection id="parking" label={t('whitepaper.nav.parking')}>
        <GlassCard title="CashPark" icon="/icons/spare/spare-balance.png" accent={t('whitepaper.parking.accent')} accentTone="ink">
          <P>{t('whitepaper.parking.p1')}</P>
          <P>{t('whitepaper.parking.p2')}</P>
          <HoloList>
            <HoloListRow label={t('whitepaper.parking.live')} value={<Addr address={SPARE.UsdgParkAdapter} />} hint="UsdgParkAdapter" />
            <HoloListRow label={t('whitepaper.parking.standby')} value={<Addr address={SPARE.SgovParkAdapter} />} hint="SgovParkAdapter" />
          </HoloList>
        </GlassCard>
      </DocSection>

      <DocSection id="units" label={t('whitepaper.nav.units')}>
        <GlassCard title={t('whitepaper.nav.units')} bar="lilac">
          <HoloList>
            <HoloListRow label="USDG" value={t('whitepaper.units.decimals', { n: 6 })} />
            <HoloListRow label={t('whitepaper.units.stockTokens')} value={t('whitepaper.units.decimals', { n: 18 })} hint={t('whitepaper.units.stockHint')} />
            <HoloListRow label={t('whitepaper.units.prices')} value={t('whitepaper.units.decimals', { n: 8 })} hint={t('whitepaper.units.priceHint')} />
            <HoloListRow label="bps" value="10,000 = 100%" />
          </HoloList>
        </GlassCard>
      </DocSection>

      {/* ── Economics ──────────────────────────────────────────── */}
      <DocSection id="fees" label={t('whitepaper.nav.fees')} kicker={t('whitepaper.nav.economics')}>
        <GlassCard title={t('whitepaper.nav.fees')} bar="holo">
          <P>{t('whitepaper.fees.body')}</P>
        </GlassCard>
        <FeesLive />
      </DocSection>

      <DocSection id="token" label="$SPARE">
        <GlassCard title="$SPARE" bar="pink" accent={t('whitepaper.token.accent')} accentTone="warn">
          <P>{t('whitepaper.token.body')}</P>
          <HoloList>
            <HoloListRow label={t('whitepaper.token.ca')} value={t('shell:common.soon')} hint={t('whitepaper.token.caHint')} />
          </HoloList>
        </GlassCard>
      </DocSection>

      {/* ── Closing ────────────────────────────────────────────── */}
      <DocSection id="privacy" label={t('whitepaper.nav.privacy')} kicker={t('whitepaper.nav.closing')}>
        <GlassCard title={t('whitepaper.privacy.title')} icon="/icons/spare/viewing-key.png" accent={t('whitepaper.privacy.accent')} accentTone="warn">
          <P>{t('whitepaper.privacy.body')}</P>
        </GlassCard>
      </DocSection>

      <DocSection id="roadmap" label={t('whitepaper.nav.roadmap')}>
        <Grid min={200}>
          {STAGES.map((s) => (
            <GlassCard key={s.title} title={s.q} accent={t(STAGE_LABEL[s.status])} accentTone={STAGE_TONE[s.status]} bar={s.status === 'LIVE' ? 'holo' : 'lilac'}>
              <H3>{t(s.title)}</H3>
              <HoloText size="sm">{t(s.line)}</HoloText>
            </GlassCard>
          ))}
        </Grid>
        <Ctas>
          <LinkButton to="/roadmap">{t('whitepaper.stages.cta')}</LinkButton>
        </Ctas>
      </DocSection>

      <DocSection id="boundaries" label={t('whitepaper.nav.boundaries')}>
        <GlassCard title={t('whitepaper.nav.boundaries')} bar="lilac">
          <Bullets items={BOUNDARIES.map((k) => t(k))} />
        </GlassCard>
      </DocSection>

      <DocSection id="disclaimers" label={t('whitepaper.nav.disclaimers')}>
        <GlassCard title={t('whitepaper.nav.disclaimers')} bar="pink">
          <P>{t('whitepaper.disclaimers.body')}</P>
        </GlassCard>
        <Ctas>
          <LinkButton to="/" variant="primary">
            {t('common.openSpare')}
          </LinkButton>
          <LinkButton to="/docs">{t('whitepaper.disclaimers.readDocs')}</LinkButton>
        </Ctas>
      </DocSection>
    </PublicShell>
  );
}
