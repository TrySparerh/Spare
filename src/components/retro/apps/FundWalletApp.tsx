/**
 * FundWalletApp — from an empty wallet to ready-to-round-up, on Robinhood Chain.
 *
 *   1. READINESS   ETH for gas (and how many SPARE transactions it pays for at the live
 *                  gas price), USDG balance, RuleRegistry.accountOf (linked), the Permit2
 *                  pull consent to SweepExecutor, and RuleRegistry.ruleOf (rule on) —
 *                  each with a button into the app that fixes it.
 *   2. RECEIVE     this wallet's address + copy. No QR: no QR library is a dependency.
 *   3. BRIDGE/BUY  the official on-ramps and bridges, labelled; unconfirmed ones marked.
 *   4. SWAP        ETH -> USDG and USDG -> ETH (gas top-up) through the Uniswap Universal
 *                  Router, with SPARE's fee (VITE_SPARE_FUND_FEE_BPS, default 0.25%,
 *                  clamped 0–1%) taken from the output in the same transaction and paid
 *                  to FeeVault. Live V4Quoter quote, minimum received at a slippage
 *                  setting, network fee estimate, and a gas reserve (gasReserveWei: the
 *                  same line Readiness reads LOW at) that no swap (and no "Max") can spend.
 *
 * The swap FAILS CLOSED. It needs: every input read (balances, gas price, allowances,
 * deployment); a quote that refreshed successfully in the last 30 s; a Chainlink ETH/USD
 * answer inside the feed's 24 h heartbeat, with the pool within 5% of it; and < 3% price
 * impact vs a tiny probe quote (no feed involved). On click it re-quotes, re-reads the feed
 * and the balance, re-checks all of it, and never accepts less than the minimum shown.
 *
 * Money is bigint base units throughout (wei, USDG 6 dp, integer bps); floats appear
 * only when a percentage is printed. Calldata comes from lib/spare-chain/fund-swap.ts.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trans, tKey, useTranslation } from '@/i18n';
import { useAccount, useBalance, useGasPrice, usePublicClient, useReadContract, useReadContracts } from 'wagmi';
import { erc20Abi, formatUnits, zeroAddress, type Address } from 'viem';
import { aggregatorV3Abi, permit2Abi, ruleRegistryAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, addressUrl, sameAddress } from '@/lib/spare-chain/addresses';
import { consentView } from '@/lib/spare-chain/consent';
import { humanizeFundError } from '@/lib/spare-chain/fund-errors';
import { useFundTx, type FundStep } from '@/lib/spare-chain/fund-hooks';
import {
  CHAINLINK_ETH_USD,
  CHAINLINK_MAX_AGE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  ETH_USDG_POOL,
  FEE_VAULT,
  FUND_GAS,
  FUND_SWAP_DEADLINE_SECONDS,
  GAS_RESERVE_TXS,
  GAS_SAFETY_MULTIPLIER,
  IMPACT_BLOCK_BPS,
  IMPACT_WARN_BPS,
  PERMIT2,
  PERMIT2_ROUTER_TTL_SECONDS,
  PRICE_BLOCK_BPS,
  PRICE_WARN_BPS,
  SPARE_TX_GAS,
  UNIVERSAL_ROUTER,
  USDG,
  buildEthToUsdg,
  buildPermit2ApproveRouterTx,
  buildUsdgApprovePermit2Tx,
  buildUsdgToEth,
  checkSwapPrice,
  ethSwapIsMeaningful,
  floorToDp,
  gasReserveWei,
  impactProbeIn,
  maxEthSwapIn,
  parseAmount,
  parseFundFeeBps,
  quoteWithProbe,
  readEthUsdReference,
  readUsdgPermit2State,
  referenceFromRound,
  txsCovered,
  usdgApprovalForSwap,
  usdgSwapNeeds,
  usdgToEthEthNeeded,
  usdgToEthGas,
  usdgToEthTxCount,
  weiToUsd6,
  type EthUsdReference,
  type FundQuote,
  type QuotedFill,
  type UsdgPermit2State,
  type UsdgSwapNeeds,
} from '@/lib/spare-chain/fund-swap';
import { useSpareDeployment } from '@/lib/spare-chain/hooks';
import { formatToken, formatUsd, ruleIsActive, ruleIsSet, type ChainRule } from '@/lib/spare';
import { useWindowManager } from '@/components/retro/WindowManager';
import { WalletPicker } from '@/components/retro/WalletPicker';
import {
  BEVEL_RAISED,
  BEVEL_SUNKEN,
  FONT_CHROME,
  FONT_DISPLAY,
  FONT_PIXEL,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  TEXTURE,
  GlyphCheck,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloInput,
  HoloLabel,
  HoloNotice,
  HoloPanel,
  HoloProgress,
  HoloScreen,
  HoloSegmented,
  HoloSparkle,
  HoloStar,
  HoloStat,
  HoloText,
  HoloTitle,
  HoloWindowBody,
  inkFor,
  pixelPath,
  type HoloTone,
} from '@/components/retro/holo';
import { AddrLink, ChainNote, Hint, TxStatus } from './spare/SpareUi';
import { HINT, NOTE, ROW, STACK, type Tone } from './spare/styles';

const chainId = SPARE_CHAIN_ID;

/** SPARE's swap fee, bps of the output. Env-configurable, clamped to 0..100 (0–1%). */
const FEE_BPS = parseFundFeeBps(import.meta.env.VITE_SPARE_FUND_FEE_BPS);
/** A quote older than this, or one whose last refresh failed, cannot be swapped. */
const QUOTE_MAX_AGE_MS = 30_000;
/** Readiness offers a USDG -> ETH top-up only from at least this much USDG (1 USDG). */
const MIN_TOPUP_USDG = 1_000_000n;
const SLIPPAGE_CHOICES = [10, 50, 100, 300] as const;
/** Quick USDG amounts for a gas top-up (whole USDG). */
const TOPUP_PRESETS = [2n, 5n, 10n] as const;

type Direction = 'eth-to-usdg' | 'usdg-to-eth';

const nowSec = () => Math.floor(Date.now() / 1000);

/* -------------------------------- format ---------------------------------- */

const fmtEth = (wei: bigint, dp = 6) => formatToken(wei, 18, dp);
const fmtUsdg = (v: bigint, dp = 6) => formatToken(v, 6, dp);
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const signedPct = (bps: number) => `${bps >= 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(2)}%`;
/** Pool LP fee (hundredths of a bip) as a percentage string. */
const poolFeePct = `${(ETH_USDG_POOL.fee / 10_000).toFixed(2)}%`;
const gweiText = (wei: bigint) => `${formatToken(wei, 9, 4)} gwei`;

type TFn = ReturnType<typeof useTranslation>['t'];

/** How old a feed answer is ("45 s", "3 min", "1.2 h"): the same buckets as fund-swap's referenceAgeText. */
function ageText(t: TFn, sec: number): string {
  if (sec < 90) return t('fundWallet.age.s', { n: Math.max(0, Math.round(sec)) });
  if (sec < 90 * 60) return t('fundWallet.age.min', { n: Math.round(sec / 60) });
  return t('fundWallet.age.h', { n: (sec / 3600).toFixed(1) });
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Date.now(), re-rendering every `everyMs` — so quote and feed ages keep counting between fetches. */
function useNowMs(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function scrollTo(el: HTMLElement | null) {
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─────────────────────────────── local atoms ─────────────────────────────── */

/** Win98 data tones -> Holo tones. */
const TONE_MAP: Record<string, HoloTone> = { up: 'good', down: 'bad', warn: 'warn', info: 'info', mono: 'ink', muted: 'muted' };
const holoTone = (t: string): HoloTone => TONE_MAP[t] ?? 'info';

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

const PX_BOLT = ['0001110', '0011100', '0011000', '0111000', '1111111', '0001110', '0001100', '0011000', '0010000'];
const PX_COIN = ['00111100', '01000010', '10011001', '10100001', '10100001', '10011001', '01000010', '00111100'];
const PX_CHECKS = ['0000000011', '1111110110', '1000001101', '1000011001', '1100110001', '1011100001', '1001000001', '1000000001', '1111111111'];

/** The little icon + caption strip. */
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

/** Numbered pixel key (deep indigo), or a chrome key with a check once done. */
function NumTile({ n, ok = false, size = 24 }: { n: number; ok?: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: ok
          ? `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.chrome}`
          : `${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%)`,
        boxShadow: ok ? `0 0 0 1px ${HOLO.ink}, ${BEVEL_RAISED}` : `0 0 0 1px ${HOLO.ink}, inset 1px 1px 0 0 #7B63E0`,
        color: HOLO.onScreen,
        fontFamily: FONT_DISPLAY,
        fontSize: size >= 24 ? 11 : 9,
        lineHeight: 1,
        paddingTop: 1,
      }}
    >
      {ok ? <GlyphCheck scale={2} /> : n}
    </span>
  );
}

/** Section heading inside a card: sparkle, Jersey title, pixel rule, optional right note. */
function SectionHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
      <HoloSparkle size={12} glow={false} color={HOLO.ink} />
      <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 19, lineHeight: 1.05, color: INK.body }}>{children}</span>
      <div aria-hidden style={{ flex: '1 1 24px', height: 1, backgroundImage: `linear-gradient(90deg, ${HOLO.inkFaint} 50%, transparent 50%)`, backgroundSize: '4px 1px' }} />
      {right != null && <span style={{ ...HINT, fontSize: 10.5 }}>{right}</span>}
    </div>
  );
}

