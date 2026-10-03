/**
 * The keeper's batched reads: Multicall3.aggregate3 in one eth_call.
 *
 * A call that reverts, returns no data or does not decode is a failure of
 * that call alone; an eth_call that fails (timeout, 429, node error) THROWS.
 * viem's `multicall` with allowFailure reports a failed eth_call as every
 * call in it failing, the same answer as a block where every contract
 * reverted: a pool lookup read "not a pool" (venue.ts) and an account read
 * looked complete while it had seen nothing (keeper.ts prunes scan state on a
 * complete read). A call that cannot even be encoded fails alone and is not
 * sent, as with viem's multicall.
 */
import { decodeFunctionResult, encodeFunctionData, multicall3Abi, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { MULTICALL3 } from "../chain/constants.ts";

export type Read = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
export type Got = { ok: true; value: unknown } | { ok: false };

export async function aggregate3(client: PublicClient, calls: readonly Read[], blockNumber?: bigint): Promise<Got[]> {
  const data = calls.map((c): Hex | null => {
    try {
      return encodeFunctionData(c as never);
    } catch {
      return null;
    }
  });
  const sent = calls.flatMap((c, i) => (data[i] ? [{ target: c.address, allowFailure: true, callData: data[i]! }] : []));
  const res = sent.length
    ? await client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [sent],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      })
    : [];
  let k = 0;
  return calls.map((c, i): Got => {
    if (!data[i]) return { ok: false };
    const r = res[k++];
    if (!r?.success || r.returnData === "0x") return { ok: false };
    try {
      return { ok: true, value: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, args: c.args, data: r.returnData } as never) };
    } catch {
      return { ok: false };
    }
  });
}
