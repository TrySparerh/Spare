import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { DEPLOYMENT_4663, parseBook } from './book.js';
import {
  applyRollingCap,
  makeClassifier,
  replayRoundUps,
  REPLAY_MAX_CALLS,
  REPLAY_MAX_RECIPIENTS,
  REPLAY_MAX_TRANSFERS,
  REPLAY_VENUE,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
} from './replay.js';
import { answerAggregate3, isAggregate3, type Aggregate3Call } from './testRpc.js';

const book = parseBook(DEPLOYMENT_4663);
const WALLET = '0x7e57000000000000000000000000000000000001' as const;
const ACCOUNT = '0x2222222222222222222222222222222222222222' as const;
const OTHER_LINKED = '0x3333333333333333333333333333333333333333' as const;
const MERCHANT = '0x4444444444444444444444444444444444444444' as const;
const V3_POOL = '0x5555555555555555555555555555555555555555' as const;
const DAY = 86_400;

describe('makeClassifier (keeper parity)', () => {
  const classify = makeClassifier({
    account: ACCOUNT,
    linkedWallets: [WALLET, OTHER_LINKED],
    spareContracts: Object.values(book.contracts),
    venue: REPLAY_VENUE,
  });
  it('excludes, in the keeper order', () => {
    expect(classify('0x0000000000000000000000000000000000000000')).toBe('to-zero-address');
    expect(classify(ACCOUNT)).toBe('to-account');
    expect(classify(OTHER_LINKED.toUpperCase().replace('0X', '0x'))).toBe('to-linked-wallet');
    expect(classify(book.contracts.CashPark)).toBe('to-spare-contract');
    expect(classify('0x8366a39cc670b4001a1121b8f6a443a643e40951')).toBe('to-venue'); // v4 PoolManager
    expect(classify('0x8876789976decbfcbbbe364623c63652db8c0904')).toBe('to-venue'); // Universal Router
    expect(classify(MERCHANT)).toBeNull();
  });
});

describe('applyRollingCap (SweepExecutor.dayPulled, rolling 7 UTC days)', () => {
  it('clamps within a week and frees room once a day leaves the window', () => {
    const d0 = 20_000 * DAY;
    const items = [
      { delta: 4_000_000n, ts: d0 },
      { delta: 4_000_000n, ts: d0 + 3 * DAY }, // only $1 of room left
      { delta: 4_000_000n, ts: d0 + 6 * DAY }, // week full
      { delta: 4_000_000n, ts: d0 + 7 * DAY }, // day 0 left the window: $4 of room again
    ];
    expect(applyRollingCap(items, 5_000_000n)).toEqual([4_000_000n, 1_000_000n, 0n, 4_000_000n]);
    expect(applyRollingCap(items, null)).toEqual(items.map((i) => i.delta));
  });
});

