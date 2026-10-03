/**
 * Spare engine reads — live, read-only views of the Spare contracts on
 * Robinhood Chain mainnet. Every figure here is read from the chain at the
 * block reported in `readAt`. (tools.ts reuses universe / activity / fees
 * results for a few seconds; `readAt` always names the block a result was
 * read at.)
 *
 * Response shapes (documented per tool in docs/MCP_TOOLS.md): the flat fields
 * the site reads (e.g. `oracleStatus`, `price`, `parkedUsd`, `expectedOut`)
 * sit next to the detailed nested objects.
 *
 * Units: USDG 6 dp, stock tokens 18 dp (raw, never rebased), Chainlink 8 dp
 * normalised to 1e18 by StockRouter.oracleStatus. Stock feeds already quote
 * the multiplier-adjusted per-token price, so the UI multiplier is applied
 * only to show "shares", never to a price.
 */
import {
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  aggregatorV3Abi,
  assetRegistryAbi,
  feeVaultAbi,
  cashParkAbi,
  electionRegistryAbi,
  erc20Abi,
  parkAdapterAbi,
  permit2Abi,
  ruleRegistryAbi,
  screeningGateAbi,
  spareAuthAbi,
  stateViewAbi,
  stockRouterAbi,
  stockTokenAbi,
  sweepExecutorAbi,
  v4QuoterAbi,
} from './abis.js';
import {
  ACTIVATION_BAR_BPS,
  EXPLORER_URL,
  FUND_WALLET_FEE_BPS,
  REFERENCE_FEEDS,
  ORACLE_LABELS,
  ORACLE_STATUS,
  KEEPER_QUOTE_TOLERANCE_BPS,
  LOG_CHUNK_BLOCKS,
  SPARE_CHAIN_ID,
  STALENESS_GRACE_SECONDS,
  STOCK_DECIMALS,
  USDG_DECIMALS,
  USDG_UNIT,
  VENUE,
  WETH,
  explorerAddress,
  explorerTx,
  getBook,
  resolveAsset,
  symbolOf,
  type SpareBook,
  type SpareContractName,
} from './book.js';
import { getSpareClient } from './client.js';
import { cleanTokenName, loadAssetDirectory, makeDirectory, rememberDirectory, type AssetDirectory } from './assets.js';
import {
  ACTIVITY_KINDS,
  ACTIVITY_MAX_CALLS,
  activityWindow,
  chunkRange,
  topic0,
  MAX_ACTIVITY_DAYS,
  MAX_ACTIVITY_LIMIT,
  pageNewestFirst,
  scanActivity,
  type ActivityItem,
  type ActivityKind,
} from './logs.js';
import { formatUnitsExact, parseUnitsExact, SpareInputError, usdg } from './roundup.js';
import { keeperMarketHoursGate, marketView, sessionView, type MarketView } from './marketHours.js';
import {
  accountLegPlans,
  assetVerdict,
  DYNAMIC_FEE_FLAG,
  KEEPER_QUOTE_MAX_SHORTFALL_BPS,
  KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS,
  KEEPER_SWEEP_MAX_IMPACT_BPS,
  legPlan,
  multiplierView,
  poolFeePips,
  quoteCheckView,
  REF_SWAP_IN,
  splitMix,
  swapInFor,
  type LegOutcome,
  type MultiplierState,
} from './keeperRules.js';
import { safeErrorMessage } from '../redact.js';
import { aggregate3, isRevert, type Call, type Res } from './multicall.js';

// ─── helpers ──────────────────────────────────────────────────────────────

export { ORACLE_STATUS };

/**
 * What to call a price right now. "LIVE" only when OracleGuard says OK AND
 * the keeper's market-hours gate is open: OracleGuard keeps a frozen Friday
 * close at OK for up to ~25 h, and the keeper does not buy against it.
 */
export function oracleLabelFor(status: number, market: Pick<MarketView, 'open'> | null): string {
  if (status !== 0) return ORACLE_LABELS[status] ?? 'unknown';
  return market && !market.open ? 'market closed' : 'LIVE';
}
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Batched reads (multicall.ts): a revert fails its own call; an eth_call that
 * fails at the RPC throws, so the read fails instead of reporting every field
 * at its default as if the chain said so.
 */
const multi = aggregate3;

const val = <T>(r: Res | undefined, fallback: T): T => (r && r.ok ? (r.value as T) : fallback);

/** A token's ERC-8056 state from its three reads; null when any failed (the keeper then waits). */
function multiplierOf(ui: Res | undefined, effectiveAt: Res | undefined, newUi: Res | undefined): MultiplierState | null {
  if (!ui?.ok || !effectiveAt?.ok || !newUi?.ok) return null;
  return { uiMultiplier: ui.value as bigint, effectiveAt: effectiveAt.value as bigint, newUIMultiplier: newUi.value as bigint };
}

function requireAddress(input: unknown, label = 'address'): Address {
  const s = String(input ?? '').trim();
  if (!isAddress(s, { strict: false })) throw new SpareInputError(`${label} must be a 0x address`);
  return getAddress(s.toLowerCase());
}

/** The registry, named (cached ~1 min; see assets.ts). Every read that prints a ticker loads it first. */
function directory(client: PublicClient, book: SpareBook): Promise<AssetDirectory> {
  return loadAssetDirectory(client, book.contracts.AssetRegistry);
}

/**
 * ETF / fund vs single stock, from the token's name() (fund issuers and
 * wrappers name themselves; operating companies don't). Same rule as the
 * frontend's universe.ts, checked there against all 203 tokenized assets.
 */
const FUND_WORDS = /\b(ETF|ETN|Fund|Trust|iShares|SPDR|Invesco|Vanguard|ProShares|Direxion|WisdomTree|VanEck|Roundhill|Schwab|Global X)\b/i;
export function assetKind(name: string | null | undefined): 'etf' | 'stock' {
  return name && FUND_WORDS.test(name) ? 'etf' : 'stock';
}

/** $100: the size a standby asset's pool is measured at. */
const STANDBY_PROBE_USDG = 100n * USDG_UNIT;

/**
 * Why a registered asset is not active, from what the chain says now.
 * `shortfallBps`: how many bps FEWER tokens $100 through the pinned pool buys
 * than the oracle price (null = the pool returned no quote, undefined = not
 * measured / no oracle price to compare).
 */
export function standbyReason(shortfallBps: number | null | undefined, bandBps: number | null | undefined): string {
  if (shortfallBps === undefined) return 'Registered but not active: it cannot be elected or bought until the owner activates it.';
  if (shortfallBps === null) return 'Registered but not active: its pinned pool returns no quote right now.';
  const pct = (bps: number) => `${(Math.abs(bps) / 100).toFixed(2)}%`;
  const band = bandBps ?? 150;
  if (shortfallBps > band) {
    return `Registered but not active: $100 through its pinned pool buys ${pct(shortfallBps)} fewer tokens than Chainlink's price, outside the ${band / 100}% oracle band.`;
  }
  if (shortfallBps > ACTIVATION_BAR_BPS) {
    return `Registered but not active: $100 through its pinned pool buys ${pct(shortfallBps)} fewer tokens than Chainlink's price, past the ${ACTIVATION_BAR_BPS / 100}% activation bar.`;
  }
  return `Registered but not active: its pinned pool fills within ${pct(shortfallBps)} of Chainlink at $100 right now; activation is an owner decision.`;
}

const tokens18 = (v: bigint) => formatUnitsExact(v, STOCK_DECIMALS);
const price = (p1e18: bigint) => formatUnitsExact(p1e18, 18);
const iso = (unixSeconds: bigint | number) => new Date(Number(unixSeconds) * 1000).toISOString();

interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
interface RegistryAsset {
  token: Address;
  feed: Address;
  feedDecimals: number;
  heartbeat: number;
  bandBps: number;
  active: boolean;
  poolKey: PoolKey;
}

/** Uniswap v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
      ],
      [key],
    ),
  );
}

/** A v4 fee in pips (1e6 = 100%) as a percent string: 500 -> "0.05%". */
const pipsPct = (pips: number) => `${pips / 10_000}%`;

/**
 * A pinned pool as the API reports it. `fee` is the PoolKey's fee field
 * verbatim: with currency0/1, tickSpacing and hooks it IS the PoolKey, and
 * poolId hashes it. For a dynamic-fee pool that field is v4's
 * DYNAMIC_FEE_FLAG (0x800000 = 8388608), not a rate: `feePct` then says
 * "dynamic" and `lpFee` / `lpFeePct` carry the hook's current LP fee from
 * StateView.getSlot0 (null when slot0 was not read). For a static pool
 * `lpFee` is the PoolKey fee. Fees in pips (1e6 = 100%).
 */
export function poolView(key: PoolKey, slot0?: Res) {
  const fee = Number(key.fee);
  const dynamicFee = fee === DYNAMIC_FEE_FLAG;
  const s0 = dynamicFee ? val<readonly [bigint, number, number, number] | null>(slot0, null) : null;
  const lpFee = dynamicFee ? (s0 ? Number(s0[3]) : null) : fee;
  return {
    poolId: poolIdOf(key),
    currency0: key.currency0,
    currency1: key.currency1,
    fee,
    feePct: dynamicFee ? 'dynamic' : pipsPct(fee),
    /** The hook sets the LP fee (PoolKey fee = DYNAMIC_FEE_FLAG); it can change between reads. */
    dynamicFee,
    /** The LP fee a swap pays now, pips; null for a dynamic-fee pool whose slot0 was not read. */
    lpFee,
    lpFeePct: lpFee === null ? null : pipsPct(lpFee),
    tickSpacing: Number(key.tickSpacing),
    hooks: key.hooks,
    hooked: key.hooks.toLowerCase() !== ZERO,
  };
}

/** V4Quoter.quoteExactInputSingle for `swapIn` USDG through a pinned pool (USDG in), as a multicall entry. */
function quoteCall(key: PoolKey, usdgToken: Address, swapIn: bigint): Call {
  return {
    address: VENUE.v4Quoter,
    abi: v4QuoterAbi as Abi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne: key.currency0.toLowerCase() === usdgToken.toLowerCase(), exactAmount: swapIn, hookData: '0x' }],
  };
}

/** amountOut of a quoteCall result; null when the swap would not quote. */
const quotedOut = (r: Res | undefined): bigint | null => (r?.ok ? (r.value as readonly [bigint, bigint])[0] : null);

/** The pinned pool's swap fee for USDG in, pips, from StateView.getSlot0 (keeper.ts marketOf). */
function feePipsOf(key: PoolKey, usdgToken: Address, slot0: Res | undefined): number {
  const s0 = val<readonly [bigint, number, number, number] | null>(slot0, null);
  return poolFeePips({
    keyFee: Number(key.fee),
    zeroForOne: key.currency0.toLowerCase() === usdgToken.toLowerCase(),
    slot0: s0 ? { protocolFee: Number(s0[2]), lpFee: Number(s0[3]) } : undefined,
  });
}

