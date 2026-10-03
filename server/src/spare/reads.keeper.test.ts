/**
 * spare_quote / spare_account / spare_universe report what the keeper will do
 * with each leg (keeperRules.ts), read from a model chain: constant-product
 * pools priced against the oracle, ERC-8056 multiplier state per token, and a
 * count of every RPC request so the mirror stays inside the read budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { DEPLOYMENT_4663, parseBook } from './book.js';
import { poolIdOf, readAccount, readQuote, readUniverse } from './reads.js';
import { DYNAMIC_FEE_FLAG } from './keeperRules.js';
import { FIXTURE_TOKENS, installFixtureDirectory } from './testFixtures.js';
import { setAssetDirectory } from './assets.js';
import { answerAggregate3, isAggregate3, type Aggregate3Call } from './testRpc.js';

const book = parseBook(DEPLOYMENT_4663);
const USDG = book.external.USDG;
const { SPY, NVDA, AAPL } = FIXTURE_TOKENS;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const HOOK = '0x08e52564bad99e05a694b4809f397edca417a080' as Address; // GME's dynamic-fee hook on mainnet
const ACCOUNT = '0x000000000000000000000000000000000000a11c' as Address;
const E18 = 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const utc = (s: string) => BigInt(Date.parse(s) / 1000);

beforeEach(() => {
  installFixtureDirectory();
});
afterEach(() => setAssetDirectory(null));

// Wednesday 2026-09-30 12:00 UTC, inside the 24/5 session; feeds posted 10 minutes earlier.
const NOW = utc('2026-09-30T12:00:00Z');
const PRINT = utc('2026-09-30T11:50:00Z');

/** x*y=k with the LP fee kept in the pool (engine/test/keeper-batches.test.ts). */
class Pool {
  constructor(
    readonly x: bigint,
    readonly y: bigint,
    readonly feePips: bigint,
  ) {}
  quote(dx: bigint): bigint {
    const dxf = (dx * (1_000_000n - this.feePips)) / 1_000_000n;
    return (this.y * dxf) / (this.x + dxf);
  }
}
/** `usdgDepth` dollars of USDG, spot `offBps` under the oracle. */
const poolAt = (price: bigint, usdgDepth: number, feePips: bigint, offBps = 0n) =>
  new Pool(usd(usdgDepth), (((usd(usdgDepth) * 10n ** 30n) / price) * (10_000n - offBps)) / 10_000n, feePips);

interface Token {
  price: bigint;
  pool: Pool;
  /** StateView.getSlot0 protocolFee (lower 12 bits: USDG -> token). */
  protocolFee?: number;
  feedAt?: bigint;
  effectiveAt?: bigint;
  ui?: bigint;
  newUi?: bigint;
  active?: boolean;
  status?: number;
  /** A hooked pool whose PoolKey fee is DYNAMIC_FEE_FLAG; its LP fee (pool.feePips) is read from slot0. */
  dynamicFee?: boolean;
  slot0Reverts?: boolean;
}

/** Hookless pools, USDG as currency0, as on mainnet for these tokens. */
function market(over: Partial<Record<Address, Partial<Token>>> = {}): Record<string, Token> {
  const t: Record<string, Token> = {
    [SPY]: { price: 660n * E18, pool: poolAt(660n * E18, 5_000_000, 500n), protocolFee: 125 | (125 << 12) },
    [NVDA]: { price: 180n * E18, pool: poolAt(180n * E18, 442_000, 100n), protocolFee: 25 | (25 << 12) },
    [AAPL]: { price: 250n * E18, pool: poolAt(250n * E18, 2_000_000, 3_000n), protocolFee: 500 | (500 << 12) },
  };
  for (const [k, v] of Object.entries(over)) t[k] = { ...t[k]!, ...v };
  return t;
}

const feedOf = (token: Address) => `0x${token.slice(2, 36).toLowerCase()}f33d00` as Address;
/** The PoolKey: fee is the pool's LP fee, or v4's DYNAMIC_FEE_FLAG for a hooked dynamic-fee pool (slot0 then carries the LP fee). */
const keyOf = (token: Address, x: Token) => ({
  currency0: USDG,
  currency1: token,
  fee: x.dynamicFee ? DYNAMIC_FEE_FLAG : Number(x.pool.feePips),
  tickSpacing: 10,
  hooks: x.dynamicFee ? HOOK : ZERO,
});

