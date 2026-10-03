/**
 * SPARE contract events -> database rows.
 *
 * This is the mapping the routers read back (links, rules, mixes,
 * accrual_batches, sweeps, sweep_fills, deliveries), kept in the core so the
 * planned chain-indexer worker writes exactly what the API expects (today only
 * test/routers.fork.test.ts calls `writeEventRows`). It is pure except
 * for `writeEventRows`, which applies the rows idempotently inside the
 * caller's transaction (re-indexing a range is a no-op).
 *
 * Block times must be supplied by the caller from eth_getBlockByNumber —
 * Nitro logs carry `blockTimestamp: "0x0"`.
 */
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { parseEventLogs, type Address, type Log } from "viem";
import { electionRegistryAbi, ruleRegistryAbi, stockRouterAbi, sweepExecutorAbi } from "./abis.ts";
import type { SpareAddresses } from "./addresses.ts";
import { ZERO_ADDRESS } from "./constants.ts";
import type { Db } from "../db/client.ts";
import * as schema from "../db/schema.ts";

const lc = (a: string) => a.toLowerCase();

type Meta = { blockNumber: bigint; txHash: string; logIndex: number; blockTime: Date | null };

export type SpareEvent =
  | (Meta & { kind: "linked"; account: string; wallet: string })
  | (Meta & { kind: "unlinked"; account: string; wallet: string })
  | (Meta & { kind: "rule"; account: string; roundTo: number; multiplier: number; weeklyCap: bigint; enabled: boolean })
  | (Meta & { kind: "mix"; account: string; mixKind: "set" | "cleared" | "default"; legs: { asset: string; bps: number }[] })
  | (Meta & { kind: "accrued"; account: string; wallet: string; amount: bigint; fromBlock: bigint; toBlock: bigint })
  | (Meta & { kind: "swept"; account: string; epoch: bigint; usdg: bigint })
  | (Meta & { kind: "fill"; asset: string; usdgIn: bigint; fee: bigint; tokensOut: bigint; oraclePrice1e18: bigint | null })
  | (Meta & {
      kind: "delivery";
      account: string;
      deliveryKind: "delivered" | "usdg" | "held" | "safe_settled" | "deferred" | "claimed";
      token: string;
      asset: string | null;
      amount: bigint;
      reason: string | null;
      oracleStatus: number | null;
    });

/** The contracts whose events the chain-indexer must scan (cursor source order). */
export function indexedContracts(a: SpareAddresses): Address[] {
  return [a.ruleRegistry, a.electionRegistry, a.sweepExecutor, a.stockRouter];
}

/**
 * Decode every SPARE event in `logs` (any order, any mix of contracts) into
 * typed events sorted by (block, logIndex). Unrelated logs are ignored.
 */
