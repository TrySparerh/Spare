/**
 * BIOS screen: Spare's power-on self-test, run against the live system.
 *
 * Every row is a real check, fired in parallel on mount and typed out in a
 * fixed order as each one resolves:
 *
 *   Chain      eth_chainId == 4663 + eth_blockNumber on the public RPC
 *   Contracts  bytecode at SweepExecutor
 *   Engine     SweepExecutor.paused() / feeBps() / threshold()
 *   Oracles    AssetRegistry.tokens() + isEligible -> StockRouter.oracleStatus
 *   Universe   active vs standby stocks
 *   Park       CashPark.adapter()
 *   Spare API  GET {API}/health + GET {API}/api/mcp/tools (DEGRADED when unreachable)
 *   Keeper     latest Accrued / AccountSwept log, else linked-wallet count
 *
 * Rows live in a map keyed by row id, never an appended list, so a re-run of
 * the checks (Fast Refresh, StrictMode, a remount) overwrites instead of
 * printing the readout twice. A failed or slow Spare API never blocks boot:
 * [ PRESS ENTER ] appears once the on-chain rows are typed (or after 15 s).
 *
 * Layout: welcome top-left, Spare logo top-right, the Spline brand scene
 * full-bleed behind everything, the readout as a Holo mini-dialog, the
 * $SPARE pill bottom-left and PRESS ENTER bottom-right (both holofoil keys).
 */
import { useEffect, useRef, useState, type ComponentType, type DetailedHTMLProps, type HTMLAttributes, type RefObject } from 'react';
import { encodeEventTopics, erc20Abi, toHex, type Abi, type Address, type Hex } from 'viem';
import { getPublicClient } from 'wagmi/actions';
import { version as APP_VERSION } from '../../../package.json';
import { API_BASE } from '@/lib/config';
import { wagmiConfig } from '@/lib/wagmi';
import {
  assetRegistryAbi,
  aggregatorV3Abi,
  cashParkAbi,
  ruleRegistryAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID, START_BLOCK, rememberAssets, sameAddress, shortAddr, symbolOf } from '@/lib/spare-chain/addresses';
import { symbolList } from '@/lib/spare-chain/universe';
import { oracleView } from '@/lib/spare-chain/hooks';
import { toUnixSeconds } from '@/lib/stockBoard';
import { useIsMobileNow } from '@/hooks/use-mobile';
import { MOBILE_FALLBACKS } from '@/lib/mobileScenes';
import { getT, tKey, useTranslation } from '@/i18n';
import { HoloBadge, HoloCard, HoloStar, HoloTitle } from './holo';
import { SpareSplineBg } from './SpareSplineBg';
import { disposeSplineViewer, injectSplineViewer, type SplineViewerElement } from '@/lib/splineViewer';
import { useSceneUrls } from '@/lib/useSceneUrls';

/** Row text is built outside React (the checks), in the active language at read time. */
const tf = getT('shell');

type SplineViewerProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  url?: string;
};

const SplineViewer = 'spline-viewer' as unknown as ComponentType<SplineViewerProps>;

/** Resize nudges queued for the Spline viewer; cleared on unmount. */
const cleanupTimers: number[] = [];

// Pinned to the viewer version the Spare scene was exported with. A scene
// built for 2.x can render subtly wrong (or not at all) on the 1.x viewer, so
// this moves with the scene. Served from Spline's own CDN rather than unpkg.
const SPLINE_SCRIPT_SRC =
  (import.meta.env.VITE_SPLINE_VIEWER as string | undefined) ||
  'https://cdn.spline.design/@splinetool/viewer@2.0.63/build/spline-viewer.js';
// Spare brand scene (the SPARE sparkle world). Production sets
// VITE_SPLINE_SCENE to this same scene; the fallback matches it so a build
// without the env var shows the Spare visuals too.
const SPARE_SPLINE_SCENE =
  (import.meta.env.VITE_SPLINE_SCENE as string | undefined) ||
  'https://prod.spline.design/27il4K9hrzXEhUv8/scene.splinecode';

/**
 * Desktop / tablet only: phones get SpareSplineBg's phone background, which
 * loads the viewer itself only for a phone scene. A page first loaded at phone
 * width may already have the phone viewer; that one serves here too (a second
 * viewer script cannot define <spline-viewer> again).
 */
