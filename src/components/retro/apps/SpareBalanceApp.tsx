/**
 * SpareBalanceApp — the money view, entirely from Robinhood Chain.
 *
 *   CashPark        pending(account)  accrued USDG not yet parked
 *                   units(account)    parked units in the live adapter
 *                   valueOf(account)  both, in USDG at current NAV
 *                   exit()            withdraw everything — never paused (but the single
 *                                     owner key can still redirect parked spare first)
 *   Stock holdings  balanceOf(account) for every registry asset, valued with
 *                   StockRouter.oracleStatus (or the feed's last answer when
 *                   the market is closed, labelled as such)
 *   SweepExecutor   claimable(account, token) + claim(token) for deliveries a
 *                   token refused to push
 *
 * A connected spending wallet sees the account it feeds (park, holdings,
 * claimables are all the account's), read-only: exit() and claim() pay
 * msg.sender, so only the account itself can use them.
 *
 * Presentation: Spare Holo, with a "$3.75 … $0.25" round-up example.
 * Without a wallet the window shows a clearly-labelled example, never numbers.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { erc20Abi, parseAbi, type Address } from 'viem';
import { cashParkAbi, sweepExecutorAbi } from '@/lib/spare-chain/abis';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, STOCK_DECIMALS, USDG_DECIMALS, sameAddress, shortAddr, symbolOf } from '@/lib/spare-chain/addresses';
import { humanizeError } from '@/lib/spare-chain/errors';
import { oracleView, txStep, useSpareDeployment, useSpareTx, useUniverse, type UniverseAsset } from '@/lib/spare-chain/hooks';
import { ROUND_TO_VALUES, formatFixed, formatToken, formatUsd, pctOf, roundUpDelta, tokensValueUsdg, type RoundTo } from '@/lib/spare';
import { WalletPicker } from '@/components/retro/WalletPicker';
import { tKey, useTranslation } from '@/i18n';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  BEVEL_WELL, FONT_TEXT, GRADIENT, HOLO, INK, TEXTURE, pixelPath,
  HoloBadge, HoloButton, HoloCard, HoloHero, HoloLabel, HoloNotice, HoloSegmented, HoloStar, HoloStat, HoloTable,
  HoloText, HoloTitle,
  type HoloColumn,
} from '@/components/retro/holo';
import { AppCanvas, ChainNote, DeployingNotice, MutedWell, SpareGate, TxStatus, WithSpareAccount } from './spare/SpareUi';
import { HINT, ROW } from './spare/styles';

const chainId = SPARE_CHAIN_ID;

/** IParkAdapter.underlying(): the token a non-USDG park adapter holds. */
const PARK_UNDERLYING_ABI = parseAbi(['function underlying() view returns (address)']);

/** Two cards side by side on a wide window, stacked at phone width. Both cards fill the row height. */
const PAIR: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(270px, 100%), 1fr))',
  gap: 12,
  alignItems: 'stretch',
};
/** Card body that grows with a stretched PAIR row, so the frame and dither drift reach the bottom. */
const FILL_BODY: CSSProperties = { flex: 1 };

type HoldingRow = {
  token: Address;
  symbol: string;
  note?: string;
  balance: bigint;
  decimals: number;
  price: bigint | null;
  priceIsLast: boolean;
  value: bigint | null;
  status: number | null;
} & Record<string, unknown>;

export function SpareBalanceApp() {
  const { t } = useTranslation('apps-b');
  const isMobile = useIsMobile();
  const { isConnected } = useAccount();
  return (
    <AppCanvas>
      <HoloHero
        art="/icons/spare/spare-balance.png"
        kicker={t('spareBalance.hero.kicker')}
        title={t('shell:appNames.spare-balance')}
        subtitle={t('spareBalance.hero.subtitle')}
        description={t('spareBalance.hero.description')}
        // i18n-ignore: the chain's name is never translated
        aside={<HoloBadge label="ROBINHOOD CHAIN" variant="solid" />}
        compact={isMobile}
        size="lg"
        seed={21}
      />
      {isConnected ? (
        <SpareGate>
          <WithSpareAccount what={t('spareBalance.what')}>
            {(v) => (v.account ? <BalanceBody account={v.account} readOnly={v.isSpendingWallet} /> : <BalancePreview />)}
          </WithSpareAccount>
        </SpareGate>
      ) : (
        <BalancePreview />
      )}
    </AppCanvas>
  );
}

