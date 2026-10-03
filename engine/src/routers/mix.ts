/**
 * mix.get — the account's target mix (own, or the default it falls back to).
 * Setting a mix is the user's own ElectionRegistry.setMix transaction.
 */
import { desc, eq, or } from "drizzle-orm";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { publicProcedure, requireContracts, router } from "../trpc.ts";
import { readMix, type Leg } from "../chain/reads.ts";
import { assetRegistryAbi } from "../chain/abis.ts";
import { headBlock } from "../chain/blocks.ts";
import type { SpareAddresses } from "../chain/addresses.ts";
import { ZERO_ADDRESS } from "../chain/constants.ts";
import { AccountInput, lc } from "../lib/inputs.ts";
import { guard } from "../lib/result.ts";
import * as schema from "../db/schema.ts";

/** Symbol + current eligibility of each leg's asset, in one multicall. */
export async function describeLegs(client: PublicClient, a: SpareAddresses, legs: Leg[]) {
  if (!legs.length) return [];
  const r = (await client.multicall({
    allowFailure: true,
    contracts: legs.flatMap((l) => [
      { address: l.asset, abi: erc20Abi, functionName: "symbol" },
      { address: a.assetRegistry, abi: assetRegistryAbi, functionName: "isEligible", args: [l.asset] },
    ]) as never,
  })) as { status: string; result?: unknown }[];
  return legs.map((l, i) => ({
    asset: l.asset,
    symbol: r[i * 2]?.status === "success" ? (r[i * 2]!.result as string) : null,
    bps: l.bps,
    pct: l.bps / 100,
    /** false = deactivated in AssetRegistry since it was elected: a sweep safe-settles this leg to USDG. */
    active: r[i * 2 + 1]?.status === "success" ? (r[i * 2 + 1]!.result as boolean) : null,
  }));
}

export const mixRouter = router({
  get: publicProcedure.input(AccountInput).query(({ ctx, input }) =>
    guard("mix.get", async () => {
      const a = await requireContracts(ctx, ["electionRegistry", "assetRegistry"]);
      const [head, m] = await Promise.all([headBlock(ctx.client), readMix(ctx.client, a, input.account)]);
      const [legs, defaultLegs] = await Promise.all([
        describeLegs(ctx.client, a, m.mix),
        describeLegs(ctx.client, a, m.defaultMix),
      ]);
      const source = m.hasOwnMix ? ("own" as const) : m.defaultMix.length ? ("default" as const) : ("none" as const);

      const history = await guard("mix.get.history", async () => {
        const rows = await ctx.db
          .select()
          .from(schema.mixes)
          .where(or(eq(schema.mixes.account, lc(input.account)), eq(schema.mixes.account, ZERO_ADDRESS)))
          .orderBy(desc(schema.mixes.blockNumber), desc(schema.mixes.logIndex))
          .limit(50);
        return {
          available: true as const,
          rows: rows.map((r) => ({
            kind: r.kind,
            scope: r.account === ZERO_ADDRESS ? ("default" as const) : ("account" as const),
            legs: r.legs.map((l) => ({ asset: l.asset as Address, bps: l.bps })),
            blockNumber: r.blockNumber.toString(),
            blockTime: r.blockTime?.toISOString() ?? null,
            txHash: r.txHash,
          })),
        };
      });

      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        asOf: { head: head.toString(), timestamp: m.timestamp.toString() },
        /** own = the account elected a mix; default = it falls back to the owner's default; none = no sweep possible. */
        source,
        legs,
        defaultMix: defaultLegs,
        maxLegs: Number(m.maxLegs),
        inactiveLegs: legs.filter((l) => l.active === false).map((l) => l.asset),
        history,
      };
    }),
  ),
});
