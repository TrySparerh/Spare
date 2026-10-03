/**
 * Monitor configuration. The monitor is a standalone, read-only process: it
 * holds no key and never signs, so nothing here accepts a private key. Like
 * the keeper (keeper/config.ts) it is independent of src/env.ts, which
 * enforces the API's database requirements at import time.
 *
 * Expected roles default to the address book's `roles` block, so the monitor
 * can tell a routine owner action (re-enabling the known keeper) from a
 * hostile one (enabling an unknown keeper) without extra configuration.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { z } from "zod";
import { parseBook, type Book } from "../keeper/config.ts";
import { hookPinsSetting } from "../keeper/hooks.ts";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));

const eth = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine((v) => /^\d+(\.\d{1,18})?$/.test(v), "must be a decimal ETH amount, e.g. 0.002")
    .transform((v) => parseEther(v));

/**
 * KEEPER_MIN_ETH default, from the keeper's measured gas on 4663 (2026-10-02):
 *   - accrueBatch: 75,212 and 80,706 gas at 0.0202 / 0.0209 gwei effective
 *     = 0.0000015-0.0000017 ETH per tx (gasUsed includes the L1 data part);
 *   - eth_gasPrice now 0.035 gwei; a sweep is capped at the keeper's
 *     SWEEP_MAX_GAS = 24M gas = 0.00084 ETH at that price;
 *   - the busiest accrual cadence (one ~80k-gas accrueBatch every 60 s tick)
 *     is 1,440 x 80k x 0.035 gwei = 0.004 ETH a day.
 * 0.002 ETH leaves at least half a day of that worst case plus one max-size
 * sweep, and is 4x the keeper's own LOW_GAS_WEI (0.0005), so this alert lands
 * well before the keeper reports itself unhealthy.
 */
export const DEFAULT_KEEPER_MIN_ETH = "0.002";
/**
 * OWNER_MIN_ETH default: the owner (and pauser) must always be able to pause
 * and rotate the keeper. An incident is ~10 txs of <= 100k gas; at 0.035 gwei
 * that is 0.000035 ETH, so 0.001 ETH still covers it through a 25x gas spike.
 */
export const DEFAULT_OWNER_MIN_ETH = "0.001";

export const DEFAULT_EXPLORER: Record<number, string> = {
  4663: "https://robinhoodchain.blockscout.com",
};

const Schema = z.object({
  CHAIN_ID: z.coerce.number().int().default(4663),
  RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  ADDRESSES_JSON: z.string().min(2).optional(),
  ADDRESSES_FILE: z.string().min(1).optional(),
  /** OpenZeppelin TimelockController that owns the contracts, once there is one. */
  TIMELOCK_ADDRESS: address.optional(),
  /** Expected role holders; default to the address book's `roles`. */
  OWNER_ADDRESS: address.optional(),
  KEEPER_ADDRESS: address.optional(),
  PAUSER_ADDRESS: address.optional(),
  ATTESTOR_ADDRESS: address.optional(),
  /**
   * ETH floors (decimal ETH). 0 disables that balance alert, e.g. OWNER_MIN_ETH
   * once the owner is a timelock (it pays no gas; its Safe signers do).
   */
  KEEPER_MIN_ETH: eth(DEFAULT_KEEPER_MIN_ETH),
  OWNER_MIN_ETH: eth(DEFAULT_OWNER_MIN_ETH),
  /** Checked only when the pauser is not the owner. */
  PAUSER_MIN_ETH: eth(DEFAULT_OWNER_MIN_ETH),
  POLL_MS: z.coerce.number().int().min(5_000).default(30_000),
  /** First block to scan on a start without saved state. Default: head - LOOKBACK_BLOCKS. */
  START_BLOCK: z.coerce.bigint().min(0n).optional(),
  /**
   * On a start without saved state, events older than head - LOOKBACK_BLOCKS
   * are logged as history and NOT pushed to Telegram / webhook, so a restart
   * (or a START_BLOCK far back) never re-sends old alerts. ~1h of blocks.
   */
  LOOKBACK_BLOCKS: z.coerce.bigint().min(0n).default(36_000n),
  /** Max L2 blocks per eth_getLogs. Halved for good on a provider range / result cap. */
  LOGS_RANGE: z.coerce.bigint().min(100n).max(10_000_000n).default(50_000n),
  /** getLogs chunks per poll: a long catch-up advances in bounded steps. */
  MAX_CHUNKS_PER_POLL: z.coerce.number().int().min(1).max(10_000).default(200),
  /** Scan this far behind head (a lagging node can truncate the newest blocks). */
  CONFIRMATIONS: z.coerce.bigint().min(0n).default(64n),
  /** RPC failures must persist this long before they alert. */
  RPC_DOWN_MINUTES: z.coerce.number().min(1).default(5),
  /**
   * keeper.idle: no keeper tx for this long while a linked wallet is one the
   * keeper must act on. The keeper zero-advances an idle wallet every
   * IDLE_ADVANCE_BLOCKS (500k blocks, ~14h at ~0.1s blocks), so 18h is a miss.
   */
  KEEPER_IDLE_MINUTES: z.coerce.number().min(10).default(1_080),
  /** sweep.overdue: an account due for a sweep this long during the 24/5 session. */
  SWEEP_OVERDUE_MINUTES: z.coerce.number().min(10).default(120),
  /** Balances, nonce and role / wiring invariants are read this often. */
  CHECK_EVERY_MS: z.coerce.number().int().min(10_000).default(300_000),
  /** Per-account liveness reads (sweep due, accrual consent) run this often. */
  LIVENESS_EVERY_MS: z.coerce.number().int().min(30_000).default(600_000),
  /** getLogs chunks per poll spent rebuilding the linked-wallet set from the deploy block. */
  DISCOVERY_CHUNKS_PER_POLL: z.coerce.number().int().min(1).max(10_000).default(20),
  /** A condition that stays bad is re-sent this often. */
  REPEAT_MINUTES: z.coerce.number().min(1).default(360),
  /** The keeper's /health on the private network, e.g. http://keeper.internal:8080/health */
  KEEPER_HEALTH_URL: z.string().url().optional(),
  /**
   * The keeper's HEALTH_TOKEN. Without it the keeper answers { ok } only, so
   * keeper.unhealthy works but keeper.stalled (needs its tick history) cannot.
   */
  KEEPER_HEALTH_TOKEN: z.string().min(32).optional(),
  /** keeper.stalled: the keeper's newest tick is older than this. Ticks run every 60s. */
  KEEPER_TICK_STALE_MINUTES: z.coerce.number().min(2).default(15),
  TELEGRAM_BOT_TOKEN: z.string().min(10).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  /** Discord / Slack incoming webhook (the body carries both `content` and `text`). */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** Least severe alert each sink receives, e.g. Telegram critical-only, the webhook everything. */
  TELEGRAM_MIN_SEVERITY: z.enum(["critical", "warning", "info"]).default("info"),
  WEBHOOK_MIN_SEVERITY: z.enum(["critical", "warning", "info"]).default("info"),
  /** Messages per minute per sink; bursts are packed into few messages and queued. */
  SINK_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(20),
  /** JSON file for the cursor, dedupe keys and open conditions (mount a persistent volume). */
  STATE_FILE: z.string().min(1).optional(),
  EXPLORER_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().max(65535).optional(),
  /**
   * The hooked pools to watch (keeper/hooks.ts; the keeper's own HOOK_PINS,
   * same format): every fee-setting event of their hooks for those pools, and
   * each hook's authority and fee cap against its pin.
   */
  HOOK_PINS: hookPinsSetting(),
});

