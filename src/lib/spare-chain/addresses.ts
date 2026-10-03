/**
 * SPARE contract addresses on Robinhood Chain mainnet (4663).
 *
 * `deployment.4663.json` is the single source: it holds the deterministic
 * addresses from the mainnet dry run until broadcast, then gets overwritten
 * with the broadcast result in the same shape. Nothing else in the frontend
 * hard-codes a SPARE address.
 *
 * Stock tokens are NOT listed here: the universe is whatever AssetRegistry
 * holds (universe.ts reads tokens() + symbol()/name() and calls
 * rememberAssets()), so a newly registered asset shows up without a release.
 *
 * Until the contracts are live the apps must not read them (every call would
 * revert or return zero-looking data), so `isDeployed()` checks for bytecode at
 * SweepExecutor — the last contract the deploy script creates.
 */
import { getAddress, type Address, type PublicClient } from 'viem';
import deployment from './deployment.4663.json';

export const SPARE_CHAIN_ID = 4663 as const;

export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export interface SpareDeployment {
  chainId: number;
  /** First block to scan for SPARE events (deploy block or just before). */
  startBlock: number;
  contracts: {
    AssetRegistry: string;
    RuleRegistry: string;
    ElectionRegistry: string;
    ScreeningGate: string;
    StockRouter: string;
    CashPark: string;
    FeeVault: string;
    SweepExecutor: string;
    UsdgParkAdapter: string;
    SgovParkAdapter: string;
  };
  external: { USDG: string; Permit2: string; PoolManager: string };
}

const raw = deployment as SpareDeployment;

if (raw.chainId !== SPARE_CHAIN_ID) {
  throw new Error(`deployment.4663.json has chainId ${raw.chainId}, expected ${SPARE_CHAIN_ID}`);
}

type ContractName = keyof SpareDeployment['contracts'];
type ExternalName = keyof SpareDeployment['external'];

function checksumAll<K extends string>(m: Record<K, string>): Record<K, Address> {
  const out = {} as Record<K, Address>;
  for (const k of Object.keys(m) as K[]) out[k] = getAddress(m[k]);
  return out;
}

/** Checksummed SPARE contract addresses. */
export const SPARE: Readonly<Record<ContractName, Address>> = checksumAll(raw.contracts);

/** Checksummed external dependencies (USDG, Permit2, v4 PoolManager). */
export const EXTERNAL: Readonly<Record<ExternalName, Address>> = checksumAll(raw.external);

export const START_BLOCK = BigInt(raw.startBlock);

/** USDG base units — 6 decimals. */
export const USDG_DECIMALS = 6;
/** Robinhood stock tokens — 18 decimals. */
export const STOCK_DECIMALS = 18;

/* ------------------------------ asset names ------------------------------- */

/**
 * Token -> on-chain symbol()/name(), filled from the registry read
 * (universe.ts `useAssetCatalog` / `readAssetCatalog`). Plain helpers that
 * only have an address (feed rows, error text, activity) name tokens through
 * this; before the first read they show a short address.
 */
const assetNames = new Map<string, { symbol: string; name: string | null }>();
let assetNamesVersion = 0;

/** Remember the symbols (and names) the registry read returned. Returns true when anything changed. */
export function rememberAssets(entries: readonly { token: string; symbol: string; name?: string | null }[]): boolean {
  let changed = false;
  for (const e of entries) {
    if (!e.token || !e.symbol) continue;
    const lc = e.token.toLowerCase();
    const prev = assetNames.get(lc);
    const name = e.name ?? prev?.name ?? null;
    if (prev?.symbol === e.symbol && prev.name === name) continue;
    assetNames.set(lc, { symbol: e.symbol, name });
    changed = true;
  }
  if (changed) assetNamesVersion += 1;
  return changed;
}

/** Bumps whenever rememberAssets() learns something (a cheap re-render key). */
export function assetNamesStamp(): number {
  return assetNamesVersion;
}

/** Test hook — forget every remembered asset name. */
export function forgetAssets(): void {
  assetNames.clear();
  assetNamesVersion += 1;
}

/** The token's name() as read from the chain, or null before the registry read. */
export function assetNameOf(token: string | undefined | null): string | null {
  return token ? assetNames.get(token.toLowerCase())?.name ?? null : null;
}

/** Ticker for a token address; USDG is named too. Falls back to a short address. */
export function symbolOf(token: string | undefined | null): string {
  if (!token) return '—';
  const lc = token.toLowerCase();
  if (lc === EXTERNAL.USDG.toLowerCase()) return 'USDG';
  return assetNames.get(lc)?.symbol ?? `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function shortAddr(a: string | undefined | null): string {
  if (!a) return '—';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/* ------------------------------ deployment -------------------------------- */

/** How long a "not deployed yet" answer is trusted before asking again. */
const NEGATIVE_TTL_MS = 30_000;

let deployedCache: { value: boolean; at: number } | null = null;
let inflight: Promise<boolean> | null = null;

/**
 * True once SweepExecutor has bytecode on 4663.
 *
 * Cached: a positive answer is permanent for the session (contracts do not
 * un-deploy); a negative one is re-checked after 30s so an open tab notices
 * the broadcast without a reload. Concurrent callers share one request.
 */
export async function isDeployed(client: Pick<PublicClient, 'getCode'>): Promise<boolean> {
  if (deployedCache?.value) return true;
  if (deployedCache && Date.now() - deployedCache.at < NEGATIVE_TTL_MS) return false;
  if (inflight) return inflight;
  inflight = client
    .getCode({ address: SPARE.SweepExecutor })
    .then((code) => {
      const value = !!code && code !== '0x';
      deployedCache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test hook — forget the cached deployment answer. */
export function resetDeployedCache(): void {
  deployedCache = null;
  inflight = null;
}