describe('replayRoundUps (wallet mode)', () => {
  const head = 80_000_000n;
  const headTs = 1_791_000_000;
  const transfers = [
    { to: MERCHANT, value: 3_750_000n, block: head - 100n, log: 0, tx: '0x01' }, // $3.75 -> $0.25
    { to: MERCHANT, value: 12_400_000n, block: head - 90n, log: 0, tx: '0x02' }, // $12.40 -> $0.60
    { to: OTHER_LINKED, value: 1_500_000n, block: head - 80n, log: 0, tx: '0x03' }, // own wallet
    { to: '0x8876789976decbfcbbbe364623c63652db8c0904', value: 2_500_000n, block: head - 70n, log: 0, tx: '0x04' }, // swap
    { to: V3_POOL, value: 1_100_000n, block: head - 60n, log: 0, tx: '0x05' }, // v3 pool swap leg
    { to: MERCHANT, value: 7_000_000n, block: head - 50n, log: 0, tx: '0x06' }, // on the boundary -> $0
  ];
  let batchDown = false;
  const client = {
    getBlock: async () => ({ number: head, timestamp: BigInt(headTs) }),
    readContract: async (p: { functionName: string; args?: readonly unknown[] }) => {
      // Multicall3.aggregate3 (multicall.ts); a throw below is that call reverting.
      if (isAggregate3(p)) {
        if (batchDown) throw new Error('eth_call failed: 429 Too Many Requests');
        return answerAggregate3(
          (fn, address) => {
            if (fn === 'accountOf') return ACCOUNT;
            const isPool = address.toLowerCase() === V3_POOL;
            if (!isPool && fn !== 'getPool') throw new Error('not a v3 pool');
            if (fn === 'token0') return book.external.USDG;
            if (fn === 'token1') return '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
            if (fn === 'fee') return 100;
            if (fn === 'getPool') return V3_POOL;
            throw new Error(`unexpected ${fn}`);
          },
          p.args![0] as Aggregate3Call[],
          [V3_POOL_ABI, V3_FACTORY_ABI],
        );
      }
      if (p.functionName === 'walletsOf') return [WALLET, OTHER_LINKED];
      throw new Error(`unexpected ${p.functionName}`);
    },
    getLogs: async (p: { fromBlock: bigint; toBlock: bigint }) =>
      transfers
        .filter((t) => t.block >= p.fromBlock && t.block <= p.toBlock)
        .map((t) => ({
          removed: false,
          blockNumber: t.block,
          logIndex: t.log,
          transactionHash: t.tx,
          args: { from: WALLET, to: t.to, value: t.value },
        })),
  } as unknown as PublicClient;

  it('prices real payments, lists exclusions, and applies the cap', async () => {
    const r = await replayRoundUps({ wallet: WALLET, days: 7, roundTo: 1, multiplier: 1, weeklyCapUsd: '0.5' }, client, book);
    expect(r.mode).toBe('wallet');
    expect(r.account).toBe(ACCOUNT);
    expect(r.payments).toBe(3);
    expect(r.rows.map((x) => [x.amount, x.roundUp, x.txHash])).toEqual([
      ['7', '0', '0x06'],
      ['12.4', '0.6', '0x02'],
      ['3.75', '0.25', '0x01'],
    ]);
    expect(r.totalUsd).toBe('0.85');
    expect(r.cappedTotalUsd).toBe('0.5');
    expect(r.droppedByCapUsd).toBe('0.35');
    expect(r.excluded.map((x) => [x.txHash, x.reason])).toEqual([
      ['0x05', 'to-venue'],
      ['0x04', 'to-venue'],
      ['0x03', 'to-linked-wallet'],
    ]);
    expect(r.window.complete).toBe(true);
    expect(r.window.getLogsCalls).toBe(4); // 7 days = 6,048,000 blocks in 2M-block chunks
  });

  it('an RPC failure on the venue / account batch fails the replay: never a swap leg counted as a payment', async () => {
    batchDown = true;
    try {
      await expect(replayRoundUps({ wallet: WALLET, days: 7, roundTo: 1, multiplier: 1 }, client, book)).rejects.toThrow(/429/);
    } finally {
      batchDown = false;
    }
  });

  it('validates input', async () => {
    await expect(replayRoundUps({ wallet: 'nope', roundTo: 1, multiplier: 1 }, client, book)).rejects.toThrow(/wallet/);
    await expect(replayRoundUps({ wallet: WALLET, days: 31, roundTo: 1, multiplier: 1 }, client, book)).rejects.toThrow(/days/);
    await expect(replayRoundUps({ wallet: WALLET, roundTo: 2, multiplier: 1 }, client, book)).rejects.toThrow(/roundTo/);
  });
});

