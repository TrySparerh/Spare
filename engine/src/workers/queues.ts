/**
 * BullMQ plumbing shared by every worker: a named repeatable job whose
 * processor is hard-wrapped so an RPC/DB/Redis outage logs and retries on
 * the next tick instead of crashing.
 */
import { Queue, Worker, type Job } from "bullmq";
import { bullConnection } from "../redis.ts";
import { env } from "../env.ts";
import { getPublicClient, chainState } from "../chain/client.ts";
import { getSql } from "../db/client.ts";

/**
 * The seven planned workers (SPARE-BUILD.md §5); none is implemented yet
 * (registry.ts). Names are also their queue names and the ids sweep.next uses
 * to report the sweeper's next run.
 */
export const WORKER_NAMES = [
  "chain-indexer",
  "roundup-observer",
  "accrual-ledger",
  "park-scheduler",
  "sweeper",
  "nav-watcher",
  "universe-refresher",
] as const;
export type WorkerName = (typeof WORKER_NAMES)[number];

/**
 * Queue namespace. Two engines sharing one Redis but serving different chains
 * must never share queues (a laptop on a local fork would otherwise swallow
 * the production keeper's jobs).
 */
export const QUEUE_PREFIX = `spare:${env.QUEUE_PREFIX ?? String(env.CHAIN_ID)}`;

export function schedulerId(name: string): string {
  return `${name}-schedule`;
}

export interface RepeatableJob {
  name: string;
  queue: Queue;
  worker: Worker;
}

export type TickProcessor = (job: Job) => Promise<unknown>;

/** Refuse to tick against the wrong chain or an unbound database. */
async function preflight(): Promise<void> {
  const s = await chainState(getPublicClient(), env.CHAIN_ID);
  if (!s.healthy) {
    throw new Error(
      s.checked ? `RPC reports chain ${s.observed}, expected ${env.CHAIN_ID}` : `RPC for chain ${env.CHAIN_ID} unreachable`,
    );
  }
  const rows = await getSql()`select chain_id from chain_binding where id = 1`;
  const bound = rows[0]?.chain_id as number | undefined;
  if (bound !== undefined && bound !== env.CHAIN_ID) {
    throw new Error(`database is bound to chain ${bound}, engine serves ${env.CHAIN_ID}`);
  }
}

/**
 * Register a named repeatable job. Every tick runs the chain/DB preflight,
 * then the processor; any error is logged and swallowed (BullMQ just runs the
 * next tick). Concurrency 1: a worker never overlaps itself in one process;
 * cursor advisory locks (cursors.ts) cover multiple processes.
 */
export function repeatable(name: WorkerName | string, everyMs: number, processor: TickProcessor): RepeatableJob {
  const connection = bullConnection();
  const queue = new Queue(name, { connection, prefix: QUEUE_PREFIX });
  const worker = new Worker(
    name,
    async (job) => {
      try {
        await preflight();
        return await processor(job);
      } catch (err) {
        console.warn(`[${name}] tick failed (will retry): ${(err as Error).message}`);
        return null;
      }
    },
    { connection, concurrency: 1, prefix: QUEUE_PREFIX },
  );
  let lastErrorLog = 0;
  worker.on("error", (err) => {
    const now = Date.now();
    if (now - lastErrorLog > 30_000) {
      lastErrorLog = now;
      console.warn(`[${name}] worker error (redis down? retrying): ${err.message || err.name}`);
    }
  });
  queue
    .upsertJobScheduler(schedulerId(name), { every: everyMs }, { name: `${name}-tick` })
    .catch((err) => console.warn(`[${name}] could not schedule (redis down?): ${err.message}`));
  return { name, queue, worker };
}

// ---------------------------------------------------------------------------
// Read-side: the API asks when a worker will next run (sweep.next).
// ---------------------------------------------------------------------------
const readQueues = new Map<string, Queue>();

/** Next scheduled run of `name`, or null if unscheduled / Redis unreachable (1.5s budget). */
export async function schedulerNextRun(name: string, timeoutMs = 1500): Promise<Date | null> {
  try {
    let q = readQueues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: { ...bullConnection(), maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true },
        prefix: QUEUE_PREFIX,
      });
      q.on("error", () => {});
      readQueues.set(name, q);
    }
    const s = await Promise.race([
      q.getJobScheduler(schedulerId(name)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return s && typeof s.next === "number" ? new Date(s.next) : null;
  } catch {
    return null;
  }
}

export async function closeReadQueues(): Promise<void> {
  await Promise.allSettled([...readQueues.values()].map((q) => q.close()));
  readQueues.clear();
}