/** A viem client over the model chain; `counts` tallies RPC requests by method. */
function chain(tokens: Record<string, Token>, acct: { value?: bigint; mix?: { asset: Address; bps: number }[] } = {}) {
  const counts = { getBlock: 0, readContract: 0, multicall: 0, simulateContract: 0, quotes: 0, multicallEntries: [] as number[] };
  const list = Object.keys(tokens) as Address[];
  const byFeed = new Map(list.map((t) => [feedOf(t).toLowerCase(), t]));
  const byPoolId = new Map(list.map((t) => [poolIdOf(keyOf(t, tokens[t]!)), t]));
  const tok = (a: string) => tokens[list.find((t) => t.toLowerCase() === a.toLowerCase()) ?? ''];
  const quote = (args: readonly unknown[]) => {
    counts.quotes++;
    const p = args[0] as { poolKey: { currency1: Address }; exactAmount: bigint };
    return [tok(p.poolKey.currency1)!.pool.quote(p.exactAmount), 100_000n];
  };
  const answer = (fn: string, address: string, args: readonly unknown[] = []): unknown => {
    const t = tok(address);
    switch (fn) {
      case 'tokens':
        return list;
      case 'get': {
        const a = args[0] as Address;
        const x = tok(a)!;
        return { token: a, feed: feedOf(a), feedDecimals: 8, heartbeat: 86_400, bandBps: 150, active: x.active ?? true, poolKey: keyOf(a, x) };
      }
      case 'oracleStatus': {
        const x = tok(args[0] as string)!;
        return [x.status ?? 0, x.price];
      }
      case 'latestRoundData': {
        const x = tokens[byFeed.get(address.toLowerCase())!];
        if (!x) throw new Error('no feed');
        const at = x.feedAt ?? PRINT;
        return [1n, x.price / 10n ** 10n, at, at, 1n];
      }
      case 'uiMultiplier':
        return t!.ui ?? E18;
      case 'newUIMultiplier':
        return t!.newUi ?? t!.ui ?? E18;
      case 'effectiveAt':
        return t!.effectiveAt ?? 0n;
      case 'getSlot0': {
        const x = tokens[byPoolId.get(args[0] as `0x${string}`)!]!;
        if (x.slot0Reverts) throw new Error('slot0 reverted');
        return [2n ** 96n, 0, x.protocolFee ?? 0, Number(x.pool.feePips)];
      }
      case 'quoteExactInputSingle':
        return quote(args);
      case 'symbol':
        return 'X';
      case 'name':
        return 'X Inc';
      case 'paused':
      case 'oraclePaused':
        return false;
      case 'feeBps':
        return 25;
      case 'threshold':
        return usd(5);
      case 'slippageBps':
        return 150;
      case 'epochLength':
        return 86_400n;
      case 'currentEpoch':
        return 20_361n;
      case 'isFresh':
        return true;
      case 'adapter':
        return book.contracts.UsdgParkAdapter;
      case 'defaultMix':
        return [{ asset: SPY, bps: 6000 }, { asset: NVDA, bps: 4000 }];
      case 'sequencerFeed':
        return ZERO;
      // spare_account
      case 'walletsOf':
        return [];
      case 'accountOf':
        return ZERO;
      case 'ruleOf':
        return { roundTo: 1, multiplier: 1, weeklyCap: usd(50), enabled: true };
      case 'activeSince':
      case 'pending':
      case 'units':
      case 'pulledLast7Days':
      case 'sweptEpoch':
      case 'claimable':
      case 'balanceOf':
      case 'clearedUntil':
        return 0n;
      case 'valueOf':
        return acct.value ?? usd(20);
      case 'remainingWeeklyCap':
        return usd(50);
      case 'mixOf':
        return acct.mix ?? [{ asset: SPY, bps: 6000 }, { asset: NVDA, bps: 4000 }];
      case 'hasOwnMix':
      case 'isEligible':
        return true;
      case 'enforced':
        return false;
      default:
        throw new Error(`unexpected read ${fn}`);
    }
  };
  const client = {
    getBlock: async () => {
      counts.getBlock++;
      return { number: 76_700_000n, timestamp: NOW };
    },
    readContract: async (p: { functionName: string; address: string; args?: readonly unknown[] }) => {
      // Multicall3.aggregate3 (multicall.ts): one eth_call answering a batch of reads.
      if (isAggregate3(p)) {
        const calls = p.args![0] as Aggregate3Call[];
        counts.multicall++;
        counts.multicallEntries.push(calls.length);
        return answerAggregate3((fn, address, args) => answer(fn, address, args), calls);
      }
      counts.readContract++;
      return answer(p.functionName, p.address, p.args);
    },
    simulateContract: async (p: { args: readonly unknown[] }) => {
      counts.simulateContract++;
      return { result: quote(p.args) };
    },
  } as unknown as PublicClient;
  return { client, counts };
}

