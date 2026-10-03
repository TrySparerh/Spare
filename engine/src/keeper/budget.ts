/**
 * Per-wallet scan budget (audit B-L2).
 *
 * One linked wallet that sends thousands of 1-unit USDG transfers used to
 * make its scan split the getLogs range again and again and look up every
 * counterparty as a possible v3 pool, holding the accrue tick (and the sweeps
 * queued behind it) for as long as that took. Each wallet's scan now runs
 * under a budget: RPC calls, logs returned, and a wall-clock deadline that is
 * never past the tick's own. The first charge past any of them throws
 * ScanBudgetError; the scan commits nothing, the wallet is skipped this tick
 * and retried later over a smaller span, and no other wallet waits on it.
 *
 * The error text must stay clear of chain/logs.ts's result-cap and rate-limit
 * patterns, so a spent budget is never mistaken for "split" or "retry".
 */
import type { PublicClient } from "viem";

export class ScanBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanBudgetError";
  }
}

export interface ScanLimits {
  maxCalls: number;
  maxLogs: number;
  /** Wall-clock deadline, ms since the epoch. */
  deadlineAt: number;
}

export class ScanBudget {
  calls = 0;
  logs = 0;
  private stopped: string | null = null;
  private readonly startedAt: number;

  constructor(
    readonly limits: ScanLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** The largest share of any limit spent so far: calls, logs, or the time to the deadline (1 = all of it). */
  used(): number {
    const window = this.limits.deadlineAt - this.startedAt;
    const time = window > 0 ? (this.now() - this.startedAt) / window : 1;
    return Math.max(this.calls / this.limits.maxCalls, this.logs / this.limits.maxLogs, time);
  }

  /** Throws once the scan was abandoned or its deadline has passed. */
  check(): void {
    if (this.stopped) throw new ScanBudgetError(this.stopped);
    if (this.now() >= this.limits.deadlineAt) throw new ScanBudgetError(`scan deadline passed after ${this.calls} RPC call(s)`);
  }

  /** Charge one RPC call that is about to be made. */
  call(): void {
    this.check();
    if (this.calls >= this.limits.maxCalls) throw new ScanBudgetError(`scan budget spent: ${this.calls}/${this.limits.maxCalls} RPC calls`);
    this.calls++;
  }

  /** Count the logs a call returned. */
  addLogs(n: number): void {
    this.logs += n;
    if (this.logs > this.limits.maxLogs) throw new ScanBudgetError(`scan budget spent: ${this.logs}/${this.limits.maxLogs} logs`);
  }

  /** Abandon the scan: every later charge or check throws, so its work can no longer commit. */
  stop(reason: string): void {
    this.stopped ??= reason;
  }
}

/** `client` with every getLogs charged to `budget` (calls before, logs after). */
export function budgetedLogs(client: PublicClient, budget: ScanBudget): PublicClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "getLogs") return Reflect.get(target, prop, receiver);
      return async (args: unknown) => {
        budget.call();
        const logs = (await target.getLogs(args as never)) as unknown[];
        budget.check();
        budget.addLogs(logs.length);
        return logs;
      };
    },
  });
}

export interface ScanResults<T> {
  done: T[];
  overran: { item: T; error: ScanBudgetError }[];
  failed: { item: T; error: unknown }[];
  /** Not started before the tick deadline: neither scanned nor failed. */
  unreached: T[];
}

/**
 * Scan every item, `concurrency` at a time and in the given order, each under
 * its own budget: `maxCalls`, `maxLogs`, and `deadlineMs` but never past the
 * tick's deadline. An item not started by the tick deadline is left for the
 * next tick. However one item's scan behaves, the others run.
 */
export async function scanEach<T>(
  items: readonly T[],
  opts: {
    concurrency: number;
    tickDeadlineAt: number;
    limits: { maxCalls: number; maxLogs: number; deadlineMs: number };
    scan: (item: T, budget: ScanBudget) => Promise<void>;
    now?: () => number;
  },
): Promise<ScanResults<T>> {
  const now = opts.now ?? Date.now;
  const res: ScanResults<T> = { done: [], overran: [], failed: [], unreached: [] };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      const t0 = now();
      if (t0 >= opts.tickDeadlineAt) {
        res.unreached.push(item);
        continue;
      }
      const { maxCalls, maxLogs, deadlineMs } = opts.limits;
      const budget = new ScanBudget({ maxCalls, maxLogs, deadlineAt: Math.min(t0 + deadlineMs, opts.tickDeadlineAt) }, now);
      try {
        await withDeadline(
          Promise.resolve().then(() => opts.scan(item, budget)),
          budget,
          now,
        );
        res.done.push(item);
      } catch (err) {
        if (err instanceof ScanBudgetError) res.overran.push({ item, error: err });
        else res.failed.push({ item, error: err });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, items.length) }, worker));
  return res;
}

/**
 * Settle with `work`, or reject with ScanBudgetError at the budget's
 * deadline. On the deadline the budget is stopped first, so the abandoned
 * work throws at its next charge or check instead of committing late.
 */
export function withDeadline<T>(work: Promise<T>, budget: ScanBudget, now: () => number = Date.now): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        const why = `scan deadline: still running after ${budget.calls} RPC call(s)`;
        budget.stop(why);
        reject(new ScanBudgetError(why));
      },
      Math.max(0, budget.limits.deadlineAt - now()),
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
