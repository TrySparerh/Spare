/**
 * accrual.state  — where an account's spare change stands right now (chain),
 *                  plus what the observer has seen but not yet accrued (DB).
 * accrual.ledger — the individual payments behind it, with each round-up and
 *                  each exclusion reason (DB, written by the roundup-observer).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Address } from "viem";
import { publicProcedure, requireContracts, router, type Context } from "../trpc.ts";
import { readAccount, readPark, readWallets } from "../chain/reads.ts";
import { finalBlock, headBlock } from "../chain/blocks.ts";
import { REQUIRED_CONTRACTS } from "../chain/addresses.ts";
import { coverage, paymentsCursorName } from "../workers/cursors.ts";
import { AccountInput, AddressInput, PageCursor, encodeCursor, lc } from "../lib/inputs.ts";
import { guard, unavailable } from "../lib/result.ts";
import { amount, progressBps, toBigInt, usdg } from "../lib/units.ts";
import { WEEK_SECONDS } from "../lib/roundup.ts";
import { permit2View } from "./link.ts";
import * as schema from "../db/schema.ts";

/** Payment-observer coverage for wallets, keyed by lower-cased wallet. */
async function walletCoverage(ctx: Context, wallets: readonly string[]) {
  if (!wallets.length) return new Map<string, { from: bigint; to: bigint } | null>();
  const rows = await ctx.db
    .select()
    .from(schema.cursors)
    .where(and(eq(schema.cursors.chainId, ctx.chainId), inArray(schema.cursors.name, wallets.map(paymentsCursorName))));
  const byName = new Map(rows.map((r) => [r.name, coverage(r)]));
  return new Map(wallets.map((w) => [w.toLowerCase(), byName.get(paymentsCursorName(w)) ?? null]));
}

export const LedgerInput = z.object({
  account: AddressInput,
  limit: z.number().int().min(1).max(200).default(50),
  /** `nextCursor` from the previous page. */
  cursor: PageCursor.optional(),
});

