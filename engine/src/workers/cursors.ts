/**
 * Durable indexing cursors: named per worker (and per wallet), and
 * finality-aware.
 *
 * A cursor records the CONTIGUOUS range [start_block, last_block] a worker has
 * fully processed, plus the hash of last_block. Each run:
 *   1. takes a Postgres advisory lock for (chain, name) inside a transaction,
 *   2. re-reads last_block's hash — if it changed, stops (no silent rewind),
 *   3. plans the next range up to head - confirmations,
 *   4. runs the handler (its writes share the transaction),
 *   5. re-checks the range end's hash, then advances the cursor.
 * A failed handler rolls back its writes and the cursor together.
 *
 * Cursor names are shared by the core and the planned workers:
 *   "chain-indexer"       SPARE contract events from deployBlock
 *   "payments:<wallet>"   USDG Transfer(from = wallet), from the wallet's link block
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PublicClient } from "viem";
import type { Db } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export class CursorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CursorError";
  }
}

export interface CursorIdentity {
  chainId: number;
  name: string;
  /** cursorSource(...) of the contracts this cursor reads. */
  source: string;
  startBlock: bigint;
}

export interface CursorRange {
  from: bigint;
  to: bigint;
  head: bigint;
  safeHead: bigint;
}

export type CursorRow = typeof schema.cursors.$inferSelect;

export const CHAIN_INDEXER_CURSOR = "chain-indexer";
export function paymentsCursorName(wallet: string): string {
  return `payments:${wallet.toLowerCase()}`;
}

/** Order-preserving hash of the source contract set. Missing / zero addresses fail closed. */
export function cursorSource(addresses: readonly (string | undefined | null)[]): string {
  if (
    addresses.length === 0 ||
    addresses.some((a) => !a || !/^0x[0-9a-f]{40}$/i.test(a) || /^0x0{40}$/i.test(a))
  ) {
    throw new CursorError("missing_source", "every source contract address must be configured before indexing");
  }
  return createHash("sha256")
    .update(addresses.map((a) => a!.toLowerCase()).join(":"))
    .digest("hex");
}

/** Pure planner: the next range, or null when caught up. Never rewinds. */
export function planRange(
  id: CursorIdentity,
  previous: Pick<CursorRow, "chainId" | "name" | "source" | "startBlock" | "lastBlock" | "lastHash"> | null,
  head: bigint,
  confirmations: bigint,
  maxBlocks: bigint,
): CursorRange | null {
  if (!Number.isSafeInteger(id.chainId) || id.chainId <= 0 || id.startBlock < 0n || maxBlocks < 1n || confirmations < 0n || head < 0n) {
    throw new CursorError("invalid_bounds", "invalid chain or block bounds");
  }
  if (previous && (previous.chainId !== id.chainId || previous.name !== id.name)) {
    throw new CursorError("identity_mismatch", "cursor belongs to another chain or name");
  }
  if (previous && (previous.source !== id.source || previous.startBlock !== id.startBlock)) {
    throw new CursorError(
      "deployment_changed",
      "source contracts or start block changed — reconcile explicitly; cursors are never relabelled",
    );
  }
  const safeHead = head > confirmations ? head - confirmations : 0n;
  let last: bigint | null = null;
  if (previous?.lastBlock !== null && previous?.lastBlock !== undefined) {
    last = previous.lastBlock;
    if (last < id.startBlock || !/^0x[0-9a-f]{64}$/i.test(previous.lastHash ?? "")) {
      throw new CursorError("invalid_cursor", "stored cursor is outside its history or missing its block hash");
    }
    if (last > head) throw new CursorError("head_behind_cursor", "observed head is behind the cursor; no automatic rewind");
  }
  const from = last === null ? id.startBlock : last + 1n;
  if (from > safeHead) return null;
  const to = from + maxBlocks - 1n;
  return { from, to: to < safeHead ? to : safeHead, head, safeHead };
}

