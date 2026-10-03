import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { cashParkAbi, ruleRegistryAbi, sweepExecutorAbi } from './abis';
import { SPARE, START_BLOCK } from './addresses';
import { FIXTURE_TOKENS as ASSET_TOKENS, primeFixtureNames } from '@/test/assetFixtures';
import { MAX_LOG_RANGE, NARROW_LOG_RANGE } from './activity';
import {
  ago,
  countLinkedWallets,
  feedRowText,
  keeperStatus,
  latestFeedEvent,
  linkedFromEvents,
  scanFeed,
  summarizeFeed,
  type FeedEvent,
} from './protocol-feed';

// Feed rows name tokens the way the app does after its registry read.
beforeAll(primeFixtureNames);

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}` as Hex;

function ev(kind: string, args: Record<string, unknown>, blockNumber = 100n, logIndex = 0, source: FeedEvent['source'] = 'SweepExecutor'): FeedEvent {
  return { id: `${TX}:${blockNumber}:${logIndex}`, kind, source, blockNumber, logIndex, txHash: TX, args };
}

function rpcLog(address: string, topics: Hex[], data: Hex, block: bigint, logIndex = 0) {
  return { address, topics, data, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${logIndex.toString(16)}`, transactionHash: TX, removed: false };
}

describe('feedRowText', () => {
  it('reads each kind in plain English with no addresses', () => {
    expect(feedRowText(ev('Accrued', { account: ACCOUNT, wallet: WALLET, amount: 1_250_000n }))).toBe('Round-up collected · $1.25');
    expect(
      feedRowText(ev('AssetSwept', { asset: ASSET_TOKENS.SPY, usdgIn: 5_000_000n, fee: 12_500n, tokensOut: 7_500_000_000_000_000n })),
    ).toBe('Bought 0.0075 SPY for $5.00 · fee $0.01');
    expect(feedRowText(ev('AccountSwept', { account: ACCOUNT, epoch: 20_361n, usdg: 5_000_000n }))).toBe('Account swept · $5.00 · epoch 20361');
    expect(feedRowText(ev('Deferred', { account: ACCOUNT, asset: ASSET_TOKENS.NVDA, usdg: 2_000_000n, status: 1 }))).toBe(
      'NVDA leg deferred · $2.00 · market closed',
    );
    expect(feedRowText(ev('SwapDeferred', { asset: ASSET_TOKENS.AAPL, usdg: 3_000_000n, reason: '0x' }))).toBe('AAPL swap deferred · $3.00');
    expect(feedRowText(ev('SafeSettled', { account: ACCOUNT, asset: ASSET_TOKENS.TSLA, usdg: 1_000_000n, reason: 'deactivated' }))).toBe(
      'TSLA leg returned as USDG · $1.00 · deactivated',
    );
    expect(feedRowText(ev('DeliveryHeld', { account: ACCOUNT, token: ASSET_TOKENS.SPY, amount: 10n ** 18n }))).toBe(
      'Delivery held for claim · 1 SPY',
    );
    expect(feedRowText(ev('Exited', { account: ACCOUNT, usdgOut: 4_200_000n, unitsInKind: 0n }, 1n, 0, 'CashPark'))).toBe(
      'Spare change withdrawn · $4.20',
    );
    for (const k of ['Accrued', 'Deferred', 'SafeSettled', 'DeliveryHeld']) {
      const text = feedRowText(ev(k, { account: ACCOUNT, wallet: WALLET, asset: ASSET_TOKENS.SPY, token: ASSET_TOKENS.SPY, amount: 1n, usdg: 1n, status: 0 }));
      expect(text.toLowerCase()).not.toContain(ACCOUNT.slice(2, 8));
      expect(text.toLowerCase()).not.toContain(WALLET.slice(2, 8));
    }
  });
});

describe('summarizeFeed', () => {
  it('sums collections, conversions and fees and finds the newest keeper event', () => {
    const s = summarizeFeed([
      ev('Accrued', { amount: 1_000_000n }, 10n),
      ev('Accrued', { amount: 250_000n }, 12n),
      ev('AssetSwept', { usdgIn: 5_000_000n, fee: 12_500n, tokensOut: 1n }, 20n, 1),
      ev('AccountSwept', { usdg: 5_000_000n, epoch: 1n }, 20n, 2),
      ev('Exited', { usdgOut: 1n }, 30n, 0, 'CashPark'),
    ]);
    expect(s.accruedCount).toBe(2);
    expect(s.accruedUsdg).toBe(1_250_000n);
    expect(s.convertedUsdg).toBe(5_000_000n);
    expect(s.feesUsdg).toBe(12_500n);
    expect(s.lastKeeper?.kind).toBe('AccountSwept'); // Exited is a user action, not the keeper's
    expect(s.lastCollectOrSweep?.kind).toBe('AccountSwept');
  });

  it('is all zeros for an empty feed', () => {
    const s = summarizeFeed([]);
    expect(s).toMatchObject({ accruedCount: 0, accruedUsdg: 0n, convertedUsdg: 0n, feesUsdg: 0n, lastKeeper: null });
  });
});