export type MonitorConfig = Omit<z.infer<typeof Schema>, "EXPLORER_URL"> & { EXPLORER_URL: string | null };

function clean(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v.trim() !== "") out[k] = v.trim();
  return out;
}

export function loadMonitorConfig(raw: Record<string, string | undefined> = process.env): MonitorConfig {
  const c = Schema.parse(clean(raw));
  if (Boolean(c.TELEGRAM_BOT_TOKEN) !== Boolean(c.TELEGRAM_CHAT_ID)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
  }
  return { ...c, EXPLORER_URL: (c.EXPLORER_URL ?? DEFAULT_EXPLORER[c.CHAIN_ID] ?? null)?.replace(/\/+$/, "") ?? null };
}

export interface Roles {
  owner: Address | null;
  keeper: Address | null;
  pauser: Address | null;
  attestor: Address | null;
}

/** The keeper's Book plus what the monitor checks state against. */
export interface MonitorBook extends Book {
  roles: Roles;
  /** Book key of the adapter CashPark should point at (parkAdapter.live), if recorded. */
  liveAdapter: "usdgParkAdapter" | "sgovParkAdapter" | null;
  /** ScreeningGate.enforced as deployed, if recorded. */
  screeningEnforced: boolean | null;
}

function role(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

export function parseMonitorBook(json: unknown, chainId: number): MonitorBook {
  const book = parseBook(json, chainId);
  const top = json as Record<string, unknown>;
  const r = (top.roles && typeof top.roles === "object" ? top.roles : {}) as Record<string, unknown>;
  const pa = (top.parkAdapter && typeof top.parkAdapter === "object" ? top.parkAdapter : {}) as Record<string, unknown>;
  const live = pa.live === "UsdgParkAdapter" ? "usdgParkAdapter" : pa.live === "SgovParkAdapter" ? "sgovParkAdapter" : null;
  return {
    ...book,
    roles: { owner: role(r.owner), keeper: role(r.keeper), pauser: role(r.pauser), attestor: role(r.attestor) },
    liveAdapter: live && book[live] ? live : null,
    screeningEnforced: typeof top.screeningEnforced === "boolean" ? top.screeningEnforced : null,
  };
}

/** ADDRESSES_JSON wins; else ADDRESSES_FILE (relative to engine/) or the repo's book. */
export function loadMonitorBook(cfg: MonitorConfig): MonitorBook {
  let book: MonitorBook;
  if (cfg.ADDRESSES_JSON) {
    book = parseMonitorBook(JSON.parse(cfg.ADDRESSES_JSON), cfg.CHAIN_ID);
  } else {
    const rel = cfg.ADDRESSES_FILE ?? `../contracts/addresses/${cfg.CHAIN_ID}.json`;
    const path = isAbsolute(rel) ? rel : resolve(import.meta.dir, "../..", rel);
    if (!existsSync(path)) throw new Error(`no address book at ${path} (set ADDRESSES_JSON)`);
    book = parseMonitorBook(JSON.parse(readFileSync(path, "utf8")), cfg.CHAIN_ID);
  }
  return withRoleOverrides(book, cfg);
}

/** Explicit env overrides the book's roles: e.g. after the owner moves to a Safe + timelock. */
export function withRoleOverrides(book: MonitorBook, cfg: MonitorConfig): MonitorBook {
  return {
    ...book,
    roles: {
      owner: cfg.OWNER_ADDRESS ?? book.roles.owner,
      keeper: cfg.KEEPER_ADDRESS ?? book.roles.keeper,
      pauser: cfg.PAUSER_ADDRESS ?? book.roles.pauser,
      attestor: cfg.ATTESTOR_ADDRESS ?? book.roles.attestor,
    },
  };
}