/** External link styled as a small Holo button. */
function LinkButton({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="holo-btn holo-btn--sm"
      style={{ textDecoration: 'none', alignSelf: 'flex-start' }}
    >
      {children}
    </a>
  );
}

const TEXT_LINK = {
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  fontSize: 12,
  color: INK.link,
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
} as const;

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

/* ---------------------------------- app ----------------------------------- */

export function FundWalletApp() {
  const { t } = useTranslation('apps-a');
  const { isConnected, address } = useAccount();
  return (
    <HoloWindowBody gap={14}>
      <HoloHero
        art="/icons/spare/fund-wallet.png"
        kicker={t('fundWallet.hero.kicker')}
        title={t('shell:appNames.fund-wallet')}
        subtitle={t('fundWallet.hero.subtitle')}
        description={t('fundWallet.hero.description')}
        aside={<HoloBadge label="ROBINHOOD CHAIN" variant="solid" />} // i18n-ignore (never translated)
        seed={6}
        compact={!!(isConnected && address)}
      >
        {!(isConnected && address) && (
          <FeatureStrip
            items={[
              { icon: PX_BOLT, text: t('fundWallet.features.gas') },
              { icon: PX_COIN, text: t('fundWallet.features.usdg') },
              { icon: PX_CHECKS, text: t('fundWallet.features.readiness') },
            ]}
          />
        )}
      </HoloHero>
      {isConnected && address ? (
        <FundBody key={address} me={address} />
      ) : (
        <>
          <ReadinessPreview />
          <ConnectCard why={t('fundWallet.connectWhy')} />
          <BridgeBuy />
        </>
      )}
    </HoloWindowBody>
  );
}

/* ───────────────────────────── no wallet: preview ─────────────────────────── */

/** Translation keys, translated at render. */
const EXAMPLE_CHECKS: { title: string; label: string; tone: HoloTone; ok: boolean; detail: string }[] = [
  { title: tKey('fundWallet.checks.eth'), label: tKey('shell:common.ok'), tone: 'good', ok: true, detail: tKey('fundWallet.example.eth') },
  { title: tKey('fundWallet.checks.usdg'), label: tKey('shell:common.ok'), tone: 'good', ok: true, detail: tKey('fundWallet.example.usdg') },
  { title: tKey('fundWallet.checks.link'), label: tKey('fundWallet.status.linked'), tone: 'good', ok: true, detail: tKey('fundWallet.example.link') },
  { title: tKey('fundWallet.checks.consent'), label: tKey('fundWallet.status.notAuthorized'), tone: 'bad', ok: false, detail: tKey('fundWallet.example.consent') },
  { title: tKey('fundWallet.checks.rule'), label: tKey('fundWallet.status.noRule'), tone: 'bad', ok: false, detail: tKey('fundWallet.example.rule') },
];

function ReadinessPreview() {
  const { t } = useTranslation('apps-a');
  const ok = EXAMPLE_CHECKS.filter((c) => c.ok).length;
  return (
    <HoloCard title={t('fundWallet.readiness.title')} accent={t('shell:common.example')} accentTone="ink">
      <HoloText size="sm" tone="muted">
        {t('fundWallet.readiness.previewIntro')}
      </HoloText>
      <HoloProgress
        value={(ok / EXAMPLE_CHECKS.length) * 100}
        segments={EXAMPLE_CHECKS.length}
        height={16}
        label={t('fundWallet.readiness.exampleWallet')}
        showValue={t('fundWallet.readiness.exampleProgress', { ok, total: EXAMPLE_CHECKS.length })}
      />
      <div style={{ ...STACK, gap: 6 }}>
        {EXAMPLE_CHECKS.map((c, i) => (
          <HoloPanel key={c.title} variant="sunken" padding="7px 10px" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <NumTile n={i + 1} ok={c.ok} />
            <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, lineHeight: 1.05, color: INK.body, minWidth: 150 }}>{t(c.title)}</span>
            <HoloBadge label={t(c.label)} tone={c.tone} />
            <span style={{ ...HINT, flex: '1 1 200px' }}>{t(c.detail)}</span>
          </HoloPanel>
        ))}
      </div>
    </HoloCard>
  );
}

function FundBody({ me }: { me: Address }) {
  const { t } = useTranslation('apps-a');
  const deployment = useSpareDeployment();
  const [direction, setDirection] = useState<Direction>('eth-to-usdg');
  const swapRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<HTMLDivElement>(null);

  const ethQ = useBalance({ address: me, chainId, query: { refetchInterval: 20_000 } });
  const usdgQ = useReadContract({
    address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [me], chainId,
    query: { refetchInterval: 20_000 },
  });
  const gasQ = useGasPrice({ chainId, query: { refetchInterval: 30_000 } });
  const feedQ = useReadContract({
    address: CHAINLINK_ETH_USD, abi: aggregatorV3Abi, functionName: 'latestRoundData', chainId,
    query: { refetchInterval: 60_000 },
  });

  const chain: ChainState = {
    eth: ethQ.data?.value,
    usdg: usdgQ.data as bigint | undefined,
    gasPrice: gasQ.data,
    // Display uses ref.usd6 as-is; the swap checks the answer's age itself (checkSwapPrice).
    ref: referenceFromRound(feedQ.data as readonly [bigint, bigint, bigint, bigint, bigint] | undefined),
    ethError: ethQ.error,
    usdgError: usdgQ.error,
    gasError: gasQ.error,
    deployed: deployment.deployed,
    checking: deployment.checking,
    deployError: deployment.error,
  };

  const goSwap = (d: Direction) => {
    setDirection(d);
    scrollTo(swapRef.current);
  };
  const goBridge = () => scrollTo(bridgeRef.current);

  return (
    <>
      <ChainNote />
      {(ethQ.error || usdgQ.error) && <Hint warn>{t('fundWallet.balancesError', { error: humanizeFundError(ethQ.error ?? usdgQ.error) })}</Hint>}
      <Readiness me={me} chain={chain} onSwap={goSwap} onBridge={goBridge} />
      <Receive me={me} />
      <div ref={bridgeRef}>
        <BridgeBuy />
      </div>
      <div ref={swapRef}>
        <SwapBox me={me} chain={chain} direction={direction} setDirection={setDirection} />
      </div>
    </>
  );
}

/** Everything FundBody reads once and both Readiness and Swap judge. */
interface ChainState {
  eth?: bigint;
  usdg?: bigint;
  gasPrice?: bigint;
  /** Chainlink ETH/USD; undefined while unread / on a bad answer. May be stale — check updatedAt. */
  ref?: EthUsdReference;
  ethError: unknown;
  usdgError: unknown;
  gasError: unknown;
  deployed: boolean;
  checking: boolean;
  /** RPC failure while checking for the SPARE contracts (NOT "not deployed"). */
  deployError: string | null;
}

/* ------------------------------- readiness -------------------------------- */

interface Check {
  key: string;
  title: string;
  label: string;
  tone: Tone;
  ok: boolean;
  detail: ReactNode;
  action?: { label: string; onClick: () => void; primary?: boolean };
}

