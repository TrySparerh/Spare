import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PublicClient } from "viem";
import {
  CursorError,
  coverage,
  cursorSource,
  paymentsCursorName,
  planRange,
  runCursor,
  type CursorIdentity,
} from "../src/workers/cursors.ts";
import * as schema from "../src/db/schema.ts";
import { closeTestDb, testDb, type TestDb } from "./helpers/db.ts";

const H = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const id: CursorIdentity = { chainId: 31337, name: "payments:0xabc", source: "s1", startBlock: 100n };

describe("planRange (pure)", () => {
  test("first run starts at startBlock and stops at head - confirmations", () => {
    expect(planRange(id, null, 1_000n, 300n, 10_000n)).toEqual({ from: 100n, to: 700n, head: 1_000n, safeHead: 700n });
  });
  test("honours maxBlocks", () => {
    expect(planRange(id, null, 1_000n, 0n, 50n)).toMatchObject({ from: 100n, to: 149n });
  });
  test("continues from last_block + 1", () => {
    const prev = { chainId: 31337, name: id.name, source: "s1", startBlock: 100n, lastBlock: 500n, lastHash: H(500) };
    expect(planRange(id, prev, 1_000n, 0n, 10_000n)).toMatchObject({ from: 501n, to: 1_000n });
  });
  test("caught up -> null", () => {
    const prev = { chainId: 31337, name: id.name, source: "s1", startBlock: 100n, lastBlock: 700n, lastHash: H(700) };
    expect(planRange(id, prev, 1_000n, 300n, 10_000n)).toBeNull();
  });
  test("never before the finality buffer", () => {
    expect(planRange(id, null, 150n, 3000n, 10_000n)).toBeNull();
  });
  test("a redeploy (source change) is refused, not relabelled", () => {
    const prev = { chainId: 31337, name: id.name, source: "OLD", startBlock: 100n, lastBlock: 200n, lastHash: H(200) };
    expect(() => planRange(id, prev, 1_000n, 0n, 100n)).toThrow(CursorError);
  });
  test("head behind the cursor is refused (no silent rewind)", () => {
    const prev = { chainId: 31337, name: id.name, source: "s1", startBlock: 100n, lastBlock: 900n, lastHash: H(900) };
    expect(() => planRange(id, prev, 800n, 0n, 100n)).toThrow(/no automatic rewind/);
  });
  test("cursorSource is order-preserving and fails closed", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const b = "0x2222222222222222222222222222222222222222";
    expect(cursorSource([a, b])).not.toBe(cursorSource([b, a]));
    expect(cursorSource([a.toUpperCase().replace("0X", "0x")])).toBe(cursorSource([a]));
    expect(() => cursorSource([a, "0x0000000000000000000000000000000000000000"])).toThrow(CursorError);
    expect(() => cursorSource([])).toThrow(CursorError);
  });
  test("names and coverage", () => {
    expect(paymentsCursorName("0xABCDEF0000000000000000000000000000000000")).toBe("payments:0xabcdef0000000000000000000000000000000000");
    expect(coverage({ startBlock: 10n, lastBlock: null })).toBeNull();
    expect(coverage({ startBlock: 10n, lastBlock: 20n })).toEqual({ from: 10n, to: 20n });
  });
});

describe("runCursor against a real database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await testDb(31337);
    await t.handle.sql`create table if not exists cursor_probe (n bigint primary key)`;
  });
  afterAll(async () => {
    await t.handle.sql`drop table if exists cursor_probe`;
    await closeTestDb();
  });

  /** Deterministic chain stub: head and block hashes. */
  const chain = (head: bigint, hash: (n: bigint) => string = H) =>
    ({
      getBlockNumber: async () => head,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hash(blockNumber) }),
    }) as unknown as PublicClient;

  test("a failed handler rolls back its writes AND the cursor", async () => {
    const opts = { db: t.handle.db, client: chain(1_000n), id, confirmations: 0n, maxBlocks: 50n };
    await expect(
      runCursor(opts, async (range, tx) => {
        await tx.execute(sql`insert into cursor_probe (n) values (${range.to})`);
        throw new Error("boom after write");
      }),
    ).rejects.toThrow("boom after write");
    expect((await t.handle.sql`select count(*)::int as n from cursor_probe`)[0]!.n).toBe(0);
    const [row] = await t.handle.db.select().from(schema.cursors).where(eq(schema.cursors.name, id.name));
    expect(row?.lastBlock ?? null).toBeNull();
    expect(row?.lastError).toBe("range_failed");
  });

  test("a successful run commits writes and advances the cursor, then continues", async () => {
    const opts = { db: t.handle.db, client: chain(1_000n), id, confirmations: 0n, maxBlocks: 50n };
    const first = await runCursor(opts, async (range, tx) => {
      await tx.execute(sql`insert into cursor_probe (n) values (${range.to})`);
    });
    expect(first?.range).toMatchObject({ from: 100n, to: 149n });
    const second = await runCursor(opts, async (range, tx) => {
      await tx.execute(sql`insert into cursor_probe (n) values (${range.to})`);
    });
    expect(second?.range).toMatchObject({ from: 150n, to: 199n });
    const [row] = await t.handle.db.select().from(schema.cursors).where(eq(schema.cursors.name, id.name));
    expect(row?.lastBlock).toBe(199n);
    expect(row?.lastHash).toBe(H(199));
    expect(row?.lastError).toBeNull();
  });

  test("a changed block hash under the cursor stops the worker", async () => {
    const opts = {
      db: t.handle.db,
      client: chain(1_000n, (n) => (n === 199n ? H(999_999) : H(n))),
      id,
      confirmations: 0n,
      maxBlocks: 50n,
    };
    await expect(runCursor(opts, async () => {})).rejects.toThrow(/hash changed/);
    const [row] = await t.handle.db.select().from(schema.cursors).where(eq(schema.cursors.name, id.name));
    expect(row?.lastBlock).toBe(199n); // not advanced
  });
});
