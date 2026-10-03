/**
 * The real app over HTTP. Unknown routes are a JSON 404 (no upstream call),
 * the Spare routes answer, and no error a client can see
 * carries the RPC URL, an upstream reply or a stack.
 *
 * Chain reads go through a real viem client pointed at a keyed provider URL;
 * fetch to that host is stubbed to refuse, so every chain read fails exactly
 * the way a rate-limited or misconfigured provider would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createPublicClient, http as viemHttp, type PublicClient } from 'viem';
import { createApp, jsonErrorHandler } from './app.js';
import { setSpareClient, spareChain } from './spare/client.js';
import { clearSpareCaches } from './spare/tools.js';
import { spareReadBudget } from './spare/budget.js';
import { getBook } from './spare/book.js';
import { listenLocal } from './testServer.js';

const KEY = 'fAkE-kEy-0123456789abcdef';
const PROVIDER = 'https://robinhood-mainnet.g.alchemy.com';
const KEYED_URL = `${PROVIDER}/v2/${KEY}`;

const upstream = vi.hoisted(() => ({ calls: 0 }));
const realFetch = globalThis.fetch;

let server: http.Server;
let base = '';

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(PROVIDER)) {
      upstream.calls++;
      return Promise.resolve(new Response('{"error":"Must be authenticated! see https://dashboard.alchemy.com/apps"}', { status: 401 }));
    }
    return realFetch(input, init);
  });
  setSpareClient(createPublicClient({ chain: spareChain, transport: viemHttp(KEYED_URL, { retryCount: 0 }) }) as PublicClient);
  server = http.createServer(createApp());
  base = await listenLocal(server);
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  setSpareClient(null);
  vi.unstubAllGlobals();
});
beforeEach(() => {
  spareReadBudget.reset();
  clearSpareCaches();
  upstream.calls = 0;
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const post = (path: string, body: unknown, raw = false) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) });
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });

/** Nothing in a client-visible body that could identify or unlock the provider. */
function expectRedacted(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toMatch(/alchemy|https?:\/\/|URL:|Request body|Must be authenticated|\bat .+:\d+:\d+/);
}

describe('unknown routes', () => {
  const UNKNOWN: Array<[method: 'GET' | 'POST', path: string]> = [
    ['GET', '/api/unknown'],
    ['POST', '/api/unknown'],
    ['GET', '/api/v1/status'],
    ['POST', '/api/v1/query'],
  ];

  for (const [method, path] of UNKNOWN) {
    it(`${method} ${path} -> JSON 404, no upstream call`, async () => {
      const r = method === 'GET' ? await get(path) : await post(path, { q: 'x', symbol: 'NVDA' });
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(await r.json()).toEqual({ error: 'not_found' });
      expect(upstream.calls).toBe(0);
    });
  }
});

describe('Spare routes still answer', () => {
  it('GET /health: service up, RPC down shows as rpcOk=false (never a 5xx), keeper address from the book', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    const h = (await r.json()) as Record<string, any>;
    expect(h).toMatchObject({ ok: true, service: 'spare-api', chainId: 4663, rpcOk: false, block: null });
    expect(h.mcp).toMatchObject({ name: 'spare-mcp', tools: 7, endpoint: '/mcp' });
    expect(h.keeper.address).toBe(getBook().roles.keeper);
    expect(h.token).toEqual({ symbol: '$SPARE', launched: false, address: null });
  });

  it('GET /health stays a 200 (rpcOk=false) even when the address book cannot load', async () => {
    process.env.SPARE_ADDRESSES_JSON = '{not json';
    vi.resetModules();
    const fresh = await import('./app.js');
    const s = http.createServer(fresh.createApp());
    const sBase = await listenLocal(s);
    try {
      const r = await fetch(`${sBase}/health`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, rpcOk: false, keeper: null });
    } finally {
      delete process.env.SPARE_ADDRESSES_JSON;
      vi.resetModules();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('GET /api/spare index and a chain-free tool (round-up preview)', async () => {
    const idx = await get('/api/spare');
    expect(idx.status).toBe(200);
    expect(((await idx.json()) as { tools: unknown[] }).tools).toHaveLength(7);
    const r = await get('/api/spare/roundup-preview?amountUsd=3.75&roundTo=1&multiplier=3');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { delta: { usd: string } }).delta.usd).toBe('0.75');
  });

  it('bad input is a 400 with the validation message', async () => {
    const r = await get('/api/spare/roundup-preview?amountUsd=3.75&roundTo=3');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_params', message: 'roundTo must be 1, 5 or 10 (got 3)' });
  });

  it('GET /api/spare/token/* answer "not launched"', async () => {
    for (const path of ['/api/spare/token', '/api/spare/token/stats', '/api/spare/token/ledger', '/api/spare/token/pending']) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
    }
    const d = await get('/api/spare/token/holders/distribution');
    expect(d.status).toBe(200);
    expect(((await d.json()) as { ok: boolean; distribution: { totalHolders: number } }).distribution.totalHolders).toBe(0);
  });

  it('MCP: catalog, server card, initialize, tools/list and a tools/call', async () => {
    const cat = await get('/api/mcp/tools');
    expect(((await cat.json()) as { toolset: string; total: number }).total).toBe(7);
    expect(((await (await get('/mcp')).json()) as { name: string }).name).toBe('spare-mcp');
    const init = (await (await post('/mcp', rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))).json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('spare-mcp');
    const list = (await (await post('/api/mcp', rpc(2, 'tools/list'))).json()) as { result: { tools: unknown[] } };
    expect(list.result.tools).toHaveLength(7);
    const call = (await (await post('/mcp', rpc(3, 'tools/call', { name: 'spare_roundup_preview', arguments: { amountUsd: '3.75' } }))).json()) as {
      result: { isError: boolean; structuredContent: { delta: { usd: string } } };
    };
    expect(call.result.isError).toBe(false);
    expect(call.result.structuredContent.delta.usd).toBe('0.25');
  });

  it('GET / redirects to the site', async () => {
    const r = await fetch(`${base}/`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://trysparerh.com');
  });
});

