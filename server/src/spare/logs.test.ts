import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, type Hex, type Log } from 'viem';
import { cashParkAbi, electionRegistryAbi, ruleRegistryAbi, sweepExecutorAbi } from './abis.js';
import { DEPLOYMENT_4663, parseBook } from './book.js';
import { ACCOUNT_TOPICS, activityWindow, chunkRange, decodeActivity, GLOBAL_TOPICS, MAX_ACTIVITY_DAYS, pageNewestFirst, type ActivityItem } from './logs.js';
import { summarise } from './reads.js';
import { FIXTURE_TOKENS, installFixtureDirectory } from './testFixtures.js';

// Tokens are named from a registry read; install the fixture one.
installFixtureDirectory();

const book = parseBook(DEPLOYMENT_4663);
const ACCOUNT = '0x7e57000000000000000000000000000000000001' as const;
const OTHER = '0x1111111111111111111111111111111111111111' as const;
const SPY = FIXTURE_TOKENS.SPY;
const USDG = book.external.USDG;

describe('chunkRange', () => {
  it('never exceeds 50,000 blocks per call and covers the range with no gaps or overlaps', () => {
    const from = 76_221_269n;
    const to = from + 6_047_999n; // 7 days of ~0.1 s blocks
    const chunks = chunkRange(from, to);
    expect(chunks.length).toBe(121);
    expect(chunks[0]!.from).toBe(from);
    expect(chunks.at(-1)!.to).toBe(to);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      expect(c.to - c.from + 1n <= 50_000n).toBe(true);
      if (i > 0) expect(c.from).toBe(chunks[i - 1]!.to + 1n);
    }
  });
  it('handles single blocks, exact multiples and empty ranges', () => {
    expect(chunkRange(10n, 10n)).toEqual([{ from: 10n, to: 10n }]);
    expect(chunkRange(0n, 99_999n)).toEqual([
      { from: 0n, to: 49_999n },
      { from: 50_000n, to: 99_999n },
    ]);
    expect(chunkRange(5n, 4n)).toEqual([]);
    expect(chunkRange(0n, 10n, 3n).length).toBe(4);
  });
  it('refuses chunk sizes above the 50k cap', () => {
    expect(() => chunkRange(0n, 10n, 50_001n)).toThrow(/<=/);
    expect(() => chunkRange(0n, 10n, 0n)).toThrow(/positive/);
  });
});

describe('activityWindow', () => {
  const deploy = 76_221_269n;
  it('spans days * blocksPerDay ending at head', () => {
    const head = 90_000_000n;
    const w = activityWindow(head, 7, deploy);
    expect(w.to).toBe(head);
    expect(w.to - w.from + 1n).toBe(7n * 864_000n);
    expect(w.clampedToDeploy).toBe(false);
    expect(chunkRange(w.from, w.to).length).toBe(121);
  });
  it('never starts before the deploy block', () => {
    const w = activityWindow(76_709_023n, 7, deploy);
    expect(w.from).toBe(deploy);
    expect(w.clampedToDeploy).toBe(true);
    expect(chunkRange(w.from, w.to).length).toBe(10);
  });
  it('validates days (integer 1..7)', () => {
    for (const bad of [0, 8, 1.5, -1, Number.NaN]) expect(() => activityWindow(100n, bad, 0n)).toThrow(/days/);
    expect(MAX_ACTIVITY_DAYS).toBe(7);
  });
});

// ── decodeActivity ───────────────────────────────────────────────────────

let logIndex = 0;
function mkLog(address: string, abi: readonly unknown[], eventName: string, args: Record<string, unknown>, block: bigint, opts: Partial<Log> = {}): Log {
  const enc = encodeEventTopics as unknown as (p: object) => Hex[];
  const item = (abi as Array<{ type: string; name: string; inputs: Array<{ name: string; type: string; indexed?: boolean; components?: unknown }> }>).find(
    (x) => x.type === 'event' && x.name === eventName,
  )!;
  const topics = enc({ abi, eventName, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) });
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => args[i.name]) as never);
  return {
    address: address as Hex,
    topics: topics as never,
    data,
    blockNumber: block,
    blockHash: `0x${'0'.repeat(64)}`,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
    ...opts,
  } as Log;
}