function priceFor(a: UniverseAsset): { price: bigint | null; last: boolean } {
  if (a.status === 0 && a.price1e18 > 0n) return { price: a.price1e18, last: false };
  if (a.lastPrice1e18) return { price: a.lastPrice1e18, last: true };
  return { price: null, last: false };
}

/* ─────────────────────────────── small pieces ─────────────────────────────── */

/** Pixel arrow (→) for the round-up receipt. */
const ARROW_PATH = pixelPath(['0001000', '0001100', '1111110', '1111111', '1111110', '0001100', '0001000']);
function PixelArrow({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden focusable="false" width={size} height={size} viewBox="0 0 7 7" shapeRendering="crispEdges" style={{ display: 'block', flexShrink: 0 }}>
      <path d={ARROW_PATH} fill={HOLO.inkSoft} />
    </svg>
  );
}

/** Chrome coin with a number (① ② ③). */
function StepCoin({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: 24,
        height: 24,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: GRADIENT.chrome,
        boxShadow: `0 0 0 2px ${HOLO.ink}, inset 0 0 0 1px #FFFFFF, 2px 2px 0 2px rgba(42,27,110,.18)`,
        fontFamily: FONT_TEXT,
        fontWeight: 700,
        fontSize: 12,
        color: HOLO.ink,
      }}
    >
      {n}
    </span>
  );
}

