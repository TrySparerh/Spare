/**
 * sweep.history — past sweeps of an account: what went in, what came out,
 *                 which legs deferred or safe-settled (DB, chain-indexer).
 * sweep.next    — the next epoch and, check by check in the executor's own
 *                 order, why the account would or would not be swept (chain).
 *
 * Sweeps are permissionless (`SweepExecutor.sweep(accounts)`); the keeper's
 * sweeper worker calls it. This router never does.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { erc20Abi, type Address } from "viem";
import { publicProcedure, requireContracts, router } from "../trpc.ts";
import { readAccount, readImmutables } from "../chain/reads.ts";
import { assetRegistryAbi, stockRouterAbi } from "../chain/abis.ts";
import { headBlock } from "../chain/blocks.ts";
import { REQUIRED_CONTRACTS } from "../chain/addresses.ts";
import { USDG } from "../chain/constants.ts";
import { AccountInput, AddressInput, lc } from "../lib/inputs.ts";
import { guard, unavailable } from "../lib/result.ts";
import { amount, toBigInt, usdg } from "../lib/units.ts";
import { legOutcome, oracleStatusName } from "../lib/oracle.ts";
import * as schema from "../db/schema.ts";

export const HistoryInput = z.object({
  account: AddressInput,
  limit: z.number().int().min(1).max(100).default(20),
  /** Only sweeps strictly older than this L2 block (from `nextBefore`). */
  before: z.string().regex(/^\d{1,20}$/).optional(),
});

/** Split `value` across legs exactly as SweepExecutor._collect does (floor; last leg takes the rest). */
export function splitLegs(value: bigint, legs: readonly { bps: number }[]): bigint[] {
  let left = value;
  return legs.map((l, i) => {
    const amt = i === legs.length - 1 ? left : (value * BigInt(l.bps)) / 10_000n;
    left -= amt;
    return amt;
  });
}