function useSplineScript(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (!injectSplineViewer(SPLINE_SCRIPT_SRC)) return;
    // spline-viewer measures its canvas when the element upgrades, which can
    // land before layout settles — it then paints at a stale size in the
    // corner and never re-measures on its own. Nudging resize after load (and
    // once more after the scene streams in) makes it fill the frame.
    const nudge = () => window.dispatchEvent(new Event('resize'));
    const t1 = window.setTimeout(nudge, 600);
    const t2 = window.setTimeout(nudge, 2500);
    const t3 = window.setTimeout(nudge, 6000);
    cleanupTimers.push(t1, t2, t3);
  }, [enabled]);
}

/**
 * Stop and dispose the boot scene's runtime when it leaves the page (on to
 * the login screen, a scene swap, or a resize down to phone width). Without
 * this it kept rendering into a zero-size canvas behind the desktop.
 */
function useSplineTeardown(hostRef: RefObject<HTMLDivElement | null>, enabled: boolean, sceneUrl: string) {
  useEffect(() => {
    if (!enabled) return;
    const viewer = hostRef.current?.querySelector('spline-viewer') as SplineViewerElement | null | undefined;
    if (!viewer) return;
    return () => disposeSplineViewer(viewer);
  }, [hostRef, enabled, sceneUrl]);
}

/**
 * Force the Spline canvas to fill its host.
 *
 * spline-viewer sizes its internal canvas once, from whatever the host
 * measured at upgrade time, and does not reliably re-measure afterwards — CSS
 * on the host, resize events and attribute changes all failed to move it, so
 * the scene kept painting into a box in the corner with black around it.
 * Reaching into the shadow root and pinning the canvas to 100% is the one
 * thing it cannot ignore. A ResizeObserver reapplies it on every layout
 * change, and a short interval covers the window between element upgrade and
 * the scene finishing its stream-in.
 */
function useSplineFill(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let stop = false;

    const fit = () => {
      const el = document.querySelector('spline-viewer') as HTMLElement | null;
      if (!el) return;
      const canvas = (el as unknown as { shadowRoot?: ShadowRoot }).shadowRoot?.querySelector(
        'canvas',
      ) as HTMLCanvasElement | null;
      if (!canvas) return;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      canvas.style.objectFit = 'cover';
      // CSS size alone stretches the drawing buffer — the canvas was still
      // 300x150 internally, which upscales ~10x and reads as mush. Match the
      // buffer to the displayed size (capped at 2x DPR so a 4K panel does not
      // ask the GPU for a 7680px surface every frame).
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    fit();
    const iv = window.setInterval(() => {
      if (stop) return;
      fit();
    }, 400);
    // Stop polling once the scene has clearly settled; the observer takes over.
    const done = window.setTimeout(() => {
      stop = true;
      window.clearInterval(iv);
    }, 12000);

    const host = document.querySelector('[data-bios-spline]');
    const ro = host ? new ResizeObserver(fit) : null;
    if (host && ro) ro.observe(host);

    return () => {
      stop = true;
      window.clearInterval(iv);
      window.clearTimeout(done);
      ro?.disconnect();
    };
  }, [enabled]);
}

/* ─────────────────────────────── the checks ─────────────────────────────── */

type RowId = 'system' | 'chain' | 'contracts' | 'engine' | 'oracles' | 'universe' | 'park' | 'api' | 'keeper';
type Tone = 'ok' | 'warn' | 'fail' | 'muted';

/** Bracketed status words → their i18n keys ([OK] stays OK in every language). */
const TAGS = {
  OK: tKey('bios.tags.ok'),
  FAIL: tKey('bios.tags.fail'),
  WAIT: tKey('bios.tags.wait'),
  DEGRADED: tKey('bios.tags.degraded'),
  PAUSED: tKey('bios.tags.paused'),
  IDLE: tKey('bios.tags.idle'),
  STANDBY: tKey('bios.tags.standby'),
} as const;
type Tag = keyof typeof TAGS;

interface RowResult {
  /** Bracketed status word (OK, FAIL, STANDBY…); omitted for plain facts. */
  tag?: Tag;
  /**
   * The row text in the active language. A function, not a string: the
   * checks resolve once, but a language switch mid-boot re-renders every
   * row in the new language. Values (ages, counts) are captured when the
   * check resolves, so the text never drifts while it is being typed.
   */
  text: () => string;
  tone: Tone;
}

const ORDER: readonly RowId[] = ['system', 'chain', 'contracts', 'engine', 'oracles', 'universe', 'park', 'api', 'keeper'];

/** Row labels (i18n keys, translated at render). */
const LABELS: Record<RowId, string> = {
  system: tKey('bios.rows.system'),
  chain: tKey('bios.rows.chain'),
  contracts: tKey('bios.rows.contracts'),
  engine: tKey('bios.rows.engine'),
  oracles: tKey('bios.rows.oracles'),
  universe: tKey('bios.rows.universe'),
  park: tKey('bios.rows.park'),
  api: tKey('bios.rows.api'),
  keeper: tKey('bios.rows.keeper'),
};

