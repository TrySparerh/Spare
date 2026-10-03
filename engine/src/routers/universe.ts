/**
 * universe.list — the eligible universe: every AssetRegistry asset with its
 * pool (the venue allowlist), oracle verdict and ERC-8056 multiplier state,
 * joined with Robinhood's own listing (the `universe` table, which the planned
 * universe-refresher worker would fill; empty until it exists).
 *
 * The registry is owner-curated and fail-closed; `proposals` are the changes
 * the refresher would suggest to the contract owner. The engine never writes
 * the registry.
 */
import { and, eq } from "drizzle-orm";
import { encodeAbiParameters, keccak256, type Address } from "viem";
import { publicProcedure, requireContracts, router } from "../trpc.ts";
import { readRegistry, type RegistryAsset } from "../chain/reads.ts";
import { headBlock } from "../chain/blocks.ts";
import { guard } from "../lib/result.ts";
import { amount } from "../lib/units.ts";
import { isDeferrable, oracleStatusName, STALENESS_GRACE } from "../lib/oracle.ts";
import * as schema from "../db/schema.ts";

/** v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function poolId(k: RegistryAsset["poolKey"]): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

export const universeRouter = router({
  list: publicProcedure.query(({ ctx }) =>
    guard("universe.list", async () => {
      const a = await requireContracts(ctx, ["assetRegistry", "stockRouter"]);
      const [head, reg] = await Promise.all([headBlock(ctx.client), readRegistry(ctx.client, a)]);

      const listed = await guard("universe.list.listed", async () => {
        const rows = await ctx.db.select().from(schema.universe).where(eq(schema.universe.chainId, ctx.chainId));
        return { available: true as const, rows };
      });
      const byToken = new Map(listed.available ? listed.rows.map((r) => [r.token.toLowerCase(), r]) : []);

      const assets = reg.assets.map((x) => {
        const age = x.feedRound ? reg.timestamp - x.feedRound.updatedAt : null;
        const rh = byToken.get(x.token.toLowerCase()) ?? null;
        return {
          token: x.token,
          symbol: x.symbol,
          name: x.name,
          decimals: x.decimals,
          active: x.active,
          heartbeatSeconds: x.heartbeat,
          bandBps: x.bandBps,
          pool: { ...x.poolKey, poolId: poolId(x.poolKey), hooked: x.poolKey.hooks.toLowerCase() !== "0x0000000000000000000000000000000000000000" },
          oracle: {
            status: oracleStatusName(x.oracle.status),
            deferrable: isDeferrable(x.oracle.status),
            /** USD per token, 1e18 — only when the router says OK. */
            price: x.oracle.status === 0 ? amount(x.oracle.price1e18, 18) : null,
          },
          feed: {
            address: x.feed,
            decimals: x.feedDecimals,
            answer: x.feedRound ? amount(x.feedRound.answer, x.feedDecimals) : null,
            updatedAt: x.feedRound ? new Date(Number(x.feedRound.updatedAt) * 1000).toISOString() : null,
            ageSeconds: age === null ? null : Number(age),
            staleAfterSeconds: x.heartbeat + Number(STALENESS_GRACE),
          },
          token8056: {
            uiMultiplier: x.token8056.uiMultiplier === null ? null : amount(x.token8056.uiMultiplier, 18),
            newUIMultiplier: x.token8056.newUIMultiplier === null ? null : amount(x.token8056.newUIMultiplier, 18),
            effectiveAt: x.token8056.effectiveAt ? new Date(Number(x.token8056.effectiveAt) * 1000).toISOString() : null,
            paused: x.token8056.paused,
            oraclePaused: x.token8056.oraclePaused,
          },
          robinhood: rh
            ? {
                symbol: rh.symbol,
                name: rh.name,
                status: rh.status,
                currentMultiplier: rh.currentMultiplier,
                pendingMultiplier: rh.pendingMultiplier || null,
                tradingCapabilities: rh.tradingCapabilities,
                logoUrl: rh.logoUrl,
                fetchedAt: rh.fetchedAt.toISOString(),
              }
            : null,
        };
      });

      const registered = new Set(reg.assets.map((x) => x.token.toLowerCase()));
      return {
        available: true as const,
        chainId: ctx.chainId,
        asOf: { head: head.toString(), timestamp: reg.timestamp.toString() },
        sequencerFeed: reg.sequencerFeed,
        assets,
        /** Robinhood listing rows the refresher proposes changes for (owner review). */
        proposals: listed.available
          ? listed.rows
              .filter((r) => r.proposal !== null)
              .map((r) => ({ token: r.token as Address, symbol: r.symbol, registered: registered.has(r.token.toLowerCase()), proposal: r.proposal }))
          : listed,
        listedCount: listed.available ? listed.rows.length : null,
      };
    }),
  ),
});
