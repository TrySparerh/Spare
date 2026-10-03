/**
 * Payment observation primitives for the planned roundup-observer worker (not
 * implemented; today only test/routers.fork.test.ts calls them).
 *
 * `observePayments` turns a wallet's real USDG Transfer(from = wallet) logs in a
 * block range into `payments` rows: classified (§3.2), priced with the rule that
 * was in force at each payment's block, and timestamped from the block itself.
 * `writePayments` inserts them idempotently. The worker's job is only to pick
 * ranges (runCursor with name paymentsCursorName(wallet), start = the wallet's
 * link block, confirmations = env FINALITY_BUFFER, which must equal
 * SweepExecutor.finalityBuffer) and call these two.
 *
 * EVERY outgoing transfer is stored, excluded ones included (with a reason and
 * delta 0): rule.preview and accrual.ledger treat the table as the complete
 * record for a covered range.
 */
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Address, PublicClient } from "viem";
import { blockTimes } from "./blocks.ts";
import { transfersFrom } from "./logs.ts";
import { roundUpDelta } from "../lib/roundup.ts";
import type { Classifier, LedgerReason } from "../lib/payments.ts";
import type { Db } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export interface RuleAt {
  roundTo: number;
  multiplier: number;
  weeklyCap: bigint;
  enabled: boolean;
}

/** The account's rule as of `block` (latest RuleSet at or before it), from the rules table. */
export async function ruleAtBlock(db: Db, chainId: number, account: string, block: bigint): Promise<RuleAt | null> {
  const [r] = await db
    .select()
    .from(schema.rules)
    .where(and(eq(schema.rules.chainId, chainId), eq(schema.rules.account, account.toLowerCase()), lte(schema.rules.blockNumber, block)))
    .orderBy(desc(schema.rules.blockNumber), desc(schema.rules.logIndex))
    .limit(1);
  return r ? { roundTo: r.roundTo, multiplier: r.multiplier, weeklyCap: BigInt(r.weeklyCap), enabled: r.enabled } : null;
}

export async function observePayments(opts: {
  client: PublicClient;
  chainId: number;
  token: Address;
  wallet: Address;
  account: Address;
  fromBlock: bigint;
  toBlock: bigint;
  maxRange: bigint;
  classifier: Classifier;
  /** Rule in force at a block (e.g. ruleAtBlock bound to a db/account). */
  ruleAt: (block: bigint) => Promise<RuleAt | null>;
}): Promise<schema.NewPayment[]> {
  const logs = await transfersFrom(opts.client, {
    token: opts.token,
    wallet: opts.wallet,
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    maxRange: opts.maxRange,
    maxChunks: Number.MAX_SAFE_INTEGER,
    finalBlock: opts.toBlock,
  });
  if (!logs.length) return [];
  const times = await blockTimes(opts.client, logs.map((l) => l.blockNumber));
  const rows: schema.NewPayment[] = [];
  for (const l of logs) {
    const t = times.get(l.blockNumber);
    if (t === undefined) throw new Error(`no timestamp for block ${l.blockNumber}`);
    const rule = await opts.ruleAt(l.blockNumber);
    let reason: LedgerReason | null = opts.classifier.classify(l.to);
    if (!reason && !rule) reason = "no-rule";
    if (!reason && rule && (!rule.enabled || rule.weeklyCap === 0n)) reason = "rule-disabled";
    rows.push({
      chainId: opts.chainId,
      wallet: opts.wallet.toLowerCase(),
      account: opts.account.toLowerCase(),
      txHash: l.txHash,
      logIndex: l.logIndex,
      blockNumber: l.blockNumber,
      blockTime: new Date(Number(t) * 1000),
      amount: l.amount.toString(),
      counterparty: l.to.toLowerCase(),
      excludedReason: reason,
      delta: (reason || !rule ? 0n : roundUpDelta(l.amount, rule.roundTo, rule.multiplier)).toString(),
      roundTo: rule?.roundTo ?? 0,
      multiplier: rule?.multiplier ?? 0,
    });
  }
  return rows;
}

/**
 * Insert payment rows (idempotent), then attach any that fall inside an
 * already-confirmed accrual — the chain-indexer may have seen the Accrued
 * event first; events.ts attaches in the other order.
 */
export async function writePayments(db: Db, rows: readonly schema.NewPayment[]): Promise<number> {
  if (!rows.length) return 0;
  const res = await db.insert(schema.payments).values([...rows]).onConflictDoNothing().returning({ tx: schema.payments.txHash });
  const wallets = [...new Set(rows.map((r) => r.wallet))];
  for (const w of wallets) {
    await db.execute(sql`
      update payments p set batch_id = b.id
      from accrual_batches b
      where p.batch_id is null and p.chain_id = b.chain_id and p.wallet = b.wallet and p.wallet = ${w}
        and b.status = 'confirmed' and p.block_number > b.from_block and p.block_number <= b.to_block`);
  }
  return res.length;
}
