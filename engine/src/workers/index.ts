/**
 * Worker entrypoint: `bun run workers` (or START_WORKERS=1 in the API process).
 * Not deployed. With no worker registered it exits at start (registry.ts), and
 * under START_WORKERS=1 that exit ends the API process too.
 *
 *   WORKERS=chain-indexer,sweeper bun run workers   # a subset
 *
 * Every worker is a BullMQ repeatable job whose tick logs-and-retries on any
 * RPC/DB/Redis failure (queues.ts), so nothing here can crash the process.
 * Workers never sign: keeper transactions come from the keeper service alone
 * (src/keeper/), and this process knows only its address (chain/keeper.ts).
 */
import { parseWorkerSelection, startWorkers } from "./registry.ts";
import { broadcastEnabled, keeperAddress } from "../chain/keeper.ts";
import { env } from "../env.ts";

const selection = parseWorkerSelection(process.env.WORKERS);
const { started, missing } = startWorkers(selection);

console.log(
  `[workers] chain ${env.CHAIN_ID}; keeper ${keeperAddress() ?? "NOT CONFIGURED"}; broadcast ${broadcastEnabled() ? "ON" : "off (simulate only)"}`,
);
console.log(`[workers] started: ${started.map((j) => j.name).join(", ") || "(none)"}`);
if (missing.length) console.warn(`[workers] not built yet: ${missing.join(", ")}`);

process.on("unhandledRejection", (err) => {
  console.warn("[workers] unhandled rejection (suppressed):", (err as Error)?.message ?? err);
});

async function shutdown() {
  await Promise.allSettled(started.flatMap((j) => [j.worker.close(), j.queue.close()]));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// With nothing registered there is nothing to keep alive; exit cleanly so a
// supervisor does not restart-loop a process that has no work.
if (started.length === 0) {
  console.warn("[workers] no workers registered — exiting");
  process.exit(0);
}
