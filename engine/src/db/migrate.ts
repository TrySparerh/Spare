/**
 * Apply Drizzle migrations, bind the database to this engine's chain, then
 * create the Timescale hypertables — tolerating plain Postgres gracefully.
 *
 * Usage: bun run db:migrate
 */
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.ts";

export const HYPERTABLES = [
  ["payments", "block_time"],
  ["oracle_snapshots", "observed_at"],
] as const;

export interface MigrateReport {
  chainId: number;
  timescale: string | null;
  hypertables: string[];
}

export async function migrateDatabase(sql: postgres.Sql, db: Db, chainId: number, log = console.log): Promise<MigrateReport> {
  log("[migrate] applying drizzle migrations…");
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });

  // One engine database indexes one chain. Never relabel another chain's data.
  await sql`insert into chain_binding (id, chain_id) values (1, ${chainId}) on conflict (id) do nothing`;
  const [binding] = await sql`select chain_id from chain_binding where id = 1`;
  if (binding?.chain_id !== chainId) {
    throw new Error(`database is bound to chain ${binding?.chain_id}; this engine serves chain ${chainId} — use a separate database`);
  }

  let timescale: string | null = null;
  try {
    await sql`create extension if not exists timescaledb`;
    const [ext] = await sql`select extversion from pg_extension where extname = 'timescaledb'`;
    timescale = (ext?.extversion as string | undefined) ?? null;
  } catch (err) {
    log(
      `[migrate] timescaledb unavailable (${(err as Error).message.split("\n")[0]}) — payments/oracle_snapshots stay plain tables`,
    );
  }

  const hypertables: string[] = [];
  if (timescale) {
    for (const [table, column] of HYPERTABLES) {
      try {
        await sql`select create_hypertable(${table}::regclass, ${column}::name, if_not_exists => true, migrate_data => true)`;
        hypertables.push(table);
      } catch (err) {
        log(`[migrate] could not create hypertable ${table} (${(err as Error).message.split("\n")[0]}) — plain table`);
      }
    }
  }
  if (!hypertables.includes("payments")) {
    // Without Timescale the literal key can be enforced directly.
    await sql`create unique index if not exists payments_log_idx on payments (tx_hash, log_index)`;
  }
  log(`[migrate] done — chain ${chainId}, timescale ${timescale ?? "absent"}, hypertables [${hypertables.join(", ")}]`);
  return { chainId, timescale, hypertables };
}

if (import.meta.main) {
  const { env } = await import("../env.ts");
  const { getDb, getSql } = await import("./client.ts");
  const sql = getSql();
  try {
    await migrateDatabase(sql, getDb(), env.CHAIN_ID);
    await sql.end({ timeout: 3 });
  } catch (err) {
    console.error("[migrate] failed:", (err as Error).message ?? err);
    process.exit(1);
  }
}