/** Tokens a USDG amount buys at an oracle price — StockRouter.oracleTokensFor. */
export function oracleTokensFor(usdgIn: bigint, price1e18: bigint): bigint {
  if (price1e18 === 0n) return 0n;
  return (usdgIn * 10n ** 12n * 10n ** 18n) / price1e18;
}

/** USDG value of raw stock tokens at an oracle price — StockRouter.oracleUsdgFor. */
export function oracleUsdgFor(tokensIn: bigint, price1e18: bigint): bigint {
  return (tokensIn * price1e18) / 10n ** 18n / 10n ** 12n;
}

async function head(client: PublicClient): Promise<{ block: bigint; timestamp: bigint }> {
  const b = await client.getBlock({ blockTag: 'latest' });
  return { block: b.number ?? 0n, timestamp: b.timestamp };
}

// ─── spare_universe ───────────────────────────────────────────────────────

export async function readUniverse(opts: { includeInactive?: unknown } = {}, client: PublicClient = getSpareClient()) {
  const includeInactive = !(opts.includeInactive === false || opts.includeInactive === 'false' || opts.includeInactive === '0');
  const book = getBook();
  const c = book.contracts;
  const at = await head(client);
  const tokens = (await client.readContract({
    address: c.AssetRegistry,
    abi: assetRegistryAbi,
    functionName: 'tokens',
    blockNumber: at.block,
  })) as Address[];

  const perToken: Call[] = tokens.flatMap((t) => [
    { address: c.AssetRegistry, abi: assetRegistryAbi as Abi, functionName: 'get', args: [t] },
    { address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'oracleStatus', args: [t] },
    { address: t, abi: erc20Abi as Abi, functionName: 'symbol' },
    { address: t, abi: erc20Abi as Abi, functionName: 'name' },
    { address: t, abi: stockTokenAbi as Abi, functionName: 'uiMultiplier' },
    { address: t, abi: stockTokenAbi as Abi, functionName: 'paused' },
    { address: t, abi: stockTokenAbi as Abi, functionName: 'oraclePaused' },
    { address: t, abi: stockTokenAbi as Abi, functionName: 'effectiveAt' },
    { address: t, abi: stockTokenAbi as Abi, functionName: 'newUIMultiplier' },
  ]);
  const shared: Call[] = [
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'threshold' },
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'feeBps' },
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'slippageBps' },
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'epochLength' },
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'currentEpoch' },
    { address: c.SweepExecutor, abi: spareAuthAbi as Abi, functionName: 'paused' },
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'isFresh' },
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'adapter' },
    { address: c.ElectionRegistry, abi: electionRegistryAbi as Abi, functionName: 'defaultMix' },
    { address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'sequencerFeed' },
  ];
  const r = await multi(client, [...perToken, ...shared], at.block);
  const N = 9;

  const assets = tokens.map((t, i) => {
    const base = i * N;
    const a = val<RegistryAsset | null>(r[base], null);
    const [status, p1e18] = val<[number, bigint]>(r[base + 1], [4, 0n]);
    return { t, a, status, p1e18, r: r.slice(base, base + N) };
  });
  // The same read names every token for the other tools (activity, account, quote).
  rememberDirectory(
    makeDirectory(
      assets.map(({ t, a, r: rr }) => ({
        token: getAddress(t),
        symbol: val<string>(rr[2], '').trim(),
        name: cleanTokenName(val<string>(rr[3], '')),
        active: a?.active ?? false,
        feed: a?.feed ? getAddress(a.feed) : null,
        bandBps: a ? Number(a.bandBps) : null,
      })),
    ),
  );

  // Feed timestamps (second round: the feed address comes from the registry),
  // plus a $100 quote through each STANDBY asset's pinned pool, to say why it
  // waits, and slot0 of each DYNAMIC-fee pool (its PoolKey fee is a flag; the
  // hook's current LP fee is in slot0). Same eth_call, no extra request.
  const feedCalls: Call[] = assets.map(({ a }) => ({
    address: (a?.feed ?? ZERO) as Address,
    abi: aggregatorV3Abi as Abi,
    functionName: 'latestRoundData',
  }));
  const standby = assets.filter(({ a }) => a && !a.active && a.poolKey);
  const quoteCalls: Call[] = standby.map(({ a }) => quoteCall(a!.poolKey, book.external.USDG, STANDBY_PROBE_USDG));
  const dynamic = assets.filter(({ a }) => a?.poolKey && Number(a.poolKey.fee) === DYNAMIC_FEE_FLAG);
  const slot0Calls: Call[] = dynamic.map(({ a }) => ({
    address: VENUE.v4StateView,
    abi: stateViewAbi as Abi,
    functionName: 'getSlot0',
    args: [poolIdOf(a!.poolKey)],
  }));
  const fq = await multi(client, [...feedCalls, ...quoteCalls, ...slot0Calls], at.block);
  const feeds = fq.slice(0, feedCalls.length);
  const standbyOut = new Map(standby.map(({ t }, i) => [t.toLowerCase(), fq[feedCalls.length + i]]));
  const slot0Of = new Map(dynamic.map(({ t }, i) => [t.toLowerCase(), fq[feedCalls.length + quoteCalls.length + i]]));

  const s = r.slice(tokens.length * N);
  const adapter = val<Address>(s[7], ZERO);
  const defaultMix = val<Array<{ asset: Address; bps: number }>>(s[8], []);

  const mixBps = new Map(defaultMix.map((l) => [l.asset.toLowerCase(), Number(l.bps)]));

  const gate = keeperMarketHoursGate();
  const rows = assets.map(({ t, a, status, p1e18, r: rr }, i) => {
      const round = val<[bigint, bigint, bigint, bigint, bigint] | null>(feeds[i], null);
      const updatedAt = round ? round[3] : 0n;
      const ageSec = updatedAt > 0n && at.timestamp >= updatedAt ? Number(at.timestamp - updatedAt) : null;
      const heartbeat = a?.heartbeat ?? 0;
      const symbol = val<string>(rr[2], symbolOf(t, book) ?? '?');
      const ui = val<bigint>(rr[4], 0n);
      const key = a?.poolKey;
      const lastAnswer = round && round[1] > 0n ? formatUnitsExact(round[1], a?.feedDecimals ?? 8) : null;
      const market = marketView(Number(at.timestamp), round ? Number(updatedAt) : null, gate);
      const label = oracleLabelFor(status, market);
      const active = a?.active ?? false;
      // The keeper's per-asset gate (keeperRules.ts assetVerdict): oracle, market hours, multiplier change.
      const multiplier = multiplierOf(rr[4], rr[7], rr[8]);
      const verdict = assetVerdict({
        nowSec: Number(at.timestamp),
        active: a ? a.active : null,
        oracleStatus: Number(status),
        feedUpdatedAt: round ? Number(updatedAt) : null,
        market,
        multiplier,
      });
      // Standby: measure $100 through the pinned pool against the guarded price, else the feed's last answer.
      let inactiveReason: string | null = null;
      if (a && !a.active) {
        const q = standbyOut.get(t.toLowerCase());
        const oracle1e18 = status === 0 && p1e18 > 0n ? p1e18 : round && round[1] > 0n ? round[1] * 10n ** BigInt(18 - (a.feedDecimals ?? 8)) : 0n;
        const out = q && q.ok ? (q.value as readonly [bigint, bigint])[0] : null;
        const atOracle = oracle1e18 > 0n ? oracleTokensFor(STANDBY_PROBE_USDG, oracle1e18) : 0n;
        const shortfall =
          q === undefined || (out !== null && atOracle === 0n)
            ? undefined
            : out === null || out === 0n
              ? null
              : Number(((atOracle - out) * 1_000_000n) / atOracle) / 100; // bps, 2 dp
        inactiveReason = standbyReason(shortfall, a.bandBps);
      }
      const rawName = val<string>(rr[3], '');
      return {
        symbol,
        name: rawName,
        kind: assetKind(cleanTokenName(rawName)),
        token: t,
        active,
        state: a ? (a.active ? 'active' : 'registered_inactive') : 'unknown',
        inactiveReason,
        defaultMixBps: mixBps.get(t.toLowerCase()) ?? 0,
        // Flat fields the site reads.
        feed: a?.feed ?? null,
        heartbeatSec: heartbeat,
        bandBps: a?.bandBps ?? null,
        /** OracleGuard.Status: 0 OK, 1 STALE, 2 PAUSED, 3 SEQUENCER_DOWN, 4 BAD_ANSWER. */
        oracleStatus: Number(status),
        oracleLabel: label,
        price: status === 0 ? price(p1e18) : null,
        lastAnswer,
        lastUpdatedAt: updatedAt > 0n ? iso(updatedAt) : null,
        marketOpen: market.open,
        sessionOpenedAt: market.sessionOpenedAt,
        /**
         * Active and past every per-asset gate of the keeper: oracle OK, inside the
         * market-hours gate, no ERC-8056 multiplier change pending. The per-size
         * quote check (B-L3) is spare_quote's / spare_account's.
         */
        buyableNow: active && verdict.state === 'ok',
        /** The keeper's state for a leg of this asset: ok, wait (the account waits) or settle (inactive). */
        keeperState: verdict.state,
        waitReason: verdict.state === 'wait' ? verdict.why : null,
        multiplierChange: multiplierView(multiplier, verdict.splitPending),
        market,
        pool: key ? poolView(key, slot0Of.get(t.toLowerCase())) : null,
        oracle: {
          feed: a?.feed ?? null,
          status: ORACLE_STATUS[status] ?? `UNKNOWN(${status})`,
          label,
          onChainLabel: ORACLE_LABELS[status] ?? 'unknown',
          priceUsd: status === 0 ? price(p1e18) : null,
          lastAnswerUsd: lastAnswer,
          updatedAt: updatedAt > 0n ? iso(updatedAt) : null,
          ageSeconds: ageSec,
          heartbeatSeconds: heartbeat,
          staleAfterSeconds: heartbeat + STALENESS_GRACE_SECONDS,
          bandBps: a?.bandBps ?? null,
        },
        tokenFlags: {
          uiMultiplier: ui > 0n ? formatUnitsExact(ui, 18) : null,
          paused: val<boolean | null>(rr[5], null),
          oraclePaused: val<boolean | null>(rr[6], null),
        },
        explorer: explorerAddress(t),
      };
    });

  return {
    chainId: SPARE_CHAIN_ID,
    readAt: { block: at.block.toString(), timestamp: iso(at.timestamp) },
    registry: book.contracts.AssetRegistry,
    counts: { registered: rows.length, active: rows.filter((r) => r.active).length },
    assets: includeInactive ? rows : rows.filter((r) => r.active),
    sweep: {
      thresholdUsd: usdg(val<bigint>(s[0], 0n)),
      conversionFeeBps: Number(val<number>(s[1], 0)),
      slippageBps: Number(val<number>(s[2], 0)),
      epochLengthSeconds: Number(val<bigint>(s[3], 0n)),
      currentEpoch: val<bigint>(s[4], 0n).toString(),
      paused: val<boolean | null>(s[5], null),
    },
    park: {
      adapter,
      adapterName: adapterName(book, adapter),
      navFresh: val<boolean | null>(s[6], null),
    },
    defaultMix: defaultMix.map((l) => ({
      symbol: symbolOf(l.asset, book),
      asset: l.asset,
      bps: Number(l.bps),
      pct: `${Number(l.bps) / 100}%`,
    })),
    sequencerFeed: val<Address>(s[9], ZERO),
    market: sessionView(Number(at.timestamp), gate),
    notes: [
      'The universe is whatever AssetRegistry holds: this list is read live, never from a fixed list. inactiveReason is measured now ($100 through the pinned pool vs Chainlink).',
      'Stock feeds quote the multiplier-adjusted per-token price; the UI multiplier is never applied to a price.',
      "ERC-8056 multiplier changes: the keeper does not buy an asset from 15 minutes before a scheduled change until its Chainlink feed has posted after the change took effect (multiplierChange.pending); buyableNow is false meanwhile.",
      'Feeds update on 0.5% deviation or a 24h heartbeat, so an age of several hours is normal. Stock feeds are 24/5.',
      "oracleLabel is LIVE only when OracleGuard says OK AND the keeper's market-hours gate is open (US-equities 24/5 session, Sunday 20:00 to Friday 20:00 ET, with a feed update since the open). OracleGuard keeps a frozen Friday close at OK for up to ~25 h; the keeper does not buy against it.",
      'A registered_inactive asset cannot be elected or bought.',
    ],
  };
}

