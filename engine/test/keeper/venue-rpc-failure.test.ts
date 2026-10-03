/**
 * A pool lookup that fails at the RPC must never be read as "not a pool":
 * that prices a Uniswap v3 swap as a payment (a round-up pulled for a swap)
 * and caches the wrong answer for the life of the process.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createPublicClient, defineChain, getAddress, type PublicClient } from "viem";
import { MULTICALL3, USDG, VENUE } from "../../src/chain/constants.ts";
import { V3PoolResolver } from "../../src/keeper/venue.ts";
import { rpcError } from "../helpers/fake-rpc.ts";
import { addr, captureLogs, keeperOn, SpareWorld, usd, type Entry } from "../helpers/fake-rpc-spare.ts";

const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const A = addr(0xa11ce);
const W1 = addr(0x1001);
const M = addr(0x3e7c4a7);
const P = addr(0x9001);

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  setSystemTime();
});

/** Every eth_call that carries a v3 getter (token0()) or the factory fails like a throttled node, while `on`. */
function throttlePoolLookups(w: SpareWorld): { off: () => void } {
  let on = true;
  w.rpc.use((method, [tx]) => {
    if (!on || method !== "eth_call" || tx.to.toLowerCase() !== MULTICALL3.toLowerCase()) return;
    if (tx.data.includes("0dfe1681") || tx.data.includes(VENUE.v3Factory.slice(2))) throw rpcError(429, "Too Many Requests");
  });
  return { off: () => void (on = false) };
}

describe("v3 pool lookups that fail at the RPC", () => {
  test("V3PoolResolver.pools throws and caches nothing", async () => {
    const w = new SpareWorld();
    w.v3Pool(P, USDG, WETH, 100);
    const chain = defineChain({
      id: 4663,
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["http://fake"] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    });
    const r = new V3PoolResolver(createPublicClient({ chain, transport: w.rpc.transport() }) as PublicClient);
    const t = throttlePoolLookups(w);
    await expect(r.pools([P])).rejects.toThrow();
    t.off();
    expect([...(await r.pools([P]))]).toEqual([P.toLowerCase()]);
  });

  test("the keeper never prices a v3 swap as a payment because a lookup failed", async () => {
    const w = new SpareWorld();
    w.enroll(A, [W1]);
    w.v3Pool(P, USDG, WETH, 100);
    w.pay(W1, P, usd(4.3), 3_000n); // a swap: USDG into the pool
    w.pay(W1, M, usd(4.3), 3_001n); // a payment: $0.70
    const t = throttlePoolLookups(w);
    const k = keeperOn(w);
    await k.accrueTick();
    expect(w.rpc.sent).toHaveLength(0);
    expect(logs.has(`${W1} backed off 5m (1x): scan: `)).toBe(true);

    t.off();
    setSystemTime(Date.now() + 301_000);
    await k.accrueTick();
    expect(w.rpc.sent[0]!.args[0] as Entry[]).toEqual([{ account: A, wallet: W1, amount: usd(0.7), toBlock: 199_880n }]);
  });
});