describe('spare_quote: the keeper outcome for a leg of this size', () => {
  it('a clean pool buys, judged by B-L3 with the pool fee read from slot0; two eth_calls besides the block, as before', async () => {
    const { client, counts } = chain(market());
    const q = await readQuote('SPY', '5', client);
    expect(q).toMatchObject({ outcome: 'buy', keeperOutcome: 'buy', wouldBuy: true, wouldHold: false, reason: null });
    // 5 bps LP fee + 1.25 bps protocol fee (125 | 125 << 12).
    expect(q.keeperChecks.quoteVsOracle).toMatchObject({ ok: true, why: null, poolFeeBps: 6.25 });
    expect(q.keeperChecks.quoteVsOracle!.reference).toMatchObject({ swapInUsd: '1', maxBps: 66.25, ok: true });
    expect(q.keeperChecks.quoteVsOracle!.fullSize).toMatchObject({ swapInUsd: '4.9875', alone: false, maxBps: 96.25, ok: true });
    expect(q.keeperChecks.multiplierChange).toMatchObject({ effectiveAt: null, pending: false, leadSeconds: 900 });
    expect(counts).toMatchObject({ getBlock: 1, readContract: 0, multicall: 2, simulateContract: 1, quotes: 2 });
  });

  it('B-L3: a pool pushed 90 bps under the oracle is HELD (a "defer" to older readers), with the keeper reason', async () => {
    const off = market({ [NVDA]: { pool: poolAt(180n * E18, 442_000, 100n, 90n) } });
    const q = await readQuote('NVDA', '8', chain(off).client);
    expect(q).toMatchObject({ outcome: 'defer', wouldDefer: true, keeperOutcome: 'hold', wouldHold: true, wouldBuy: false });
    expect(q.sweep).toMatchObject({ outcome: 'defer', keeperOutcome: 'hold', wouldHold: true });
    expect(q.keeperChecks.quoteVsOracle!.why).toMatch(/^pool 9\d\.\d bps under the oracle at \$1 \(max 61\.3: pool fee \+ 60\)$/);
    expect(q.reason).toMatch(/^held this tick: pool 9\d\.\d bps under the oracle at \$1 .*epoch kept and is retried next tick/);
    expect(q.notes.join(' ')).toMatch(/HOLD: the keeper does not turn this quote into a limit/);
  });

  it('size: a $5k leg (~113 bps impact) is swept alone under the 120 bps cap; $12k is held even alone', async () => {
    const whale = await readQuote('NVDA', '5000', chain(market()).client);
    expect(whale).toMatchObject({ outcome: 'buy', keeperOutcome: 'buy' });
    expect(whale.keeperChecks.quoteVsOracle!.fullSize).toMatchObject({ alone: true, maxBps: 120, ok: true });
    expect(whale.keeperChecks.quoteVsOracle!.fullSize!.impactBps).toBeGreaterThan(100);
    const bigger = await readQuote('NVDA', '12000', chain(market()).client);
    expect(bigger).toMatchObject({ outcome: 'defer', keeperOutcome: 'hold' });
    expect(bigger.keeperChecks.quoteVsOracle!.why).toMatch(/^quote 2\d\d\.\d bps under the oracle \(max 120\.0, alone\)$/);
  });

  it('ERC-8056: a change in force the feed has not posted since -> wait; a post after it -> buy', async () => {
    const eff = utc('2026-09-30T11:55:00Z');
    const split = market({ [AAPL]: { effectiveAt: eff, ui: 1_007n * 10n ** 15n } });
    const q = await readQuote('AAPL', '5', chain(split).client);
    expect(q).toMatchObject({ outcome: 'wait', keeperOutcome: 'wait', wouldWait: true, marketOpen: true, oracleLabel: 'LIVE' });
    expect(q.reason).toBe(
      'multiplier change in force since 2026-09-30T11:55:00.000Z and not yet in the Chainlink feed (last post 2026-09-30T11:50:00.000Z): the keeper holds the account; value stays parked',
    );
    expect(q.keeperChecks.multiplierChange).toMatchObject({ effectiveAt: '2026-09-30T11:55:00.000Z', uiMultiplier: '1.007', pending: true });
    expect(q.notes.join(' ')).toMatch(/ERC-8056 multiplier change is pending/);
    const posted = market({ [AAPL]: { effectiveAt: eff, ui: 1_007n * 10n ** 15n, feedAt: utc('2026-09-30T11:58:00Z') } });
    expect((await readQuote('AAPL', '5', chain(posted).client)).outcome).toBe('buy');
  });

  it('ERC-8056: a change scheduled 10 min out -> wait; 20 min out -> buy', async () => {
    const soon = market({ [AAPL]: { effectiveAt: NOW + 600n, newUi: 2n * E18 } });
    const q = await readQuote('AAPL', '5', chain(soon).client);
    expect(q.keeperOutcome).toBe('wait');
    expect(q.reason).toBe('multiplier change scheduled for 2026-09-30T12:10:00.000Z (the keeper stops buying 15 min before it): the keeper holds the account; value stays parked');
    const later = market({ [AAPL]: { effectiveAt: NOW + 1_200n, newUi: 2n * E18 } });
    expect((await readQuote('AAPL', '5', chain(later).client)).keeperOutcome).toBe('buy');
  });
});

