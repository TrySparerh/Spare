import { describe, expect, it, vi } from 'vitest';
import { cacheKey, createTtlCache } from './cache.js';

describe('createTtlCache', () => {
  it('shares one in-flight load and reuses the result until the TTL passes', async () => {
    vi.useFakeTimers();
    try {
      const c = createTtlCache<number>(10_000);
      let n = 0;
      const load = vi.fn(async () => ++n);
      const [a, b] = await Promise.all([c.get('k', load), c.get('k', load)]);
      expect([a, b]).toEqual([1, 1]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(await c.get('k', load)).toBe(1);
      vi.advanceTimersByTime(10_001);
      expect(await c.get('k', load)).toBe(2);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never caches a failure', async () => {
    const c = createTtlCache<number>(10_000);
    await expect(c.get('k', async () => Promise.reject(new Error('rpc down')))).rejects.toThrow('rpc down');
    expect(await c.get('k', async () => 7)).toBe(7);
  });

  it('is bounded', async () => {
    const c = createTtlCache<number>(10_000, 3);
    for (let i = 0; i < 5; i++) await c.get(String(i), async () => i);
    expect(c.size).toBe(3);
  });

  it('cacheKey normalises case, empties and list order', () => {
    expect(cacheKey(['0xABC', undefined, ''])).toBe(cacheKey(['0xabc', null, null]));
    expect(cacheKey([['Swept', 'accrued']])).toBe(cacheKey([['accrued', 'swept']]));
  });
});