function adapterName(book: SpareBook, adapter: string): SpareContractName | null {
  for (const [name, a] of Object.entries(book.contracts)) {
    if (a.toLowerCase() === adapter.toLowerCase()) return name as SpareContractName;
  }
  return null;
}

// ─── spare_account ────────────────────────────────────────────────────────

interface Rule {
  roundTo: number;
  multiplier: number;
  weeklyCap: bigint;
  enabled: boolean;
}

export async function readAccount(input: unknown, client: PublicClient = getSpareClient()) {
  const book = getBook();
  const c = book.contracts;
  const asked = requireAddress(input, 'address');
  const [at] = await Promise.all([head(client), directory(client, book).catch(() => null)]);

  // A linked spending wallet resolves to the account it feeds.
  const [walletsOfAsked, accountOfAsked] = await multi(
    client,
    [
      { address: c.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'walletsOf', args: [asked] },
      { address: c.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'accountOf', args: [asked] },
    ],
    at.block,
  );
  const owned = val<Address[]>(walletsOfAsked, []);
  const feeds = val<Address>(accountOfAsked, ZERO);
  const account =
    owned.length === 0 && feeds.toLowerCase() !== ZERO && feeds.toLowerCase() !== asked.toLowerCase()
      ? getAddress(feeds)
      : asked;

  const tokens = (await client.readContract({
    address: c.AssetRegistry,
    abi: assetRegistryAbi,
    functionName: 'tokens',
    blockNumber: at.block,
  })) as Address[];
  const USDG = book.external.USDG;

  const core: Call[] = [
    { address: c.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'ruleOf', args: [account] }, // 0
    { address: c.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'walletsOf', args: [account] }, // 1
    { address: c.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'activeSince', args: [account] }, // 2
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'pending', args: [account] }, // 3
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'units', args: [account] }, // 4
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'valueOf', args: [account] }, // 5
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'isFresh' }, // 6
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'remainingWeeklyCap', args: [account] }, // 7
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'pulledLast7Days', args: [account] }, // 8
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'sweptEpoch', args: [account] }, // 9
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'currentEpoch' }, // 10
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'threshold' }, // 11
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'epochLength' }, // 12
    { address: c.ElectionRegistry, abi: electionRegistryAbi as Abi, functionName: 'mixOf', args: [account] }, // 13
    { address: c.ElectionRegistry, abi: electionRegistryAbi as Abi, functionName: 'hasOwnMix', args: [account] }, // 14
    { address: c.ScreeningGate, abi: screeningGateAbi as Abi, functionName: 'isEligible', args: [account] }, // 15
    { address: c.ScreeningGate, abi: screeningGateAbi as Abi, functionName: 'enforced' }, // 16
    { address: c.ScreeningGate, abi: screeningGateAbi as Abi, functionName: 'clearedUntil', args: [account] }, // 17
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'claimable', args: [account, USDG] }, // 18
    { address: USDG, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [account] }, // 19
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'feeBps' }, // 20
  ];
  const CORE = core.length;
  const PER = 5;
  const perToken: Call[] = tokens.flatMap((t) => [
    { address: t, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [account] },
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'claimable', args: [account, t] },
    { address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'oracleStatus', args: [t] },
    { address: t, abi: stockTokenAbi as Abi, functionName: 'uiMultiplier' },
    { address: c.AssetRegistry, abi: assetRegistryAbi as Abi, functionName: 'get', args: [t] },
  ]);
  const r = await multi(client, [...core, ...perToken, { address: c.SweepExecutor, abi: spareAuthAbi as Abi, functionName: 'paused' }], at.block);
  const executorPaused = val<boolean | null>(r[CORE + tokens.length * PER], null);

  const rule = val<Rule | null>(r[0], null);
  const wallets = val<Address[]>(r[1], []);
  const ruleSet = !!rule && [1, 5, 10].includes(Number(rule.roundTo)) && Number(rule.multiplier) >= 1;
  const ruleActive = !!rule && rule.enabled && rule.weeklyCap > 0n;
  const pending = val<bigint>(r[3], 0n);
  const units = val<bigint>(r[4], 0n);
  const value = val<bigint>(r[5], 0n);
  const remaining = val<bigint>(r[7], 0n);
  const pulled7d = val<bigint>(r[8], 0n);
  const sweptEpoch = val<bigint>(r[9], 0n);
  const currentEpoch = val<bigint>(r[10], 0n);
  const threshold = val<bigint>(r[11], 0n);
  const mix = val<Array<{ asset: Address; bps: number }>>(r[13], []);
  const clearedUntil = val<bigint>(r[17], 0n);

  // Per-wallet consent and cursor state.
  const walletCalls: Call[] = wallets.flatMap((w) => [
    { address: c.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'linkedAt', args: [w] },
    { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'lastAccruedBlock', args: [w] },
    { address: book.external.Permit2, abi: permit2Abi as Abi, functionName: 'allowance', args: [w, USDG, c.SweepExecutor] },
    { address: USDG, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [w] },
    { address: USDG, abi: erc20Abi as Abi, functionName: 'allowance', args: [w, book.external.Permit2] },
  ]);
  const wr = await multi(client, walletCalls, at.block);

  const claimables: Array<{ symbol: string | null; token: Address; amount: string }> = [];
  const usdgClaim = val<bigint>(r[18], 0n);
  if (usdgClaim > 0n) claimables.push({ symbol: 'USDG', token: USDG, amount: usdg(usdgClaim) });

  let holdingsValue = 0n;
  const oracleByToken = new Map<string, { status: number; price1e18: bigint; reg: RegistryAsset | null }>();
  const holdings = tokens.map((t, i) => {
    const base = CORE + i * PER;
    const bal = val<bigint>(r[base], 0n);
    const claim = val<bigint>(r[base + 1], 0n);
    const [status, p1e18] = val<[number, bigint]>(r[base + 2], [4, 0n]);
    const ui = val<bigint>(r[base + 3], 0n);
    const reg = val<RegistryAsset | null>(r[base + 4], null);
    oracleByToken.set(t.toLowerCase(), { status: Number(status), price1e18: p1e18, reg });
    if (claim > 0n) claimables.push({ symbol: symbolOf(t, book), token: t, amount: tokens18(claim) });
    const valueUsdg = status === 0 ? oracleUsdgFor(bal, p1e18) : null;
    if (valueUsdg !== null) holdingsValue += valueUsdg;
    return {
      symbol: symbolOf(t, book),
      token: t,
      balance: tokens18(bal),
      shares: ui > 0n ? tokens18((bal * ui) / 10n ** 18n) : null,
      priceUsd: status === 0 ? price(p1e18) : null,
      valueUsd: valueUsdg === null ? null : usdg(valueUsdg),
      oracleStatus: ORACLE_STATUS[status] ?? `UNKNOWN(${status})`,
    };
  });

  // Would the keeper sweep this account now? Every mix leg in the keeper's
  // order (keeperRules.ts legPlan): inactive -> settle (never blocks); feed or
  // multiplier state unreadable, oracle not OK, market closed or a multiplier
  // change not yet in the feed -> wait (the sweep is all-or-nothing); a pool
  // or a leg quote too far under the oracle -> hold (B-L3). The size checks
  // are for this account's own legs (its parked value split by the mix, fee
  // off), quoted at the read block. One multicall: per leg the feed, the
  // token's ERC-8056 state, the pool's slot0, a $1 and a leg-size quote.
  const gate = keeperMarketHoursGate();
  const feeBps = BigInt(val<number>(r[20], 25));
  const grossOf = new Map<string, bigint>();
  for (const s of splitMix(value, mix)) {
    const k = s.asset.toLowerCase();
    grossOf.set(k, (grossOf.get(k) ?? 0n) + s.usdg);
  }
  const legReads = mix.map((l) => {
    const o = oracleByToken.get(l.asset.toLowerCase());
    const key = o?.reg?.active ? o.reg.poolKey : undefined;
    const swapIn = swapInFor(grossOf.get(l.asset.toLowerCase()) ?? 0n, feeBps);
    const calls: Call[] = [
      { address: (o?.reg?.feed ?? ZERO) as Address, abi: aggregatorV3Abi as Abi, functionName: 'latestRoundData' },
      { address: l.asset, abi: stockTokenAbi as Abi, functionName: 'uiMultiplier' },
      { address: l.asset, abi: stockTokenAbi as Abi, functionName: 'effectiveAt' },
      { address: l.asset, abi: stockTokenAbi as Abi, functionName: 'newUIMultiplier' },
    ];
    // Only an active leg is ever quoted by the keeper.
    if (key) {
      calls.push({ address: VENUE.v4StateView, abi: stateViewAbi as Abi, functionName: 'getSlot0', args: [poolIdOf(key)] });
      calls.push(quoteCall(key, USDG, REF_SWAP_IN));
      if (swapIn > 0n) calls.push(quoteCall(key, USDG, swapIn));
    }
    return { o, key, swapIn, calls };
  });
  const legRes = await multi(client, legReads.flatMap((x) => x.calls), at.block);
  let offset = 0;
  const legInputs = legReads.map(({ o, key, swapIn, calls }) => {
    const res = legRes.slice(offset, (offset += calls.length));
    const round = val<[bigint, bigint, bigint, bigint, bigint] | null>(res[0], null);
    const market = marketView(Number(at.timestamp), round ? Number(round[3]) : null, gate);
    return {
      nowSec: Number(at.timestamp),
      active: o?.reg ? o.reg.active : null,
      oracleStatus: o?.status ?? 4,
      feedUpdatedAt: round ? Number(round[3]) : null,
      market,
      multiplier: multiplierOf(res[1], res[2], res[3]),
      price1e18: o?.price1e18 ?? 0n,
      swapIn,
      out: key && swapIn > 0n ? quotedOut(res[6]) : null,
      refOut: key ? quotedOut(res[5]) : null,
      feePips: key ? feePipsOf(key, USDG, res[4]) : 0,
      bandBps: Number(o?.reg?.bandBps ?? 0),
    };
  });
  // The account is swept alone when any of its legs is over the impact cap; every leg is then judged alone.
  const { plans, alone: sweepsAlone } = accountLegPlans(legInputs);
  const legs = mix.map((l, i) => {
    const plan = plans[i]!;
    const { market, multiplier, oracleStatus: status } = legInputs[i]!;
    return {
      symbol: symbolOf(l.asset, book),
      asset: l.asset,
      bps: Number(l.bps),
      pct: `${Number(l.bps) / 100}%`,
      oracleStatus: status,
      oracleLabel: oracleLabelFor(status, market),
      marketOpen: market.open,
      /** plan.ts assetState: ok, wait (the whole account waits) or settle (inactive: paid out as USDG). */
      keeperState: plan.state,
      ...(plan.state === 'wait' ? { waitReason: plan.why } : {}),
      /** What a sweep does with this leg now: buy, wait, hold (B-L3 / no quote), defer (router band) or safe_settle. */
      keeperOutcome: plan.outcome,
      /** Why the leg does not buy now; null when it buys. */
      reason: plan.reason,
      multiplierChange: multiplierView(multiplier, plan.splitPending),
      /** The keeper's quote-vs-oracle check (B-L3) of this account's leg on its own; null for an inactive asset. */
      quoteCheck: quoteCheckView(plan.check),
    };
  });
  const held = legs.filter((l) => l.keeperOutcome === 'hold');

  const overThreshold = threshold > 0n && value >= threshold;
  const sweptThisEpoch = sweptEpoch !== 0n && sweptEpoch === currentEpoch;
  const screeningEligible = val<boolean | null>(r[15], null);
  const readyToSweep = overThreshold && !sweptThisEpoch && screeningEligible !== false && mix.length > 0;
  const waitingFor: string[] = [];
  if (executorPaused) waitingFor.push('SweepExecutor is paused');
  if (!overThreshold) waitingFor.push(`parked spare below the $${usdg(threshold)} sweep threshold`);
  if (sweptThisEpoch) waitingFor.push('already swept this epoch');
  if (screeningEligible === false) waitingFor.push('screening: not eligible');
  if (mix.length === 0) waitingFor.push('no mix');
  for (const l of legs) if (l.keeperState === 'wait') waitingFor.push(`${l.symbol ?? l.asset}: ${l.waitReason}`);
  for (const l of held) waitingFor.push(`${l.symbol ?? l.asset}: held: ${l.quoteCheck?.why ?? 'no quote'}`);
  const epochLength = val<bigint>(r[12], 0n);
  const nextEpochAt = epochLength > 0n && currentEpoch > 0n ? iso(currentEpoch * epochLength) : null;
  const ownMix = val<boolean>(r[14], false);
  const nowSec = at.timestamp;

  return {
    account,
    ...(account !== asked ? { resolvedFrom: { wallet: asked, note: 'This address is a spending wallet linked to the account above.' } } : {}),
    explorer: explorerAddress(account),
    readAt: { block: at.block.toString(), timestamp: iso(at.timestamp) },
    // Flat fields the site reads.
    /** Everything waiting in CashPark for this account: pending USDG + parked units at NAV (CashPark.valueOf). */
    parkedUsd: usdg(value),
    /** USDG credited but not yet parked into the adapter (CashPark.pending). */
    pendingUsd: usdg(pending),
    remainingWeeklyCapUsd: usdg(remaining),
    pulledLast7dUsd: usdg(pulled7d),
    sweptThisEpoch,
    /** When the next daily sweep epoch starts (SweepExecutor.currentEpoch() x epochLength). */
    nextEpochAt,
    /** On-chain sweep conditions met: over threshold, not swept this epoch, screening eligible, mix set. */
    readyToSweep,
    /**
     * readyToSweep AND the executor is not paused AND no mix leg waits (oracle, market hours,
     * multiplier change) or is held (the keeper's quote-vs-oracle check, B-L3).
     */
    keeperWouldSweepNow: readyToSweep && executorPaused !== true && legs.every((l) => l.keeperState !== 'wait') && held.length === 0,
    /** A leg moves its pool more than the keeper's impact cap: the account is swept in a call of its own, after the others. */
    keeperSweepsAlone: sweepsAlone,
    waitingFor,
    mixIsDefault: !ownMix,
    status: {
      hasLinkedWallets: wallets.length > 0,
      ruleActive,
      overThreshold,
      sweptThisEpoch,
      readyToSweep,
      screeningEligible,
    },
    rule: ruleSet
      ? {
          roundTo: Number(rule!.roundTo),
          multiplier: Number(rule!.multiplier),
          weeklyCapUsd: usdg(rule!.weeklyCap),
          enabled: rule!.enabled,
          active: ruleActive,
          activeSinceBlock: val<bigint>(r[2], 0n).toString(),
        }
      : null,
    wallets: wallets.map((w, i) => {
      const b = i * 5;
      const allowance = val<[bigint, number, number]>(wr[b + 2], [0n, 0, 0]);
      const expiration = BigInt(allowance[1] ?? 0);
      const expired = expiration !== 0n && expiration <= nowSec;
      const erc20ToPermit2 = val<bigint>(wr[b + 4], 0n);
      return {
        wallet: w,
        selfLinked: w.toLowerCase() === account.toLowerCase(),
        linkedAtBlock: val<bigint>(wr[b], 0n).toString(),
        lastAccruedBlock: val<bigint>(wr[b + 1], 0n).toString(),
        usdgBalance: usdg(val<bigint>(wr[b + 3], 0n)),
        permit2: {
          // type(uint160).max (and anything near it) is an unlimited approval;
          // the rolling weekly cap is then the only bound on pulls.
          allowanceUsd: allowance[0] >= 1n << 159n ? 'unlimited' : usdg(allowance[0]),
          expiration: expiration > 0n ? iso(expiration) : null,
          expired,
          nonce: Number(allowance[2] ?? 0),
        },
        usdgApprovedToPermit2: erc20ToPermit2 > 0n,
        consent: allowance[0] > 0n && !expired && erc20ToPermit2 > 0n ? 'ok' : expired ? 'expired' : 'missing',
      };
    }),
    park: {
      pendingUsd: usdg(pending),
      parkedUnits: units.toString(),
      valueUsd: usdg(value),
      navFresh: val<boolean | null>(r[6], null),
      sweepThresholdUsd: usdg(threshold),
      toThresholdUsd: overThreshold ? '0' : usdg(threshold > value ? threshold - value : 0n),
    },
    weeklyCap: {
      capUsd: rule ? usdg(rule.weeklyCap) : '0',
      pulledLast7DaysUsd: usdg(pulled7d),
      remainingUsd: usdg(remaining),
      window: 'rolling 7 UTC days (SweepExecutor.dayPulled)',
    },
    sweep: {
      currentEpoch: currentEpoch.toString(),
      lastSweptEpoch: sweptEpoch === 0n ? null : sweptEpoch.toString(),
      sweptThisEpoch,
      epochLengthSeconds: Number(epochLength),
      nextEpochAt,
      executorPaused,
      marketHoursGate: gate,
    },
    /** The mix a sweep would buy (own mix, or the default when mixIsDefault). */
    mix: legs,
    claimable: claimables,
    holdings: holdings.filter((h) => h.balance !== '0'),
    holdingsValueUsd: usdg(holdingsValue),
    accountUsdgBalance: usdg(val<bigint>(r[19], 0n)),
    screening: {
      enforced: val<boolean | null>(r[16], null),
      eligible: screeningEligible,
      clearedUntil: clearedUntil > 0n ? iso(clearedUntil) : null,
    },
    notes: [
      'A sweep is all-or-nothing per account: if any active stock in the mix is waiting (oracle not OK, outside the US-equities 24/5 session / no feed update since the open, or an ERC-8056 multiplier change the feed has not caught up with), the keeper holds the whole account and its spare change stays parked. An inactive stock never blocks: its leg is safe-settled to USDG.',
      `Before a sweep the keeper checks each quote against Chainlink (B-L3): a stock whose $1 quote is more than the pool fee + ${KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS} bps under the oracle, or whose leg quote is more than min(pool fee + ${KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS + KEEPER_SWEEP_MAX_IMPACT_BPS}, ${KEEPER_QUOTE_MAX_SHORTFALL_BPS}) bps under it (${KEEPER_QUOTE_MAX_SHORTFALL_BPS} when the leg is big enough to be swept alone), is held: accounts holding it keep their epoch and are retried next tick. quoteCheck judges this account's own legs; netting with other accounts' legs can change a shared call's size. The limits are the keeper's defaults (quoteCheck.allowanceBps / maxImpactBps / maxShortfallBps); a deployment can override them.`,
    ],
  };
}

