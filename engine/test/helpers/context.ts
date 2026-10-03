import type { PublicClient } from "viem";
import type { Context } from "../../src/trpc.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { appRouter } from "../../src/routers/index.ts";
import { createDb, type DbHandle } from "../../src/db/client.ts";
import type { AddressBook } from "../../src/chain/addresses.ts";
import { REQUIRED_CONTRACTS } from "../../src/chain/addresses.ts";
import { makePublicClient } from "../../src/chain/client.ts";
import type { SupportedChainId } from "../../src/env.ts";
import { Gate, KeyedGate } from "../../src/lib/gate.ts";

/** A database handle that points at nothing listening — for "DB down" paths. */
export function deadDb(): DbHandle {
  return createDb("postgres://nobody:nothing@127.0.0.1:1/none_test", 1);
}

/** A client whose RPC is unreachable. */
export function deadClient(chainId: SupportedChainId = 4663): PublicClient {
  return makePublicClient(chainId, "http://127.0.0.1:1");
}

export const NOT_DEPLOYED: Extract<AddressBook, { deployed: false }> = {
  deployed: false,
  reason: "SPARE is not deployed on chain 4663: no address book at /nowhere/4663.json",
  source: "/nowhere/4663.json",
  present: [],
  missing: [...REQUIRED_CONTRACTS],
};

export function makeCtx(over: Partial<Omit<Context, "db" | "sql">> & { handle?: DbHandle } = {}): Context {
  const { handle, ...rest } = over;
  const h = handle ?? deadDb();
  return {
    chainId: 4663,
    client: deadClient(),
    book: () => NOT_DEPLOYED,
    finalityBuffer: 3000n,
    logsMaxRange: 2_000_000n,
    previewMaxChunks: 250,
    previewMaxLogs: 20_000,
    previewTimeoutMs: 20_000,
    previewGate: new Gate(4),
    previewClientGate: new KeyedGate(1),
    clientKey: "203.0.113.7",
    schedulerNextRun: async () => null,
    redisHealthy: async () => false,
    keeperAddress: null,
    keeperBroadcast: false,
    authorization: null,
    ...rest,
    db: h.db,
    sql: h.sql,
  };
}

export const caller = (ctx: Context) => createCallerFactory(appRouter)(ctx);
