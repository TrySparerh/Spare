/**
 * Holder snapshot — $SPARE holders by tier (powers the token page's tier panel).
 *
 * $SPARE has not launched, so until SPARE_TOKEN_ADDRESS is set this returns an
 * empty distribution (`token.launched: false`, zero holders, zero
 * supply) — never another token's data.
 *
 * Once the token is live:
 *   1. walk Transfer events on the $SPARE contract (recent window, chunked),
 *   2. batch-read balanceOf for every address seen (multicall3),
 *   3. drop dust, classify by tier, cache 15 minutes.
 * The endpoint never blocks on enumeration: a cold cache returns a warming
 * stub while the snapshot builds in the background. A log chunk or a balance
 * that could not be read leaves holders out, and the snapshot then says
 * `complete: false`.
 */
import { formatUnits, getAddress, parseAbi, parseAbiItem, type Address } from 'viem';
import { getSpareClient } from '../spare/client.js';
import { safeErrorMessage } from '../redact.js';
import {
  classifyTier,
  emptyTierDistribution,
  getSpareTokenStatus,
  spareTokenAddress,
  type HolderTier,
  type TierDistribution,
} from './spareToken.js';

export type { HolderTier, TierDistribution };

// Reads go through the one Spare RPC client (SPARE_RPC_URL, else RHC_RPC_URL,
// else the public RHC RPC; spare/client.ts). Public RPCs rate-limit historical
// log queries, so point SPARE_RPC_URL at a provider before the token launches.
const SNAPSHOT_TTL_MS = 15 * 60_000;
const DUST_FLOOR = 1; // below 1 whole token is not a holder
const SCAN_BLOCKS_BACK = 2_000_000n; // ~2.3 days of ~0.1 s RHC blocks
const BLOCK_CHUNK = 50_000n;
const ENUMERATION_TIMEOUT_MS = 90_000;

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

let cached: TierDistribution | null = null;
let cachedFor: string | null = null;
let warming = false;
let lastWarmAttempt = 0;

/** Every address in the token's recent Transfer logs; `failedChunks` counts the log reads that failed. */
async function enumerateCandidateAddresses(token: Address): Promise<{ addresses: Set<Address>; failedChunks: number }> {
  const client = getSpareClient();
  const addresses = new Set<Address>();
  const tip = await client.getBlockNumber();
  if (tip === 0n) return { addresses, failedChunks: 0 };
  const earliest = tip > SCAN_BLOCKS_BACK ? tip - SCAN_BLOCKS_BACK : 0n;
  let errCount = 0;
  for (let to = tip; to > earliest; to -= BLOCK_CHUNK) {
    const from = to - BLOCK_CHUNK + 1n > earliest ? to - BLOCK_CHUNK + 1n : earliest;
    try {
      const logs = await client.getLogs({ address: token, event: TRANSFER_EVENT, fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (log.args.from) addresses.add(getAddress(log.args.from));
        if (log.args.to) addresses.add(getAddress(log.args.to));
      }
    } catch (err) {
      errCount += 1;
      if (errCount <= 3) console.warn(`[holderSnapshot] getLogs ${from}-${to} failed: ${safeErrorMessage(err)}`);
    }
  }
  addresses.delete(getAddress('0x000000000000000000000000000000000000dEaD'));
  addresses.delete(getAddress('0x0000000000000000000000000000000000000000'));
  return { addresses, failedChunks: errCount };
}

async function snapshotNow(token: Address): Promise<TierDistribution> {
  const client = getSpareClient();
  const t0 = Date.now();
  let decimals = 18;
  try {
    decimals = Number(await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }));
  } catch {
    /* 18 */
  }
  const scan = await enumerateCandidateAddresses(token);
  const candidates = Array.from(scan.addresses);
  const balances = await client.multicall({
    contracts: candidates.map((addr) => ({ address: token, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [addr] })),
    allowFailure: true,
  });
  let totalSupplyRaw = 0n;
  try {
    totalSupplyRaw = (await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' })) as bigint;
  } catch {
    /* 0 */
  }
  const totalSupply = Number(formatUnits(totalSupplyRaw, decimals));
  const counts: Record<HolderTier, number> = { standard: 0, holder: 0, whale: 0, og: 0 };
  const supply: Record<HolderTier, number> = { standard: 0, holder: 0, whale: 0, og: 0 };
  let totalHolders = 0;
  let failedBalances = 0;
  candidates.forEach((_a, i) => {
    const r = balances[i];
    if (!r || r.status !== 'success') {
      failedBalances += 1;
      return;
    }
    const balance = Number(formatUnits(r.result as bigint, decimals));
    if (balance < DUST_FLOOR) return;
    totalHolders += 1;
    const tier = classifyTier(balance);
    counts[tier] += 1;
    supply[tier] += balance;
  });
  const supplyPct: Record<HolderTier, number> = { standard: 0, holder: 0, whale: 0, og: 0 };
  if (totalSupply > 0) {
    for (const t of ['standard', 'holder', 'whale', 'og'] as const) supplyPct[t] = (supply[t] / totalSupply) * 100;
  }
  const now = Date.now();
  return {
    token: getSpareTokenStatus(),
    counts,
    supplyPct,
    supply,
    totalSupply,
    totalHolders,
    lastUpdated: new Date(now).toISOString(),
    buildMs: now - t0,
    nextRefreshAt: new Date(now + SNAPSHOT_TTL_MS).toISOString(),
    cached: false,
    warming: false,
    complete: scan.failedChunks === 0 && failedBalances === 0,
  };
}

/** Latest snapshot; never blocks on enumeration. Empty while $SPARE is not launched. */
export async function getTierDistribution(): Promise<TierDistribution> {
  const token = spareTokenAddress();
  if (!token) return emptyTierDistribution();
  if (cachedFor !== token) {
    cached = null;
    cachedFor = token;
  }

  const now = Date.now();
  const ttlExpired = !cached || Date.parse(cached.lastUpdated) + SNAPSHOT_TTL_MS < now;
  if (ttlExpired && !warming && now - lastWarmAttempt > 30_000) {
    warming = true;
    lastWarmAttempt = now;
    const timeout = new Promise<TierDistribution>((_, reject) =>
      setTimeout(() => reject(new Error(`enumeration timed out after ${ENUMERATION_TIMEOUT_MS}ms`)), ENUMERATION_TIMEOUT_MS),
    );
    Promise.race([snapshotNow(token), timeout])
      .then((snap) => {
        cached = snap;
        console.log(`[holderSnapshot] $SPARE snapshot: ${snap.totalHolders} holders in ${snap.buildMs}ms${snap.complete ? '' : ' (incomplete: some reads failed)'}`);
      })
      .catch((err) => console.warn('[holderSnapshot] enumeration failed:', safeErrorMessage(err)))
      .finally(() => {
        warming = false;
      });
  }
  if (cached) return { ...cached, cached: true };
  return { ...emptyTierDistribution(), warming: true, complete: false };
}