/** Last row that comes from the chain; PRESS ENTER waits for rows up to here only. */
const LAST_CHAIN_ROW = ORDER.indexOf('park');

/** "1.0" from package.json's version — the same value About Spare shows in full. */
const RELEASE = APP_VERSION.split('.').slice(0, 2).join('.');
const SYSTEM_ROW: RowResult = { text: () => tf('bios.system', { release: RELEASE }), tone: 'ok' };

/** Spare API unreachable (DataLayer's boot probes print the same line). */
const API_OFFLINE_ROW: RowResult = { tag: 'DEGRADED', text: () => tf('bios.api.offline'), tone: 'warn' };

/** "[OK]" / "[失败]": the row's bracketed tag, or '' for a plain fact. */
function tagText(r: RowResult): string {
  return r.tag ? `[${tf(TAGS[r.tag])}]` : '';
}

/** Full typed string for a row (the leading ':' is drawn separately). */
function rowText(r: RowResult): string {
  return r.tag ? `${tagText(r)} ${r.text()}` : r.text();
}

/**
 * The app's own Robinhood Chain read client: the same transport every wagmi
 * read uses (rpc.mainnet.chain.robinhood.com unless VITE_RHC_RPC_URL points
 * elsewhere), with Multicall3 for the contract reads.
 */
function rpc() {
  const client = getPublicClient(wagmiConfig, { chainId: SPARE_CHAIN_ID });
  if (!client) throw new Error('Robinhood Chain client not configured');
  return client;
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

// viem's generic call types trip over these large const ABIs (the same reason
// LinkWalletApp casts), so calls go through as `never` and results are typed
// at the call site.
async function readOne<T>(c: Call): Promise<T> {
  return (await attempt(() => rpc().readContract(c as never))) as T;
}

/** One multicall; a failed sub-call reads as `undefined`. */
async function readMany(calls: Call[]): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const res = (await attempt(() => rpc().multicall({ allowFailure: true, contracts: calls } as never))) as {
    status: 'success' | 'failure';
    result?: unknown;
  }[];
  return res.map((r) => (r.status === 'success' ? r.result : undefined));
}

const CHECK_TIMEOUT_MS = 20_000;
const RETRY_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 20 s for a cold start, then one retry with a tighter window. */
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(fn(), CHECK_TIMEOUT_MS);
  } catch {
    await sleep(1_500);
    return withTimeout(fn(), RETRY_TIMEOUT_MS);
  }
}

function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return tf('bios.age.s', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return tf('bios.age.m', { m });
  const h = Math.floor(m / 60);
  if (h < 48) return tf('bios.age.hm', { h, m: m % 60 });
  return tf('bios.age.dh', { d: Math.floor(h / 24), h: h % 24 });
}

/** "1h 24m ago" / "1 小时 24 分前" for an age in seconds. */
function agoText(seconds: number): string {
  return tf('bios.ago', { age: fmtAge(seconds) });
}

const nowSec = () => Date.now() / 1000;

interface ChainHead {
  ok: boolean;
  head: bigint;
}

async function checkChain(): Promise<{ row: RowResult; head: ChainHead }> {
  try {
    const [id, head] = await attempt(() => Promise.all([rpc().getChainId(), rpc().getBlockNumber()]));
    if (id !== SPARE_CHAIN_ID) {
      return { row: { tag: 'FAIL', text: () => tf('bios.chain.wrong', { id }), tone: 'fail' }, head: { ok: false, head: 0n } };
    }
    const block = head.toLocaleString('en-US');
    return {
      row: { text: () => tf('bios.chain.ok', { id: SPARE_CHAIN_ID, block }), tone: 'ok' },
      head: { ok: true, head },
    };
  } catch {
    return { row: { tag: 'FAIL', text: () => tf('bios.chain.rpcDown'), tone: 'fail' }, head: { ok: false, head: 0n } };
  }
}

async function checkDeployed(): Promise<boolean> {
  const code = await attempt(() => rpc().getCode({ address: SPARE.SweepExecutor }));
  return !!code && code !== '0x';
}

