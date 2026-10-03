import { describe, it, expect } from 'vitest';
import {
  USDG_UNIT,
  accrueBatch,
  balanceBps,
  epochAt,
  feeOf,
  formatBps,
  formatToken,
  formatUsd,
  nextEpochStart,
  parsePct,
  parseUsd,
  pctOf,
  roundUpDelta,
  ruleIsActive,
  splitByBps,
  to1e18,
  tokensValueUsdg,
  usdToInput,
  validateMix,
  type ChainRule,
} from './spare';

/** "$4.25" -> 4_250_000n, via the same parser the UI uses. */
const $ = (s: string) => {
  const v = parseUsd(s);
  if (v === null) throw new Error(`bad test amount ${s}`);
  return v;
};

describe('roundUpDelta (base units, == RoundUp.sol)', () => {
  it('rounds to the next dollar', () => {
    expect(roundUpDelta($('4.25'), 1, 1)).toBe($('0.75'));
    expect(roundUpDelta($('3.75'), 1, 1)).toBe($('0.25'));
  });
  it('gives nothing on an exact boundary (no full increment)', () => {
    expect(roundUpDelta($('5'), 1, 1)).toBe(0n);
    expect(roundUpDelta($('10'), 5, 1)).toBe(0n);
    expect(roundUpDelta($('20'), 10, 5)).toBe(0n);
  });
  it('applies the multiplier', () => {
    expect(roundUpDelta($('4.25'), 1, 4)).toBe($('3'));
    expect(roundUpDelta($('4.9'), 1, 5)).toBe($('0.5'));
  });
  it('handles $5 and $10 bases', () => {
    expect(roundUpDelta($('12.4'), 5, 1)).toBe($('2.6'));
    expect(roundUpDelta($('12.4'), 10, 1)).toBe($('7.6'));
  });
  it('keeps all 6 decimals — sub-cent payments are exact', () => {
    expect(roundUpDelta(4_250_001n, 1, 1)).toBe(749_999n);
    expect(roundUpDelta(1n, 1, 3)).toBe((USDG_UNIT - 1n) * 3n);
  });
  it('has no floating-point tail (0.1 + 0.2)', () => {
    expect(roundUpDelta($('0.3'), 1, 3)).toBe($('2.1'));
  });
  it('ignores zero / negative amounts', () => {
    expect(roundUpDelta(0n, 1, 1)).toBe(0n);
    expect(roundUpDelta(-3n, 1, 1)).toBe(0n);
  });
  it('rejects what the contract rejects', () => {
    expect(() => roundUpDelta(1n, 2, 1)).toThrow(RangeError);
    expect(() => roundUpDelta(1n, 1, 0)).toThrow(RangeError);
    expect(() => roundUpDelta(1n, 1, 6)).toThrow(RangeError);
  });
  it('matches an independent integer-cents model over $0.01–$100.00', () => {
    for (const roundTo of [1, 5, 10]) {
      for (const mult of [1, 2, 3, 4, 5]) {
        const stepCents = roundTo * 100;
        for (let cents = 1; cents <= 10_000; cents++) {
          const rem = cents % stepCents;
          const want = rem === 0 ? 0n : BigInt((stepCents - rem) * mult) * 10_000n;
          if (roundUpDelta(BigInt(cents) * 10_000n, roundTo, mult) !== want) {
            throw new Error(`mismatch at ${cents}c roundTo=${roundTo} mult=${mult}`);
          }
        }
      }
    }
  });
});

describe('accrueBatch', () => {
  const rule: ChainRule = { roundTo: 1, multiplier: 1, weeklyCap: $('100'), enabled: true };
  it('sums a batch', () => {
    const r = accrueBatch([$('4.25'), $('3.75'), $('1.10')], rule);
    expect(r).toEqual({ requested: $('1.9'), accepted: $('1.9'), capped: false });
  });
  it('clips to the weekly cap', () => {
    const r = accrueBatch([$('4.25'), $('3.75')], { ...rule, weeklyCap: $('0.5') });
    expect(r).toEqual({ requested: $('1'), accepted: $('0.5'), capped: true });
  });
  it('clips to the room left after what was already pulled this week', () => {
    const r = accrueBatch([$('4.25'), $('3.75')], { ...rule, weeklyCap: $('2') }, $('1.5'));
    expect(r.accepted).toBe($('0.5'));
    expect(accrueBatch([$('4.25')], { ...rule, weeklyCap: $('2') }, $('3')).accepted).toBe(0n);
  });
  it('accrues nothing while disabled or capped at zero', () => {
    expect(accrueBatch([$('4.25')], { ...rule, enabled: false }).accepted).toBe(0n);
    expect(accrueBatch([$('4.25')], { ...rule, weeklyCap: 0n }).accepted).toBe(0n);
    expect(ruleIsActive({ ...rule, weeklyCap: 0n })).toBe(false);
    expect(ruleIsActive(rule)).toBe(true);
  });
});

describe('splitByBps (== SweepExecutor._collect)', () => {
  it('splits by bps and conserves the total', () => {
    const legs = splitByBps($('10'), [{ bps: 7000 }, { bps: 3000 }]);
    expect(legs.map((l) => l.amount)).toEqual([$('7'), $('3')]);
  });
  it('gives the rounding remainder to the LAST leg', () => {
    const legs = splitByBps(100n, [{ bps: 3333 }, { bps: 3333 }, { bps: 3334 }]);
    expect(legs.map((l) => l.amount)).toEqual([33n, 33n, 34n]);
    const odd = splitByBps(7n, [{ bps: 5000 }, { bps: 5000 }]);
    expect(odd.map((l) => l.amount)).toEqual([3n, 4n]);
  });
  it('returns nothing without legs or amount', () => {
    expect(splitByBps($('10'), [])).toEqual([]);
    expect(splitByBps(0n, [{ bps: 10_000 }])).toEqual([]);
  });
  it('fee is total * feeBps / 10000, floored', () => {
    expect(feeOf($('5'), 25)).toBe(12_500n);
    expect(feeOf(3n, 25)).toBe(0n);
  });
});

