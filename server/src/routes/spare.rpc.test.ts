/**
 * An RPC failure under a Spare read is a clean, redacted 502 on the REST
 * mirror. Before multicall.ts, a failed multicall eth_call read like every
 * call reverting, and the route answered 200 with defaults the chain never
 * said (every asset "unknown" with oracle BAD_ANSWER, an empty mix, $0 parked).
 * The reads run for real here, over a viem client whose node answers single
 * reads but fails Multicall3 with a 429 from a keyed provider URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { listenLocal } from '../testServer.js';
import express from 'express';
import { HttpRequestError } from 'viem';
import spareRouter from './spare.js';
import { spareReadBudget } from '../spare/budget.js';
import { MULTICALL3 } from '../spare/book.js';
import { setSpareClient } from '../spare/client.js';
import { setAssetDirectory } from '../spare/assets.js';
import { FIXTURE_TOKENS, installFixtureDirectory } from '../spare/testFixtures.js';
import { fakeRpcClient } from '../spare/testRpc.js';

const KEYED = 'https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/spare', spareRouter);
  server = http.createServer(app);
  base = await listenLocal(server);
});
afterAll(async () => {
  setSpareClient(null);
  setAssetDirectory(null);
  await new Promise<void>((r) => server.close(() => r()));
});

let multicalls = 0;
beforeEach(() => {
  spareReadBudget.reset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  installFixtureDirectory();
  multicalls = 0;
  const { client } = fakeRpcClient({
    // Single reads answer (the registry's token list); every batched read hits the 429.
    answer: (fn) => {
      if (fn === 'tokens') return [FIXTURE_TOKENS.SPY];
      throw new Error(`unexpected single read ${fn}`);
    },
    fail: (to) => {
      if (to.toLowerCase() !== MULTICALL3.toLowerCase()) return null;
      multicalls++;
      return new HttpRequestError({ url: KEYED, status: 429, body: { method: 'eth_call' }, details: 'Too Many Requests' });
    },
  });
  setSpareClient(client);
});

describe('REST mirror: an RPC failure under a batched read', () => {
  for (const path of ['/universe', '/account/0x000000000000000000000000000000000000a11c', '/quote?asset=SPY&usdgIn=5', '/fees']) {
    it(`GET /api/spare${path} -> 502 chain_read_failed, one redacted line`, async () => {
      const r = await fetch(`${base}/api/spare${path}`);
      const text = await r.text();
      expect(r.status).toBe(502);
      expect(JSON.parse(text)).toEqual({ error: 'chain_read_failed', message: 'HTTP request failed.' });
      expect(text).not.toMatch(/fAkE-kEy|alchemy|https?:\/\/|Too Many Requests/);
      expect(multicalls).toBeGreaterThan(0);
    });
  }
});
