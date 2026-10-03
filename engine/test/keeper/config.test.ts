/**
 * Keeper config: env validation (every bound refuses the value just past it),
 * and the address book (contracts/addresses/<chain>.json shape).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadBook, loadConfig, parseBook } from "../../src/keeper/config.ts";
import { DEFAULT_HOOK_PINS } from "../../src/keeper/hooks.ts";
import { BOOK, BOOK_JSON, TEST_PK } from "../helpers/fake-rpc-spare.ts";

const base = { KEEPER_PK: TEST_PK };
const ENGINE = resolve(import.meta.dir, "../..");

describe("loadConfig", () => {
  test("defaults", () => {
    expect(loadConfig(base)).toEqual({
      CHAIN_ID: 4663,
      RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
      KEEPER_PK: TEST_PK,
      KEEPER_BROADCAST: "0",
      ACCRUE_EVERY_MS: 60_000,
      SWEEP_EVERY_MS: 600_000,
      QUOTE_TOLERANCE_BPS: 50,
      IDLE_ADVANCE_BLOCKS: 500_000,
      LOGS_MAX_RANGE: 2_000_000,
      SCAN_MAX_BLOCKS: 500_000,
      SCAN_CONCURRENCY: 6,
      SCAN_WALLET_MAX_CALLS: 64,
      SCAN_WALLET_MAX_LOGS: 5_000,
      SCAN_WALLET_DEADLINE_MS: 45_000,
      SCAN_TICK_DEADLINE_MS: 120_000,
      FINALITY_MARGIN: 20,
      BACKOFF_BASE_MS: 300_000,
      BACKOFF_MAX_MS: 14_400_000,
      DORMANT_RECHECK_MS: 3_600_000,
      READ_CHUNK: 50,
      STARTUP_DELAY_MS: 180_000,
      MARKET_HOURS_GATE: "1",
      MARKET_GATE_EXEMPT: new Set(),
      SWEEP_MAX_ASSETS: 16,
      SWEEP_MAX_LEGS: 192,
      SWEEP_MAX_GAS: 24_000_000n,
      SWEEP_MAX_IMPACT_BPS: 30,
      QUOTE_ORACLE_ALLOWANCE_BPS: 60,
      QUOTE_MAX_SHORTFALL_BPS: 120,
      HOOK_PINS: [...DEFAULT_HOOK_PINS],
      SWEEP_RECOVERY_BPS: 10,
      SWEEP_RECOVERY_MAX_MS: 14_400_000,
      SWEEP_MAX_CALLS: 4,
      LOW_GAS_WEI: 500_000_000_000_000n,
      HEALTH_MAX_BAD_TICKS: 5,
      HOST: "::",
    });
  });

  test("the keeper key is required and must be 0x + 64 hex", () => {
    expect(() => loadConfig({})).toThrow();
    for (const pk of ["11".repeat(32), `0x${"11".repeat(31)}`, `0x${"zz".repeat(32)}`]) {
      expect(() => loadConfig({ KEEPER_PK: pk })).toThrow("KEEPER_PK must be 0x + 64 hex chars");
    }
  });

  test("values are trimmed and blank ones fall back to the default", () => {
    const c = loadConfig({ KEEPER_PK: `  ${TEST_PK}\n`, PORT: "   ", ACCRUE_EVERY_MS: "", KEEPER_BROADCAST: " 1 ", SWEEP_MAX_GAS: "15000000", LOW_GAS_WEI: "1" });
    expect(c).toMatchObject({ KEEPER_PK: TEST_PK, ACCRUE_EVERY_MS: 60_000, KEEPER_BROADCAST: "1", SWEEP_MAX_GAS: 15_000_000n, LOW_GAS_WEI: 1n });
    expect(c.PORT).toBeUndefined();
  });

  // [variable, smallest accepted, largest accepted (or null: no upper bound)]
  const bounds: [string, number, number | null][] = [
    ["ACCRUE_EVERY_MS", 10_000, null],
    ["SWEEP_EVERY_MS", 30_000, null],
    ["QUOTE_TOLERANCE_BPS", 1, 300],
    ["IDLE_ADVANCE_BLOCKS", 10_000, null],
    ["LOGS_MAX_RANGE", 1_000, null],
    ["SCAN_MAX_BLOCKS", 1_000, null],
    ["SCAN_CONCURRENCY", 1, 32],
    ["SCAN_WALLET_MAX_CALLS", 2, null],
    ["SCAN_WALLET_MAX_LOGS", 100, null],
    ["SCAN_WALLET_DEADLINE_MS", 1_000, null],
    ["SCAN_TICK_DEADLINE_MS", 5_000, null],
    ["FINALITY_MARGIN", 0, null],
    ["BACKOFF_BASE_MS", 1_000, null],
    ["BACKOFF_MAX_MS", 1_000, null],
    ["DORMANT_RECHECK_MS", 10_000, null],
    ["READ_CHUNK", 1, 500],
    ["STARTUP_DELAY_MS", 0, null],
    ["SWEEP_MAX_ASSETS", 1, 256],
    ["SWEEP_MAX_LEGS", 1, 384],
    ["SWEEP_MAX_IMPACT_BPS", 1, 150],
    ["QUOTE_ORACLE_ALLOWANCE_BPS", 0, 150],
    ["QUOTE_MAX_SHORTFALL_BPS", 0, 140],
    ["SWEEP_MAX_CALLS", 1, 16],
    ["SWEEP_RECOVERY_BPS", 1, 100],
    ["SWEEP_RECOVERY_MAX_MS", 600_000, 86_400_000],
    ["HEALTH_MAX_BAD_TICKS", 1, null],
    ["PORT", 1, null],
  ];
  test.each(bounds)("%s: refuses min - 1 and max + 1, accepts the bounds", (key, min, max) => {
    expect((loadConfig({ ...base, [key]: String(min) }) as Record<string, unknown>)[key]).toBe(min);
    expect(() => loadConfig({ ...base, [key]: String(min - 1) })).toThrow();
    if (max !== null) {
      expect((loadConfig({ ...base, [key]: String(max) }) as Record<string, unknown>)[key]).toBe(max);
      expect(() => loadConfig({ ...base, [key]: String(max + 1) })).toThrow();
    }
    expect(() => loadConfig({ ...base, [key]: `${min}.5` })).toThrow();
    expect(() => loadConfig({ ...base, [key]: "lots" })).toThrow();
  });

  test("switches are exactly 0 or 1; the RPC must be a URL; the health token is at least 32 characters", () => {
    for (const key of ["KEEPER_BROADCAST", "MARKET_HOURS_GATE"]) {
      expect(() => loadConfig({ ...base, [key]: "true" })).toThrow();
      expect(() => loadConfig({ ...base, [key]: "yes" })).toThrow();
    }
    expect(() => loadConfig({ ...base, RPC_URL: "rpc.mainnet.chain.robinhood.com" })).toThrow();
    expect(loadConfig({ ...base, RPC_URL: "http://127.0.0.1:8545" }).RPC_URL).toBe("http://127.0.0.1:8545");
    expect(() => loadConfig({ ...base, HEALTH_TOKEN: "x".repeat(31) })).toThrow("HEALTH_TOKEN must be at least 32 characters");
    expect(() => loadConfig({ ...base, SWEEP_MAX_GAS: "lots" })).toThrow();
    expect(() => loadConfig({ ...base, CHAIN_ID: "4663.5" })).toThrow();
  });
});

describe("address book", () => {
  test("parseBook reads the deploy's contracts block and checksums every address", () => {
    const lower = { ...BOOK_JSON, contracts: Object.fromEntries(Object.entries(BOOK_JSON.contracts).map(([k, v]) => [k, String(v).toLowerCase()])) };
    expect(parseBook(lower, 4663)).toEqual(BOOK);
  });

  test("top-level keys (camelCase or contract name) are read too; optional adapters may be missing; startBlock may be deployBlock or a string", () => {
    const { UsdgParkAdapter: _, ...contracts } = BOOK_JSON.contracts;
    const flat = { chainId: "4663", deployBlock: "1000", ...Object.fromEntries(Object.entries(contracts).map(([k, v], i) => [i % 2 ? k : k[0]!.toLowerCase() + k.slice(1), v])) };
    const { usdgParkAdapter: _u, ...want } = BOOK;
    expect(parseBook(flat, 4663)).toEqual(want);
    expect(parseBook({ ...flat, deployBlock: undefined }, 4663).startBlock).toBe(0n);
  });

  test("parseBook refuses a non-object, another chain, a missing or malformed required contract", () => {
    expect(() => parseBook(null, 4663)).toThrow("address book is not an object");
    expect(() => parseBook("{}", 4663)).toThrow("address book is not an object");
    expect(() => parseBook(BOOK_JSON, 31337)).toThrow("address book is for chain 4663, keeper serves 31337");
    const { SweepExecutor: _, ...noExecutor } = BOOK_JSON.contracts;
    expect(() => parseBook({ ...BOOK_JSON, contracts: noExecutor }, 4663)).toThrow("address book is missing SweepExecutor");
    expect(() => parseBook({ ...BOOK_JSON, contracts: { ...BOOK_JSON.contracts, CashPark: "0x1234" } }, 4663)).toThrow("address book is missing CashPark");
  });

  test("loadBook: ADDRESSES_JSON, an absolute or engine-relative ADDRESSES_FILE, else the committed book for the chain", () => {
    expect(loadBook(loadConfig({ ...base, ADDRESSES_JSON: JSON.stringify(BOOK_JSON) }))).toEqual(BOOK);

    const dir = mkdtempSync(join(tmpdir(), "spare-keeper-book-"));
    try {
      const file = join(dir, "book.json");
      writeFileSync(file, JSON.stringify(BOOK_JSON));
      expect(loadBook(loadConfig({ ...base, ADDRESSES_FILE: file }))).toEqual(BOOK);
      expect(loadBook(loadConfig({ ...base, ADDRESSES_FILE: relative(ENGINE, file) }))).toEqual(BOOK);
      expect(() => loadBook(loadConfig({ ...base, ADDRESSES_FILE: join(dir, "missing.json") }))).toThrow(`no address book at ${join(dir, "missing.json")} (set ADDRESSES_JSON)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const committed = JSON.parse(readFileSync(resolve(ENGINE, "../contracts/addresses/4663.json"), "utf8"));
    const book = loadBook(loadConfig(base));
    expect(book.sweepExecutor).toBe(committed.contracts.SweepExecutor);
    expect(book.startBlock).toBe(BigInt(committed.startBlock));
    expect(() => loadBook(loadConfig({ ...base, CHAIN_ID: "1" }))).toThrow("no address book at");
  });
});
