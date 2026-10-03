#!/usr/bin/env bun
/**
 * keeper-e2e — the whole S1 loop on a local anvil fork of RHC mainnet
 * (scripts/dev-fork.sh), driven by the REAL keeper code:
 *
 *   link -> rule -> Permit2 consent -> real USDG payments -> finality ->
 *   keeper accrue -> keeper sweep (v4 quote limits) -> stock tokens delivered
 *
 * plus, against the real pools and feeds:
 *   - a linked wallet over its scan budget is skipped; the others accrue (B-L2)
 *   - a whale co-due with alice is swept in a call of its own, so alice's NVDA
 *     limit is quoted on her leg alone (A-M1), and the whale's own quote, far
 *     under the oracle, is held instead of becoming a limit (B-L3), all at the
 *     production QUOTE_ORACLE_ALLOWANCE_BPS
 *   - every keeper tx goes out with gas headroom over what it used (no entry
 *     skipped, no swap deferred, for want of gas)
 *
 * Keys are anvil's PUBLIC default test keys. Never point this at mainnet.
 * ANVIL_PORT selects the local fork (default 8545, as scripts/dev-fork.sh), and
 * ADDRESSES_FILE its address book (default ../contracts/addresses/31337.json,
 * where scripts/dev-fork.sh writes it).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint160,
  maxUint256,
  parseAbi,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cashParkAbi, electionRegistryAbi, permit2Abi, ruleRegistryAbi, sweepExecutorAbi } from "../src/chain/abis.ts";
import { PERMIT2, TOKENS, USDG } from "../src/chain/constants.ts";
import { loadBook, loadConfig } from "../src/keeper/config.ts";
import { Keeper, fmtUsdg } from "../src/keeper/keeper.ts";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8545"}`;
const KEYS = {
  keeper: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  alice: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  bob: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  mallory: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  spammer: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
} as const;
/** A large plain-EOA USDG holder on mainnet (scripts/lib/common.sh), impersonated on the fork. */
const USDG_WHALE: Address = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
/** Mallory's park: big enough that her NVDA leg alone moves the pool far past the 30 bps impact cap. */
const WHALE_USDG = 25_000_000_000n;
const SPAM_TRANSFERS = 120;
const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const chain = { id: 31337, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
// anvil pulls mainnet state lazily on first touch (a whale-sized quote walks many ticks): allow it time.
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
if ((await pub.getChainId()) !== 31337) throw new Error("not the local dev fork");

const cfg = loadConfig({
  CHAIN_ID: "31337",
  RPC_URL: RPC,
  KEEPER_PK: KEYS.keeper,
  KEEPER_BROADCAST: "1",
  ADDRESSES_FILE: process.env.ADDRESSES_FILE ?? "../contracts/addresses/31337.json",
  LOGS_MAX_RANGE: "100000",
  // The spam wallet's 120 transfers overrun this; alice's and bob's 3 each do not.
  SCAN_WALLET_MAX_LOGS: "100",
  // QUOTE_ORACLE_ALLOWANCE_BPS stays at its default (60): the fork inherits
  // whatever drift mainnet pools have from feeds that post only on a 50 bps
  // move, and alice's small legs must trade at production settings, while
  // mallory's ~100+ bps of her own impact stays far over the 120 bps cap.
});
const book = loadBook(cfg);
const keeper = new Keeper(cfg, book);

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  [ok]  " : "  [FAIL]"} ${what}`);
  if (!ok) failures++;
}

async function as(key: `0x${string}`, address: Address, abi: any, functionName: string, args: unknown[]) {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ account, chain, transport: http(RPC) });
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account } as never);
  const hash = await w.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

