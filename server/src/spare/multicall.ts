/**
 * Batched reads: Multicall3.aggregate3 through readContract, as the keeper
 * does (engine/src/keeper/multicall.ts).
 *
 * A call that reverts, returns no data or does not decode is a failure of
 * that call alone; an eth_call that fails (timeout, 429, node error) THROWS,
 * so the read fails (a redacted 502 on the REST mirror). viem's `multicall`
 * with allowFailure reported a failed eth_call as every call in it failing,
 * the same answer as a block where every contract reverted: the API then
 * printed defaults (oracle BAD_ANSWER, empty mix, $0 parked) as if read. A
 * call that cannot even be encoded fails alone and is not sent, as with
 * viem's multicall.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  multicall3Abi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/**
 * Multicall3, at the same address on every chain (deployed on RHC). Defined
 * here, with no Spare imports, so assets.ts (which book.ts imports) can batch.
 */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * A single readContract / simulateContract error that is the CONTRACT's
 * answer (it reverted, or returned nothing), not the RPC failing. viem
 * classifies the node's reply: a revert (JSON-RPC code 3, or -32603 with
 * revert data) is ContractFunctionRevertedError; a timeout, 429 or node
 * error stays an HTTP / RPC error and is not a revert.
 */
export function isRevert(err: unknown): boolean {
  return err instanceof BaseError && !!err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
}

export type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
/** One call's answer. `error` names a per-call failure (a revert); it never carries RPC text. */
export type Res = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Calls per aggregate3 eth_call. Bounds one request's calldata and gas (a
 * universe read is ~350 calls); the chunks go out together and the
 * transport's JSON-RPC batching sends them as one HTTP request.
 */
export const AGGREGATE3_CHUNK = 100;

/** A failed call's revert, in one short line: Error(string) / Panic decoded, else its selector. */
function revertOf(abi: Abi, data: Hex): string {
  if (data === '0x') return 'reverted';
  try {
    const e = decodeErrorResult({ abi, data });
    return e.args?.length ? `${e.errorName}(${e.args.map(String).join(', ')})`.slice(0, 120) : e.errorName;
  } catch {
    return `reverted (${data.slice(0, 10)})`;
  }
}

export async function aggregate3(client: PublicClient, calls: readonly Call[], blockNumber?: bigint): Promise<Res[]> {
  if (calls.length === 0) return [];
  const data = calls.map((c): Hex | null => {
    try {
      return encodeFunctionData(c as never);
    } catch {
      return null;
    }
  });
  const sent = calls.flatMap((c, i) => (data[i] ? [{ target: c.address, allowFailure: true, callData: data[i]! }] : []));
  const chunks: (typeof sent)[] = [];
  for (let i = 0; i < sent.length; i += AGGREGATE3_CHUNK) chunks.push(sent.slice(i, i + AGGREGATE3_CHUNK));
  // Any chunk's eth_call failing fails the read: never half a snapshot.
  const answers = (
    await Promise.all(
      chunks.map((chunk) =>
        client.readContract({
          address: MULTICALL3,
          abi: multicall3Abi,
          functionName: 'aggregate3',
          args: [chunk],
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        }),
      ),
    )
  ).flat();
  let k = 0;
  return calls.map((c, i): Res => {
    if (!data[i]) return { ok: false, error: 'call not encodable' };
    const r = answers[k++];
    if (!r) return { ok: false, error: 'no answer' };
    if (!r.success) return { ok: false, error: revertOf(c.abi, r.returnData) };
    if (r.returnData === '0x') return { ok: false, error: 'no data (no contract at the address?)' };
    try {
      return { ok: true, value: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, args: c.args, data: r.returnData } as never) };
    } catch {
      return { ok: false, error: 'result does not decode' };
    }
  });
}
