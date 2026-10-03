/**
 * link.list — the wallets that feed an account.
 *
 * Linking and unlinking are the USER's own transactions on RuleRegistry
 * (linkSelf / linkWallet with the wallet's EIP-712 signature / unlink); this
 * router only reads. The chain is authoritative for the current set; the DB
 * `links` table (chain-indexer) adds the history of past link episodes.
 */
import { desc, eq } from "drizzle-orm";
import type { Address } from "viem";
import { publicProcedure, requireContracts, router } from "../trpc.ts";
import { readLinkSet, readWallets } from "../chain/reads.ts";
import { finalBlock, headBlock } from "../chain/blocks.ts";
import { AccountInput, lc } from "../lib/inputs.ts";
import { guard } from "../lib/result.ts";
import { usdg } from "../lib/units.ts";
import * as schema from "../db/schema.ts";

/**
 * Permit2 AllowanceTransfer semantics: `transferFrom` reverts once
 * block.timestamp > expiration. A zero record means no allowance was ever set.
 */
export function permit2View(p: { amount: bigint; expiration: number; nonce: number }, nowSeconds: bigint) {
  const never = p.amount === 0n && p.expiration === 0;
  const expired = !never && nowSeconds > BigInt(p.expiration);
  return {
    status: never ? ("none" as const) : expired ? ("expired" as const) : ("active" as const),
    amount: usdg(p.amount),
    expiration: p.expiration,
    expiresAt: p.expiration ? new Date(p.expiration * 1000).toISOString() : null,
    nonce: p.nonce,
    /** What the executor may still pull through Permit2 right now. */
    usable: usdg(never || expired ? 0n : p.amount),
  };
}

export const linkRouter = router({
  list: publicProcedure.input(AccountInput).query(({ ctx, input }) =>
    guard("link.list", async () => {
      const a = await requireContracts(ctx, ["ruleRegistry", "sweepExecutor", "stockRouter", "cashPark"]);
      const [head, set] = await Promise.all([headBlock(ctx.client), readLinkSet(ctx.client, a, input.account)]);
      const wallets = await readWallets(ctx.client, a, set.wallets);
      const accruableThrough = finalBlock(head, ctx.finalityBuffer);

      const history = await guard("link.list.history", async () => {
        const rows = await ctx.db
          .select()
          .from(schema.links)
          .where(eq(schema.links.account, lc(input.account)))
          .orderBy(desc(schema.links.linkedBlock))
          .limit(100);
        return {
          available: true as const,
          rows: rows.map((r) => ({
            wallet: r.wallet as Address,
            linkedBlock: r.linkedBlock.toString(),
            linkedAt: r.linkedAt?.toISOString() ?? null,
            linkedTx: r.linkedTx,
            unlinkedBlock: r.unlinkedBlock?.toString() ?? null,
            unlinkedAt: r.unlinkedAt?.toISOString() ?? null,
            unlinkedTx: r.unlinkedTx,
            active: r.unlinkedBlock === null,
          })),
        };
      });

      return {
        available: true as const,
        chainId: ctx.chainId,
        account: input.account,
        asOf: { head: head.toString(), timestamp: set.timestamp.toString() },
        /** If this address is itself a linked wallet, the account it feeds. */
        linkedTo: set.linkedTo,
        maxWallets: Number(set.maxWallets),
        accruableThrough: accruableThrough.toString(),
        wallets: wallets.map((w) => ({
          wallet: w.wallet,
          linkedAtBlock: w.linkedAt.toString(),
          lastAccruedBlock: w.lastAccruedBlock.toString(),
          /** Next accrual covers (accrualCursor, toBlock]. */
          accrualCursor: w.accrualCursor.toString(),
          usdgBalance: usdg(w.usdgBalance),
          permit2: permit2View(w.permit2, set.timestamp),
          erc20AllowanceToPermit2: usdg(w.erc20AllowanceToPermit2),
        })),
        history,
      };
    }),
  ),
});
