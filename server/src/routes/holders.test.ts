import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { listenLocal } from '../testServer.js';
import express from 'express';

vi.mock('../services/holderSnapshot.js', () => ({
  getTierDistribution: async () => {
    throw new Error('request to https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef failed\nDetails: Must be authenticated!');
  },
}));

import holdersRouter from './holders.js';

let server: http.Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use('/api/spare/token/holders', holdersRouter);
  server = http.createServer(app);
  base = await listenLocal(server);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('GET /api/spare/token/holders/distribution', () => {
  it('a failed snapshot is a fixed 500 body, and the log line carries no RPC URL or key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await fetch(`${base}/api/spare/token/holders/distribution`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ ok: false, error: 'snapshot failed' });
    const line = error.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(line).toBe('[spare-token/holders] request to [url] failed');
    error.mockRestore();
  });
});
