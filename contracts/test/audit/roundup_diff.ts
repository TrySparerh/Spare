import { roundUpDelta } from "../../../src/lib/spare.ts";

// Exact port of contracts/src/libraries/RoundUp.sol (USDG base units, 6dp)
function solDelta(amount: bigint, roundTo: bigint, mult: bigint): bigint {
  if (amount === 0n) return 0n;
  const step = roundTo * 1_000_000n;
  const rem = amount % step;
  if (rem === 0n) return 0n;
  return (step - rem) * mult;
}
// How an engine would feed spare.ts: USD float in, USD float out, back to base units.
function tsDeltaUnits(amount: bigint, base: 1|5|10, mult: 1|2|3|4|5): bigint {
  const usd = Number(amount) / 1e6;
  return BigInt(Math.round(roundUpDelta(usd, base, mult) * 1e6));
}

// 1) whole-cent sweep: $0.01 .. $2000.00, all bases and multipliers
let centMismatch = 0, centChecked = 0; const centExamples: string[] = [];
for (let cents = 1n; cents <= 200_000n; cents++) {
  const amt = cents * 10_000n;
  for (const b of [1, 5, 10] as const) for (const m of [1, 2, 3, 4, 5] as const) {
    centChecked++;
    const s = solDelta(amt, BigInt(b), BigInt(m)); const t = tsDeltaUnits(amt, b, m);
    if (s !== t) { centMismatch++; if (centExamples.length < 5) centExamples.push(`${amt} b${b} m${m}: sol=${s} ts=${t}`); }
  }
}
console.log(`whole-cent inputs: checked=${centChecked} mismatches=${centMismatch}`, centExamples);

// 2) sub-cent inputs (USDG has 6 decimals)
const cases: [bigint, 1|5|10, 1|2|3|4|5][] = [
  [3_751_234n, 1, 1], [3_751_234n, 1, 3], [4_999_999n, 1, 1], [4_999_999n, 5, 5],
  [5_000_001n, 1, 1], [3_745_000n, 1, 1], [3_749_999n, 1, 1], [12_345_678n, 10, 5], [1n, 1, 1], [9_995_000n, 10, 2],
];
for (const [a, b, m] of cases) {
  const s = solDelta(a, BigInt(b), BigInt(m)); const t = tsDeltaUnits(a, b, m);
  console.log(`amount=${a} roundTo=${b} mult=${m}  RoundUp.delta=${s}  spare.ts=${t}  diff=${t - s}`);
}
// 3) random 6dp amounts
let rnd = 0, rndMis = 0, maxAbs = 0n; let seed = 12345;
const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
for (let i = 0; i < 200000; i++) {
  const a = BigInt(r()) % 1_000_000_000n + 1n; // up to $1000
  const b = ([1, 5, 10] as const)[r() % 3]; const m = ((r() % 5) + 1) as 1|2|3|4|5;
  rnd++; const d = tsDeltaUnits(a, b, m) - solDelta(a, BigInt(b), BigInt(m));
  if (d !== 0n) { rndMis++; const ad = d < 0n ? -d : d; if (ad > maxAbs) maxAbs = ad; }
}
console.log(`random 6dp inputs: checked=${rnd} mismatches=${rndMis} maxAbsDiff=${maxAbs} base units`);
