/**
 * Test helper only: answer Multicall3.aggregate3 (multicall.ts) from a fake
 * that answers by function name, through the real ABI encoding. Each call's
 * calldata is decoded with the Spare ABIs (abis.ts) by selector, answered,
 * and encoded back, so the reads decode exactly what a node would return. A
 * throw is that call reverting (its `data`, if any, is the revert data).
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  RpcRequestError,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import * as abis from './abis.js';
import { MULTICALL3 } from './book.js';
import { spareChain } from './client.js';

const BY_SELECTOR = new Map<string, AbiFunction>();
for (const abi of Object.values(abis) as Abi[]) {
  for (const item of abi) {
    if (item.type !== 'function') continue;
    const sel = toFunctionSelector(item);
    if (!BY_SELECTOR.has(sel)) BY_SELECTOR.set(sel, item);
  }
}

export type Answer = (functionName: string, address: Address, args: readonly unknown[]) => unknown;
/** Return this from an Answer for a call that succeeds with no data (an address without code). */
export const NO_DATA = Symbol('no data');
export type Aggregate3Call = { target: Address; allowFailure: boolean; callData: Hex };

/** What Multicall3.aggregate3 returns for `calls` on the fake chain; `extraAbis` name functions outside abis.ts. */
export function answerAggregate3(answer: Answer, calls: readonly Aggregate3Call[], extraAbis: readonly Abi[] = []): { success: boolean; returnData: Hex }[] {
  const extra = extraAbis.flatMap((abi) => abi.filter((x): x is AbiFunction => x.type === 'function'));
  return calls.map(({ target, callData }) => {
    const item = BY_SELECTOR.get(callData.slice(0, 10)) ?? extra.find((x) => toFunctionSelector(x) === callData.slice(0, 10));
    if (!item) throw new Error(`fake chain: no Spare ABI function has selector ${callData.slice(0, 10)}`);
    const { args } = decodeFunctionData({ abi: [item], data: callData });
    try {
      const result = answer(item.name, target, args ?? []);
      if (result === NO_DATA) return { success: true, returnData: '0x' as Hex };
      // One output (an array or a struct included) is the value itself; several are a tuple.
      const values = item.outputs.length === 1 ? [result] : (result as readonly unknown[]);
      return { success: true, returnData: encodeAbiParameters(item.outputs, values as never) };
    } catch (err) {
      const data = (err as { data?: unknown }).data;
      return { success: false, returnData: typeof data === 'string' && data.startsWith('0x') ? (data as Hex) : '0x' };
    }
  });
}

/** True when a fake `readContract` is the Multicall3.aggregate3 read. */
export function isAggregate3(p: { functionName: string }): boolean {
  return p.functionName === 'aggregate3';
}

/**
 * A real viem PublicClient over a fake JSON-RPC node: eth_call to Multicall3
 * runs aggregate3 against `answer`, any other eth_call is answered directly
 * (a throw is a revert, code 3). `fail(to, data)` returning an Error makes
 * that eth_call fail AT THE RPC (a 429, a timeout) instead. No retries.
 */
export function fakeRpcClient(opts: {
  answer: Answer;
  block?: { number: bigint; timestamp: bigint };
  fail?: (to: Address, data: Hex) => Error | null;
}) {
  const block = opts.block ?? { number: 76_700_000n, timestamp: 1_790_000_000n };
  const calls = { ethCall: 0, aggregate3: 0 };
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case 'eth_chainId':
        return '0x1237';
      case 'eth_blockNumber':
        return toHex(block.number);
      case 'eth_getBlockByNumber':
        return { number: toHex(block.number), timestamp: toHex(block.timestamp), hash: `0x${'11'.repeat(32)}`, transactions: [] };
      case 'eth_call': {
        calls.ethCall++;
        const { to, data } = p[0] as { to: Address; data: Hex };
        const failure = opts.fail?.(to, data);
        if (failure) throw failure;
        if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
          calls.aggregate3++;
          const { args } = decodeFunctionData({ abi: multicall3Abi, data });
          const out = answerAggregate3(opts.answer, args[0] as readonly Aggregate3Call[]);
          return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out });
        }
        const [r] = answerAggregate3(opts.answer, [{ target: to, allowFailure: false, callData: data }]);
        if (!r!.success) throw new RpcRequestError({ body: {}, url: 'fake', error: { code: 3, message: 'execution reverted', data: r!.returnData } });
        return r!.returnData;
      }
      default:
        throw new Error(`fake node: unexpected ${method}`);
    }
  };
  const client = createPublicClient({ chain: spareChain, transport: custom({ request }, { retryCount: 0 }) }) as PublicClient;
  return { client, calls };
}
