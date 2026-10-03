/**
 * Keeper configuration. The keeper is a standalone process: no Postgres, no
 * Redis. Every cursor it needs already lives on-chain (lastAccruedBlock,
 * linkedAt, activeSince, sweptEpoch), so a restart loses nothing; the
 * in-memory state (rule history, scan progress, backoff) is rebuilt from logs.
 *
 * Deliberately independent of src/env.ts, which enforces the API's database
 * requirements at import time.
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { hookPinsSetting } from "./hooks.ts";

const Schema = z.object({
  CHAIN_ID: z.coerce.number().int().default(4663),
  RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  KEEPER_PK: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "KEEPER_PK must be 0x + 64 hex chars"),
  /** "1" sends transactions; anything else only simulates them. */
  KEEPER_BROADCAST: z.enum(["0", "1"]).default("0"),
  ADDRESSES_JSON: z.string().min(2).optional(),
  ADDRESSES_FILE: z.string().min(1).optional(),
  ACCRUE_EVERY_MS: z.coerce.number().int().min(10_000).default(60_000),
  SWEEP_EVERY_MS: z.coerce.number().int().min(30_000).default(600_000),
  /** Tolerance applied to the same-block v4 quote to form each sweep limit. */
  QUOTE_TOLERANCE_BPS: z.coerce.number().int().min(1).max(300).default(50),
  /**
   * Advance an IDLE wallet's cursor (0-amount accrual) once its window is this
   * wide. Only a window whose round-ups total 0 is advanced; a window holding
   * real round-ups is held until consent / balance / cap room allows the pull.
   */
  IDLE_ADVANCE_BLOCKS: z.coerce.number().int().min(10_000).default(500_000),
  LOGS_MAX_RANGE: z.coerce.number().int().min(1_000).default(2_000_000),
  /** Most blocks one wallet's window is scanned per tick (incremental scan). */
  SCAN_MAX_BLOCKS: z.coerce.number().int().min(1_000).default(500_000),
  /** Wallet log scans run in parallel up to this many. */
  SCAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(6),
  /**
   * Per-wallet scan budget, per tick: RPC calls (getLogs, including range
   * splits and rate-limit retries, plus v3-pool lookups), logs returned, and
   * wall-clock time. A wallet over any of them is skipped this tick, backed
   * off, and retried over half the span, so it can never hold up the others.
   */
  SCAN_WALLET_MAX_CALLS: z.coerce.number().int().min(2).default(64),
  SCAN_WALLET_MAX_LOGS: z.coerce.number().int().min(100).default(5_000),
  SCAN_WALLET_DEADLINE_MS: z.coerce.number().int().min(1_000).default(45_000),
  /** All wallet scans of one accrue tick end by this; wallets not reached go first next tick. */
  SCAN_TICK_DEADLINE_MS: z.coerce.number().int().min(5_000).default(120_000),
  /** Blocks of margin on top of the executor's finalityBuffer. */
  FINALITY_MARGIN: z.coerce.number().int().min(0).default(20),
  /** Per-wallet exponential backoff after a failed / skipped accrual or scan. */
  BACKOFF_BASE_MS: z.coerce.number().int().min(1_000).default(300_000),
  BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).default(4 * 3_600_000),
  /** An account with no active rule / no wallets is re-read this often (events wake it sooner). */
  DORMANT_RECHECK_MS: z.coerce.number().int().min(10_000).default(3_600_000),
  /** Accounts per multicall read. */
  READ_CHUNK: z.coerce.number().int().min(1).max(500).default(50),
  /**
   * Wait this long before the first tick, so an overlapping old deployment
   * (the hosting platform starts the new container before stopping the old one) finishes
   * its in-flight tick first. /health is served immediately. The default is
   * longer than SCAN_TICK_DEADLINE_MS (120 s) plus a send and its receipt;
   * the contract does not bind an accrual amount to its start block, so two
   * overlapping keepers could pull one window twice (SECURITY.md).
   */
  STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(180_000),
  /** "1": sweep equity legs only inside the 24/5 session with a feed posted since the open. */
  MARKET_HOURS_GATE: z.enum(["0", "1"]).default("1"),
  /**
   * Registry tokens that trade around the clock (not on the US-equities 24/5
   * session), comma-separated addresses; the market-hours gate skips them.
   * Empty by default: every tokenized stock / ETF follows the equity session.
   * Config, not code, so a new 24/7 asset needs no release.
   */
  MARKET_GATE_EXEMPT: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .refine((xs) => xs.every((x) => isAddress(x, { strict: false })), "MARKET_GATE_EXEMPT must be comma-separated 0x addresses")
    .transform((xs) => new Set(xs.map((x) => x.toLowerCase()))),
  /**
   * Sweep batch size, by what the executor does per sweep: one swap per
   * distinct asset and one delivery per account leg. With dozens of assets and
   * up to MAX_LEGS legs per account, a 64-account batch could otherwise ask for
   * more gas than a block holds; accounts that don't fit wait for the next tick.
   */
  SWEEP_MAX_ASSETS: z.coerce.number().int().min(1).max(256).default(16),
  SWEEP_MAX_LEGS: z.coerce.number().int().min(1).max(64 * 6).default(192),
  /** Gas a sweep may estimate at; above it the batch is halved and re-planned. */
  SWEEP_MAX_GAS: z.coerce.bigint().default(24_000_000n),
  /**
   * Price impact (vs a $1 quote on the same pool) one sweep call's netted
   * swap of an asset may have. An account whose own leg is over it is swept
   * in a call of its own, after everyone else's; the rest are packed so no
   * call's netted swap is over it. One account's size never sets another's limit.
   */
  SWEEP_MAX_IMPACT_BPS: z.coerce.number().int().min(1).max(150).default(30),
  /**
   * A quote becomes a limit only if it is at most the pool's swap fee (LP
   * fee, slot0's for a dynamic-fee pool, plus the protocol fee) plus this many
   * bps worse than the oracle; otherwise the asset's accounts wait this tick.
   *
   * 60 = the feeds' own drift + 10 bps of margin. Chainlink's RHC equity feeds
   * post on a 0.5% (50 bps) deviation or a 24 h heartbeat, so a pool that
   * tracks the market sits up to ~50 bps from a feed that has not posted yet.
   * At 30 the keeper held healthy assets for hours on a mainnet fork (NVDA of
   * the default 60/40 mix, AAPL, GLD, GME, BABA, CRCL, DELL), and one held leg
   * holds the whole account. A pool pushed further than this still waits, and
   * QUOTE_MAX_SHORTFALL_BPS (120) still caps every full-size quote.
   */
  QUOTE_ORACLE_ALLOWANCE_BPS: z.coerce.number().int().min(0).max(150).default(60),
  /**
   * No call's full-size quote becomes a limit if it is more than this many bps
   * under the oracle, pool fee and impact included: the executor's 150 bps
   * slippage backstop and the assets' 150 bps bands would reject the fill and
   * burn the epoch. An isolated account is held to this cap alone (its size
   * only costs itself); a packed call also to pool fee + QUOTE_ORACLE_ALLOWANCE_BPS
   * + SWEEP_MAX_IMPACT_BPS.
   */
  QUOTE_MAX_SHORTFALL_BPS: z.coerce.number().int().min(0).max(140).default(120),
  /**
   * Pins for the assets that swap through a hooked pool (hooks.ts): a JSON
   * array that replaces the built-in table, e.g. after the hook's operator
   * re-configures a pool. An asset on a hooked pool with no pin is held.
   */
  HOOK_PINS: hookPinsSetting(),
  /**
   * After an isolated call (one large account swept alone, A-M1), every asset
   * it bought is held, for the rest of the tick and later ticks, until its
   * pool's $1 reference quote is back within this many bps of its pre-sweep
   * value (rebased by any oracle move since). The whale's leftover impact
   * would otherwise pass the $1 check (pool fee + QUOTE_ORACLE_ALLOWANCE_BPS)
   * and set the limits of accounts still due.
   */
  SWEEP_RECOVERY_BPS: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * The hold lapses after this long even if the quote has not come back (the
   * oracle checks still apply): a move that outlasts it is the market's, and
   * every account holding the asset waits while it lasts.
   */
  SWEEP_RECOVERY_MAX_MS: z.coerce.number().int().min(600_000).max(86_400_000).default(14_400_000),
  /** Sweep calls one tick may send (co-batched calls first, then isolated accounts); the rest wait. */
  SWEEP_MAX_CALLS: z.coerce.number().int().min(1).max(16).default(4),
  /** /health reports ok:false below this keeper ETH balance (wei). */
  LOW_GAS_WEI: z.coerce.bigint().default(500_000_000_000_000n),
  /** /health reports ok:false after this many consecutive failed or no-progress ticks. */
  HEALTH_MAX_BAD_TICKS: z.coerce.number().int().min(1).default(5),
  /** Bearer token for the detailed /health; unset, /health only ever says { ok }. */
  HEALTH_TOKEN: z.string().min(32, "HEALTH_TOKEN must be at least 32 characters").optional(),
  PORT: z.coerce.number().int().positive().optional(),
  /**
   * Address /health listens on. "::" is dual-stack (IPv6 and IPv4): the
   * private network is IPv6, and Bun's documented default (0.0.0.0) is IPv4 only.
   */
  HOST: z.string().min(1).default("::"),
});

