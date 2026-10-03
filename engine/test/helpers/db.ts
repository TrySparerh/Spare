/**
 * Isolated test database.
 *
 * Preferred: the compose Timescale Postgres (infra/docker-compose.yml, :5434),
 * database `spare_test`. Fallback, when that server is not reachable: an
 * in-process PGlite (real PostgreSQL compiled to WASM) served over the
 * Postgres wire protocol on a random loopback port, so the engine's own
 * postgres-js + Drizzle code path is what gets exercised. PGlite has no
 * TimescaleDB, so under it migrate.ts takes its plain-table branch.
 *
 * Refuses anything but a loopback host and a database named *_test, so a test
 * run can never truncate the dev or a remote database.
 */
import postgres from "postgres";
import { createDb, type DbHandle } from "../../src/db/client.ts";
import { migrateDatabase, type MigrateReport } from "../../src/db/migrate.ts";

export const TEST_DATABASE_URL =
  process.env.SPARE_TEST_DATABASE_URL ?? "postgres://spare:spare_dev@127.0.0.1:5434/spare_test";

export function assertIsolated(url: string): URL {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || !/_test$/.test(u.pathname.slice(1))) {
    throw new Error(`refusing to use ${u.hostname}${u.pathname} as a test database (loopback + *_test only)`);
  }
  return u;
}

export interface TestDb {
  handle: DbHandle;
  kind: "compose-postgres" | "pglite";
  migrate: MigrateReport;
}

let current: TestDb | null = null;
let pglite: { stop: () => Promise<void> } | null = null;

async function composeReachable(u: URL): Promise<boolean> {
  const admin = new URL(u);
  admin.pathname = "/postgres";
  const a = postgres(admin.toString(), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    const name = u.pathname.slice(1);
    const exists = await a`select 1 from pg_database where datname = ${name}`;
    if (!exists.length) await a.unsafe(`create database "${name}"`);
    return true;
  } catch {
    return false;
  } finally {
    await a.end({ timeout: 1 }).catch(() => {});
  }
}

async function startPglite(): Promise<string> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const pg = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1", maxConnections: 8 });
  await server.start();
  const addr = (server as unknown as { server?: { address(): { port: number } } }).server?.address();
  if (!addr?.port) throw new Error("PGlite socket server did not report a port");
  pglite = {
    stop: async () => {
      await server.stop().catch(() => {});
      await pg.close().catch(() => {});
    },
  };
  return `postgres://postgres:postgres@127.0.0.1:${addr.port}/spare_test`;
}

/** A clean, migrated test database bound to `chainId`. */
export async function testDb(chainId: number): Promise<TestDb> {
  if (!current) {
    const u = assertIsolated(TEST_DATABASE_URL);
    let url = u.toString();
    let kind: TestDb["kind"] = "compose-postgres";
    if (process.env.SPARE_TEST_PGLITE === "1" || !(await composeReachable(u))) {
      url = await startPglite();
      kind = "pglite";
    }
    assertIsolated(url);
    const handle = createDb(url, 4);
    // A reused test database may be bound to another chain from a previous run.
    await handle.sql.unsafe("truncate chain_binding").catch(() => {});
    const migrate = await migrateDatabase(handle.sql, handle.db, chainId, () => {});
    current = { handle, kind, migrate };
  }
  await resetDb(current.handle, chainId);
  return current;
}

const TABLES = [
  "payments",
  "accrual_batches",
  "links",
  "rules",
  "mixes",
  "cursors",
  "sweeps",
  "sweep_fills",
  "deliveries",
  "universe",
  "oracle_snapshots",
  "chain_binding",
];

export async function resetDb(h: DbHandle, chainId: number): Promise<void> {
  await h.sql.unsafe(`truncate ${TABLES.join(", ")}`);
  await h.sql`insert into chain_binding (id, chain_id) values (1, ${chainId})`;
}

export async function closeTestDb(): Promise<void> {
  if (current) await current.handle.sql.end({ timeout: 2 }).catch(() => {});
  current = null;
  if (pglite) await pglite.stop();
  pglite = null;
}
