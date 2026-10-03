import { eq, sql } from "drizzle-orm";
import { publicProcedure, type Context } from "../trpc.ts";
import { chainFor, chainState } from "../chain/client.ts";
import { verifiedContracts, REQUIRED_CONTRACTS } from "../chain/addresses.ts";
import { sweepExecutorAbi, cashParkAbi } from "../chain/abis.ts";
import { dbHealthy } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { bearerMatches } from "../keeper/health.ts";

export const SERVICE = "spare-engine";

async function timed<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/**
 * Health snapshot. Always resolves (never throws): the hosting platform's healthcheck must
 * see the process up even while a dependency is down, and each dependency's
 * state is reported rather than assumed.
 *
 * Public (`detailed` false): whether the chain, database, Redis and address
 * book are up. Detailed, for operators only: the keeper's address and its
 * registration, the verified deployment, and the database binding, Timescale
 * version, hypertables and indexing cursors.
 */
export async function healthSnapshot(ctx: Context, detailed = true) {
  const [chain, db, redis] = await Promise.all([
    timed(chainState(ctx.client, ctx.chainId), 6000, { expected: ctx.chainId, observed: null, checked: false, healthy: false }),
    timed(dbHealthy(ctx.sql), 6000, false),
    timed(ctx.redisHealthy(), 3000, false),
  ]);
  const head = chain.healthy ? await timed(ctx.client.getBlockNumber({ cacheTime: 0 }), 5000, null) : null;
  const book = ctx.book();

  const base = {
    ok: true as const,
    service: SERVICE,
    chain: {
      id: ctx.chainId,
      name: chainFor(ctx.chainId).name,
      rpc: chain.checked ? ("up" as const) : ("down" as const),
      observedId: chain.observed,
      idHealthy: chain.healthy,
      head: head === null ? null : head.toString(),
      finalityBuffer: ctx.finalityBuffer.toString(),
    },
    db: db ? ("up" as const) : ("down" as const),
    redis: redis ? ("up" as const) : ("down" as const),
    contracts: book.deployed
      ? { deployed: true as const, source: book.source, addresses: { ...book.addresses, deployBlock: book.addresses.deployBlock?.toString() ?? null } }
      : { deployed: false as const, source: book.source, reason: book.reason, missing: book.missing },
    ts: new Date().toISOString(),
  };
  if (!detailed) return base;
  const keeper = { configured: ctx.keeperAddress !== null, address: ctx.keeperAddress, broadcast: ctx.keeperBroadcast };

  // --- verified deployment + keeper registration (chain) --------------------
  let deployment: Record<string, unknown> | null = null;
  if (book.deployed && chain.healthy) {
    deployment = await timed<Record<string, unknown>>(
      (async (): Promise<Record<string, unknown>> => {
        const v = await verifiedContracts(ctx.client, book, REQUIRED_CONTRACTS);
        if (!v.ok) return { verified: false, reason: v.reason };
        const a = v.addresses;
        const reads = (await ctx.client.multicall({
          allowFailure: true,
          contracts: [
            { address: a.sweepExecutor, abi: sweepExecutorAbi, functionName: "paused" },
            { address: a.cashPark, abi: cashParkAbi, functionName: "paused" },
            ...(ctx.keeperAddress
              ? ([
                  { address: a.sweepExecutor, abi: sweepExecutorAbi, functionName: "isKeeper", args: [ctx.keeperAddress] },
                  { address: a.cashPark, abi: cashParkAbi, functionName: "isKeeper", args: [ctx.keeperAddress] },
                ] as const)
              : []),
          ] as never,
        })) as { status: string; result?: unknown }[];
        const ok = (i: number) => (reads[i]?.status === "success" ? (reads[i]!.result as boolean) : null);
        return {
          verified: true,
          executorPaused: ok(0),
          parkPaused: ok(1),
          keeperRegistered: ctx.keeperAddress ? { sweepExecutor: ok(2), cashPark: ok(3) } : null,
        };
      })(),
      8000,
      { verified: false, reason: "deployment check timed out" },
    );
  }

  // --- database: binding, timescale, cursors --------------------------------
  let database: Record<string, unknown> | null = null;
  if (db) {
    database = await timed<Record<string, unknown>>(
      (async (): Promise<Record<string, unknown>> => {
        const [binding] = await ctx.db.select().from(schema.chainBinding).where(eq(schema.chainBinding.id, 1));
        const ext = await ctx.db.execute(sql`select extversion from pg_extension where extname = 'timescaledb'`);
        const hypertables = await ctx.db
          .execute(sql`select hypertable_name from timescaledb_information.hypertables`)
          .then((r) => (r as unknown as { hypertable_name: string }[]).map((x) => x.hypertable_name))
          .catch(() => [] as string[]);
        const cursors = await ctx.db.select().from(schema.cursors).where(eq(schema.cursors.chainId, ctx.chainId));
        return {
          migrated: true,
          boundChainId: binding?.chainId ?? null,
          bindingHealthy: binding ? binding.chainId === ctx.chainId : null,
          timescale: (ext as unknown as { extversion: string }[])[0]?.extversion ?? null,
          hypertables,
          cursors: cursors.map((c) => ({
            name: c.name,
            startBlock: c.startBlock.toString(),
            lastBlock: c.lastBlock?.toString() ?? null,
            observedHead: c.observedHead?.toString() ?? null,
            lagBlocks: c.lastBlock !== null && c.observedHead !== null ? (c.observedHead - c.lastBlock).toString() : null,
            lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
            lastError: c.lastError,
          })),
        };
      })().catch((err: Error) => ({ migrated: false, reason: /does not exist/.test(err.message) ? "run `bun run db:migrate`" : "query failed" })),
      6000,
      { migrated: null, reason: "database check timed out" },
    );
  }

  return { ...base, keeper, deployment, database };
}

/** The detail is served only to a bearer of HEALTH_TOKEN, and to nobody while it is unset (as the keeper's /health). */
export function healthDetailAllowed(ctx: Pick<Context, "healthToken" | "authorization">): boolean {
  return Boolean(ctx.healthToken) && bearerMatches(ctx.authorization, ctx.healthToken!);
}

/** `health` — mounted as a top-level procedure on the AppRouter. */
export const healthProcedure = publicProcedure.query(({ ctx }) => healthSnapshot(ctx, healthDetailAllowed(ctx)));