// ─── spare_quote ──────────────────────────────────────────────────────────

export async function readQuote(assetInput: unknown, usdgInInput: unknown, client: PublicClient = getSpareClient()) {
  const book = getBook();
  const c = book.contracts;
  // Tickers resolve through the live registry, so a newly registered asset is quotable at once.
  const dir = await directory(client, book);
  const token = resolveAsset(String(assetInput ?? ''), book, dir);
  if (!token) {
    const known = dir.assets.map((x) => x.symbol).filter(Boolean);
    throw new SpareInputError(
      `asset must be a registered ticker (${known.length ? `${known.slice(0, 12).join(', ')}${known.length > 12 ? `, … ${known.length - 12} more` : ''}` : 'none read'}; see spare_universe) or a registry token address`,
    );
  }
  const gross = parseUnitsExact(usdgInInput ?? '5', USDG_DECIMALS, 'usdgIn');
  if (gross <= 0n) throw new SpareInputError('usdgIn must be greater than 0');
  if (gross > 1_000_000n * USDG_UNIT) throw new SpareInputError('usdgIn must be at most 1,000,000');

  const at = await head(client);
  const r = await multi(
    client,
    [
      { address: c.AssetRegistry, abi: assetRegistryAbi as Abi, functionName: 'get', args: [token] },
      { address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'oracleStatus', args: [token] },
      { address: c.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'feeBps' },
      { address: token, abi: stockTokenAbi as Abi, functionName: 'uiMultiplier' },
      { address: token, abi: stockTokenAbi as Abi, functionName: 'effectiveAt' },
      { address: token, abi: stockTokenAbi as Abi, functionName: 'newUIMultiplier' },
    ],
    at.block,
  );
  const a = val<RegistryAsset | null>(r[0], null);
  if (!a) throw new SpareInputError(`${token} is not registered in the Spare AssetRegistry`);
  const [status, p1e18] = val<[number, bigint]>(r[1], [4, 0n]);
  const feeBps = BigInt(val<number>(r[2], 25));
  const ui = val<bigint>(r[3], 0n);
  const multiplier = multiplierOf(r[3], r[4], r[5]);

  // Exactly the sweep path: the fee comes off the top, the rest is swapped.
  const fee = (gross * feeBps) / 10_000n;
  const swapIn = gross - fee;
  const key = a.poolKey;
  const zeroForOne = key.currency0.toLowerCase() === book.external.USDG.toLowerCase();

  type QuoteRead = { amountOut: bigint; gasEstimate: bigint; error: null } | { amountOut: null; gasEstimate: null; error: string };
  // The quote (its own call, for its revert reason) next to one multicall: the
  // feed, the pool's slot0 and the keeper's $1 reference quote. A quote that
  // reverts is "no quote"; an RPC failure on either fails the read (502),
  // never a "no quote" / "feed unreadable" verdict the chain did not give.
  const [q, side] = await Promise.all([
    client
      .simulateContract({
        address: VENUE.v4Quoter,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: key, zeroForOne, exactAmount: swapIn, hookData: '0x' }] as never,
        blockNumber: at.block,
      })
      .then((sim): QuoteRead => {
        const [amountOut, gasEstimate] = sim.result as readonly [bigint, bigint];
        return { amountOut, gasEstimate, error: null };
      })
      .catch((err): QuoteRead => {
        if (!isRevert(err)) throw err;
        return { amountOut: null, gasEstimate: null, error: safeErrorMessage(err, 'quote failed') };
      }),
    multi(
      client,
      [
        { address: a.feed, abi: aggregatorV3Abi as Abi, functionName: 'latestRoundData' },
        { address: VENUE.v4StateView, abi: stateViewAbi as Abi, functionName: 'getSlot0', args: [poolIdOf(key)] },
        quoteCall(key, book.external.USDG, REF_SWAP_IN),
      ],
      at.block,
    ),
  ]);
  const feedRound = val<readonly [bigint, bigint, bigint, bigint, bigint] | null>(side[0], null);
  const amountOut = q.amountOut;
  const gasEstimate = q.gasEstimate;
  const quoteError = q.error;
  const market = marketView(Number(at.timestamp), feedRound ? Number(feedRound[3]) : null);

  const oracleOk = status === 0;
  const oracleOut = oracleOk ? oracleTokensFor(swapIn, p1e18) : null;
  const bandFloor = oracleOut === null ? null : (oracleOut * BigInt(10_000 - a.bandBps)) / 10_000n;
  const out = amountOut;
  const keeperMin = out === null ? null : (out * BigInt(10_000 - KEEPER_QUOTE_TOLERANCE_BPS)) / 10_000n;
  // Positive = the pool gives FEWER tokens than the oracle price would.
  const shortfallBps =
    out !== null && out > 0n && oracleOut !== null && oracleOut > 0n
      ? Number(((oracleOut - out) * 1_000_000n) / oracleOut) / 100
      : null;
  const fillPrice = out !== null && out > 0n ? formatUnitsExact((swapIn * 10n ** 20n) / out, 8) : null;

  // What the keeper + SweepExecutor would do with a leg of this size right now,
  // in the keeper's order (keeperRules.ts legPlan: keeper.ts assetInfos ->
  // plan.ts assetState, batches.ts partitionSweep / planCall, then the router band).
  const plan = legPlan({
    nowSec: Number(at.timestamp),
    active: a.active,
    oracleStatus: Number(status),
    feedUpdatedAt: feedRound ? Number(feedRound[3]) : null,
    market,
    multiplier,
    price1e18: p1e18,
    swapIn,
    out,
    refOut: quotedOut(side[2]),
    feePips: feePipsOf(key, book.external.USDG, side[1]),
    bandBps: Number(a.bandBps),
  });
  const sweep: { outcome: 'buy' | 'wait' | 'defer' | 'safe_settle'; reason: string | null; keeperOutcome: LegOutcome } = {
    // `outcome` keeps its four values: a keeper hold (no quote, or B-L3) is a "defer" to older readers.
    outcome: plan.outcome === 'hold' ? 'defer' : plan.outcome,
    reason: plan.reason,
    keeperOutcome: plan.outcome,
  };

  return {
    asset: { symbol: symbolOf(token, book), token, active: a.active },
    readAt: { block: at.block.toString(), timestamp: iso(at.timestamp) },
    // Flat fields the site reads.
    usdgIn: usdg(gross),
    feeUsd: usdg(fee),
    expectedOut: out === null ? null : tokens18(out),
    oraclePrice: oracleOk ? price(p1e18) : null,
    fillPrice,
    /** Fill vs Chainlink in bps: positive = the pool gives MORE tokens than the oracle price, negative = fewer. */
    edgeVsOracleBps: shortfallBps === null ? null : -shortfallBps,
    minOutAtKeeperTolerance: keeperMin === null ? null : tokens18(keeperMin),
    oracleStatus: Number(status),
    oracleLabel: oracleLabelFor(status, market),
    marketOpen: market.open,
    outcome: sweep.outcome,
    wouldBuy: sweep.outcome === 'buy',
    wouldDefer: sweep.outcome === 'defer',
    wouldWait: sweep.outcome === 'wait',
    reason: sweep.reason,
    /** The keeper's own outcome: `outcome`, with "hold" (no quote, or the B-L3 quote-vs-oracle check) told apart from an on-chain "defer". */
    keeperOutcome: sweep.keeperOutcome,
    wouldHold: sweep.keeperOutcome === 'hold',
    /** The keeper's checks behind keeperOutcome: the ERC-8056 multiplier gate and B-L3 for a leg of this size on its own. */
    keeperChecks: {
      multiplierChange: multiplierView(multiplier, plan.splitPending),
      quoteVsOracle: quoteCheckView(plan.check),
    },
    input: {
      grossUsd: usdg(gross),
      conversionFeeBps: Number(feeBps),
      feeUsd: usdg(fee),
      swapInUsd: usdg(swapIn),
    },
    // fee is the PoolKey field (8388608 = dynamic); lpFee is the LP fee now (slot0's for a dynamic pool).
    pool: { ...poolView(key, side[1]), zeroForOne },
    quote:
      amountOut === null
        ? { ok: false, error: quoteError }
        : {
            ok: true,
            quoter: VENUE.v4Quoter,
            tokensOut: tokens18(amountOut),
            shares: ui > 0n ? tokens18((amountOut * ui) / 10n ** 18n) : null,
            fillPriceUsd: amountOut > 0n ? formatUnitsExact((swapIn * 10n ** 20n) / amountOut, 8) : null,
            gasEstimate: gasEstimate?.toString() ?? null,
            keeperMinOut: keeperMin === null ? null : tokens18(keeperMin),
            keeperToleranceBps: KEEPER_QUOTE_TOLERANCE_BPS,
          },
    oracle: {
      status: ORACLE_STATUS[status] ?? `UNKNOWN(${status})`,
      priceUsd: oracleOk ? price(p1e18) : null,
      tokensAtOracle: oracleOut === null ? null : tokens18(oracleOut),
      bandBps: a.bandBps,
      bandFloorTokens: bandFloor === null ? null : tokens18(bandFloor),
      fillShortfallVsOracleBps: shortfallBps,
      withinBand: amountOut !== null && bandFloor !== null ? amountOut >= bandFloor : null,
    },
    market,
    sweep: { ...sweep, wouldDefer: sweep.outcome === 'defer', wouldWait: sweep.outcome === 'wait', wouldHold: sweep.keeperOutcome === 'hold' },
    notes: [
      a.active ? null : 'This asset is registered but INACTIVE: sweeps will not buy it (the leg is safe-settled to USDG).',
      oracleOk ? null : 'Oracle is not OK right now: the keeper WAITS (no sweep for accounts holding this stock) and value stays parked.',
      oracleOk && !market.open
        ? "Outside the keeper's market-hours gate: OracleGuard still reports OK, but the keeper does not buy equity legs outside the US-equities 24/5 session (Sunday 20:00 to Friday 20:00 ET) or before the feed has posted since the open."
        : null,
      plan.waitCause === 'multiplier_change'
        ? "An ERC-8056 multiplier change is pending: OracleGuard does not read the multiplier, so the keeper does not buy from 15 minutes before the change until the Chainlink feed has posted after it."
        : null,
      sweep.keeperOutcome === 'hold'
        ? 'HOLD: the keeper does not turn this quote into a limit (keeperChecks.quoteVsOracle.why). Accounts holding this stock sit the sweep out with their epoch kept and are retried next tick; nothing is spent.'
        : null,
      'Outcome is for one leg. A sweep is all-or-nothing per account: if any active stock in the account\'s mix is waiting, the keeper holds the whole account (see spare_account waitingFor).',
      'Read-only quote from the Uniswap v4 Quoter for the exact pool the AssetRegistry pins. Not an order.',
    ].filter(Boolean),
  };
}

