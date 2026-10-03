import { describe, expect, test } from "bun:test";
import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { classifyLogError, isFullAlignedChunk, rateLimitDelayMs, retryAfterMs } from "../src/chain/logs.ts";
import {
  ACCRUE_GAS,
  accountReady,
  accrualFrom,
  accrueGasFloor,
  assetState,
  capSweepBatch,
  clampAccrual,
  decideAccrual,
  DYNAMIC_FEE_FLAG,
  easternOffsetSeconds,
  equityMarketOpen,
  equitySessionOpenedAt,
  GAS_STEPS_PCT,
  gasLimit,
  hasConsent,
  impactBps,
  insertRuleEvent,
  limitFromQuote,
  netTotals,
  nextBackoffMs,
  oracleTokensFor,
  poolFeePips,
  priceAt,
  pullableNow,
  quoteVsOracle,
  ruleAt,
  safeToBlock,
  SPLIT_LEAD_SEC,
  splitMix,
  splitPending,
  swapInFor,
  TX_GAS_CAP,
  UnpricedPaymentError,
  withoutAssets,
  type RuleEvent,
} from "../src/keeper/plan.ts";
import { loadConfig } from "../src/keeper/config.ts";

const A = "0x0000000000000000000000000000000000000001" as const;
const B = "0x0000000000000000000000000000000000000002" as const;
const C = "0x0000000000000000000000000000000000000003" as const;
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("keeper plan (mirrors SweepExecutor)", () => {
  test("accrual window starts at the latest of cursor, link and activation", () => {
    expect(accrualFrom(10n, 5n, 7n)).toBe(10n);
    expect(accrualFrom(0n, 50n, 7n)).toBe(50n);
    expect(accrualFrom(0n, 50n, 90n)).toBe(90n);
  });
  test("safe toBlock trails head by buffer + margin", () => {
    expect(safeToBlock(10_000n, 3_000n, 20n)).toBe(6_980n);
    expect(safeToBlock(100n, 3_000n, 20n)).toBe(0n);
  });
  test("clamp takes the tightest bound", () => {
    expect(clampAccrual(78_150_000n, [20_000_000n, 2n ** 160n - 1n, 1_000_000_000n])).toBe(20_000_000n);
    expect(clampAccrual(5n, [])).toBe(5n);
  });
  test("splitMix floors each leg and gives the remainder to the last", () => {
    const s = splitMix(10_000_001n, [
      { asset: A, bps: 6000 },
      { asset: B, bps: 4000 },
    ]);
    expect(s).toEqual([
      { asset: A, usdg: 6_000_000n },
      { asset: B, usdg: 4_000_001n },
    ]);
  });
  test("fee comes off before the swap", () => {
    expect(swapInFor(20_000_000n, 25n)).toBe(19_950_000n);
  });
  test("limit reproduces quote minus tolerance on-chain", () => {
    const swapIn = 7_980_000n;
    const out = 34_956_000_000_000_000n;
    const lim = limitFromQuote(swapIn, out, 50n);
    const minOut = (swapIn * lim) / 1_000_000n;
    expect(minOut).toBeLessThanOrEqual((out * 9_950n) / 10_000n);
    expect(minOut).toBeGreaterThan((out * 9_949n) / 10_000n);
    expect(limitFromQuote(0n, out, 50n)).toBe(0n);
  });
});

describe("consent needs the USDG->Permit2 approval too (calls-01)", () => {
  const base = { erc20Allowance: 10n ** 30n, permit2Amount: 2n ** 160n - 1n, permit2Expiration: 2_000n, now: 1_000n, safetySeconds: 60n };
  test("both approvals live -> consent", () => expect(hasConsent(base)).toBe(true));
  test("revoked ERC-20 approval with a max Permit2 allowance -> no consent", () =>
    expect(hasConsent({ ...base, erc20Allowance: 0n })).toBe(false));
  test("Permit2 amount 0 or expiring within the safety margin -> no consent", () => {
    expect(hasConsent({ ...base, permit2Amount: 0n })).toBe(false);
    expect(hasConsent({ ...base, permit2Expiration: 1_060n })).toBe(false);
  });
  test("a small ERC-20 leftover clamps the pull instead of looping on a revert", () => {
    const d = decideAccrual({ consent: true, delta: 450_000n, bounds: [50_000_000n, 2n ** 160n - 1n, 370_000n, 9_000_000n], wide: false });
    expect(d).toEqual({ kind: "pull", amount: 370_000n });
  });
  test("pullableNow: the least of balance, both allowances and cap room; 0 without consent", () => {
    const p = { consent: true, balance: 9_000_000n, permit2Amount: 2n ** 160n - 1n, erc20Allowance: 370_000n, capRoom: 50_000_000n };
    expect(pullableNow(p)).toBe(370_000n);
    expect(pullableNow({ ...p, balance: 0n })).toBe(0n);
    expect(pullableNow({ ...p, capRoom: 1n })).toBe(1n);
    expect(pullableNow({ ...p, consent: false })).toBe(0n);
  });
});

