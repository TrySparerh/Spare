import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { setSpareClient } from '../spare/client.js';
import { getTierDistribution } from './holderSnapshot.js';

const TOKEN = '0x00000000000000000000000000000000005Fa4E1';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;

/** A fake Spare client: one Transfer chunk, two holders (holder tier and og tier); `failBalanceOf` makes that read fail. */
function fakeClient(getLogs: () => Promise<unknown[]>, failBalanceOf?: string): PublicClient {
  return {
    getBlockNumber: async () => 100n,
    getLogs,
    readContract: async (p: { functionName: string }) => (p.functionName === 'decimals' ? 18 : 1_000_000n * E18),
    multicall: async (p: { contracts: Array<{ args: [string] }> }) =>
      p.contracts.map((c) =>
        c.args[0] === failBalanceOf ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: c.args[0] === A ? 10_000n * E18 : 600_000n * E18 },
      ),
  } as unknown as PublicClient;
}

afterEach(() => {
  delete process.env.SPARE_TOKEN_ADDRESS;
  setSpareClient(null);
  vi.restoreAllMocks();
});

describe('$SPARE holder snapshot', () => {
  it('is empty while the token is not launched', async () => {
    const d = await getTierDistribution();
    expect(d.token.launched).toBe(false);
    expect(d.totalHolders).toBe(0);
  });

  it('reads through the one Spare RPC client, and its log lines carry no RPC URL or key', async () => {
    process.env.SPARE_TOKEN_ADDRESS = TOKEN;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let first = true;
    setSpareClient(
      fakeClient(async () => {
        if (first) {
          first = false;
          throw new Error('request to https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef failed\nDetails: Must be authenticated!');
        }
        return [];
      }),
    );
    const stub = await getTierDistribution();
    expect(stub.warming).toBe(true);
    expect(stub.complete).toBe(false);
    await vi.waitFor(async () => expect((await getTierDistribution()).cached).toBe(true));
    // The one log chunk failed: whatever was counted is not every holder.
    expect((await getTierDistribution()).complete).toBe(false);
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(lines).toContain('[holderSnapshot] getLogs 0-100 failed: request to [url] failed');
    expect(lines).not.toMatch(/fAkE-kEy|alchemy|Must be authenticated/);
  });
});

describe('$SPARE holder snapshot (token live)', () => {
  it('classifies holders from the injected Spare client', async () => {
    vi.resetModules();
    const { setSpareClient: inject } = await import('../spare/client.js');
    const { getTierDistribution: dist } = await import('./holderSnapshot.js');
    process.env.SPARE_TOKEN_ADDRESS = TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    inject(fakeClient(async () => [{ args: { from: '0x0000000000000000000000000000000000000000', to: A } }, { args: { from: A, to: B } }]));
    await dist();
    await vi.waitFor(async () => expect((await dist()).cached).toBe(true));
    const d = await dist();
    expect(d.token.launched).toBe(true);
    expect(d.totalHolders).toBe(2);
    expect(d.counts).toEqual({ standard: 0, holder: 1, whale: 0, og: 1 });
    expect(d.totalSupply).toBe(1_000_000);
    expect(d.complete).toBe(true);
    inject(null);
  });

  it('a balance that could not be read leaves that holder out and marks the snapshot incomplete', async () => {
    vi.resetModules();
    const { setSpareClient: inject } = await import('../spare/client.js');
    const { getTierDistribution: dist } = await import('./holderSnapshot.js');
    process.env.SPARE_TOKEN_ADDRESS = TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    inject(fakeClient(async () => [{ args: { from: A, to: B } }], B));
    await dist();
    await vi.waitFor(async () => expect((await dist()).cached).toBe(true));
    const d = await dist();
    expect(d.totalHolders).toBe(1);
    expect(d.complete).toBe(false);
    inject(null);
  });

  it('not launched: a complete, empty distribution', async () => {
    const { emptyTierDistribution } = await import('./spareToken.js');
    expect(emptyTierDistribution()).toMatchObject({ totalHolders: 0, warming: false, complete: true });
  });
});
