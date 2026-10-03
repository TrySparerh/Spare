/**
 * A non-queuing concurrency limit. `tryEnter` hands out a release function
 * while fewer than `size` holders are inside, else null.
 *
 * Expensive public work (rule.preview) refuses instead of queueing: a burst
 * from many addresses cannot pile up RPC calls or held logs behind the limit,
 * so what the process holds at once is `size` x one request's budget.
 */
export class Gate {
  private held = 0;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError("gate size must be a positive integer");
  }

  get inUse(): number {
    return this.held;
  }

  /** A release function (idempotent), or null when the gate is full. */
  tryEnter(): (() => void) | null {
    if (this.held >= this.size) return null;
    this.held++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held--;
    };
  }
}

/**
 * A Gate per key (rule.preview: per rate-limit key, so one client cannot hold
 * every engine-wide slot). `tryEnter(key)` hands out a release function while
 * fewer than `size` holders share that key, else null. A key with no holder is
 * forgotten, so the map only ever holds keys with work in flight.
 */
export class KeyedGate {
  private readonly held = new Map<string, number>();

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError("gate size must be a positive integer");
  }

  /** Holders of `key` now. */
  inUse(key: string): number {
    return this.held.get(key) ?? 0;
  }

  /** Keys with at least one holder. */
  get keys(): number {
    return this.held.size;
  }

  /** A release function (idempotent), or null when `key` is at its limit. */
  tryEnter(key: string): (() => void) | null {
    const n = this.held.get(key) ?? 0;
    if (n >= this.size) return null;
    this.held.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.held.get(key) ?? 1) - 1;
      if (left > 0) this.held.set(key, left);
      else this.held.delete(key);
    };
  }
}