function Readiness(props: {
  me: Address;
  chain: ChainState;
  onSwap: (d: Direction) => void;
  onBridge: () => void;
}) {
  const { t } = useTranslation('apps-a');
  const { me, chain, onSwap, onBridge } = props;
  const { eth, usdg, gasPrice, ref, deployed, checking, deployError } = chain;
  const ethUsd6 = ref?.usd6;
  const wm = useWindowManager();
  const READING = { label: t('fundWallet.status.reading'), tone: 'muted' as Tone, ok: false };

  const acctQ = useReadContract({
    address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'accountOf', args: [me], chainId,
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const feeds = acctQ.data as Address | undefined;
  const linked = !!feeds && feeds !== zeroAddress;
  const isSpender = linked && !sameAddress(feeds, me);
  // The rule that governs this wallet's round-ups is its account's (itself if unlinked).
  const ruleAccount = linked ? (feeds as Address) : me;

  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'ruleOf', args: [ruleAccount], chainId } as const,
      { address: USDG, abi: erc20Abi, functionName: 'allowance', args: [me, PERMIT2], chainId } as const,
      { address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [me, USDG, SPARE.SweepExecutor], chainId } as const,
    ],
    query: { enabled: deployed && acctQ.isSuccess, refetchInterval: 30_000 },
  });
  const ruleRaw = reads.data?.[0]?.result as { roundTo: number; multiplier: number; weeklyCap: bigint; enabled: boolean } | undefined;
  const rule: ChainRule | undefined = ruleRaw
    ? { roundTo: Number(ruleRaw.roundTo), multiplier: Number(ruleRaw.multiplier), weeklyCap: BigInt(ruleRaw.weeklyCap), enabled: ruleRaw.enabled }
    : undefined;
  const erc20 = reads.data?.[1]?.result as bigint | undefined;
  const p2 = reads.data?.[2]?.result as readonly [bigint, number, number] | undefined;
  const consent = consentView(erc20 != null && p2 ? { erc20, p2Amount: p2[0], p2Expiration: Number(p2[1]) } : undefined, {
    now: nowSec(),
    weeklyCap: rule?.weeklyCap,
  });

  // An RPC failure is not "not deployed": say which one it is.
  const notLive: Pick<Check, 'label' | 'tone' | 'ok'> = deployError
    ? { label: t('fundWallet.status.rpcError'), tone: 'warn', ok: false }
    : { label: checking ? t('fundWallet.status.checking') : t('fundWallet.status.deploying'), tone: 'muted', ok: false };
  const notLiveDetail = deployError
    ? t('fundWallet.readiness.notLive.rpc', { error: deployError })
    : checking
      ? t('fundWallet.readiness.notLive.checking')
      : t('fundWallet.readiness.notLive.deploying');
  const openLink = { label: t('fundWallet.readiness.action.openLink'), onClick: () => wm.openApp('link-wallet'), primary: true };
  const openRules = { label: t('fundWallet.readiness.action.openRules'), onClick: () => wm.openApp('roundup-rules'), primary: true };
  const getEth = { label: t('fundWallet.readiness.action.getEth'), onClick: onBridge, primary: true };

  /* 1 — ETH for gas. ONE line for LOW here and for the swap's reserve: gasReserveWei. */
  const ETH_TITLE = t('fundWallet.checks.eth');
  const reserve = gasReserveWei(gasPrice);
  const maxSwap = eth != null ? maxEthSwapIn(eth, reserve) : 0n;
  const ethUsd = eth != null && ethUsd6 ? ` (≈ ${formatUsd(weiToUsd6(eth, ethUsd6))})` : '';
  // A USDG -> ETH top-up's gas, approvals included (the router's Permit2 allowance is used up by
  // every swap, so assume it is needed), with the wallet-side safety margin.
  const topUpNeeds: UsdgSwapNeeds = { erc20Approve: erc20 == null || erc20 < MIN_TOPUP_USDG, permit2Allowance: true };
  const topUpEth = gasPrice ? usdgToEthEthNeeded(gasPrice, topUpNeeds) : undefined;
  const hasUsdgForTopUp = usdg != null && usdg >= MIN_TOPUP_USDG;
  const canTopUp = hasUsdgForTopUp && eth != null && topUpEth != null && eth >= topUpEth;
  const topUp = { label: t('fundWallet.readiness.action.topUp'), onClick: () => onSwap('usdg-to-eth'), primary: true };

  let ethCheck: Check;
  if (eth == null) {
    ethCheck = chain.ethError
      ? { key: 'eth', title: ETH_TITLE, label: t('fundWallet.status.rpcError'), tone: 'warn', ok: false, detail: t('fundWallet.readiness.eth.rpc', { error: humanizeFundError(chain.ethError) }) }
      : { key: 'eth', title: ETH_TITLE, ...READING, detail: t('fundWallet.readiness.readingBalance') };
  } else if (eth === 0n) {
    ethCheck = {
      key: 'eth', title: ETH_TITLE, label: t('fundWallet.status.noEth'), tone: 'down', ok: false,
      detail: t('fundWallet.readiness.eth.none'),
      action: getEth,
    };
  } else if (!gasPrice) {
    // Unknown gas price: never a green OK.
    ethCheck = chain.gasError
      ? {
          key: 'eth', title: ETH_TITLE, label: t('fundWallet.status.rpcError'), tone: 'warn', ok: false,
          detail: t('fundWallet.readiness.eth.gasRpc', { eth: fmtEth(eth), usd: ethUsd, error: humanizeFundError(chain.gasError) }),
        }
      : { key: 'eth', title: ETH_TITLE, ...READING, detail: t('fundWallet.readiness.eth.readingGas', { eth: fmtEth(eth), usd: ethUsd }) };
  } else {
    const covered = txsCovered(eth, gasPrice) ?? 0n;
    const cover = { eth: fmtEth(eth), usd: ethUsd, count: covered.toLocaleString(), gas: gweiText(gasPrice), reserve: fmtEth(reserve) };
    if (eth <= reserve) {
      const stuck = hasUsdgForTopUp && !canTopUp;
      ethCheck = {
        key: 'eth', title: ETH_TITLE, label: t('fundWallet.status.low'), tone: 'warn', ok: false,
        detail: stuck
          ? t('fundWallet.readiness.eth.lowStuck', { ...cover, txs: String(GAS_RESERVE_TXS), need: fmtEth(topUpEth ?? 0n, 8) })
          : t('fundWallet.readiness.eth.low', { ...cover, txs: String(GAS_RESERVE_TXS) }),
        action: canTopUp ? topUp : getEth,
      };
    } else {
      const swapUsd = ethUsd6 ? ` (≈ ${formatUsd(weiToUsd6(maxSwap, ethUsd6))})` : '';
      ethCheck = {
        key: 'eth', title: ETH_TITLE, label: t('shell:common.ok'), tone: 'up', ok: true,
        detail: t('fundWallet.readiness.eth.ok', { ...cover, max: fmtEth(maxSwap), maxUsd: swapUsd }),
      };
    }
  }

  /* 2 — USDG */
  const USDG_TITLE = t('fundWallet.checks.usdg');
  const canBuyUsdg = eth != null && ethSwapIsMeaningful(maxSwap, ethUsd6);
  const usdgCheck: Check =
    usdg == null
      ? { key: 'usdg', title: USDG_TITLE, ...READING, detail: t('fundWallet.readiness.readingBalance') }
      : usdg === 0n
        ? {
            key: 'usdg', title: USDG_TITLE, label: t('fundWallet.status.noUsdg'), tone: 'down', ok: false,
            detail: t('fundWallet.readiness.usdg.none'),
            action: canBuyUsdg
              ? { label: t('fundWallet.readiness.action.swapToUsdg'), onClick: () => onSwap('eth-to-usdg'), primary: true }
              : { label: t('fundWallet.readiness.action.getUsdg'), onClick: onBridge, primary: true },
          }
        : { key: 'usdg', title: USDG_TITLE, label: t('shell:common.ok'), tone: 'up', ok: true, detail: t('fundWallet.readiness.usdg.ok', { amount: formatUsd(usdg) }) };

  /* 3 — linked */
  const LINK_TITLE = t('fundWallet.checks.link');
  const linkCheck: Check = !deployed
    ? { key: 'link', title: LINK_TITLE, ...notLive, detail: notLiveDetail }
    : acctQ.error
      ? { key: 'link', title: LINK_TITLE, label: t('fundWallet.status.rpcError'), tone: 'warn', ok: false, detail: humanizeFundError(acctQ.error) }
      : !acctQ.isSuccess
        ? { key: 'link', title: LINK_TITLE, ...READING, detail: t('fundWallet.readiness.readingRegistry') }
        : !linked
          ? {
              key: 'link', title: LINK_TITLE, label: t('fundWallet.status.notLinked'), tone: 'down', ok: false,
              detail: t('fundWallet.readiness.link.notLinked'),
              action: openLink,
            }
          : {
              key: 'link', title: LINK_TITLE, label: t('fundWallet.status.linked'), tone: 'up', ok: true,
              detail: isSpender
                ? <Trans t={t} i18nKey="fundWallet.readiness.link.spender" components={{ addr: <AddrLink address={feeds as Address} /> }} />
                : t('fundWallet.readiness.link.self'),
            };

  /* 4 — round-ups authorized (this wallet's own Permit2 pull consent) */
  // consent.label / consent.detail come from lib/spare-chain/consent.ts, already in the live language.
  const CONSENT_TITLE = t('fundWallet.checks.consent');
  const consentCheck: Check = !deployed
    ? { key: 'consent', title: CONSENT_TITLE, ...notLive, detail: notLiveDetail }
    : {
        key: 'consent', title: CONSENT_TITLE, label: consent.label, tone: consent.tone, ok: consent.ok,
        detail: consent.state === 'reading'
          ? consent.detail
          : t('fundWallet.readiness.consentDetail', { detail: consent.detail }),
        action: consent.ok || consent.state === 'reading' ? undefined : { ...openLink, label: t('fundWallet.readiness.action.authorize') },
      };

  /* 5 — rule enabled */
  const RULE_TITLE = t('fundWallet.checks.rule');
  const whose = { addr: <AddrLink address={ruleAccount} /> };
  const ruleCheck: Check = !deployed
    ? { key: 'rule', title: RULE_TITLE, ...notLive, detail: notLiveDetail }
    : !rule
      ? { key: 'rule', title: RULE_TITLE, ...READING, detail: t('fundWallet.readiness.readingRegistry') }
      : ruleIsActive(rule) && ruleIsSet(rule)
        ? {
            key: 'rule', title: RULE_TITLE, label: t('fundWallet.status.on'), tone: 'up', ok: true,
            detail: isSpender
              ? <Trans t={t} i18nKey="fundWallet.readiness.rule.onWhose" values={{ roundTo: rule.roundTo, multiplier: rule.multiplier, cap: formatUsd(rule.weeklyCap) }} components={whose} />
              : t('fundWallet.readiness.rule.on', { roundTo: rule.roundTo, multiplier: rule.multiplier, cap: formatUsd(rule.weeklyCap) }),
          }
        : {
            key: 'rule', title: RULE_TITLE, label: ruleIsSet(rule) ? t('fundWallet.status.off') : t('fundWallet.status.noRule'), tone: 'down', ok: false,
            detail: ruleIsSet(rule)
              ? isSpender
                ? <Trans t={t} i18nKey="fundWallet.readiness.rule.pausedWhose" components={whose} />
                : t('fundWallet.readiness.rule.paused')
              : isSpender
                ? <Trans t={t} i18nKey="fundWallet.readiness.rule.noneWhose" components={whose} />
                : t('fundWallet.readiness.rule.none'),
            action: openRules,
          };

  const checks = [ethCheck, usdgCheck, linkCheck, consentCheck, ruleCheck];
  const okCount = checks.filter((c) => c.ok).length;
  const allOk = okCount === checks.length;
  // Only the first open gap's button is dressed as the primary "next step".
  const nextKey = checks.find((c) => !c.ok && c.action)?.key;

  return (
    <HoloCard
      title={t('fundWallet.readiness.title')}
      icon={<Px rows={PX_CHECKS} />}
      accent={allOk ? t('fundWallet.readiness.accentReady') : t('fundWallet.readiness.accentProgress', { ok: okCount, total: checks.length })}
      accentTone={allOk ? 'good' : 'warn'}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 26px', alignItems: 'flex-start' }}>
        <HoloStat size="xl" label={t('fundWallet.readiness.statReady')} value={`${okCount}/${checks.length}`} tone={allOk ? 'good' : 'holo'} />
        <HoloStat
          size="md"
          label={ETH_TITLE}
          value={eth != null ? `${fmtEth(eth)} ETH` : chain.ethError ? '—' : '…'}
          sub={eth != null && ethUsd6 ? `≈ ${formatUsd(weiToUsd6(eth, ethUsd6))}` : undefined}
          tone={ethCheck.ok ? 'ink' : holoTone(ethCheck.tone)}
        />
        <HoloStat
          size="md"
          label="USDG"
          value={usdg != null ? formatUsd(usdg) : chain.usdgError ? '—' : '…'}
          sub={t('fundWallet.readiness.usdgSub')}
          tone={usdgCheck.ok ? 'ink' : holoTone(usdgCheck.tone)}
        />
      </div>
      <HoloProgress
        value={(okCount / checks.length) * 100}
        segments={checks.length}
        height={18}
        tone={allOk ? 'good' : 'holo'}
        label={t('fundWallet.readiness.title')}
        showValue={t('fundWallet.readiness.progress', { ok: okCount, total: checks.length })}
      />
      <div style={{ ...STACK, gap: 6 }}>
        {checks.map((c, i) => (
          <CheckLine key={c.key} n={i + 1} check={c} next={c.key === nextKey} />
        ))}
      </div>
      <span style={HINT}>
        {t('fundWallet.readiness.gasNote', { k: (SPARE_TX_GAS / 1000n).toString(), reserve: fmtEth(reserve), txs: GAS_RESERVE_TXS.toString() })}
      </span>
    </HoloCard>
  );
}

