/**
 * rule.preview — what a round-up rule WOULD have accrued over an account's real
 * USDG payments in the last N days.
 *
 * It is a PREVIEW OF THE RULE, not an accrual: nothing is pulled, parked or
 * promised. Every input is real: the transfers are the wallet's actual USDG
 * Transfer logs (from the payments table when the observer has indexed the
 * whole window, otherwise straight from eth_getLogs), the window is bounded by
 * real block timestamps, and the math is lib/roundup.ts (== RoundUp.sol).
 *
 * The preview is public, so its RPC work is bounded per request: one
 * LogBudget caps getLogs calls (result-cap splits and rate-limit retries
 * included), the transfers held (RPC logs and DB rows) and wall-clock time.
 * A window that cannot fit is refused before the first getLogs call.
 *
 * Weekly cap: simulated as the executor enforces it, a ROLLING 7 days (the
 * payment's UTC day + the 6 before it, SweepExecutor._pulled7d), bucketed by
 * the UTC day OF THE PAYMENT. The executor buckets by the day of the ACCRUAL
 * transaction, which trails a payment by at least the finality buffer
 * (~5 min) — the response says so.
 */
import { and, between, eq, inArray } from "drizzle-orm";
import type { Address, PublicClient } from "viem";
import { blockAtOrAfter, blockTime, blockTimes, finalBlock } from "./blocks.ts";
import { chunkRange, LogBudget, transfersFrom, type TransferLog } from "./logs.ts";
import { coverage, paymentsCursorName } from "../workers/cursors.ts";
import { makeClassifier, type ExclusionReason } from "../lib/payments.ts";
import { DAY_SECONDS, applyRollingWeeklyCap, roundUpDelta } from "../lib/roundup.ts";
import { usdg, type Amount } from "../lib/units.ts";
import type { Db } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export const PREVIEW_LABEL =
  "Preview of your round-up rule over your real USDG payments. Nothing was accrued, pulled or moved.";
export const PREVIEW_PAYMENT_LIMIT = 200;

export interface PreviewRule {
  roundTo: number;
  multiplier: number;
  /** null = do not simulate a cap. */
  weeklyCap: bigint | null;
  enabled: boolean;
  source: "chain" | "input";
}

export interface PreviewInput {
  client: PublicClient;
  db: Db;
  chainId: number;
  account: Address;
  wallets: Address[];
  walletsNote: string | null;
  usdgToken: Address;
  spareContracts: string[];
  venue: string[];
  rule: PreviewRule;
  days: number;
  finalityBuffer: bigint;
  maxRange: bigint;
  /** Most eth_getLogs calls the WHOLE preview may make: every wallet, split and retry. */
  maxChunks: number;
  /** Most transfers the whole preview may hold: RPC logs and database rows together. */
  maxLogs: number;
  /** Wall-clock allowance (ms): no log call starts, and no backoff is slept, past it. */
  timeoutMs: number;
}

interface Row extends TransferLog {
  wallet: Address;
  excludedReason: ExclusionReason | null;
  delta: bigint;
  day: bigint;
}

type Source = { wallet: Address; source: "db" | "rpc"; payments: number };

async function dbCoverage(db: Db, chainId: number, wallets: Address[]) {
  const names = wallets.map(paymentsCursorName);
  const rows = await db
    .select()
    .from(schema.cursors)
    .where(and(eq(schema.cursors.chainId, chainId), inArray(schema.cursors.name, names)));
  return new Map(rows.map((r) => [r.name, coverage(r)]));
}

