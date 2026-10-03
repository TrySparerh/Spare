/**
 * Short-lived result cache with in-flight de-duplication for the scan-heavy
 * Spare reads (universe, activity, fees). Concurrent identical calls share
 * one chain read; a result is reused for `ttlMs` (every result carries the
 * block it was read at in `readAt`). Failures are never cached.
 */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
  readonly size: number;
}

export function createTtlCache<T>(ttlMs: number, maxEntries = 500): TtlCache<T> {
  const done = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  return {
    async get(key, load) {
      const hit = done.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      if (hit) done.delete(key);
      const pending = inflight.get(key);
      if (pending) return pending;
      const p = load()
        .then((value) => {
          done.set(key, { at: Date.now(), value });
          while (done.size > maxEntries) done.delete(done.keys().next().value as string);
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    clear() {
      done.clear();
      inflight.clear();
    },
    get size() {
      return done.size;
    },
  };
}

/** Stable cache key for tool args (address-like strings lower-cased). */
export function cacheKey(parts: readonly unknown[]): string {
  return JSON.stringify(
    parts.map((p) => {
      if (p === undefined || p === null || p === '') return null;
      if (Array.isArray(p)) return p.map((x) => String(x).trim().toLowerCase()).sort();
      return String(p).trim().toLowerCase();
    }),
  );
}
