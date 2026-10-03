/**
 * Worker registry. A worker lives in its own module exporting
 * `start(): RepeatableJob` (built with `repeatable()` from queues.ts) and is
 * registered here under its name.
 *
 * The registry is empty: none of the seven planned workers is implemented, so
 * `startWorkers` reports every selected name as missing and `bun run workers`
 * exits. The workers, the HTTP API and its database are not deployed; they are
 * kept as the base for the next release. Production runs the keeper
 * (src/keeper) and the monitor (src/monitor) from this package, plus spare-api
 * (server/). See engine/README.md.
 */
import { WORKER_NAMES, type RepeatableJob, type WorkerName } from "./queues.ts";

export type WorkerStart = () => RepeatableJob;

export const WORKER_REGISTRY: Partial<Record<WorkerName, WorkerStart>> = {
  // "chain-indexer":      (await import("./chain-indexer.ts")).start,
  // "roundup-observer":   ...
  // "accrual-ledger":     ...
  // "park-scheduler":     ...
  // "sweeper":            ...
  // "nav-watcher":        ...
  // "universe-refresher": ...
};

export function parseWorkerSelection(raw: string | undefined): WorkerName[] {
  if (!raw || raw.trim() === "" || raw.trim() === "all") return [...WORKER_NAMES];
  const picked = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = picked.filter((p) => !(WORKER_NAMES as readonly string[]).includes(p));
  if (unknown.length) throw new Error(`unknown worker(s): ${unknown.join(", ")} — known: ${WORKER_NAMES.join(", ")}`);
  return picked as WorkerName[];
}

export function startWorkers(
  selection: WorkerName[],
  registry: Partial<Record<WorkerName, WorkerStart>> = WORKER_REGISTRY,
): { started: RepeatableJob[]; missing: WorkerName[] } {
  const started: RepeatableJob[] = [];
  const missing: WorkerName[] = [];
  for (const name of selection) {
    const start = registry[name];
    if (start) started.push(start());
    else missing.push(name);
  }
  return { started, missing };
}
