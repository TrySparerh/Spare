/**
 * park.state — where idle spare waits: the CashPark adapter, whether its NAV
 * is fresh (law 4: stale NAV holds accrual un-parked, never blocks sweeps),
 * and the NAV itself. Optionally one account's position.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Address } from "viem";
import { publicProcedure, requireContracts, router } from "../trpc.ts";
import { readPark } from "../chain/reads.ts";
import { assetRegistryAbi, aggregatorV3Abi, cashParkAbi, stockRouterAbi } from "../chain/abis.ts";
import { headBlock } from "../chain/blocks.ts";
import { AddressInput } from "../lib/inputs.ts";
import { guard } from "../lib/result.ts";
import { amount, toBigInt, usdg } from "../lib/units.ts";
import { oracleStatusName } from "../lib/oracle.ts";
import * as schema from "../db/schema.ts";

export const ParkInput = z.object({ account: AddressInput.optional() }).default({});

export const parkRouter = router({
  state: publicProcedure.input(ParkInput).query(({ ctx, input }) =>
    guard("park.state", async () => {
      const a = await requireContracts(ctx, ["cashPark", "assetRegistry", "stockRouter"]);
      const [head, park] = await Promise.all([headBlock(ctx.client), readPark(ctx.client, a)]);

      const kind = !park.adapter
        ? ("none" as const)
        : a.usdgParkAdapter && park.adapter.toLowerCase() === a.usdgParkAdapter.toLowerCase()
          ? ("usdg" as const)
          : a.sgovParkAdapter && park.adapter.toLowerCase() === a.sgovParkAdapter.toLowerCase()
            ? ("sgov" as const)
            : ("unlisted" as const);

      // If the underlying is a registry asset (SGOV), report its oracle + feed.
      let oracle: Record<string, unknown> | null = null;
      if (park.underlying) {
        const r = (await ctx.client.multicall({
          allowFailure: true,
          contracts: [
            { address: a.assetRegistry, abi: assetRegistryAbi, functionName: "isRegistered", args: [park.underlying] },
            { address: a.stockRouter, abi: stockRouterAbi, functionName: "oracleStatus", args: [park.underlying] },
            { address: a.assetRegistry, abi: assetRegistryAbi, functionName: "get", args: [park.underlying] },
          ],
        })) as { status: string; result?: unknown }[];
        if (r[0]?.status === "success" && r[0].result === true && r[2]?.status === "success") {
          const asset = r[2].result as { feed: Address; heartbeat: number };
          const os = r[1]?.status === "success" ? (r[1].result as readonly [number, bigint]) : null;
          const round = await ctx.client
            .readContract({ address: asset.feed, abi: aggregatorV3Abi, functionName: "latestRoundData" })
            .catch(() => null);
          oracle = {
            feed: asset.feed,
            status: os ? oracleStatusName(Number(os[0])) : "UNREADABLE",
            price: os && Number(os[0]) === 0 ? amount(os[1], 18) : null,
            feedAnswer: round ? amount(round[1], 8) : null,
            feedUpdatedAt: round ? new Date(Number(round[3]) * 1000).toISOString() : null,
            feedAgeSeconds: round ? Number(park.timestamp - round[3]) : null,
            heartbeatSeconds: Number(asset.heartbeat),
          };
        }
      }

      let account: Record<string, unknown> | null = null;
      if (input.account) {
        const [pending, units, value] = await ctx.client.multicall({
          allowFailure: false,
          contracts: [
            { address: a.cashPark, abi: cashParkAbi, functionName: "pending", args: [input.account] },
            { address: a.cashPark, abi: cashParkAbi, functionName: "units", args: [input.account] },
            { address: a.cashPark, abi: cashParkAbi, functionName: "valueOf", args: [input.account] },
          ],
        });
        account = {
          account: input.account,
          pending: usdg(pending),
          units: amount(units, park.underlyingDecimals ?? 0),
          value: usdg(value),
        };
      }

      const history = park.underlying
        ? await guard("park.state.history", async () => {
            const rows = await ctx.db
              .select()
              .from(schema.oracleSnapshots)
              .where(and(eq(schema.oracleSnapshots.chainId, ctx.chainId), eq(schema.oracleSnapshots.asset, park.underlying!.toLowerCase())))
              .orderBy(desc(schema.oracleSnapshots.observedAt))
              .limit(96);
            return {
              available: true as const,
              rows: rows.map((s) => ({
                observedAt: s.observedAt.toISOString(),
                answer: s.answer === null ? null : amount(toBigInt(s.answer), s.decimals),
                updatedAt: s.updatedAt?.toISOString() ?? null,
                status: s.status === null ? null : oracleStatusName(s.status),
              })),
            };
          })
        : null;

      const unitDecimals = park.underlyingDecimals;
      return {
        available: true as const,
        chainId: ctx.chainId,
        asOf: { head: head.toString(), timestamp: park.timestamp.toString() },
        adapter: park.adapter,
        kind,
        underlying: park.underlying,
        underlyingSymbol: park.underlyingSymbol,
        /** null = the adapter's freshness could not be read. */
        isFresh: park.isFresh,
        paused: park.paused,
        nav: {
          /** USDG value of one whole underlying unit, from the adapter's own valueOf. */
          perUnit: park.navPerUnit === null ? null : usdg(park.navPerUnit),
          source:
            kind === "usdg"
              ? "identity: 1 unit = 1 USDG base unit (UsdgParkAdapter)"
              : kind === "sgov"
                ? "SGOV / USD Chainlink feed via SgovParkAdapter.valueOf (latest answer, even when stale — display only)"
                : "adapter valueOf",
        },
        totals: {
          pending: usdg(park.totalPending),
          units: unitDecimals === null ? { raw: park.totalUnits.toString(), decimals: null, display: null } : amount(park.totalUnits, unitDecimals),
          parkedValue: park.parkedValue === null ? null : usdg(park.parkedValue),
        },
        oracle,
        account,
        history,
      };
    }),
  ),
});