describe("rule in force at each payment (calls-03 / journey-rule-retroactive)", () => {
  const ev = (blockNumber: bigint, logIndex: number, roundTo: number, multiplier: number, enabled = true, weeklyCap = 50_000_000n): RuleEvent => ({
    blockNumber,
    logIndex,
    roundTo,
    multiplier,
    weeklyCap,
    enabled,
  });
  const h: RuleEvent[] = [];
  insertRuleEvent(h, ev(200n, 5, 10, 5)); // out of order on purpose
  insertRuleEvent(h, ev(100n, 1, 1, 1));
  insertRuleEvent(h, ev(100n, 1, 1, 1)); // duplicate ignored
  insertRuleEvent(h, ev(300n, 0, 1, 1, false));

  test("history is kept sorted and de-duplicated", () => {
    expect(h.map((e) => e.blockNumber)).toEqual([100n, 200n, 300n]);
  });
  test("ruleAt picks the latest RuleSet strictly before the payment, by log index within a block", () => {
    expect(ruleAt(h, 150n, 0)?.multiplier).toBe(1);
    expect(ruleAt(h, 200n, 4)?.multiplier).toBe(1); // same block, earlier log: old rule
    expect(ruleAt(h, 200n, 6)?.multiplier).toBe(5); // same block, later log: new rule
    expect(ruleAt(h, 100n, 1)).toBeNull();
  });
  test("$4.30 paid under $1 x1 stays $0.70 after switching to $10 x5", () => {
    expect(priceAt(h, { amount: 4_300_000n, blockNumber: 150n, logIndex: 0 })).toBe(700_000n);
    expect(priceAt(h, { amount: 4_300_000n, blockNumber: 250n, logIndex: 0 })).toBe(28_500_000n);
  });
  test("a payment under a disabled rule prices at 0", () => {
    expect(priceAt(h, { amount: 4_300_000n, blockNumber: 301n, logIndex: 0 })).toBe(0n);
  });
  test("no rule before the payment refuses to price", () => {
    expect(() => priceAt(h, { amount: 4_300_000n, blockNumber: 50n, logIndex: 0 })).toThrow(UnpricedPaymentError);
  });
});

describe("accrual decision never zero-advances real round-ups (journey-silent-forfeit)", () => {
  const max = 2n ** 160n - 1n;
  test("no consent + payments in a wide window -> hold, not a 0-amount advance", () => {
    expect(decideAccrual({ consent: false, delta: 700_000n, bounds: [max], wide: true })).toEqual({ kind: "hold", reason: "no-consent" });
  });
  test("zero balance + payments in a wide window -> hold", () => {
    expect(decideAccrual({ consent: true, delta: 700_000n, bounds: [max, max, max, 0n], wide: true })).toEqual({
      kind: "hold",
      reason: "clamped-to-zero",
    });
  });
  test("truly idle wide window -> advance; narrow idle window -> hold", () => {
    expect(decideAccrual({ consent: false, delta: 0n, bounds: [], wide: true })).toEqual({ kind: "advance" });
    expect(decideAccrual({ consent: true, delta: 0n, bounds: [], wide: false })).toEqual({ kind: "hold", reason: "narrow" });
  });
  test("consent -> pull the clamped amount", () => {
    expect(decideAccrual({ consent: true, delta: 700_000n, bounds: [max, max, max, 100_000n], wide: false })).toEqual({
      kind: "pull",
      amount: 100_000n,
    });
  });
});

