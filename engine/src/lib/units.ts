/**
 * Money on the wire.
 *
 * tRPC serialises with JSON, which has no bigint, and a float cannot hold a
 * uint256. So every amount the API returns is an `Amount`: the exact base-unit
 * integer as a decimal string, its decimals, and an exact decimal rendering.
 * No rounding happens here — a UI that wants cents rounds for display itself.
 */

export interface Amount {
  /** Base units, base-10 integer string (e.g. "250000" for $0.25 USDG). */
  raw: string;
  decimals: number;
  /** Exact decimal string, trailing zeros trimmed (e.g. "0.25"). */
  display: string;
}

/** Exact decimal string for a base-unit integer. */
export function formatUnitsExact(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  if (decimals === 0) return `${neg ? "-" : ""}${v}`;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function amount(value: bigint, decimals: number): Amount {
  return { raw: value.toString(), decimals, display: formatUnitsExact(value, decimals) };
}

export const usdg = (v: bigint): Amount => amount(v, 6);
export const tokens18 = (v: bigint): Amount => amount(v, 18);

/**
 * Parse an exact decimal dollar string ("3.75") into base units. Rejects more
 * fractional digits than the token has rather than silently rounding.
 */
export function parseUnitsExact(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new RangeError(`not a non-negative decimal: ${JSON.stringify(value)}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`${value} has more than ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** bps of `part` over `whole`, floored and capped at 10000. 0 when whole is 0. */
export function progressBps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const bps = (part * 10_000n) / whole;
  return Number(bps > 10_000n ? 10_000n : bps);
}

/** A bigint from a DB numeric / bigint column (postgres-js returns strings). */
export function toBigInt(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  const s = v.split(".")[0] ?? "0";
  return BigInt(s === "" || s === "-" ? "0" : s);
}