export type KeeperConfig = z.infer<typeof Schema>;

function clean(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v.trim() !== "") out[k] = v.trim();
  return out;
}

export function loadConfig(raw: Record<string, string | undefined> = process.env): KeeperConfig {
  return Schema.parse(clean(raw));
}

export interface Book {
  chainId: number;
  startBlock: bigint;
  assetRegistry: Address;
  ruleRegistry: Address;
  electionRegistry: Address;
  screeningGate: Address;
  stockRouter: Address;
  cashPark: Address;
  feeVault: Address;
  sweepExecutor: Address;
  usdgParkAdapter?: Address;
  sgovParkAdapter?: Address;
}

const KEYS: Record<Exclude<keyof Book, "chainId" | "startBlock">, string> = {
  assetRegistry: "AssetRegistry",
  ruleRegistry: "RuleRegistry",
  electionRegistry: "ElectionRegistry",
  screeningGate: "ScreeningGate",
  stockRouter: "StockRouter",
  cashPark: "CashPark",
  feeVault: "FeeVault",
  sweepExecutor: "SweepExecutor",
  usdgParkAdapter: "UsdgParkAdapter",
  sgovParkAdapter: "SgovParkAdapter",
};
const OPTIONAL = new Set(["usdgParkAdapter", "sgovParkAdapter"]);