/** Two-or-more-part pixel bar (pending vs parked) with a legend. */
function SplitBar({ parts, label }: { parts: { key: string; value: bigint; fill: string; name: string }[]; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0n);
  const shown = parts.filter((p) => p.value > 0n);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div role="img" aria-label={label} style={{ display: 'flex', height: 16, padding: 2, background: HOLO.paper, boxShadow: BEVEL_WELL, overflow: 'hidden' }}>
        {shown.map((p, i) => (
          <span
            key={p.key}
            title={p.name}
            style={{
              width: `${pctOf(p.value, total)}%`,
              height: '100%',
              flexShrink: 0,
              background: `linear-gradient(180deg, rgba(255,255,255,.7) 0 3px, transparent 3px), ${TEXTURE.dither} 0 0 / 4px 4px, ${p.fill}`,
              boxShadow: i < shown.length - 1 ? `inset -2px 0 0 0 ${HOLO.ink}` : undefined,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {parts.map((p) => (
          <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONT_TEXT, fontSize: 11.5, color: INK.soft }}>
            <span aria-hidden style={{ width: 10, height: 10, background: p.fill, boxShadow: `0 0 0 1px ${HOLO.ink}` }} />
            {p.name}
          </span>
        ))}
      </div>
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

/* ─────────────────────────── no wallet: the example ─────────────────────────── */

const EXAMPLE_PAID = 3_750_000n; // a $3.75 coffee

/** The three "what happens next" steps (apps-b keys). */
const EXAMPLE_STEPS = [
  tKey('spareBalance.example.steps.park'),
  tKey('spareBalance.example.steps.sweep'),
  tKey('spareBalance.example.steps.land'),
] as const;

function BalancePreview() {
  const { t } = useTranslation('apps-b');
  const { deployed, checking, error } = useSpareDeployment();
  const [roundTo, setRoundTo] = useState<RoundTo>(1);
  // Same arithmetic as RoundUp.sol (1× multiplier).
  const spare = roundUpDelta(EXAMPLE_PAID, roundTo, 1);
  return (
    <>
      <div style={PAIR}>
        <HoloCard
          title={t('spareBalance.example.title')}
          icon="/icons/spare/spare-balance.png"
          accent={t('shell:common.example')}
          accentTone="ink"
          bodyStyle={FILL_BODY}
        >
          <HoloText size="sm" tone="muted">{t('spareBalance.example.note')}</HoloText>
          <div style={{ ...ROW, gap: 10 }}>
            <HoloLabel>{t('spareBalance.example.roundUpTo')}</HoloLabel>
            <HoloSegmented
              value={roundTo}
              onChange={setRoundTo}
              options={ROUND_TO_VALUES}
              format={(v) => `$${v}`}
              size="sm"
              ariaLabel={t('spareBalance.example.aria')}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', padding: '10px 12px', background: HOLO.paper, boxShadow: BEVEL_WELL }}>
            <HoloStat label={t('spareBalance.example.coffee')} value={formatUsd(EXAMPLE_PAID)} size="md" />
            <PixelArrow />
            <HoloStat label={t('spareBalance.example.roundsTo')} value={formatUsd(EXAMPLE_PAID + spare)} size="md" />
            <PixelArrow />
            <HoloStat label={t('spareBalance.example.spare')} value={`+${formatUsd(spare)}`} size="lg" tone="good" />
          </div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {EXAMPLE_STEPS.map((step, i) => (
              <li key={step} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StepCoin n={i + 1} />
                <HoloText size="sm">{t(step)}</HoloText>
              </li>
            ))}
          </ol>
        </HoloCard>
        <ConnectCard why={t('spareBalance.connectWhy')} />
      </div>
      {!deployed && !checking && <DeployingNotice checking={false} error={error} />}
    </>
  );
}

/* ─────────────────────────────── with a wallet ─────────────────────────────── */

function BalanceBody({ account, readOnly }: { account: Address; readOnly: boolean }) {
  const { t } = useTranslation('apps-b');
  const me = account;
  const exitTx = useSpareTx();
  const claimTx = useSpareTx();
  const [confirmExit, setConfirmExit] = useState(false);
  const { assets, isLoading: uniLoading } = useUniverse({ enabled: true, withFeedPrices: true });

  const park = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'pending', args: [me], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'units', args: [me], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'valueOf', args: [me], chainId },
      { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'adapter', chainId },
      { address: EXTERNAL.USDG, abi: erc20Abi, functionName: 'balanceOf', args: [me], chainId },
    ],
    query: { enabled: !!me, refetchInterval: 30_000 },
  });

  // Holdings + claimables for every registry asset, plus USDG claimables.
  const claimTokens: Address[] = [EXTERNAL.USDG, ...assets.map((a) => a.token)];
  const per = useReadContracts({
    allowFailure: true,
    contracts: [
      ...assets.map((a) => ({ address: a.token, abi: erc20Abi, functionName: 'balanceOf', args: [me], chainId }) as const),
      ...claimTokens.map((tok) => ({ address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'claimable', args: [me, tok], chainId }) as const),
    ],
    query: { enabled: !!me && assets.length > 0, refetchInterval: 30_000 },
  });

  const pending = park.data?.[0] ?? 0n;
  const units = park.data?.[1] ?? 0n;
  const value = park.data?.[2] ?? 0n;
  const adapter = park.data?.[3] as Address | undefined;
  const walletUsdg = park.data?.[4] ?? 0n;
  const parkedValue = value > pending ? value - pending : 0n;
  const isSgov = !!adapter && sameAddress(adapter, SPARE.SgovParkAdapter);
  // What a token-holding adapter parks in (IParkAdapter.underlying), named from the registry read.
  const underlyingQ = useReadContract({
    address: adapter,
    abi: PARK_UNDERLYING_ABI,
    functionName: 'underlying',
    chainId,
    query: { enabled: isSgov, staleTime: Infinity },
  });
  const parkLabel = !adapter
    ? '—'
    : sameAddress(adapter, SPARE.UsdgParkAdapter)
    ? t('spareBalance.park.usdg')
    : isSgov
    ? t('spareBalance.park.sgov')
    : t('shared.customAdapter');
  // Units are whatever the adapter holds: USDG itself (6 dp) or the adapter's stock token (18 dp).
  const unitsLabel = isSgov
    ? `${formatToken(units, STOCK_DECIMALS, 6)} ${underlyingQ.data ? symbolOf(underlyingQ.data as Address) : ''}`.trim()
    : t('spareBalance.park.units', { amount: formatToken(units, USDG_DECIMALS, 6) });

  const holdings: HoldingRow[] = assets.map((a, i) => {
    const bal = (per.data?.[i]?.result as bigint | undefined) ?? 0n;
    const { price, last } = priceFor(a);
    return {
      token: a.token, symbol: a.symbol, note: a.name ?? undefined, balance: bal, decimals: STOCK_DECIMALS,
      price, priceIsLast: last, value: price != null ? tokensValueUsdg(bal, price) : null, status: a.status,
    };
  });
  const held = holdings.filter((h) => h.balance > 0n);
  const heldValue = held.reduce((s, h) => s + (h.value ?? 0n), 0n);
  const unpriced = held.filter((h) => h.value == null).length;

  const claimables = claimTokens
    .map((tok, j) => ({ token: tok, amount: (per.data?.[assets.length + j]?.result as bigint | undefined) ?? 0n }))
    .filter((c) => c.amount > 0n);

  const exit = () => {
    setConfirmExit(false);
    exitTx.run([txStep(t('spareBalance.tx.exit'), { address: SPARE.CashPark, abi: cashParkAbi, functionName: 'exit' })]);
  };
  const claim = (token: Address) =>
    claimTx.run([
      txStep(t('spareBalance.tx.claim', { sym: symbolOf(token) }), { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'claim', args: [token] }),
    ]);

  const cols: HoloColumn<HoldingRow>[] = [
    {
      key: 'symbol', label: t('spareBalance.cols.asset'), width: 'minmax(120px, 1.4fr)',
      render: (h) => (
        <span title={h.token}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{h.symbol}</span>
          {h.note ? <span style={{ color: INK.muted, fontSize: 11 }}> · {h.note}</span> : null}
        </span>
      ),
    },
    { key: 'balance', label: t('spareBalance.cols.tokens'), align: 'right', render: (h) => formatToken(h.balance, h.decimals, 6) },
    {
      key: 'price', label: t('spareBalance.cols.price'), width: 140, align: 'right',
      render: (h) => h.price == null ? <span style={{ color: INK.muted }}>—</span> : (
        <span title={h.priceIsLast ? oracleView(h.status).detail : t('spareBalance.liveOracle')} style={{ color: h.priceIsLast ? INK.muted : INK.body }}>
          {h.priceIsLast ? t('spareBalance.priceLast', { price: `$${formatFixed(h.price, 18, 2)}` }) : `$${formatFixed(h.price, 18, 2)}`}
        </span>
      ),
    },
    { key: 'value', label: t('spareBalance.cols.value'), width: 110, align: 'right', render: (h) => (h.value == null ? <span style={{ color: INK.muted }}>—</span> : <strong>{formatUsd(h.value)}</strong>) },
  ];

  const exitCopy = readOnly
    ? t('spareBalance.exit.readOnly', { account: shortAddr(me) })
    : confirmExit
    ? t('spareBalance.exit.confirm', { pending: formatUsd(pending) })
    : t('spareBalance.exit.info');

  return (
    <>
      <ChainNote />
      {park.error && <HoloNotice tone="error" compact title={t('spareBalance.park.readFail')}>{humanizeError(park.error)}</HoloNotice>}

      {/* ─── Parked spare ─── */}
      <HoloCard title={t('spareBalance.park.title')} icon="/icons/spare/spare-balance.png" accent={parkLabel} accentTone="info">
        {park.isLoading ? (
          <MutedWell center>{t('spareBalance.park.reading')}</MutedWell>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '14px 30px' }}>
              <HoloStat label={t('spareBalance.park.total')} value={formatUsd(value)} size="xl" sub="valueOf(account)" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 26px' }}>
                <HoloStat label={t('spareBalance.park.pending')} value={formatUsd(pending)} size="md" sub={t('spareBalance.park.pendingSub')} />
                <HoloStat label={t('spareBalance.park.parked')} value={formatUsd(parkedValue)} size="md" sub={unitsLabel} />
              </div>
            </div>
            {value > 0n && (
              <SplitBar
                label={t('spareBalance.park.splitAria', { pending: formatUsd(pending), parked: formatUsd(parkedValue) })}
                parts={[
                  { key: 'pending', value: pending, fill: HOLO.pink, name: t('spareBalance.park.splitPending', { amount: formatUsd(pending) }) },
                  { key: 'parked', value: parkedValue, fill: HOLO.lilac, name: t('spareBalance.park.splitParked', { amount: formatUsd(parkedValue) }) },
                ]}
              />
            )}
          </>
        )}
        <div style={ROW}>
          {confirmExit ? (
            <>
              <HoloButton variant="primary" disabled={exitTx.busy} onClick={exit}>{t('spareBalance.exit.confirmBtn')}</HoloButton>
              <HoloButton onClick={() => setConfirmExit(false)}>{t('shell:common.cancel')}</HoloButton>
            </>
          ) : (
            <HoloButton disabled={readOnly || exitTx.busy || (value === 0n && units === 0n)} onClick={() => setConfirmExit(true)}>
              {t('spareBalance.exit.btn')}
            </HoloButton>
          )}
        </div>
        <HoloNotice tone={confirmExit ? 'warn' : 'info'} compact live={confirmExit ? 'status' : 'none'}>{exitCopy}</HoloNotice>
        <TxStatus state={exitTx.state} onDismiss={exitTx.reset} />
      </HoloCard>

      {/* ─── Stocks in the wallet ─── */}
      <HoloCard
        title={t('spareBalance.holdings.title')}
        icon="/icons/spare/stock-mix.png"
        accent={
          held.length
            ? unpriced
              ? t('spareBalance.holdings.accentUnpriced', { value: formatUsd(heldValue), count: unpriced })
              : formatUsd(heldValue)
            : t('spareBalance.holdings.none')
        }
        accentTone={held.length ? 'good' : 'muted'}
      >
        {uniLoading && assets.length === 0 ? (
          <MutedWell>{t('spareBalance.holdings.readingRegistry')}</MutedWell>
        ) : held.length === 0 ? (
          <MutedWell>
            {readOnly ? t('spareBalance.holdings.emptyAccount', { account: shortAddr(me) }) : t('spareBalance.holdings.emptyWallet')}
          </MutedWell>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '10px 28px' }}>
              <HoloStat
                label={t('spareBalance.holdings.value')}
                value={formatUsd(heldValue)}
                size="lg"
                sub={unpriced ? t('spareBalance.holdings.unpricedSub', { count: unpriced }) : undefined}
              />
              <HoloStat label={t('spareBalance.holdings.positions')} value={String(held.length)} size="md" style={{ paddingBottom: 4 }} />
            </div>
            <HoloTable columns={cols} rows={held} rowKey={(h) => h.token} minWidth={460} ariaLabel={t('spareBalance.holdings.aria')} />
          </>
        )}
        <span style={HINT}>
          {readOnly
            ? t('spareBalance.holdings.hintAccount', { account: shortAddr(me), usdg: formatUsd(walletUsdg) })
            : t('spareBalance.holdings.hintWallet', { usdg: formatUsd(walletUsdg) })}
        </span>
      </HoloCard>

      {/* ─── Claimable deliveries ─── */}
      <HoloCard
        title={t('spareBalance.claim.title')}
        accent={claimables.length ? t('spareBalance.claim.waiting', { count: claimables.length }) : t('spareBalance.claim.nothing')}
        accentTone={claimables.length ? 'warn' : 'muted'}
        bar={claimables.length ? 'pink' : 'lilac'}
      >
        {claimables.length === 0 ? (
          <MutedWell>{t('spareBalance.claim.empty')}</MutedWell>
        ) : (
          <>
            <div className="holo-list" role="list" aria-label={t('spareBalance.claim.aria')}>
              {claimables.map((c) => (
                <div key={c.token} role="listitem" className="holo-list__row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '6px 12px' }}>
                  <HoloBadge label={symbolOf(c.token)} tone="warn" variant="fill" size="md" />
                  <span style={{ flex: '1 1 auto', fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 16, color: INK.body }}>
                    {sameAddress(c.token, EXTERNAL.USDG) ? formatUsd(c.amount, 6) : formatToken(c.amount, STOCK_DECIMALS, 6)}
                  </span>
                  <HoloButton variant="primary" size="sm" disabled={readOnly || claimTx.busy} onClick={() => claim(c.token)}>
                    {t('spareBalance.claim.btn')}
                  </HoloButton>
                </div>
              ))}
            </div>
            <span style={HINT}>
              {readOnly ? t('spareBalance.claim.readOnly', { account: shortAddr(me) }) : t('spareBalance.claim.own')}
            </span>
          </>
        )}
        <TxStatus state={claimTx.state} onDismiss={claimTx.reset} />
      </HoloCard>
    </>
  );
}

export default SpareBalanceApp;
