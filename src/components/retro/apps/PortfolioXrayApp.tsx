/**
 * PORTFOLIO X-RAY — "What's in my wallet?"
 *
 * Reads the connected wallet's Robinhood Chain holdings straight from the
 * chain — every stock token in Spare's universe, USDG, ETH and WETH, plus the
 * spare change parked for it in Spare's CashPark — prices each position with
 * Chainlink (USDG at $1.00), and lays the book out: value, weights, the split
 * between stocks, cash and ETH, and how concentrated it is.
 *
 * Read-only: nothing is signed and nothing leaves the browser except the
 * public RPC reads. It describes the wallet; it never recommends anything.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, useBalance, useReadContract, useReadContracts } from 'wagmi';
import { erc20Abi, type Address } from 'viem';
import { useWindowManager } from '@/components/retro/WindowManager';
import { useIsMobile } from '@/hooks/use-mobile';
import { useEthUsd } from '@/hooks/useEthUsd';
import { getT, tKey, useTranslation } from '@/i18n';
import { cashParkAbi } from '@/lib/spare-chain/abis';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, STOCK_DECIMALS, USDG_DECIMALS, sameAddress } from '@/lib/spare-chain/addresses';
import { WETH } from '@/lib/spare-chain/fund-swap';
import { useSpareAccount } from '@/lib/spare-chain/hooks';
import { fmtUsd, useStockBoard } from '@/lib/stockBoard';
import { assetColor } from '@/lib/spare-chain/universe';
import {
  BEVEL_WELL,
  FONT_CHROME,
  FONT_PIXEL,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloLabel,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloProgress,
  HoloStar,
  HoloStat,
  HoloTable,
  HoloTitle,
  HoloWindowBody,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';
import { AddrLink, ConnectPrompt, Hint } from './spare/SpareUi';
import { HINT, ROW } from './spare/styles';

const chainId = SPARE_CHAIN_ID;
const tf = getT('apps-b');

type Kind = 'stock' | 'cash' | 'eth';

/** Holding kinds: a pastel swatch for the allocation bar + a meter tone for weight bars. `label` is an apps-b key. */
const KIND: Record<Kind, { fill: string; tone: HoloTone; label: string }> = {
  stock: { fill: HOLO.periwinkle, tone: 'holo', label: tKey('xray.kind.stocks') },
  cash: { fill: HOLO.goodFill, tone: 'good', label: tKey('xray.kind.cash') },
  eth: { fill: HOLO.lilac, tone: 'holo', label: tKey('xray.kind.eth') },
};

interface HoldingBase {
  key: string;
  symbol: string;
  name: string;
  kind: Kind;
  /** Display balance. */
  balance: number;
  /** USD value, or null when there is no price. */
  valueUsd: number | null;
  /** How the position is priced. */
  priceNote: string;
}

/** A priced position with its share of the wallet (HoloTable wants an index signature). */
type Holding = HoldingBase & { weightPct: number; [key: string]: unknown };

function toNumber(raw: bigint, decimals: number): number {
  const n = Number(raw) / 10 ** decimals;
  return Number.isFinite(n) ? n : 0;
}

/* ─────────────────────────────── local styles ─────────────────────────────── */

const COPY: CSSProperties = { fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.6, color: INK.body, margin: 0 };
const GRID2: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
  gap: 12,
  alignItems: 'start',
};
const CELL_SYMBOL: CSSProperties = { fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13.5, color: HOLO.ink, letterSpacing: 0.5 };
const CELL_SUB: CSSProperties = { fontFamily: FONT_TEXT, fontSize: 10, color: HOLO.inkMuted, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis' };
const KIND_CAPS: CSSProperties = { fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: HOLO.inkSoft };

/* ─────────────────────────────── pieces ─────────────────────────────── */

function Swatch({ fill, size = 10 }: { fill: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, flexShrink: 0, background: fill, boxShadow: `0 0 0 1px ${HOLO.ink}`, display: 'inline-block' }} />;
}

