import { describe, expect, it } from 'vitest';
import {
  equitySessionOpenedAt,
  fillPrice,
  fmtPct,
  fmtUsd,
  gapPct,
  marketState,
  nextSessionOpen,
  toUnixSeconds,
  usd1e18ToNumber,
} from './stockBoard';

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('stock board helpers', () => {
  it('reads API timestamps: ISO-8601 text, unix seconds or unix milliseconds', () => {
    expect(toUnixSeconds('2026-10-01T20:20:25.000Z')).toBe(utc('2026-10-01T20:20:25Z'));
    expect(toUnixSeconds(1_790_886_025)).toBe(1_790_886_025);
    expect(toUnixSeconds(1_790_886_025_000)).toBe(1_790_886_025);
    for (const v of [null, undefined, '', '  ', 'not a date', 0, Number.NaN, {}, true]) expect(toUnixSeconds(v)).toBeNull();
  });

  it('formats prices and gaps, "—" when unknown', () => {
    expect(fmtUsd(573.2)).toBe('$573.20');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtPct(0.294)).toBe('+0.29%');
    expect(fmtPct(-1.1)).toBe('−1.10%');
    expect(fmtPct(undefined)).toBe('—');
  });

  it('converts 1e18 prices and ignores zero', () => {
    expect(usd1e18ToNumber(573_210_000_000_000_000_000n)).toBeCloseTo(573.21, 6);
    expect(usd1e18ToNumber(0n)).toBeNull();
    expect(usd1e18ToNumber(undefined)).toBeNull();
  });

  it('prices a fill per token from USDG (6 dp) and tokens (18 dp)', () => {
    // $100 buys 0.2 tokens -> $500 per token.
    expect(fillPrice(100_000_000n, 200_000_000_000_000_000n)).toBeCloseTo(500, 9);
    expect(fillPrice(100_000_000n, 0n)).toBeNull();
  });

  it('measures the gap against a reference', () => {
    expect(gapPct(101, 100)).toBeCloseTo(1, 9);
    expect(gapPct(99, 100)).toBeCloseTo(-1, 9);
    expect(gapPct(null, 100)).toBeNull();
    expect(gapPct(100, 0)).toBeNull();
  });

  it('reads the market off the active feeds', () => {
    expect(marketState([])).toBe('unknown');
    expect(marketState([{ active: true, status: 0 }, { active: true, status: 1 }])).toBe('open');
    expect(marketState([{ active: true, status: 1 }, { active: true, status: 1 }, { active: false, status: 0 }])).toBe('closed');
    expect(marketState([{ active: true, status: 2 }, { active: true, status: 1 }])).toBe('mixed');
  });
});

describe('US-equities 24/5 session (mirrors the keeper)', () => {
  it('is open midweek and closed on Saturday', () => {
    // Wed 30 Sep 2026 17:50 UTC = 13:50 EDT
    expect(equitySessionOpenedAt(utc('2026-09-30T17:50:00Z'))).toBe(utc('2026-09-28T00:00:00Z')); // Sun 27 Sep 20:00 EDT
    // Sat 3 Oct 2026 12:00 UTC
    expect(equitySessionOpenedAt(utc('2026-10-03T12:00:00Z'))).toBeNull();
  });

  it('closes Friday 20:00 ET and reopens Sunday 20:00 ET', () => {
    expect(equitySessionOpenedAt(utc('2026-10-02T23:59:00Z'))).not.toBeNull(); // Fri 19:59 EDT
    expect(equitySessionOpenedAt(utc('2026-10-03T00:00:00Z'))).toBeNull(); // Fri 20:00 EDT
    expect(nextSessionOpen(utc('2026-10-03T12:00:00Z'))).toBe(utc('2026-10-05T00:00:00Z')); // Sun 4 Oct 20:00 EDT
    expect(nextSessionOpen(utc('2026-09-30T17:50:00Z'))).toBeNull();
  });
});