describe("per-wallet backoff", () => {
  test("doubles from the base and caps", () => {
    expect(nextBackoffMs(1, 300_000, 14_400_000)).toBe(300_000);
    expect(nextBackoffMs(2, 300_000, 14_400_000)).toBe(600_000);
    expect(nextBackoffMs(6, 300_000, 14_400_000)).toBe(9_600_000);
    expect(nextBackoffMs(7, 300_000, 14_400_000)).toBe(14_400_000);
    expect(nextBackoffMs(500, 300_000, 14_400_000)).toBe(14_400_000);
  });
});

describe("sweep planning (calls-02 / calls-04)", () => {
  test("a deactivated leg safe-settles regardless of oracle; it never makes the account wait", () => {
    expect(assetState({ eligible: false, oracleStatus: 0, marketOpen: true })).toBe("settle");
    expect(assetState({ eligible: false, oracleStatus: 1, marketOpen: false })).toBe("settle");
    expect(accountReady(["ok", "settle"])).toBe(true);
    expect(accountReady(["settle", "settle"])).toBe(true);
  });
  test("an eligible leg that is not OK, or a closed market, makes the account wait", () => {
    expect(assetState({ eligible: true, oracleStatus: 2, marketOpen: true })).toBe("wait");
    expect(assetState({ eligible: true, oracleStatus: 0, marketOpen: false })).toBe("wait");
    expect(accountReady(["ok", "wait"])).toBe(false);
  });
  test("netTotals only quotes legs that need a quote", () => {
    const t = netTotals(
      [
        { value: 10_000_000n, legs: [{ asset: A, bps: 6000 }, { asset: B, bps: 4000 }] },
        { value: 5_000_000n, legs: [{ asset: A, bps: 10000 }] },
      ],
      (a) => a !== B,
    );
    expect([...t.entries()]).toEqual([[A, 11_000_000n]]);
  });
  test("an unquotable asset drops exactly the accounts holding it, then totals re-net", () => {
    const entries = [
      { value: 10_000_000n, legs: [{ asset: A, bps: 5000 }, { asset: C, bps: 5000 }] },
      { value: 6_000_000n, legs: [{ asset: A, bps: 10000 }] },
    ];
    const left = withoutAssets(entries, new Set([C.toUpperCase().replace("0X", "0x")]));
    expect(left).toHaveLength(1);
    expect([...netTotals(left, () => true).entries()]).toEqual([[A, 6_000_000n]]);
  });
});

describe("many-asset sweeps stay bounded (registry with dozens of assets)", () => {
  const asset = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
  const mix = (...ids: number[]) => ids.map((i) => ({ asset: asset(i), bps: Math.floor(10_000 / ids.length) }));
  test("takes accounts while distinct assets and legs fit; a big mix waits, smaller ones still go", () => {
    const entries = [
      { id: 1, legs: mix(1, 2, 3, 4, 5, 6) },
      { id: 2, legs: mix(7, 8, 9, 10, 11, 12) }, // would make 12 assets > 10
      { id: 3, legs: mix(1, 2) }, // already counted assets
      { id: 4, legs: mix(13, 14, 15, 16) }, // 6 + 4 = 10 assets: fits
    ];
    const r = capSweepBatch(entries, { maxAssets: 10, maxLegs: 100 });
    expect(r.batch.map((e) => e.id)).toEqual([1, 3, 4]);
    expect(r.waiting).toBe(1);
  });
  test("the leg cap counts every account leg; the first account always goes", () => {
    const entries = [{ id: 1, legs: mix(1, 2, 3, 4, 5, 6) }, { id: 2, legs: mix(1, 2, 3, 4, 5, 6) }];
    expect(capSweepBatch(entries, { maxAssets: 50, maxLegs: 8 }).batch.map((e) => e.id)).toEqual([1]);
    expect(capSweepBatch(entries, { maxAssets: 1, maxLegs: 1 }).batch.map((e) => e.id)).toEqual([1]);
  });
  test("64 accounts x 6 legs over 30 assets is split, never sent as one oversized sweep", () => {
    const entries = Array.from({ length: 64 }, (_, k) => ({ id: k, legs: mix(...[0, 1, 2, 3, 4, 5].map((j) => ((k * 5 + j) % 30) + 1)) }));
    const r = capSweepBatch(entries, { maxAssets: 16, maxLegs: 192 });
    const assets = new Set(r.batch.flatMap((e) => e.legs.map((l) => l.asset)));
    expect(assets.size).toBeLessThanOrEqual(16);
    expect(r.batch.reduce((n, e) => n + e.legs.length, 0)).toBeLessThanOrEqual(192);
    expect(r.batch.length + r.waiting).toBe(64);
  });
});