/** Parse the deploy's address book (contracts/addresses/<chain>.json shape). */
export function parseBook(json: unknown, chainId: number): Book {
  if (!json || typeof json !== "object") throw new Error("address book is not an object");
  const top = json as Record<string, unknown>;
  const c = (top.contracts ?? {}) as Record<string, unknown>;
  if (Number(top.chainId) !== chainId) throw new Error(`address book is for chain ${String(top.chainId)}, keeper serves ${chainId}`);
  const out: Record<string, unknown> = { chainId };
  for (const [key, name] of Object.entries(KEYS)) {
    const v = c[name] ?? top[key] ?? top[name];
    if (typeof v === "string" && isAddress(v, { strict: false })) out[key] = getAddress(v);
    else if (!OPTIONAL.has(key)) throw new Error(`address book is missing ${name}`);
  }
  const sb = top.startBlock ?? top.deployBlock;
  out.startBlock = typeof sb === "number" || typeof sb === "string" ? BigInt(sb) : 0n;
  return out as unknown as Book;
}

export function loadBook(cfg: KeeperConfig): Book {
  if (cfg.ADDRESSES_JSON) return parseBook(JSON.parse(cfg.ADDRESSES_JSON), cfg.CHAIN_ID);
  const rel = cfg.ADDRESSES_FILE ?? `../contracts/addresses/${cfg.CHAIN_ID}.json`;
  const path = isAbsolute(rel) ? rel : resolve(import.meta.dir, "../..", rel);
  if (!existsSync(path)) throw new Error(`no address book at ${path} (set ADDRESSES_JSON)`);
  return parseBook(JSON.parse(readFileSync(path, "utf8")), cfg.CHAIN_ID);
}
