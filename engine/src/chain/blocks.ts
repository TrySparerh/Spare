/**
 * L2 block and time helpers.
 *
 * On RHC (Arbitrum Nitro) eth_blockNumber is the L2 block — the same clock the
 * contracts read through ArbSys (L2Clock). Blocks are ~0.1s apart and block
 * timestamps have 1s resolution, so ~10 consecutive blocks share a timestamp.
 *
 * Logs from Nitro carry `blockTimestamp: "0x0"`: a log's time MUST be read from
 * its block. `blockTimes` does that with a bounded cache (a block's timestamp
 * never changes once it is behind the finality buffer).
 */
import type { PublicClient } from "viem";

export async function headBlock(client: PublicClient): Promise<bigint> {
  return client.getBlockNumber({ cacheTime: 0 });
}

/** Newest block an accrual may cover: head - finalityBuffer (never negative). */
export function finalBlock(head: bigint, finalityBuffer: bigint): bigint {
  return head > finalityBuffer ? head - finalityBuffer : 0n;
}

// ---------------------------------------------------------------------------
// block timestamps
// ---------------------------------------------------------------------------
const MAX_CACHE = 20_000;
const timeCache = new WeakMap<PublicClient, Map<bigint, bigint>>();

function cacheFor(client: PublicClient) {
  let m = timeCache.get(client);
  if (!m) timeCache.set(client, (m = new Map()));
  return m;
}

export async function blockTime(client: PublicClient, n: bigint): Promise<bigint> {
  const m = cacheFor(client);
  const hit = m.get(n);
  if (hit !== undefined) return hit;
  const b = await client.getBlock({ blockNumber: n, includeTransactions: false });
  if (m.size >= MAX_CACHE) m.delete(m.keys().next().value as bigint);
  m.set(n, b.timestamp);
  return b.timestamp;
}

/** Timestamps for many blocks; concurrent calls are folded by JSON-RPC batching. */
export async function blockTimes(client: PublicClient, blocks: Iterable<bigint>, concurrency = 25): Promise<Map<bigint, bigint>> {
  const unique = [...new Set(blocks)];
  const out = new Map<bigint, bigint>();
  for (let i = 0; i < unique.length; i += concurrency) {
    const slice = unique.slice(i, i + concurrency);
    const times = await Promise.all(slice.map((n) => blockTime(client, n)));
    slice.forEach((n, j) => out.set(n, times[j]!));
  }
  return out;
}

/**
 * First block whose timestamp is >= `ts` (clamped to [0, head]).
 * Interpolation search with a bisection fallback: blocks are near-uniform on
 * RHC, so it typically converges in a handful of getBlock calls.
 */
export async function blockAtOrAfter(
  client: PublicClient,
  ts: bigint,
  head?: { number: bigint; timestamp: bigint },
): Promise<bigint> {
  const h = head ?? (await (async () => {
    const n = await headBlock(client);
    return { number: n, timestamp: await blockTime(client, n) };
  })());
  if (ts > h.timestamp) return h.number;
  const genesisTs = await blockTime(client, 0n);
  if (ts <= genesisTs) return 0n;

  // Invariant: time(lo) < ts <= time(hi).
  let lo = 0n;
  let loTs = genesisTs;
  let hi = h.number;
  let hiTs = h.timestamp;
  for (let i = 0; i < 80 && hi - lo > 1n; i++) {
    let mid: bigint;
    const span = hiTs - loTs;
    if (i % 3 !== 2 && span > 0n) {
      mid = lo + ((ts - loTs) * (hi - lo)) / span;
      if (mid <= lo) mid = lo + 1n;
      if (mid >= hi) mid = hi - 1n;
    } else {
      mid = lo + (hi - lo) / 2n; // bisection step guarantees progress
    }
    const t = await blockTime(client, mid);
    if (t < ts) {
      lo = mid;
      loTs = t;
    } else {
      hi = mid;
      hiTs = t;
    }
  }
  return hi;
}