describe("keeper config: market-hours exemptions come from config, not a token list", () => {
  const PK = `0x${"11".repeat(32)}`;
  test("empty by default; comma-separated addresses, case-insensitive", () => {
    expect(loadConfig({ KEEPER_PK: PK }).MARKET_GATE_EXEMPT.size).toBe(0);
    const cfg = loadConfig({ KEEPER_PK: PK, MARKET_GATE_EXEMPT: `${asset24(1)}, ${asset24(2).toUpperCase().replace("0X", "0x")}` });
    expect([...cfg.MARKET_GATE_EXEMPT]).toEqual([asset24(1), asset24(2)]);
    expect(() => loadConfig({ KEEPER_PK: PK, MARKET_GATE_EXEMPT: "SPY" })).toThrow();
    expect(loadConfig({ KEEPER_PK: PK }).SWEEP_MAX_ASSETS).toBe(16);
  });
});

function asset24(i: number): string {
  return `0x${i.toString(16).padStart(40, "a")}`;
}

describe("US-equity market hours (24/5, Sun 20:00 ET -> Fri 20:00 ET)", () => {
  test("Eastern offset flips on the US DST Sundays", () => {
    expect(easternOffsetSeconds(utc("2026-03-08T06:59:59Z"))).toBe(-5 * 3600);
    expect(easternOffsetSeconds(utc("2026-03-08T07:00:00Z"))).toBe(-4 * 3600);
    expect(easternOffsetSeconds(utc("2026-11-01T05:59:59Z"))).toBe(-4 * 3600);
    expect(easternOffsetSeconds(utc("2026-11-01T06:00:00Z"))).toBe(-5 * 3600);
  });
  test("session opens Sunday 20:00 ET and closes Friday 20:00 ET (EDT)", () => {
    const open = utc("2026-09-28T00:00:00Z"); // Sun 2026-09-27 20:00 EDT
    expect(equitySessionOpenedAt(open - 1)).toBeNull();
    expect(equitySessionOpenedAt(open)).toBe(open);
    expect(equitySessionOpenedAt(utc("2026-09-30T12:00:00Z"))).toBe(open);
    expect(equitySessionOpenedAt(utc("2026-10-02T23:59:59Z"))).toBe(open); // Fri 19:59:59 EDT
    expect(equitySessionOpenedAt(utc("2026-10-03T00:00:00Z"))).toBeNull(); // Fri 20:00 EDT
    expect(equitySessionOpenedAt(utc("2026-10-03T12:00:00Z"))).toBeNull(); // Saturday
  });
  test("winter (EST) boundaries are an hour later in UTC", () => {
    expect(equitySessionOpenedAt(utc("2026-12-07T00:30:00Z"))).toBeNull(); // Sun 19:30 EST
    expect(equitySessionOpenedAt(utc("2026-12-07T01:00:00Z"))).toBe(utc("2026-12-07T01:00:00Z"));
    expect(equitySessionOpenedAt(utc("2026-12-12T00:59:59Z"))).not.toBeNull(); // Fri 19:59:59 EST
    expect(equitySessionOpenedAt(utc("2026-12-12T01:00:00Z"))).toBeNull();
  });
  test("mainnet SPY feed: the frozen Friday price is not swept over the weekend", () => {
    // Round 146: Fri 2026-09-25 16:03:00 UTC; round 147: Mon 2026-09-28 00:00:40 UTC.
    const fri = utc("2026-09-25T16:03:00Z");
    expect(equityMarketOpen(utc("2026-09-25T20:00:00Z"), fri)).toBe(true); // Friday, session still open
    expect(equityMarketOpen(utc("2026-09-26T10:00:00Z"), fri)).toBe(false); // Saturday: OracleGuard still says OK
    expect(equityMarketOpen(utc("2026-09-28T00:10:00Z"), utc("2026-09-28T00:00:40Z"))).toBe(true);
  });
  test("holiday Monday (Labor Day 2026-09-07): no feed post since the open -> closed", () => {
    const lastFri = utc("2026-09-04T15:12:39Z");
    expect(equityMarketOpen(utc("2026-09-07T15:00:00Z"), lastFri)).toBe(false);
    expect(equityMarketOpen(utc("2026-09-08T01:00:00Z"), utc("2026-09-08T00:00:51Z"))).toBe(true);
  });
});

