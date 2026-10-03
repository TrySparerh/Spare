import { describe, expect, it } from 'vitest';
import { formatUnitsExact, parseUnitsExact, previewRoundUp, previewRoundUps, roundUpDelta, SpareInputError, usdLabel } from './roundup.js';

const usd = (s: string) => parseUnitsExact(s);

describe('roundUpDelta (RoundUp.sol parity)', () => {
  it('acceptance (1): $3.75 -> $0.25 at 1x, $0.75 at 3x', () => {
    expect(roundUpDelta(usd('3.75'), 1, 1)).toBe(250_000n);
    expect(roundUpDelta(usd('3.75'), 1, 3)).toBe(750_000n);
  });

  it('a payment already on the boundary rounds up by zero', () => {
    expect(roundUpDelta(usd('5'), 5, 1)).toBe(0n);
    expect(roundUpDelta(usd('10'), 1, 5)).toBe(0n);
    expect(roundUpDelta(usd('20'), 10, 3)).toBe(0n);
    expect(roundUpDelta(0n, 1, 1)).toBe(0n);
  });

  it('handles every boundary and multiplier', () => {
    expect(roundUpDelta(usd('4.20'), 5, 1)).toBe(800_000n);
    expect(roundUpDelta(usd('4.20'), 5, 5)).toBe(4_000_000n);
    expect(roundUpDelta(usd('0.01'), 10, 1)).toBe(9_990_000n);
    expect(roundUpDelta(usd('12.34'), 10, 2)).toBe(15_320_000n);
  });

  it('keeps all 6 USDG decimals (no cent rounding on-chain)', () => {
    expect(roundUpDelta(usd('3.749999'), 1, 1)).toBe(250_001n);
    expect(roundUpDelta(1n, 1, 1)).toBe(999_999n);
  });

  it('matches an independent ceil-based formula over the whole $0.01..$100.00 cent grid', () => {
    for (const roundTo of [1, 5, 10]) {
      const stepCents = roundTo * 100;
      for (let c = 1; c <= 10_000; c++) {
        const expectedCents = Math.ceil(c / stepCents) * stepCents - c;
        for (const m of [1, 3, 5]) {
          expect(roundUpDelta(BigInt(c) * 10_000n, roundTo, m)).toBe(BigInt(expectedCents * m) * 10_000n);
        }
      }
    }
  });

  it('rejects what the contract rejects, in the same order', () => {
    expect(() => roundUpDelta(1n, 2, 1)).toThrow(/roundTo/);
    expect(() => roundUpDelta(1n, 2, 9)).toThrow(/roundTo/); // roundTo is checked first
    expect(() => roundUpDelta(1n, 1, 0)).toThrow(/multiplier/);
    expect(() => roundUpDelta(1n, 1, 6)).toThrow(/multiplier/);
    expect(() => roundUpDelta(1n, 1, 1.5)).toThrow(/multiplier/);
    expect(() => roundUpDelta(-1n, 1, 1)).toThrow(SpareInputError);
  });
});

describe('parseUnitsExact / formatUnitsExact', () => {
  it('parses decimal strings and numbers exactly', () => {
    expect(parseUnitsExact('3.75')).toBe(3_750_000n);
    expect(parseUnitsExact(3.75)).toBe(3_750_000n);
    expect(parseUnitsExact('$1,204.5')).toBe(1_204_500_000n);
    expect(parseUnitsExact('0.000001')).toBe(1n);
    expect(parseUnitsExact('7')).toBe(7_000_000n);
    expect(parseUnitsExact('.5')).toBe(500_000n);
    expect(parseUnitsExact('2.500000')).toBe(2_500_000n);
  });
  it('refuses to silently round or guess', () => {
    expect(() => parseUnitsExact('1.0000001')).toThrow(/decimal places/);
    expect(() => parseUnitsExact('abc')).toThrow(SpareInputError);
    expect(() => parseUnitsExact('-1')).toThrow(/negative/);
    expect(() => parseUnitsExact('')).toThrow(SpareInputError);
    expect(() => parseUnitsExact(undefined)).toThrow(/required/);
    expect(() => parseUnitsExact(Number.NaN)).toThrow(/finite/);
  });
  it('formats without float error and trims zeros', () => {
    expect(formatUnitsExact(3_750_000n, 6)).toBe('3.75');
    expect(formatUnitsExact(1n, 6)).toBe('0.000001');
    expect(formatUnitsExact(5_000_000n, 6)).toBe('5');
    expect(formatUnitsExact(6_486_471_341_257_423n, 18)).toBe('0.006486471341257423');
    expect(usdLabel(250_001n)).toBe('$0.25');
    expect(usdLabel(1_234_567_890n)).toBe('$1,234.57');
  });
});

describe('previewRoundUp', () => {
  it('shows the working for the acceptance case', () => {
    const p = previewRoundUp('3.75', 1, 3);
    expect(p.payment).toEqual({ usd: '3.75', baseUnits: '3750000' });
    expect(p.roundsUpTo.usd).toBe('4');
    expect(p.onBoundary).toBe(false);
    expect(p.delta1x.usd).toBe('0.25');
    expect(p.delta).toEqual({ usd: '0.75', baseUnits: '750000', label: '$0.75' });
    expect(p.turbo.map((t) => t.usd)).toEqual(['0.25', '0.5', '0.75', '1', '1.25']);
  });
  it('reports a boundary payment as zero spare change', () => {
    const p = previewRoundUp(5, 5, 4);
    expect(p.onBoundary).toBe(true);
    expect(p.roundsUpTo.usd).toBe('5');
    expect(p.delta.usd).toBe('0');
  });
});

describe('previewRoundUps', () => {
  it('sums a list of payments and clamps to the weekly cap', () => {
    const p = previewRoundUps(['3.75', '12.40', '5.00', '0.99'], 1, 2, '2');
    expect(p.rows.map((r) => r.roundUp)).toEqual(['0.5', '1.2', '0', '0.02']);
    expect(p.rows[2]!.onBoundary).toBe(true);
    expect(p.totalUsd).toBe('1.72');
    expect(p.cappedTotalUsd).toBe('1.72');
    expect(previewRoundUps('3.75,12.40,5.00,0.99', 1, 2, '1.5').cappedTotalUsd).toBe('1.5');
    expect(previewRoundUps('3.75,12.40,5.00,0.99', 1, 2, '1.5').droppedByCapUsd).toBe('0.22');
    expect(previewRoundUps(['3.75'], 5, 1).weeklyCapUsd).toBeNull();
  });
  it('rejects empty lists and bad amounts', () => {
    expect(() => previewRoundUps([], 1, 1)).toThrow(/at least one/);
    expect(() => previewRoundUps(['1.0000001'], 1, 1)).toThrow(/amounts\[0\]/);
  });
});
