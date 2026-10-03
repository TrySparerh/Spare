/**
 * SPARE engine schema.
 *
 * Conventions
 *   - EVM addresses are stored LOWER-CASED hex (they are case-insensitive; the
 *     API returns them EIP-55 checksummed). Never apply this to non-EVM ids.
 *   - Money is stored as numeric(78,0) BASE UNITS: USDG has 6 decimals, stock
 *     tokens 18. Never floats, never pre-formatted dollars.
 *   - Block numbers are L2 blocks (eth_blockNumber == ArbSys.arbBlockNumber),
 *     the same clock the contracts' L2Clock uses. Never Solidity block.number,
 *     which on Nitro is an L1 estimate.
 *   - Block times come from eth_getBlockByNumber. Nitro returns
 *     `blockTimestamp: "0x0"` on logs — it is not a timestamp.
 *   - Every chain-derived row carries (tx_hash, log_index) so re-indexing a
 *     range is idempotent.
 *
 * Hypertables (created in migrate.ts when TimescaleDB is present):
 *   payments(block_time), oracle_snapshots(observed_at).
 *   Timescale requires the partition column in every unique index, so their
 *   primary keys include it. For payments that is (tx_hash, log_index,
 *   block_time): because only blocks behind the finality buffer are indexed, a
 *   log's block — and so its time — is fixed, and the key is exactly as unique
 *   as (tx_hash, log_index). On plain Postgres migrate.ts adds the literal
 *   unique(tx_hash, log_index) index as well.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const amount = (name: string) => numeric(name, { precision: 78, scale: 0 });
const block = (name: string) => bigint(name, { mode: "bigint" });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// chain_binding — one engine database indexes one chain. Never relabel.
// ---------------------------------------------------------------------------
export const chainBinding = pgTable("chain_binding", {
  id: integer("id").primaryKey().default(1),
  chainId: integer("chain_id").notNull(),
  boundAt: tstz("bound_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// links — RuleRegistry.Linked / Unlinked. One row per link episode.
// The chain (RuleRegistry.walletsOf / accountOf) is authoritative for the
// CURRENT set; this table is the history the ledger needs.
// ---------------------------------------------------------------------------
export const links = pgTable(
  "links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    wallet: text("wallet").notNull(),
    linkedBlock: block("linked_block").notNull(),
    linkedAt: tstz("linked_at"),
    linkedTx: text("linked_tx").notNull(),
    linkedLogIndex: integer("linked_log_index").notNull(),
    unlinkedBlock: block("unlinked_block"),
    unlinkedAt: tstz("unlinked_at"),
    unlinkedTx: text("unlinked_tx"),
    unlinkedLogIndex: integer("unlinked_log_index"),
  },
  (t) => [
    uniqueIndex("links_linked_log_idx").on(t.linkedTx, t.linkedLogIndex),
    index("links_account_idx").on(t.account, t.linkedBlock.desc()),
    index("links_wallet_idx").on(t.wallet, t.linkedBlock.desc()),
  ],
);

// ---------------------------------------------------------------------------
// rules — RuleRegistry.RuleSet history (append-only). Latest row per account
// is the current rule; the history lets a payment be priced with the rule
// that was in force at its block.
// ---------------------------------------------------------------------------
export const rules = pgTable(
  "rules",
  {
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    roundTo: smallint("round_to").notNull(),
    multiplier: smallint("multiplier").notNull(),
    weeklyCap: amount("weekly_cap").notNull(),
    enabled: boolean("enabled").notNull(),
    blockNumber: block("block_number").notNull(),
    blockTime: tstz("block_time"),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("rules_account_block_idx").on(t.account, t.blockNumber.desc()),
  ],
);

// ---------------------------------------------------------------------------
// mixes — ElectionRegistry.MixSet / MixCleared / DefaultMixSet history.
// The default mix is stored with account = the zero address.
// ---------------------------------------------------------------------------
export const mixes = pgTable(
  "mixes",
  {
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    kind: text("kind").notNull().$type<"set" | "cleared" | "default">(),
    legs: jsonb("legs").notNull().$type<{ asset: string; bps: number }[]>(),
    blockNumber: block("block_number").notNull(),
    blockTime: tstz("block_time"),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("mixes_account_block_idx").on(t.account, t.blockNumber.desc()),
  ],
);

// ---------------------------------------------------------------------------
// payments — Timescale hypertable on block_time.
// One row per outgoing USDG Transfer from a linked wallet, observed from the
// wallet's link block onward. `delta` is the round-up under (round_to,
// multiplier) — the rule in force at the payment's block — and is 0 when the
// transfer is excluded (§3.2), in which case `excluded_reason` says why.
// ---------------------------------------------------------------------------
export const payments = pgTable(
  "payments",
  {
    chainId: integer("chain_id").notNull(),
    wallet: text("wallet").notNull(),
    account: text("account").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: block("block_number").notNull(),
    blockTime: tstz("block_time").notNull(),
    amount: amount("amount").notNull(),
    counterparty: text("counterparty").notNull(),
    excludedReason: text("excluded_reason"),
    delta: amount("delta").notNull(),
    roundTo: smallint("round_to").notNull(),
    multiplier: smallint("multiplier").notNull(),
    /** accrual_batches.id once the payment's range has been accrued. */
    batchId: uuid("batch_id"),
    observedAt: tstz("observed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "payments_pkey", columns: [t.txHash, t.logIndex, t.blockTime] }),
    index("payments_account_time_idx").on(t.account, t.blockTime.desc()),
    index("payments_wallet_block_idx").on(t.wallet, t.blockNumber),
  ],
);