describe("getLogs error classification (journey-429-treated-as-result-cap)", () => {
  test("HTTP 429 'Too Many Requests' is a rate limit, not a result cap", () => {
    const e = new HttpRequestError({
      url: "https://rpc.example",
      status: 429,
      details: JSON.stringify({ code: 429, message: "Too Many Requests" }),
      headers: new Headers({ "retry-after": "3" }),
    });
    expect(classifyLogError(e)).toBe("rate-limit");
    expect(classifyLogError(new Error("wrapped", { cause: e }))).toBe("rate-limit");
    expect(retryAfterMs(new Error("wrapped", { cause: e }))).toBe(3_000);
  });
  test("a bare 'Too Many Requests' message (HTTP/1.1 reason phrase) is a rate limit", () => {
    expect(classifyLogError(new Error("HTTP request failed. Details: Too Many Requests"))).toBe("rate-limit");
  });
  test("the RPC's real result cap still splits", () => {
    const e = new RpcRequestError({
      body: {},
      url: "https://rpc.example",
      error: { code: -32602, message: "logs matched by query exceeds limit of 10000" },
    });
    expect(classifyLogError(e)).toBe("result-cap");
    expect(classifyLogError(new Error("query returned more than 10000 results"))).toBe("result-cap");
  });
  test("-32005 is a result cap only when the message says so", () => {
    const cap = new RpcRequestError({ body: {}, url: "u", error: { code: -32005, message: "query returned more than 10000 results" } });
    const lim = new RpcRequestError({ body: {}, url: "u", error: { code: -32005, message: "limit exceeded" } });
    expect(classifyLogError(cap)).toBe("result-cap");
    expect(classifyLogError(lim)).toBe("rate-limit");
  });
  test("timeouts and other failures are neither", () => {
    expect(classifyLogError(new TimeoutError({ body: {}, url: "u" }))).toBe("other");
  });
  test("backoff honours Retry-After, else doubles, and is capped", () => {
    expect(rateLimitDelayMs(0, 3_000)).toBe(3_000);
    expect(rateLimitDelayMs(0, null)).toBe(1_000);
    expect(rateLimitDelayMs(3, null)).toBe(8_000);
    expect(rateLimitDelayMs(10, null)).toBe(30_000);
  });
});

describe("log cache keys (keeper-held-window-cache-bloat)", () => {
  test("only fully aligned chunks are cacheable; a moving tail never is", () => {
    const size = 2_000_000n;
    expect(isFullAlignedChunk({ from: 76_000_000n, to: 77_999_999n }, size)).toBe(true);
    expect(isFullAlignedChunk({ from: 76_000_000n, to: 76_240_000n }, size)).toBe(false);
    expect(isFullAlignedChunk({ from: 76_000_001n, to: 77_999_999n }, size)).toBe(false);
  });
});

describe("ERC-8056 multiplier changes (splits / dividend re-invests)", () => {
  // Mainnet SGOV (2026-10-01): effectiveAt 00:10:35 UTC; the feed's session-open post was 00:00:40.
  const eff = utc("2026-10-01T00:10:35Z");
  const m = { uiMultiplier: 1_007_186_931_447_954_063n, newUIMultiplier: 1_007_186_931_447_954_063n };
  test("in force, feed not posted since effectiveAt -> pending (the router would price the old multiplier)", () => {
    expect(splitPending({ ...m, now: eff + 60, effectiveAt: eff, feedUpdatedAt: utc("2026-10-01T00:00:40Z") })).toBe(true);
  });
  test("any feed post at or after effectiveAt clears it", () => {
    expect(splitPending({ ...m, now: utc("2026-10-02T04:34:40Z"), effectiveAt: eff, feedUpdatedAt: utc("2026-10-01T22:42:05Z") })).toBe(false);
    expect(splitPending({ ...m, now: eff + 5, effectiveAt: eff, feedUpdatedAt: eff })).toBe(false);
  });
  test("never scheduled (effectiveAt 0, e.g. TSLA) -> not pending", () => {
    expect(splitPending({ uiMultiplier: 10n ** 18n, newUIMultiplier: 10n ** 18n, now: eff, effectiveAt: 0, feedUpdatedAt: 0 })).toBe(false);
  });
  test("a scheduled change pauses buys from SPLIT_LEAD_SEC before it, not earlier", () => {
    const split = { uiMultiplier: 10n ** 18n, newUIMultiplier: 10n * 10n ** 18n, effectiveAt: eff, feedUpdatedAt: eff - 600 };
    expect(splitPending({ ...split, now: eff - SPLIT_LEAD_SEC })).toBe(true);
    expect(splitPending({ ...split, now: eff - SPLIT_LEAD_SEC - 1 })).toBe(false);
    expect(splitPending({ ...split, newUIMultiplier: split.uiMultiplier, now: eff - 60 })).toBe(false); // nothing changes
  });
  test("a pending change makes the asset wait, so the account keeps its epoch", () => {
    expect(assetState({ eligible: true, oracleStatus: 0, marketOpen: true, splitPending: true })).toBe("wait");
    expect(assetState({ eligible: true, oracleStatus: 0, marketOpen: true, splitPending: false })).toBe("ok");
    expect(assetState({ eligible: false, oracleStatus: 0, marketOpen: true, splitPending: true })).toBe("settle");
  });
});