/** Poster numeral that scales with its own column, so a five-figure book still fits a 375px window. */
function BigNumber({ label, value, sub }: { label: ReactNode; value: string; sub?: ReactNode }) {
  return (
    <div style={{ containerType: 'inline-size', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <HoloLabel>{label}</HoloLabel>
      <HoloTitle as="div" size="lg" style={{ fontSize: 'clamp(18px, 7.5cqi, 34px)', textTransform: 'none', whiteSpace: 'nowrap', marginLeft: -3 }}>
        {value}
      </HoloTitle>
      {sub && <span style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.4, color: INK.muted }}>{sub}</span>}
    </div>
  );
}

interface AllocPart {
  key: string;
  /** An apps-b key (KIND[k].label). */
  label: string;
  pct: number;
  fill: string;
}

/** Stacked pixel bar of the book by kind, with a swatch legend. */
function AllocationBar({ parts, label: labelProp }: { parts: AllocPart[]; label?: string }) {
  const { t } = useTranslation('apps-b');
  const label = labelProp ?? t('xray.split');
  const total = parts.reduce((a, p) => a + p.pct, 0) || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <HoloLabel>{label}</HoloLabel>
      <div
        role="img"
        aria-label={t('xray.splitAria', { label, parts: parts.map((p) => `${t(p.label)} ${p.pct.toFixed(0)}%`).join(t('shared.listSep')) })}
        style={{ display: 'flex', height: 20, padding: 2, background: HOLO.paper, boxShadow: BEVEL_WELL }}
      >
        {parts.map((p, i) => (
          <div
            key={p.key}
            style={{
              width: `${(p.pct / total) * 100}%`,
              background: `repeating-linear-gradient(90deg, transparent 0 6px, rgba(255,253,251,.9) 6px 7px), ${p.fill}`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,.7)${i < parts.length - 1 ? `, inset -2px 0 0 ${HOLO.ink}` : ''}`,
            }}
          />
        ))}
      </div>
      <div style={{ ...ROW, gap: 12 }}>
        {parts.map((p) => (
          <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONT_TEXT, fontSize: 11, color: INK.body }}>
            <Swatch fill={p.fill} />
            <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: INK.soft }}>{t(p.label)}</span>
            <strong>{p.pct.toFixed(0)}%</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function WeightCell({ h }: { h: Holding }) {
  const { t } = useTranslation('apps-b');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <HoloProgress value={Math.min(100, h.weightPct)} segments={10} height={10} tone={KIND[h.kind].tone} ariaLabel={t('xray.weightAria', { symbol: h.symbol })} style={{ flex: 1 }} />
      <span style={{ fontWeight: 700, minWidth: 32, textAlign: 'right' }}>{h.weightPct.toFixed(0)}%</span>
    </div>
  );
}

/** A stock keeps its own colour (from its ticker, as everywhere in Spare); cash and ETH use the kind's. */
const fillOf = (h: Pick<Holding, 'kind' | 'symbol'>) => (h.kind === 'stock' ? assetColor(h.symbol) : KIND[h.kind].fill);

function holdingColumns(mobile: boolean): HoloColumn<Holding>[] {
  const balance = (h: Holding) => h.balance.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const value = (h: Holding) => <span style={{ fontWeight: 700 }}>{h.valueUsd == null ? '—' : fmtUsd(h.valueUsd)}</span>;
  if (mobile) {
    return [
      {
        key: 'symbol',
        label: tf('xray.cols.asset'),
        render: (h) => (
          <div title={h.name} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <Swatch fill={fillOf(h)} />
            <div style={{ minWidth: 0, lineHeight: 1.25 }}>
              <div style={CELL_SYMBOL}>{h.symbol}</div>
              <div style={CELL_SUB}>{balance(h)}</div>
            </div>
          </div>
        ),
      },
      { key: 'value', label: tf('xray.cols.value'), align: 'right', render: value },
      { key: 'weight', label: tf('xray.cols.weight'), width: 44, align: 'right', render: (h) => <span style={{ fontWeight: 700 }}>{h.weightPct.toFixed(0)}%</span> },
    ];
  }
  return [
    {
      key: 'symbol',
      label: tf('xray.cols.asset'),
      width: 'minmax(96px, 1fr)',
      render: (h) => (
        <span title={h.priceNote} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Swatch fill={fillOf(h)} />
          <span style={{ lineHeight: 1.25 }}>
            <span style={CELL_SYMBOL}>{h.symbol}</span>
            <span style={{ ...CELL_SUB, display: 'block' }}>{h.name}</span>
          </span>
        </span>
      ),
    },
    { key: 'kind', label: tf('xray.cols.kind'), width: 66, render: (h) => <span style={KIND_CAPS}>{tf(KIND[h.kind].label)}</span> },
    { key: 'balance', label: tf('xray.cols.balance'), align: 'right', render: (h) => <span style={{ color: HOLO.inkMuted }}>{balance(h)}</span> },
    { key: 'value', label: tf('xray.cols.value'), align: 'right', render: value },
    { key: 'weight', label: tf('xray.cols.weight'), width: 150, render: (h) => <WeightCell h={h} /> },
  ];
}

/** Numbered pixel coin for the how-it-works steps. */
function StepCoin({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: GRADIENT.chrome,
        boxShadow: `0 0 0 2px ${HOLO.ink}, inset -2px -2px 0 rgba(42,27,110,.25), inset 2px 2px 0 #FFFFFF, 2px 2px 0 2px rgba(42,27,110,.2)`,
      }}
    >
      <HoloTitle as="span" size="xs" fill="ink" style={{ lineHeight: 1 }}>
        {n}
      </HoloTitle>
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <StepCoin n={n} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 19, lineHeight: 1.05, color: INK.body }}>{title}</span>
        <span style={{ fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.5, color: INK.muted }}>{children}</span>
      </div>
    </div>
  );
}