/** Send as an address anvil impersonates (fork only). */
async function asImpersonated(from: Address, address: Address, abi: any, functionName: string, args: unknown[]) {
  await pub.request({ method: "anvil_impersonateAccount" as never, params: [from] as never });
  await pub.request({ method: "anvil_setBalance" as never, params: [from, "0xDE0B6B3A7640000"] as never });
  const w = createWalletClient({ chain, transport: http(RPC) });
  const hash = await w.writeContract({ address, abi, functionName, args, account: from } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  await pub.request({ method: "anvil_stopImpersonatingAccount" as never, params: [from] as never });
  if (r.status !== "success") throw new Error(`${functionName} as ${from} reverted`);
}

const alice = privateKeyToAccount(KEYS.alice).address;
const bob = privateKeyToAccount(KEYS.bob).address;
const mallory = privateKeyToAccount(KEYS.mallory).address;
const spammer = privateKeyToAccount(KEYS.spammer).address;
const merchant: Address = "0x000000000000000000000000000000000000bEEF";
const spamSink: Address = "0x0000000000000000000000000000000000005a5a";
const now = Math.floor(Date.now() / 1000);

// What alice's NVDA leg would get inside ONE swap netted with mallory's (the
// old keeper). Quoted now: nothing trades these pools on the fork before the
// sweep, and quoting the whale-sized swap first also pulls the pool state into
// anvil's cache while the public RPC still serves the fork block (~10 min).
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const registryGetAbi = parseAbi([
  "function get(address) view returns ((address token, address feed, uint8 feedDecimals, uint32 heartbeat, uint16 bandBps, bool active, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey))",
]);
type Key = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
async function quote(token: Address, usdgIn: bigint): Promise<bigint> {
  const { poolKey } = (await pub.readContract({ address: book.assetRegistry, abi: registryGetAbi, functionName: "get", args: [token] })) as { poolKey: Key };
  const { result } = await pub.simulateContract({
    address: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey, zeroForOne: poolKey.currency0.toLowerCase() === USDG.toLowerCase(), exactAmount: usdgIn, hookData: "0x" }],
  });
  return result[0];
}
const aliceNvdaGross = 8_000_000n; // 40% of $20 (default mix)
const nettedQuote = await quote(TOKENS.NVDA, ((WHALE_USDG + aliceNvdaGross) * 9_975n) / 10_000n);
const aliceNettedShare = (nettedQuote * aliceNvdaGross) / (WHALE_USDG + aliceNvdaGross);
await quote(TOKENS.SPY, 12_000_000n);
for (const t of [TOKENS.SPY, TOKENS.NVDA]) {
  await pub.readContract({ address: book.stockRouter, abi: parseAbi(["function oracleStatus(address) view returns (uint8, uint256)"]), functionName: "oracleStatus", args: [t] });
  for (const fn of ["effectiveAt", "uiMultiplier", "newUIMultiplier"]) {
    await pub.readContract({ address: t, abi: parseAbi([`function ${fn}() view returns (uint256)`]), functionName: fn });
  }
}

console.log("== onboarding (link, rule, Permit2 consent)");
// The fork tooling funds its own fresh users, not these keys: give each the USDG it spends.
for (const [who, usdg] of [
  [alice, 100_000_000n],
  [bob, 100_000_000n],
  [spammer, 1_000_000n],
] as const) {
  await asImpersonated(USDG_WHALE, USDG, erc20, "transfer", [who, usdg]);
}
for (const [key, who, rule] of [
  [KEYS.alice, alice, [10, 5, 20_000_000n, true]],
  [KEYS.bob, bob, [1, 1, 50_000_000n, true]],
  [KEYS.spammer, spammer, [1, 1, 50_000_000n, true]],
] as const) {
  await as(key, book.ruleRegistry, ruleRegistryAbi, "linkSelf", []);
  await as(key, book.ruleRegistry, ruleRegistryAbi, "setRule", [...rule]);
  await as(key, USDG, erc20, "approve", [PERMIT2, maxUint256]);
  await as(key, PERMIT2, permit2Abi, "approve", [USDG, book.sweepExecutor, maxUint160, now + 365 * 86400]);
  check(
    (await pub.readContract({ address: book.ruleRegistry, abi: ruleRegistryAbi, functionName: "isLinked", args: [who, who] })) === true,
    `${who === alice ? "alice" : who === bob ? "bob" : "spammer"} linked + rule set + Permit2 consent`,
  );
}
await as(KEYS.bob, book.electionRegistry, electionRegistryAbi, "setMix", [
  [
    { asset: TOKENS.AAPL, bps: 5000 },
    { asset: TOKENS.TSLA, bps: 5000 },
  ],
]);

