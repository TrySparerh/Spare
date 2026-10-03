import { afterEach, describe, expect, it } from 'vitest';
import { getAddress, type PublicClient } from 'viem';
import { cleanTokenName, currentAssetDirectory, loadAssetDirectory, makeDirectory, readAssetDirectory, setAssetDirectory } from './assets.js';
import { answerAggregate3, isAggregate3, type Aggregate3Call } from './testRpc.js';

const REGISTRY = '0x6dA6e49E2c59b622697a208a83bF266D5268c937';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';

const ZERO = '0x0000000000000000000000000000000000000000';
const key = { currency0: ZERO, currency1: ZERO, fee: 500, tickSpacing: 10, hooks: ZERO };

/** A fake registry: `tokens` registered, answered per function name (batched reads through Multicall3.aggregate3). */
function fakeRegistry(tokens: string[], opts: { failTokens?: boolean; failBatch?: boolean } = {}) {
  let reads = 0;
  const answer = (fn: string, address: string, args: readonly unknown[]): unknown => {
    // Only A is active.
    const t = String(args[0] ?? '').toLowerCase();
    if (fn === 'get') return { token: t, feed: '0x00000000000000000000000000000000000000f1', feedDecimals: 8, heartbeat: 86_400, bandBps: 150, active: t === A, poolKey: key };
    if (fn === 'symbol') {
      if (address.toLowerCase() !== A) throw new Error('symbol() reverts');
      return 'AAA';
    }
    if (fn === 'name') return address.toLowerCase() === A ? 'Alpha Holdings • Robinhood Token' : 'Beta Bond ETF • Robinhood Token';
    throw new Error(`unexpected ${fn}`);
  };
  const client = {
    readContract: async (p: { functionName: string; args?: readonly unknown[] }) => {
      if (isAggregate3(p)) {
        if (opts.failBatch) throw new Error('eth_call failed: 429 Too Many Requests');
        return answerAggregate3(answer, p.args![0] as Aggregate3Call[]);
      }
      reads++;
      if (opts.failTokens) throw new Error('rpc down');
      return tokens;
    },
  } as unknown as PublicClient;
  return { client, reads: () => reads };
}

afterEach(() => setAssetDirectory(null));

describe('asset directory', () => {
  it('reads the registry: symbols, names, flags — no list of its own', async () => {
    const { client } = fakeRegistry([A, B]);
    const d = await readAssetDirectory(client, REGISTRY);
    expect(d.assets.map((a) => [a.symbol, a.name, a.active])).toEqual([
      ['AAA', 'Alpha Holdings', true],
      ['', 'Beta Bond ETF', false],
    ]);
    expect(d.bySymbol.get('AAA')?.token).toBe(getAddress(A));
    // A token whose symbol() failed still resolves by address, never by a guessed ticker.
    expect(d.byToken.get(B.toLowerCase())?.symbol).toBe('');
    expect(d.bySymbol.has('')).toBe(false);
  });

  it('caches for a minute, shares concurrent reads, and keeps the last good read when a refresh fails', async () => {
    const ok = fakeRegistry([A]);
    const [d1, d2] = await Promise.all([loadAssetDirectory(ok.client, REGISTRY), loadAssetDirectory(ok.client, REGISTRY)]);
    expect(d1).toBe(d2);
    expect(ok.reads()).toBe(1);
    await loadAssetDirectory(ok.client, REGISTRY);
    expect(ok.reads()).toBe(1);

    const down = fakeRegistry([A], { failTokens: true });
    const stale = await loadAssetDirectory(down.client, REGISTRY, { maxAgeMs: 0 });
    expect(stale).toBe(d1);
    setAssetDirectory(null);
    await expect(loadAssetDirectory(down.client, REGISTRY)).rejects.toThrow(/rpc down/);
    expect(currentAssetDirectory()).toBeNull();
  });

  it('an RPC failure on the batched get/symbol/name read fails the refresh: never a blank directory over a good one', async () => {
    const good = await loadAssetDirectory(fakeRegistry([A, B]).client, REGISTRY);
    expect(good.bySymbol.get('AAA')?.token).toBe(getAddress(A));
    const flaky = fakeRegistry([A, B], { failBatch: true });
    await expect(readAssetDirectory(flaky.client, REGISTRY)).rejects.toThrow(/429/);
    // The cached read survives the failed refresh, symbols and flags intact.
    const after = await loadAssetDirectory(flaky.client, REGISTRY, { maxAgeMs: 0 });
    expect(after).toBe(good);
    expect(after.assets.map((a) => [a.symbol, a.active])).toEqual([
      ['AAA', true],
      ['', false],
    ]);
  });

  it('first registration wins a duplicate symbol; names lose the Robinhood suffix', () => {
    const d = makeDirectory([
      { token: A, symbol: 'DUP', name: null, active: true, feed: null, bandBps: null },
      { token: B, symbol: 'dup', name: null, active: true, feed: null, bandBps: null },
    ]);
    expect(d.bySymbol.get('DUP')?.token).toBe(A); // makeDirectory keeps the address as given
    expect(cleanTokenName('Apple • Robinhood Token')).toBe('Apple');
    expect(cleanTokenName(42)).toBeNull();
  });
});
