import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  sql: postgres.Sql;
  db: Db;
}

/**
 * Lazy Postgres connection. postgres-js only opens sockets on first query, so
 * constructing this never throws even when the DB is down — queries fail fast
 * (connect_timeout) and callers are expected to catch.
 */
export function createDb(url: string, max = env.DB_POOL_MAX): DbHandle {
  const sql = postgres(url, {
    max,
    connect_timeout: 5,
    idle_timeout: 30,
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }) };
}

let handle: DbHandle | undefined;

export function getSql(): postgres.Sql {
  handle ??= createDb(env.DATABASE_URL);
  return handle.sql;
}

export function getDb(): Db {
  handle ??= createDb(env.DATABASE_URL);
  return handle.db;
}

/** true if a trivial query succeeds within the timeout. */
export async function dbHealthy(sql: postgres.Sql = getSql()): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