// ---------------------------------------------------------------------------
// accrual_batches — one row per SweepExecutor accrual (planned by the
// accrual-ledger worker, then confirmed from the Accrued event). `requested`
// is the sum of the range's deltas; `amount` is what was pulled after the
// weekly cap / Permit2 allowance bound it.
// ---------------------------------------------------------------------------
export const accrualBatches = pgTable(
  "accrual_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    wallet: text("wallet").notNull(),
    fromBlock: block("from_block").notNull(),
    toBlock: block("to_block").notNull(),
    requested: amount("requested").notNull(),
    amount: amount("amount").notNull(),
    cappedBy: text("capped_by").$type<"weekly-cap" | "permit2-allowance" | "balance" | null>(),
    paymentCount: integer("payment_count").notNull().default(0),
    status: text("status")
      .notNull()
      .$type<"planned" | "simulated" | "submitted" | "confirmed" | "failed">()
      .default("planned"),
    /** 'keeper' = planned by this engine; 'chain' = observed Accrued event only. */
    source: text("source").notNull().$type<"keeper" | "chain">().default("keeper"),
    txHash: text("tx_hash"),
    logIndex: integer("log_index"),
    blockNumber: block("block_number"),
    blockTime: tstz("block_time"),
    error: text("error"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("accrual_batches_log_idx")
      .on(t.txHash, t.logIndex)
      .where(sql`${t.txHash} is not null`),
    index("accrual_batches_account_idx").on(t.account, t.createdAt.desc()),
    index("accrual_batches_wallet_idx").on(t.wallet, t.toBlock.desc()),
  ],
);

// ---------------------------------------------------------------------------
// cursors — durable indexing coverage, one row per (chain, name).
// Names are shared by the core and the planned workers (workers/cursors.ts):
//   "chain-indexer"            SPARE contract events
//   "payments:<wallet>"        USDG Transfer(from = wallet) coverage
// start_block..last_block is the FULLY scanned, contiguous range.
// ---------------------------------------------------------------------------
export const cursors = pgTable(
  "cursors",
  {
    chainId: integer("chain_id").notNull(),
    name: text("name").notNull(),
    /** Hash of the source contract set; a redeploy never silently reuses a cursor. */
    source: text("source").notNull(),
    startBlock: block("start_block").notNull(),
    lastBlock: block("last_block"),
    lastHash: text("last_hash"),
    observedHead: block("observed_head"),
    lastAttemptAt: tstz("last_attempt_at").notNull().defaultNow(),
    lastSuccessAt: tstz("last_success_at"),
    lastError: text("last_error"),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.name] })],
);

// ---------------------------------------------------------------------------
// sweeps — SweepExecutor.AccountSwept (one row per account per sweep tx).
// ---------------------------------------------------------------------------
export const sweeps = pgTable(
  "sweeps",
  {
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    epoch: block("epoch").notNull(),
    usdg: amount("usdg").notNull(),
    blockNumber: block("block_number").notNull(),
    blockTime: tstz("block_time"),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    uniqueIndex("sweeps_account_epoch_idx").on(t.chainId, t.account, t.epoch),
    index("sweeps_account_block_idx").on(t.account, t.blockNumber.desc()),
  ],
);