/** Advisory-locked transaction for one cursor. Returns null if another process holds it. */
export async function withCursorLock<T>(db: Db, chainId: number, name: string, fn: (tx: Db) => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const got = await tx.execute(sql`select pg_try_advisory_xact_lock(${chainId}, hashtext(${name})) as locked`);
    if (!(got as unknown as { locked: boolean }[])[0]?.locked) return null;
    return fn(tx as unknown as Db);
  });
}

async function hashOf(client: PublicClient, n: bigint): Promise<string> {
  const b = await client.getBlock({ blockNumber: n });
  if (!b.hash) throw new CursorError("invalid_block_hash", `RPC returned no hash for block ${n}`);
  return b.hash;
}

/**
 * Process the next range for a cursor. The handler's writes and the cursor
 * advance commit together; on any error both roll back and the error is
 * recorded (reason code only) on the cursor row.
 */
export async function runCursor(
  opts: {
    db: Db;
    client: PublicClient;
    id: CursorIdentity;
    confirmations: bigint;
    maxBlocks: bigint;
  },
  handler: (range: CursorRange, tx: Db) => Promise<void>,
): Promise<{ range: CursorRange | null; cursor: CursorRow } | null> {
  const { db, client, id } = opts;
  const startedAt = new Date();
  let observedHead: bigint | null = null;
  try {
    return await withCursorLock(db, id.chainId, id.name, async (tx) => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      observedHead = head;
      const rows = await tx
        .select()
        .from(schema.cursors)
        .where(and(eq(schema.cursors.chainId, id.chainId), eq(schema.cursors.name, id.name)));
      const previous = rows[0] ?? null;
      const range = planRange(id, previous, head, opts.confirmations, opts.maxBlocks);
      if (previous?.lastBlock !== null && previous?.lastBlock !== undefined && previous.lastHash) {
        const h = await hashOf(client, previous.lastBlock);
        if (h.toLowerCase() !== previous.lastHash.toLowerCase()) {
          throw new CursorError("cursor_hash_changed", `block ${previous.lastBlock} hash changed under the cursor — reconcile`);
        }
      }
      let lastHash = previous?.lastHash ?? null;
      if (range) {
        lastHash = await hashOf(client, range.to);
        await handler(range, tx);
        if ((await hashOf(client, range.to)).toLowerCase() !== lastHash.toLowerCase()) {
          throw new CursorError("range_hash_changed", "range end changed while processing; cursor not advanced");
        }
      }
      const now = new Date();
      const next: CursorRow = {
        chainId: id.chainId,
        name: id.name,
        source: id.source,
        startBlock: id.startBlock,
        lastBlock: range ? range.to : (previous?.lastBlock ?? null),
        lastHash,
        observedHead: head,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastError: null,
      };
      await tx
        .insert(schema.cursors)
        .values(next)
        .onConflictDoUpdate({ target: [schema.cursors.chainId, schema.cursors.name], set: next });
      return { range, cursor: next };
    });
  } catch (err) {
    const code = err instanceof CursorError ? err.code : "range_failed";
    await db
      .execute(
        sql`insert into cursors (chain_id, name, source, start_block, observed_head, last_attempt_at, last_error)
            values (${id.chainId}, ${id.name}, ${id.source}, ${id.startBlock.toString()}, ${(observedHead as bigint | null)?.toString() ?? null}, now(), ${code})
            on conflict (chain_id, name) do update set last_attempt_at = now(), last_error = excluded.last_error,
              observed_head = coalesce(excluded.observed_head, cursors.observed_head)
            where cursors.source = excluded.source and cursors.start_block = excluded.start_block
              and (cursors.last_success_at is null or cursors.last_success_at <= ${startedAt.toISOString()}::timestamptz)`,
      )
      .catch(() => {});
    throw err;
  }
}

/** Contiguous coverage of a cursor, or null if it has processed nothing. */
export function coverage(row: Pick<CursorRow, "startBlock" | "lastBlock"> | undefined | null): { from: bigint; to: bigint } | null {
  if (!row || row.lastBlock === null || row.lastBlock < row.startBlock) return null;
  return { from: row.startBlock, to: row.lastBlock };
}