export function decodeSpareLogs(
  logs: readonly Log[],
  a: SpareAddresses,
  usdg: Address,
  blockTimes: ReadonlyMap<bigint, bigint> = new Map(),
): SpareEvent[] {
  const from = (addr: string) => logs.filter((l) => lc(l.address) === lc(addr)) as Log[];
  const meta = (l: { blockNumber: bigint | null; transactionHash: string | null; logIndex: number | null }): Meta => {
    if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) {
      throw new Error("unmined log passed to decodeSpareLogs");
    }
    const t = blockTimes.get(l.blockNumber);
    return { blockNumber: l.blockNumber, txHash: l.transactionHash, logIndex: l.logIndex, blockTime: t === undefined ? null : new Date(Number(t) * 1000) };
  };
  const out: SpareEvent[] = [];

  for (const l of parseEventLogs({ abi: ruleRegistryAbi, logs: from(a.ruleRegistry) })) {
    if (l.eventName === "Linked") out.push({ ...meta(l), kind: "linked", account: lc(l.args.account), wallet: lc(l.args.wallet) });
    else if (l.eventName === "Unlinked") out.push({ ...meta(l), kind: "unlinked", account: lc(l.args.account), wallet: lc(l.args.wallet) });
    else if (l.eventName === "RuleSet") {
      out.push({
        ...meta(l),
        kind: "rule",
        account: lc(l.args.account),
        roundTo: l.args.roundTo,
        multiplier: l.args.multiplier,
        weeklyCap: BigInt(l.args.weeklyCap),
        enabled: l.args.enabled,
      });
    }
  }

  for (const l of parseEventLogs({ abi: electionRegistryAbi, logs: from(a.electionRegistry) })) {
    const legs = (xs: readonly { asset: Address; bps: number }[]) => xs.map((x) => ({ asset: lc(x.asset), bps: x.bps }));
    if (l.eventName === "MixSet") out.push({ ...meta(l), kind: "mix", account: lc(l.args.account), mixKind: "set", legs: legs(l.args.legs) });
    else if (l.eventName === "MixCleared") out.push({ ...meta(l), kind: "mix", account: lc(l.args.account), mixKind: "cleared", legs: [] });
    else if (l.eventName === "DefaultMixSet") out.push({ ...meta(l), kind: "mix", account: ZERO_ADDRESS, mixKind: "default", legs: legs(l.args.legs) });
  }

  // Router Bought events carry the oracle price each netted fill was checked against.
  const bought = parseEventLogs({ abi: stockRouterAbi, logs: from(a.stockRouter), eventName: "Bought" });

  for (const l of parseEventLogs({ abi: sweepExecutorAbi, logs: from(a.sweepExecutor) })) {
    const m = meta(l);
    switch (l.eventName) {
      case "Accrued":
        out.push({ ...m, kind: "accrued", account: lc(l.args.account), wallet: lc(l.args.wallet), amount: l.args.amount, fromBlock: l.args.fromBlock, toBlock: l.args.toBlock });
        break;
      case "AccountSwept":
        out.push({ ...m, kind: "swept", account: lc(l.args.account), epoch: l.args.epoch, usdg: l.args.usdg });
        break;
      case "AssetSwept": {
        // Nearest preceding Bought for the same token in the same tx.
        const b = bought
          .filter((x) => x.transactionHash === l.transactionHash && lc(x.args.token) === lc(l.args.asset) && (x.logIndex ?? 0) < m.logIndex)
          .sort((x, y) => (y.logIndex ?? 0) - (x.logIndex ?? 0))[0];
        out.push({ ...m, kind: "fill", asset: lc(l.args.asset), usdgIn: l.args.usdgIn, fee: l.args.fee, tokensOut: l.args.tokensOut, oraclePrice1e18: b ? b.args.oraclePrice1e18 : null });
        break;
      }
      case "Delivered":
        out.push({
          ...m, kind: "delivery", account: lc(l.args.account),
          deliveryKind: lc(l.args.token) === lc(usdg) ? "usdg" : "delivered",
          token: lc(l.args.token), asset: lc(l.args.token) === lc(usdg) ? null : lc(l.args.token),
          amount: l.args.amount, reason: null, oracleStatus: null,
        });
        break;
      case "DeliveryHeld":
        out.push({ ...m, kind: "delivery", account: lc(l.args.account), deliveryKind: "held", token: lc(l.args.token), asset: null, amount: l.args.amount, reason: "push refused; claimable", oracleStatus: null });
        break;
      case "Deferred":
        out.push({ ...m, kind: "delivery", account: lc(l.args.account), deliveryKind: "deferred", token: lc(usdg), asset: lc(l.args.asset), amount: l.args.usdg, reason: null, oracleStatus: l.args.status });
        break;
      case "SafeSettled":
        out.push({ ...m, kind: "delivery", account: lc(l.args.account), deliveryKind: "safe_settled", token: lc(usdg), asset: lc(l.args.asset), amount: l.args.usdg, reason: l.args.reason, oracleStatus: null });
        break;
      case "Claimed":
        out.push({ ...m, kind: "delivery", account: lc(l.args.account), deliveryKind: "claimed", token: lc(l.args.token), asset: null, amount: l.args.amount, reason: `to ${lc(l.args.to)}`, oracleStatus: null });
        break;
      default:
        break; // admin events (KeeperSet, ParamsSet, Paused, ...) are not indexed here
    }
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

/**
 * Apply decoded events in order, idempotently. Run it inside the cursor
 * transaction (workers/cursors.ts runCursor) so rows and cursor commit together.
 */
export async function writeEventRows(db: Db, chainId: number, events: readonly SpareEvent[]): Promise<void> {
  for (const e of events) {
    switch (e.kind) {
      case "linked":
        await db
          .insert(schema.links)
          .values({ chainId, account: e.account, wallet: e.wallet, linkedBlock: e.blockNumber, linkedAt: e.blockTime, linkedTx: e.txHash, linkedLogIndex: e.logIndex })
          .onConflictDoNothing();
        break;
      case "unlinked":
        await db
          .update(schema.links)
          .set({ unlinkedBlock: e.blockNumber, unlinkedAt: e.blockTime, unlinkedTx: e.txHash, unlinkedLogIndex: e.logIndex })
          .where(
            and(
              eq(schema.links.chainId, chainId),
              eq(schema.links.account, e.account),
              eq(schema.links.wallet, e.wallet),
              isNull(schema.links.unlinkedBlock),
              lte(schema.links.linkedBlock, e.blockNumber),
            ),
          );
        break;
      case "rule":
        await db
          .insert(schema.rules)
          .values({ chainId, account: e.account, roundTo: e.roundTo, multiplier: e.multiplier, weeklyCap: e.weeklyCap.toString(), enabled: e.enabled, blockNumber: e.blockNumber, blockTime: e.blockTime, txHash: e.txHash, logIndex: e.logIndex })
          .onConflictDoNothing();
        break;
      case "mix":
        await db
          .insert(schema.mixes)
          .values({ chainId, account: e.account, kind: e.mixKind, legs: e.legs, blockNumber: e.blockNumber, blockTime: e.blockTime, txHash: e.txHash, logIndex: e.logIndex })
          .onConflictDoNothing();
        break;
      case "accrued": {
        // Confirm a keeper-planned batch for the same (wallet, toBlock) if there is one…
        const confirmed = await db
          .update(schema.accrualBatches)
          .set({
            status: "confirmed", amount: e.amount.toString(), txHash: e.txHash, logIndex: e.logIndex,
            blockNumber: e.blockNumber, blockTime: e.blockTime, error: null, updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.accrualBatches.chainId, chainId),
              eq(schema.accrualBatches.wallet, e.wallet),
              eq(schema.accrualBatches.toBlock, e.toBlock),
              isNull(schema.accrualBatches.txHash),
            ),
          )
          .returning({ id: schema.accrualBatches.id });
        let batchId = confirmed[0]?.id;
        // …otherwise record what the chain says happened.
        if (!batchId) {
          const ins = await db
            .insert(schema.accrualBatches)
            .values({
              chainId, account: e.account, wallet: e.wallet, fromBlock: e.fromBlock, toBlock: e.toBlock,
              requested: e.amount.toString(), amount: e.amount.toString(), status: "confirmed", source: "chain",
              txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: e.blockTime,
            })
            .onConflictDoNothing({ target: [schema.accrualBatches.txHash, schema.accrualBatches.logIndex], where: sql`tx_hash is not null` })
            .returning({ id: schema.accrualBatches.id });
          batchId = ins[0]?.id;
        }
        // Accrual covers (fromBlock, toBlock]: attach the payments it paid for.
        if (batchId) {
          await db
            .update(schema.payments)
            .set({ batchId })
            .where(
              and(
                eq(schema.payments.chainId, chainId),
                eq(schema.payments.wallet, e.wallet),
                gt(schema.payments.blockNumber, e.fromBlock),
                lte(schema.payments.blockNumber, e.toBlock),
                isNull(schema.payments.batchId),
              ),
            );
        }
        break;
      }
      case "swept":
        await db
          .insert(schema.sweeps)
          .values({ chainId, account: e.account, epoch: e.epoch, usdg: e.usdg.toString(), blockNumber: e.blockNumber, blockTime: e.blockTime, txHash: e.txHash, logIndex: e.logIndex })
          .onConflictDoNothing();
        break;
      case "fill":
        await db
          .insert(schema.sweepFills)
          .values({
            chainId, asset: e.asset, usdgIn: e.usdgIn.toString(), fee: e.fee.toString(), tokensOut: e.tokensOut.toString(),
            oraclePrice1e18: e.oraclePrice1e18?.toString() ?? null, blockNumber: e.blockNumber, blockTime: e.blockTime, txHash: e.txHash, logIndex: e.logIndex,
          })
          .onConflictDoNothing();
        break;
      case "delivery":
        await db
          .insert(schema.deliveries)
          .values({
            chainId, account: e.account, kind: e.deliveryKind, token: e.token, asset: e.asset, amount: e.amount.toString(),
            reason: e.reason, oracleStatus: e.oracleStatus, blockNumber: e.blockNumber, blockTime: e.blockTime, txHash: e.txHash, logIndex: e.logIndex,
          })
          .onConflictDoNothing();
        break;
    }
  }
}