export const sweepRouter = router({
  history: publicProcedure.input(HistoryInput).query(({ ctx, input }) =>
    guard("sweep.history", async () => {
      const acct = lc(input.account);
      const sweeps = await ctx.db
        .select()
        .from(schema.sweeps)
        .where(
          and(
            eq(schema.sweeps.chainId, ctx.chainId),
            eq(schema.sweeps.account, acct),
            input.before ? sql`${schema.sweeps.blockNumber} < ${input.before}` : undefined,
          ),
        )
        .orderBy(desc(schema.sweeps.blockNumber), desc(schema.sweeps.logIndex))
        .limit(input.limit + 1);

      const [cursor] = await ctx.db
        .select()
        .from(schema.cursors)
        .where(and(eq(schema.cursors.chainId, ctx.chainId), eq(schema.cursors.name, "chain-indexer")));
      if (!sweeps.length && (!cursor || cursor.lastBlock === null)) {
        return unavailable("not_indexed", "the chain indexer has not indexed SPARE events yet — sweep history is unknown, not empty");
      }

      const page = sweeps.slice(0, input.limit);
      const txs = [...new Set(page.map((s) => s.txHash))];
      const [deliveries, fills] = txs.length
        ? await Promise.all([
            ctx.db
              .select()
              .from(schema.deliveries)
              .where(and(inArray(schema.deliveries.txHash, txs), eq(schema.deliveries.account, acct)))
              .orderBy(schema.deliveries.logIndex),
            ctx.db.select().from(schema.sweepFills).where(inArray(schema.sweepFills.txHash, txs)).orderBy(schema.sweepFills.logIndex),
          ])
        : [[], []];

      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        indexedThrough: cursor?.lastBlock?.toString() ?? null,
        sweeps: page.map((s) => ({
          txHash: s.txHash,
          epoch: s.epoch.toString(),
          blockNumber: s.blockNumber.toString(),
          blockTime: s.blockTime?.toISOString() ?? null,
          usdgIn: usdg(toBigInt(s.usdg)),
          /** Everything this account received or had returned in this tx. */
          outcomes: deliveries
            .filter((d) => d.txHash === s.txHash)
            .map((d) => ({
              kind: d.kind,
              token: d.token as Address,
              asset: (d.asset as Address | null) ?? null,
              // `token` is what moved: USDG (6 dp) for usdg/deferred/safe-settled rows, else the stock (18 dp).
              amount: amount(toBigInt(d.amount), d.token.toLowerCase() === USDG.toLowerCase() ? 6 : 18),
              reason: d.reason,
              oracleStatus: d.oracleStatus === null ? null : oracleStatusName(d.oracleStatus),
            })),
          /** Netted fills of the whole batch (shared by every account in the tx). */
          fills: fills
            .filter((f) => f.txHash === s.txHash)
            .map((f) => ({
              asset: f.asset as Address,
              usdgIn: usdg(toBigInt(f.usdgIn)),
              fee: usdg(toBigInt(f.fee)),
              tokensOut: amount(toBigInt(f.tokensOut), 18),
              oraclePrice: f.oraclePrice1e18 === null ? null : amount(toBigInt(f.oraclePrice1e18), 18),
            })),
        })),
        nextBefore: sweeps.length > input.limit ? page[page.length - 1]!.blockNumber.toString() : null,
      };
    }),
  ),

  next: publicProcedure.input(AccountInput).query(({ ctx, input }) =>
    guard("sweep.next", async () => {
      const a = await requireContracts(ctx, REQUIRED_CONTRACTS);
      const [head, s, imm] = await Promise.all([
        headBlock(ctx.client),
        readAccount(ctx.client, a, input.account),
        readImmutables(ctx.client, a),
      ]);

      // Per-leg outcome at current oracle state (one multicall).
      const legReads = s.mix.length
        ? ((await ctx.client.multicall({
            allowFailure: true,
            contracts: s.mix.flatMap((l) => [
              { address: a.assetRegistry, abi: assetRegistryAbi, functionName: "isEligible", args: [l.asset] },
              { address: a.stockRouter, abi: stockRouterAbi, functionName: "oracleStatus", args: [l.asset] },
              { address: l.asset, abi: erc20Abi, functionName: "symbol" },
            ]) as never,
          })) as { status: string; result?: unknown }[])
        : [];
      const split = splitLegs(s.value, s.mix);
      const legs = s.mix.map((l, i) => {
        const active = legReads[i * 3]?.status === "success" ? (legReads[i * 3]!.result as boolean) : false;
        const os = legReads[i * 3 + 1]?.status === "success" ? (legReads[i * 3 + 1]!.result as readonly [number, bigint]) : null;
        // An unreadable oracle is what OracleGuard calls BAD_ANSWER.
        const status = os ? Number(os[0]) : 4;
        return {
          asset: l.asset,
          symbol: legReads[i * 3 + 2]?.status === "success" ? (legReads[i * 3 + 2]!.result as string) : null,
          bps: l.bps,
          /** This leg's share of the account's CURRENT value — a projection, not a quote. */
          projectedUsdg: usdg(split[i] ?? 0n),
          active,
          oracleStatus: oracleStatusName(status),
          outcome: legOutcome(status, active),
        };
      });

      const epochStart = (s.timestamp / s.epochLength) * s.epochLength;
      const nextEpochAt = epochStart + s.epochLength;
      const sweptThisEpoch = s.sweptEpoch === s.currentEpoch;

      // Checks in SweepExecutor.sweep / _collect order.
      const checks = [
        { code: "executor_paused", pass: !s.paused, detail: "SweepExecutor is paused — no sweeps until the owner unpauses" },
        {
          code: "already_swept_this_epoch",
          pass: !sweptThisEpoch,
          detail: `swept in epoch ${s.currentEpoch}; next epoch starts ${new Date(Number(nextEpochAt) * 1000).toISOString()}`,
        },
        {
          code: "below_threshold",
          pass: s.value >= s.threshold,
          detail: `value ${usdg(s.value).display} of ${usdg(s.threshold).display} USDG threshold`,
        },
        { code: "not_cleared", pass: s.screening.eligible, detail: "ScreeningGate has no current clearance for this account" },
        { code: "no_mix", pass: s.mix.length > 0, detail: "no own mix and no default mix" },
      ];
      const failing = checks.filter((c) => !c.pass);
      const unitsAtRisk = s.units > 0n && s.parkFresh === false;

      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        asOf: { head: head.toString(), timestamp: s.timestamp.toString() },
        epoch: {
          current: s.currentEpoch.toString(),
          lengthSeconds: s.epochLength.toString(),
          startedAt: new Date(Number(epochStart) * 1000).toISOString(),
          nextStartsAt: new Date(Number(nextEpochAt) * 1000).toISOString(),
          sweptThisEpoch,
          lastSweptEpoch: s.sweptEpoch === 0n ? null : s.sweptEpoch.toString(),
        },
        eligibleNow: failing.length === 0,
        /** The first check the executor would fail on, if any. */
        blockedBy: failing[0]?.code ?? null,
        checks: checks.map((c) => ({ code: c.code, pass: c.pass, detail: c.pass ? null : c.detail })),
        value: usdg(s.value),
        threshold: usdg(s.threshold),
        feeBps: s.feeBps,
        legs,
        notes: [
          ...(unitsAtRisk
            ? ["The park adapter is not fresh: parked units stay parked this epoch and only pending USDG is swept (the executor re-parks it if that is under the threshold)."]
            : []),
          ...(legs.some((l) => l.outcome === "defer")
            ? ["A deferred leg's USDG goes back to the park and is retried next epoch — it is never paid out as USDG."]
            : []),
          ...(legs.some((l) => l.outcome === "safe-settle")
            ? ["A safe-settled leg is delivered to the account as USDG with a SafeSettled notice."]
            : []),
        ],
        usdg: imm.usdg,
        keeper: { sweeperNextRunAt: (await ctx.schedulerNextRun("sweeper"))?.toISOString() ?? null },
      };
    }),
  ),
});