export async function runPreview(p: PreviewInput) {
  // One allowance for the whole request, however many wallets it scans.
  const budget = new LogBudget({ maxCalls: p.maxChunks, maxLogs: p.maxLogs, deadline: Date.now() + p.timeoutMs });
  const head = await p.client.getBlockNumber({ cacheTime: 0 });
  const headTs = await blockTime(p.client, head);
  const fromTs = headTs - BigInt(p.days) * 86_400n;
  const fromBlock = await blockAtOrAfter(p.client, fromTs, { number: head, timestamp: headTs });
  const safe = finalBlock(head, p.finalityBuffer);

  // DB coverage is optional: a DB outage only means every wallet uses the RPC.
  const cov = await dbCoverage(p.db, p.chainId, p.wallets).catch(() => new Map<string, { from: bigint; to: bigint } | null>());

  const classifier = makeClassifier({
    account: p.account,
    linkedWallets: p.wallets,
    spareContracts: p.spareContracts,
    venue: p.venue,
  });

  // Use the DB only when it covers the WHOLE window up to the final head.
  // Sources are settled first so a window the RPC budget cannot cover is
  // refused before a single getLogs call.
  const plan = p.wallets.map((wallet) => {
    const c = cov.get(paymentsCursorName(wallet));
    return { wallet, covered: c && c.from <= fromBlock && c.to >= safe ? c : null };
  });
  const rpcWallets = plan.filter((w) => w.covered === null).length;
  budget.require(
    rpcWallets * chunkRange(fromBlock, head, p.maxRange).length,
    `the ${p.days}-day window over ${rpcWallets} unindexed wallet${rpcWallets === 1 ? "" : "s"}`,
  );

  const sources: Source[] = [];
  const transfers: (TransferLog & { wallet: Address })[] = [];
  let toBlock = head;
  for (const { wallet, covered: c } of plan) {
    if (c) {
      // One row past what the budget may hold is enough to know it is too many.
      const rows = await p.db
        .select()
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.chainId, p.chainId),
            eq(schema.payments.wallet, wallet.toLowerCase()),
            between(schema.payments.blockNumber, fromBlock, c.to),
          ),
        )
        .limit(budget.logsLeft + 1);
      budget.hold(rows.length);
      for (const r of rows) {
        transfers.push({
          wallet,
          from: wallet,
          to: r.counterparty as Address,
          amount: BigInt(r.amount),
          blockNumber: r.blockNumber,
          txHash: r.txHash as `0x${string}`,
          logIndex: r.logIndex,
        });
      }
      if (c.to < toBlock) toBlock = c.to;
      sources.push({ wallet, source: "db", payments: rows.length });
    } else {
      const logs = await transfersFrom(p.client, {
        token: p.usdgToken,
        wallet,
        fromBlock,
        toBlock: head,
        maxRange: p.maxRange,
        maxChunks: p.maxChunks,
        finalBlock: safe,
        budget,
      });
      for (const l of logs) transfers.push({ ...l, wallet });
      sources.push({ wallet, source: "rpc", payments: logs.length });
    }
  }
  // A single consistent window: drop anything past the tightest source.
  const inWindow = transfers.filter((t) => t.blockNumber >= fromBlock && t.blockNumber <= toBlock);
  const toTs = toBlock === head ? headTs : await blockTime(p.client, toBlock);

  // UTC-day boundaries inside the window -> first block of each day (the
  // executor's cap buckets; at most MAX_PREVIEW_DAYS + 1 lookups).
  const boundaries: { day: bigint; block: bigint }[] = [];
  for (let d = fromTs / DAY_SECONDS + 1n; d * DAY_SECONDS <= toTs; d++) {
    boundaries.push({ day: d, block: await blockAtOrAfter(p.client, d * DAY_SECONDS, { number: head, timestamp: headTs }) });
  }
  const dayOf = (n: bigint) => {
    let d = fromTs / DAY_SECONDS;
    for (const b of boundaries) if (n >= b.block) d = b.day;
    return d;
  };

  const rows: Row[] = inWindow.map((t) => {
    const excludedReason = classifier.classify(t.to);
    const delta = excludedReason ? 0n : roundUpDelta(t.amount, p.rule.roundTo, p.rule.multiplier);
    return { ...t, excludedReason, delta, day: dayOf(t.blockNumber) };
  });
  rows.sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1));

  const eligible = rows.filter((r) => r.excludedReason === null);
  const byReason: Partial<Record<ExclusionReason, number>> = {};
  for (const r of rows) if (r.excludedReason) byReason[r.excludedReason] = (byReason[r.excludedReason] ?? 0) + 1;
  const gross = eligible.reduce((s, r) => s + r.delta, 0n);
  const spend = eligible.reduce((s, r) => s + r.amount, 0n);
  const capped =
    p.rule.weeklyCap === null ? null : applyRollingWeeklyCap(eligible.map((r) => ({ day: r.day, delta: r.delta })), p.rule.weeklyCap);

  const shown = rows.slice(0, PREVIEW_PAYMENT_LIMIT);
  const times = await blockTimes(p.client, shown.map((r) => r.blockNumber));

  const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();
  return {
    available: true as const,
    kind: "rule-preview" as const,
    label: PREVIEW_LABEL,
    chainId: p.chainId,
    account: p.account,
    rule: {
      roundTo: p.rule.roundTo,
      multiplier: p.rule.multiplier,
      weeklyCap: p.rule.weeklyCap === null ? null : usdg(p.rule.weeklyCap),
      enabled: p.rule.enabled,
      source: p.rule.source,
    },
    notes: [
      ...(p.walletsNote ? [p.walletsNote] : []),
      ...(p.rule.enabled ? [] : ["This rule is disabled on-chain: no accrual would actually happen until it is enabled."]),
      "Only outgoing USDG transfers count; transfers to your own linked wallets, your account, SPARE contracts and the swap venue are excluded.",
      ...(capped
        ? [
            "Weekly cap applied as the executor enforces it: a rolling 7 days (the payment's UTC day + the 6 before it), not a calendar week. The executor counts the day of the accrual transaction, which trails a payment by ~5 minutes or more. Amounts already pulled before this window are not included.",
          ]
        : []),
    ],
    window: {
      days: p.days,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      fromTime: iso(fromTs),
      toTime: iso(toTs),
    },
    sources,
    totals: {
      payments: rows.length,
      eligible: eligible.length,
      excluded: rows.length - eligible.length,
      excludedByReason: byReason,
      eligibleSpend: usdg(spend),
      roundUps: usdg(gross),
      afterWeeklyCap: capped ? usdg(capped.accepted) : null,
      droppedByWeeklyCap: capped ? usdg(capped.dropped) : null,
    },
    /** Per UTC day (the executor's cap bucket); each day's room is cap − the 6 prior days − itself. */
    days: (capped?.days ?? []).map((d) => ({
      day: d.day.toString(),
      startsAt: iso(d.day * DAY_SECONDS),
      requested: usdg(d.requested),
      accepted: usdg(d.accepted),
    })),
    payments: shown.map((r) => ({
      txHash: r.txHash,
      logIndex: r.logIndex,
      wallet: r.wallet,
      to: r.to,
      blockNumber: r.blockNumber.toString(),
      time: times.has(r.blockNumber) ? iso(times.get(r.blockNumber)!) : null,
      amount: usdg(r.amount),
      delta: usdg(r.delta) as Amount,
      excludedReason: r.excludedReason,
    })),
    truncated: rows.length > shown.length,
  };
}
