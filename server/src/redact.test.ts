import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http } from 'viem';
import { spareChain } from './spare/client.js';
import { MAX_ERROR_CHARS, REDACTED_URL, redactUrls, safeErrorMessage } from './redact.js';

const KEY = 'fAkE-kEy-0123456789abcdef';
const KEYED_URL = `https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`;

/** A real viem error, raised through viem's own HTTP transport against a keyed provider URL. */
async function viemError(reply: () => Response): Promise<Error> {
  vi.stubGlobal('fetch', async () => reply());
  const client = createPublicClient({ chain: spareChain, transport: http(KEYED_URL, { retryCount: 0 }) });
  return client.getBlockNumber({ cacheTime: 0 }).then(
    () => {
      throw new Error('expected the read to fail');
    },
    (err: Error) => err,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safeErrorMessage', () => {
  it('a viem HTTP error carrying URL: https://robinhood-mainnet.g.alchemy.com/v2/<key> becomes one keyless line', async () => {
    const err = await viemError(() => new Response('{"error":"Must be authenticated!"}', { status: 401 }));
    // What used to reach clients: the full message, key included.
    expect(err.name).toBe('HttpRequestError');
    expect(err.message).toContain(`URL: ${KEYED_URL}`);
    const out = safeErrorMessage(err);
    expect(out).toBe('HTTP request failed.');
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/alchemy|URL:|Request body|Must be authenticated|\n/);
  });

  it("an upstream JSON-RPC error body never comes through, only viem's fixed summary", async () => {
    const err = await viemError(
      () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'upstream says: see https://status.example/x?k=1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(err.message).toContain('upstream says');
    const out = safeErrorMessage(err);
    expect(out).not.toMatch(/upstream says|status\.example|alchemy/);
    expect(out).not.toContain(KEY);
    expect(out.length).toBeGreaterThan(0);
  });

  it('strips URLs (scheme or not, with path and query) from a plain error line', () => {
    expect(safeErrorMessage(new Error(`request to ${KEYED_URL}?apikey=abc&x=1 failed`))).toBe(`request to ${REDACTED_URL} failed`);
    expect(safeErrorMessage(new Error(`fetch robinhood-mainnet.g.alchemy.com/v2/${KEY} refused`))).toBe(`fetch ${REDACTED_URL} refused`);
    expect(safeErrorMessage(new Error('socket wss://user:pass@node.example:8546/ws closed'))).toBe(`socket ${REDACTED_URL} closed`);
    expect(redactUrls('ok "http://a.example/b" ok')).toBe(`ok "${REDACTED_URL}" ok`);
  });

  it('keeps only the first line: no stack, no details', () => {
    const err = new Error('boom\n    at handler (file:///srv/app/dist/x.js:1:1)\nDetails: secret');
    expect(safeErrorMessage(err)).toBe('boom');
    expect(safeErrorMessage(err)).not.toContain(err.stack!.split('\n')[1]!.trim());
  });

  it('keeps plain input-validation messages as they are', () => {
    expect(safeErrorMessage(new RangeError('roundTo must be 1, 5 or 10 (got 3)'))).toBe('roundTo must be 1, 5 or 10 (got 3)');
    expect(safeErrorMessage(new Error('Spare address book: contracts.SweepExecutor is not an address'))).toBe(
      'Spare address book: contracts.SweepExecutor is not an address',
    );
  });

  it('falls back for empty, non-Error or URL-only input, and caps the length', () => {
    expect(safeErrorMessage(null)).toBe('request failed');
    expect(safeErrorMessage({}, 'read failed')).toBe('read failed');
    expect(safeErrorMessage(new Error('\n\n'), 'scan failed')).toBe('scan failed');
    expect(safeErrorMessage('plain string')).toBe('plain string');
    expect(safeErrorMessage(new Error('x'.repeat(500))).length).toBe(MAX_ERROR_CHARS);
  });
});
