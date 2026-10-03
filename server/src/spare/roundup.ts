/**
 * Spare round-up math and money formatting — pure, no I/O.
 *
 * `roundUpDelta` is operation-for-operation identical to
 * contracts/src/libraries/RoundUp.sol (and engine/src/lib/roundup.ts):
 *
 *   step  = roundTo * 1e6            (USDG has 6 decimals)
 *   rem   = amount % step
 *   delta = rem == 0 ? 0 : (step - rem) * multiplier
 *
 * A payment already on the boundary yields ZERO — rounding $5.00 up to $5.00 is
 * nothing. Money is bigint USDG base units end to end; no float touches it.
 */
import { USDG_DECIMALS, USDG_UNIT } from './book.js';

export const ROUND_TO_VALUES = [1, 5, 10] as const;
export const MULTIPLIER_VALUES = [1, 2, 3, 4, 5] as const;

export class SpareInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'SpareInputError';
  }
}

export function isRoundTo(v: number): boolean {
  return v === 1 || v === 5 || v === 10;
}

export function isMultiplier(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= 5;
}

/** RoundUp.delta — spare change in USDG base units. Same check order as the contract. */
export function roundUpDelta(amount: bigint, roundTo: number, multiplier: number): bigint {
  if (!isRoundTo(roundTo)) throw new SpareInputError(`roundTo must be 1, 5 or 10 (got ${roundTo})`);
  if (!isMultiplier(multiplier)) throw new SpareInputError(`multiplier must be an integer 1..5 (got ${multiplier})`);
  if (amount < 0n) throw new SpareInputError('amount cannot be negative');
  if (amount === 0n) return 0n;
  const step = BigInt(roundTo) * USDG_UNIT;
  const rem = amount % step;
  if (rem === 0n) return 0n;
  return (step - rem) * BigInt(multiplier);
}

/**
 * Parse a decimal amount ("3.75", 3.75, "$1,204.5") into base units with
 * `decimals` places — exactly, from the decimal string, never via float math.
 * More fractional digits than the token has is an error, not a silent round.
 */
export function parseUnitsExact(input: unknown, decimals: number = USDG_DECIMALS, label = 'amount'): bigint {
  let s: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new SpareInputError(`${label} must be a finite number`);
    // Numbers are accepted for convenience; their shortest round-trip string is used.
    s = String(input);
    if (/e/i.test(s)) s = input.toFixed(decimals);
  } else if (typeof input === 'string' || typeof input === 'bigint') {
    s = String(input);
  } else {
    throw new SpareInputError(`${label} is required`);
  }
  s = s.trim().replace(/^\$/, '').replace(/,/g, '').replace(/_/g, '');
  if (s.startsWith('-')) throw new SpareInputError(`${label} cannot be negative`);
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new SpareInputError(`${label} must be a decimal number (got "${String(input)}")`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed.length > decimals) {
    throw new SpareInputError(`${label} has more than ${decimals} decimal places`);
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((trimmed + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Exact decimal string for base units ("3750000", 6 -> "3.75"). */
export function formatUnitsExact(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const usdg = (v: bigint) => formatUnitsExact(v, USDG_DECIMALS);

/** "$0.75" style label, rounded half-up to the cent (display only). */
export function usdLabel(v: bigint): string {
  const cents = (v + 5_000n) / 10_000n; // base units -> cents, half-up
  const whole = cents / 100n;
  const c = (cents % 100n).toString().padStart(2, '0');
  return `$${whole.toLocaleString('en-US')}.${c}`;
}

export interface RoundUpPreview {
  payment: { usd: string; baseUnits: string };
  rule: { roundTo: number; multiplier: number };
  roundsUpTo: { usd: string; baseUnits: string };
  onBoundary: boolean;
  delta1x: { usd: string; baseUnits: string };
  delta: { usd: string; baseUnits: string; label: string };
  /** Round-up delta for every multiplier 1..5 at this roundTo (for "turbo" UIs). */
  turbo: Array<{ multiplier: number; usd: string }>;
  formula: string;
  source: string;
}

/** The exact RoundUp.sol result for one payment, with the working shown. */
export function previewRoundUp(amountUsd: unknown, roundTo: number, multiplier: number): RoundUpPreview {
  const amount = parseUnitsExact(amountUsd, USDG_DECIMALS, 'amountUsd');
  const delta = roundUpDelta(amount, roundTo, multiplier);
  const delta1x = roundUpDelta(amount, roundTo, 1);
  const step = BigInt(roundTo) * USDG_UNIT;
  const onBoundary = amount === 0n || amount % step === 0n;
  const roundsUpTo = onBoundary ? amount : amount + delta1x;
  return {
    payment: { usd: usdg(amount), baseUnits: amount.toString() },
    rule: { roundTo, multiplier },
    roundsUpTo: { usd: usdg(roundsUpTo), baseUnits: roundsUpTo.toString() },
    onBoundary,
    delta1x: { usd: usdg(delta1x), baseUnits: delta1x.toString() },
    delta: { usd: usdg(delta), baseUnits: delta.toString(), label: usdLabel(delta) },
    turbo: MULTIPLIER_VALUES.map((m) => ({ multiplier: m, usd: usdg(roundUpDelta(amount, roundTo, m)) })),
    formula: 'delta = amount % step == 0 ? 0 : (step - amount % step) * multiplier; step = roundTo * 1e6 (USDG base units)',
    source: 'contracts/src/libraries/RoundUp.sol',
  };
}

export interface RoundUpBatchPreview {
  rule: { roundTo: number; multiplier: number };
  rows: Array<{ amount: string; roundUp: string; onBoundary: boolean }>;
  totalUsd: string;
  weeklyCapUsd: string | null;
  /** min(total, weeklyCap) — what one 7-day cap window could accrue. */
  cappedTotalUsd: string;
  droppedByCapUsd: string;
  formula: string;
  source: string;
}

/**
 * Round-ups for a list of payments under one rule, optionally clamped to a
 * weekly cap (treating the list as one rolling 7-day window, as the executor
 * does). Pure — the same RoundUp.sol math per payment.
 */
export function previewRoundUps(
  amounts: unknown,
  roundTo: number,
  multiplier: number,
  weeklyCapUsd?: unknown,
): RoundUpBatchPreview {
  const list = Array.isArray(amounts) ? amounts : String(amounts ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new SpareInputError('amounts must list at least one payment');
  if (list.length > 500) throw new SpareInputError('amounts can list at most 500 payments');
  let total = 0n;
  const rows = list.map((raw, i) => {
    const amount = parseUnitsExact(raw, USDG_DECIMALS, `amounts[${i}]`);
    const d = roundUpDelta(amount, roundTo, multiplier);
    total += d;
    return { amount: usdg(amount), roundUp: usdg(d), onBoundary: d === 0n };
  });
  const cap =
    weeklyCapUsd === undefined || weeklyCapUsd === null || weeklyCapUsd === ''
      ? null
      : parseUnitsExact(weeklyCapUsd, USDG_DECIMALS, 'weeklyCapUsd');
  const capped = cap === null || total <= cap ? total : cap;
  return {
    rule: { roundTo, multiplier },
    rows,
    totalUsd: usdg(total),
    weeklyCapUsd: cap === null ? null : usdg(cap),
    cappedTotalUsd: usdg(capped),
    droppedByCapUsd: usdg(total - capped),
    formula: 'per payment: delta = amount % step == 0 ? 0 : (step - amount % step) * multiplier; step = roundTo * 1e6',
    source: 'contracts/src/libraries/RoundUp.sol',
  };
}