describe('spare_account: keeperWouldSweepNow and the per-leg outcome', () => {
  it('a clean account: every leg buys; one more multicall entry set, no more RPC requests than before', async () => {
    const { client, counts } = chain(market());
    const a = await readAccount(ACCOUNT, client);
    expect(a).toMatchObject({ readyToSweep: true, keeperWouldSweepNow: true, keeperSweepsAlone: false, waitingFor: [] });
    expect(a.mix.map((l) => [l.symbol, l.keeperState, l.keeperOutcome, l.reason])).toEqual([
      ['SPY', 'ok', 'buy', null],
      ['NVDA', 'ok', 'buy', null],
    ]);
    // $20 split 60/40, 25 bps fee off: the account's own legs.
    expect(a.mix.map((l) => l.quoteCheck!.fullSize!.swapInUsd)).toEqual(['11.97', '7.98']);
    // getBlock, AssetRegistry.tokens, and three multicalls (resolve, core, legs) — the same requests as before the mirror.
    expect(counts).toMatchObject({ getBlock: 1, readContract: 1, multicall: 3, simulateContract: 0, quotes: 4 });
    // The leg multicall: feed + 3 token reads + slot0 + $1 and leg quotes, per leg.
    expect(counts.multicallEntries.at(-1)).toBe(2 * 7);
  });

  it('B-L3: one held leg holds the account (epoch kept) and says why; the other leg still buys', async () => {
    const off = market({ [NVDA]: { pool: poolAt(180n * E18, 442_000, 100n, 90n) } });
    const a = await readAccount(ACCOUNT, chain(off).client);
    expect(a.readyToSweep).toBe(true);
    expect(a.keeperWouldSweepNow).toBe(false);
    const [spy, nvda] = a.mix;
    expect(spy).toMatchObject({ keeperState: 'ok', keeperOutcome: 'buy' });
    expect(nvda).toMatchObject({ keeperState: 'ok', keeperOutcome: 'hold' });
    expect(nvda).not.toHaveProperty('waitReason');
    expect(nvda!.reason).toMatch(/^held this tick: pool 9\d\.\d bps under the oracle at \$1/);
    expect(a.waitingFor).toEqual([expect.stringMatching(/^NVDA: held: pool 9\d\.\d bps under the oracle at \$1 \(max 61\.3: pool fee \+ 60\)$/)]);
  });

  it('ERC-8056: a pending multiplier change makes its leg wait, and so the whole account', async () => {
    const split = market({ [SPY]: { effectiveAt: utc('2026-09-30T11:55:00Z') } });
    const a = await readAccount(ACCOUNT, chain(split).client);
    expect(a.keeperWouldSweepNow).toBe(false);
    expect(a.mix[0]).toMatchObject({ symbol: 'SPY', keeperState: 'wait', keeperOutcome: 'wait', oracleLabel: 'LIVE' });
    expect(a.mix[0]!.waitReason).toMatch(/^multiplier change in force since 2026-09-30T11:55:00\.000Z and not yet in the Chainlink feed/);
    expect(a.mix[0]!.multiplierChange).toMatchObject({ pending: true });
    expect(a.waitingFor).toEqual([expect.stringMatching(/^SPY: multiplier change in force since/)]);
  });

  it('a whale account is swept alone and still sweeps; past the 120 bps cap it is held', async () => {
    const mix = [{ asset: NVDA, bps: 10_000 }];
    const whale = await readAccount(ACCOUNT, chain(market(), { value: usd(5_000), mix }).client);
    expect(whale).toMatchObject({ keeperWouldSweepNow: true, keeperSweepsAlone: true });
    const bigger = await readAccount(ACCOUNT, chain(market(), { value: usd(12_000), mix }).client);
    expect(bigger.keeperWouldSweepNow).toBe(false);
    expect(bigger.waitingFor).toEqual([expect.stringMatching(/^NVDA: held: quote 2\d\d\.\d bps under the oracle \(max 120\.0, alone\)$/)]);
  });

  it('below the threshold the pool is still judged at $1, and an inactive leg is never quoted', async () => {
    const off = market({ [NVDA]: { pool: poolAt(180n * E18, 442_000, 100n, 60n), active: false } });
    const { client, counts } = chain(off, { value: 0n });
    const a = await readAccount(ACCOUNT, client);
    expect(a).toMatchObject({ readyToSweep: false, keeperWouldSweepNow: false });
    expect(a.mix[0]!.quoteCheck).toMatchObject({ ok: true, fullSize: null });
    expect(a.mix[1]).toMatchObject({ keeperState: 'settle', keeperOutcome: 'safe_settle', quoteCheck: null });
    expect(counts.quotes).toBe(1); // SPY's $1 reference only
  });
});