describe('client-visible errors are redacted', () => {
  it('REST: a failed chain read is a 502 with one keyless line', async () => {
    for (const path of ['/api/spare/universe', '/api/spare/fees', '/api/spare/contracts', '/api/spare/quote?asset=SPY&usdgIn=5']) {
      const r = await get(path);
      const text = await r.text();
      expect(r.status, path).toBe(502);
      expect(JSON.parse(text), path).toEqual({ error: 'chain_read_failed', message: 'HTTP request failed.' });
      expectRedacted(text);
    }
    expect(upstream.calls).toBeGreaterThan(0);
  });

  it('MCP tools/call: the tool error text carries no URL, key or upstream reply', async () => {
    for (const path of ['/mcp', '/api/mcp']) {
      const r = await post(path, rpc(7, 'tools/call', { name: 'spare_universe', arguments: {} }));
      const text = await r.text();
      expect(r.status).toBe(200);
      const body = JSON.parse(text) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]!.text).toBe('tool_error: HTTP request failed.');
      expectRedacted(text);
    }
  });

  it('a disallowed browser origin is a JSON 403, not a 500 page', async () => {
    const r = await get('/api/spare', { origin: 'https://evil.example' });
    const text = await r.text();
    expect(r.status).toBe(403);
    expect(JSON.parse(text)).toEqual({ error: 'forbidden' });
    expect(text).not.toMatch(/Error:|\bat .+:\d+:\d+|evil\.example/);
  });

  it('malformed JSON: invalid_json on REST paths, a JSON-RPC parse error on MCP', async () => {
    const rest = await post('/api/spare', '{"broken":', true);
    expect(rest.status).toBe(400);
    expect(await rest.json()).toEqual({ error: 'invalid_json' });
    const mcp = await post('/mcp', '{"broken":', true);
    expect(mcp.status).toBe(400);
    expect(await mcp.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });

  it('an oversized body is a JSON 413', async () => {
    const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'payload_too_large' });
  });

  it('with NODE_ENV unset, Express runs as production (Express alone would say development)', async () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      vi.resetModules();
      const fresh = await import('./app.js');
      expect(fresh.createApp().get('env')).toBe('production');
      expect(express().get('env')).toBe('development');
    } finally {
      process.env.NODE_ENV = saved;
      vi.resetModules();
    }
  });
});

describe('jsonErrorHandler', () => {
  it('a thrown error is a JSON 500 with a fixed code; the log line is redacted', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    const app = express();
    app.get('/boom', () => {
      throw new Error(`upstream failed\nURL: ${KEYED_URL}\n    at handler (file:///srv/app.js:1:1)`);
    });
    app.use(jsonErrorHandler);
    const s = http.createServer(app);
    const sBase = await listenLocal(s);
    try {
      const r = await fetch(`${sBase}/boom`);
      const text = await r.text();
      expect(r.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
      expectRedacted(text);
      expect(logged.join('\n')).toContain('upstream failed');
      expectRedacted(logged.join('\n'));
    } finally {
      spy.mockRestore();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
