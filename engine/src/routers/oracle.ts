/**
 * oracle.status — every price SPARE depends on, and whether a sweep may use it.
 *
 * Rows: every AssetRegistry asset's own feed (read live — the registry, not a
 * list in this file, decides which stocks exist), then the reference feeds
 * (USDG / USD, ETH / USD). Before SPARE is deployed the constants' feed list
 * stands in, display-only.
 *
 * Sources, in order of authority:
 *   router        StockRouter.oracleStatus — the on-chain OracleGuard verdict a
 *                 sweep will actually get (registry assets, once deployed).
 *   engine-mirror lib/oracle.ts mirror of OracleGuard over the raw feed + token
 *                 flags, for the verified RHC feeds when no router is deployed.
 * Stock feeds are 24/5: a weekend STALE is normal and means DEFER, not failure.
 */
import { desc, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { publicProcedure, requireChain, router } from "../trpc.ts";
import { readFeeds, readRegistry } from "../chain/reads.ts";
import { stockTokenAbi } from "../chain/abis.ts";
import { verifiedContracts } from "../chain/addresses.ts";
import { headBlock } from "../chain/blocks.ts";
import { FEEDS, FEED_HEARTBEAT_SECONDS, type Hours } from "../chain/constants.ts";
import { guard, unavailable } from "../lib/result.ts";
import { amount } from "../lib/units.ts";
import { isDeferrable, mirrorOracleGuard, oracleStatusName, STALENESS_GRACE } from "../lib/oracle.ts";
import * as schema from "../db/schema.ts";

export const oracleRouter = router({
  status: publicProcedure.query(({ ctx }) =>
    guard("oracle.status", async () => {
      await requireChain(ctx);
      const head = await headBlock(ctx.client);
      const book = ctx.book();

      // Registry verdicts, when SPARE is deployed.
      let registry: Awaited<ReturnType<typeof readRegistry>> | null = null;
      let registryState: { available: true } | ReturnType<typeof unavailable>;
      if (book.deployed) {
        const v = await verifiedContracts(ctx.client, book, ["assetRegistry", "stockRouter"]);
        if (v.ok) {
          registry = await readRegistry(ctx.client, v.addresses);
          registryState = { available: true };
        } else registryState = unavailable("not_deployed", v.reason);
      } else registryState = unavailable("not_deployed", book.reason);

      // The feeds to show: each registry asset's own, then the reference feeds.
      type FeedRow = { label: string; feed: Address; token: Address | null; hours: Hours };
      const list: readonly FeedRow[] = registry
        ? [
            ...registry.assets.map((x) => ({ label: `${x.symbol ?? x.token} / USD`, feed: x.feed, token: x.token, hours: "us_equities_24_5" as Hours })),
            // Known feeds the registry doesn't price (reference feeds; unregistered launch feeds, engine-mirror only).
            ...FEEDS.filter((f) => !registry!.assets.some((x) => x.feed.toLowerCase() === f.feed.toLowerCase())),
          ]
        : FEEDS;

      // Raw rounds for those feeds + token pause flags (one pass each).
      const feeds = await readFeeds(ctx.client, list.map((f) => f.feed));
      const flagTokens = list.filter((f) => f.token).map((f) => f.token as Address);
      const flags = (await ctx.client.multicall({
        allowFailure: true,
        contracts: flagTokens.flatMap((t) => [
          { address: t, abi: stockTokenAbi, functionName: "paused" },
          { address: t, abi: stockTokenAbi, functionName: "oraclePaused" },
        ]) as never,
      })) as { status: string; result?: unknown }[];
      const flagOf = (t: Address) => {
        const i = flagTokens.findIndex((x) => x.toLowerCase() === t.toLowerCase());
        const b = (r?: { status: string; result?: unknown }) => (r?.status === "success" ? (r.result as boolean) : null);
        return i < 0 ? { paused: null, oraclePaused: null } : { paused: b(flags[i * 2]), oraclePaused: b(flags[i * 2 + 1]) };
      };

      const now = feeds.timestamp;
      type Row = {
        label: string;
        feed: Address;
        token: Address | null;
        symbol: string | null;
        hours: Hours | "registry";
        decimals: number | null;
        answer: ReturnType<typeof amount> | null;
        updatedAt: string | null;
        ageSeconds: number | null;
        heartbeatSeconds: number;
        stale: boolean | null;
        verdict: { source: "router" | "engine-mirror" | "none"; status: string; deferrable: boolean; price: ReturnType<typeof amount> | null };
        registry: { active: boolean; bandBps: number } | null;
      };
      const rows: Row[] = list.map((f, i) => {
        const round = feeds.rounds[i] ?? null;
        const reg = registry?.assets.find((x) => f.token && x.token.toLowerCase() === f.token.toLowerCase()) ?? null;
        const heartbeat = reg ? reg.heartbeat : FEED_HEARTBEAT_SECONDS;
        const age = round ? now - round.updatedAt : null;
        let verdict: Row["verdict"];
        if (reg) {
          verdict = {
            source: "router",
            status: oracleStatusName(reg.oracle.status),
            deferrable: isDeferrable(reg.oracle.status),
            price: reg.oracle.status === 0 ? amount(reg.oracle.price1e18, 18) : null,
          };
        } else if (round && f.token) {
          const code = mirrorOracleGuard({
            answer: round.answer,
            updatedAt: round.updatedAt,
            heartbeat: BigInt(heartbeat),
            now,
            ...flagOf(f.token),
          });
          verdict = {
            source: "engine-mirror",
            status: oracleStatusName(code),
            deferrable: isDeferrable(code),
            price: code === 0 ? amount(round.answer * 10n ** BigInt(18 - round.decimals), 18) : null,
          };
        } else {
          verdict = { source: "none", status: round ? "N/A" : "UNREADABLE", deferrable: false, price: null };
        }
        return {
          label: f.label,
          feed: f.feed,
          token: f.token,
          symbol: reg?.symbol ?? (f.token ? f.label.split(" ")[0]! : null),
          hours: f.hours,
          decimals: round?.decimals ?? null,
          answer: round ? amount(round.answer, round.decimals) : null,
          updatedAt: round ? new Date(Number(round.updatedAt) * 1000).toISOString() : null,
          ageSeconds: age === null ? null : Number(age),
          heartbeatSeconds: heartbeat,
          stale: age === null ? null : age > BigInt(heartbeat) + STALENESS_GRACE,
          verdict,
          registry: reg ? { active: reg.active, bandBps: reg.bandBps } : null,
        };
      });


      const snapshots = await guard("oracle.status.snapshots", async () => {
        const last = await ctx.db
          .select({ feed: schema.oracleSnapshots.feed, at: sql<Date>`max(${schema.oracleSnapshots.observedAt})` })
          .from(schema.oracleSnapshots)
          .where(eq(schema.oracleSnapshots.chainId, ctx.chainId))
          .groupBy(schema.oracleSnapshots.feed)
          .orderBy(desc(sql`max(${schema.oracleSnapshots.observedAt})`));
        return {
          available: true as const,
          lastObserved: last.map((l) => ({ feed: l.feed as Address, at: new Date(l.at).toISOString() })),
        };
      });

      return {
        available: true as const,
        chainId: ctx.chainId,
        asOf: { head: head.toString(), timestamp: now.toString() },
        sequencer: {
          feed: registry?.sequencerFeed ?? null,
          note: "No L2 sequencer-uptime feed is published for Robinhood Chain; the router's sequencer check is off (address(0)) until one is.",
        },
        registry: registryState,
        feeds: rows,
        snapshots,
      };
    }),
  ),
});
