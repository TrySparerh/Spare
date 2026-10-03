/**
 * Offline tests for the Spare reads: the market-hours gate in spare_quote /
 * spare_universe (keeper parity), and the flat §2.3 fields.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  HttpRequestError,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { sweepExecutorAbi, v4QuoterAbi } from './abis.js';
import { DEPLOYMENT_4663, parseBook, VENUE } from './book.js';
import { answerAggregate3, isAggregate3, type Aggregate3Call } from './testRpc.js';
import {
  activityFields,
  decodeReasonBytes,
  FEE_LEDGER_CONFIRMATIONS,
  oracleLabelFor,
  readContracts,
  readFees,
  readQuote,
  readUniverse,
  resetFeeLedger,
} from './reads.js';
import type { ActivityItem } from './logs.js';
import { FIXTURE_TOKENS, installFixtureDirectory } from './testFixtures.js';
import { setAssetDirectory } from './assets.js';

const book = parseBook(DEPLOYMENT_4663);
const SPY = FIXTURE_TOKENS.SPY;

// Tokens are named from a registry read: start every test from the fixture one.
beforeEach(() => {
  installFixtureDirectory();
});
afterEach(() => setAssetDirectory(null));
const USDG = book.external.USDG;
const utc = (s: string) => BigInt(Date.parse(s) / 1000);

// Saturday 2026-10-03 10:00 EDT; the SPY feed last posted Friday 15:00 EDT (19 h earlier,
// inside heartbeat + 1 h, so OracleGuard still says OK).
const SATURDAY = utc('2026-10-03T14:00:00Z');
const FRIDAY_PRINT = utc('2026-10-02T19:00:00Z');
// Wednesday 2026-09-30 12:00 UTC with a print 10 minutes earlier.
const WEDNESDAY = utc('2026-09-30T12:00:00Z');
const WED_PRINT = utc('2026-09-30T11:50:00Z');

const PRICE_1E18 = 600n * 10n ** 18n; // $600 per token
const poolKey = { currency0: USDG, currency1: SPY, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' };
const registryAsset = (active = true) => ({ token: SPY, feed: '0x319724394D3A0e3669269846abE664Cd621f9f6A', feedDecimals: 8, heartbeat: 86_400, bandBps: 150, active, poolKey });

/** What viem's simulateContract throws when the V4Quoter reverts (e.g. a pool that cannot fill). */
function quoterRevert(): Error {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: '0x6190b2b0' }),
    { abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [], contractAddress: VENUE.v4Quoter },
  );
}

/** A fake viem client answering by function name. */
function fakeClient(opts: { ts: bigint; feedUpdatedAt: bigint; oracleStatus?: number; active?: boolean; quoteOut?: bigint | null }): PublicClient {
  const status = opts.oracleStatus ?? 0;
  const answer = (fn: string, args?: readonly unknown[]): unknown => {
    switch (fn) {
      case 'get':
        return registryAsset(opts.active ?? true);
      case 'oracleStatus':
        return [status, PRICE_1E18];
      case 'feeBps':
        return 25;
      case 'uiMultiplier':
      case 'newUIMultiplier':
        return 10n ** 18n;
      case 'effectiveAt':
        return 0n; // no ERC-8056 change ever scheduled
      case 'getSlot0':
        return [2n ** 96n, 0, 512_125, 500]; // mainnet SPY pool: 125 | 125 << 12 protocol fee, 500 LP fee
      case 'latestRoundData':
        return [1n, 60_000_000_000n, opts.feedUpdatedAt, opts.feedUpdatedAt, 1n];
      case 'tokens':
        return [SPY];
      case 'symbol':
        return 'SPY';
      case 'name':
        return 'SPDR S&P 500';
      case 'paused':
      case 'oraclePaused':
        return false;
      case 'threshold':
        return 5_000_000n;
      case 'slippageBps':
        return 150;
      case 'epochLength':
        return 86_400n;
      case 'currentEpoch':
        return 1n;
      case 'isFresh':
        return true;
      case 'adapter':
        return book.contracts.UsdgParkAdapter;
      case 'defaultMix':
        return [{ asset: SPY, bps: 10_000 }];
      case 'sequencerFeed':
        return '0x0000000000000000000000000000000000000000';
      case 'quoteExactInputSingle': {
        if (opts.quoteOut === null) throw new Error('quote reverted');
        const out = opts.quoteOut ?? 8_300_000_000_000_000n;
        // The keeper's $1 reference: the same rate as the $5 sweep's 4.9875 USDG swap.
        const exact = (args?.[0] as { exactAmount?: bigint } | undefined)?.exactAmount;
        return [exact === 1_000_000n ? (out * 1_000_000n) / 4_987_500n : out, 90_000n];
      }
      default:
        throw new Error(`unexpected read ${fn}`);
    }
  };
  return {
    getBlock: async () => ({ number: 76_700_000n, timestamp: opts.ts }),
    readContract: async (p: { functionName: string; args?: readonly unknown[] }) =>
      // Multicall3.aggregate3 (multicall.ts), answered through the real ABI encoding.
      isAggregate3(p) ? answerAggregate3((fn, _address, args) => answer(fn, args), p.args![0] as Aggregate3Call[]) : answer(p.functionName),
    simulateContract: async () => {
      if (opts.quoteOut === null) throw quoterRevert();
      return { result: [opts.quoteOut ?? 8_300_000_000_000_000n, 90_000n] };
    },
  } as unknown as PublicClient;
}