// ─── spare_activity ───────────────────────────────────────────────────────

export interface ActivityQuery {
  /** Account (or a wallet linked to one). Omit for the global feed. */
  address?: unknown;
  /** Lookback in days, 1..7 (default 7). */
  days?: unknown;
  /** Max items, 1..100 (default 50). */
  limit?: unknown;
  /** Only these kinds (array or comma-separated). */
  kinds?: unknown;
  /** Exclusive upper block bound, for paging (use `page.nextBefore`). */
  before?: unknown;
}

function parseKinds(v: unknown): Set<ActivityKind> | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((k) => !(ACTIVITY_KINDS as readonly string[]).includes(k));
  if (bad.length) throw new SpareInputError(`unknown kinds: ${bad.join(', ')} (valid: ${ACTIVITY_KINDS.join(', ')})`);
  return new Set(list as ActivityKind[]);
}

function intIn(v: unknown, d: number, lo: number, hi: number, label: string): number {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new SpareInputError(`${label} must be an integer ${lo}..${hi}`);
  return n;
}

/** Resolve a linked spending wallet to the account it feeds (else the address itself). */
async function resolveAccount(client: PublicClient, book: SpareBook, asked: Address): Promise<Address> {
  const [owned, feeds] = await multi(client, [
    { address: book.contracts.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'walletsOf', args: [asked] },
    { address: book.contracts.RuleRegistry, abi: ruleRegistryAbi as Abi, functionName: 'accountOf', args: [asked] },
  ]);
  const wallets = val<Address[]>(owned, []);
  const account = val<Address>(feeds, ZERO);
  return wallets.length === 0 && account.toLowerCase() !== ZERO && account.toLowerCase() !== asked.toLowerCase()
    ? getAddress(account)
    : asked;
}

/** Strip account/wallet addresses from a global-feed item. */
function anonymise(i: ActivityItem): ActivityItem {
  const { account: _a, wallet: _w, ...rest } = i.args;
  return { ...i, args: rest };
}