console.log("== payments (real USDG transfers)");
await pub.request({ method: "anvil_mine" as never, params: ["0x2"] as never });
// alice: $1.00 -> (10-1)*5 = $45 ; $3.37 -> (10-3.37)*5 = $33.15 ; capped at $20/7d
await as(KEYS.alice, USDG, erc20, "transfer", [merchant, 1_000_000n]);
await as(KEYS.alice, USDG, erc20, "transfer", [merchant, 3_370_000n]);
// alice -> own linked wallet is NOT a payment (self transfer)
await as(KEYS.alice, USDG, erc20, "transfer", [alice, 2_500_000n]);
// bob: $4.25 -> 0.75 ; $7.10 -> 0.90 ; $0.01 -> 0.99  => $2.64 (under the $5 threshold)
await as(KEYS.bob, USDG, erc20, "transfer", [merchant, 4_250_000n]);
await as(KEYS.bob, USDG, erc20, "transfer", [merchant, 7_100_000n]);
await as(KEYS.bob, USDG, erc20, "transfer", [merchant, 10_000n]);
// spammer: a stream of 1-unit transfers (the audit's B-L2 trace). Its log count
// is what overruns the scan budget; fresh recipients per transfer would add v3
// pool lookups, which test/keeper-budget.test.ts charges against the budget.
for (let i = 0; i < SPAM_TRANSFERS; i++) await as(KEYS.spammer, USDG, erc20, "transfer", [spamSink, 1n]);

console.log("== keeper accrue before finality");
await keeper.accrueTick();
const pendingEarly = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "pending", args: [alice] });
check(pendingEarly === 0n, "nothing accrued inside the finality buffer");

console.log("== mine past finality, keeper accrue");
await pub.request({ method: "anvil_mine" as never, params: ["0xC80"] as never }); // 3200 blocks
await keeper.accrueTick();
const pa = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "pending", args: [alice] });
const pb = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "pending", args: [bob] });
check(pa === 20_000_000n, `alice accrued $${fmtUsdg(pa)} (expected $20.00: $78.15 of round-ups capped at the $20 rolling cap)`);
check(pb === 2_640_000n, `bob accrued $${fmtUsdg(pb)} (expected $2.64)`);
const ps = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "pending", args: [spammer] });
const spamCursor = await pub.readContract({ address: book.sweepExecutor, abi: sweepExecutorAbi, functionName: "lastAccruedBlock", args: [spammer] });
check(ps === 0n && spamCursor === 0n, `spam wallet over its scan budget was skipped (pending $${fmtUsdg(ps)}, cursor ${spamCursor}) while alice and bob accrued`);
const rem = await pub.readContract({ address: book.sweepExecutor, abi: sweepExecutorAbi, functionName: "remainingWeeklyCap", args: [alice] });
check(rem === 0n, "alice's rolling 7-day cap is used up");
// Gas headroom: every accrueBatch went out well above what it used, so none of
// its try'd entries could run out of gas and be skipped while the tx succeeds.
for (const t of keeper.history.filter((h) => h.kind === "accrue" && h.tx)) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: t.tx! }), pub.getTransactionReceipt({ hash: t.tx! })]);
  const skipped = parseEventLogs({ abi: sweepExecutorAbi, eventName: "AccrualSkipped", logs: rc.logs });
  check(
    skipped.length === 0 && tx.gas * 100n >= rc.gasUsed * 140n,
    `accrueBatch ${t.tx!.slice(0, 10)}…: limit ${tx.gas} for ${rc.gasUsed} used (${(Number(tx.gas) / Number(rc.gasUsed)).toFixed(2)}x), ${skipped.length} skipped`,
  );
}

console.log("== second accrue is a no-op (cursor advanced)");
await pub.request({ method: "anvil_mine" as never, params: ["0xC80"] as never });
await keeper.accrueTick();
const pa2 = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "pending", args: [alice] });
check(pa2 === pa, "no double accrual");

console.log("== non-keeper cannot sweep");
try {
  await as(KEYS.bob, book.sweepExecutor, sweepExecutorAbi, "sweep", [[alice], []]);
  check(false, "stranger sweep should revert");
} catch {
  check(true, "stranger sweep reverts (keeper only)");
}

console.log(`== a whale co-due with alice: mallory parks $${fmtUsdg(WHALE_USDG)}, 100% NVDA`);
await as(KEYS.mallory, book.ruleRegistry, ruleRegistryAbi, "linkSelf", []);
await as(KEYS.mallory, book.electionRegistry, electionRegistryAbi, "setMix", [[{ asset: TOKENS.NVDA, bps: 10_000 }]]);
// Stands in for weeks of accruals: the executor (impersonated, fork only)
// credits her park directly. Nothing on the sweep path can tell the difference.
await asImpersonated(USDG_WHALE, USDG, erc20, "transfer", [book.sweepExecutor, WHALE_USDG]);
await asImpersonated(book.sweepExecutor, book.cashPark, cashParkAbi, "credit", [mallory, WHALE_USDG]);
await pub.request({ method: "anvil_mine" as never, params: ["0x50"] as never }); // past the keeper's discovery lag (64 blocks)
const mv0 = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "valueOf", args: [mallory] });
check(mv0 === WHALE_USDG, `mallory's park holds $${fmtUsdg(mv0)}`);

