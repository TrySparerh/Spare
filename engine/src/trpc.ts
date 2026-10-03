import { initTRPC } from "@trpc/server";
import type postgres from "postgres";
import type { Address, PublicClient } from "viem";
import { env, type SupportedChainId } from "./env.ts";
import { redisHealthy } from "./redis.ts";
import { broadcastEnabled, keeperAddress } from "./chain/keeper.ts";
import { getDb, getSql, type Db } from "./db/client.ts";
import { getPublicClient, chainState } from "./chain/client.ts";
import { addressBook, verifiedContracts, type AddressBook, type ContractKey, type SpareAddresses } from "./chain/addresses.ts";
import { UnavailableError } from "./lib/result.ts";
import { Gate, KeyedGate } from "./lib/gate.ts";

/**
 * Everything a router touches comes through the context, so tests (and a
 * second chain profile) can hand in their own database, RPC client and address
 * book without monkey-patching module state.
 */
export interface Context {
  chainId: SupportedChainId;
  client: PublicClient;
  db: Db;
  sql: postgres.Sql;
  book: () => AddressBook;
  /** L2 blocks a range must trail the head by (SweepExecutor.finalityBuffer). */
  finalityBuffer: bigint;
  logsMaxRange: bigint;
  /** rule.preview's per-REQUEST ceilings (all wallets): getLogs calls, transfers held, ms. */
  previewMaxChunks: number;
  previewMaxLogs: number;
  previewTimeoutMs: number;
  /** Engine-wide limit on rule.previews running at once (shared by every request). */
  previewGate: Gate;
  /** Per-client limit on rule.previews running at once, keyed by `clientKey`. */
  previewClientGate: KeyedGate;
  /** The caller's rate-limit key (IPv4 address or IPv6 /64), as the HTTP limiter computed it. */
  clientKey: string;
  /** Next run of a BullMQ job scheduler, if Redis and the scheduler exist. */
  schedulerNextRun: (queue: string) => Promise<Date | null>;
  redisHealthy: () => Promise<boolean>;
  /** The keeper's public address (KEEPER_ADDRESS); this process holds no key. */
  keeperAddress: Address | null;
  keeperBroadcast: boolean;
  /** HEALTH_TOKEN: unset, the `health` procedure never serves its detail. */
  healthToken?: string;
  /** The request's Authorization header, if any (the `health` detail needs the bearer token). */
  authorization: string | null;
}

/** What createContext takes from the HTTP request (app.ts). */
export interface RequestInfo {
  clientKey: string;
  authorization: string | null;
}

// One of each gate per process: createContext runs per request.
const previewGate = new Gate(env.PREVIEW_MAX_INFLIGHT);
const previewClientGate = new KeyedGate(env.PREVIEW_MAX_INFLIGHT_PER_CLIENT);

export function createContext(req: RequestInfo = { clientKey: "unknown", authorization: null }): Context {
  return {
    chainId: env.CHAIN_ID,
    client: getPublicClient(),
    db: getDb(),
    sql: getSql(),
    book: addressBook,
    finalityBuffer: BigInt(env.FINALITY_BUFFER),
    logsMaxRange: BigInt(env.LOGS_MAX_RANGE),
    previewMaxChunks: env.PREVIEW_MAX_CHUNKS,
    previewMaxLogs: env.PREVIEW_MAX_LOGS,
    previewTimeoutMs: env.PREVIEW_TIMEOUT_MS,
    previewGate,
    previewClientGate,
    clientKey: req.clientKey,
    schedulerNextRun: async (queue) => {
      // Imported lazily so the API never opens a BullMQ connection unless asked.
      const { schedulerNextRun } = await import("./workers/queues.ts");
      return schedulerNextRun(queue);
    },
    redisHealthy,
    keeperAddress: keeperAddress(),
    keeperBroadcast: broadcastEnabled(),
    healthToken: env.HEALTH_TOKEN,
    authorization: req.authorization,
  };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

/** Refuse to read from a node that is not the chain we serve. */
export async function requireChain(ctx: Context): Promise<void> {
  const s = await chainState(ctx.client, ctx.chainId);
  if (!s.checked) throw new UnavailableError("rpc_unavailable", `RPC for chain ${ctx.chainId} is unreachable`);
  if (!s.healthy) {
    throw new UnavailableError(
      "chain_mismatch",
      `RPC reports chain ${s.observed}, but this engine serves chain ${ctx.chainId} — refusing to read`,
    );
  }
}

/** The named SPARE contracts, verified to exist on the chain we serve. */
export async function requireContracts(ctx: Context, keys: readonly ContractKey[]): Promise<SpareAddresses> {
  const book = ctx.book();
  if (!book.deployed) throw new UnavailableError("not_deployed", book.reason);
  await requireChain(ctx);
  const v = await verifiedContracts(ctx.client, book, keys);
  if (!v.ok) throw new UnavailableError("not_deployed", v.reason);
  return v.addresses;
}
