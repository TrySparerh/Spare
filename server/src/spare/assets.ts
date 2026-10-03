/**
 * The Spare asset directory — what AssetRegistry holds, read from the chain.
 *
 *   AssetRegistry.tokens()          the registered tokens
 *   AssetRegistry.get(token)        active flag, feed, band, pinned PoolKey
 *   token.symbol() / token.name()   how each one is named
 *
 * Nothing here lists a ticker: a newly registered asset shows up in every
 * spare_* tool on the next read. The directory is cached for a minute and
 * shared by concurrent callers; a failed refresh keeps serving the last good
 * read (and says how old it is) rather than forgetting every name.
 *
 * Kept free of book.ts imports so book.ts can name tokens through it.
 */
import { getAddress, type Abi, type Address, type PublicClient } from 'viem';
import { assetRegistryAbi, erc20Abi } from './abis.js';
import { aggregate3, type Res } from './multicall.js';

export interface DirectoryAsset {
  token: Address;
  /** token.symbol(), upper-case as the token returns it. */
  symbol: string;
  /** token.name() without the " • Robinhood Token" suffix. */
  name: string | null;
  active: boolean;
  feed: Address | null;
  bandBps: number | null;
}

export interface AssetDirectory {
  /** ms since epoch of the registry read. */
  readAt: number;
  /** Registry order. */
  assets: DirectoryAsset[];
  byToken: ReadonlyMap<string, DirectoryAsset>;
  bySymbol: ReadonlyMap<string, DirectoryAsset>;
}

export const ASSET_DIRECTORY_TTL_MS = 60_000;

/** "Apple • Robinhood Token" → "Apple". */
export function cleanTokenName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s*[•·|-]\s*Robinhood Token\s*$/i, '').trim();
  return s || null;
}

export function makeDirectory(assets: readonly DirectoryAsset[], readAt = Date.now()): AssetDirectory {
  const byToken = new Map<string, DirectoryAsset>();
  const bySymbol = new Map<string, DirectoryAsset>();
  for (const a of assets) {
    byToken.set(a.token.toLowerCase(), a);
    // First registration wins a (theoretical) duplicate symbol; the address always resolves.
    if (a.symbol && !bySymbol.has(a.symbol.toUpperCase())) bySymbol.set(a.symbol.toUpperCase(), a);
  }
  return { readAt, assets: [...assets], byToken, bySymbol };
}

let current: AssetDirectory | null = null;
let inflight: Promise<AssetDirectory> | null = null;

/** The last directory read (null before the first). Sync callers name tokens from it. */
export function currentAssetDirectory(): AssetDirectory | null {
  return current;
}

/** Test hook: install a directory (or forget it). */
export function setAssetDirectory(d: AssetDirectory | null): void {
  current = d;
  inflight = null;
}

/**
 * One registry read: tokens(), then get() + symbol() + name() for each in one
 * multicall (multicall.ts). A token whose symbol() reverts is named by its
 * address; an RPC failure fails the read, so a blank directory is never
 * cached in place of the last good one.
 */
export async function readAssetDirectory(client: PublicClient, registry: Address, blockNumber?: bigint): Promise<AssetDirectory> {
  const tokens = (await client.readContract({
    address: registry,
    abi: assetRegistryAbi,
    functionName: 'tokens',
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  })) as Address[];
  const r = await aggregate3(
    client,
    tokens.flatMap((t) => [
      { address: registry, abi: assetRegistryAbi as Abi, functionName: 'get', args: [t] },
      { address: t, abi: erc20Abi as Abi, functionName: 'symbol' },
      { address: t, abi: erc20Abi as Abi, functionName: 'name' },
    ]),
    blockNumber,
  );
  const ok = (x: Res | undefined) => (x && x.ok ? x.value : undefined);
  const assets = tokens.map((t, i): DirectoryAsset => {
    const get = ok(r[i * 3]) as { active?: boolean; feed?: Address; bandBps?: number } | undefined;
    const sym = ok(r[i * 3 + 1]);
    return {
      token: getAddress(t),
      symbol: typeof sym === 'string' && sym.trim() ? sym.trim() : '',
      name: cleanTokenName(ok(r[i * 3 + 2])),
      active: !!get?.active,
      feed: get?.feed ? getAddress(get.feed) : null,
      bandBps: get?.bandBps != null ? Number(get.bandBps) : null,
    };
  });
  return makeDirectory(assets);
}

/**
 * The directory, at most `maxAgeMs` old. Concurrent callers share one read;
 * when a refresh fails but an older read exists, that read is returned.
 */
export async function loadAssetDirectory(
  client: PublicClient,
  registry: Address,
  { maxAgeMs = ASSET_DIRECTORY_TTL_MS }: { maxAgeMs?: number } = {},
): Promise<AssetDirectory> {
  if (current && Date.now() - current.readAt < maxAgeMs) return current;
  if (inflight) return inflight;
  inflight = readAssetDirectory(client, registry)
    .then((d) => {
      current = d;
      return d;
    })
    .catch((err) => {
      if (current) return current;
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Remember a directory another read already produced (spare_universe reads the same data). */
export function rememberDirectory(d: AssetDirectory): void {
  if (!current || d.readAt >= current.readAt) current = d;
}