describe('validateMix (== ElectionRegistry._validate)', () => {
  const opts = { maxLegs: 6, isEligible: (a: string) => a !== 'QQQ' };
  it('accepts a clean 100% mix', () => {
    expect(validateMix([{ asset: 'SPY', bps: 6000 }, { asset: 'NVDA', bps: 4000 }], opts)).toBeNull();
  });
  it('rejects what the contract rejects', () => {
    expect(validateMix([], opts)).toMatch(/at least one/);
    expect(validateMix(Array.from({ length: 7 }, (_, i) => ({ asset: `A${i}`, bps: 1 })), opts)).toMatch(/at most 6/);
    expect(validateMix([{ asset: 'SPY', bps: 0 }, { asset: 'NVDA', bps: 10_000 }], opts)).toMatch(/above 0%/);
    expect(validateMix([{ asset: 'QQQ', bps: 10_000 }], opts)).toMatch(/not active/);
    expect(validateMix([{ asset: 'SPY', bps: 5000 }, { asset: 'spy', bps: 5000 }], opts)).toMatch(/twice/);
    expect(validateMix([{ asset: 'SPY', bps: 9000 }], opts)).toMatch(/exactly 100%/);
  });
  it('balanceBps nudges the largest leg to reach 10000', () => {
    expect(balanceBps([{ asset: 'A', bps: 5000 }, { asset: 'B', bps: 3000 }]).map((l) => l.bps)).toEqual([7000, 3000]);
    expect(balanceBps([{ asset: 'A', bps: 6000 }, { asset: 'B', bps: 6000 }]).map((l) => l.bps)).toEqual([4000, 6000]);
    expect(balanceBps([{ asset: 'A', bps: 0 }, { asset: 'B', bps: 0 }, { asset: 'C', bps: 0 }]).map((l) => l.bps)).toEqual([3334, 3333, 3333]);
  });
});

describe('money parsing and formatting (no floats)', () => {
  it('parses dollar text to base units', () => {
    expect(parseUsd('12')).toBe(12_000_000n);
    expect(parseUsd('12.5')).toBe(12_500_000n);
    expect(parseUsd('.5')).toBe(500_000n);
    expect(parseUsd('12.')).toBe(12_000_000n);
    expect(parseUsd('$1,250.00')).toBe(1_250_000_000n);
    expect(parseUsd('0.000001')).toBe(1n);
  });
  it('rejects junk rather than guessing', () => {
    for (const bad of ['', '.', '-1', '1e3', 'abc', '1.1234567', '1.2.3']) expect(parseUsd(bad)).toBeNull();
  });
  it('formats with half-up rounding and separators', () => {
    expect(formatUsd(1_234_567n)).toBe('$1.23');
    expect(formatUsd(1_235_000n)).toBe('$1.24');
    expect(formatUsd(1_234_567_890_000n)).toBe('$1,234,567.89');
    expect(formatUsd(0n)).toBe('$0.00');
    expect(formatUsd(-1_500_000n)).toBe('-$1.50');
    expect(formatUsd(1n, 6)).toBe('$0.000001');
    expect(formatUsd(25_000_000n, 0)).toBe('$25');
  });
  it('round-trips editable text', () => {
    expect(usdToInput(12_500_000n)).toBe('12.5');
    expect(usdToInput(12_000_000n)).toBe('12');
    expect(parseUsd(usdToInput(4_250_001n))).toBe(4_250_001n);
  });
  it('formats token amounts', () => {
    expect(formatToken(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatToken(123n, 18, 6)).toBe('0');
  });
  it('values tokens like StockRouter.oracleUsdgFor', () => {
    expect(tokensValueUsdg(2n * 10n ** 18n, 500n * 10n ** 18n)).toBe(1_000_000_000n);
    expect(to1e18(50_000_000_000n, 8)).toBe(500n * 10n ** 18n);
    expect(to1e18(5n * 10n ** 20n, 20)).toBe(5n * 10n ** 18n);
  });
  it('percent helpers', () => {
    expect(parsePct('33.33')).toBe(3333);
    expect(parsePct('25')).toBe(2500);
    expect(parsePct('100')).toBe(10_000);
    for (const bad of ['100.01', 'abc', '33.333', '', '-5']) expect(parsePct(bad)).toBeNull();
    expect(formatBps(3333)).toBe('33.33');
    expect(formatBps(2500)).toBe('25');
    expect(formatBps(3330)).toBe('33.3');
    expect(formatBps(25)).toBe('0.25');
    expect(pctOf(1n, 4n)).toBe(25);
    expect(pctOf(5n, 4n)).toBe(100);
    expect(pctOf(1n, 0n)).toBe(0);
  });
});

describe('epochs (== SweepExecutor.currentEpoch)', () => {
  it('is floor(ts / length) + 1 and rolls at the boundary', () => {
    expect(epochAt(86_399n, 86_400n)).toBe(1n);
    expect(epochAt(86_400n, 86_400n)).toBe(2n);
    expect(nextEpochStart(86_399n, 86_400n)).toBe(86_400n);
    expect(nextEpochStart(86_400n, 86_400n)).toBe(172_800n);
  });
});