async function readEngine(): Promise<RowResult> {
  const se = { address: SPARE.SweepExecutor, abi: sweepExecutorAbi as Abi };
  const [paused, feeBps, threshold] = await readMany([
    { ...se, functionName: 'paused' },
    { ...se, functionName: 'feeBps' },
    { ...se, functionName: 'threshold' },
  ]);
  if (paused === undefined || feeBps === undefined || threshold === undefined) throw new Error('engine read failed');
  if (paused) return { tag: 'PAUSED', text: () => tf('bios.engine.paused'), tone: 'warn' };
  const fee = Number((Number(feeBps) / 100).toFixed(2));
  const sweepAt = (Number(threshold) / 1e6).toFixed(2);
  return { tag: 'OK', text: () => tf('bios.engine.running', { fee, threshold: sweepAt }), tone: 'ok' };
}

interface StockState {
  token: Address;
  symbol: string;
  eligible: boolean;
  status: number | null;
  feed?: Address;
}

async function readUniverse(): Promise<StockState[]> {
  const registry = { address: SPARE.AssetRegistry, abi: assetRegistryAbi as Abi };
  const router = { address: SPARE.StockRouter, abi: stockRouterAbi as Abi };
  const tokens = await readOne<readonly Address[]>({ ...registry, functionName: 'tokens' });
  if (tokens.length === 0) return [];
  const res = await readMany(
    tokens.flatMap((t) => [
      { ...registry, functionName: 'isEligible', args: [t] },
      { ...router, functionName: 'oracleStatus', args: [t] },
      { ...registry, functionName: 'get', args: [t] },
      { address: t, abi: erc20Abi as Abi, functionName: 'symbol' },
    ]),
  );
  const stocks = tokens.map((token, i) => {
    const eligible = res[i * 4] as boolean | undefined;
    const os = res[i * 4 + 1] as readonly [number, bigint] | undefined;
    const cfg = res[i * 4 + 2] as { feed?: Address } | undefined;
    const sym = res[i * 4 + 3] as string | undefined;
    return {
      token,
      symbol: sym?.trim() || symbolOf(token),
      eligible: eligible === true,
      status: os ? Number(os[0]) : null,
      feed: cfg?.feed,
    };
  });
  // Teach symbolOf() the registry's tickers before any app window opens.
  rememberAssets(stocks.filter((s) => !s.symbol.includes('…')));
  return stocks;
}

/** Newest Chainlink update among the given feeds (unix seconds), for "last close". */
async function lastFeedUpdate(feeds: Address[]): Promise<number | null> {
  if (feeds.length === 0) return null;
  const res = await readMany(feeds.map((f) => ({ address: f, abi: aggregatorV3Abi as Abi, functionName: 'latestRoundData' })));
  let latest = 0;
  for (const r of res) {
    const round = r as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
    if (round) latest = Math.max(latest, Number(round[3]));
  }
  return latest > 0 ? latest : null;
}

async function oraclesRow(stocks: StockState[]): Promise<RowResult> {
  const active = stocks.filter((s) => s.eligible);
  const n = active.length;
  if (n === 0) return { tag: 'WAIT', text: () => tf('bios.oracles.none'), tone: 'warn' };
  const live = active.filter((s) => s.status === 0);
  const k = live.length;
  if (k === n) {
    const symbols = symbolList(active.map((s) => s.symbol), 6);
    return { tag: 'OK', text: () => tf('bios.oracles.live', { live: k, total: n, symbols }), tone: 'ok' };
  }
  if (active.every((s) => s.status === 1)) {
    const at = await lastFeedUpdate(active.map((s) => s.feed).filter((f): f is Address => !!f)).catch(() => null);
    const age = at ? nowSec() - at : null;
    const lastClose = () => (age !== null ? tf('bios.oracles.lastClose', { ago: agoText(age) }) : tf('bios.oracles.lastCloseUnknown'));
    return { tag: 'WAIT', text: () => tf('bios.oracles.closed', { lastClose: lastClose() }), tone: 'warn' };
  }
  const bad = active.find((s) => s.status !== 0);
  // oracleView's label is read at render too, so it follows the language.
  const status = () => (bad ? oracleView(bad.status).label : '—');
  return { tag: 'DEGRADED', text: () => tf('bios.oracles.degraded', { live: k, total: n, symbol: bad?.symbol ?? '?', status: status() }), tone: 'warn' };
}

function universeRow(stocks: StockState[]): RowResult {
  const active = stocks.filter((s) => s.eligible);
  const standby = stocks.filter((s) => !s.eligible);
  const symbols = symbolList(standby.map((s) => s.symbol), 6, ', ');
  return {
    text: () =>
      [
        tf('bios.universe.active', { count: active.length }),
        ...(standby.length > 0 ? [tf('bios.universe.standby', { count: standby.length, symbols })] : []),
      ].join(' · '),
    tone: active.length > 0 ? 'ok' : 'warn',
  };
}