function CheckLine({ n, check, next }: { n: number; check: Check; next: boolean }) {
  return (
    <HoloPanel
      variant="sunken"
      padding="8px 10px"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        ...(check.ok ? { background: `${TEXTURE.dither} 0 0 / 4px 4px, linear-gradient(90deg, #EFFFF8 0%, #FFFDFB 70%)` } : null),
      }}
    >
      <NumTile n={n} ok={check.ok} />
      <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, lineHeight: 1.05, color: INK.body }}>{check.title}</span>
          <HoloBadge label={check.label} tone={holoTone(check.tone)} />
        </div>
        <div style={{ ...HINT, fontSize: 11.5 }}>{check.detail}</div>
      </div>
      {check.action && (
        <HoloButton size="sm" variant={next && check.action.primary ? 'primary' : 'secondary'} onClick={check.action.onClick}>
          {check.action.label}
        </HoloButton>
      )}
    </HoloPanel>
  );
}

/* -------------------------------- receive --------------------------------- */

function Receive({ me }: { me: Address }) {
  const { t } = useTranslation('apps-a');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(me);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };
  return (
    <HoloCard title={t('fundWallet.receive.title')} accent="ROBINHOOD CHAIN · 4663" accentTone="info">
      <HoloScreen padding="12px 14px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <HoloStar size={34} />
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: INK.soft }}>{t('fundWallet.receive.eyebrow')}</span>
            <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 15, lineHeight: 1.4, color: INK.body, wordBreak: 'break-all', userSelect: 'all' }}>
              {me}
            </span>
          </div>
        </div>
      </HoloScreen>
      <div style={ROW}>
        <HoloButton onClick={copy}>{copied === 'ok' ? t('fundWallet.receive.copied') : t('fundWallet.receive.copy')}</HoloButton>
        <a href={addressUrl(me)} target="_blank" rel="noopener noreferrer" style={TEXT_LINK}>
          {t('fundWallet.receive.explorer')}
        </a>
        {copied === 'fail' && <span style={NOTE}>{t('fundWallet.receive.copyBlocked')}</span>}
      </div>
      <HoloNotice tone="warn" compact title={t('fundWallet.receive.chainOnlyTitle')} live="none">
        {t('fundWallet.receive.chainOnly')}
      </HoloNotice>
      <span style={HINT}>
        {t('fundWallet.receive.needs')}
      </span>
    </HoloCard>
  );
}

/* ------------------------------- bridge / buy ------------------------------ */

/**
 * `name` is a product name and stays as written (glossary §1) unless `nameKey`
 * gives a translatable one. `gives` is literal token text unless `givesKey` is
 * set. `how` / `caveat` are translation keys.
 */
interface Route {
  name: string;
  nameKey?: string;
  url: string;
  tag: RouteTag;
  tone: Tone;
  gives: string;
  givesKey?: string;
  how: string;
  caveat?: string;
}

type RouteTag = 'OFFICIAL' | 'PARTNER' | 'LISTED' | 'CANONICAL';

const ROUTE_TAG: Record<RouteTag, string> = {
  OFFICIAL: tKey('fundWallet.bridge.tag.official'),
  PARTNER: tKey('fundWallet.bridge.tag.partner'),
  LISTED: tKey('fundWallet.bridge.tag.listed'),
  CANONICAL: tKey('fundWallet.bridge.tag.canonical'),
};

const BUY_ROUTES: Route[] = [
  {
    name: 'Robinhood app',
    url: 'https://robinhood.com/us/en/support/articles/crypto-transfers/',
    tag: 'OFFICIAL', tone: 'up', gives: 'ETH + USDG',
    how: tKey('fundWallet.bridge.routes.robinhoodApp.how'),
    caveat: tKey('fundWallet.bridge.routes.robinhoodApp.caveat'),
  },
  {
    name: 'Robinhood Wallet',
    url: 'https://robinhood.com/us/en/support/articles/send-receive-and-swap-crypto',
    tag: 'OFFICIAL', tone: 'up', gives: 'send · receive · swap', givesKey: tKey('fundWallet.bridge.routes.robinhoodWallet.gives'),
    how: tKey('fundWallet.bridge.routes.robinhoodWallet.how'),
  },
  {
    name: 'MoonPay',
    url: 'https://www.moonpay.com/newsroom/moonpay-robinhoodchain',
    tag: 'PARTNER', tone: 'info', gives: 'USDG',
    how: tKey('fundWallet.bridge.routes.moonpay.how'),
    caveat: tKey('fundWallet.bridge.routes.moonpay.caveat'),
  },
];