export async function readActivity(q: ActivityQuery = {}, client: PublicClient = getSpareClient()) {
  const book = getBook();
  const global = q.address === undefined || q.address === null || q.address === '';
  const asked = global ? null : requireAddress(q.address, 'address');
  const days = intIn(q.days, MAX_ACTIVITY_DAYS, 1, MAX_ACTIVITY_DAYS, 'days');
  const limit = intIn(q.limit, 50, 1, MAX_ACTIVITY_LIMIT, 'limit');
  const kinds = parseKinds(q.kinds);
  const [account] = await Promise.all([
    asked ? resolveAccount(client, book, asked) : Promise.resolve(null),
    // Rows name their tokens from the registry read.
    directory(client, book).catch(() => null),
  ]);

  const at = await head(client);
  let upper = at.block;
  if (q.before !== undefined && q.before !== null && q.before !== '') {
    const b = BigInt(intIn(q.before, 0, 1, Number.MAX_SAFE_INTEGER, 'before'));
    if (b - 1n < upper) upper = b - 1n;
  }
  const win = activityWindow(at.block, days, book.startBlock);
  const range = { from: win.from, to: upper };
  const t0 = Date.now();
  const scan =
    range.to >= range.from
      ? await scanActivity(client, book, { account, range, limit, kinds, maxCalls: ACTIVITY_MAX_CALLS })
      : { items: [], calls: 0, scannedFrom: range.from, complete: true };
  const page = pageNewestFirst(scan.items, limit);
  // A scan that stopped at ACTIVITY_MAX_CALLS with room left on the page: the
  // next page starts below the last block scanned.
  const scanCut = !page.truncated && !scan.complete;

  // Nitro logs carry no block timestamp: read exact times for up to 40
  // distinct blocks, estimate the rest from the head (~0.1 s blocks).
  const blocks = [...new Set(page.items.map((i) => i.blockNumber))];
  const exact = new Map<string, bigint>();
  await Promise.all(
    blocks.slice(0, 40).map(async (b) => {
      try {
        const blk = await client.getBlock({ blockNumber: BigInt(b) });
        exact.set(b, blk.timestamp);
      } catch {
        /* estimated below */
      }
    }),
  );
  const timeOf = (b: string) => {
    const e = exact.get(b);
    if (e !== undefined) return { at: iso(e), estimated: false };
    const dt = Number(at.block - BigInt(b)) / 10; // ~10 blocks/s
    return { at: new Date(Number(at.timestamp) * 1000 - dt * 1000).toISOString(), estimated: true };
  };

  const shown = account ? page.items : page.items.map(anonymise);
  const items = shown.map((i) => {
    const t = timeOf(i.blockNumber);
    return {
      ...i,
      ...describe(i, book),
      // Flat fields the site reads.
      block: i.blockNumber,
      time: t.at,
      timeEstimated: t.estimated,
      ...activityFields(i, book),
      explorer: explorerTx(i.txHash),
    };
  });

  return {
    scope: account ? 'account' : 'global',
    ...(account ? { account } : {}),
    ...(account && asked && account !== asked ? { resolvedFrom: { wallet: asked } } : {}),
    window: {
      days,
      fromBlock: range.from.toString(),
      toBlock: range.to.toString(),
      clampedToDeployBlock: win.clampedToDeploy,
      scannedFromBlock: scan.scannedFrom.toString(),
      complete: scan.complete,
      getLogsCalls: scan.calls,
      maxGetLogsCalls: ACTIVITY_MAX_CALLS,
      maxBlocksPerCall: 50_000,
      scanMs: Date.now() - t0,
    },
    totals: summarise(page.items, book),
    count: items.length,
    page: { limit, truncated: page.truncated || scanCut, nextBefore: scanCut ? scan.scannedFrom.toString() : page.nextBefore },
    items, // newest first
  };
}

/** Revert data carried by SwapDeferred / AccrualSkipped, as text when it decodes. */
export function decodeReasonBytes(data: unknown): string {
  const hex = String(data ?? '');
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex === '0x') return hex === '0x' ? '' : hex;
  try {
    const d = decodeErrorResult({ abi: [...sweepExecutorAbi, ...stockRouterAbi, ...permit2Abi] as Abi, data: hex as Hex });
    return d.errorName === 'Error' ? String(d.args?.[0] ?? '') : d.errorName;
  } catch {
    return hex.slice(0, 10);
  }
}

export interface ActivityFields {
  /** Stock symbol (or USDG) the event is about. */
  asset?: string;
  /** USDG amount in dollars. */
  usdg?: string;
  /** Stock tokens (18 dp, raw token units). */
  tokens?: string;
  /** Conversion fee in dollars (AssetSwept). */
  fee?: string;
  epoch?: string;
  /** OracleGuard.Status of a Deferred leg. */
  status?: number;
  reason?: string;
}

/** The flat per-item fields of `spare_activity` (docs/MCP_TOOLS.md). Pure. */
export function activityFields(i: ActivityItem, book: SpareBook): ActivityFields {
  const a = i.args;
  const sym = (x: unknown) => symbolOf(String(x ?? ''), book) ?? String(x ?? '');
  const d = (raw: unknown) => usdg(BigInt(String(raw ?? '0')));
  const tok = (token: unknown, raw: unknown): ActivityFields =>
    symbolOf(String(token ?? ''), book) === 'USDG'
      ? { asset: 'USDG', usdg: d(raw) }
      : { asset: sym(token), tokens: tokens18(BigInt(String(raw ?? '0'))) };
  switch (i.kind) {
    case 'accrued':
    case 'credited':
    case 'returned':
      return { usdg: d(a.amount) };
    case 'swept':
      return { usdg: d(a.usdg), epoch: String(a.epoch) };
    case 'asset_swept':
      return { asset: sym(a.asset), usdg: d(a.usdgIn), tokens: tokens18(BigInt(String(a.tokensOut))), fee: d(a.fee) };
    case 'swap_deferred':
      return { asset: sym(a.asset), usdg: d(a.usdg), reason: decodeReasonBytes(a.reason) };
    case 'deferred':
      return { asset: sym(a.asset), usdg: d(a.usdg), status: Number(a.status), reason: `oracle ${ORACLE_STATUS[Number(a.status)] ?? a.status}` };
    case 'safe_settled':
      return { asset: sym(a.asset), usdg: d(a.usdg), reason: String(a.reason ?? '') };
    case 'delivered':
    case 'delivery_held':
    case 'claimed':
      return tok(a.token, a.amount);
    case 'withdrawn_for_sweep':
    case 'exited':
      return { usdg: d(a.usdgOut) };
    case 'accrual_skipped':
      return { reason: decodeReasonBytes(a.reason) };
    default:
      return {};
  }
}

function describe(i: ActivityItem, book: SpareBook): { summary: string } {
  const a = i.args;
  const tok = (x: unknown) => symbolOf(String(x ?? ''), book) ?? String(x ?? '');
  const amt = (token: unknown, raw: unknown) => {
    const s = symbolOf(String(token ?? ''), book);
    const v = BigInt(String(raw ?? '0'));
    return s === 'USDG' ? `$${usdg(v)}` : `${tokens18(v)} ${s ?? ''}`.trim();
  };
  switch (i.kind) {
    case 'accrued':
      return { summary: `Round-ups accrued: $${usdg(BigInt(String(a.amount)))}${a.wallet ? ` from ${String(a.wallet)}` : ''} (blocks ${String(a.fromBlock)}..${String(a.toBlock)})` };
    case 'accrual_skipped':
      return { summary: `Accrual skipped${a.wallet ? ` for ${String(a.wallet)}` : ''} (consent, cap or balance)` };
    case 'swept':
      return { summary: `Swept $${usdg(BigInt(String(a.usdg)))} into the mix (epoch ${String(a.epoch)})` };
    case 'asset_swept':
      return {
        summary: `Batch buy: $${usdg(BigInt(String(a.usdgIn)))} -> ${tokens18(BigInt(String(a.tokensOut)))} ${tok(a.asset)} (fee $${usdg(BigInt(String(a.fee)))})`,
      };
    case 'swap_deferred':
      return { summary: `Swap deferred for ${tok(a.asset)} ($${usdg(BigInt(String(a.usdg)))}); value stays parked` };
    case 'delivered':
      return { summary: `Delivered ${amt(a.token, a.amount)}` };
    case 'delivery_held':
      return { summary: `Delivery held as claimable: ${amt(a.token, a.amount)}` };
    case 'deferred':
      return { summary: `Deferred ${tok(a.asset)} leg ($${usdg(BigInt(String(a.usdg)))}) — oracle ${ORACLE_STATUS[Number(a.status)] ?? a.status}; value stays parked` };
    case 'safe_settled':
      return { summary: `Safe-settled ${tok(a.asset)} leg to USDG ($${usdg(BigInt(String(a.usdg)))}): ${String(a.reason)}` };
    case 'claimed':
      return { summary: `Claimed ${amt(a.token, a.amount)}` };
    case 'credited':
      return { summary: `Spare change credited: $${usdg(BigInt(String(a.amount)))}` };
    case 'withdrawn_for_sweep':
      return { summary: `$${usdg(BigInt(String(a.usdgOut)))} unparked for a sweep` };
    case 'returned':
      return { summary: `$${usdg(BigInt(String(a.amount)))} returned to the park (deferred leg)` };
    case 'exited':
      return { summary: `Exit: $${usdg(BigInt(String(a.usdgOut)))} withdrawn` };
    case 'exit_units_kept':
      return { summary: 'Exit: parked units kept (adapter could not redeem yet)' };
    case 'rule_set':
      return { summary: `Rule set: round to $${String(a.roundTo)}, ${String(a.multiplier)}x, weekly cap $${usdg(BigInt(String(a.weeklyCap)))}, ${a.enabled ? 'enabled' : 'disabled'}` };
    case 'linked':
      return { summary: a.wallet ? `Wallet linked: ${String(a.wallet)}` : 'Wallet linked' };
    case 'unlinked':
      return { summary: a.wallet ? `Wallet unlinked: ${String(a.wallet)}` : 'Wallet unlinked' };
    case 'mix_set':
      return {
        summary: `Mix set: ${((a.legs as Array<{ asset: string; bps: number }>) ?? [])
          .map((l) => `${tok(l.asset)} ${Number(l.bps) / 100}%`)
          .join(', ')}`,
      };
    case 'mix_cleared':
      return { summary: 'Mix cleared (default mix applies)' };
  }
}