describe("pool swap fee for the oracle check (v4 ProtocolFeeLibrary.calculateSwapFee)", () => {
  // slot0 read on mainnet 2026-10-02 via StateView.getSlot0.
  test("static pool: PoolKey fee + the directional protocol fee", () => {
    // NVDA fee-100 pool, protocolFee 102425 = 25 | 25 << 12; USDG is currency0 (zeroForOne).
    expect(poolFeePips({ keyFee: 100, zeroForOne: true, slot0: { protocolFee: 102_425, lpFee: 100 } })).toBe(125);
    // AAPL fee-3000 pool, protocolFee 2048500 = 500 | 500 << 12: 500 + 3000 - floor(500*3000/1e6).
    expect(poolFeePips({ keyFee: 3000, zeroForOne: true, slot0: { protocolFee: 2_048_500, lpFee: 3000 } })).toBe(3499);
    // Direction matters: oneForZero takes the upper 12 bits.
    expect(poolFeePips({ keyFee: 500, zeroForOne: false, slot0: { protocolFee: 7 | (125 << 12), lpFee: 500 } })).toBe(625);
  });
  test("dynamic-fee (hooked) pool: the LP fee is slot0's, not the 0x800000 flag", () => {
    expect(poolFeePips({ keyFee: DYNAMIC_FEE_FLAG, zeroForOne: false, slot0: { protocolFee: 0, lpFee: 3000 } })).toBe(3000);
    expect(poolFeePips({ keyFee: DYNAMIC_FEE_FLAG, zeroForOne: false, slot0: { protocolFee: 0, lpFee: 0 } })).toBe(0); // GME today
  });
  test("an unread slot0 counts no protocol / dynamic fee: only ever a tighter check", () => {
    expect(poolFeePips({ keyFee: 3000, zeroForOne: true })).toBe(3000);
    expect(poolFeePips({ keyFee: DYNAMIC_FEE_FLAG, zeroForOne: true })).toBe(0);
  });
});

describe("quote vs oracle (B-L3)", () => {
  const price = 180n * 10n ** 18n;
  const swapIn = 7_980_000n;
  const fair = oracleTokensFor(swapIn, price);
  const under = (bps: bigint) => (fair * (10_000n - bps)) / 10_000n;
  test("allowed: up to the pool fee + allowance under the oracle; better than the oracle always", () => {
    expect(quoteVsOracle({ swapIn, quotedOut: under(30n), price1e18: price, feePips: 100, allowanceBps: 30 }).ok).toBe(true);
    expect(quoteVsOracle({ swapIn, quotedOut: under(32n), price1e18: price, feePips: 100, allowanceBps: 30 }).ok).toBe(false);
    expect(quoteVsOracle({ swapIn, quotedOut: (fair * 10_050n) / 10_000n, price1e18: price, feePips: 100, allowanceBps: 30 }).ok).toBe(true);
  });
  test("a flat 30 bps would hold every 1% pool for good; fee + 30 does not", () => {
    expect(quoteVsOracle({ swapIn, quotedOut: under(115n), price1e18: price, feePips: 0, allowanceBps: 30 }).ok).toBe(false);
    const r = quoteVsOracle({ swapIn, quotedOut: under(115n), price1e18: price, feePips: 10_000, allowanceBps: 30 });
    expect(r).toEqual({ ok: true, shortfallBps: 115, maxBps: 130 });
  });
  test("no oracle price never passes", () => {
    expect(quoteVsOracle({ swapIn, quotedOut: fair, price1e18: 0n, feePips: 100, allowanceBps: 30 }).ok).toBe(false);
  });
  test("oracleTokensFor matches StockRouter.oracleTokensFor (USDG 6 dp -> 18 dp tokens)", () => {
    expect(oracleTokensFor(180_000_000n, price)).toBe(10n ** 18n);
  });
});