/*
 * Illustration for the disconnected state — clearly labelled EXAMPLE, never
 * shown as the user's data. Stocks are placeholders ("Stock A"), not tickers,
 * so the example never reads as a pick; `symbol` is an apps-b key for them.
 */
const SAMPLE: Array<{ symbol: string; kind: Kind; weight: number; key?: boolean }> = [
  { symbol: tKey('shared.stockA'), kind: 'stock', weight: 42, key: true },
  { symbol: tKey('shared.stockB'), kind: 'stock', weight: 26, key: true },
  { symbol: 'USDG', kind: 'cash', weight: 22 },
  { symbol: 'ETH', kind: 'eth', weight: 10 },
];
const SAMPLE_PARTS: AllocPart[] = [
  { key: 'stock', label: KIND.stock.label, pct: 68, fill: KIND.stock.fill },
  { key: 'cash', label: KIND.cash.label, pct: 22, fill: KIND.cash.fill },
  { key: 'eth', label: KIND.eth.label, pct: 10, fill: KIND.eth.fill },
];

function ExampleBook() {
  const { t } = useTranslation('apps-b');
  return (
    <HoloCard title={t('xray.holdings.title')} accent={t('shell:common.example')} accentTone="warn">
      <Hint>{t('xray.example.note')}</Hint>
      <AllocationBar parts={SAMPLE_PARTS} />
      <HoloList>
        {SAMPLE.map((s) => (
          <HoloListRow key={s.symbol} icon={<Swatch fill={KIND[s.kind].fill} size={12} />} label={s.key ? t(s.symbol) : s.symbol} hint={t(KIND[s.kind].label)} value={`${s.weight}%`} />
        ))}
      </HoloList>
    </HoloCard>
  );
}

function HowItWorks() {
  const { t } = useTranslation('apps-b');
  return (
    <HoloCard title={t('xray.how.title')} bar="lilac">
      <Step n={1} title={t('xray.how.connect')}>{t('xray.how.connectBody')}</Step>
      <Step n={2} title={t('xray.how.read')}>{t('xray.how.readBody')}</Step>
      <Step n={3} title={t('xray.how.price')}>{t('xray.how.priceBody')}</Step>
      <Hint>{t('xray.how.hint')}</Hint>
    </HoloCard>
  );
}