describe('decodeActivity', () => {
  const ex = book.contracts.SweepExecutor;
  const park = book.contracts.CashPark;
  const rules = book.contracts.RuleRegistry;
  const elections = book.contracts.ElectionRegistry;

  const logs: Log[] = [
    mkLog(ex, sweepExecutorAbi, 'Delivered', { account: ACCOUNT, token: SPY, amount: 6_486_471_341_257_423n }, 300n),
    mkLog(rules, ruleRegistryAbi, 'Linked', { account: ACCOUNT, wallet: ACCOUNT }, 100n),
    mkLog(rules, ruleRegistryAbi, 'RuleSet', { account: ACCOUNT, roundTo: 1, multiplier: 3, weeklyCap: 25_000_000n, enabled: true }, 101n),
    mkLog(elections, electionRegistryAbi, 'MixSet', { account: ACCOUNT, legs: [{ asset: SPY, bps: 6000 }, { asset: FIXTURE_TOKENS.NVDA, bps: 4000 }] }, 102n),
    mkLog(ex, sweepExecutorAbi, 'Accrued', { account: ACCOUNT, wallet: ACCOUNT, amount: 750_000n, fromBlock: 100n, toBlock: 200n }, 250n),
    mkLog(park, cashParkAbi, 'Credited', { account: ACCOUNT, amount: 750_000n }, 250n),
    mkLog(ex, sweepExecutorAbi, 'AccountSwept', { account: ACCOUNT, epoch: 20727n, usdg: 5_000_000n }, 300n),
    mkLog(ex, sweepExecutorAbi, 'Deferred', { account: ACCOUNT, asset: FIXTURE_TOKENS.NVDA, usdg: 2_000_000n, status: 1 }, 300n),
    // noise that must be dropped:
    mkLog(ex, sweepExecutorAbi, 'Accrued', { account: OTHER, wallet: OTHER, amount: 1n, fromBlock: 1n, toBlock: 2n }, 260n),
    mkLog(OTHER, sweepExecutorAbi, 'Accrued', { account: ACCOUNT, wallet: ACCOUNT, amount: 9n, fromBlock: 1n, toBlock: 2n }, 261n),
    mkLog(ex, sweepExecutorAbi, 'Accrued', { account: ACCOUNT, wallet: ACCOUNT, amount: 9n, fromBlock: 1n, toBlock: 2n }, 262n, { removed: true }),
    mkLog(ex, sweepExecutorAbi, 'AssetSwept', { asset: SPY, usdgIn: 1n, fee: 0n, tokensOut: 1n }, 300n),
  ];

  it('decodes only this account\'s events from the Spare contracts, oldest first', () => {
    const items = decodeActivity(logs, book, ACCOUNT);
    expect(items.map((i) => i.kind)).toEqual(['linked', 'rule_set', 'mix_set', 'accrued', 'credited', 'delivered', 'swept', 'deferred']);
    const rule = items.find((i) => i.kind === 'rule_set')!;
    expect(rule.args).toMatchObject({ roundTo: 1, multiplier: 3, weeklyCap: '25000000', enabled: true });
    expect(rule.contract).toBe('RuleRegistry');
    const mix = items.find((i) => i.kind === 'mix_set')!;
    expect((mix.args.legs as Array<{ bps: number }>).map((l) => l.bps)).toEqual([6000, 4000]);
  });

  it('is case-insensitive on the account and filters by it', () => {
    expect(decodeActivity(logs, book, ACCOUNT.toLowerCase() as Hex).length).toBe(8);
    expect(decodeActivity(logs, book, OTHER).map((i) => i.kind)).toEqual(['accrued']);
  });

  it('summarises accruals, sweeps, deferrals and deliveries', () => {
    const s = summarise(decodeActivity(logs, book, ACCOUNT), book);
    expect(s.accruedUsd).toBe('0.75');
    expect(s.sweptUsd).toBe('5');
    expect(s.deferredUsd).toBe('2');
    expect(s.safeSettledUsd).toBe('0');
    expect(s.delivered).toEqual([{ symbol: 'SPY', token: SPY, amount: '0.006486471341257423' }]);
    void USDG;
  });

  it('one topic0 filter covers every account-scoped event', () => {
    expect(ACCOUNT_TOPICS.length).toBe(18);
    expect(new Set(ACCOUNT_TOPICS).size).toBe(18);
    const accrued = (encodeEventTopics as unknown as (p: object) => Hex[])({ abi: sweepExecutorAbi, eventName: 'Accrued' })[0];
    expect(ACCOUNT_TOPICS).toContain(accrued);
    expect(pad(ACCOUNT.toLowerCase() as Hex, { size: 32 }).length).toBe(66);
  });
});

describe('global feed + paging', () => {
  const ex = book.contracts.SweepExecutor;
  const logs: Log[] = [
    mkLog(ex, sweepExecutorAbi, 'Accrued', { account: ACCOUNT, wallet: ACCOUNT, amount: 250_000n, fromBlock: 1n, toBlock: 2n }, 500n),
    mkLog(ex, sweepExecutorAbi, 'Accrued', { account: OTHER, wallet: OTHER, amount: 1n, fromBlock: 1n, toBlock: 2n }, 501n),
    mkLog(ex, sweepExecutorAbi, 'AssetSwept', { asset: SPY, usdgIn: 4_987_500n, fee: 12_500n, tokensOut: 6_470_413_274_257_675n }, 502n),
  ];

  it('decodes every Spare event (including batch-level AssetSwept) when no account is given', () => {
    const items = decodeActivity(logs, book, null);
    expect(items.map((i) => i.kind)).toEqual(['accrued', 'accrued', 'asset_swept']);
    expect(GLOBAL_TOPICS.length).toBe(20);
  });

  const item = (block: number, logIndex = 0): ActivityItem => ({
    kind: 'accrued',
    contract: 'SweepExecutor',
    blockNumber: String(block),
    txHash: '0x',
    logIndex,
    args: {},
  });

  it('returns newest first and never splits a block across pages', () => {
    const items = [item(10), item(12, 0), item(12, 1), item(11), item(13)];
    const p1 = pageNewestFirst(items, 2);
    expect(p1.items.map((i) => `${i.blockNumber}:${i.logIndex}`)).toEqual(['13:0']); // block 12 would be split -> deferred whole
    expect(p1.truncated).toBe(true);
    expect(p1.nextBefore).toBe('13');
    const rest = items.filter((i) => BigInt(i.blockNumber) < BigInt(p1.nextBefore!));
    const p2 = pageNewestFirst(rest, 2);
    expect(p2.items.map((i) => `${i.blockNumber}:${i.logIndex}`)).toEqual(['12:1', '12:0']);
    expect(p2.nextBefore).toBe('12');
    const p3 = pageNewestFirst(items.filter((i) => BigInt(i.blockNumber) < 12n), 2);
    expect(p3.items.map((i) => i.blockNumber)).toEqual(['11', '10']);
    expect(p3.truncated).toBe(false);
    expect(p3.nextBefore).toBeNull();
  });

  it('returns an over-full single block whole rather than splitting it', () => {
    const p = pageNewestFirst([item(7, 0), item(7, 1), item(7, 2)], 2);
    expect(p.items.length).toBe(3);
    expect(p.nextBefore).toBe('7');
  });
});