describe("price impact vs a $1 reference quote", () => {
  const ref = { swapIn: 1_000_000n, out: 5_555_000_000_000_000n };
  test("fee cancels; impact rounds up; a better fill is 0", () => {
    expect(impactBps(ref, 1_000_000_000n, (ref.out * 1000n * 9_888n) / 10_000n)).toBe(112);
    expect(impactBps(ref, 1_000_000_000n, (ref.out * 1000n * 98_885n) / 100_000n)).toBe(112);
    expect(impactBps(ref, 2_000_000n, ref.out * 2n)).toBe(0);
    expect(impactBps(ref, 2_000_000n, ref.out * 3n)).toBe(0);
  });
  test("an unusable reference is infinite impact (never 'fits')", () => {
    expect(impactBps({ swapIn: 1_000_000n, out: 0n }, 5_000_000n, 1n)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("keeper config: A-M1 / B-L2 / B-L3 knobs", () => {
  const PK = `0x${"11".repeat(32)}`;
  test("defaults", () => {
    const c = loadConfig({ KEEPER_PK: PK });
    expect([c.SWEEP_MAX_IMPACT_BPS, c.QUOTE_ORACLE_ALLOWANCE_BPS, c.QUOTE_MAX_SHORTFALL_BPS, c.SWEEP_MAX_CALLS]).toEqual([30, 60, 120, 4]);
    expect([c.SCAN_WALLET_MAX_CALLS, c.SCAN_WALLET_MAX_LOGS, c.SCAN_WALLET_DEADLINE_MS, c.SCAN_TICK_DEADLINE_MS]).toEqual([64, 5_000, 45_000, 120_000]);
    expect(c.HEALTH_TOKEN).toBeUndefined();
  });
  test("bounds: the impact cap and allowance never exceed the router's 150 bps band; a short health token is refused", () => {
    expect(() => loadConfig({ KEEPER_PK: PK, SWEEP_MAX_IMPACT_BPS: "151" })).toThrow();
    expect(() => loadConfig({ KEEPER_PK: PK, QUOTE_ORACLE_ALLOWANCE_BPS: "151" })).toThrow();
    expect(() => loadConfig({ KEEPER_PK: PK, HEALTH_TOKEN: "short" })).toThrow();
    expect(loadConfig({ KEEPER_PK: PK, HEALTH_TOKEN: "x".repeat(32) }).HEALTH_TOKEN).toBe("x".repeat(32));
  });
});

describe("keeper tx gas limits", () => {
  test("estimate x step, rounded up; never under the floor; capped, but never under the estimate itself", () => {
    expect(GAS_STEPS_PCT).toEqual([150, 200, 300]);
    expect(gasLimit({ estimate: 228_722n, pct: 150 })).toBe(343_083n);
    expect(gasLimit({ estimate: 100_000n, pct: 150, floor: 210_000n })).toBe(210_000n);
    expect(gasLimit({ estimate: 200_000n, pct: 200, floor: 210_000n })).toBe(400_000n);
    expect(gasLimit({ estimate: 24_000_000n, pct: 150 })).toBe(TX_GAS_CAP);
    expect(gasLimit({ estimate: 31_000_000n, pct: 150 })).toBe(31_000_000n);
  });
  test("an accrueBatch floor: a base, then a pull or an advance per entry", () => {
    expect(accrueGasFloor([])).toBe(ACCRUE_GAS.base);
    expect(accrueGasFloor([6_630_000n, 0n, 1n])).toBe(ACCRUE_GAS.base + 2n * ACCRUE_GAS.pull + ACCRUE_GAS.advance);
    expect(accrueGasFloor(Array.from({ length: 64 }, () => 1n))).toBeLessThan(TX_GAS_CAP);
  });
});