const BRIDGE_ROUTES: Route[] = [
  {
    name: 'Across',
    url: 'https://across.to/?to=robinhood',
    tag: 'LISTED', tone: 'info', gives: 'USDC → USDG · ETH',
    how: tKey('fundWallet.bridge.routes.across.how'),
  },
  {
    name: 'Relay',
    url: 'https://relay.link/bridge/robinhood',
    tag: 'LISTED', tone: 'info', gives: 'ETH · tokens', givesKey: tKey('fundWallet.bridge.routes.relay.gives'),
    how: tKey('fundWallet.bridge.routes.relay.how'),
    caveat: tKey('fundWallet.bridge.routes.relay.caveat'),
  },
  {
    name: 'Stargate (LayerZero)',
    url: 'https://stargate.finance',
    tag: 'LISTED', tone: 'info', gives: 'USDG',
    how: tKey('fundWallet.bridge.routes.stargate.how'),
  },
  {
    name: 'Arbitrum canonical bridge', nameKey: tKey('fundWallet.bridge.routes.arbitrum.name'),
    url: 'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum',
    tag: 'CANONICAL', tone: 'mono', gives: 'ETH · ERC-20s', givesKey: tKey('fundWallet.bridge.routes.arbitrum.gives'),
    how: tKey('fundWallet.bridge.routes.arbitrum.how'),
    caveat: tKey('fundWallet.bridge.routes.arbitrum.caveat'),
  },
];

const ROUTE_BAR: Record<string, 'holo' | 'lilac' | 'pink'> = { OFFICIAL: 'pink', PARTNER: 'holo', LISTED: 'holo', CANONICAL: 'lilac' };

function RouteCard({ r }: { r: Route }) {
  const { t } = useTranslation('apps-a');
  const name = r.nameKey ? t(r.nameKey) : r.name;
  return (
    <HoloCard title={name} accent={t(ROUTE_TAG[r.tag])} accentTone={holoTone(r.tone)} bar={ROUTE_BAR[r.tag] ?? 'holo'} compact closeBox={false}>
      <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13, lineHeight: 1.3, color: INK.body }}>{r.givesKey ? t(r.givesKey) : r.gives}</span>
      <span style={HINT}>{t(r.how)}</span>
      {r.caveat && <span style={{ ...HINT, color: INK.warn }}>{t(r.caveat)}</span>}
      <div style={{ flex: 1 }} />
      <LinkButton href={r.url} label={t('fundWallet.bridge.newTab', { name })}>{name} ↗</LinkButton>
    </HoloCard>
  );
}

const ROUTE_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 } as const;

function BridgeBuy() {
  const { t } = useTranslation('apps-a');
  const warnStrong = { b: <strong style={{ color: HOLO.warnInk }} /> };
  return (
    <HoloCard title={t('fundWallet.bridge.title')} accent="ETH + USDG" accentTone="info">
      <HoloText size="sm" bold>{t('fundWallet.bridge.heading')}</HoloText>
      <HoloNotice tone="info" compact live="none">
        <Trans t={t} i18nKey="fundWallet.bridge.quickest" components={{ b: <strong /> }} />
      </HoloNotice>
      <SectionHead right={t('fundWallet.bridge.buyRight')}>{t('fundWallet.bridge.buy')}</SectionHead>
      <div style={ROUTE_GRID}>
        {BUY_ROUTES.map((r) => <RouteCard key={r.name} r={r} />)}
      </div>
      <SectionHead right={t('fundWallet.bridge.bridgeRight')}>{t('fundWallet.bridge.bridgeFrom')}</SectionHead>
      <div style={ROUTE_GRID}>
        {BRIDGE_ROUTES.map((r) => <RouteCard key={r.name} r={r} />)}
      </div>
      <SectionHead>{t('fundWallet.bridge.unconfirmed')}</SectionHead>
      <HoloNotice tone="warn" compact live="none">
        <Trans t={t} i18nKey="fundWallet.bridge.kucoin" components={warnStrong} />
        <br />
        <Trans t={t} i18nKey="fundWallet.bridge.others" components={warnStrong} />
      </HoloNotice>
      <div style={ROW}>
        <a href="https://docs.robinhood.com/chain/bridging/" target="_blank" rel="noopener noreferrer" style={TEXT_LINK}>
          {t('fundWallet.bridge.docsLink')}
        </a>
        <span style={{ ...HINT, flex: '1 1 240px' }}>
          {t('fundWallet.bridge.legend')}
        </span>
      </div>
    </HoloCard>
  );
}

/* ---------------------------------- swap ---------------------------------- */

/** One row of the quote screen. `big` renders the value as a holo poster numeral. */
function QuoteLine({ label, value, sub, tone, big = false }: { label: string; value: ReactNode; sub?: ReactNode; tone?: HoloTone; big?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '4px 12px',
        flexWrap: 'wrap',
        padding: big ? '8px 0 7px' : '5px 0',
        borderBottom: `1px dashed ${HOLO.screenLine}`,
      }}
    >
      <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: INK.soft, width: 140, flexShrink: 0 }}>{label}</span>
      {big ? (
        <HoloTitle as="span" size="sm" fill={tone === 'good' ? 'good' : 'holo'} style={{ textTransform: 'none' }}>
          {value}
        </HoloTitle>
      ) : (
        <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 14, lineHeight: 1.3, color: tone ? inkFor(tone) : INK.body, overflowWrap: 'anywhere' }}>{value}</span>
      )}
      {sub && <span style={{ ...HINT, flex: '1 1 160px', minWidth: 0 }}>{sub}</span>}
    </div>
  );
}

interface LastSwap {
  netOut: bigint;
  minAmountOut: bigint;
  outSym: string;
  outDec: number;
}

interface QuoteData {
  q: FundQuote;
  /** Tiny same-direction quote for the feed-independent price-impact check. */
  probe: QuotedFill;
  gas: bigint | null;
}

const NO_NEEDS: UsdgSwapNeeds = { erc20Approve: false, permit2Allowance: false };
/** Until the allowances are read, assume the worst case: both approvals. */
const ALL_NEEDS: UsdgSwapNeeds = { erc20Approve: true, permit2Allowance: true };

