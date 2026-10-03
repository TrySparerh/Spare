/**
 * V3PoolResolver: a counterparty is a v3 pool only when the canonical factory
 * names that very address for the pool's own token0 / token1 / fee.
 */
import { describe, expect, test } from "bun:test";
import { createPublicClient, defineChain, getAddress, parseAbi, type PublicClient } from "viem";
import { MULTICALL3, USDG, VENUE } from "../../src/chain/constants.ts";
import { V3PoolResolver } from "../../src/keeper/venue.ts";
import { addr, SpareWorld } from "../helpers/fake-rpc-spare.ts";

const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");

function clientOf(w: SpareWorld): PublicClient {
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://fake"] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  return createPublicClient({ chain, transport: w.rpc.transport() }) as PublicClient;
}
const ethCalls = (w: SpareWorld) => w.rpc.count("eth_call");

describe("V3PoolResolver", () => {
  test("only an address the factory names for its own tokens and fee is a pool", async () => {
    const w = new SpareWorld();
    const pool = addr(0x9001);
    const spoof = addr(0x9002); // answers USDG/WETH/100, but the factory names `pool`
    const halfPool = addr(0x9003); // answers token0 only
    const otherFee = addr(0x9004); // a real pool of the same pair at another fee tier
    w.v3Pool(pool, USDG, WETH, 100);
    w.v3Pool(otherFee, USDG, WETH, 500);
    w.v3Pool(spoof, USDG, WETH, 100);
    w.v3Pools.delete(spoof.toLowerCase());
    w.rpc.contract(halfPool, parseAbi(["function token0() view returns (address)"]), { token0: () => USDG });
    const eoa = addr(0x3e7c4a7);
    const r = new V3PoolResolver(clientOf(w));
    const got = await r.pools([pool, spoof, halfPool, otherFee, eoa, pool.toLowerCase()]);
    expect([...got]).toEqual([pool.toLowerCase(), otherFee.toLowerCase()]);
    // Two multicalls: the three getters of every address, then getPool for the three that answered all of them.
    expect(ethCalls(w)).toBe(2);
    expect(w.rpc.callsTo("getPool").map((c) => [c.to, ...c.args])).toEqual([
      [VENUE.v3Factory, USDG, WETH, 100], // pool
      [VENUE.v3Factory, USDG, WETH, 100], // spoof
      [VENUE.v3Factory, USDG, WETH, 500], // otherFee
    ]);
  });

  test("answers are cached: a known address costs no RPC call, and a lookup with nothing new makes none", async () => {
    const w = new SpareWorld();
    const pool = addr(0x9001);
    w.v3Pool(pool, USDG, WETH, 100);
    const r = new V3PoolResolver(clientOf(w));
    await r.pools([pool, addr(0x77)]);
    const n = ethCalls(w);
    const charged: number[] = [];
    expect([...(await r.pools([addr(0x77), pool], () => charged.push(1)))]).toEqual([pool.toLowerCase()]);
    expect(ethCalls(w)).toBe(n);
    expect(charged).toHaveLength(0);
  });

  test("every RPC call is charged to onCall first, 60 addresses per multicall; a throwing onCall stops the lookups", async () => {
    const w = new SpareWorld();
    w.v3Pool(addr(0x9001), USDG, WETH, 100);
    const many = [addr(0x9001), ...Array.from({ length: 60 }, (_, i) => addr(0x50000 + i))];
    const r = new V3PoolResolver(clientOf(w));
    let charged = 0;
    await r.pools(many, () => void charged++);
    expect(charged).toBe(3); // 2 getter multicalls (60 + 1) + 1 factory multicall
    expect(ethCalls(w)).toBe(3);
    expect(w.rpc.callsTo("token0").length).toBe(1);

    const r2 = new V3PoolResolver(clientOf(w));
    let n = 0;
    const budget = () => {
      if (++n > 1) throw new Error("scan budget spent: 1/1 RPC calls");
    };
    await expect(r2.pools([addr(0x9001)], budget)).rejects.toThrow("scan budget spent");
    // Nothing was decided about the pool: asked again with room, it is looked up and found.
    expect([...(await r2.pools([addr(0x9001)]))]).toEqual([addr(0x9001).toLowerCase()]);
  });

  test("the cache is bounded: the oldest answer is evicted first", async () => {
    const w = new SpareWorld();
    const r = new V3PoolResolver(clientOf(w), getAddress(VENUE.v3Factory), 3);
    await r.pools([addr(0x71), addr(0x72), addr(0x73)]);
    const n = ethCalls(w);
    await r.pools([addr(0x73), addr(0x71)]);
    expect(ethCalls(w)).toBe(n); // all cached
    await r.pools([addr(0x74)]); // the 4th answer evicts the oldest (0x71)
    await r.pools([addr(0x72), addr(0x73), addr(0x74)]);
    expect(ethCalls(w)).toBe(n + 1);
    await r.pools([addr(0x71)]);
    expect(ethCalls(w)).toBe(n + 2);
  });
});
