#!/usr/bin/env bun
/**
 * prove: Spare's whole money path, replayed against a local anvil fork of LIVE
 * Robinhood Chain mainnet, with the DEPLOYED contracts (contracts/addresses/4663.json)
 * and the real keeper (src/keeper/keeper.ts): real USDG, Permit2, Uniswap v4
 * pools and hooks, Chainlink feeds and stock tokens. From the repository root:
 *
 *   npm run prove        (scripts/prove.mjs checks the prerequisites, then runs this)
 *
 * Every check prints PASS or FAIL; the run ends with a summary and exits 1 on
 * any FAIL (2 when it could not run at all):
 *   1. onboarding: every test user links its wallet, sets a rule, gives Permit2 consent
 *   2. round-ups: each payment's round-up from contracts/src/libraries/RoundUp.sol
 *      itself (its test harness, executed on the fork), from the keeper's copy
 *      (src/lib/roundup.ts) and from an independent ceiling-division reference
 *   3. accrual: nothing inside the finality buffer; past it, the keeper's
 *      accrueBatch credits every user exactly its round-ups (the weekly cap
 *      applied on-chain), with no AccrualSkipped, as recomputed from the fork's
 *      own USDG Transfer logs
 *   4. sweep: one user per active asset, plus one on the default multi-leg mix
 *      (netted with the others); every fill inside the asset's oracle band and
 *      at or above the keeper's quote limit, fee exactly feeBps. An asset the
 *      keeper refuses to buy right now (its pool too far under the oracle, a
 *      hook fee above its pinned ceiling, a bad oracle) is reported as HELD
 *      with the keeper's reason, and that reason is confirmed by this run's own
 *      reads (its own quotes against StockRouter.oracleTokensFor, the hook's
 *      fee against contracts/config/4663.json); an unconfirmed hold fails.
 *      PROVE_STRICT=1 fails on any hold.
 *   5. delivery: every token lands in the user's wallet, pro rata inside a
 *      netted swap, nothing left to claim
 *   6. exit: CashPark.exit returns everything still parked, pending USDG and
 *      park-adapter units alike
 *
 * Inputs are public only: the public RPC (or PROVE_RPC_URL) and this repository's
 * address book. Every key is generated for this run and kept in memory. On the
 * fork only, the run impersonates the contracts' owner to make a throwaway key a
 * keeper, impersonates a large USDG holder to fund the test users, and puts
 * MockArbSys at the ArbSys precompile (0x64) so L2Clock takes its production
 * branch. Nothing is ever sent to mainnet: every transaction goes to
 * http://127.0.0.1, checked to be anvil before the first one is sent.
 *
 * Keeper discovery starts at the fork block, so the keeper serves only this
 * run's users; real accounts on the fork are left alone.
 *
 * Market hours: the production keeper only trades equity legs inside the 24/5
 * session (Sunday 20:00 ET to Friday 20:00 ET) once each feed has posted since
 * the open. When that is not the case at the fork block, the run uses the
 * keeper's test override (MARKET_HOURS_GATE=0, src/keeper/config.ts) and says
 * so; the contracts' own oracle checks and bands still apply.
 *
 * Environment (all optional)
 *   PROVE_RPC_URL      upstream RPC to fork (default https://rpc.mainnet.chain.robinhood.com)
 *   PROVE_PORT         local anvil port (default: a free one)
 *   PROVE_CUPS         anvil's upstream budget in compute units per second (default 150;
 *                      halved on each retry when the RPC rate-limits the fork's start)
 *   PROVE_MARKET_GATE  "auto" (default) or "off" (always use the test override)
 *   PROVE_STRICT=1     count an asset the keeper holds as a failure
 *   PROVE_KEEP_FORK=1  leave the fork running at the end and print its URL
 *   ANVIL_BIN          the anvil executable (scripts/prove.mjs sets it)
 *
 * STATE WINDOW. The public RPC is not an archive node: it serves state for only
 * the last ~10 minutes of blocks, and anvil reads mainnet state lazily at the fork
 * block. The run therefore forks at a fresh head and first touches every pool,
 * feed and token it will trade, while the RPC still serves that block. A run that
 * stalls past the window fails with "historical state ... not available"; run it
 * again, or point PROVE_RPC_URL at an archive endpoint.
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  maxUint160,
  maxUint256,
  numberToHex,
  pad,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  aggregatorV3Abi,
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  permit2Abi,
  ruleRegistryAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from "../src/chain/abis.ts";
import { MULTICALL3, PERMIT2, USDG, VENUE } from "../src/chain/constants.ts";
import { loadConfig, parseBook } from "../src/keeper/config.ts";
import { Keeper } from "../src/keeper/keeper.ts";
import { equityMarketOpen, equitySessionOpenedAt } from "../src/keeper/plan.ts";
import { roundUpDelta } from "../src/lib/roundup.ts";

// ── settings ────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "../..");
const CONTRACTS = join(ROOT, "contracts");
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const UPSTREAM = (process.env.PROVE_RPC_URL ?? "").trim() || PUBLIC_RPC;
const CUPS = Number((process.env.PROVE_CUPS ?? "").trim() || "150");
if (!Number.isInteger(CUPS) || CUPS < 1) throw new Error(`PROVE_CUPS must be a positive integer, got "${process.env.PROVE_CUPS}"`);
const GATE_MODE = (process.env.PROVE_MARKET_GATE ?? "auto").trim().toLowerCase();
const KEEP_FORK = process.env.PROVE_KEEP_FORK === "1";
const STRICT = process.env.PROVE_STRICT === "1";
const ANVIL = process.env.ANVIL_BIN || "anvil";
const CHAIN_ID = 4663;

/** A large plain-EOA USDG holder (scripts/lib/common.sh); impersonated on the fork only. */
const USDG_WHALE: Address = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
/** USDG's balance mapping slot (scripts/lib/common.sh); the funding fallback writes it on the fork. */
const USDG_BALANCE_SLOT = 1n;
const ARBSYS: Address = "0x0000000000000000000000000000000000000064";
/** Where the RoundUp harness's runtime code is placed on the fork (an otherwise empty address). */
const HARNESS = getAddress(`0x${keccak256(toHex("spare prove: RoundUp harness")).slice(26)}`);
const USDG_EACH = 300_000_000n; // $300 per test user
const ETH_EACH = 10n ** 18n;
const CAP = 50_000_000n; // weekly cap of the per-asset users ($50)
const ONE = 1_000_000n;

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
]);
const ownable = parseAbi(["function owner() view returns (address)"]);
const hookAbi = parseAbi(["function currentFee(bytes32 poolId, bool zeroForOne) view returns (uint24)"]);
const harnessAbi = parseAbi(["function delta(uint256 amount, uint8 roundTo, uint8 multiplier) pure returns (uint256)"]);
const arbSysAbi = parseAbi(["function arbBlockNumber() view returns (uint256)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// ── output ──────────────────────────────────────────────────────────────────

const results: { ok: boolean; what: string }[] = [];
function check(ok: boolean, what: string, detail?: string): boolean {
  results.push({ ok, what });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  return ok;
}
const info = (msg: string) => console.log(`        ${msg}`);
const section = (title: string) => console.log(`\n== ${title}`);
/** USDG with at least 2 decimals, all 6 when it has sub-cent digits: $12.10, $3.141592. */
const usd = (v: bigint) => {
  const [i, f = ""] = formatUnits(v, 6).split(".");
  return `$${i}.${f.padEnd(2, "0")}`;
};
const usd2 = (v: bigint) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}$${a / ONE}.${((a % ONE) / 10_000n).toString().padStart(2, "0")}`;
};
const tok = (v: bigint) => Number(formatUnits(v, 18)).toPrecision(6);
const bps = (num: bigint, den: bigint) => (den === 0n ? 0 : Number((num * 1_000_000n) / den) / 100);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const lc = (a: string) => a.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown) => {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split("\n")[0]!;
};

/** Thrown when the run cannot continue; main() reports it as a failure. */
class Abort extends Error {}

async function eachLimit<T>(items: readonly T[], n: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

// ── upstream (the only calls that leave this machine besides anvil's own) ──

async function upstream<T>(method: string, params: unknown[] = []): Promise<T> {
  let wait = 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "RPC error");
      return j.result as T;
    } catch (err) {
      if (attempt >= 8) throw new Abort(`${UPSTREAM} did not answer ${method} after ${attempt} tries: ${errText(err)}`);
      console.log(`        upstream ${method}: ${errText(err)}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      wait = Math.min(wait * 2, 16_000);
    }
  }
}

