/**
 * The keeper's batched read (multicall.ts aggregate3): a revert fails its own
 * call, an eth_call that fails at the RPC throws. viem's multicall with
 * allowFailure answered both the same way, so a node blip read like a block
 * where every contract reverted.
 */
import { describe, expect, test } from "bun:test";
import { createPublicClient, defineChain, parseAbi, type PublicClient } from "viem";
import { MULTICALL3 } from "../../src/chain/constants.ts";
import { aggregate3, type Read } from "../../src/keeper/multicall.ts";
import { FakeRpc, Revert, rpcError } from "../helpers/fake-rpc.ts";
import { addr } from "../helpers/fake-rpc-spare.ts";

const abi = parseAbi([
  "function get(uint256) view returns (uint256)",
  "function pair() view returns (uint256, address)",
  "function small(uint8) view returns (uint8)",
]);
const C = addr(0xc0de);
const EOA = addr(0xe0a);

function setup() {
  const rpc = new FakeRpc();
  rpc.contract(C, abi, {
    get: ([n]) => {
      if (n === 13n) throw new Revert("0x");
      return n * 2n;
    },
    pair: () => [7n, EOA],
    small: ([n]) => n,
  });
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://fake"] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  return { rpc, client: createPublicClient({ chain, transport: rpc.transport() }) as PublicClient };
}
const get = (n: bigint, address = C): Read => ({ address, abi, functionName: "get", args: [n] });

describe("aggregate3", () => {
  test("one eth_call; each call decoded, a revert or an empty answer (an EOA) fails alone", async () => {
    const { rpc, client } = setup();
    const got = await aggregate3(client, [get(2n), get(13n), get(5n, EOA), { address: C, abi, functionName: "pair" }]);
    expect(got).toEqual([{ ok: true, value: 4n }, { ok: false }, { ok: false }, { ok: true, value: [7n, EOA] }]);
    expect(rpc.count("eth_call")).toBe(1);
  });

  test("an eth_call that fails at the RPC throws: never every call 'reverted'", async () => {
    const { rpc, client } = setup();
    rpc.use((method) => {
      if (method === "eth_call") throw rpcError(-32000, "upstream unavailable");
    });
    await expect(aggregate3(client, [get(2n), get(3n)])).rejects.toThrow();
  });

  test("a call that cannot be encoded fails alone and is not sent", async () => {
    const { rpc, client } = setup();
    const got = await aggregate3(client, [get(2n), { address: C, abi, functionName: "small", args: [256] }, get(4n)]);
    expect(got).toEqual([{ ok: true, value: 4n }, { ok: false }, { ok: true, value: 8n }]);
    expect(rpc.callsTo("small")).toHaveLength(0);
    expect(await aggregate3(client, [{ address: C, abi, functionName: "small", args: [-1] }])).toEqual([{ ok: false }]);
    expect(rpc.count("eth_call")).toBe(1); // nothing to send: no eth_call
  });

  test("the read is pinned to `blockNumber`", async () => {
    const { rpc, client } = setup();
    await aggregate3(client, [get(2n)], 990n);
    await aggregate3(client, [get(2n)]);
    expect(rpc.callsTo("get").map((c) => c.block)).toEqual([990n, rpc.head]);
  });
});
