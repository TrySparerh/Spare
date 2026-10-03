/**
 * The per-IP read budget covers every public way into the Spare tools:
 * POST /mcp, POST /api/mcp and the /api/spare REST mirror draw from ONE
 * bucket, and MCP is charged per JSON-RPC message.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { listenLocal } from '../testServer.js';
import express from 'express';

const calls = vi.hoisted(() => ({ n: 0 }));

vi.mock('../mcp/registry.js', () => {
  const mk = (name: string) => ({
    name,
    category: 'Spare Engine',
    scope: 'read',
    free: true,
    description: name,
    params: [],
    handler: async () => {
      calls.n++;
      return { ok: true };
    },
  });
  const tools = [mk('spare_roundup_preview'), mk('spare_activity')];
  return {
    TOOLS: tools,
    REGISTRY: Object.fromEntries(tools.map((t) => [t.name, t])),
    buildCatalog: (toolset: string) => ({ toolset, tools: tools.map(({ handler: _h, ...m }) => m) }),
  };
});
vi.mock('../spare/tools.js', () => {
  const t = {
    name: 'spare_roundup_preview',
    category: 'Spare Engine',
    scope: 'read',
    free: true,
    description: 'x',
    params: [],
    handler: async () => {
      calls.n++;
      return { ok: true };
    },
  };
  return { SPARE_ENGINE_TOOLS: [t], SPARE_TOOL_BY_SLUG: new Map([['roundup-preview', t]]) };
});
vi.mock('../env.js', () => ({ env: {} }));

import mcpRouter, { rpcRouter } from './mcp.js';
import spareRouter from './spare.js';
import { BUDGET_CAPACITY, ROUNDUP_REPLAY_COST, spareReadBudget } from '../spare/budget.js';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/spare', spareRouter);
  app.use('/mcp', rpcRouter);
  app.use('/api/mcp', mcpRouter);
  server = http.createServer(app);
  base = await listenLocal(server);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  // Freeze the clock so the bucket does not refill mid-test (timers stay real).
  vi.useFakeTimers({ toFake: ['Date'] });
  spareReadBudget.reset();
  calls.n = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const rpc = (id: number, name = 'spare_roundup_preview') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('shared per-IP read budget', () => {
  it('POST /mcp is rate limited like the REST mirror (the old gap: 70 x 200)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await post('/mcp', rpc(i))).status);
    expect(statuses.filter((s) => s === 200).length).toBe(BUDGET_CAPACITY);
    expect(statuses.filter((s) => s === 429).length).toBe(70 - BUDGET_CAPACITY);
    const limited = await post('/mcp', rpc(999));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = (await limited.json()) as { jsonrpc: string; id: number; error: { code: number } };
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 999, error: { code: -32005 } });
  });

  it('a batch is charged per message, and scan-heavy tools cost more', async () => {
    // 10 x spare_activity = 60 units: exactly one minute of budget.
    const r1 = await post('/mcp', Array.from({ length: 10 }, (_, i) => rpc(i, 'spare_activity')));
    expect(r1.status).toBe(200);
    expect(calls.n).toBe(10);
    const r2 = await post('/api/mcp', rpc(11));
    expect(r2.status).toBe(429);
    expect(calls.n).toBe(10);
  });

  it('wallet= beside a real address is charged as a wallet replay on both paths (was 1 unit)', async () => {
    const addr = '0x7e57000000000000000000000000000000000001';
    const perMinute = BUDGET_CAPACITY / ROUNDUP_REPLAY_COST;
    for (let i = 0; i < perMinute; i++) expect((await fetch(`${base}/api/spare/roundup-preview?wallet=&address=${addr}`)).status).toBe(200);
    expect((await fetch(`${base}/api/spare/roundup-preview?wallet=&address=${addr}`)).status).toBe(429);
    spareReadBudget.reset();
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'spare_roundup_preview', arguments: { wallet: '', address: addr } } });
    for (let i = 0; i < perMinute; i++) expect((await post('/mcp', call(i))).status).toBe(200);
    expect((await post('/mcp', call(99))).status).toBe(429);
    expect(calls.n).toBe(2 * perMinute);
  });

  it('oversized batches are refused and run nothing', async () => {
    const r = await post('/mcp', Array.from({ length: 11 }, (_, i) => rpc(i)));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(calls.n).toBe(0);
  });

  it('/mcp, /api/mcp and /api/spare share one bucket', async () => {
    for (let i = 0; i < BUDGET_CAPACITY / 2; i++) expect((await fetch(`${base}/api/spare/roundup-preview`)).status).toBe(200);
    for (let i = 0; i < BUDGET_CAPACITY / 4; i++) expect((await post('/api/mcp', rpc(i))).status).toBe(200);
    for (let i = 0; i < BUDGET_CAPACITY / 4; i++) expect((await post('/mcp', rpc(i))).status).toBe(200);
    expect((await post('/mcp', rpc(1))).status).toBe(429);
    expect((await post('/api/mcp', rpc(2))).status).toBe(429);
    expect((await fetch(`${base}/api/spare/roundup-preview`)).status).toBe(429);
  });

  it('the retired playground, manifest and status endpoints 404 and run nothing', async () => {
    expect((await post('/api/mcp/playground/execute', { tool: 'spare_roundup_preview', params: {} })).status).toBe(404);
    expect((await fetch(`${base}/api/mcp/manifest`)).status).toBe(404);
    expect((await fetch(`${base}/api/mcp/status`)).status).toBe(404);
    expect(calls.n).toBe(0);
  });

  it('GET /api/mcp/tools defaults to the Spare engine toolset and is not charged', async () => {
    const r = await fetch(`${base}/api/mcp/tools`);
    expect(((await r.json()) as { toolset: string }).toolset).toBe('spare');
    const all = await fetch(`${base}/api/mcp/tools?toolset=all`);
    expect(((await all.json()) as { toolset: string }).toolset).toBe('all');
  });
});
