/**
 * rule.get / rule.preview.
 *
 * The rule lives on-chain (RuleRegistry.setRule, sent from the user's own
 * wallet) because that is what makes a keeper's accrual auditable. This router
 * reads it and previews it; it never sets it.
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Address } from "viem";
import { publicProcedure, requireChain, requireContracts, router, type Context } from "../trpc.ts";
import { readAccount, readImmutables, readLinkSet } from "../chain/reads.ts";
import { headBlock } from "../chain/blocks.ts";
import { runPreview, type PreviewRule } from "../chain/preview.ts";
import { LogRangeError } from "../chain/logs.ts";
import { USDG, VENUE } from "../chain/constants.ts";
import { REQUIRED_CONTRACTS, OPTIONAL_CONTRACTS } from "../chain/addresses.ts";
import { AddressInput, AccountInput, lc } from "../lib/inputs.ts";
import { guard, unavailable, UnavailableError } from "../lib/result.ts";
import { usdg } from "../lib/units.ts";
import { WEEK_SECONDS, ROUND_TO_VALUES } from "../lib/roundup.ts";
import * as schema from "../db/schema.ts";

export const MAX_PREVIEW_DAYS = 30;

const RuleOverride = z.object({
  roundTo: z.union([z.literal(1), z.literal(5), z.literal(10)]),
  multiplier: z.number().int().min(1).max(5),
  /** USDG base units as a decimal string; omit to preview without a cap. */
  weeklyCap: z.string().regex(/^\d{1,30}$/).optional(),
});

export const PreviewInput = z.object({
  account: AddressInput,
  days: z.number().int().min(1).max(MAX_PREVIEW_DAYS).default(7),
  /** A what-if rule. Omit to preview the account's on-chain rule. */
  rule: RuleOverride.optional(),
});

