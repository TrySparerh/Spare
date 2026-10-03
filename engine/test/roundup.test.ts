import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  RoundUpError,
  USDG_UNIT,
  applyRollingWeeklyCap,
  dayIndex,
  roundUpDelta,
  sumDeltas,
  weekIndex,
} from "../src/lib/roundup.ts";
import { formatUnitsExact, parseUnitsExact, progressBps, usdg } from "../src/lib/units.ts";

const $ = (s: string) => parseUnitsExact(s, 6);

describe("acceptance (1): $3.75 payment", () => {
  test("-> $0.25 at 1x", () => expect(roundUpDelta($("3.75"), 1, 1)).toBe(250_000n));
  test("-> $0.75 at 3x", () => expect(roundUpDelta($("3.75"), 1, 3)).toBe(750_000n));
});

/** [amount, roundTo, multiplier, expected delta] in dollars — same vectors as SpareFork.t.sol + boundaries. */
const TABLE: [string, 1 | 5 | 10, number, string][] = [
  // contract fork-test vectors
  ["3.75", 1, 1, "0.25"],
  ["3.75", 1, 3, "0.75"],
  ["5", 1, 1, "0"],
  ["12.4", 5, 1, "2.6"],
  ["12.4", 10, 1, "7.6"],
  // exactly on a boundary -> zero, at every multiplier
  ["1", 1, 5, "0"],
  ["10", 5, 1, "0"],
  ["10", 10, 3, "0"],
  ["20", 5, 5, "0"],
  ["100", 10, 1, "0"],
  // one base unit either side of a boundary
  ["4.999999", 1, 1, "0.000001"],
  ["5.000001", 1, 1, "0.999999"],
  ["5.000001", 5, 1, "4.999999"],
  ["9.999999", 10, 2, "0.000002"],
  ["0.000001", 1, 1, "0.999999"],
  ["0.000001", 10, 5, "49.999995"],
  // zero payment
  ["0", 1, 1, "0"],
  ["0", 10, 5, "0"],
  // frontend spec vectors
  ["4.25", 1, 1, "0.75"],
  ["4.25", 1, 4, "3"],
  ["4.9", 1, 5, "0.5"],
];

describe("boundary table", () => {
  for (const [amt, to, m, want] of TABLE) {
    test(`$${amt} to $${to} at ${m}x = $${want}`, () => {
      const d = roundUpDelta($(amt), to, m);
      expect(d).toBe($(want));
      expect(formatUnitsExact(d, 6)).toBe(want);
    });
  }

  test("delta is always in [0, step*multiplier) and zero exactly on the boundary", () => {
    for (const to of [1, 5, 10] as const) {
      const step = BigInt(to) * USDG_UNIT;
      for (let m = 1; m <= 5; m++) {
        for (const a of [1n, 7n, step - 1n, step, step + 1n, 3n * step, 3n * step + 123_456n]) {
          const d = roundUpDelta(a, to, m);
          expect(d >= 0n && d < step * BigInt(m)).toBe(true);
          expect(d === 0n).toBe(a % step === 0n);
          if (d !== 0n) expect((a + d / BigInt(m)) % step).toBe(0n);
        }
      }
    }
  });
});

describe("validation mirrors RoundUp.sol", () => {
  test("roundTo must be 1, 5 or 10", () => {
    for (const bad of [0, 2, 3, 4, 6, 20, 100]) {
      expect(() => roundUpDelta(1n, bad, 1)).toThrow(RoundUpError);
    }
  });
  test("multiplier must be 1..5", () => {
    for (const bad of [0, 6, 255, 1.5]) expect(() => roundUpDelta(1n, 1, bad)).toThrow(RoundUpError);
  });
  test("roundTo is checked before multiplier (same revert order as the contract)", () => {
    try {
      roundUpDelta(1n, 3, 9);
      throw new Error("no throw");
    } catch (e) {
      expect((e as RoundUpError).code).toBe("BadRoundTo");
    }
  });
  test("negative amounts are rejected (uint256 on-chain)", () => {
    expect(() => roundUpDelta(-1n, 1, 1)).toThrow(RoundUpError);
  });
  test("validation applies even to a zero amount (the contract checks first)", () => {
    expect(() => roundUpDelta(0n, 2, 1)).toThrow(RoundUpError);
  });
});

// ---------------------------------------------------------------------------
// Parity with the frontend's roundUpDelta (src/lib/spare.ts), imported for real.
// The module imports i18next from the site's own node_modules, so the parity
// check needs the root `npm ci` too; without it (an engine-only checkout or
// image) it is skipped rather than failed.
// ---------------------------------------------------------------------------
const FRONTEND = resolve(import.meta.dir, "../../src/lib/spare.ts");
const FRONTEND_DEPS = resolve(import.meta.dir, "../../node_modules/i18next");
const hasFrontend = existsSync(FRONTEND) && existsSync(FRONTEND_DEPS);