describe('spare_quote market-hours gate (keeper parity)', () => {
  afterEach(() => {
    delete process.env.SPARE_MARKET_HOURS_GATE;
  });

  it('Saturday with a Friday print: OracleGuard says OK but the keeper waits, so outcome is wait', async () => {
    const q = await readQuote('SPY', '5', fakeClient({ ts: SATURDAY, feedUpdatedAt: FRIDAY_PRINT }));
    expect(q.oracleStatus).toBe(0);
    expect(q.oracle.status).toBe('OK');
    expect(q.marketOpen).toBe(false);
    expect(q.oracleLabel).toBe('market closed');
    expect(q.outcome).toBe('wait');
    expect(q.wouldBuy).toBe(false);
    expect(q.wouldDefer).toBe(false);
    expect(q.reason).toMatch(/^market closed \(keeper market-hours gate\)/);
    expect(q.sweep.outcome).toBe('wait');
    expect(q.notes.join(' ')).toMatch(/all-or-nothing per account/);
  });

  it('inside the session with a fresh print it would buy', async () => {
    const q = await readQuote('SPY', '5', fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }));
    expect(q.marketOpen).toBe(true);
    expect(q.oracleLabel).toBe('LIVE');
    expect(q.outcome).toBe('buy');
    expect(q.wouldBuy).toBe(true);
    // Flat §2.3 fields.
    expect(q.usdgIn).toBe('5');
    expect(q.feeUsd).toBe('0.0125');
    expect(q.expectedOut).toBe('0.0083');
    expect(q.oraclePrice).toBe('600');
    expect(q.minOutAtKeeperTolerance).toBe('0.0082585');
    expect(typeof q.edgeVsOracleBps).toBe('number');
    expect(q.fillPrice).not.toBeNull();
  });

  it('oracle not OK -> wait; no quote -> defer; inactive -> safe_settle', async () => {
    expect((await readQuote('SPY', '5', fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT, oracleStatus: 1 }))).outcome).toBe('wait');
    expect((await readQuote('SPY', '5', fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT, quoteOut: null }))).outcome).toBe('defer');
    expect((await readQuote('SPY', '5', fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT, active: false }))).outcome).toBe('safe_settle');
  });

  it('SPARE_MARKET_HOURS_GATE=0 mirrors a keeper running with the gate off', async () => {
    process.env.SPARE_MARKET_HOURS_GATE = '0';
    const q = await readQuote('SPY', '5', fakeClient({ ts: SATURDAY, feedUpdatedAt: FRIDAY_PRINT }));
    expect(q.outcome).toBe('buy');
  });
});

describe('spare_universe', () => {
  it('flat §2.3 row fields; LIVE only inside the market-hours gate', async () => {
    const sat = await readUniverse({}, fakeClient({ ts: SATURDAY, feedUpdatedAt: FRIDAY_PRINT }));
    const row = sat.assets[0]!;
    expect(row).toMatchObject({
      symbol: 'SPY',
      active: true,
      oracleStatus: 0,
      oracleLabel: 'market closed',
      price: '600',
      marketOpen: false,
      sessionOpenedAt: null,
      buyableNow: false,
      heartbeatSec: 86_400,
      bandBps: 150,
      lastAnswer: '600',
    });
    expect(row.oracle.status).toBe('OK');
    expect(row.oracle.onChainLabel).toBe('LIVE');
    expect(sat.market.sessionOpen).toBe(false);

    const wed = await readUniverse({}, fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }));
    expect(wed.assets[0]).toMatchObject({ oracleLabel: 'LIVE', marketOpen: true, buyableNow: true, sessionOpenedAt: '2026-09-28T00:00:00.000Z' });
  });
});