/** Aggregate totals over decoded activity. Pure. */
export function summarise(items: readonly ActivityItem[], book: SpareBook) {
  let accruedUsdg = 0n;
  let sweptUsdg = 0n;
  let deferredUsdg = 0n;
  let safeSettledUsdg = 0n;
  const delivered = new Map<string, bigint>();
  for (const i of items) {
    const a = i.args;
    if (i.kind === 'accrued') accruedUsdg += BigInt(String(a.amount));
    else if (i.kind === 'swept') sweptUsdg += BigInt(String(a.usdg));
    else if (i.kind === 'deferred') deferredUsdg += BigInt(String(a.usdg));
    else if (i.kind === 'safe_settled') safeSettledUsdg += BigInt(String(a.usdg));
    else if (i.kind === 'delivered') {
      const k = String(a.token).toLowerCase();
      delivered.set(k, (delivered.get(k) ?? 0n) + BigInt(String(a.amount)));
    }
  }
  return {
    accruedUsd: usdg(accruedUsdg),
    sweptUsd: usdg(sweptUsdg),
    deferredUsd: usdg(deferredUsdg),
    safeSettledUsd: usdg(safeSettledUsdg),
    delivered: [...delivered.entries()].map(([token, amount]) => {
      const sym = symbolOf(token, book);
      return { symbol: sym, token: getAddress(token), amount: sym === 'USDG' ? usdg(amount) : tokens18(amount) };
    }),
  };
}

// ─── spare_contracts ──────────────────────────────────────────────────────

const AUTH_CONTRACTS: SpareContractName[] = [
  'AssetRegistry',
  'ElectionRegistry',
  'ScreeningGate',
  'StockRouter',
  'CashPark',
  'FeeVault',
  'SweepExecutor',
];

const ROLE_OF: Record<SpareContractName, string> = {
  AssetRegistry: 'Eligible universe: asset -> feed, pinned v4 PoolKey, heartbeat, band, active. Fail-closed.',
  RuleRegistry: 'Linked spending wallets and each account\'s round-up rule (roundTo, multiplier, weekly cap).',
  ElectionRegistry: 'Each account\'s mix (<= 6 legs, bps sum 10000, active assets only).',
  ScreeningGate: 'Eligibility attestation required before buying tokenized stocks.',
  StockRouter: 'Swaps USDG -> asset through the allowlisted v4 pool; enforces minOut and the Chainlink band.',
  CashPark: 'Holds accrued spare change (pending USDG + parked units) between accrual and sweep. Exit never gated.',
  FeeVault: 'Collects the conversion fee (bps on USDG actually converted) and Fund Wallet swap fees.',
  SweepExecutor: 'accrue: capped Permit2 pull -> CashPark. sweep: netted, quote-limited, idempotent per epoch.',
  UsdgParkAdapter: 'Park adapter holding USDG as-is. No yield, always fresh. Launch default.',
  SgovParkAdapter: "Park adapter that parks spare in its underlying() treasury-ETF token instead of USDG. Standby: switching CashPark to it is an owner decision.",
};

export async function readContracts(client: PublicClient = getSpareClient()) {
  const book = getBook();
  const c = book.contracts;
  const [at, dir] = await Promise.all([head(client), directory(client, book).catch(() => null)]);
  const authCalls: Call[] = AUTH_CONTRACTS.flatMap((name) => [
    { address: c[name], abi: spareAuthAbi as Abi, functionName: 'owner' },
    { address: c[name], abi: spareAuthAbi as Abi, functionName: 'pendingOwner' },
    { address: c[name], abi: spareAuthAbi as Abi, functionName: 'pauser' },
    { address: c[name], abi: spareAuthAbi as Abi, functionName: 'paused' },
    { address: c[name], abi: spareAuthAbi as Abi, functionName: 'isKeeper', args: [book.roles.keeper] },
  ]);
  const extra: Call[] = [
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'executor' },
    { address: c.CashPark, abi: cashParkAbi as Abi, functionName: 'adapter' },
    { address: c.ScreeningGate, abi: screeningGateAbi as Abi, functionName: 'attestor' },
    { address: c.ScreeningGate, abi: screeningGateAbi as Abi, functionName: 'enforced' },
    { address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'isCaller', args: [c.SweepExecutor] },
    { address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'sequencerFeed' },
    { address: c.UsdgParkAdapter, abi: parkAdapterAbi as Abi, functionName: 'park' },
    { address: c.SgovParkAdapter, abi: parkAdapterAbi as Abi, functionName: 'park' },
  ];
  const r = await multi(client, [...authCalls, ...extra], at.block);
  // No catch: a failed getCode is the RPC failing, never "not deployed".
  const codes = await Promise.all(Object.values(c).map((a) => client.getCode({ address: a, blockNumber: at.block })));

  const liveRoles: Record<string, unknown> = {};
  const mismatches: string[] = [];
  AUTH_CONTRACTS.forEach((name, i) => {
    const b = i * 5;
    const owner = val<Address | null>(r[b], null);
    const pendingOwner = val<Address | null>(r[b + 1], null);
    const pauser = val<Address | null>(r[b + 2], null);
    const keeperEnabled = val<boolean | null>(r[b + 4], null);
    liveRoles[name] = {
      owner,
      pendingOwner: pendingOwner && pendingOwner.toLowerCase() !== ZERO ? pendingOwner : null,
      pauser,
      paused: val<boolean | null>(r[b + 3], null),
      bookKeeperEnabled: keeperEnabled,
    };
    if (owner && owner.toLowerCase() !== book.roles.owner.toLowerCase()) mismatches.push(`${name}.owner`);
    if (pauser && pauser.toLowerCase() !== book.roles.pauser.toLowerCase()) mismatches.push(`${name}.pauser`);
  });
  const e = r.slice(AUTH_CONTRACTS.length * 5);
  const executorOfPark = val<Address | null>(e[0], null);
  if (executorOfPark && executorOfPark.toLowerCase() !== c.SweepExecutor.toLowerCase()) mismatches.push('CashPark.executor');
  const attestor = val<Address | null>(e[2], null);
  if (attestor && attestor.toLowerCase() !== book.roles.attestor.toLowerCase()) mismatches.push('ScreeningGate.attestor');

  const names = Object.keys(c) as SpareContractName[];
  const contractDetails = names.map((name, i) => ({
    name,
    address: c[name],
    deployed: !!codes[i] && codes[i] !== '0x',
    role: ROLE_OF[name],
    explorer: explorerAddress(c[name]),
  }));
  const cashParkAdapter = val<Address | null>(e[1], null);
  const screeningEnforced = val<boolean | null>(e[3], null);

  return {
    chainId: book.chainId,
    network: book.network,
    readAt: { block: at.block.toString(), timestamp: iso(at.timestamp) },
    // Flat fields the site reads.
    startBlock: book.startBlock.toString(),
    deployedAt: iso(book.deployedAt),
    /** Contract name -> address, e.g. contracts.AssetRegistry. */
    contracts: Object.fromEntries(names.map((n) => [n, c[n]])) as Record<SpareContractName, Address>,
    /** Per contract: job, bytecode check, explorer link. */
    contractDetails,
    allDeployed: contractDetails.every((d) => d.deployed),
    /** Roles from the deploy file; `rolesLive` and `mismatches` check them on-chain. */
    roles: { ...book.roles },
    rolesLive: liveRoles,
    wiring: {
      cashParkExecutor: executorOfPark,
      cashParkAdapter,
      routerCallerSweepExecutor: val<boolean | null>(e[4], null),
      sequencerFeed: val<Address | null>(e[5], null),
      usdgAdapterPark: val<Address | null>(e[6], null),
      sgovAdapterPark: val<Address | null>(e[7], null),
      screeningAttestor: attestor,
      screeningEnforced,
    },
    mismatches,
    screeningEnforced: screeningEnforced ?? book.screeningEnforced,
    explorer: EXPLORER_URL,
    deploy: { startBlock: book.startBlock.toString(), deployedAt: iso(book.deployedAt) },
    parkAdapter: { ...book.parkAdapter, current: cashParkAdapter ? adapterName(book, cashParkAdapter) : null },
    external: { ...book.external, WETH },
    venue: VENUE,
    /** Ticker -> token, as AssetRegistry lists them right now (null if the registry could not be read). */
    assets: dir ? Object.fromEntries(dir.assets.filter((x) => x.symbol).map((x) => [x.symbol, x.token])) : null,
    /** Each registry asset's own feed, then the reference feeds. */
    chainlinkFeeds: {
      ...(dir ? Object.fromEntries(dir.assets.filter((x) => x.symbol && x.feed).map((x) => [`${x.symbol} / USD`, x.feed])) : {}),
      ...REFERENCE_FEEDS,
    },
    notes: [
      'Owner is an EOA at launch (per docs/SPARE-BUILD.md; a multisig is planned via Ownable2Step).',
      'The keeper can only pull what a user authorised: capped by the rolling weekly cap and the user\'s own Permit2 allowance.',
    ],
  };
}

// ─── spare_fees ───────────────────────────────────────────────────────────

/**
 * All-time conversion-fee ledger: AssetSwept (fee, usdgIn) and FeeVault
 * Withdrawn events since the deploy block, scanned incrementally in 50k-block
 * chunks and kept in memory. One request advances it by at most
 * FEE_SCAN_MAX_CHUNKS; `allTime.complete` says whether it has reached
 * head - FEE_LEDGER_CONFIRMATIONS. The ledger is a running sum that never
 * rescans, so it only takes blocks that deep: a reorg nearer the head cannot
 * count an event twice or keep one that was dropped.
 */
interface FeeLedger {
  scannedTo: bigint;
  fees: bigint;
  converted: bigint;
  sweeps: number;
  withdrawn: Array<{ token: string; symbol: string | null; amount: string; to: string; txHash: string; block: string; time: string | null }>;
}
const FEE_SCAN_MAX_CHUNKS = 40;
/** SweepExecutor.finalityBuffer (contracts/config/4663.json): the depth Spare itself treats as final (~5 min). */
export const FEE_LEDGER_CONFIRMATIONS = 3_000n;
let feeLedger: FeeLedger | null = null;
let feeLedgerLock: Promise<unknown> = Promise.resolve();

/** Test hook: forget the in-memory fee ledger. */
export function resetFeeLedger(): void {
  feeLedger = null;
  feeLedgerLock = Promise.resolve();
}

type RawLog = { address: string; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex; removed?: boolean };