async function readPark(): Promise<RowResult> {
  const adapter = await readOne<Address>({ address: SPARE.CashPark, abi: cashParkAbi as Abi, functionName: 'adapter' });
  if (sameAddress(adapter, SPARE.UsdgParkAdapter)) return { text: () => tf('bios.park.usdg'), tone: 'ok' };
  if (sameAddress(adapter, SPARE.SgovParkAdapter)) return { text: () => tf('bios.park.sgov'), tone: 'ok' };
  return { text: () => tf('bios.park.adapter', { address: shortAddr(adapter) }), tone: 'ok' };
}

/* ── keeper: event logs, newest first ── */

// Single address + single topic: the public RPC answers up to 10M blocks per
// eth_getLogs; 5M keeps a wide margin.
const LOG_SPAN = 5_000_000n;
const MAX_LOG_CHUNKS = 40;

const topic0 = (abi: typeof sweepExecutorAbi | typeof ruleRegistryAbi, eventName: string): Hex =>
  (encodeEventTopics({ abi, eventName } as Parameters<typeof encodeEventTopics>[0]) as Hex[])[0];

interface RawLog {
  blockNumber: Hex | null;
}

async function logsIn(address: Address, topic: Hex, from: bigint, to: bigint): Promise<RawLog[]> {
  return (await attempt(() =>
    rpc().request({
      method: 'eth_getLogs',
      params: [{ address, fromBlock: toHex(from), toBlock: toHex(to), topics: [topic] }],
    } as never),
  )) as RawLog[];
}

/** Block of the newest `topic` log from `address`, or null when there is none. */
async function newestLogBlock(address: Address, topic: Hex, head: bigint): Promise<bigint | null> {
  let to = head;
  for (let i = 0; i < MAX_LOG_CHUNKS && to >= START_BLOCK; i++) {
    const from = to - LOG_SPAN + 1n > START_BLOCK ? to - LOG_SPAN + 1n : START_BLOCK;
    const logs = await logsIn(address, topic, from, to);
    let best: bigint | null = null;
    for (const l of logs) {
      if (l.blockNumber) {
        const b = BigInt(l.blockNumber);
        if (best === null || b > best) best = b;
      }
    }
    if (best !== null) return best;
    to = from - 1n;
  }
  return null;
}

async function countLogs(address: Address, topic: Hex, head: bigint): Promise<number> {
  let to = head;
  let n = 0;
  for (let i = 0; i < MAX_LOG_CHUNKS && to >= START_BLOCK; i++) {
    const from = to - LOG_SPAN + 1n > START_BLOCK ? to - LOG_SPAN + 1n : START_BLOCK;
    n += (await logsIn(address, topic, from, to)).length;
    to = from - 1n;
  }
  return n;
}

async function blockTime(block: bigint): Promise<number> {
  const b = await attempt(() => rpc().getBlock({ blockNumber: block }));
  return Number(b.timestamp);
}

/** Round-up / sweep ages → the Keeper row. `null` timestamps mean "never". */
function keeperFromTimes(accruedAt: number | null, sweptAt: number | null): RowResult | null {
  if (accruedAt === null && sweptAt === null) return null;
  const now = nowSec();
  const latest = Math.max(accruedAt ?? 0, sweptAt ?? 0);
  if (now - latest > 48 * 3600) {
    const idle = now - latest;
    return { tag: 'IDLE', text: () => tf('bios.keeper.idle', { ago: agoText(idle) }), tone: 'warn' };
  }
  const roundUpAge = accruedAt === null ? null : now - accruedAt;
  const sweepAge = sweptAt === null ? null : now - sweptAt;
  return {
    tag: 'OK',
    text: () =>
      [
        roundUpAge === null ? tf('bios.keeper.noRoundUp') : tf('bios.keeper.lastRoundUp', { ago: agoText(roundUpAge) }),
        sweepAge === null ? tf('bios.keeper.noSweep') : tf('bios.keeper.lastSweep', { ago: agoText(sweepAge) }),
      ].join(' · '),
    tone: 'ok',
  };
}