describe('spare_universe standby reasons (measured, never a stored note)', () => {
  it('a standby asset says what $100 through its pinned pool does vs Chainlink', async () => {
    // $600 oracle: $100 buys 0.1667 tokens at the oracle; the pool gives 0.16 (4% fewer).
    const u = await readUniverse({}, fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT, active: false, quoteOut: 160_000_000_000_000_000n }));
    const row = u.assets[0]!;
    expect(row.active).toBe(false);
    expect(row.inactiveReason).toMatch(/4\.00% fewer tokens than Chainlink's price, outside the 1\.5% oracle band/);
  });

  it('a standby asset whose pool cannot quote says so; an active one has no reason', async () => {
    const off = await readUniverse({}, fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT, active: false, quoteOut: null }));
    expect(off.assets[0]!.inactiveReason).toMatch(/returns no quote/);
    const on = await readUniverse({}, fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }));
    expect(on.assets[0]!.inactiveReason).toBeNull();
    expect(on.assets[0]!.kind).toBe('etf'); // "SPDR S&P 500" is a fund by its name
  });

  it('an unknown ticker lists what the registry holds', async () => {
    await expect(readQuote('DOGE', '5', fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }))).rejects.toThrow(/registered ticker \(SPY, NVDA, AAPL, TSLA; see spare_universe\)/);
  });
});

describe('read errors embedded in a 200 response are redacted', () => {
  const KEYED = 'https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef';
  const failing = () => new Error(`request to ${KEYED}?x=1 failed\nDetails: {"error":"Must be authenticated!"}`);

  it('spare_quote: a quoter REVERT is "no quote" (held), and the 200 names no URL or key', async () => {
    const q = await readQuote('SPY', '5', fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT, quoteOut: null }));
    expect(q).toMatchObject({ outcome: 'defer', keeperOutcome: 'hold', reason: expect.stringMatching(/^held this tick: no quote\./) });
    expect(q.quote).toEqual({ ok: false, error: 'The contract function "quoteExactInputSingle" reverted with the following signature:' });
    expect(JSON.stringify(q)).not.toMatch(/https?:\/\/|viem\.sh/);
  });

  it('spare_quote: a quoter RPC failure fails the read (502 upstream), never "no quote"', async () => {
    for (const thrown of [failing(), new HttpRequestError({ url: KEYED, status: 429, details: 'Too Many Requests' })]) {
      const client = {
        ...fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }),
        simulateContract: async () => {
          throw thrown;
        },
      } as unknown as PublicClient;
      await expect(readQuote('SPY', '5', client)).rejects.toBe(thrown);
    }
  });

  it('spare_quote: an RPC failure on the feed / slot0 / $1-reference multicall fails the read, never "feed unreadable"', async () => {
    const base = fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT });
    const thrown = new HttpRequestError({ url: KEYED, status: 429, details: 'Too Many Requests' });
    let batches = 0;
    const client = {
      ...base,
      readContract: async (p: { functionName: string }) => {
        if (isAggregate3(p) && ++batches === 2) throw thrown; // the registry batch reads; the side batch fails
        return base.readContract(p as never);
      },
    } as unknown as PublicClient;
    await expect(readQuote('SPY', '5', client)).rejects.toBe(thrown);
    expect(batches).toBe(2);
  });

  it('spare_contracts: a failed getCode fails the read, never "not deployed"', async () => {
    const thrown = new HttpRequestError({ url: KEYED, status: 429, details: 'Too Many Requests' });
    const base = fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT });
    const ok = await readContracts({ ...base, getCode: async () => '0x6080' } as unknown as PublicClient);
    expect(ok.allDeployed).toBe(true);
    let n = 0;
    const flaky = {
      ...base,
      getCode: async () => {
        if (++n === 3) throw thrown;
        return '0x6080';
      },
    } as unknown as PublicClient;
    await expect(readContracts(flaky)).rejects.toBe(thrown);
  });

  it('spare_fees: a failed ledger scan names no URL or key', async () => {
    const client = {
      ...fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }),
      getBalance: async () => 0n,
      request: async () => {
        throw failing();
      },
    } as unknown as PublicClient;
    const f = await readFees(client);
    expect(f.allTime).toEqual({ error: 'request to [url] failed', complete: false });
    expect(JSON.stringify(f)).not.toMatch(/fAkE-kEy|alchemy\.com\/v2|Must be authenticated/);
  });
});