async function advanceFeeLedger(client: PublicClient, book: SpareBook, headBlock: bigint): Promise<FeeLedger & { complete: boolean }> {
  const run = async () => {
    const ledger: FeeLedger = (feeLedger ??= { scannedTo: book.startBlock - 1n, fees: 0n, converted: 0n, sweeps: 0, withdrawn: [] });
    const finalTo = headBlock > FEE_LEDGER_CONFIRMATIONS ? headBlock - FEE_LEDGER_CONFIRMATIONS : 0n;
    const from = ledger.scannedTo + 1n;
    const maxTo = from + BigInt(FEE_SCAN_MAX_CHUNKS) * LOG_CHUNK_BLOCKS - 1n;
    const to = finalTo < maxTo ? finalTo : maxTo;
    const chunks = chunkRange(from, to);
    const topics = [[topic0(sweepExecutorAbi, 'AssetSwept'), topic0(feeVaultAbi, 'Withdrawn')]];
    for (let i = 0; i < chunks.length; i += 6) {
      const batch = chunks.slice(i, i + 6);
      const raw = await Promise.all(
        batch.map(
          (c) =>
            client.request({
              method: 'eth_getLogs',
              params: [
                {
                  address: [book.contracts.SweepExecutor, book.contracts.FeeVault],
                  topics,
                  fromBlock: `0x${c.from.toString(16)}`,
                  toBlock: `0x${c.to.toString(16)}`,
                },
              ],
            } as never) as unknown as Promise<RawLog[]>,
        ),
      );
      for (const l of raw.flat()) {
        if (l.removed) continue;
        try {
          if (l.address.toLowerCase() === book.contracts.SweepExecutor.toLowerCase()) {
            const d = decodeEventLog({ abi: sweepExecutorAbi, data: l.data, topics: l.topics as never }) as unknown as {
              eventName: string;
              args: { fee: bigint; usdgIn: bigint };
            };
            if (d.eventName !== 'AssetSwept') continue;
            ledger.fees += d.args.fee;
            ledger.converted += d.args.usdgIn;
            ledger.sweeps += 1;
          } else {
            const d = decodeEventLog({ abi: feeVaultAbi, data: l.data, topics: l.topics as never }) as unknown as {
              args: { token: Address; to: Address; amount: bigint };
            };
            const sym = symbolOf(d.args.token, book);
            const blockNumber = BigInt(l.blockNumber);
            // Withdrawals are rare owner actions: one block read each for the time.
            const ts = await client
              .getBlock({ blockNumber })
              .then((b) => iso(b.timestamp))
              .catch(() => null);
            ledger.withdrawn.push({
              token: d.args.token,
              symbol: sym,
              amount: sym === 'USDG' ? usdg(d.args.amount) : formatUnitsExact(d.args.amount, 18),
              to: d.args.to,
              txHash: l.transactionHash,
              block: blockNumber.toString(),
              time: ts,
            });
          }
        } catch {
          /* not an event we track */
        }
      }
      ledger.scannedTo = batch[batch.length - 1]!.to;
    }
    return { ...ledger, complete: ledger.scannedTo >= finalTo };
  };
  const next = feeLedgerLock.then(run, run);
  feeLedgerLock = next.catch(() => undefined);
  return next;
}

export async function readFees(client: PublicClient = getSpareClient()) {
  const book = getBook();
  const vault = book.contracts.FeeVault;
  // Withdrawals name their token from the registry read.
  const [at] = await Promise.all([head(client), directory(client, book).catch(() => null)]);
  const r = await multi(
    client,
    [
      { address: book.external.USDG, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [vault] },
      { address: WETH, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [vault] },
      { address: book.contracts.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'feeBps' },
      { address: vault, abi: spareAuthAbi as Abi, functionName: 'owner' },
      { address: book.contracts.SweepExecutor, abi: sweepExecutorAbi as Abi, functionName: 'MAX_FEE_BPS' },
    ],
    at.block,
  );
  const eth = await client.getBalance({ address: vault, blockNumber: at.block }).catch(() => null);
  const usdgBal = val<bigint | null>(r[0], null);
  const wethBal = val<bigint | null>(r[1], null);
  let allTime: Record<string, unknown>;
  let ledger: (FeeLedger & { complete: boolean }) | null = null;
  try {
    const l = await advanceFeeLedger(client, book, at.block);
    ledger = l;
    allTime = {
      conversionFeesUsd: usdg(l.fees),
      convertedUsd: usdg(l.converted),
      batchBuys: l.sweeps,
      withdrawn: l.withdrawn,
      fromBlock: book.startBlock.toString(),
      scannedToBlock: l.scannedTo.toString(),
      confirmations: Number(FEE_LEDGER_CONFIRMATIONS),
      complete: l.complete,
    };
  } catch (err) {
    allTime = { error: safeErrorMessage(err, 'scan failed'), complete: false };
  }
  const balances = {
    USDG: usdgBal === null ? null : usdg(usdgBal),
    WETH: wethBal === null ? null : formatUnitsExact(wethBal, 18),
    ETH: eth === null ? null : formatUnitsExact(eth, 18),
  };
  const feeBps = Number(val<number>(r[2], 0));
  const maxFeeBps = Number(val<number>(r[4], 0));
  return {
    readAt: { block: at.block.toString(), timestamp: iso(at.timestamp) },
    // Flat fields the site reads.
    feeBps,
    fundFeeBps: FUND_WALLET_FEE_BPS,
    maxFeeBps,
    feeVault: { address: vault, usdg: balances.USDG, weth: balances.WETH, eth: balances.ETH, explorer: explorerAddress(vault) },
    /** Σ AssetSwept.fee since deploy (null while the ledger scan failed). */
    conversionFeesAllTimeUsd: ledger ? usdg(ledger.fees) : null,
    /** Σ AssetSwept.usdgIn since deploy. */
    convertedAllTimeUsd: ledger ? usdg(ledger.converted) : null,
    /** False until the incremental ledger scan has reached head - FEE_LEDGER_CONFIRMATIONS. */
    allTimeComplete: ledger?.complete ?? false,
    withdrawn: ledger?.withdrawn ?? [],
    explorer: explorerAddress(vault),
    balances,
    fees: {
      sweepConversionFeeBps: feeBps,
      maxConversionFeeBps: maxFeeBps,
      fundWalletSwapFeeBps: FUND_WALLET_FEE_BPS,
      subscription: 'none',
    },
    allTime,
    owner: val<Address | null>(r[3], null),
    notes: [
      'Sweep fee: bps on USDG actually converted into stock (never on deferred or safe-settled legs), paid in USDG.',
      'Fund Wallet fee: taken from the swap output — USDG for ETH->USDG, WETH for USDG->ETH (FeeVault has no receive()).',
      'The WETH balance can include ETH others stranded on the Universal Router, so it is not strictly a sum of fees.',
    ],
  };
}

// ─── health snapshot ──────────────────────────────────────────────────────

export interface SpareHealth {
  rpcOk: boolean;
  chainId: number;
  block: string | null;
  contractsDeployed: boolean | null;
  paused: boolean | null;
  /** `label` is LIVE only when OracleGuard says OK and the keeper's market-hours gate is open. */
  oracles: Array<{ symbol: string | null; status: string; oracleStatus: number; label: string; marketOpen: boolean | null }>;
  /** US-equities 24/5 session at the head block, as the keeper's market-hours gate sees it. */
  market: { session: string; gate: boolean; sessionOpen: boolean; sessionOpenedAt: string | null } | null;
  keeper: {
    address: Address;
    ethBalance: string | null;
    lastAccruedAt: string | null;
    lastSweptAt: string | null;
    lastEventTx: string | null;
    lookbackDays: number;
  };
  readAt: string;
}

/** Chain-side health for /health. Never throws: rpcOk=false (or partial) instead. */
export async function readHealth(client: PublicClient = getSpareClient()): Promise<SpareHealth> {
  const book = getBook();
  const c = book.contracts;
  const out: SpareHealth = {
    rpcOk: false,
    chainId: book.chainId,
    block: null,
    contractsDeployed: null,
    paused: null,
    oracles: [],
    market: null,
    keeper: { address: book.roles.keeper, ethBalance: null, lastAccruedAt: null, lastSweptAt: null, lastEventTx: null, lookbackDays: 1 },
    readAt: new Date().toISOString(),
  };
  try {
    const at = await head(client);
    // Every registered token, from the registry itself.
    const dir = await directory(client, book).catch(() => null);
    const tokens = dir ? dir.assets.map((x) => x.token) : [];
    const [code, r, eth] = await Promise.all([
      client.getCode({ address: c.SweepExecutor, blockNumber: at.block }),
      multi(
        client,
        [
          { address: c.SweepExecutor, abi: spareAuthAbi as Abi, functionName: 'paused' },
          ...tokens.map((t) => ({ address: c.StockRouter, abi: stockRouterAbi as Abi, functionName: 'oracleStatus', args: [t] })),
          ...tokens.map((t) => ({ address: c.AssetRegistry, abi: assetRegistryAbi as Abi, functionName: 'get', args: [t] })),
        ],
        at.block,
      ),
      client.getBalance({ address: book.roles.keeper, blockNumber: at.block }).catch(() => null),
    ]);
    out.rpcOk = true;
    out.block = at.block.toString();
    out.contractsDeployed = !!code && code !== '0x';
    out.paused = val<boolean | null>(r[0], null);
    const gate = keeperMarketHoursGate();
    out.market = sessionView(Number(at.timestamp), gate);
    const feedsOf = tokens.map((_, i) => val<RegistryAsset | null>(r[1 + tokens.length + i], null)?.feed ?? null);
    const rounds = await multi(
      client,
      feedsOf.map((f) => ({ address: (f ?? ZERO) as Address, abi: aggregatorV3Abi as Abi, functionName: 'latestRoundData' })),
      at.block,
    ).catch(() => [] as Res[]);
    out.oracles = tokens.map((t, i) => {
      const [status] = val<[number, bigint]>(r[i + 1], [4, 0n]);
      const round = val<[bigint, bigint, bigint, bigint, bigint] | null>(rounds[i], null);
      const market = feedsOf[i] ? marketView(Number(at.timestamp), round ? Number(round[3]) : null, gate) : null;
      return {
        symbol: symbolOf(t, book),
        status: ORACLE_STATUS[status] ?? 'UNKNOWN',
        oracleStatus: Number(status),
        label: oracleLabelFor(status, market),
        marketOpen: market ? market.open : null,
      };
    });
    out.keeper.ethBalance = eth === null ? null : formatUnitsExact(eth, 18);

    // Last keeper-driven events in the past day (newest-first scan, stops at the first hit).
    const win = activityWindow(at.block, 1, book.startBlock);
    const [acc, swept] = await Promise.all([
      scanActivity(client, book, { account: null, range: win, limit: 0, kinds: new Set<ActivityKind>(['accrued']) }),
      scanActivity(client, book, { account: null, range: win, limit: 0, kinds: new Set<ActivityKind>(['swept']) }),
    ]);
    const newest = (items: ActivityItem[]) => pageNewestFirst(items, 1).items[0] ?? null;
    const la = newest(acc.items);
    const ls = newest(swept.items);
    const timeOf = async (i: ActivityItem | null) => (i ? iso((await client.getBlock({ blockNumber: BigInt(i.blockNumber) })).timestamp) : null);
    out.keeper.lastAccruedAt = await timeOf(la);
    out.keeper.lastSweptAt = await timeOf(ls);
    const last = [la, ls]
      .filter((x): x is ActivityItem => !!x)
      .sort((a, b) => (BigInt(b.blockNumber) > BigInt(a.blockNumber) ? 1 : BigInt(b.blockNumber) < BigInt(a.blockNumber) ? -1 : 0))[0];
    out.keeper.lastEventTx = last?.txHash ?? null;
  } catch {
    /* rpcOk stays false, or the snapshot is partial */
  }
  out.readAt = new Date().toISOString();
  return out;
}