export const ruleRouter = router({
  get: publicProcedure.input(AccountInput).query(({ ctx, input }) =>
    guard("rule.get", async () => {
      const a = await requireContracts(ctx, REQUIRED_CONTRACTS);
      const [head, s] = await Promise.all([headBlock(ctx.client), readAccount(ctx.client, a, input.account)]);
      const currentWeek = s.timestamp / WEEK_SECONDS;
      const pulledThisWeek = s.pulledLast7Days;

      const history = await guard("rule.get.history", async () => {
        const rows = await ctx.db
          .select()
          .from(schema.rules)
          .where(eq(schema.rules.account, lc(input.account)))
          .orderBy(desc(schema.rules.blockNumber), desc(schema.rules.logIndex))
          .limit(50);
        return {
          available: true as const,
          rows: rows.map((r) => ({
            roundTo: r.roundTo,
            multiplier: r.multiplier,
            weeklyCap: usdg(BigInt(r.weeklyCap)),
            enabled: r.enabled,
            blockNumber: r.blockNumber.toString(),
            blockTime: r.blockTime?.toISOString() ?? null,
            txHash: r.txHash,
          })),
        };
      });

      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        asOf: { head: head.toString(), timestamp: s.timestamp.toString() },
        /** false = the account never called RuleRegistry.setRule. */
        set: s.rule.set,
        rule: s.rule.set
          ? {
              roundTo: s.rule.roundTo,
              multiplier: s.rule.multiplier,
              weeklyCap: usdg(s.rule.weeklyCap),
              enabled: s.rule.enabled,
            }
          : null,
        /** Accrual is live only when set, enabled and the cap is non-zero. */
        accruing: s.rule.set && s.rule.enabled && s.rule.weeklyCap > 0n,
        weeklyCap: {
          week: currentWeek.toString(),
          weekStartsAt: new Date(Number(currentWeek * WEEK_SECONDS) * 1000).toISOString(),
          weekEndsAt: new Date(Number((currentWeek + 1n) * WEEK_SECONDS) * 1000).toISOString(),
          pulled: usdg(pulledThisWeek),
          remaining: usdg(s.remainingWeeklyCap),
        },
        allowed: { roundTo: [...ROUND_TO_VALUES], multiplier: [1, 2, 3, 4, 5] },
        history,
      };
    }),
  ),

  preview: publicProcedure.input(PreviewInput).query(({ ctx, input }) =>
    guard("rule.preview", inPreviewGate(ctx, async () => {
      await requireChain(ctx);
      const book = ctx.book();
      let rule: PreviewRule;
      let wallets: Address[];
      let walletsNote: string | null = null;
      let usdgToken: Address = USDG;
      let spareContracts: string[] = [];

      if (book.deployed) {
        const a = await requireContracts(ctx, REQUIRED_CONTRACTS);
        const [set, imm] = await Promise.all([readLinkSet(ctx.client, a, input.account), readImmutables(ctx.client, a)]);
        usdgToken = imm.usdg;
        spareContracts = [...REQUIRED_CONTRACTS, ...OPTIONAL_CONTRACTS]
          .map((k) => a[k])
          .filter((x): x is Address => Boolean(x));
        wallets = set.wallets.length ? set.wallets : [input.account];
        if (!set.wallets.length) walletsNote = "No wallets are linked to this account yet — previewing the account address's own payments.";
        if (input.rule) {
          rule = {
            roundTo: input.rule.roundTo,
            multiplier: input.rule.multiplier,
            weeklyCap: input.rule.weeklyCap === undefined ? null : BigInt(input.rule.weeklyCap),
            enabled: true,
            source: "input",
          };
        } else if (set.rule.set) {
          rule = { ...set.rule, source: "chain" };
        } else {
          return unavailable(
            "not_indexed",
            "this account has no rule on-chain yet — pass `rule` ({ roundTo, multiplier }) to preview a what-if rule",
          );
        }
      } else {
        // Pre-deploy: the payments are still real; only the rule must come from the caller.
        if (!input.rule) {
          throw new UnavailableError("not_deployed", `${book.reason} — pass \`rule\` to preview a what-if rule over real payments`);
        }
        rule = {
          roundTo: input.rule.roundTo,
          multiplier: input.rule.multiplier,
          weeklyCap: input.rule.weeklyCap === undefined ? null : BigInt(input.rule.weeklyCap),
          enabled: true,
          source: "input",
        };
        wallets = [input.account];
        walletsNote = "SPARE is not deployed on this chain yet — previewing the address's own payments.";
      }

      try {
        return await runPreview({
          client: ctx.client,
          db: ctx.db,
          chainId: ctx.chainId,
          account: input.account,
          wallets,
          walletsNote,
          usdgToken,
          spareContracts,
          venue: Object.values(VENUE),
          rule,
          days: input.days,
          finalityBuffer: ctx.finalityBuffer,
          maxRange: ctx.logsMaxRange,
          maxChunks: ctx.previewMaxChunks,
          maxLogs: ctx.previewMaxLogs,
          timeoutMs: ctx.previewTimeoutMs,
        });
      } catch (err) {
        // LogBudgetError (calls, logs, window or deadline) is a LogRangeError.
        if (err instanceof LogRangeError) {
          return unavailable("too_large", `${err.message} — use fewer days, or wait for the payment observer to index these wallets`);
        }
        throw err;
      }
    })),
  ),
});

/**
 * rule.preview is the only public route whose RPC work and memory scale with
 * its input, so it runs inside two gates, both refused (not queued) before
 * any RPC read: the caller's own (PREVIEW_MAX_INFLIGHT_PER_CLIENT, keyed like
 * the rate limiter), so one client running slow previews cannot keep every
 * other caller at "busy", and the engine-wide one.
 */
function inPreviewGate<T>(ctx: Context, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const mine = ctx.previewClientGate.tryEnter(ctx.clientKey);
    if (!mine) {
      throw new UnavailableError("busy", "a rule preview from your address is already running — wait for it to finish");
    }
    const release = ctx.previewGate.tryEnter();
    if (!release) {
      mine();
      throw new UnavailableError("busy", `${ctx.previewGate.size} rule previews are already running — try again in a few seconds`);
    }
    try {
      return await fn();
    } finally {
      release();
      mine();
    }
  };
}
