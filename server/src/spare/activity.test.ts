/**
 * spare_activity read cost: one call sends at most ACTIVITY_MAX_CALLS
 * eth_getLogs, whatever the filter. An account (or kinds filter) with no
 * events used to walk the whole 7-day window, 121 reads for 6 units; now it
 * pages through it with nextBefore, and the pages cover the window exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { readActivity } from './reads.js';
import { MULTICALL3, getBook } from './book.js';
import { spareChain } from './client.js';
import { answerAggregate3, type Aggregate3Call } from './testRpc.js';
import { ACTIVITY_MAX_CALLS, chunkRange } from './logs.js';
import { ruleRegistryAbi } from './abis.js';
import { toolCost } from './budget.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
// Seven days back from here starts after the deploy block, so the window is the full 121 chunks.
const HEAD = 83_000_000n;

/** A fake node: Spare reads revert, eth_getLogs answers from `logs`; every getLogs range is recorded. */
function fakeNode(logs: Array<{ block: bigint; raw: Record<string, unknown> }> = []) {
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case 'eth_chainId':
        return '0x1237';
      case 'eth_blockNumber':
        return toHex(HEAD);
      case 'eth_getBlockByNumber':
        return { number: toHex(HEAD), timestamp: toHex(1_791_000_000n), hash: `0x${'11'.repeat(32)}`, transactions: [] };
      case 'eth_getLogs': {
        const f = p[0] as { fromBlock: Hex; toBlock: Hex };
        const r = { from: BigInt(f.fromBlock), to: BigInt(f.toBlock) };
        ranges.push(r);
        return logs.filter((l) => l.block >= r.from && l.block <= r.to).map((l) => l.raw);
      }
      case 'eth_call': {
        const { to, data } = p[0] as { to: string; data: Hex };
        if (to.toLowerCase() !== MULTICALL3.toLowerCase()) throw new Error('revert');
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const out = answerAggregate3(() => {
          throw new Error('revert');
        }, args[0] as readonly Aggregate3Call[]);
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out });
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const client = createPublicClient({ chain: spareChain, transport: custom({ request }, { retryCount: 0 }) }) as PublicClient;
  return { client, ranges };
}

/** Pages until nextBefore is null; returns every page. */
async function allPages(client: PublicClient, q: Record<string, unknown>) {
  const pages: Array<Awaited<ReturnType<typeof readActivity>>> = [];
  let before: string | null | undefined;
  do {
    const r = await readActivity({ ...q, before: before ?? undefined }, client);
    pages.push(r);
    before = r.page.nextBefore;
  } while (before !== null && pages.length < 50);
  return pages;
}

describe('spare_activity: bounded reads per call, the rest by page', () => {
  it('an account with no events: one 6-unit call reads 24 chunks, not 121, and says where to continue', async () => {
    const { client, ranges } = fakeNode();
    const r = await readActivity({ address: ACCOUNT, days: 7, limit: 1 }, client);
    expect(toolCost('spare_activity', { address: ACCOUNT })).toBe(6);
    expect(ranges).toHaveLength(ACTIVITY_MAX_CALLS);
    expect(r.window).toMatchObject({ complete: false, getLogsCalls: ACTIVITY_MAX_CALLS, maxGetLogsCalls: ACTIVITY_MAX_CALLS });
    expect(r.count).toBe(0);
    expect(r.page).toEqual({ limit: 1, truncated: true, nextBefore: r.window.scannedFromBlock });
    expect(BigInt(r.window.scannedFromBlock)).toBe(ranges.at(-1)!.from);
  });

  it('following nextBefore covers the 7-day window exactly once, at most 24 reads a page', async () => {
    const { client, ranges } = fakeNode();
    const pages = await allPages(client, { address: ACCOUNT, days: 7, kinds: 'claimed' });
    const window = chunkRange(BigInt(pages[0]!.window.fromBlock), HEAD);
    expect(window).toHaveLength(121);
    expect(pages).toHaveLength(Math.ceil(121 / ACTIVITY_MAX_CALLS));
    expect(pages.every((p) => p.window.getLogsCalls <= ACTIVITY_MAX_CALLS)).toBe(true);
    expect(pages.at(-1)!.window.complete).toBe(true);
    expect(pages.at(-1)!.page).toEqual({ limit: 50, truncated: false, nextBefore: null });
    // Newest first, no gap, no overlap, nothing before the window.
    const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : 1));
    expect(sorted[0]!.from).toBe(window[0]!.from);
    expect(sorted.at(-1)!.to).toBe(HEAD);
    sorted.forEach((x, i) => i > 0 && expect(x.from).toBe(sorted[i - 1]!.to + 1n));
  });

  it('an event past the first page is found on a later page, once', async () => {
    const book = getBook();
    const block = HEAD - 3_000_000n; // ~60 chunks back: page 3
    const topics = (encodeEventTopics as unknown as (p: object) => Hex[])({ abi: ruleRegistryAbi, eventName: 'Linked', args: { account: ACCOUNT, wallet: ACCOUNT } });
    const raw = {
      address: book.contracts.RuleRegistry,
      topics,
      data: '0x',
      blockNumber: toHex(block),
      blockHash: `0x${'22'.repeat(32)}`,
      transactionHash: `0x${'33'.repeat(32)}`,
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    };
    const { client } = fakeNode([{ block, raw }]);
    const pages = await allPages(client, { address: ACCOUNT, days: 7 });
    const found = pages.flatMap((p) => p.items.map((i) => ({ kind: i.kind, block: i.block })));
    expect(found).toEqual([{ kind: 'linked', block: block.toString() }]);
    expect(pages.findIndex((p) => p.count === 1)).toBe(2);
  });
});