describe('spare_universe: buyableNow mirrors the keeper per-asset gate', () => {
  it('a pending multiplier change is not buyable now; the multiplier state rides in the same multicall', async () => {
    const split = market({ [AAPL]: { effectiveAt: utc('2026-09-30T11:55:00Z') } });
    const { client, counts } = chain(split);
    const u = await readUniverse({}, client);
    const row = (t: Address) => u.assets.find((x) => x.token === t)!;
    expect(row(SPY)).toMatchObject({ buyableNow: true, keeperState: 'ok', waitReason: null, oracleLabel: 'LIVE' });
    expect(row(AAPL)).toMatchObject({ buyableNow: false, keeperState: 'wait', oracleLabel: 'LIVE', marketOpen: true });
    expect(row(AAPL).waitReason).toMatch(/^multiplier change in force since 2026-09-30T11:55:00\.000Z/);
    expect(row(AAPL).multiplierChange).toMatchObject({ pending: true, effectiveAt: '2026-09-30T11:55:00.000Z' });
    expect(counts.multicall).toBe(2);
  });
});

describe('pool fees: a dynamic-fee pool is "dynamic", never its 0x800000 flag read as a rate', () => {
  // GME on mainnet: hooked pool, PoolKey fee 8388608 (DYNAMIC_FEE_FLAG), slot0 lpFee 0 (2026-10-02).
  const gme = (lpFeePips: bigint) => market({ [AAPL]: { pool: poolAt(250n * E18, 2_000_000, lpFeePips), dynamicFee: true, protocolFee: 0 } });

  it('spare_universe: feePct "dynamic" and the LP fee from slot0, in the same second-round multicall', async () => {
    const { client, counts } = chain(gme(0n));
    const u = await readUniverse({}, client);
    const row = (t: Address) => u.assets.find((x) => x.token === t)!;
    expect(row(AAPL).pool).toMatchObject({ fee: 8_388_608, feePct: 'dynamic', dynamicFee: true, lpFee: 0, lpFeePct: '0%', hooked: true });
    expect(row(SPY).pool).toMatchObject({ fee: 500, feePct: '0.05%', dynamicFee: false, lpFee: 500, lpFeePct: '0.05%', hooked: false });
    expect(JSON.stringify(u)).not.toMatch(/838\.8608%/);
    // fee stays the PoolKey field: poolId hashes it.
    expect(row(AAPL).pool!.poolId).toBe(poolIdOf({ ...row(AAPL).pool!, fee: DYNAMIC_FEE_FLAG }));
    expect(counts.multicall).toBe(2);
    // One slot0 read: only the dynamic-fee pool's.
    expect(counts.multicallEntries[1]).toBe(3 + 1);
  });

  it('spare_universe: a dynamic pool whose slot0 does not read says lpFee null, never a guess', async () => {
    const t = market({ [AAPL]: { pool: poolAt(250n * E18, 2_000_000, 3_000n), dynamicFee: true, slot0Reverts: true } });
    const u = await readUniverse({}, chain(t).client);
    expect(u.assets.find((x) => x.token === AAPL)!.pool).toMatchObject({ fee: 8_388_608, feePct: 'dynamic', dynamicFee: true, lpFee: null, lpFeePct: null });
  });

  it('spare_quote: the same pool fields, and B-L3 judges the dynamic pool by its slot0 LP fee', async () => {
    const q = await readQuote('AAPL', '5', chain(gme(3_000n)).client);
    expect(q.pool).toMatchObject({ fee: 8_388_608, feePct: 'dynamic', dynamicFee: true, lpFee: 3_000, lpFeePct: '0.3%', zeroForOne: true });
    expect(q.keeperChecks.quoteVsOracle).toMatchObject({ ok: true, poolFeeBps: 30 });
    expect(q.keeperOutcome).toBe('buy');
  });
});