describe.skipIf(!hasFrontend)("parity with the frontend roundUpDelta", () => {
  // The frontend now does the same bigint base-unit math as RoundUp.sol, so the
  // two must agree EXACTLY — including sub-cent payments.
  type Fe = { roundUpDelta: (a: bigint, b: number, m: number) => bigint };
  const load = async () => {
    const path = FRONTEND; // variable: keep tsc from type-checking the browser module
    return (await import(path)) as Fe;
  };

  test("every cent from $0.01 to $100.00, every roundTo, every multiplier", async () => {
    const fe = await load();
    let checked = 0;
    const mismatches: string[] = [];
    for (let cents = 1; cents <= 10_000; cents++) {
      const base = BigInt(cents) * 10_000n;
      for (const to of [1, 5, 10] as const) {
        for (const m of [1, 2, 3, 4, 5] as const) {
          const engine = roundUpDelta(base, to, m);
          const front = fe.roundUpDelta(base, to, m);
          if (front !== engine && mismatches.length < 10) {
            mismatches.push(`${formatUnitsExact(base, 6)} to ${to} x${m}: engine ${formatUnitsExact(engine, 6)} vs frontend ${formatUnitsExact(front, 6)}`);
          }
          checked++;
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(150_000);
  });

  test("acceptance vectors agree in both", async () => {
    const fe = await load();
    expect(fe.roundUpDelta($("3.75"), 1, 1)).toBe(250_000n);
    expect(fe.roundUpDelta($("3.75"), 1, 3)).toBe(750_000n);
    expect(roundUpDelta($("3.75"), 1, 1)).toBe(250_000n);
    expect(roundUpDelta($("3.75"), 1, 3)).toBe(750_000n);
  });

  test("sub-cent payments agree to the base unit", async () => {
    const fe = await load();
    expect(roundUpDelta($("3.755"), 1, 1)).toBe(245_000n);
    expect(fe.roundUpDelta($("3.755"), 1, 1)).toBe(245_000n);
    expect(fe.roundUpDelta($("4.123456"), 5, 2)).toBe(roundUpDelta($("4.123456"), 5, 2));
  });
});

describe("weekly cap (SweepExecutor semantics: rolling 7 UTC days)", () => {
  test("week index is floor(ts / 604800) (display only)", () => {
    expect(weekIndex(0)).toBe(0n);
    expect(weekIndex(604_799)).toBe(0n);
    expect(weekIndex(604_800)).toBe(1n);
  });
  test("day index is floor(ts / 86400), the executor's cap bucket", () => {
    expect(dayIndex(86_399)).toBe(0n);
    expect(dayIndex(86_400)).toBe(1n);
  });
  test("cap is never exceeded within any 7-day window; excess is dropped", () => {
    const r = applyRollingWeeklyCap(
      [
        { day: 10n, delta: $("30") },
        { day: 10n, delta: $("25") },
        { day: 11n, delta: $("5") },
      ],
      $("50"),
    );
    expect(r.days.map((d) => d.accepted)).toEqual([$("50"), 0n]);
    expect(r.accepted).toBe($("50"));
    expect(r.dropped).toBe($("10"));
  });
  test("calendar-week boundary does not reset the cap (Wed + Thu = one rolling window)", () => {
    // 1970-01-07 is a Wednesday (day 6), 1970-01-08 a Thursday (day 7, a new calendar week).
    expect(weekIndex(6 * 86_400)).not.toBe(weekIndex(7 * 86_400));
    const r = applyRollingWeeklyCap(
      [
        { day: 6n, delta: $("10") },
        { day: 7n, delta: $("10") },
      ],
      $("10"),
    );
    expect(r.accepted).toBe($("10"));
    expect(r.dropped).toBe($("10"));
  });
  test("a day's pulls roll off after 7 days", () => {
    const r = applyRollingWeeklyCap(
      [
        { day: 0n, delta: $("10") },
        { day: 6n, delta: $("10") },
        { day: 7n, delta: $("10") },
      ],
      $("10"),
    );
    expect(r.days.map((d) => d.accepted)).toEqual([$("10"), 0n, $("10")]);
  });
  test("a zero cap lets nothing through", () => {
    expect(applyRollingWeeklyCap([{ day: 1n, delta: 5n }], 0n).accepted).toBe(0n);
  });
  test("prior on-chain pulls inside the window reduce the room", () => {
    const r = applyRollingWeeklyCap([{ day: 7n, delta: $("10") }], $("50"), new Map([[3n, $("45")]]));
    expect(r.accepted).toBe($("5"));
    const later = applyRollingWeeklyCap([{ day: 10n, delta: $("10") }], $("50"), new Map([[3n, $("45")]]));
    expect(later.accepted).toBe($("10"));
  });
  test("sumDeltas", () => {
    expect(sumDeltas([$("3.75"), $("4.25"), $("5")], 1, 1)).toBe($("1"));
  });
});

describe("units", () => {
  test("exact formatting, no float", () => {
    expect(usdg(250_000n)).toEqual({ raw: "250000", decimals: 6, display: "0.25" });
    expect(formatUnitsExact(123_456_789_012_345_678_901n, 18)).toBe("123.456789012345678901");
    expect(formatUnitsExact(0n, 6)).toBe("0");
    expect(formatUnitsExact(-1_500_000n, 6)).toBe("-1.5");
  });
  test("parse rejects excess precision instead of rounding", () => {
    expect(() => parseUnitsExact("1.0000001", 6)).toThrow();
    expect(parseUnitsExact("1.5", 6)).toBe(1_500_000n);
  });
  test("progress bps floors and caps", () => {
    expect(progressBps(2_500_000n, 5_000_000n)).toBe(5000);
    expect(progressBps(9_000_000n, 5_000_000n)).toBe(10_000);
    expect(progressBps(1n, 0n)).toBe(0);
  });
});