export const accrualRouter = router({
  state: publicProcedure.input(AccountInput).query(({ ctx, input }) =>
    guard("accrual.state", async () => {
      const a = await requireContracts(ctx, REQUIRED_CONTRACTS);
      const [head, s, park] = await Promise.all([
        headBlock(ctx.client),
        readAccount(ctx.client, a, input.account),
        readPark(ctx.client, a),
      ]);
      const wallets = await readWallets(ctx.client, a, s.wallets);
      const accruableThrough = finalBlock(head, ctx.finalityBuffer);
      const currentWeek = s.timestamp / WEEK_SECONDS;
      const pulledThisWeek = s.pulledLast7Days;

      // --- DB: observed-but-not-yet-accrued round-ups ------------------------
      const observed = await guard("accrual.state.observed", async () => {
        if (!wallets.length) return unavailable("not_indexed", "no wallets are linked to this account");
        const cov = await walletCoverage(ctx, wallets.map((w) => w.wallet));
        const per = await Promise.all(
          wallets.map(async (w) => {
            const c = cov.get(w.wallet.toLowerCase()) ?? null;
            if (!c) return { wallet: w.wallet, indexed: false as const, coverage: null, unaccrued: null, payments: 0 };
            const [agg] = await ctx.db
              .select({
                delta: sql<string>`coalesce(sum(${schema.payments.delta}), 0)::text`,
                n: sql<number>`count(*)::int`,
              })
              .from(schema.payments)
              .where(
                and(
                  eq(schema.payments.chainId, ctx.chainId),
                  eq(schema.payments.wallet, w.wallet.toLowerCase()),
                  sql`${schema.payments.blockNumber} > ${w.accrualCursor}`,
                  sql`${schema.payments.excludedReason} is null`,
                ),
              );
            return {
              wallet: w.wallet,
              indexed: true as const,
              coverage: { fromBlock: c.from.toString(), toBlock: c.to.toString() },
              unaccrued: usdg(toBigInt(agg?.delta)),
              payments: agg?.n ?? 0,
            };
          }),
        );
        const indexed = per.filter((p) => p.indexed);
        if (!indexed.length) {
          return unavailable("not_indexed", "the payment observer has not indexed this account's wallets yet");
        }
        return {
          available: true as const,
          complete: indexed.length === per.length,
          wallets: per,
          totalUnaccrued: usdg(indexed.reduce((t, p) => t + BigInt(p.unaccrued!.raw), 0n)),
        };
      });

      const batches = await guard("accrual.state.batches", async () => {
        const rows = await ctx.db
          .select()
          .from(schema.accrualBatches)
          .where(and(eq(schema.accrualBatches.chainId, ctx.chainId), eq(schema.accrualBatches.account, lc(input.account))))
          .orderBy(desc(schema.accrualBatches.createdAt))
          .limit(10);
        return {
          available: true as const,
          rows: rows.map((b) => ({
            id: b.id,
            wallet: b.wallet as Address,
            fromBlock: b.fromBlock.toString(),
            toBlock: b.toBlock.toString(),
            requested: usdg(BigInt(b.requested)),
            amount: usdg(BigInt(b.amount)),
            cappedBy: b.cappedBy,
            payments: b.paymentCount,
            status: b.status,
            source: b.source,
            txHash: b.txHash,
            blockTime: b.blockTime?.toISOString() ?? null,
          })),
        };
      });

      const remainingToThreshold = s.value >= s.threshold ? 0n : s.threshold - s.value;
      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        asOf: { head: head.toString(), timestamp: s.timestamp.toString() },
        /** CashPark: accrued USDG not yet parked. */
        pending: usdg(s.pending),
        /** CashPark: parked units in the adapter (underlying's own decimals). */
        units: {
          ...amount(s.units, park.underlyingDecimals ?? 0),
          underlying: park.underlying,
          symbol: park.underlyingSymbol,
          decimalsKnown: park.underlyingDecimals !== null,
        },
        /** CashPark.valueOf: pending + units at the adapter's NAV, in USDG. */
        value: usdg(s.value),
        parkFresh: s.parkFresh,
        claimableUsdg: usdg(s.claimableUsdg),
        threshold: usdg(s.threshold),
        progressBps: progressBps(s.value, s.threshold),
        remainingToThreshold: usdg(remainingToThreshold),
        rule: s.rule.set
          ? { roundTo: s.rule.roundTo, multiplier: s.rule.multiplier, weeklyCap: usdg(s.rule.weeklyCap), enabled: s.rule.enabled }
          : null,
        weekly: {
          week: currentWeek.toString(),
          weekEndsAt: new Date(Number((currentWeek + 1n) * WEEK_SECONDS) * 1000).toISOString(),
          /** SweepExecutor.pulledLast7Days — the cap is a ROLLING 7-day window. */
          weekPulled: usdg(pulledThisWeek),
          window: "rolling-7d",
          remainingWeeklyCap: usdg(s.remainingWeeklyCap),
        },
        finality: {
          head: head.toString(),
          finalityBuffer: s.finalityBuffer.toString(),
          engineFinalityBuffer: ctx.finalityBuffer.toString(),
          accruableThrough: accruableThrough.toString(),
        },
        wallets: wallets.map((w) => ({
          wallet: w.wallet,
          linkedAtBlock: w.linkedAt.toString(),
          lastAccruedBlock: w.lastAccruedBlock.toString(),
          accrualCursor: w.accrualCursor.toString(),
          /** Final blocks not yet covered by an accrual. */
          lagBlocks: (accruableThrough > w.accrualCursor ? accruableThrough - w.accrualCursor : 0n).toString(),
          usdgBalance: usdg(w.usdgBalance),
          permit2: permit2View(w.permit2, s.timestamp),
        })),
        paused: { executor: s.paused, park: s.parkPaused },
        observed,
        batches,
      };
    }),
  ),

  ledger: publicProcedure.input(LedgerInput).query(({ ctx, input }) =>
    guard("accrual.ledger", async () => {
      const acct = lc(input.account);
      const base = and(eq(schema.payments.chainId, ctx.chainId), eq(schema.payments.account, acct));
      const where = input.cursor
        ? and(base, sql`(${schema.payments.blockNumber}, ${schema.payments.logIndex}) < (${input.cursor.block}, ${input.cursor.logIndex})`)
        : base;
      const rows = await ctx.db
        .select({
          p: schema.payments,
          batchStatus: schema.accrualBatches.status,
          batchTx: schema.accrualBatches.txHash,
        })
        .from(schema.payments)
        .leftJoin(schema.accrualBatches, eq(schema.accrualBatches.id, schema.payments.batchId))
        .where(where)
        .orderBy(desc(schema.payments.blockNumber), desc(schema.payments.logIndex))
        .limit(input.limit + 1);

      // Which wallets has the observer covered for this account?
      const linked = await ctx.db
        .selectDistinct({ wallet: schema.links.wallet })
        .from(schema.links)
        .where(and(eq(schema.links.chainId, ctx.chainId), eq(schema.links.account, acct)));
      const seen = await ctx.db
        .selectDistinct({ wallet: schema.payments.wallet })
        .from(schema.payments)
        .where(base);
      const wallets = [...new Set([...linked.map((r) => r.wallet), ...seen.map((r) => r.wallet)])];
      const cov = await walletCoverage(ctx, wallets);
      const covered = [...cov.entries()].filter(([, c]) => c !== null);
      if (!covered.length && rows.length === 0) {
        return unavailable(
          "not_indexed",
          "the payment observer has not indexed any wallet of this account yet — an empty ledger here would be a guess, not a fact",
        );
      }

      const [totals] = await ctx.db
        .select({
          payments: sql<number>`count(*)::int`,
          eligible: sql<number>`count(*) filter (where ${schema.payments.excludedReason} is null)::int`,
          roundUps: sql<string>`coalesce(sum(${schema.payments.delta}), 0)::text`,
          accrued: sql<string>`coalesce(sum(${schema.payments.delta}) filter (where ${schema.payments.batchId} is not null), 0)::text`,
        })
        .from(schema.payments)
        .where(base);
      const reasons = await ctx.db
        .select({ reason: schema.payments.excludedReason, n: sql<number>`count(*)::int` })
        .from(schema.payments)
        .where(and(base, sql`${schema.payments.excludedReason} is not null`))
        .groupBy(schema.payments.excludedReason);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        coverage: [...cov.entries()].map(([wallet, c]) => ({
          wallet: wallet as Address,
          fromBlock: c?.from.toString() ?? null,
          toBlock: c?.to.toString() ?? null,
          indexed: c !== null,
        })),
        totals: {
          payments: totals?.payments ?? 0,
          eligible: totals?.eligible ?? 0,
          roundUps: usdg(toBigInt(totals?.roundUps)),
          accrued: usdg(toBigInt(totals?.accrued)),
          notYetAccrued: usdg(toBigInt(totals?.roundUps) - toBigInt(totals?.accrued)),
          excludedByReason: Object.fromEntries(reasons.map((r) => [r.reason!, r.n])),
        },
        rows: page.map(({ p, batchStatus, batchTx }) => ({
          txHash: p.txHash,
          logIndex: p.logIndex,
          wallet: p.wallet as Address,
          counterparty: p.counterparty as Address,
          blockNumber: p.blockNumber.toString(),
          blockTime: p.blockTime.toISOString(),
          amount: usdg(toBigInt(p.amount)),
          delta: usdg(toBigInt(p.delta)),
          roundTo: p.roundTo,
          multiplier: p.multiplier,
          excludedReason: p.excludedReason,
          batch: p.batchId ? { id: p.batchId, status: batchStatus, txHash: batchTx } : null,
        })),
        nextCursor: rows.length > input.limit && last ? encodeCursor(last.p.blockNumber, last.p.logIndex) : null,
      };
    }),
  ),
});
