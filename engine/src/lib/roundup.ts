/**
 * The round-up rule, in USDG BASE UNITS (6 decimals), as bigint.
 *
 * This is the engine's copy of contracts/src/libraries/RoundUp.sol and must stay
 * operation-for-operation identical to it:
 *
 *   step  = roundTo * 1e6
 *   rem   = amount % step
 *   delta = rem == 0 ? 0 : (step - rem) * multiplier
 *
 * A payment already on the boundary yields ZERO: rounding $5.00 up to $5.00 is
 * nothing, and adding a full step there would take money the user never
 * agreed to give. Anyone can recompute a keeper's accrual from public payments
 * with this function; that is what makes the accrual auditable.
 *
 * The site's `roundUpDelta` (src/lib/spare.ts) does the same bigint base-unit
 * math. test/roundup.test.ts checks that the two agree exactly over every cent
 * from $0.01 to $100.00 and on sub-cent payments (skipped when the site's
 * dependencies are not installed).
 */

export const USDG_UNIT = 1_000_000n; // $1.00 in USDG base units

export const ROUND_TO_VALUES = [1, 5, 10] as const;
export type RoundTo = (typeof ROUND_TO_VALUES)[number];
export const MULTIPLIER_VALUES = [1, 2, 3, 4, 5] as const;
export type Multiplier = (typeof MULTIPLIER_VALUES)[number];

/** Mirrors RoundUp.BadRoundTo / BadMultiplier. */
export class RoundUpError extends RangeError {
  constructor(
    readonly code: "BadRoundTo" | "BadMultiplier" | "NegativeAmount",
    message: string,
  ) {
    super(message);
    this.name = "RoundUpError";
  }
}

export function isRoundTo(v: number): v is RoundTo {
  return v === 1 || v === 5 || v === 10;
}

export function isMultiplier(v: number): v is Multiplier {
  return Number.isInteger(v) && v >= 1 && v <= 5;
}

/**
 * @param amount     payment in USDG base units (uint256 on-chain)
 * @param roundTo    boundary in whole dollars: 1, 5 or 10
 * @param multiplier 1..5
 * @returns          spare change in USDG base units
 */
export function roundUpDelta(amount: bigint, roundTo: number, multiplier: number): bigint {
  // Same check order as the contract: roundTo, then multiplier.
  if (!isRoundTo(roundTo)) throw new RoundUpError("BadRoundTo", `roundTo must be 1, 5 or 10 (got ${roundTo})`);
  if (!isMultiplier(multiplier)) throw new RoundUpError("BadMultiplier", `multiplier must be 1..5 (got ${multiplier})`);
  if (amount < 0n) throw new RoundUpError("NegativeAmount", "amount is a uint256; it cannot be negative");
  if (amount === 0n) return 0n;
  const step = BigInt(roundTo) * USDG_UNIT;
  const rem = amount % step;
  if (rem === 0n) return 0n;
  return (step - rem) * BigInt(multiplier);
}

/** Sum of round-ups for a batch of payments (no cap — see applyRollingWeeklyCap). */
export function sumDeltas(amounts: readonly bigint[], roundTo: number, multiplier: number): bigint {
  let total = 0n;
  for (const a of amounts) total += roundUpDelta(a, roundTo, multiplier);
  return total;
}

/** Seconds in a week (the length of the executor's ROLLING cap window). */
export const WEEK_SECONDS = 604_800n;
/** Calendar week index `ts / 1 weeks`. Display only: the executor's cap is NOT calendar-weekly. */
export function weekIndex(unixSeconds: bigint | number): bigint {
  return BigInt(unixSeconds) / WEEK_SECONDS;
}

/**
 * The executor's cap bucket: `block.timestamp / 1 days` (UTC days). The cap
 * is enforced over a ROLLING 7 days = today's bucket + the 6 before it
 * (SweepExecutor._pulled7d), not per calendar week.
 */
export const DAY_SECONDS = 86_400n;
export const ROLLING_CAP_DAYS = 7n;
export function dayIndex(unixSeconds: bigint | number): bigint {
  return BigInt(unixSeconds) / DAY_SECONDS;
}

/**
 * What the executor's rolling weekly cap lets through, day by day in order.
 * For each UTC day d: room = weeklyCap − (accepted + prior) over days d−6..d,
 * and the day accepts min(requested, room). A cap of 0 lets nothing through.
 * `prior` seeds already-pulled amounts per day (e.g. on-chain dayPulled).
 * Within a day the keeper clamps each pull to the remaining room, so the day
 * total is min(sum, room).
 */
export function applyRollingWeeklyCap(
  items: ReadonlyArray<{ day: bigint; delta: bigint }>,
  weeklyCap: bigint,
  prior: ReadonlyMap<bigint, bigint> = new Map(),
): { accepted: bigint; dropped: bigint; days: { day: bigint; requested: bigint; accepted: bigint }[] } {
  const byDay = new Map<bigint, bigint>();
  for (const it of items) byDay.set(it.day, (byDay.get(it.day) ?? 0n) + it.delta);
  const acceptedOn = new Map<bigint, bigint>();
  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, requested]) => {
      let used = 0n;
      for (let d = day - (ROLLING_CAP_DAYS - 1n); d <= day; d++) used += (acceptedOn.get(d) ?? 0n) + (prior.get(d) ?? 0n);
      const room = weeklyCap > used ? weeklyCap - used : 0n;
      const accepted = requested < room ? requested : room;
      acceptedOn.set(day, accepted);
      return { day, requested, accepted };
    });
  const accepted = days.reduce((s, d) => s + d.accepted, 0n);
  const requested = days.reduce((s, d) => s + d.requested, 0n);
  return { accepted, dropped: requested - accepted, days };
}