describe('replayRoundUps bounds: one call costs the same whatever the wallet', () => {
  const head = 80_000_000n;
  const headTs = 1_791_000_000;
  const payee = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;

  /** A fake chain for a wallet with no Spare link whose payees are all EOAs; counts every read. */
  function spamClient(getLogs: (p: { fromBlock: bigint; toBlock: bigint }) => unknown[]) {
    const n = { getLogs: 0, ethCalls: 0 };
    const client = {
      getBlock: async () => ({ number: head, timestamp: BigInt(headTs) }),
      readContract: async (p: { functionName: string; args?: readonly unknown[] }) => {
        n.ethCalls++;
        if (!isAggregate3(p)) throw new Error(`unexpected ${p.functionName}`);
        return answerAggregate3(
          (fn) => {
            if (fn === 'accountOf') return '0x0000000000000000000000000000000000000000';
            throw new Error('not a v3 pool'); // an EOA has no token0()
          },
          p.args![0] as Aggregate3Call[],
          [V3_POOL_ABI, V3_FACTORY_ABI],
        );
      },
      getLogs: async (p: { fromBlock: bigint; toBlock: bigint }) => {
        n.getLogs++;
        return getLogs(p);
      },
    } as unknown as PublicClient;
    return { client, n };
  }
  const log = (block: bigint, logIndex: number, to: string, value = 1_250_000n) => ({
    removed: false,
    blockNumber: block,
    logIndex,
    transactionHash: `0x${(block * 100_000n + BigInt(logIndex)).toString(16).padStart(64, '0')}`,
    args: { from: WALLET, to, value },
  });

  it('a wallet paying a new address in every transfer (9,999 logs per read): 3 log reads, <= 50 eth_calls, newest payments only', async () => {
    let uniq = 0;
    const { client, n } = spamClient((p) =>
      Array.from({ length: 9_999 }, (_, i) => log(p.fromBlock + BigInt(i % 1000), i, payee(++uniq))),
    );
    const r = await replayRoundUps({ wallet: WALLET, days: 30, roundTo: 1, multiplier: 1 }, client, book);
    // Unbounded, this was 13 reads, 129,987 transfers held and 4,334 eth_calls.
    expect(n.getLogs).toBe(3); // 9,999 + 9,999 fit; the third read passes REPLAY_MAX_TRANSFERS and stops the scan
    expect(n.ethCalls).toBeLessThanOrEqual(50);
    // 10 transfers a block (9 in the newest): 60 whole blocks hold 599 payees; payee 600 and 601 share the 61st, left out whole.
    expect(r.payments).toBe(599);
    expect(r.payments).toBeLessThanOrEqual(REPLAY_MAX_RECIPIENTS);
    expect(r.window.complete).toBe(false);
    expect(r.window.stoppedBy).toBe('recipients');
    expect(r.notes.join(' ')).toMatch(/Payee cap reached \(600 distinct payees checked for swap pools\): payments before block \d+ are not included/);
  });

  it('the payee cap cuts at a whole block, leaves out everything older, and excluded transfers do not count toward it', async () => {
    const OWN = OTHER_LINKED;
    const logs = [
      ...Array.from({ length: 10 }, (_, k) => log(head - 10n - BigInt(k), 0, '0x0000000000000000000000000000000000000000')), // burns
      ...Array.from({ length: 700 }, (_, k) => log(head - 1_000n - BigInt(k), 0, payee(k + 1))),
      log(head - 1_000n - 600n, 1, OWN), // shares the cut block with payee 601
      log(head - 5_000n, 0, payee(1)), // an already-checked payee, but older than the cut
    ];
    const { client, n } = spamClient((p) => logs.filter((l) => l.blockNumber >= p.fromBlock && l.blockNumber <= p.toBlock));
    const r = await replayRoundUps({ wallet: WALLET, days: 7, roundTo: 1, multiplier: 1 }, client, book);
    expect(r.payments).toBe(600);
    expect(r.excludedCount).toBe(10);
    expect(r.window.scannedFromBlock).toBe((head - 1_000n - 600n + 1n).toString());
    expect(r.window).toMatchObject({ complete: false, stoppedBy: 'recipients', getLogsCalls: 4 });
    expect(r.rows.every((x) => BigInt(x.block) > head - 1_600n)).toBe(true);
    expect(n.ethCalls).toBe(1 + 10 * 2); // accountOf + 10 batches of 60 payees (180 calls = 2 aggregate3 each)
  });

  it('the transfer cap keeps the newest whole blocks that fit and stops reading', async () => {
    // 20,010 transfers, 3 per block, all to one merchant; the cut falls inside a block.
    const logs = Array.from({ length: 20_010 }, (_, i) => log(head - 10n - BigInt(Math.floor(i / 3)), 2 - (i % 3), MERCHANT));
    const { client, n } = spamClient((p) => logs.filter((l) => l.blockNumber >= p.fromBlock && l.blockNumber <= p.toBlock));
    const r = await replayRoundUps({ wallet: WALLET, days: 30, roundTo: 1, multiplier: 1 }, client, book);
    const cutBlock = head - 10n - BigInt(Math.floor(REPLAY_MAX_TRANSFERS / 3)); // holds transfers 19,998..20,000
    expect(r.payments).toBe(19_998);
    expect(r.window).toMatchObject({ complete: false, stoppedBy: 'transfers', getLogsCalls: 1, scannedFromBlock: (cutBlock + 1n).toString() });
    expect(r.notes.join(' ')).toContain(`Transfer cap reached (20,000 outgoing transfers read): payments before block ${cutBlock + 1n} are not included.`);
    expect(n.getLogs).toBe(1);
  });

  it('the log-read budget running out inside a split chunk keeps the newer halves already read', async () => {
    // The provider refuses any range over 100,000 blocks; one transfer sits at the top of every range it serves.
    const served: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const { client } = spamClient((p) => {
      if (p.toBlock - p.fromBlock + 1n > 100_000n) throw new Error('query returned more than 10000 results');
      served.push(p);
      return [log(p.toBlock, 0, MERCHANT)];
    });
    const r = await replayRoundUps({ wallet: WALLET, days: 30, roundTo: 1, multiplier: 1 }, client, book);
    expect(r.window).toMatchObject({ complete: false, stoppedBy: 'log-reads', getLogsCalls: REPLAY_MAX_CALLS });
    expect(served.length).toBeGreaterThan(0);
    expect(r.payments).toBe(served.length);
    // Contiguous from the head down to scannedFromBlock, newest first.
    expect(served[0]!.toBlock).toBe(head);
    served.forEach((s, i) => i > 0 && expect(s.toBlock).toBe(served[i - 1]!.fromBlock - 1n));
    expect(r.window.scannedFromBlock).toBe(served.at(-1)!.fromBlock.toString());
    expect(r.notes.join(' ')).toContain(`Scan budget reached (${REPLAY_MAX_CALLS} log reads): payments before block ${served.at(-1)!.fromBlock}`);
  });
});
