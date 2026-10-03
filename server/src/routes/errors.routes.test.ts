/**
 * Tool failures on the REST mirror and the MCP endpoint: whatever a handler
 * throws, the client gets one redacted line (never the URL, the upstream
 * reply or a stack), and an unexpected failure inside the JSON-RPC layer is a
 * JSON-RPC internal error instead of an unhandled rejection. The server-wide
 * eth_getLogs cap being full is a 503 `rpc_busy` with Retry-After.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { listenLocal } from '../testServer.js';
import express from 'express';

vi.mock('../spare/tools.js', async () => {
  const { RpcBusyError } = await vi.importActual<typeof import('../spare/client.js')>('../spare/client.js');
  const KEYED_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef';
  const mk = (name: string, handler: () => Promise<unknown>) => ({
    name,
    category: 'Spare Engine',
    scope: 'read',
    free: true,
    description: name,
    params: [],
    handler,
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const tools = [
    mk('spare_fees', async () => {
      throw new Error(`request to ${KEYED_URL}?apikey=1 failed\nDetails: {"error":"Must be authenticated!"}\n    at x (file:///srv/a.js:1:1)`);
    }),
    mk('spare_quote', async () => {
      throw new RangeError(`asset must be a ticker, not ${KEYED_URL}`);
    }),
    mk('spare_contracts', async () => circular),
    mk('spare_activity', async () => {
      throw new Error('scan failed', { cause: new RpcBusyError(2) });
    }),
  ];
  const token = mk('spare_token', async () => ({ launched: false }));
  return {
    SPARE_ENGINE_TOOLS: tools,
    SPARE_TOKEN_TOOL: token,
    SPARE_TOOL_BY_SLUG: new Map(tools.map((t) => [t.name.replace(/^spare_/, ''), t])),
  };
});

import mcpRouter, { rpcRouter } from './mcp.js';
import spareRouter from './spare.js';
import { spareReadBudget } from '../spare/budget.js';

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
  spareReadBudget.reset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function expectRedacted(text: string) {
  expect(text).not.toMatch(/fAkE-kEy|alchemy|https?:\/\/|Details|Must be authenticated|\bat .+:\d+:\d+/);
}

describe('REST mirror', () => {
  it('a read failure is a 502 with the first line, URL replaced', async () => {
    const r = await fetch(`${base}/api/spare/fees`);
    const text = await r.text();
    expect(r.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: 'chain_read_failed', message: 'request to [url] failed' });
    expectRedacted(text);
  });

  it('the server-wide log-read cap full is a 503 rpc_busy with Retry-After, not a 502', async () => {
    const r = await fetch(`${base}/api/spare/activity`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('2');
    expect(await r.json()).toEqual({ error: 'rpc_busy', message: 'RPC busy: log reads are at the server-wide cap, retry in 2s', retryAfterSeconds: 2 });
  });

  it('an input error is a 400 with the message, URL replaced', async () => {
    const r = await fetch(`${base}/api/spare/quote`);
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: 'invalid_params', message: 'asset must be a ticker, not [url]' });
    expectRedacted(text);
  });
});

describe('MCP', () => {
  it('tools/call failures are reported in the result, redacted', async () => {
    for (const [name, text] of [
      ['spare_fees', 'tool_error: request to [url] failed'],
      ['spare_quote', 'invalid_params: asset must be a ticker, not [url]'],
      ['spare_activity', 'rpc_busy: RPC busy: log reads are at the server-wide cap, retry in 2s'],
    ] as const) {
      const r = await post('/mcp', call(name));
      const raw = await r.text();
      expect(r.status).toBe(200);
      expect(JSON.parse(raw).result).toEqual({ content: [{ type: 'text', text }], isError: true });
      expectRedacted(raw);
    }
  });

  it('a failure outside the tool (unserialisable result) is a JSON-RPC internal error, and the server keeps serving', async () => {
    const r = await post('/api/mcp', call('spare_contracts'));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } });
    expect((await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'ping' })).status).toBe(200);
  });
});