async function readKeeper(head: bigint): Promise<RowResult> {
  const [accruedBlock, sweptBlock] = await Promise.all([
    newestLogBlock(SPARE.SweepExecutor, topic0(sweepExecutorAbi, 'Accrued'), head),
    newestLogBlock(SPARE.SweepExecutor, topic0(sweepExecutorAbi, 'AccountSwept'), head),
  ]);
  const [accruedAt, sweptAt] = await Promise.all([
    accruedBlock === null ? null : blockTime(accruedBlock),
    sweptBlock === null ? null : blockTime(sweptBlock),
  ]);
  const active = keeperFromTimes(accruedAt, sweptAt);
  if (active) return active;
  const [linked, unlinked] = await Promise.all([
    countLogs(SPARE.RuleRegistry, topic0(ruleRegistryAbi, 'Linked'), head),
    countLogs(SPARE.RuleRegistry, topic0(ruleRegistryAbi, 'Unlinked'), head),
  ]);
  const w = Math.max(0, linked - unlinked);
  return {
    tag: 'STANDBY',
    text: () => (w === 1 ? tf('bios.keeper.watchingOne', { count: w }) : tf('bios.keeper.watchingMany', { count: w })),
    tone: 'warn',
  };
}

/* ── Spare API ── */

interface ApiHealth {
  ok?: boolean;
  service?: string;
  mcp?: { tools?: number };
  keeper?: { lastAccruedAt?: number | string | null; lastSweptAt?: number | string | null };
}