function SwapBox(props: {
  me: Address;
  chain: ChainState;
  direction: Direction;
  setDirection: (d: Direction) => void;
}) {
  const { t } = useTranslation('apps-a');
  const { me, chain, direction, setDirection } = props;
  const { eth, usdg, gasPrice, ref } = chain;
  const ethUsd6 = ref?.usd6;
  const client = usePublicClient({ chainId });
  const tx = useFundTx();
  const nowMs = useNowMs(5_000);
  const [text, setText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [prep, setPrep] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [lastSwap, setLastSwap] = useState<LastSwap | null>(null);

  const zeroForOne = direction === 'eth-to-usdg';
  const inDec = zeroForOne ? 18 : 6;
  const outDec = zeroForOne ? 6 : 18;
  const inSym = zeroForOne ? 'ETH' : 'USDG';
  const outSym = zeroForOne ? 'USDG' : 'ETH';
  const fmtIn = (v: bigint) => (zeroForOne ? fmtEth(v, 8) : fmtUsdg(v));
  const fmtOut = (v: bigint) => (zeroForOne ? fmtUsdg(v) : fmtEth(v, 8));
  /** Minimums round DOWN: the screen never promises more than the router enforces. */
  const fmtOutMin = (v: bigint) => (zeroForOne ? fmtUsdg(v) : fmtEth(floorToDp(v, 18, 8), 8));

  // A new direction starts from a clean form.
  useEffect(() => {
    setText('');
    setPrep({ busy: false });
  }, [direction]);

  const amountIn = parseAmount(text, inDec);
  const hasAmount = amountIn != null && amountIn > 0n;
  const debounced = useDebounced(text, 350);
  const quoteAmount = parseAmount(debounced, inDec);

  /* USDG -> ETH: what the router's Permit2 path still needs (display; re-read fresh on click). */
  const allowQ = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: USDG, abi: erc20Abi, functionName: 'allowance', args: [me, PERMIT2], chainId } as const,
      { address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [me, USDG, UNIVERSAL_ROUTER], chainId } as const,
      { address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [me, USDG, SPARE.SweepExecutor], chainId } as const,
    ],
    query: { enabled: !zeroForOne, refetchInterval: 30_000 },
  });
  const allowError: unknown = allowQ.error ?? allowQ.data?.find((r) => r.status === 'failure')?.error;
  const a0 = allowQ.data?.[0]?.result as bigint | undefined;
  const a1 = allowQ.data?.[1]?.result as readonly [bigint, number, number] | undefined;
  const a2 = allowQ.data?.[2]?.result as readonly [bigint, number, number] | undefined;
  const p2State: UsdgPermit2State | undefined =
    a0 != null && a1 && a2
      ? {
          erc20Allowance: a0,
          permit2Amount: a1[0],
          permit2Expiration: Number(a1[1]),
          permit2Nonce: Number(a1[2]),
          sweep: { amount: a2[0], expiration: Number(a2[1]) },
        }
      : undefined;
  const needs: UsdgSwapNeeds = zeroForOne || !hasAmount ? NO_NEEDS : p2State ? usdgSwapNeeds(p2State, amountIn) : ALL_NEEDS;
  const approval =
    !zeroForOne && hasAmount && p2State && needs.erc20Approve
      ? usdgApprovalForSwap(p2State.erc20Allowance, amountIn, p2State.sweep, Math.floor(nowMs / 1000))
      : null;

  /* Live quote + probe: V4Quoter via eth_call, then eth_estimateGas on the exact calldata when it can run. */
  const quoteQ = useQuery({
    queryKey: ['spare', 'fund-quote', direction, quoteAmount?.toString() ?? '', FEE_BPS, slippageBps, me],
    enabled: !!client && quoteAmount != null && quoteAmount > 0n,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async (): Promise<QuoteData> => {
      const amt = quoteAmount as bigint;
      const { q, probe } = await quoteWithProbe(client!, zeroForOne, amt, { feeBps: FEE_BPS, slippageBps });
      let gas: bigint | null = null;
      if (q.minAmountOut > 0n) {
        try {
          const call = zeroForOne
            ? buildEthToUsdg({ amountIn: q.amountIn, minAmountOut: q.minAmountOut, feeBps: q.feeBps })
            : buildUsdgToEth({ amountIn: q.amountIn, minAmountOut: q.minAmountOut, feeBps: q.feeBps });
          gas = await client!.estimateGas({ account: me, to: call.to, data: call.data, value: call.value });
        } catch {
          gas = null; // no allowance yet / amount above balance: fall back to measured constants
        }
      }
      return { q, probe, gas };
    },
  });

  const quote = quoteQ.data?.q;
  const quoteFresh = !!quote && amountIn != null && quote.amountIn === amountIn && quote.slippageBps === slippageBps && quote.feeBps === FEE_BPS;
  // TanStack keeps the last good data when a refetch fails: that quote is STALE, never swappable.
  const quoteAgeMs = quoteQ.dataUpdatedAt > 0 ? nowMs - quoteQ.dataUpdatedAt : Infinity;
  const quoteStale = !!quote && (quoteQ.isError || quoteAgeMs > QUOTE_MAX_AGE_MS);

  const balanceIn = zeroForOne ? eth : usdg;
  const reserve = gasReserveWei(gasPrice);
  const maxIn = zeroForOne ? (eth != null ? maxEthSwapIn(eth, reserve) : undefined) : usdg;
  const swapGas = (quoteFresh ? quoteQ.data?.gas : null) ?? (zeroForOne ? FUND_GAS.ethToUsdg : FUND_GAS.usdgToEth);
  const totalGas = zeroForOne ? swapGas : usdgToEthGas(needs, swapGas);
  const txCount = zeroForOne ? 1 : usdgToEthTxCount(needs);
  const networkFee = gasPrice ? totalGas * gasPrice : undefined;
  const ethNeeded = networkFee != null ? networkFee * GAS_SAFETY_MULTIPLIER : undefined;

  const priceCheck =
    quote && quoteFresh
      ? checkSwapPrice({ zeroForOne, fill: quote, probe: quoteQ.data?.probe, ref, now: Math.floor(nowMs / 1000) })
      : null;
  const edge = priceCheck?.edgeBps ?? null;
  const impact = priceCheck?.impactBps ?? null;

  // problem = a reason shown as a warning; waiting = still loading. Either blocks the swap.
  let problem: string | null = null;
  let waiting: string | null = null;
  if (chain.deployError) problem = t('fundWallet.swap.err.deployRpc', { error: chain.deployError });
  else if (chain.checking) waiting = t('fundWallet.swap.wait.checking');
  else if (!chain.deployed) problem = t('fundWallet.swap.err.notDeployed');
  else if (text.trim() === '') problem = null;
  else if (amountIn == null) problem = t('fundWallet.swap.err.invalidAmount', { sym: inSym, dec: inDec });
  else if (amountIn === 0n) problem = t('fundWallet.swap.err.zero');
  else if (eth == null) {
    if (chain.ethError) problem = t('fundWallet.swap.err.ethRead', { error: humanizeFundError(chain.ethError) });
    else waiting = t('fundWallet.swap.wait.eth');
  } else if (!zeroForOne && usdg == null) {
    if (chain.usdgError) problem = t('fundWallet.swap.err.usdgRead', { error: humanizeFundError(chain.usdgError) });
    else waiting = t('fundWallet.swap.wait.usdg');
  } else if (!gasPrice) {
    if (chain.gasError) problem = t('fundWallet.swap.err.gasRead', { error: humanizeFundError(chain.gasError) });
    else waiting = t('fundWallet.swap.wait.gas');
  } else if (zeroForOne && amountIn > maxEthSwapIn(eth, reserve)) {
    problem = eth <= reserve
      ? t('fundWallet.swap.err.nothingToSwap', { eth: fmtEth(eth), reserve: fmtEth(reserve), txs: String(GAS_RESERVE_TXS) })
      : t('fundWallet.swap.err.overMax', { max: fmtEth(maxEthSwapIn(eth, reserve), 8), reserve: fmtEth(reserve) });
  } else if (!zeroForOne && amountIn > (usdg as bigint)) problem = t('fundWallet.swap.err.overUsdg', { amount: fmtUsdg(usdg as bigint) });
  else if (!zeroForOne && !p2State) {
    if (allowError) problem = t('fundWallet.swap.err.allowRead', { error: humanizeFundError(allowError) });
    else waiting = t('fundWallet.swap.wait.allow');
  } else if (!zeroForOne && ethNeeded != null && eth < ethNeeded) {
    problem = eth === 0n
      ? t('fundWallet.swap.err.noEth')
      : t(txCount > 1 ? 'fundWallet.swap.err.lowEthMany' : 'fundWallet.swap.err.lowEthOne', {
          fee: fmtEth(networkFee as bigint, 8),
          count: txCount,
          mult: String(GAS_SAFETY_MULTIPLIER),
          need: fmtEth(ethNeeded, 8),
          eth: fmtEth(eth, 8),
        });
  } else if (priceCheck?.block) {
    problem = priceCheck.block;
  }

  const ready =
    hasAmount && !!quote && quoteFresh && !quoteStale && !problem && !waiting &&
    !!priceCheck && !priceCheck.block && quote.minAmountOut > 0n && !tx.busy && !prep.busy;

  const doSwap = async () => {
    if (!ready || !quote || !client || !gasPrice) return;
    const snap = quote;
    const gp = gasPrice;
    setLastSwap(null);
    const steps: FundStep[] = [];
    if (!zeroForOne) {
      // Fresh reads: the cached ones may predate an approval, a revoke or a spend made elsewhere.
      setPrep({ busy: true });
      try {
        const [st, bal] = await Promise.all([readUsdgPermit2State(client, me), client.getBalance({ address: me })]);
        const need = usdgSwapNeeds(st, snap.amountIn);
        const needEth = usdgToEthEthNeeded(gp, need);
        if (bal < needEth) {
          throw new Error(
            t('fundWallet.swap.err.prepLowEth', { count: usdgToEthTxCount(need), need: fmtEth(needEth, 8), eth: fmtEth(bal, 8) }),
          );
        }
        if (need.erc20Approve) {
          const a = usdgApprovalForSwap(st.erc20Allowance, snap.amountIn, st.sweep);
          steps.push({
            label: a.sized ? t('fundWallet.swap.steps.approveSized', { amount: fmtUsdg(a.amount) }) : t('fundWallet.swap.steps.approveOnce'),
            build: () => buildUsdgApprovePermit2Tx(a.amount),
          });
        }
        if (need.permit2Allowance) {
          steps.push({
            label: t('fundWallet.swap.steps.router', { amount: fmtUsdg(snap.amountIn) }),
            build: () => buildPermit2ApproveRouterTx(snap.amountIn, nowSec() + PERMIT2_ROUTER_TTL_SECONDS),
          });
        }
      } catch (e) {
        setPrep({ busy: false, error: humanizeFundError(e) });
        return;
      }
      setPrep({ busy: false });
    }
    const got = { netOut: snap.netOut, minAmountOut: snap.minAmountOut };
    steps.push({
      label: t('fundWallet.swap.steps.swap', { amount: fmtIn(snap.amountIn), in: inSym, out: outSym }),
      errorContext: { outSymbol: outSym, outDecimals: outDec },
      // Built right before it is simulated — possibly minutes after the click, behind approvals —
      // so re-quote, re-read the feed and the balance, and re-run every guard here.
      build: async () => {
        const [fresh, freshRef, bal] = await Promise.all([
          quoteWithProbe(client, zeroForOne, snap.amountIn, { feeBps: snap.feeBps, slippageBps: snap.slippageBps }),
          readEthUsdReference(client),
          client.getBalance({ address: me }),
        ]);
        if (zeroForOne) {
          const r = gasReserveWei(gp);
          if (snap.amountIn > maxEthSwapIn(bal, r)) {
            throw new Error(
              t('fundWallet.swap.err.reserveBreached', { bal: fmtEth(bal, 8), amount: fmtEth(snap.amountIn, 8), reserve: fmtEth(r) }),
            );
          }
        }
        const check = checkSwapPrice({ zeroForOne, fill: fresh.q, probe: fresh.probe, ref: freshRef, now: nowSec() });
        if (check.block) throw new Error(t('fundWallet.swap.err.blocked', { reason: check.block }));
        // Never below the minimum the user was shown, and never looser than the chosen slippage
        // from the price right now.
        const minAmountOut = fresh.q.minAmountOut > snap.minAmountOut ? fresh.q.minAmountOut : snap.minAmountOut;
        got.netOut = fresh.q.netOut;
        got.minAmountOut = minAmountOut;
        const p = { amountIn: snap.amountIn, minAmountOut, feeBps: snap.feeBps };
        return zeroForOne ? buildEthToUsdg(p) : buildUsdgToEth(p);
      },
    });
    void tx.run(steps, () => {
      setLastSwap({ netOut: got.netOut, minAmountOut: got.minAmountOut, outSym, outDec });
      setText('');
    });
  };

  const buttonLabel = tx.busy || prep.busy
    ? t('fundWallet.swap.button.working')
    : hasAmount
      ? txCount > 1
        ? t('fundWallet.swap.button.swapSteps', { amount: fmtIn(amountIn), in: inSym, out: outSym, count: txCount })
        : t('fundWallet.swap.steps.swap', { amount: fmtIn(amountIn), in: inSym, out: outSym })
      : t('fundWallet.swap.button.enterAmount');

  const probeText = zeroForOne ? `${fmtEth(impactProbeIn(true))} ETH` : `${fmtUsdg(impactProbeIn(false))} USDG`;
  const step1Text = approval?.sized
    ? p2State && p2State.erc20Allowance > 0n
      ? t('fundWallet.swap.step1.sizedKeep', { amount: fmtUsdg(approval.amount) })
      : t('fundWallet.swap.step1.sized', { amount: fmtUsdg(approval.amount) })
    : t('fundWallet.swap.step1.once');
  const stepState = (need: boolean): StepState => (!p2State ? 'checking' : need ? 'todo' : 'done');
  const showQuoteBox = hasAmount && (quoteFresh || !quoteQ.error);

  /* Network fee line: "≈ $0.0012 · 2 transactions at 0.0100 gwei · estimated · …" */
  const feeUsdText = networkFee != null && ethUsd6 ? `≈ ${formatUsd(weiToUsd6(networkFee, ethUsd6), 4)} · ` : '';
  const txText = gasPrice
    ? t(txCount > 1 ? 'fundWallet.swap.sub.txAtMany' : 'fundWallet.swap.sub.txAtOne', { count: txCount, gas: gweiText(gasPrice) })
    : t(txCount > 1 ? 'fundWallet.swap.sub.txMany' : 'fundWallet.swap.sub.txOne', { count: txCount });
  const networkFeeSub =
    `${feeUsdText}${txText}` +
    `${quoteQ.data?.gas ? '' : ` · ${t('fundWallet.swap.sub.estimated')}`}` +
    `${!zeroForOne && !p2State ? ` · ${t('fundWallet.swap.sub.assumesApprovals')}` : ''}`;
  const staleNote = Number.isFinite(quoteAgeMs)
    ? t(quoteQ.isError ? 'fundWallet.swap.stale.agoFailed' : 'fundWallet.swap.stale.ago', { n: Math.max(0, Math.round(quoteAgeMs / 1000)) })
    : t(quoteQ.isError ? 'fundWallet.swap.stale.earlierFailed' : 'fundWallet.swap.stale.earlier');
  const outDp = (dec: number) => (dec === 6 ? 6 : 8);
  const footerValues = {
    pct: pct(FEE_BPS),
    poolFee: poolFeePct,
    hours: CHAINLINK_MAX_AGE_SECONDS / 3600,
    priceBlock: pct(PRICE_BLOCK_BPS),
    impactBlock: pct(IMPACT_BLOCK_BPS),
  };

  return (
    <HoloCard
      title={t('fundWallet.swap.title')}
      icon={<Px rows={PX_BOLT} scale={2} />}
      accent={FEE_BPS > 0 ? t('fundWallet.swap.accentFee', { pct: pct(FEE_BPS) }) : t('fundWallet.swap.accentNoFee')}
      accentTone="info"
    >
      <div style={{ ...STACK, gap: 6 }}>
        <HoloSegmented
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'eth-to-usdg' as Direction, label: 'ETH → USDG' },
            { value: 'usdg-to-eth' as Direction, label: t('fundWallet.swap.dirTopUp') },
          ]}
          disabled={tx.busy}
          block
          ariaLabel={t('fundWallet.swap.dirAria')}
        />
        <span style={HINT}>
          {zeroForOne ? t('fundWallet.swap.hintToUsdg') : t('fundWallet.swap.hintToEth')}
        </span>
      </div>

      <div style={{ ...STACK, gap: 6 }}>
        <HoloLabel as="label" htmlFor="fund-swap-amount" font="chrome" style={{ fontSize: 18, color: INK.body }}>{t('fundWallet.swap.youPay')}</HoloLabel>
        <div style={ROW}>
          <HoloInput
            id="fund-swap-amount"
            value={text}
            inputMode="decimal"
            placeholder="0.0"
            spellCheck={false}
            autoComplete="off"
            disabled={tx.busy}
            onChange={(e) => setText(e.target.value)}
            suffix={inSym}
            inputSize="lg"
            invalid={text.trim() !== '' && amountIn == null}
            fieldStyle={{ flex: '1 1 190px', maxWidth: 280 }}
          />
          <HoloButton size="sm" disabled={!maxIn || tx.busy} onClick={() => maxIn && setText(formatUnits(maxIn, inDec))}>{t('fundWallet.swap.max')}</HoloButton>
          {!zeroForOne && TOPUP_PRESETS.map((d) => (
            <HoloButton key={d.toString()} size="sm" disabled={tx.busy} onClick={() => setText(d.toString())}>${d.toString()}</HoloButton>
          ))}
        </div>
        <span style={HINT}>
          {t('fundWallet.swap.balance', { amount: balanceIn == null ? '…' : `${zeroForOne ? fmtEth(balanceIn, 8) : fmtUsdg(balanceIn)} ${inSym}` })}
          {zeroForOne ? ` · ${t('fundWallet.swap.maxLeaves', { reserve: fmtEth(reserve) })}` : ''}
        </span>
      </div>

      <div style={ROW}>
        <HoloLabel font="chrome" style={{ fontSize: 18, color: INK.body }}>{t('fundWallet.swap.slippage')}</HoloLabel>
        <HoloSegmented<number>
          value={slippageBps}
          onChange={setSlippageBps}
          options={SLIPPAGE_CHOICES}
          format={(b) => pct(b).replace(/0+%$/, '%').replace(/\.%$/, '%')}
          size="sm"
          disabled={tx.busy}
          ariaLabel={t('fundWallet.swap.slippage')}
        />
        <span style={{ ...HINT, flex: '1 1 200px' }}>{t('fundWallet.swap.slippageHint')}</span>
      </div>

      {problem && <Hint warn>{problem}</Hint>}
      {!problem && waiting && <Hint>{waiting}</Hint>}
      {quoteQ.error && hasAmount && (
        <Hint warn>
          {quoteFresh
            ? t('fundWallet.swap.noQuoteStale', { error: humanizeFundError(quoteQ.error) })
            : t('fundWallet.swap.noQuote', { error: humanizeFundError(quoteQ.error) })}
        </Hint>
      )}

      {showQuoteBox && (
        <HoloScreen padding="8px 12px" style={{ opacity: quoteStale ? 0.55 : 1 }}>
          {!quote || !quoteFresh ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
              <span style={HINT}>{t('fundWallet.swap.quoting')}</span>
              <HoloProgress indeterminate onScreen height={10} ariaLabel={t('fundWallet.swap.quoting')} />
            </div>
          ) : (
            <>
              {quoteStale && (
                <div style={{ ...ROW, paddingBottom: 4 }}>
                  <HoloBadge label={t('fundWallet.swap.staleBadge')} tone="warn" variant="fill" />
                  <span style={HINT}>{staleNote}</span>
                </div>
              )}
              <QuoteLine
                label={t('fundWallet.swap.line.youPay')}
                value={`${fmtIn(quote.amountIn)} ${inSym}`}
                sub={ethUsd6 ? t('fundWallet.swap.sub.payUsd', { usd: formatUsd(zeroForOne ? weiToUsd6(quote.amountIn, ethUsd6) : quote.amountIn) }) : undefined}
              />
              <QuoteLine label={t('fundWallet.swap.line.poolOutput')} value={`${fmtOut(quote.grossOut)} ${outSym}`} sub={t('fundWallet.swap.sub.poolOutput')} />
              <QuoteLine label={t('fundWallet.swap.line.poolFee')} value={poolFeePct} sub={t('fundWallet.swap.sub.poolFee')} />
              <QuoteLine
                label={t('fundWallet.swap.line.spareFee')}
                value={FEE_BPS > 0 ? `${pct(FEE_BPS)} = ${fmtOut(quote.fee)} ${outSym}` : t('fundWallet.swap.sub.feeNone')}
                sub={FEE_BPS > 0 ? (zeroForOne ? t('fundWallet.swap.sub.fee') : t('fundWallet.swap.sub.feeWeth')) : undefined}
              />
              <QuoteLine label={t('fundWallet.swap.line.youReceive')} value={`≈ ${fmtOut(quote.netOut)} ${outSym}`} tone="good" big sub={t('fundWallet.swap.sub.receive')} />
              <QuoteLine
                label={t('fundWallet.swap.line.minReceived')}
                value={`${fmtOutMin(quote.minAmountOut)} ${outSym}`}
                sub={t('fundWallet.swap.sub.minReceived', { pct: pct(slippageBps) })}
              />
              {priceCheck?.poolUsd6 && (
                <QuoteLine
                  label={t('fundWallet.swap.line.price')}
                  value={`1 ETH = ${formatUsd(priceCheck.poolUsd6).slice(1)} USDG`}
                  tone={edge != null && edge < -PRICE_WARN_BPS ? 'warn' : undefined}
                  sub={
                    ref
                      ? edge != null
                        ? t('fundWallet.swap.sub.priceEdge', { usd: formatUsd(ref.usd6), age: ageText(t, priceCheck.refAgeSec ?? 0), edge: signedPct(edge) })
                        : t('fundWallet.swap.sub.priceOld', { usd: formatUsd(ref.usd6), age: ageText(t, priceCheck.refAgeSec ?? 0) })
                      : t('fundWallet.swap.sub.priceNoRef')
                  }
                />
              )}
              {impact != null && (
                <QuoteLine
                  label={t('fundWallet.swap.line.impact')}
                  value={pct(Math.max(0, impact))}
                  tone={impact > IMPACT_WARN_BPS ? 'warn' : undefined}
                  sub={t('fundWallet.swap.sub.impact', { probe: probeText, block: pct(IMPACT_BLOCK_BPS) })}
                />
              )}
              <QuoteLine
                label={t('fundWallet.swap.line.networkFee')}
                value={networkFee != null ? `≈ ${fmtEth(networkFee, 8)} ETH` : '…'}
                sub={networkFeeSub}
              />
            </>
          )}
        </HoloScreen>
      )}
      {edge != null && edge < -PRICE_WARN_BPS && edge >= -PRICE_BLOCK_BPS && (
        <Hint warn>{t('fundWallet.swap.warnEdge', { pct: pct(-edge) })}</Hint>
      )}
      {impact != null && impact > IMPACT_WARN_BPS && impact <= IMPACT_BLOCK_BPS && (
        <Hint warn>{t('fundWallet.swap.warnImpact', { pct: pct(impact) })}</Hint>
      )}

      {!zeroForOne && hasAmount && (
        <div style={{ ...STACK, gap: 6 }}>
          <SectionHead
            right={
              p2State
                ? t(txCount > 1 ? 'fundWallet.swap.sub.txMany' : 'fundWallet.swap.sub.txOne', { count: txCount })
                : t('fundWallet.swap.upToTxs', { count: txCount })
            }
          >
            {t('fundWallet.swap.walletAsks')}
          </SectionHead>
          <StepLine n={1} state={stepState(needs.erc20Approve)} text={step1Text} doneText={t('fundWallet.swap.approvedSkipped')} />
          <StepLine
            n={2}
            state={stepState(needs.permit2Allowance)}
            text={t('fundWallet.swap.step2', { amount: fmtUsdg(amountIn), min: PERMIT2_ROUTER_TTL_SECONDS / 60 })}
            doneText={t('fundWallet.swap.allowanceSkipped')}
          />
          <StepLine n={3} state="todo" text={t('fundWallet.swap.step3')} />
        </div>
      )}

      <HoloPanel variant="glass" padding="10px 12px" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <HoloBadge
          label={
            ready
              ? t('fundWallet.swap.badge.live')
              : tx.busy
                ? t('fundWallet.swap.badge.inProgress')
                : quoteStale && quoteFresh
                  ? t('fundWallet.swap.badge.stale')
                  : t('fundWallet.swap.badge.notReady')
          }
          tone={ready ? 'good' : tx.busy || (quoteStale && quoteFresh) ? 'warn' : 'muted'}
          pulse={ready || tx.busy}
          size="md"
        />
        <span style={{ ...HINT, flex: '1 1 180px', minWidth: 0 }}>
          {t('fundWallet.swap.deadline', { min: FUND_SWAP_DEADLINE_SECONDS / 60 })}
        </span>
        <HoloButton variant="primary" disabled={!ready} onClick={doSwap} style={{ maxWidth: '100%' }}>{buttonLabel}</HoloButton>
      </HoloPanel>
      {prep.error && <Hint warn>{prep.error}</Hint>}
      <TxStatus state={tx.state} onDismiss={() => { tx.reset(); setLastSwap(null); }} />
      {tx.state.phase === 'confirmed' && lastSwap && (
        <HoloNotice tone="success" compact live="none">
          {t('fundWallet.swap.swapped', {
            expected: formatToken(lastSwap.netOut, lastSwap.outDec, outDp(lastSwap.outDec)),
            sym: lastSwap.outSym,
            min: formatToken(floorToDp(lastSwap.minAmountOut, lastSwap.outDec, outDp(lastSwap.outDec)), lastSwap.outDec, outDp(lastSwap.outDec)),
          })}
        </HoloNotice>
      )}

      <span style={HINT}>
        {FEE_BPS > 0 ? (
          <Trans
            t={t}
            i18nKey="fundWallet.swap.footer.feeRoute"
            values={footerValues}
            components={{ vault: <AddrLink address={FEE_VAULT} />, router: <AddrLink address={UNIVERSAL_ROUTER} /> }}
          />
        ) : (
          <Trans t={t} i18nKey="fundWallet.swap.footer.noFeeRoute" values={footerValues} components={{ router: <AddrLink address={UNIVERSAL_ROUTER} /> }} />
        )}
      </span>
    </HoloCard>
  );
}

type StepState = 'todo' | 'done' | 'checking';

function StepLine({ n, state, text, doneText }: { n: number; state: StepState; text: string; doneText?: string }) {
  const { t } = useTranslation('apps-a');
  const done = state === 'done';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 8px', background: HOLO.paper, boxShadow: BEVEL_SUNKEN }}>
      <NumTile n={n} ok={done} size={22} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'baseline', paddingTop: 2 }}>
        <span style={{ ...HINT, fontSize: 11.5, color: done ? INK.muted : INK.body, textDecoration: done ? 'line-through' : 'none' }}>{text}</span>
        {done && doneText && <span style={{ ...HINT, fontWeight: 700, color: INK.good }}>{doneText}</span>}
        {state === 'checking' && <span style={HINT}>{t('fundWallet.swap.checking')}</span>}
      </div>
    </div>
  );
}

export default FundWalletApp;