// ── the local fork ──────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

let anvilProc: ReturnType<typeof Bun.spawn> | undefined;
let anvilLog = "";

async function startFork(forkBlock: bigint, port: number, cups: number): Promise<void> {
  anvilLog = join(tmpdir(), `spare-prove-anvil-${port}.log`);
  const fd = openSync(anvilLog, "w");
  anvilProc = Bun.spawn(
    [
      ANVIL,
      "--fork-url",
      UPSTREAM,
      "--fork-block-number",
      forkBlock.toString(),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--retries",
      "30",
      "--fork-retry-backoff",
      "1000",
      "--timeout",
      "60000",
      "--compute-units-per-second",
      String(cups),
    ],
    { stdout: fd, stderr: fd, stdin: "ignore" },
  );
  closeSync(fd);
  const local = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 180; i++) {
    if (anvilProc.exitCode !== null) break;
    try {
      const res = await fetch(local, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(2_000),
      });
      const j = (await res.json()) as { result?: string };
      if (j.result && Number(BigInt(j.result)) === CHAIN_ID) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  const tail = existsSync(anvilLog) ? readFileSync(anvilLog, "utf8").trim().split("\n").slice(-15).join("\n") : "";
  throw new Abort(`anvil did not come up on ${local}${tail ? `; its log ends:\n${tail}` : ""}`);
}

async function stopFork(): Promise<void> {
  if (!anvilProc || KEEP_FORK || anvilProc.exitCode !== null) return;
  anvilProc.kill();
  await Promise.race([anvilProc.exited, sleep(5_000)]);
}

process.on("SIGINT", () => {
  console.log("\n[prove] interrupted; stopping the local fork");
  void stopFork().finally(() => process.exit(130));
});

// ── main ────────────────────────────────────────────────────────────────────

interface Asset {
  token: Address;
  symbol: string;
  feed: Address;
  bandBps: number;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  price1e18: bigint;
  status: number;
  updatedAt: number;
}
interface Rule {
  roundTo: 1 | 5 | 10;
  multiplier: 1 | 2 | 3 | 4 | 5;
}
interface User {
  name: string;
  key: PrivateKeyAccount;
  rule: Rule;
  cap: bigint;
  /** Payments to merchants (round-ups) and, for one user, a transfer to itself (none). */
  payments: bigint[];
  selfTransfer?: bigint;
  /** Its own one-asset mix; undefined = the default mix. */
  asset?: Asset;
  role: "asset" | "mixed" | "saver" | "parked";
}

/** Payment profiles: every rule shape, boundary payments (round-up 0) and a sub-cent amount. */
const PROFILES: { rule: Rule; payments: bigint[] }[] = [
  { rule: { roundTo: 10, multiplier: 1 }, payments: [1_370_000n, 20_000_000n] },
  { rule: { roundTo: 5, multiplier: 1 }, payments: [250_000n, 12_100_000n] },
  { rule: { roundTo: 5, multiplier: 2 }, payments: [3_330_000n, 41_800_000n] },
  { rule: { roundTo: 1, multiplier: 5 }, payments: [7_010_000n, 2_500_000n] },
  { rule: { roundTo: 10, multiplier: 3 }, payments: [9_000_000n, 18_750_000n] },
  { rule: { roundTo: 1, multiplier: 4 }, payments: [10_000n, 4_400_000n, 10_000_000n] },
  { rule: { roundTo: 5, multiplier: 3 }, payments: [3_141_592n, 7_770_000n] },
  { rule: { roundTo: 10, multiplier: 2 }, payments: [6_660_000n, 99_990_000n] },
  { rule: { roundTo: 1, multiplier: 3 }, payments: [2_010_000n, 3_020_000n, 15_500_000n] },
  { rule: { roundTo: 5, multiplier: 4 }, payments: [4_120_000n, 11_000_000n] },
];

/** Independent of RoundUp.sol's modulo: the next boundary at or above the amount, by ceiling division. */
function referenceDelta(amount: bigint, r: Rule): bigint {
  const step = BigInt(r.roundTo) * ONE;
  const next = ((amount + step - 1n) / step) * step;
  return (next - amount) * BigInt(r.multiplier);
}

