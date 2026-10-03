/**
 * Swap-venue recognition for the keeper beyond the static VENUE list.
 *
 * A Uniswap v3 swap (SwapRouter02 or UniversalRouter) moves the wallet's USDG
 * straight into the POOL contract in the swap callback, so Transfer(from=W,
 * to=pool) looked like a payment and was rounded up. Pools are individual
 * contracts, so they are recognised here: a counterparty is a v3 pool when
 * the canonical factory's getPool(token0(), token1(), fee()) returns that
 * very address. A contract that merely claims pool tokens cannot pass (the
 * factory names the real pool), so a spoof can only cause under-accrual.
 *
 * Verified on 4663 (2026-09-30): v3Factory.getPool(USDG, WETH, 100) =
 * 0x52e65B17…71Ca, whose token0/token1/fee round-trip through the factory.
 */
import { parseAbi, type Address, type PublicClient } from "viem";
import { VENUE } from "../chain/constants.ts";
import { aggregate3 } from "./multicall.ts";

/**
 * Routers on 4663 that are not in chain/constants VENUE. A USDG transfer INTO
 * a router (UniversalRouter's PERMIT2_TRANSFER_FROM routes) is a swap input.
 * UniversalRouter 2.1.x: see src/lib/spare-chain/fund-swap.ts.
 */
export const KEEPER_EXTRA_VENUE: readonly Address[] = ["0x8876789976decbfcbbbe364623c63652db8c0904"];

const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);

const MAX_CACHE = 50_000;

export class V3PoolResolver {
  private readonly cache = new Map<string, boolean>();

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address = VENUE.v3Factory,
    /** Answers kept; the oldest is evicted first. */
    private readonly maxCache = MAX_CACHE,
  ) {}

  private remember(addr: string, isPool: boolean) {
    if (this.cache.size >= this.maxCache) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(addr, isPool);
  }

  /**
   * The subset of `addrs` (lower-cased) that are canonical v3 pools. An RPC
   * failure throws (nothing is cached), so the caller never prices a swap
   * as a payment because a lookup failed. `onCall` runs before every RPC call
   * (a scan budget charges it there, and may throw to stop the lookups).
   */
  async pools(addrs: Iterable<string>, onCall?: () => void): Promise<Set<string>> {
    const all = [...new Set([...addrs].map((a) => a.toLowerCase()))];
    const todo = all.filter((a) => !this.cache.has(a));
    for (let i = 0; i < todo.length; i += 60) {
      const slice = todo.slice(i, i + 60);
      onCall?.();
      // aggregate3 (multicall.ts): an RPC failure throws, so a failed lookup is never "not a pool".
      const ids = await aggregate3(
        this.client,
        slice.flatMap((a) => [
          { address: a as Address, abi: poolAbi, functionName: "token0" },
          { address: a as Address, abi: poolAbi, functionName: "token1" },
          { address: a as Address, abi: poolAbi, functionName: "fee" },
        ]),
      );
      const candidates: { addr: string; t0: Address; t1: Address; fee: number }[] = [];
      slice.forEach((addr, k) => {
        const [t0, t1, fee] = [ids[3 * k], ids[3 * k + 1], ids[3 * k + 2]];
        // A v3 fee is a uint24. A contract answering fee() with more cannot be a
        // factory pool (nor be encoded into getPool): not a pool, no lookup.
        const feeNum = fee?.ok ? Number(fee.value) : -1;
        if (t0?.ok && t1?.ok && Number.isInteger(feeNum) && feeNum >= 0 && feeNum <= 0xffffff) {
          candidates.push({ addr, t0: t0.value as Address, t1: t1.value as Address, fee: feeNum });
        } else {
          this.remember(addr, false); // EOA or not a pool: token0/token1/fee do not all answer
        }
      });
      if (!candidates.length) continue;
      onCall?.();
      const got = await aggregate3(
        this.client,
        candidates.map((c) => ({ address: this.factory, abi: factoryAbi, functionName: "getPool", args: [c.t0, c.t1, c.fee] })),
      );
      candidates.forEach((c, k) => {
        const r = got[k];
        this.remember(c.addr, r?.ok === true && (r.value as string).toLowerCase() === c.addr);
      });
    }
    return new Set(all.filter((a) => this.cache.get(a) === true));
  }
}