/* ─────────────────────────────── the book ─────────────────────────────── */

function useBook(me: Address | undefined) {
  const { t } = useTranslation('apps-b');
  const board = useStockBoard({ enabled: !!me });
  const eth = useEthUsd();
  const { account, isSpendingWallet } = useSpareAccount();
  const ownAccount = !!me && !!account && sameAddress(account, me) && !isSpendingWallet;

  const native = useBalance({ address: me, chainId, query: { enabled: !!me, refetchInterval: 60_000 } });
  const stocks = board.rows;
  // Every ERC-20 balance in one multicall: USDG, WETH, then each stock token.
  const tokens: Address[] = me ? [EXTERNAL.USDG, WETH, ...stocks.map((s) => s.token)] : [];
  const reads = useReadContracts({
    allowFailure: true,
    contracts: tokens.map((tok) => ({ address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [me as Address], chainId }) as const),
    query: { enabled: !!me, refetchInterval: 60_000 },
  });
  const parkQ = useReadContract({
    address: SPARE.CashPark,
    abi: cashParkAbi,
    functionName: 'valueOf',
    args: [me as Address],
    chainId,
    query: { enabled: ownAccount, refetchInterval: 60_000 },
  });

  const holdings: HoldingBase[] = [];
  const usdg = reads.data?.[0]?.result as bigint | undefined;
  const weth = reads.data?.[1]?.result as bigint | undefined;
  const parked = parkQ.data as bigint | undefined;

  stocks.forEach((s, i) => {
    const raw = reads.data?.[2 + i]?.result as bigint | undefined;
    if (!raw || raw === 0n) return;
    const bal = toNumber(raw, STOCK_DECIMALS);
    holdings.push({
      key: s.token,
      symbol: s.symbol,
      name: s.name ?? s.symbol,
      kind: 'stock',
      balance: bal,
      valueUsd: s.price != null ? bal * s.price : null,
      priceNote: s.price == null ? t('xray.priceNote.none') : s.priceIsLive ? t('xray.priceNote.live') : t('xray.priceNote.lastClose'),
    });
  });
  if (usdg && usdg > 0n) {
    const bal = toNumber(usdg, USDG_DECIMALS);
    holdings.push({ key: 'usdg', symbol: 'USDG', name: 'Global Dollar', kind: 'cash', balance: bal, valueUsd: bal, priceNote: t('xray.priceNote.usd') });
  }
  if (ownAccount && parked && parked > 0n) {
    const bal = toNumber(parked, USDG_DECIMALS);
    holdings.push({ key: 'parked', symbol: t('xray.parked.symbol'), name: t('xray.parked.name'), kind: 'cash', balance: bal, valueUsd: bal, priceNote: 'CashPark.valueOf, USDG' });
  }
  if (native.data && native.data.value > 0n) {
    const bal = toNumber(native.data.value, 18);
    holdings.push({ key: 'eth', symbol: 'ETH', name: t('xray.etherGas'), kind: 'eth', balance: bal, valueUsd: eth.price != null ? bal * eth.price : null, priceNote: 'Chainlink ETH/USD' });
  }
  if (weth && weth > 0n) {
    const bal = toNumber(weth, 18);
    holdings.push({ key: 'weth', symbol: 'WETH', name: 'Wrapped Ether', kind: 'eth', balance: bal, valueUsd: eth.price != null ? bal * eth.price : null, priceNote: 'Chainlink ETH/USD' });
  }

  const total = holdings.reduce((a, h) => a + (h.valueUsd ?? 0), 0);
  const withWeights: Holding[] = holdings
    .map((h) => ({ ...h, weightPct: total > 0 && h.valueUsd != null ? (h.valueUsd / total) * 100 : 0 }))
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const loading = reads.isLoading || native.isLoading || (stocks.length === 0 && board.isLoading);
  const error = (reads.error as Error | null) ?? (board.rows.length === 0 ? board.error : null);
  return {
    holdings: withWeights,
    total,
    priced: withWeights.filter((h) => h.valueUsd != null).length,
    loading,
    error,
    ownAccount,
    isSpendingWallet,
    fetching: reads.isFetching || native.isFetching,
    refetch: () => {
      board.refetch();
      void reads.refetch();
      void native.refetch();
      if (ownAccount) void parkQ.refetch();
    },
  };
}

