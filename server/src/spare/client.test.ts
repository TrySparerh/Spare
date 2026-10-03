/**
 * The process-wide eth_getLogs cap: over it a read fails at once with
 * RpcBusyError (nothing sent upstream, no retry), whichever scan asked; the
 * shared client is built with it; other methods are never held back.
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createPublicClient, custom, parseAbiItem, toHex, type PublicClient } from 'viem';
import { createTokenBucket } from './budget.js';
import { GETLOGS_BURST, getLogsGate, gateGetLogs, getSpareClient, RpcBusyError, rpcBusyOf, setSpareClient, spareChain } from './client.js';
import { getBook } from './book.js';
import { scanActivity } from './logs.js';
import { replayRoundUps } from './replay.js';
import { listenLocal } from '../testServer.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const WALLET = '0x7e57000000000000000000000000000000000001';

/** A fake node behind the gate; `seen` counts what reached it, by method. */
function gated(tokens: number) {
  const seen: Record<string, number> = {};
  const request = async ({ method }: { method: string }) => {
    seen[method] = (seen[method] ?? 0) + 1;
    if (method === 'eth_blockNumber') return toHex(80_000_000n);
    if (method === 'eth_getBlockByNumber') return { number: toHex(80_000_000n), timestamp: toHex(1_791_000_000n), hash: `0x${'11'.repeat(32)}`, transactions: [] };
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_chainId') return '0x1237';
    throw new Error(`unexpected ${method}`);
  };
  const gate = createTokenBucket(tokens, 60_000);
  const client = createPublicClient({ chain: spareChain, transport: gateGetLogs(custom({ request }, { retryCount: 0 }), gate) }) as PublicClient;
  return { client, seen };
}

afterEach(() => {
  getLogsGate.reset();
  setSpareClient(null);
  delete process.env.SPARE_RPC_URL;
});

describe('eth_getLogs gate', () => {
  it('lets `burst` reads through, then fails fast with a retry hint and sends nothing; other methods pass', async () => {
    const { client, seen } = gated(3);
    for (let i = 0; i < 3; i++) await client.getLogs({ event: TRANSFER, fromBlock: 1n, toBlock: 2n });
    const err = await client.getLogs({ event: TRANSFER, fromBlock: 1n, toBlock: 2n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcBusyError);
    expect((err as RpcBusyError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((err as Error).message).toMatch(/^RPC busy: log reads are at the server-wide cap, retry in \d+s$/);
    expect(seen.eth_getLogs).toBe(3);
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(80_000_000n);
  });

  it('finds the busy error behind a wrapping cause', () => {
    const busy = new RpcBusyError(2);
    expect(rpcBusyOf(new Error('read failed', { cause: new Error('chunk failed', { cause: busy }) }))).toBe(busy);
    expect(rpcBusyOf(new Error('429 Too Many Requests'))).toBeNull();
    expect(rpcBusyOf(undefined)).toBeNull();
  });

  it('activity and wallet-replay scans fail at once on a busy gate: no backoff, no retry, no partial answer', async () => {
    const { client, seen } = gated(0);
    const book = getBook();
    const t0 = Date.now();
    await expect(scanActivity(client, book, { account: null, range: { from: 1n, to: 200_000n }, limit: 10 })).rejects.toBeInstanceOf(RpcBusyError);
    await expect(replayRoundUps({ wallet: WALLET, days: 7, roundTo: 1, multiplier: 1 }, gatedReplayClient(client), book)).rejects.toBeInstanceOf(
      RpcBusyError,
    );
    expect(Date.now() - t0).toBeLessThan(400); // the 429 path would back off 500 ms first
    expect(seen.eth_getLogs).toBeUndefined();
  });

  it('the shared client is built behind the gate', async () => {
    let upstream = 0;
    const node = http.createServer((req, res) => {
      upstream++;
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }));
    });
    process.env.SPARE_RPC_URL = await listenLocal(node);
    try {
      setSpareClient(null);
      for (let i = 0; i < GETLOGS_BURST; i++) expect(getLogsGate.take('eth_getLogs', 1)).toBe(0);
      await expect(getSpareClient().getLogs({ event: TRANSFER, fromBlock: 1n, toBlock: 2n })).rejects.toBeInstanceOf(RpcBusyError);
      expect(upstream).toBe(0);
    } finally {
      await new Promise<void>((r) => node.close(() => r()));
    }
  });
});

/** The replay reads `accountOf` through Multicall3 first: answer it (unlinked), keep getLogs on the gated client. */
function gatedReplayClient(client: PublicClient): PublicClient {
  return {
    getBlock: () => client.getBlock(),
    getLogs: (p: Parameters<PublicClient['getLogs']>[0]) => client.getLogs(p),
    readContract: async () => [{ success: true, returnData: `0x${'00'.repeat(32)}` }],
  } as unknown as PublicClient;
}