describe('keeperStatus', () => {
  it('is Running within 24 h of a collection or sweep, else standing by with the wallet count', () => {
    expect(keeperStatus({ lastCollectOrSweepAt: 1_000, nowSec: 1_000 + 3_600, linkedWallets: 1 })).toEqual({ running: true, label: 'Running' });
    expect(keeperStatus({ lastCollectOrSweepAt: 1_000, nowSec: 1_000 + 90_000, linkedWallets: 1 }).label).toBe(
      'Standing by — watching 1 linked wallet',
    );
    expect(keeperStatus({ lastCollectOrSweepAt: null, nowSec: 5, linkedWallets: 3 }).label).toBe('Standing by — watching 3 linked wallets');
    expect(keeperStatus({ lastCollectOrSweepAt: null, nowSec: 5, linkedWallets: null }).label).toBe('Standing by — watching — linked wallets');
  });
});

describe('ago / linkedFromEvents', () => {
  it('formats ages and counts linked wallets', () => {
    expect(ago(100, 130)).toBe('30s ago');
    expect(ago(0, 7_200)).toBe('2h ago');
    expect(ago(null, 1)).toBe('—');
    expect(linkedFromEvents([{ kind: 'Linked' }, { kind: 'Linked' }, { kind: 'Unlinked' }])).toBe(1);
    expect(linkedFromEvents([{ kind: 'Unlinked' }])).toBe(0);
  });
});

describe('scanFeed', () => {
  it('reads in ≤ 50,000-block chunks from the deploy block, newest first, and decodes feed events only', async () => {
    const accruedTopics = encodeEventTopics({ abi: sweepExecutorAbi, eventName: 'Accrued', args: { account: ACCOUNT, wallet: WALLET } }) as Hex[];
    const accruedData = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [1_500_000n, START_BLOCK, START_BLOCK + 10n],
    );
    const exitedTopics = encodeEventTopics({ abi: cashParkAbi, eventName: 'Exited', args: { account: ACCOUNT } }) as Hex[];
    const exitedData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [2_000_000n, 0n]);
    const ranges: [bigint, bigint][] = [];
    const request = vi.fn(async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex; address: string[] }] }) => {
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      ranges.push([from, to]);
      expect(params[0].address).toEqual([SPARE.SweepExecutor, SPARE.CashPark]);
      const out = [];
      const a = START_BLOCK + 60_000n;
      const b = START_BLOCK + 70_000n;
      if (a >= from && a <= to) out.push(rpcLog(SPARE.SweepExecutor, accruedTopics, accruedData, a));
      if (b >= from && b <= to) out.push(rpcLog(SPARE.CashPark, exitedTopics, exitedData, b));
      return out;
    });
    const to = START_BLOCK + 123_456n;
    const events = await scanFeed({ request } as never, START_BLOCK - 5_000n, to);
    for (const [f, t] of ranges) {
      expect(t - f + 1n).toBeLessThanOrEqual(MAX_LOG_RANGE);
      expect(f >= START_BLOCK).toBe(true);
    }
    const covered = ranges.reduce((n, [f, t]) => n + (t - f + 1n), 0n);
    expect(covered).toBe(to - START_BLOCK + 1n);
    expect(events.map((e) => e.kind)).toEqual(['Exited', 'Accrued']);
    expect(events[1].args.amount).toBe(1_500_000n);
  });

  it('never scans before the deploy block', async () => {
    const request = vi.fn(async () => []);
    expect(await scanFeed({ request } as never, 0n, START_BLOCK - 1n)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('narrow lookups', () => {
  it('latestFeedEvent walks back from the head and stops at the first hit', async () => {
    const topics = encodeEventTopics({ abi: sweepExecutorAbi, eventName: 'Accrued', args: { account: ACCOUNT, wallet: WALLET } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [7n, 1n, 2n]);
    const hitBlock = START_BLOCK + 10n;
    const request = vi.fn(async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      expect(to - from + 1n).toBeLessThanOrEqual(NARROW_LOG_RANGE);
      return hitBlock >= from && hitBlock <= to ? [rpcLog(SPARE.SweepExecutor, topics, data, hitBlock)] : [];
    });
    const head = START_BLOCK + 2_500_000n;
    const e = await latestFeedEvent({ request } as never, 'SweepExecutor', ['Accrued'], head);
    expect(e?.blockNumber).toBe(hitBlock);
    // newest chunk first, so the earliest-chunk hit is found last
    expect(request.mock.calls.length).toBeGreaterThan(1);
  });

  it('countLinkedWallets is Linked − Unlinked', async () => {
    const linked = encodeEventTopics({ abi: ruleRegistryAbi, eventName: 'Linked', args: { account: ACCOUNT, wallet: WALLET } }) as Hex[];
    const unlinked = encodeEventTopics({ abi: ruleRegistryAbi, eventName: 'Unlinked', args: { account: ACCOUNT, wallet: WALLET } }) as Hex[];
    const request = vi.fn(async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
      const from = BigInt(params[0].fromBlock);
      return from === START_BLOCK
        ? [
            rpcLog(SPARE.RuleRegistry, linked, '0x', START_BLOCK + 1n, 0),
            rpcLog(SPARE.RuleRegistry, linked, '0x', START_BLOCK + 2n, 0),
            rpcLog(SPARE.RuleRegistry, unlinked, '0x', START_BLOCK + 3n, 0),
          ]
        : [];
    });
    expect(await countLinkedWallets({ request } as never, START_BLOCK + 10n)).toBe(1);
  });
});