async function main(): Promise<number> {
  const t0 = Date.now();
  console.log("Spare: the money path, replayed on a local fork of live Robinhood Chain mainnet");
  console.log(`  upstream ${UPSTREAM}  (read-only; nothing is ever sent there)`);

  // ── fork ──────────────────────────────────────────────────────────────────
  section("fork");
  const upChain = Number(BigInt(await upstream<string>("eth_chainId")));
  if (upChain !== CHAIN_ID) throw new Abort(`${UPSTREAM} is chain ${upChain}, not Robinhood Chain mainnet (${CHAIN_ID})`);
  // A few blocks behind the head the RPC reports: it is load-balanced, and a
  // node a block behind its peers cannot serve the newest one yet.
  let forkBlock = 0n;
  const port = Number(process.env.PROVE_PORT || (await freePort()));
  // A public RPC answers a burst of fork-start reads with HTTP 429; then the
  // next attempt asks for half the rate (PROVE_CUPS), down to 30.
  let cups = CUPS;
  for (let attempt = 1; ; attempt++) {
    forkBlock = BigInt(await upstream<string>("eth_blockNumber")) - 20n;
    await upstream("eth_getBlockByNumber", [numberToHex(forkBlock), false]);
    try {
      await startFork(forkBlock, port, cups);
      break;
    } catch (err) {
      await stopFork();
      if (attempt >= 4) throw err;
      const limited = /\b429\b|rate.?limit|too many requests/i.test(errText(err));
      if (limited) cups = Math.max(30, Math.floor(cups / 2));
      info(
        `anvil could not fork block ${forkBlock} (${errText(err).split(";")[0]}); trying a fresh head` +
          (limited ? ` at ${cups} compute units/s (the RPC rate-limited the last try)` : ""),
      );
      await sleep((limited ? 10_000 : 2_000) * attempt);
    }
  }
  const LOCAL = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain (local fork)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [LOCAL] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const pub = createPublicClient({ chain, transport: http(LOCAL, { timeout: 180_000, retryCount: 2 }), pollingInterval: 200 });
  const rpc = (method: string, params: unknown[] = []) => pub.request({ method, params } as never) as Promise<unknown>;
  const client = String(await rpc("web3_clientVersion"));
  if (!/^anvil/i.test(client)) throw new Abort(`${LOCAL} is "${client}", not anvil; refusing to send anything`);
  const forkTs = Number((await pub.getBlock({ blockNumber: forkBlock })).timestamp);
  info(`anvil ${client.replace(/^anvil\/?/i, "")} on ${LOCAL}, forked at block ${forkBlock} (${new Date(forkTs * 1000).toISOString()}), log ${anvilLog}`);

  const tx = async (from: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => {
    const { request } = await pub.simulateContract({ address, abi, functionName, args, account: from } as never);
    const w = createWalletClient({ account: from, chain, transport: http(LOCAL, { timeout: 180_000 }) });
    const hash = await w.writeContract(request as never);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 300_000 });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return r;
  };
  /** Send as `from` with anvil impersonation (fork only). Callers never overlap on one `from`. */
  const txAs = async (from: Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => {
    await rpc("anvil_impersonateAccount", [from]);
    try {
      if ((await pub.getBalance({ address: from })) < ETH_EACH) await rpc("anvil_setBalance", [from, numberToHex(ETH_EACH)]);
      await pub.simulateContract({ address, abi, functionName, args, account: from } as never);
      const w = createWalletClient({ chain, transport: http(LOCAL, { timeout: 180_000 }) });
      const hash = await w.writeContract({ address, abi, functionName, args, account: from, chain } as never);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 300_000 });
      if (r.status !== "success") throw new Error(`${functionName} as ${from} reverted (${hash})`);
      return r;
    } finally {
      await rpc("anvil_stopImpersonatingAccount", [from]);
    }
  };
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  // ── the deployment ────────────────────────────────────────────────────────
  section("deployment (contracts/addresses/4663.json)");
  const bookJson = JSON.parse(readFileSync(join(CONTRACTS, "addresses", "4663.json"), "utf8")) as { contracts: Record<string, string> };
  const book = parseBook(bookJson, CHAIN_ID);
  const names = Object.entries(bookJson.contracts);
  const codes = await Promise.all(names.map(([, a]) => pub.getCode({ address: a as Address })));
  const noCode = names.filter((_, i) => !codes[i] || codes[i] === "0x").map(([n]) => n);
  check(noCode.length === 0, `the ${names.length} deployed contracts have code at the fork block`, noCode.length ? `missing: ${noCode.join(", ")}` : undefined);
  const x = book.sweepExecutor;
  const [owner, paused, threshold, feeBps, finalityBuffer, epochLength] = await Promise.all([
    read<Address>(x, ownable, "owner"),
    read<boolean>(x, sweepExecutorAbi, "paused"),
    read<bigint>(x, sweepExecutorAbi, "threshold"),
    read<number>(x, sweepExecutorAbi, "feeBps"),
    read<bigint>(x, sweepExecutorAbi, "finalityBuffer"),
    read<bigint>(x, sweepExecutorAbi, "epochLength"),
  ]);
  info(`owner ${owner}; threshold ${usd2(threshold)}; fee ${feeBps} bps; finality ${finalityBuffer} blocks; epoch ${epochLength} s`);
  if (paused) throw new Abort("SweepExecutor is paused on mainnet at the fork block: its pauser has halted new activity, so there is no money path to replay");

  const tokens = await read<readonly Address[]>(book.assetRegistry, assetRegistryAbi as Abi, "tokens");
  type Reg = { token: Address; feed: Address; bandBps: number; active: boolean; poolKey: Asset["poolKey"] };
  const regs = await Promise.all(tokens.map((t) => read<Reg>(book.assetRegistry, assetRegistryAbi as Abi, "get", [t])));
  const activeRegs = regs.filter((r) => r.active);
  const assets: Asset[] = await Promise.all(
    activeRegs.map(async (r) => {
      const [symbol, [status, price1e18], round] = await Promise.all([
        read<string>(r.token, erc20, "symbol"),
        read<readonly [number, bigint]>(book.stockRouter, stockRouterAbi as Abi, "oracleStatus", [r.token]),
        read<readonly [bigint, bigint, bigint, bigint, bigint]>(r.feed, aggregatorV3Abi as Abi, "latestRoundData"),
      ]);
      return { token: r.token, symbol, feed: r.feed, bandBps: Number(r.bandBps), poolKey: r.poolKey, price1e18, status: Number(status), updatedAt: Number(round[3]) };
    }),
  );
  const hooked = assets.filter((a) => lc(a.poolKey.hooks) !== lc("0x0000000000000000000000000000000000000000"));
  info(`registry: ${tokens.length} assets, ${assets.length} active (${hooked.length} on hooked pools: ${hooked.map((a) => a.symbol).join(", ") || "none"})`);
  info(`active: ${assets.map((a) => a.symbol).join(" ")}`);
  const badOracle = assets.filter((a) => a.status !== 0);
  check(assets.length > 0, `${assets.length} active assets to buy`);
  if (badOracle.length) info(`oracle not OK at the fork block: ${badOracle.map((a) => `${a.symbol} (status ${a.status})`).join(", ")}`);

  // ── market hours ──────────────────────────────────────────────────────────
  section("market hours");
  const opened = equitySessionOpenedAt(forkTs);
  const notPosted = assets.filter((a) => !equityMarketOpen(forkTs, a.updatedAt));
  let gate: "0" | "1" = "1";
  let gateWhy = "";
  if (GATE_MODE === "off") gateWhy = "PROVE_MARKET_GATE=off was set";
  else if (opened === null) gateWhy = "the US-equities 24/5 session (Sunday 20:00 ET to Friday 20:00 ET) is CLOSED at the fork block";
  else if (notPosted.length) gateWhy = `the session is open but ${notPosted.length} feed(s) have not posted since it opened (${notPosted.map((a) => a.symbol).join(", ")})`;
  if (gateWhy) {
    gate = "0";
    console.log(`  NOTE  ${gateWhy}.`);
    if (GATE_MODE !== "off") info("The production keeper would not trade these legs now.");
    info("This run uses the keeper's documented test override MARKET_HOURS_GATE=0 (engine/src/keeper/config.ts),");
    info("so it trades at the current oracle price.");
    info("The contracts' own checks still apply in full: OracleGuard staleness, the oracle band, the keeper's");
    info("quote limits. Run during the session to exercise the gate exactly as deployed.");
  } else {
    info(`session open since ${new Date(opened! * 1000).toISOString()}, every feed posted since; the keeper runs with its production gate (MARKET_HOURS_GATE=1)`);
  }

  // ── keys, all generated for this run ──────────────────────────────────────
  const keeperPk = generatePrivateKey();
  const keeperKey = privateKeyToAccount(keeperPk);
  const merchants = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address);
  const users: User[] = assets.map((asset, i) => {
    const p = PROFILES[i % PROFILES.length]!;
    return { name: asset.symbol, key: privateKeyToAccount(generatePrivateKey()), rule: p.rule, cap: CAP, payments: p.payments, asset, role: "asset" };
  });
  const mixed: User = {
    name: "default mix",
    key: privateKeyToAccount(generatePrivateKey()),
    rule: { roundTo: 10, multiplier: 5 },
    cap: 20_000_000n,
    payments: [1_000_000n, 3_370_000n],
    selfTransfer: 2_500_000n,
    role: "mixed",
  };
  const saver: User = {
    name: "saver",
    key: privateKeyToAccount(generatePrivateKey()),
    rule: { roundTo: 1, multiplier: 1 },
    cap: CAP,
    payments: [4_250_000n, 7_100_000n, 10_000n],
    role: "saver",
  };
  const parker: User = {
    name: "parked",
    key: privateKeyToAccount(generatePrivateKey()),
    rule: { roundTo: 1, multiplier: 2 },
    cap: CAP,
    payments: [1_400_000n, 2_750_000n],
    role: "parked",
  };
  const everyone = [...users, mixed, saver, parker];
  const addr = (u: User) => u.key.address;

  // ── warm the fork while the RPC still serves the fork block ───────────────
  section("warming the fork (pools, hooks, feeds, tokens)");
  const tw = Date.now();
  const execUsdgSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [x, USDG_BALANCE_SLOT]));
  let warmFailed = 0;
  await eachLimit(assets, 4, async (a) => {
    const zeroForOne = lc(a.poolKey.currency0) === lc(USDG);
    for (const amount of [ONE, 25n * ONE]) {
      await pub
        .simulateContract({
          address: VENUE.v4Quoter as Address,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey: a.poolKey, zeroForOne, exactAmount: amount, hookData: "0x" }],
        })
        .catch(() => warmFailed++);
    }
    // The executor's whole buy path (router, pool, hook, token, oracle), as an eth_call with a USDG balance override.
    await pub
      .call({
        account: x,
        to: book.stockRouter,
        data: encodeFunctionData({ abi: stockRouterAbi as Abi, functionName: "buy", args: [a.token, 20n * ONE, 0n, x] }),
        stateOverride: [{ address: USDG, stateDiff: [{ slot: execUsdgSlot, value: pad(numberToHex(10n ** 12n)) }] }],
      })
      .catch(() => warmFailed++);
    const user = users.find((u) => u.asset === a);
    if (user) {
      await pub
        .call({ account: VENUE.v4PoolManager as Address, to: a.token, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [addr(user), 1n] }) })
        .catch(() => {});
    }
  });
  info(`${assets.length} assets warmed in ${((Date.now() - tw) / 1000).toFixed(0)} s${warmFailed ? ` (${warmFailed} warm-up call(s) reverted; the checks below decide)` : ""}`);

  // ── fork-only setup: helpers, keeper role, funding ────────────────────────
  section("setup (on the fork only)");
  const artifact = (p: string) => (JSON.parse(readFileSync(join(CONTRACTS, "out", p), "utf8")) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;
  await rpc("anvil_setCode", [ARBSYS, artifact("MockArbSys.sol/MockArbSys.json")]);
  const [arb, head0] = await Promise.all([read<bigint>(ARBSYS, arbSysAbi, "arbBlockNumber"), pub.getBlockNumber({ cacheTime: 0 })]);
  check(arb === head0, "MockArbSys at 0x64: the contracts read the L2 block number through ArbSys, as on mainnet", `arbBlockNumber ${arb}, head ${head0}`);
  await rpc("anvil_setCode", [HARNESS, artifact("RoundUp.t.sol/RoundUpHarness.json")]);

  await txAs(owner, x, sweepExecutorAbi as Abi, "setKeeper", [keeperKey.address, true]);
  await txAs(owner, book.cashPark, cashParkAbi as Abi, "setKeeper", [keeperKey.address, true]);
  await rpc("anvil_setBalance", [keeperKey.address, numberToHex(10n * ETH_EACH)]);
  const [isKeeperX, isKeeperP] = await Promise.all([
    read<boolean>(x, sweepExecutorAbi as Abi, "isKeeper", [keeperKey.address]),
    read<boolean>(book.cashPark, cashParkAbi as Abi, "isKeeper", [keeperKey.address]),
  ]);
  check(isKeeperX && isKeeperP, `throwaway key ${short(keeperKey.address)} made a keeper by the impersonated owner ${short(owner)}`);

  let slotFunded = 0;
  for (const u of everyone) {
    await rpc("anvil_setBalance", [addr(u), numberToHex(ETH_EACH)]);
    try {
      await txAs(getAddress(USDG_WHALE), USDG, erc20, "transfer", [addr(u), USDG_EACH]);
    } catch {
      slotFunded++;
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [addr(u), USDG_BALANCE_SLOT]));
      await rpc("anvil_setStorageAt", [USDG, slot, pad(numberToHex(USDG_EACH))]);
    }
  }
  const funded = await Promise.all(everyone.map((u) => read<bigint>(USDG, erc20, "balanceOf", [addr(u)])));
  check(
    funded.every((b) => b === USDG_EACH),
    `${everyone.length} fresh test users hold ${usd2(USDG_EACH)} USDG each`,
    slotFunded ? `${slotFunded} funded by writing USDG's balance slot (the holder was short)` : `transferred from holder ${short(USDG_WHALE)}`,
  );

  // ── 1. onboarding ─────────────────────────────────────────────────────────
  section("1. onboarding: link, rule, Permit2 consent");
  const expiry = BigInt(forkTs + 30 * 86_400);
  const onboardErrors: string[] = [];
  await eachLimit(everyone, 6, async (u) => {
    try {
      await tx(u.key, book.ruleRegistry, ruleRegistryAbi as Abi, "linkSelf", []);
      await tx(u.key, book.ruleRegistry, ruleRegistryAbi as Abi, "setRule", [u.rule.roundTo, u.rule.multiplier, u.cap, true]);
      await tx(u.key, USDG, erc20, "approve", [PERMIT2, maxUint256]);
      await tx(u.key, PERMIT2, permit2Abi as Abi, "approve", [USDG, x, maxUint160, expiry]);
      if (u.asset) await tx(u.key, book.electionRegistry, electionRegistryAbi as Abi, "setMix", [[{ asset: u.asset.token, bps: 10_000 }]]);
    } catch (err) {
      onboardErrors.push(`${u.name}: ${errText(err)}`);
    }
  });
  const defaultMix = await read<readonly { asset: Address; bps: number }[]>(book.electionRegistry, electionRegistryAbi as Abi, "defaultMix");
  const onboard = await Promise.all(
    everyone.map(async (u) => {
      const [linked, rule, allowance, p2, mix] = await Promise.all([
        read<boolean>(book.ruleRegistry, ruleRegistryAbi as Abi, "isLinked", [addr(u), addr(u)]),
        read<{ roundTo: number; multiplier: number; weeklyCap: bigint; enabled: boolean }>(book.ruleRegistry, ruleRegistryAbi as Abi, "ruleOf", [addr(u)]),
        read<bigint>(USDG, erc20, "allowance", [addr(u), PERMIT2]),
        read<readonly [bigint, number, number]>(PERMIT2, permit2Abi as Abi, "allowance", [addr(u), USDG, x]),
        read<readonly { asset: Address; bps: number }[]>(book.electionRegistry, electionRegistryAbi as Abi, "mixOf", [addr(u)]),
      ]);
      const wantMix = u.asset ? [{ asset: u.asset.token, bps: 10_000 }] : defaultMix;
      const mixOk = mix.length === wantMix.length && mix.every((l, i) => lc(l.asset) === lc(wantMix[i]!.asset) && Number(l.bps) === Number(wantMix[i]!.bps));
      return linked && rule.enabled && rule.roundTo === u.rule.roundTo && rule.multiplier === u.rule.multiplier && rule.weeklyCap === u.cap && allowance === maxUint256 && p2[0] === maxUint160 && mixOk;
    }),
  );
  const onboarded = onboard.filter(Boolean).length;
  check(
    onboarded === everyone.length && onboardErrors.length === 0,
    `${onboarded}/${everyone.length} users linked, rule set, Permit2 consent given, mix chosen`,
    onboardErrors.length ? onboardErrors.slice(0, 3).join("; ") : `${users.length} one-asset mixes, 1 on the default mix (${defaultMix.map((l) => `${assets.find((a) => lc(a.token) === lc(l.asset))?.symbol ?? short(l.asset)} ${Number(l.bps) / 100}%`).join(" / ")}), 2 savers`,
  );

  // ── 2. round-ups ──────────────────────────────────────────────────────────
  section("2. round-ups: RoundUp.sol (executed on the fork) vs the keeper's copy vs a reference");
  const pays = everyone.flatMap((u) => u.payments.map((amount) => ({ u, amount })));
  const sol = await Promise.all(pays.map((p) => read<bigint>(HARNESS, harnessAbi, "delta", [p.amount, p.u.rule.roundTo, p.u.rule.multiplier])));
  let agree = 0;
  console.log("        payment      rule        RoundUp.sol    keeper copy    reference");
  pays.forEach((p, i) => {
    const k = roundUpDelta(p.amount, p.u.rule.roundTo, p.u.rule.multiplier);
    const ref = referenceDelta(p.amount, p.u.rule);
    if (sol[i] === k && k === ref) agree++;
    if (i < 12 || sol[i] !== k || k !== ref) {
      console.log(
        `        ${usd(p.amount).padEnd(12)} $${p.u.rule.roundTo} x${p.u.rule.multiplier}`.padEnd(34) +
          `${usd(sol[i]!).padEnd(15)}${usd(k).padEnd(15)}${usd(ref)}`,
      );
    }
  });
  if (pays.length > 12) info(`... ${pays.length - 12} more`);
  check(agree === pays.length, `${agree}/${pays.length} payments: all three agree, to the base unit`, "includes boundary payments (round-up 0) and a sub-cent amount");
  const expectedRaw = new Map(everyone.map((u) => [u, u.payments.reduce((s, a) => s + roundUpDelta(a, u.rule.roundTo, u.rule.multiplier), 0n)]));
  const expected = new Map(everyone.map((u) => [u, expectedRaw.get(u)! < u.cap ? expectedRaw.get(u)! : u.cap]));

  // ── payments ──────────────────────────────────────────────────────────────
  section("payments (real USDG transfers on the fork)");
  const payErrors: string[] = [];
  await eachLimit(everyone, 6, async (u) => {
    try {
      for (const [i, amount] of u.payments.entries()) await tx(u.key, USDG, erc20, "transfer", [merchants[i % merchants.length]!, amount]);
      if (u.selfTransfer) await tx(u.key, USDG, erc20, "transfer", [addr(u), u.selfTransfer]);
    } catch (err) {
      payErrors.push(`${u.name}: ${errText(err)}`);
    }
  });
  check(payErrors.length === 0, `${pays.length} payments to merchants (plus a transfer to the payer's own wallet, which is not a payment)`, payErrors.slice(0, 3).join("; ") || undefined);

  // ── the real keeper ───────────────────────────────────────────────────────
  // Production settings throughout, except: this fork, the throwaway key, discovery
  // from the fork block, and the market-hours gate decided above.
  const keeperCfg = loadConfig({
    CHAIN_ID: String(CHAIN_ID),
    RPC_URL: LOCAL,
    KEEPER_PK: keeperPk,
    KEEPER_BROADCAST: "1",
    ADDRESSES_JSON: JSON.stringify({ ...bookJson, startBlock: (forkBlock + 1n).toString() }),
    MARKET_HOURS_GATE: gate,
  });
  const keeper = new Keeper(keeperCfg, parseBook(JSON.parse(keeperCfg.ADDRESSES_JSON!), CHAIN_ID));
  const ticks: { kind: string; ok: boolean; detail: string; tx?: Hex }[] = [];
  const tick = async (kind: "accrue" | "sweep") => {
    const before = keeper.history[0];
    const { log, warn, error } = console;
    const tag =
      (f: (...a: unknown[]) => void) =>
      (...a: unknown[]) =>
        f("        keeper |", ...a);
    console.log = tag(log);
    console.warn = tag(warn);
    console.error = tag(error);
    try {
      if (kind === "accrue") await keeper.accrueTick();
      else await keeper.sweepTick();
    } finally {
      console.log = log;
      console.warn = warn;
      console.error = error;
    }
    const fresh: typeof ticks = [];
    for (const h of keeper.history) {
      if (h === before) break;
      fresh.unshift({ kind: h.kind, ok: h.ok, detail: h.detail, tx: h.tx as Hex | undefined });
    }
    ticks.push(...fresh);
    return fresh;
  };
  const pending = (u: User) => read<bigint>(book.cashPark, cashParkAbi as Abi, "pending", [addr(u)]);

  // ── 3. accrual ────────────────────────────────────────────────────────────
  section(`3. accrual (keeper accrueBatch, finality ${finalityBuffer} blocks)`);
  await tick("accrue");
  const early = await Promise.all(everyone.map(pending));
  check(early.every((p) => p === 0n), "nothing accrues while the payments are inside the finality buffer");
  await rpc("anvil_mine", [numberToHex(finalityBuffer + 200n)]);
  const accrueTxs: Hex[] = [];
  for (let i = 0; i < 3; i++) {
    for (const t of await tick("accrue")) if (t.tx) accrueTxs.push(t.tx);
    const now = await Promise.all(everyone.map(pending));
    if (now.every((p, j) => p === expected.get(everyone[j]!)!)) break;
  }
  const accrueReceipts = await Promise.all(accrueTxs.map((hash) => pub.getTransactionReceipt({ hash })));
  const accrued = accrueReceipts.flatMap((r) => parseEventLogs({ abi: sweepExecutorAbi, eventName: "Accrued", logs: r.logs }));
  const skipped = accrueReceipts.flatMap((r) => parseEventLogs({ abi: sweepExecutorAbi, eventName: "AccrualSkipped", logs: r.logs }));
  const parked0 = await Promise.all(everyone.map(pending));
  const wrong = everyone.filter((u, i) => parked0[i] !== expected.get(u));
  check(
    wrong.length === 0 && accrueReceipts.length > 0 && accrueReceipts.every((r) => r.status === "success"),
    `the keeper accrued exactly each user's round-ups (${everyone.length} users, ${usd2([...expected.values()].reduce((s, v) => s + v, 0n))} in ${accrueReceipts.length} accrueBatch tx)`,
    wrong.length ? wrong.slice(0, 4).map((u) => `${u.name} ${usd(parked0[everyone.indexOf(u)]!)} != ${usd(expected.get(u)!)}`).join("; ") : undefined,
  );
  check(skipped.length === 0, "no AccrualSkipped in any accrueBatch", skipped.length ? skipped.map((s) => short(s.args.wallet as string)).join(", ") : undefined);

  // Anyone can recompute an accrual from public data: the wallet's USDG Transfer
  // logs inside the accrued range, priced by RoundUp.sol on the fork.
  let recomputed = 0;
  const recomputeErr: string[] = [];
  for (const u of everyone) {
    const ev = accrued.find((e) => lc(e.args.wallet as string) === lc(addr(u)));
    if (!ev) {
      recomputeErr.push(`${u.name}: no Accrued event`);
      continue;
    }
    const logs = await pub.getLogs({ address: USDG, event: transferEvent, args: { from: addr(u) }, fromBlock: (ev.args.fromBlock as bigint) + 1n, toBlock: ev.args.toBlock as bigint });
    const payouts = logs.filter((l) => lc(l.args.to as string) !== lc(addr(u)) && lc(l.args.to as string) !== lc(PERMIT2) && lc(l.args.to as string) !== lc(x));
    const deltas = await Promise.all(payouts.map((l) => read<bigint>(HARNESS, harnessAbi, "delta", [l.args.value!, u.rule.roundTo, u.rule.multiplier])));
    const sum = deltas.reduce((s, d) => s + d, 0n);
    const want = sum < u.cap ? sum : u.cap;
    if (want === ev.args.amount && payouts.length === u.payments.length) recomputed++;
    else recomputeErr.push(`${u.name}: ${payouts.length} payments, ${usd(want)} vs Accrued ${usd(ev.args.amount as bigint)}`);
  }
  check(recomputed === everyone.length, `${recomputed}/${everyone.length} accruals recomputed from the fork's Transfer logs and RoundUp.sol`, recomputeErr.slice(0, 3).join("; ") || "self-transfers are not payments");
  const capLeft = await read<bigint>(x, sweepExecutorAbi as Abi, "remainingWeeklyCap", [addr(mixed)]);
  check(
    expectedRaw.get(mixed)! > mixed.cap && parked0[everyone.indexOf(mixed)] === mixed.cap && capLeft === 0n,
    `weekly cap enforced on-chain: ${usd2(expectedRaw.get(mixed)!)} of round-ups, ${usd2(mixed.cap)} pulled, ${usd2(capLeft)} cap left`,
  );
  await rpc("anvil_mine", [numberToHex(finalityBuffer + 200n)]);
  await tick("accrue");
  const parked1 = await Promise.all(everyone.map(pending));
  check(parked1.every((p, i) => p === parked0[i]), "a second accrue tick past finality accrues nothing again (each wallet's cursor advanced)");

  // ── 4/5. sweep and delivery ───────────────────────────────────────────────
  section(`4. sweep (keeper sweep, ${assets.length} assets, quote limits, oracle bands)`);
  const due = [...users, mixed];
  const legsOf = (u: User) => (u.asset ? [{ asset: u.asset.token, bps: 10_000 }] : defaultMix.map((l) => ({ asset: l.asset, bps: Number(l.bps) })));
  const balBefore = new Map<string, bigint>();
  await Promise.all(
    due.flatMap((u) => legsOf(u).map(async (l) => balBefore.set(`${lc(addr(u))}|${lc(l.asset)}`, await read<bigint>(l.asset, erc20, "balanceOf", [addr(u)])))),
  );
  const vault0 = await read<bigint>(USDG, erc20, "balanceOf", [book.feeVault]);
  const epoch = await read<bigint>(x, sweepExecutorAbi as Abi, "currentEpoch");
  const sweepTxs: Hex[] = [];
  let idle = 0;
  for (let i = 0; i < 8 && idle < 2; i++) {
    const sent = (await tick("sweep")).filter((t) => t.tx).map((t) => t.tx!);
    sweepTxs.push(...sent);
    idle = sent.length ? 0 : idle + 1;
    const swept = await Promise.all(due.map((u) => read<bigint>(x, sweepExecutorAbi as Abi, "sweptEpoch", [addr(u)])));
    if (swept.every((e) => e === epoch)) break;
  }
  const sweeps = await Promise.all(
    sweepTxs.map(async (hash) => {
      const [t, r] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
      const { args } = decodeFunctionData({ abi: sweepExecutorAbi, data: t.input });
      const [accounts, limits] = args as unknown as [readonly Address[], readonly { asset: Address; minOutPerUsdg: bigint }[]];
      return { hash, r, accounts, limits };
    }),
  );
  check(sweeps.length > 0 && sweeps.every((s) => s.r.status === "success"), `${sweeps.length} sweep tx sent by the keeper, all mined`);

  interface Swap {
    asset: Asset;
    hash: Hex;
    total: bigint;
    swapIn: bigint;
    fee: bigint;
    out: bigint;
    paid: bigint;
    price: bigint;
    limit: bigint | undefined;
    contributors: { account: Address; usdg: bigint }[];
    delivered: Map<string, bigint>;
    heldForClaim: bigint;
  }
  const swaps: Swap[] = [];
  const deferred: { asset: string; why: string }[] = [];
  const sweptUsdg = new Map<string, bigint>();
  for (const s of sweeps) {
    const logs = s.r.logs;
    const accountSwept = parseEventLogs({ abi: sweepExecutorAbi, eventName: "AccountSwept", logs });
    for (const e of accountSwept) sweptUsdg.set(lc(e.args.account as string), (sweptUsdg.get(lc(e.args.account as string)) ?? 0n) + (e.args.usdg as bigint));
    // Rebuild the executor's contribution list: accounts in call order, legs in mix order, the last leg takes the remainder.
    const contrib: { account: Address; asset: Address; usdg: bigint }[] = [];
    for (const a of s.accounts) {
      const e = accountSwept.find((ev) => lc(ev.args.account as string) === lc(a));
      if (!e) continue;
      const got = e.args.usdg as bigint;
      const u = everyone.find((v) => lc(addr(v)) === lc(a));
      const legs = u ? legsOf(u) : [];
      let left = got;
      legs.forEach((l, k) => {
        const amt = k === legs.length - 1 ? left : (got * BigInt(l.bps)) / 10_000n;
        left -= amt;
        contrib.push({ account: a, asset: l.asset, usdg: amt });
      });
    }
    const bought = parseEventLogs({ abi: stockRouterAbi, eventName: "Bought", logs: logs.filter((l) => lc(l.address) === lc(book.stockRouter)) });
    const delivered = parseEventLogs({ abi: sweepExecutorAbi, eventName: "Delivered", logs });
    const held = parseEventLogs({ abi: sweepExecutorAbi, eventName: "DeliveryHeld", logs });
    for (const e of parseEventLogs({ abi: sweepExecutorAbi, eventName: "AssetSwept", logs })) {
      const asset = assets.find((a) => lc(a.token) === lc(e.args.asset as string));
      const b = bought.find((v) => lc(v.args.token as string) === lc(e.args.asset as string));
      if (!asset || !b) continue;
      const d = new Map<string, bigint>();
      for (const v of delivered) if (lc(v.args.token as string) === lc(asset.token)) d.set(lc(v.args.account as string), (d.get(lc(v.args.account as string)) ?? 0n) + (v.args.amount as bigint));
      swaps.push({
        asset,
        hash: s.hash,
        total: (e.args.usdgIn as bigint) + (e.args.fee as bigint),
        swapIn: e.args.usdgIn as bigint,
        fee: e.args.fee as bigint,
        out: e.args.tokensOut as bigint,
        paid: b.args.usdgIn as bigint,
        price: b.args.oraclePrice1e18 as bigint,
        limit: s.limits.find((l) => lc(l.asset) === lc(asset.token))?.minOutPerUsdg,
        contributors: contrib.filter((c) => lc(c.asset) === lc(asset.token)).map(({ account, usdg }) => ({ account, usdg })),
        delivered: d,
        heldForClaim: held.filter((h) => lc(h.args.token as string) === lc(asset.token)).reduce((t, h) => t + (h.args.amount as bigint), 0n),
      });
    }
    for (const e of parseEventLogs({ abi: sweepExecutorAbi, eventName: "SwapDeferred", logs })) {
      deferred.push({ asset: e.args.asset as string, why: `swap deferred: ${e.args.reason}` });
    }
    for (const e of parseEventLogs({ abi: sweepExecutorAbi, eventName: "Deferred", logs })) {
      deferred.push({ asset: e.args.asset as string, why: `deferred, oracle status ${e.args.status}` });
    }
  }

  // Per swap: band, keeper limit, fee, pro-rata delivery.
  const rows: string[][] = [];
  const verdict = new Map<string, { ok: boolean; why: string }>();
  for (const w of swaps) {
    const oracleTokens = (w.paid * 10n ** 12n * 10n ** 18n) / w.price;
    const floor = (oracleTokens * BigInt(10_000 - w.asset.bandBps)) / 10_000n;
    const keeperMin = w.limit === undefined ? undefined : (w.swapIn * w.limit) / ONE;
    const feeOk = w.fee === (w.total * BigInt(feeBps)) / 10_000n && w.paid === w.swapIn;
    // Pro rata by gross contribution, floored, the dust to the last contributor (SweepExecutor._distribute).
    const want = new Map<string, bigint>();
    let assigned = 0n;
    w.contributors.forEach((c) => {
      const share = (w.out * c.usdg) / w.total;
      assigned += share;
      want.set(lc(c.account), (want.get(lc(c.account)) ?? 0n) + share);
    });
    const last = w.contributors.at(-1);
    if (last && assigned < w.out) want.set(lc(last.account), want.get(lc(last.account))! + w.out - assigned);
    const proRata = [...want].every(([a, v]) => w.delivered.get(a) === v) && [...w.delivered.values()].reduce((s, v) => s + v, 0n) + w.heldForClaim === w.out;
    const inBand = w.out >= floor;
    const atLimit = keeperMin !== undefined && w.out >= keeperMin;
    const ok = inBand && atLimit && feeOk && proRata;
    const why = [!inBand && "below the oracle band", !atLimit && "below the keeper's limit", !feeOk && "fee or amount mismatch", !proRata && "delivery not pro rata"].filter(Boolean).join(", ");
    const prev = verdict.get(lc(w.asset.token));
    verdict.set(lc(w.asset.token), { ok: (prev?.ok ?? true) && ok, why: [prev?.why, why].filter(Boolean).join("; ") });
    rows.push([
      w.asset.symbol,
      lc(w.asset.poolKey.hooks) === lc("0x0000000000000000000000000000000000000000") ? `v4 ${w.asset.poolKey.fee / 100}bp` : "v4 hook",
      `${w.contributors.length}`,
      usd2(w.total),
      usd(w.fee).slice(1),
      tok(w.out),
      `${bps(w.out - oracleTokens, oracleTokens).toFixed(1)}`,
      `-${(w.asset.bandBps / 100).toFixed(1)}%`,
      keeperMin === undefined ? "none" : `+${bps(w.out - keeperMin, keeperMin).toFixed(1)}`,
      ok ? "BOUGHT" : "FAIL",
    ]);
  }

  // Assets the keeper did not buy: its own reason (its log), re-measured with this run's own reads.
  const reasonFor = (a: Asset): string => {
    const d = deferred.find((v) => lc(v.asset) === lc(a.token));
    if (d) return d.why;
    for (const t of [...ticks].reverse()) {
      const at = t.detail.toLowerCase().indexOf(lc(a.token));
      if (at < 0) continue;
      const rest = t.detail.slice(at + a.token.length).trimStart();
      if (rest.startsWith("(")) {
        let depth = 0;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "(") depth++;
          else if (rest[i] === ")" && --depth === 0) return rest.slice(1, i);
        }
      }
      return rest.split(";")[0]!.trim();
    }
    return "not swept, no reason logged";
  };
  const cfgAssets = (JSON.parse(readFileSync(join(CONTRACTS, "config", "4663.json"), "utf8")) as { assets: { token: string; hookMaxFeePips?: number }[] }).assets;
  /** How far this run's own quote of `swapIn` is under the oracle, bps, by StockRouter.oracleTokensFor. */
  const shortfallBps = async (a: Asset, swapIn: bigint) => {
    const zeroForOne = lc(a.poolKey.currency0) === lc(USDG);
    const [{ result }, [, price]] = await Promise.all([
      pub.simulateContract({
        address: VENUE.v4Quoter as Address,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: a.poolKey, zeroForOne, exactAmount: swapIn, hookData: "0x" }],
      }),
      read<readonly [number, bigint]>(book.stockRouter, stockRouterAbi as Abi, "oracleStatus", [a.token]),
    ]);
    const fair = await read<bigint>(book.stockRouter, stockRouterAbi as Abi, "oracleTokensFor", [swapIn, price]);
    return Number(((fair - result[0]) * 1_000_000n) / fair) / 100;
  };
  const confirmHold = async (a: Asset, u: User, why: string): Promise<{ ok: boolean; note: string; measured?: number }> => {
    const nums = (re: RegExp) => re.exec(why)?.slice(1).map(Number) ?? null;
    try {
      let m = nums(/pool (-?[\d.]+) bps under the oracle at \$1 \(max ([\d.]+)/);
      if (m) {
        const s = await shortfallBps(a, ONE);
        return { ok: Math.abs(s - m[0]!) <= 0.2 && m[0]! > m[1]!, note: `this run's own $1 quote is ${s.toFixed(1)} bps under the oracle, past the keeper's ${m[1]}`, measured: s };
      }
      m = nums(/quote (-?[\d.]+) bps under the oracle \(max ([\d.]+)/);
      if (m) {
        const total = expected.get(u)!;
        const s = await shortfallBps(a, total - (total * BigInt(feeBps)) / 10_000n);
        return {
          ok: Math.abs(s - m[0]!) <= 0.2 && m[0]! > m[1]!,
          note: `this run's own quote for the ${usd2(total)} leg is ${s.toFixed(1)} bps under the oracle, past the keeper's ${m[1]} (the band is ${a.bandBps})`,
          measured: s,
        };
      }
      m = nums(/hook fee (\d+) pips is above the keeper's (\d+)/);
      if (m) {
        const k = a.poolKey;
        const poolId = keccak256(
          encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]),
        );
        const fee = Number(await read<number>(k.hooks, hookAbi, "currentFee", [poolId, BigInt(USDG) < BigInt(a.token)]));
        const ceiling = cfgAssets.find((c) => lc(c.token) === lc(a.token))?.hookMaxFeePips;
        return { ok: fee === m[0] && ceiling !== undefined && fee > ceiling && m[1] === ceiling, note: `the hook's fee read now is ${fee} pips; contracts/config/4663.json pins ${ceiling ?? "nothing"}` };
      }
      m = nums(/oracle status (\d+)/);
      if (m) {
        const [status] = await read<readonly [number, bigint]>(book.stockRouter, stockRouterAbi as Abi, "oracleStatus", [a.token]);
        return { ok: Number(status) !== 0, note: `StockRouter.oracleStatus reads ${status} (0 = OK)` };
      }
    } catch (err) {
      return { ok: false, note: `could not re-measure: ${errText(err)}` };
    }
    return { ok: false, note: "not a reason this run can confirm" };
  };
  const held: { a: Asset; why: string; confirm: { ok: boolean; note: string; measured?: number } }[] = [];
  for (const a of assets) {
    if (verdict.has(lc(a.token))) continue;
    const why = reasonFor(a);
    const confirm = await confirmHold(a, users.find((u) => u.asset === a)!, why);
    held.push({ a, why, confirm });
    rows.push([
      a.symbol,
      lc(a.poolKey.hooks) === lc("0x0000000000000000000000000000000000000000") ? `v4 ${a.poolKey.fee / 100}bp` : "v4 hook",
      "-",
      "-",
      "-",
      "-",
      confirm.measured === undefined ? "-" : `${(-confirm.measured).toFixed(1)} (quote)`,
      `-${(a.bandBps / 100).toFixed(1)}%`,
      "-",
      "HELD",
    ]);
  }
  const head = ["asset", "pool", "users", "usdg in", "fee", "tokens out", "vs oracle bps", "band", "vs limit bps", "result"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  console.log("");
  console.log(`        ${head.map((h, i) => h.padEnd(widths[i]!)).join("  ")}`);
  for (const r of rows) console.log(`        ${r.map((c, i) => c.padEnd(widths[i]!)).join("  ")}`);
  info("vs oracle: the fill against StockRouter's oracle price (negative = fewer tokens); vs limit: the fill");
  info("against the keeper's limit, which sits QUOTE_TOLERANCE_BPS under its same-block quote (nothing else trades on the fork).");
  for (const h of held) {
    info(`${h.a.symbol} held by the keeper: ${h.why}`);
    info(`  ${h.confirm.ok ? "confirmed" : "NOT confirmed"}: ${h.confirm.note}`);
  }
  console.log("");
  const boughtOk = [...verdict.values()].filter((v) => v.ok).length;
  const badSwaps = [...verdict.entries()].filter(([, v]) => !v.ok);
  check(badSwaps.length === 0 && swaps.length > 0, `${swaps.length} swaps: every fill inside its oracle band, at or above the keeper's quote limit, fee exactly ${feeBps} bps`, badSwaps.map(([t, v]) => `${assets.find((a) => lc(a.token) === t)?.symbol}: ${v.why}`).join("; ") || undefined);
  const unconfirmed = held.filter((h) => !h.confirm.ok);
  check(
    unconfirmed.length === 0 && (!STRICT || held.length === 0),
    held.length
      ? `${boughtOk}/${assets.length} active assets bought; the keeper held ${held.length} (${held.map((h) => h.a.symbol).join(", ")}), ${held.length - unconfirmed.length}/${held.length} holds confirmed by this run's own reads`
      : `${boughtOk}/${assets.length} active assets bought through their own pools`,
    STRICT && held.length ? "PROVE_STRICT=1 counts every hold as a failure" : unconfirmed.map((h) => `${h.a.symbol}: ${h.confirm.note}`).join("; ") || undefined,
  );
  const netted = swaps.filter((w) => w.contributors.length > 1);
  if (netted.length) info(`netted: ${netted.map((w) => `${w.asset.symbol} (${w.contributors.length} users, one swap)`).join(", ")}; the default-mix user's legs split ${defaultMix.map((l) => `${Number(l.bps) / 100}%`).join(" / ")}`);
  const vault1 = await read<bigint>(USDG, erc20, "balanceOf", [book.feeVault]);
  const fees = swaps.reduce((s, w) => s + w.fee, 0n);
  check(vault1 - vault0 === fees, `FeeVault received exactly the swaps' fees`, usd(fees));

  section("5. delivery and claim");
  const deliverErr: string[] = [];
  let deliveries = 0;
  for (const u of due) {
    for (const l of legsOf(u)) {
      const after = await read<bigint>(l.asset, erc20, "balanceOf", [addr(u)]);
      const got = after - balBefore.get(`${lc(addr(u))}|${lc(l.asset)}`)!;
      const want = swaps.filter((w) => lc(w.asset.token) === lc(l.asset)).reduce((s, w) => s + (w.delivered.get(lc(addr(u))) ?? 0n), 0n);
      if (got !== want) deliverErr.push(`${u.name}: ${tok(got)} received, ${tok(want)} delivered`);
      else if (want > 0n) deliveries++;
      const claimable = await read<bigint>(x, sweepExecutorAbi as Abi, "claimable", [addr(u), l.asset]);
      if (claimable > 0n) {
        await tx(u.key, x, sweepExecutorAbi as Abi, "claim", [l.asset]);
        const left = await read<bigint>(x, sweepExecutorAbi as Abi, "claimable", [addr(u), l.asset]);
        if (left !== 0n) deliverErr.push(`${u.name}: claim left ${left}`);
      }
    }
  }
  const pushedAll = swaps.every((w) => w.heldForClaim === 0n);
  check(deliverErr.length === 0, `${deliveries} deliveries landed in the users' wallets, pro rata inside the netted swaps`, deliverErr.slice(0, 3).join("; ") || undefined);
  check(pushedAll, "every delivery was pushed; nothing waits in claimable()", pushedAll ? undefined : "some deliveries were held and claimed above");
  const sweptWrong = due.filter((u) => {
    const s = sweptUsdg.get(lc(addr(u)));
    return s !== undefined && s !== expected.get(u);
  });
  check(sweptWrong.length === 0, "each swept user's whole park went into the sweep (AccountSwept = accrued)", sweptWrong.map((u) => u.name).join(", ") || undefined);

  // ── 6. exit ───────────────────────────────────────────────────────────────
  if (held.length) {
    const heldUsers = held.map((h) => users.find((u) => u.asset === h.a)!);
    const kept = await Promise.all(
      heldUsers.map(async (u) => {
        const [v, e] = await Promise.all([
          read<bigint>(book.cashPark, cashParkAbi as Abi, "valueOf", [addr(u)]),
          read<bigint>(x, sweepExecutorAbi as Abi, "sweptEpoch", [addr(u)]),
        ]);
        return v === expected.get(u) && e !== epoch;
      }),
    );
    check(kept.every(Boolean), `each held user's park is untouched and its epoch unspent (${heldUsers.map((u) => u.name).join(", ")}): the keeper retries next tick`);
  }

  section("6. exit: CashPark.exit returns everything still parked");
  await tx(keeperKey, book.cashPark, cashParkAbi as Abi, "park", [[addr(parker)]]);
  const units = await read<bigint>(book.cashPark, cashParkAbi as Abi, "units", [addr(parker)]);
  check(units > 0n && (await pending(parker)) === 0n, `the "parked" user's ${usd2(expected.get(parker)!)} moved into the live park adapter (${units} units)`);
  const exiters = [saver, parker, ...held.map((h) => users.find((u) => u.asset === h.a)!), ...users.filter((u) => sweptUsdg.has(lc(addr(u)))).slice(0, 1)];
  const exitErr: string[] = [];
  const exitNotes: string[] = [];
  for (const u of exiters) {
    const [v0, b0] = await Promise.all([read<bigint>(book.cashPark, cashParkAbi as Abi, "valueOf", [addr(u)]), read<bigint>(USDG, erc20, "balanceOf", [addr(u)])]);
    await tx(u.key, book.cashPark, cashParkAbi as Abi, "exit", []);
    const [v1, b1] = await Promise.all([read<bigint>(book.cashPark, cashParkAbi as Abi, "valueOf", [addr(u)]), read<bigint>(USDG, erc20, "balanceOf", [addr(u)])]);
    const owed = expected.get(u)! - (sweptUsdg.get(lc(addr(u))) ?? 0n);
    if (b1 - b0 !== v0 || v1 !== 0n || v0 !== owed) exitErr.push(`${u.name}: had ${usd(v0)}, got ${usd(b1 - b0)}, left ${usd(v1)}, owed ${usd(owed)}`);
    exitNotes.push(`${u.role === "asset" ? `${u.name} user` : u.name} ${usd2(b1 - b0)}`);
  }
  check(exitErr.length === 0, `${exiters.length} exits returned every parked dollar and left nothing behind`, exitErr.join("; ") || exitNotes.join(", "));
  const leftover = await Promise.all(users.filter((u) => sweptUsdg.has(lc(addr(u)))).map((u) => read<bigint>(book.cashPark, cashParkAbi as Abi, "valueOf", [addr(u)])));
  check(leftover.every((v) => v === 0n), "every swept user's park is empty (nothing stranded)");

  info(`run took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return 0;
}

// ── run ───────────────────────────────────────────────────────────────────────

let code = 1;
try {
  await main();
} catch (err) {
  const msg = err instanceof Abort ? err.message : `${errText(err)}`;
  check(false, "the run could not finish", msg);
  if (/historical state|state.*not available|missing trie node/i.test(String((err as Error)?.message ?? err))) {
    info("The public RPC no longer serves state at the fork block (it keeps ~10 minutes). Run again, or set PROVE_RPC_URL to an archive endpoint.");
  }
  if (!(err instanceof Abort)) console.error(err);
} finally {
  await stopFork();
}
const failed = results.filter((r) => !r.ok);
// The fork's log is kept only when something failed (or the fork is kept).
if (failed.length === 0 && !KEEP_FORK && anvilLog) rmSync(anvilLog, { force: true });
console.log(`\n== summary`);
console.log(`  ${results.length - failed.length} PASS, ${failed.length} FAIL`);
for (const f of failed) console.log(`  FAIL  ${f.what}`);
if (KEEP_FORK && anvilProc) console.log(`  the fork is still running (PROVE_KEEP_FORK=1); stop anvil when done`);
console.log(failed.length === 0 ? "\nPROVE: PASS" : "\nPROVE: FAIL");
code = failed.length === 0 ? 0 : 1;
process.exit(code);