/* ─────────────────────────────── app ─────────────────────────────── */

export function PortfolioXrayApp() {
  const { t } = useTranslation('apps-b');
  const { address, isConnected } = useAccount();
  const me = isConnected ? (address as Address | undefined) : undefined;
  const wm = useWindowManager();
  const mobile = useIsMobile();
  const book = useBook(me);
  const [showAll, setShowAll] = useState(false);

  const connected = !!me;
  const status: { label: string; tone: HoloTone } = !connected
    ? { label: t('xray.status.noWallet'), tone: 'warn' }
    : book.loading
    ? { label: t('shared.reading'), tone: 'warn' }
    : book.error
    ? { label: t('shared.unavailable'), tone: 'bad' }
    : { label: t('shell:common.liveData'), tone: 'good' };

  const holdings = book.holdings;
  const top = holdings[0] && holdings[0].valueUsd != null ? holdings[0] : null;
  const byKind = new Map<Kind, number>();
  for (const h of holdings) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + h.weightPct);
  const parts: AllocPart[] = [...byKind]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, w]) => ({ key: k, label: KIND[k].label, pct: w, fill: KIND[k].fill }));
  const stockPct = byKind.get('stock') ?? 0;
  const stockCount = holdings.filter((h) => h.kind === 'stock').length;
  const visible = showAll || holdings.length <= 8 ? holdings : holdings.slice(0, 8);

  return (
    <HoloWindowBody>
      <HoloHero
        art="/icons/spare/portfolio-xray.png"
        kicker={t('xray.hero.kicker')}
        title={t('shell:appNames.portfolio-xray')}
        subtitle={t('xray.hero.subtitle')}
        description={t('xray.hero.description')}
        seed={51}
      >
        <div style={{ ...ROW, marginTop: 2 }}>
          <HoloBadge label={status.label} tone={status.tone} pulse={connected && book.loading} size="md" />
          <HoloBadge label={t('xray.hero.readOnly')} variant="solid" size="md" />
        </div>
      </HoloHero>

      {!connected ? (
        <>
          <ConnectPrompt why={t('xray.connectWhy')} />
          <div style={GRID2}>
            <ExampleBook />
            <HowItWorks />
          </div>
        </>
      ) : (
        <>
          <HoloCard
            title={t('shell:common.wallet')}
            accent={book.loading ? t('shared.reading') : t('shell:common.liveData')}
            accentTone={book.loading ? 'warn' : 'good'}
          >
            <div style={{ ...ROW, gap: 12, justifyContent: 'space-between' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <HoloLabel>{t('xray.wallet.reading')}</HoloLabel>
                <div style={{ ...ROW, gap: 6 }}>
                  <AddrLink address={me!} />
                  <span style={HINT}>{t('xray.wallet.hint')}</span>
                </div>
              </div>
              <HoloButton onClick={book.refetch} disabled={book.fetching}>
                {book.fetching ? t('shell:common.reading') : t('xray.wallet.rescan')}
              </HoloButton>
            </div>
            {book.loading && <HoloProgress indeterminate height={12} segments={24} label={t('xray.wallet.progress')} />}
            {book.isSpendingWallet && <Hint>{t('xray.wallet.spending')}</Hint>}
          </HoloCard>

          {book.error && !book.loading && (
            <HoloNotice
              tone="error"
              live="alert"
              title={t('xray.readFail.title')}
              action={
                <HoloButton size="sm" onClick={book.refetch}>
                  {t('shell:common.retry')}
                </HoloButton>
              }
            >
              {t('xray.readFail.body')}
            </HoloNotice>
          )}

          {!book.loading && !book.error && holdings.length === 0 && (
            <HoloCard title={t('xray.empty.title')} accent={t('xray.empty.accent')} accentTone="muted">
              <div style={{ ...ROW, gap: 14, alignItems: 'center' }}>
                <HoloStar size={52} />
                <p style={{ ...COPY, flex: '1 1 220px', minWidth: 0 }}>{t('xray.empty.body')}</p>
              </div>
              <div style={ROW}>
                <HoloButton variant="primary" onClick={() => wm.openApp('fund-wallet')}>
                  {t('xray.empty.open')}
                </HoloButton>
              </div>
            </HoloCard>
          )}

          {holdings.length > 0 && (
            <>
              <HoloCard
                title={t('xray.holdings.title')}
                accent={t('xray.holdings.accent', { total: fmtUsd(book.total), priced: book.priced, count: holdings.length })}
                accentTone="good"
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, alignItems: 'end' }}>
                  <BigNumber
                    label={t('xray.holdings.value')}
                    value={fmtUsd(book.total)}
                    sub={t('xray.holdings.valueSub', { priced: book.priced, count: holdings.length })}
                  />
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                    <HoloStat label={t('xray.holdings.positions')} value={String(holdings.length)} size="md" />
                    {top && <HoloStat label={t('xray.holdings.largest')} value={`${top.symbol} ${top.weightPct.toFixed(0)}%`} size="md" />}
                  </div>
                </div>
                {parts.length > 0 && <AllocationBar parts={parts} />}
                <HoloTable<Holding>
                  columns={holdingColumns(mobile)}
                  rows={visible}
                  rowKey={(h) => h.key}
                  minWidth={mobile ? undefined : 560}
                  maxHeight={320}
                  ariaLabel={t('xray.holdings.aria')}
                />
                {holdings.length > 8 && (
                  <HoloButton size="sm" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? t('xray.holdings.showFewer') : t('xray.holdings.showAll', { count: holdings.length })}
                  </HoloButton>
                )}
              </HoloCard>

              <div style={GRID2}>
                <HoloCard title={t('xray.ray.title')} bar="ink" tone="screen">
                  <HoloList>
                    <HoloListRow
                      label={t('xray.ray.inStocks')}
                      value={`${stockPct.toFixed(0)}%`}
                      hint={stockCount === 1 ? t('xray.ray.stockTokenOne', { count: stockCount }) : t('xray.ray.stockTokenMany', { count: stockCount })}
                    />
                    <HoloListRow label={t('xray.ray.inCash')} value={`${(byKind.get('cash') ?? 0).toFixed(0)}%`} hint={t('xray.ray.inCashHint')} />
                    <HoloListRow label={t('xray.ray.inEth')} value={`${(byKind.get('eth') ?? 0).toFixed(0)}%`} hint={t('xray.ray.inEthHint')} />
                    {top && (
                      <HoloListRow label={t('xray.holdings.largest')} value={`${top.symbol} · ${top.weightPct.toFixed(0)}%`} hint={t('xray.ray.largestHint')} />
                    )}
                  </HoloList>
                </HoloCard>
                <HoloCard title={t('xray.next.title')} bar="lilac">
                  <p style={COPY}>{t('xray.next.body')}</p>
                  <div style={ROW}>
                    <HoloButton size="sm" onClick={() => wm.openApp('stock-mix')}>
                      {t('shell:appNames.stock-mix')}
                    </HoloButton>
                    <HoloButton size="sm" onClick={() => wm.openApp('spare-balance')}>
                      {t('shell:appNames.spare-balance')}
                    </HoloButton>
                  </div>
                </HoloCard>
              </div>

              <Hint>{t('xray.footer')}</Hint>
            </>
          )}
        </>
      )}
    </HoloWindowBody>
  );
}

export default PortfolioXrayApp;