// ---------------------------------------------------------------------------
// sweep_fills — SweepExecutor.AssetSwept (+ the StockRouter.Bought oracle
// price from the same tx): one netted swap per asset per sweep tx.
// ---------------------------------------------------------------------------
export const sweepFills = pgTable(
  "sweep_fills",
  {
    chainId: integer("chain_id").notNull(),
    asset: text("asset").notNull(),
    usdgIn: amount("usdg_in").notNull(),
    fee: amount("fee").notNull(),
    tokensOut: amount("tokens_out").notNull(),
    oraclePrice1e18: amount("oracle_price_1e18"),
    blockNumber: block("block_number").notNull(),
    blockTime: tstz("block_time"),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("sweep_fills_tx_idx").on(t.txHash),
  ],
);

// ---------------------------------------------------------------------------
// deliveries — what each account received from a sweep, and what did not
// convert. `token` is what moved (USDG for usdg / deferred / safe_settled
// rows; `asset` then names the leg). kind:
//   delivered     Delivered(token = asset)        tokens pushed to the account
//   usdg          Delivered(token = USDG)         a safe-settled leg's USDG
//   held          DeliveryHeld                    push refused; claimable
//   safe_settled  SafeSettled(asset, usdg, reason) leg paid out as USDG
//   deferred      Deferred(asset, usdg, status)   leg returned to the park
//   claimed       Claimed                         a held delivery collected
// ---------------------------------------------------------------------------
export const deliveries = pgTable(
  "deliveries",
  {
    chainId: integer("chain_id").notNull(),
    account: text("account").notNull(),
    kind: text("kind")
      .notNull()
      .$type<"delivered" | "usdg" | "held" | "safe_settled" | "deferred" | "claimed">(),
    token: text("token").notNull(),
    asset: text("asset"),
    amount: amount("amount").notNull(),
    reason: text("reason"),
    oracleStatus: smallint("oracle_status"),
    blockNumber: block("block_number").notNull(),
    blockTime: tstz("block_time"),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("deliveries_account_block_idx").on(t.account, t.blockNumber.desc()),
    index("deliveries_tx_idx").on(t.txHash),
  ],
);

// ---------------------------------------------------------------------------
// universe — Robinhood's asset list (GET api.robinhood.com/rhj/assets) as the
// planned universe-refresher worker would store it, for tokens deployed on
// this chain. `proposal` is a SUGGESTED registry change for the contract owner
// (e.g. "listed but not registered", "status halted -> deactivate"). The engine
// never writes AssetRegistry; only the owner key can.
// ---------------------------------------------------------------------------
export const universe = pgTable(
  "universe",
  {
    chainId: integer("chain_id").notNull(),
    token: text("token").notNull(),
    sourceId: text("source_id"),
    symbol: text("symbol").notNull(),
    name: text("name"),
    decimals: smallint("decimals"),
    isin: text("isin"),
    status: text("status"),
    currentMultiplier: text("current_multiplier"),
    pendingMultiplier: text("pending_multiplier"),
    tradingCapabilities: jsonb("trading_capabilities"),
    logoUrl: text("logo_url"),
    proposal: jsonb("proposal").$type<Record<string, unknown> | null>(),
    fetchedAt: tstz("fetched_at").notNull(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.token] }),
    index("universe_symbol_idx").on(t.symbol),
  ],
);

// ---------------------------------------------------------------------------
// oracle_snapshots — Timescale hypertable on observed_at. Written by the
// nav-watcher: raw Chainlink round data plus the router's guard verdict.
// ---------------------------------------------------------------------------
export const oracleSnapshots = pgTable(
  "oracle_snapshots",
  {
    chainId: integer("chain_id").notNull(),
    feed: text("feed").notNull(),
    /** Registry token the feed prices, or null for USDG/USD, ETH/USD. */
    asset: text("asset"),
    label: text("label"),
    roundId: amount("round_id"),
    answer: amount("answer"),
    decimals: smallint("decimals").notNull(),
    updatedAt: tstz("updated_at"),
    /** OracleGuard.Status via StockRouter.oracleStatus (null if not a registry asset). */
    status: smallint("status"),
    price1e18: amount("price_1e18"),
    blockNumber: block("block_number").notNull(),
    observedAt: tstz("observed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "oracle_snapshots_pkey", columns: [t.feed, t.observedAt] }),
    index("oracle_snapshots_asset_idx").on(t.asset, t.observedAt.desc()),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type AccrualBatch = typeof accrualBatches.$inferSelect;
export type Cursor = typeof cursors.$inferSelect;
export type Sweep = typeof sweeps.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type UniverseRow = typeof universe.$inferSelect;
export type OracleSnapshot = typeof oracleSnapshots.$inferSelect;