console.log("== keeper sweep (quote-limited)");
const epochNow = await pub.readContract({ address: book.sweepExecutor, abi: sweepExecutorAbi, functionName: "currentEpoch" });
const spy0 = await pub.readContract({ address: TOKENS.SPY, abi: erc20, functionName: "balanceOf", args: [alice] });
const nvda0 = await pub.readContract({ address: TOKENS.NVDA, abi: erc20, functionName: "balanceOf", args: [alice] });
const seenBefore = keeper.history.length;
await keeper.sweepTick();
const spy1 = await pub.readContract({ address: TOKENS.SPY, abi: erc20, functionName: "balanceOf", args: [alice] });
const nvda1 = await pub.readContract({ address: TOKENS.NVDA, abi: erc20, functionName: "balanceOf", args: [alice] });
check(spy1 > spy0, `alice received ${Number(spy1 - spy0) / 1e18} SPY`);
check(nvda1 > nvda0, `alice received ${Number(nvda1 - nvda0) / 1e18} NVDA`);
const ticks = keeper.history.slice(0, keeper.history.length - seenBefore).reverse();
for (const t of ticks) console.log(`         keeper: ${t.detail}${t.tx ? ` (${t.tx})` : ""}`);
const sent = ticks.filter((t) => t.tx);
check(sent.length === 1, `one sweep tx sent (${sent.length})`);
if (sent[0]?.tx) {
  const rc = await pub.getTransactionReceipt({ hash: sent[0].tx });
  const swept = parseEventLogs({ abi: sweepExecutorAbi, eventName: "AccountSwept", logs: rc.logs }).map((e) => e.args.account);
  check(swept.length === 1 && swept[0] === alice, `alice's sweep call held alice only (swept: ${swept.join(", ")})`);
}
check(
  nvda1 - nvda0 > (aliceNettedShare * 10_050n) / 10_000n,
  `alice's NVDA (${Number(nvda1 - nvda0) / 1e18}) beats her share of a swap netted with mallory (${Number(aliceNettedShare) / 1e18}) by > 50 bps`,
);
check(
  ticks.some((t) => t.detail.startsWith("call 2/2") && t.detail.includes("under the oracle")),
  "mallory's own call was planned last and held: her quote is far under the oracle",
);
const mv1 = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "valueOf", args: [mallory] });
const mEpoch = await pub.readContract({ address: book.sweepExecutor, abi: sweepExecutorAbi, functionName: "sweptEpoch", args: [mallory] });
check(mv1 === WHALE_USDG && mEpoch !== epochNow, `mallory's $${fmtUsdg(mv1)} stays parked and her epoch is untouched`);
const left = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "valueOf", args: [alice] });
check(left === 0n, `alice's park is empty after the sweep ($${fmtUsdg(left)})`);
const pbAfter = await pub.readContract({ address: book.cashPark, abi: cashParkAbi, functionName: "valueOf", args: [bob] });
check(pbAfter === 2_640_000n, "bob (under threshold) was not swept");
const fees = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [book.feeVault] });
check(fees === 50_000n, `fee vault took $${fmtUsdg(fees)} (25 bps of $20)`);
if (sent[0]?.tx) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: sent[0].tx }), pub.getTransactionReceipt({ hash: sent[0].tx })]);
  const outOfGas = parseEventLogs({ abi: sweepExecutorAbi, eventName: "SwapDeferred", logs: rc.logs }).filter((e) => e.args.reason === "0x");
  check(
    outOfGas.length === 0 && tx.gas * 100n >= rc.gasUsed * 140n,
    `sweep: limit ${tx.gas} for ${rc.gasUsed} used (${(Number(tx.gas) / Number(rc.gasUsed)).toFixed(2)}x), no swap deferred out of gas`,
  );
}

console.log("== second sweep same epoch is a no-op");
await keeper.sweepTick();

console.log("== bob exits (never gated)");
const b0 = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [bob] });
await as(KEYS.bob, book.cashPark, cashParkAbi, "exit", []);
const b1 = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [bob] });
check(b1 - b0 === 2_640_000n, "bob got his $2.64 back");
const m0 = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [mallory] });
await as(KEYS.mallory, book.cashPark, cashParkAbi, "exit", []);
const m1 = await pub.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [mallory] });
check(m1 - m0 === WHALE_USDG, `mallory (held, never swept) exits with her $${fmtUsdg(m1 - m0)}`);

console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
