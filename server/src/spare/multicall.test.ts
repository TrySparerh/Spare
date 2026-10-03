/**
 * The API's batched read (multicall.ts aggregate3), through a real viem
 * client over a fake node: a revert fails its own call, an eth_call that
 * fails at the RPC throws. viem's multicall with allowFailure answered both
 * the same way, so a 429 read like a block where every contract reverted.
 */
import { describe, expect, it } from 'vitest';
import { encodeErrorResult, HttpRequestError, parseAbi, type Abi, type Address } from 'viem';
import { erc20Abi, stockRouterAbi } from './abis.js';
import { AGGREGATE3_CHUNK, aggregate3, isRevert, type Call } from './multicall.js';
import { fakeRpcClient, NO_DATA } from './testRpc.js';

const KEYED = 'https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef';
const T = '0x00000000000000000000000000000000000000a1' as Address;
const EOA = '0x00000000000000000000000000000000000000e0' as Address;
const POOR = '0x00000000000000000000000000000000000000b0' as Address;

/** balanceOf(x) = 2x, reverts with Error("poor") for POOR, a bare revert for 13; oracleStatus answers a pair. */
const answer = (fn: string, address: Address, args: readonly unknown[]): unknown => {
  if (address.toLowerCase() === EOA) return NO_DATA; // no code: success, empty return data
  if (fn === 'balanceOf') {
    const who = String(args[0]).toLowerCase();
    if (who === POOR) throw Object.assign(new Error('poor'), { data: encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['poor'] }) });
    if (BigInt(who) === 13n) throw new Error('bare revert');
    return BigInt(who) * 2n;
  }
  if (fn === 'oracleStatus') return [0, 600n * 10n ** 18n];
  throw new Error(`unexpected ${fn}`);
};
const bal = (who: bigint | Address): Call => ({
  address: T,
  abi: erc20Abi as Abi,
  functionName: 'balanceOf',
  args: [typeof who === 'bigint' ? (`0x${who.toString(16).padStart(40, '0')}` as Address) : who],
});
const http429 = () => new HttpRequestError({ url: KEYED, status: 429, body: { method: 'eth_call' }, details: 'Too Many Requests' });

describe('aggregate3', () => {
  it('one eth_call; each call decoded; a revert fails alone with its reason', async () => {
    const { client, calls } = fakeRpcClient({ answer });
    const got = await aggregate3(client, [
      bal(2n),
      bal(13n),
      bal(POOR),
      { address: T, abi: stockRouterAbi as Abi, functionName: 'oracleStatus', args: [T] },
      { address: EOA, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [T] },
    ]);
    expect(got).toEqual([
      { ok: true, value: 4n },
      { ok: false, error: 'reverted' },
      { ok: false, error: 'Error(poor)' },
      { ok: true, value: [0, 600n * 10n ** 18n] },
      { ok: false, error: 'no data (no contract at the address?)' },
    ]);
    expect(calls).toEqual({ ethCall: 1, aggregate3: 1 });
  });

  it('an eth_call that fails at the RPC throws: never every call "reverted"', async () => {
    const { client } = fakeRpcClient({ answer, fail: () => http429() });
    const err = await aggregate3(client, [bal(2n), bal(3n)]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isRevert(err)).toBe(false);
    expect((err as { shortMessage?: string }).shortMessage).toBe('HTTP request failed.');
  });

  it(`chunks of ${AGGREGATE3_CHUNK}: one failing chunk fails the whole read, never half a snapshot`, async () => {
    const many = Array.from({ length: AGGREGATE3_CHUNK * 2 + 5 }, (_, i) => bal(BigInt(i + 1_000)));
    const ok = fakeRpcClient({ answer });
    const got = await aggregate3(ok.client, many);
    expect(ok.calls.aggregate3).toBe(3);
    expect(got.map((r) => (r.ok ? r.value : null))).toEqual(many.map((_, i) => BigInt(i + 1_000) * 2n));

    let n = 0;
    const flaky = fakeRpcClient({ answer, fail: () => (++n === 2 ? http429() : null) });
    await expect(aggregate3(flaky.client, many)).rejects.toThrow();
  });

  it('a call that cannot be encoded fails alone and is not sent; an empty batch sends nothing', async () => {
    const { client, calls } = fakeRpcClient({ answer });
    const got = await aggregate3(client, [bal(2n), { address: T, abi: erc20Abi as Abi, functionName: 'balanceOf', args: ['not an address'] }]);
    expect(got).toEqual([{ ok: true, value: 4n }, { ok: false, error: 'call not encodable' }]);
    expect(await aggregate3(client, [])).toEqual([]);
    expect(calls.aggregate3).toBe(1);
  });
});

describe('isRevert', () => {
  it('a contract revert through readContract is a revert; an HTTP failure is not', async () => {
    const { client } = fakeRpcClient({ answer });
    const revert = await client.readContract({ address: T, abi: erc20Abi, functionName: 'balanceOf', args: [POOR] }).catch((e: unknown) => e);
    expect(isRevert(revert)).toBe(true);
    const down = fakeRpcClient({ answer, fail: () => http429() });
    const failed = await down.client.readContract({ address: T, abi: erc20Abi, functionName: 'balanceOf', args: [POOR] }).catch((e: unknown) => e);
    expect(isRevert(failed)).toBe(false);
    expect(isRevert(new Error('plain'))).toBe(false);
  });
});