async function getJson(path: string, timeoutMs: number): Promise<unknown> {
  const r = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

/** Only the rebuilt Spare API counts as online; anything else at that host is not it. */
async function readApi(): Promise<{ row: RowResult; health: ApiHealth | null }> {
  const offline = { row: API_OFFLINE_ROW, health: null };
  let health: ApiHealth | null = null;
  try {
    health = (await getJson('/health', CHECK_TIMEOUT_MS)) as ApiHealth;
  } catch {
    // Cold start: give the API a beat, then one tighter retry.
    await sleep(1_500);
    try {
      health = (await getJson('/health', RETRY_TIMEOUT_MS)) as ApiHealth;
    } catch {
      return offline;
    }
  }
  if (!health || typeof health !== 'object' || health.service !== 'spare-api') return offline;
  let tools: number | null = typeof health.mcp?.tools === 'number' ? health.mcp.tools : null;
  try {
    const cat = (await getJson('/api/mcp/tools', RETRY_TIMEOUT_MS)) as unknown;
    const list = Array.isArray(cat) ? cat : Array.isArray((cat as { tools?: unknown[] })?.tools) ? (cat as { tools: unknown[] }).tools : null;
    if (list) tools = list.length;
  } catch {
    /* health already answered; the catalog is a nice-to-have */
  }
  const status = health.ok === false ? { tag: 'DEGRADED' as const, tone: 'warn' as Tone } : { tag: 'OK' as const, tone: 'ok' as Tone };
  const toolCount = tools ?? '—';
  return {
    row: { ...status, text: () => tf('bios.api.online', { tools: toolCount }) },
    health,
  };
}

/* ─────────────────────────────── component ─────────────────────────────── */

type Results = Partial<Record<RowId, RowResult>>;

/** Fires every check once per mount; results are keyed, so a re-run just overwrites. */
function useBiosChecks(): Results {
  const [results, setResults] = useState<Results>({ system: SYSTEM_ROW });

  useEffect(() => {
    let live = true;
    const put = (id: RowId, r: RowResult) => {
      if (live) setResults((prev) => ({ ...prev, [id]: r }));
    };
    /** `why` is an i18n key (bios.reason.*). */
    const skipped = (why: string): RowResult => ({ text: () => tf('bios.skipped', { reason: tf(why) }), tone: 'muted' });
    const failed: RowResult = { tag: 'FAIL', text: () => tf('bios.readFailed'), tone: 'fail' };
    const RPC_DOWN = tKey('bios.reason.rpcDown');
    const NOT_DEPLOYED = tKey('bios.reason.notDeployed');

    const chainP = checkChain();
    const deployedP = checkDeployed().catch(() => null);
    const apiP = readApi();

    void chainP.then(({ row }) => put('chain', row));

    // Rows that need the contracts: explain a dead RPC or a missing deployment
    // once, in plain words, instead of a column of FAILs.
    const gated = async (id: RowId, read: () => Promise<RowResult>) => {
      const [{ head }, deployed] = await Promise.all([chainP, deployedP]);
      if (!head.ok) return put(id, skipped(RPC_DOWN));
      if (deployed === false) return put(id, skipped(NOT_DEPLOYED));
      try {
        put(id, await read());
      } catch {
        put(id, failed);
      }
    };

    void (async () => {
      const [{ head }, deployed] = await Promise.all([chainP, deployedP]);
      if (!head.ok) return put('contracts', skipped(RPC_DOWN));
      if (deployed === null) return put('contracts', failed);
      put(
        'contracts',
        deployed
          ? { tag: 'OK', text: () => tf('bios.contracts.ok', { address: shortAddr(SPARE.SweepExecutor) }), tone: 'ok' }
          : { tag: 'FAIL', text: () => tf('bios.contracts.noCode'), tone: 'fail' },
      );
    })();

    void gated('engine', readEngine);
    const universeP = readUniverse();
    universeP.catch(() => undefined);
    void gated('oracles', async () => oraclesRow(await universeP));
    void gated('universe', async () => universeRow(await universeP));
    void gated('park', readPark);

    // "on-chain app still works" is only true while the chain answers.
    void Promise.all([apiP, chainP]).then(([{ row, health }, { head }]) =>
      put('api', !health && !head.ok ? { ...row, text: () => tf('bios.api.offlineShort') } : row),
    );

    void (async () => {
      const [{ head }, deployed] = await Promise.all([chainP, deployedP]);
      const fromApi = async (): Promise<RowResult | null> => {
        const k = (await apiP).health?.keeper;
        if (!k) return null;
        return (
          keeperFromTimes(toUnixSeconds(k.lastAccruedAt), toUnixSeconds(k.lastSweptAt)) ?? {
            tag: 'STANDBY',
            text: () => tf('bios.keeper.noRoundUps'),
            tone: 'warn',
          }
        );
      };
      if (!head.ok || deployed === false) {
        const r = await fromApi();
        return put('keeper', r ?? skipped(!head.ok ? RPC_DOWN : NOT_DEPLOYED));
      }
      try {
        put('keeper', await readKeeper(head.head));
      } catch {
        put('keeper', (await fromApi()) ?? { text: () => tf('bios.keeper.unavailable'), tone: 'muted' });
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return results;
}

/** Typing speed (characters per second) and redraw tick. */
const TYPE_CPS = 190;
const TYPE_TICK_MS = 16;

interface Cursor {
  row: number;
  char: number;
}

/** Type `budget` more characters, rolling onto the next row(s) whose check has resolved. */
function advanceCursor(c: Cursor, budget: number, results: Results): Cursor {
  let { row, char } = c;
  let left = budget;
  while (left > 0 && row < ORDER.length) {
    const r = results[ORDER[row]];
    if (!r) break;
    const len = rowText(r).length;
    if (char + left < len) {
      char += left;
      left = 0;
    } else {
      left -= len - char;
      row += 1;
      char = 0;
    }
  }
  return row === c.row && char === c.char ? c : { row, char };
}

/** PRESS ENTER shows by now even if a chain check is still hanging. */
const READY_FALLBACK_MS = 15_000;

export function BiosScreen({ onContinue }: { onContinue: () => void }) {
  const scenes = useSceneUrls('bios', SPARE_SPLINE_SCENE);
  // Re-renders on a language switch; row text is read through tf at render.
  const { t } = useTranslation('shell');
  // Phones (< 768px, read synchronously so the first frame is already the
  // phone branch): no 16:9 scene, no viewer script — the portrait background
  // below — and the continue key from the first frame.
  const phone = useIsMobileNow();
  useSplineFill(!phone);
  useSplineScript(!phone);
  const splineHostRef = useRef<HTMLDivElement | null>(null);
  useSplineTeardown(splineHostRef, !phone, scenes.url);
  const results = useBiosChecks();

  // Typing cursor: rows before `row` are fully typed; `row` is typing (or
  // waiting for its check); later rows are hidden. Rows appear strictly in
  // ORDER even though the checks resolve in any order.
  const [cursor, setCursor] = useState<Cursor>({ row: 0, char: 0 });
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  const typingDone = cursor.row >= ORDER.length;
  useEffect(() => {
    if (typingDone) return;
    // Time-based, so a busy main thread (the Spline scene streaming in) slows
    // the frame rate, not the boot.
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const budget = Math.max(1, Math.round(((now - last) * TYPE_CPS) / 1000));
      last = now;
      setCursor((c) => advanceCursor(c, budget, resultsRef.current));
    }, TYPE_TICK_MS);
    return () => window.clearInterval(id);
  }, [typingDone]);

  const [fallbackReady, setFallbackReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setFallbackReady(true), READY_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, []);
  // Phones never wait on the chain rows: a slow mobile RPC could otherwise hold
  // the only way forward for up to 15 s. The readout keeps typing behind it.
  const allReady = phone || cursor.row > LAST_CHAIN_ROW || fallbackReady;

  // Keyboard advance
  useEffect(() => {
    if (!allReady) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // A focused control (the language key, its menu) keeps its own Enter.
      const target = e.target as HTMLElement | null;
      if (target && target !== document.body && target.closest?.('button, a[href], input, select, textarea, [role="menuitem"]') && !target.closest('[data-bios-enter]')) return;
      e.preventDefault();
      onContinue();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allReady, onContinue]);

  useEffect(
    () => () => {
      while (cleanupTimers.length) window.clearTimeout(cleanupTimers.pop());
    },
    [],
  );

  const anyFail = ORDER.some((id) => results[id]?.tone === 'fail');

  return (
    <div className="bios-screen">
      {/* Top-left: welcome */}
      <div data-bios-welcome className="bios-welcome">
        <HoloTitle as="h1" size="md" className="bios-welcome__title">
          {t('welcome.title')}
        </HoloTitle>
        <HoloTitle as="div" size="sm" font="pixel" fill="cream" className="bios-welcome__sub">
          Robinhood Chain
        </HoloTitle>
      </div>

      {/* Top-right: the Spare mark. translate="no" keeps a browser's page
          translator from rewriting the alt text. */}
      <img className="bios-logo notranslate" translate="no" src="/icons/spare-logo.png" alt="Spare" width={128} height={128} />

      {/* The Spline brand scene, full-bleed behind every overlay. Phones: the
          phone-native scene once MOBILE_SCENES.bios is set, else the portrait
          poster (CSS drifts it) — never the 16:9 scene. */}
      {phone ? (
        <SpareSplineBg
          key={`${scenes.url}|${scenes.mobileUrl}`}
          url={scenes.url}
          marker="data-bios-spline"
          mobileUrl={scenes.mobileUrl}
          mobilePoster={MOBILE_FALLBACKS.bios.poster}
        />
      ) : (
      <div
        ref={splineHostRef}
        data-bios-spline
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      >
        <SplineViewer
          key={scenes.url}
          url={scenes.url}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            background: 'transparent',
          }}
        />
      </div>
      )}

      {/* The readout: a Holo mini-dialog with a deep-indigo screen body. */}
      <div data-bios-rows className="bios-panel">
        <HoloCard
          title={t('bios.cardTitle')}
          icon={<HoloStar size={16} keyline={false} />}
          accent={
            <HoloBadge
              label={!typingDone ? t('bios.badge.checking') : anyFail ? t('bios.badge.attention') : t('common.ready')}
              tone={!typingDone ? 'warn' : anyFail ? 'bad' : 'good'}
              variant="solid"
              dot
              pulse={!typingDone}
            />
          }
          tone="screen"
          compact
          aria-label={t('bios.cardAria')}
        >
          <div className="bios-readout">
            {ORDER.map((id, i) => {
              if (i > cursor.row) return null;
              const r = results[id];
              const active = i === cursor.row;
              const full = r ? rowText(r) : '';
              const n = active ? cursor.char : full.length;
              const tagStr = r ? tagText(r) : '';
              const tagShown = full.slice(0, Math.min(n, tagStr.length));
              const rest = full.slice(tagStr.length, n);
              return (
                <div key={id} className={`bios-row bios-row--${r?.tone ?? 'pending'}`}>
                  <span className="bios-label">{t(LABELS[id])}</span>
                  <span className="bios-value">
                    <span className="bios-colon" aria-hidden>
                      :
                    </span>
                    {r ? (
                      <>
                        {tagShown && <span className={`bios-tag bios-tag--${r.tone}`}>{tagShown}</span>}
                        {rest}
                      </>
                    ) : (
                      <span className="bios-wait">{t('bios.pending')}</span>
                    )}
                    {active && <span className="blink-caret">_</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </HoloCard>
      </div>

      {/* Bottom-left: $SPARE pill. The token does not exist yet, so it is a
          disabled holofoil key that only ever says SOON (no CA, ever, until
          it ships). */}
      <button
        type="button"
        data-bios-ca
        className="holo-btn holo-btn--primary spare-foil spare-foil--pill"
        disabled
        title={t('bios.spareSoonTitle')}
      >
        <span>$SPARE</span>
        <span className="spare-foil__dot" aria-hidden>
          ·
        </span>
        <span className="spare-foil__tag">{t('common.soon')}</span>
      </button>

      {allReady && (
        <button
          type="button"
          data-bios-enter
          onClick={onContinue}
          className="holo-btn holo-btn--primary spare-foil spare-foil--cta"
        >
          {phone ? t('bios.tapToEnter') : t('bios.pressEnter')}
        </button>
      )}
    </div>
  );
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export default BiosScreen;