describe('labels and flat activity fields', () => {
  it('oracleLabelFor', () => {
    expect(oracleLabelFor(0, { open: true })).toBe('LIVE');
    expect(oracleLabelFor(0, { open: false })).toBe('market closed');
    expect(oracleLabelFor(2, { open: true })).toBe('corporate action');
    expect(oracleLabelFor(0, null)).toBe('LIVE');
  });

  const item = (kind: ActivityItem['kind'], args: Record<string, unknown>): ActivityItem => ({
    kind,
    contract: 'SweepExecutor',
    blockNumber: '76300000',
    txHash: '0xabc',
    logIndex: 0,
    args,
  });

  it('activityFields flattens the §2.3 fields per kind', () => {
    expect(activityFields(item('asset_swept', { asset: SPY, usdgIn: '5000000', fee: '12500', tokensOut: '8300000000000000' }), book)).toEqual({
      asset: 'SPY',
      usdg: '5',
      tokens: '0.0083',
      fee: '0.0125',
    });
    expect(activityFields(item('swept', { account: '0x1', epoch: '20361', usdg: '6000000' }), book)).toEqual({ usdg: '6', epoch: '20361' });
    expect(activityFields(item('deferred', { asset: SPY, usdg: '1000000', status: 1 }), book)).toEqual({
      asset: 'SPY',
      usdg: '1',
      status: 1,
      reason: 'oracle STALE',
    });
    expect(activityFields(item('delivered', { token: SPY, amount: '10' }), book)).toEqual({ asset: 'SPY', tokens: '0.00000000000000001' });
    expect(activityFields(item('claimed', { token: USDG, amount: '2500000' }), book)).toEqual({ asset: 'USDG', usdg: '2.5' });
    expect(activityFields(item('linked', {}), book)).toEqual({});
  });

  it('decodeReasonBytes decodes Error(string) and leaves unknown data short', () => {
    const data = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['pool drained'] });
    expect(decodeReasonBytes(data)).toBe('pool drained');
    expect(decodeReasonBytes('0xdeadbeef00')).toBe('0xdeadbeef');
    expect(decodeReasonBytes('0x')).toBe('');
  });
});

describe('spare_fees: the all-time ledger only takes confirmed blocks', () => {
  afterEach(() => resetFeeLedger());

  it(`scans to head - ${FEE_LEDGER_CONFIRMATIONS} and counts a sweep once it is that deep, once`, async () => {
    resetFeeLedger();
    const swept = 76_699_000n; // 1,000 blocks under the first head
    const topics = (encodeEventTopics as unknown as (p: object) => Hex[])({ abi: sweepExecutorAbi, eventName: 'AssetSwept', args: { asset: SPY } });
    const data = encodeAbiParameters(parseAbiParameters('uint256 usdgIn, uint256 fee, uint256 tokensOut'), [5_000_000n, 12_500n, 8_300_000_000_000_000n]);
    const log = { address: book.contracts.SweepExecutor, topics, data, transactionHash: `0x${'44'.repeat(32)}`, blockNumber: toHex(swept), removed: false };
    let headNow = 76_700_000n;
    const ranges: Array<[bigint, bigint]> = [];
    const client = {
      ...fakeClient({ ts: WEDNESDAY, feedUpdatedAt: WED_PRINT }),
      getBlock: async () => ({ number: headNow, timestamp: WEDNESDAY }),
      getBalance: async () => 0n,
      request: async ({ method, params }: { method: string; params: Array<{ fromBlock: Hex; toBlock: Hex }> }) => {
        if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
        const [from, to] = [BigInt(params[0]!.fromBlock), BigInt(params[0]!.toBlock)];
        ranges.push([from, to]);
        return swept >= from && swept <= to ? [log] : [];
      },
    } as unknown as PublicClient;

    const first = await readFees(client);
    expect(ranges.every(([, to]) => to <= headNow - FEE_LEDGER_CONFIRMATIONS)).toBe(true);
    expect(first.allTime).toMatchObject({ scannedToBlock: (headNow - FEE_LEDGER_CONFIRMATIONS).toString(), confirmations: 3000, complete: true });
    expect(first.conversionFeesAllTimeUsd).toBe('0'); // the sweep is not final yet

    headNow += 5_000n;
    const second = await readFees(client);
    expect(second.allTime).toMatchObject({ scannedToBlock: (headNow - FEE_LEDGER_CONFIRMATIONS).toString(), complete: true });
    expect(second.conversionFeesAllTimeUsd).toBe('0.0125');
    expect(second.convertedAllTimeUsd).toBe('5');
    expect(ranges.filter(([from, to]) => swept >= from && swept <= to)).toHaveLength(1);
  });
});
