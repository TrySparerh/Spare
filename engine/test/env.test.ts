import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CORS_ORIGINS,
  DEFAULT_DATABASE_URL,
  DEFAULT_REDIS_URL,
  assertProductionConfig,
  keyWarnings,
  parseEnv,
  redisHasPassword,
} from "../src/env.ts";
import { corsOrigins } from "../src/app.ts";

describe("parseEnv defaults", () => {
  const e = parseEnv({});
  test("local infra ports (docker-compose: Timescale on 5434, Redis on 6381)", () => {
    expect(e.DATABASE_URL).toBe(DEFAULT_DATABASE_URL);
    expect(new URL(e.DATABASE_URL).port).toBe("5434");
    expect(e.REDIS_URL).toBe(DEFAULT_REDIS_URL);
    expect(new URL(e.REDIS_URL).port).toBe("6381");
  });
  test("chain 4663 with the public RHC RPC", () => {
    expect(e.CHAIN_ID).toBe(4663);
    expect(e.RPC_URL).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
  test("address book defaults to ../contracts/addresses/<CHAIN_ID>.json", () => {
    expect(e.ADDRESSES_FILE).toBe("../contracts/addresses/4663.json");
    expect(e.ADDRESSES_JSON).toBeUndefined();
  });
  test("finality buffer 3000 and keeper off", () => {
    expect(e.FINALITY_BUFFER).toBe(3000);
    expect(e.KEEPER_ADDRESS).toBeUndefined();
    expect(e.KEEPER_BROADCAST).toBe("0");
    expect(e.HEALTH_TOKEN).toBeUndefined();
    expect(e.strayKeeperKey).toBe(false);
  });
  test("CORS includes the production app and the local desktop", () => {
    expect(e.CORS_ORIGIN_LIST).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(e.CORS_ORIGIN_LIST).toContain("https://trysparerh.com");
    expect(e.CORS_ORIGIN_LIST).toContain("http://localhost:8080");
  });
  test("nothing was marked explicit", () => {
    expect(e.explicit).toEqual({ DATABASE_URL: false, REDIS_URL: false, RPC_URL: false });
  });
});

describe("parseEnv overrides and validation", () => {
  test("local fork chain picks the anvil RPC and its own address book", () => {
    const e = parseEnv({ CHAIN_ID: "31337" });
    expect(e.CHAIN_ID).toBe(31337);
    expect(e.RPC_URL).toBe("http://127.0.0.1:8545");
    expect(e.ADDRESSES_FILE).toBe("../contracts/addresses/31337.json");
  });
  test("explicit RPC_URL and ADDRESSES_FILE win", () => {
    const e = parseEnv({ CHAIN_ID: "4663", RPC_URL: "https://rhc.example.org/rpc", ADDRESSES_FILE: "/abs/book.json" });
    expect(e.RPC_URL).toBe("https://rhc.example.org/rpc");
    expect(e.ADDRESSES_FILE).toBe("/abs/book.json");
    expect(e.explicit.RPC_URL).toBe(true);
  });
  test("unsupported chains are rejected (testnet 46630 has no Uniswap or stock tokens)", () => {
    expect(() => parseEnv({ CHAIN_ID: "46630" })).toThrow();
    expect(() => parseEnv({ CHAIN_ID: "8453" })).toThrow();
    expect(() => parseEnv({ CHAIN_ID: "abc" })).toThrow();
  });
  test("blank values count as unset", () => {
    const e = parseEnv({ CHAIN_ID: "", RPC_URL: "  ", KEEPER_ADDRESS: "", KEEPER_PK: " ", FINALITY_BUFFER: "" });
    expect(e.CHAIN_ID).toBe(4663);
    expect(e.KEEPER_ADDRESS).toBeUndefined();
    expect(e.strayKeeperKey).toBe(false);
    expect(e.FINALITY_BUFFER).toBe(3000);
  });
  test("the API takes the keeper's address, checksummed; never its key", () => {
    expect(() => parseEnv({ KEEPER_ADDRESS: "0x1234" })).toThrow(/KEEPER_ADDRESS/);
    expect(() => parseEnv({ KEEPER_ADDRESS: `0x${"ab".repeat(32)}` })).toThrow(/KEEPER_ADDRESS/);
    const a = parseEnv({ KEEPER_ADDRESS: "0x8ba1f109551bd432803012645ac136ddd64dba72" });
    expect(a.KEEPER_ADDRESS).toBe("0x8ba1f109551bD432803012645Ac136ddd64DBA72");
    // A key left on the service is not parsed (nothing exposes it), only reported, whatever NODE_ENV.
    const pk = `0x${"ab".repeat(32)}`;
    const e = parseEnv({ KEEPER_PK: pk });
    expect(Object.values(e)).not.toContain(pk);
    expect(JSON.stringify(e)).not.toContain("abab");
    expect(e.strayKeeperKey).toBe(true);
    expect(keyWarnings(e)).toEqual(["[env] KEEPER_PK is set but this service never signs: remove it from this service and set KEEPER_ADDRESS instead."]);
    expect(keyWarnings(parseEnv({}))).toEqual([]);
  });
  test("HEALTH_TOKEN must be at least 32 characters", () => {
    expect(() => parseEnv({ HEALTH_TOKEN: "short" })).toThrow(/HEALTH_TOKEN/);
    expect(parseEnv({ HEALTH_TOKEN: "t".repeat(32) }).HEALTH_TOKEN).toBe("t".repeat(32));
  });
  test("KEEPER_BROADCAST only accepts 0/1", () => {
    expect(() => parseEnv({ KEEPER_BROADCAST: "yes" })).toThrow();
    expect(parseEnv({ KEEPER_BROADCAST: "1" }).KEEPER_BROADCAST).toBe("1");
  });
  test("database and redis URLs must use their schemes", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://x@y/z" })).toThrow();
    expect(() => parseEnv({ REDIS_URL: "http://localhost:6379" })).toThrow();
    expect(parseEnv({ REDIS_URL: "rediss://:pw@r.example:6380" }).REDIS_URL).toBe("rediss://:pw@r.example:6380");
  });
  test("CORS origins must be bare origins", () => {
    expect(() => parseEnv({ CORS_ORIGINS: "https://a.example/path" })).toThrow();
    expect(() => parseEnv({ CORS_ORIGINS: "ftp://a.example" })).toThrow();
    expect(parseEnv({ CORS_ORIGINS: "https://a.example, http://localhost:3000," }).CORS_ORIGIN_LIST).toEqual([
      "https://a.example",
      "http://localhost:3000",
    ]);
  });
  test("numeric bounds", () => {
    expect(() => parseEnv({ FINALITY_BUFFER: "-1" })).toThrow();
    expect(() => parseEnv({ LOGS_MAX_RANGE: "10" })).toThrow();
    expect(parseEnv({ PORT: "8081" }).PORT).toBe(8081);
  });
  test("unknown variables are ignored", () => {
    expect(() => parseEnv({ SOMETHING_ELSE: "x" })).not.toThrow();
  });
});

describe("production guardrails", () => {
  const prod = (extra: Record<string, string>) => parseEnv({ NODE_ENV: "production", ...extra });
  test("refuses the dev database defaults", () => {
    expect(() => assertProductionConfig(prod({ REDIS_URL: "redis://:pw@r:6379" }))).toThrow(/DATABASE_URL/);
    expect(() =>
      assertProductionConfig(prod({ DATABASE_URL: DEFAULT_DATABASE_URL, REDIS_URL: "redis://:pw@r:6379" })),
    ).toThrow(/DATABASE_URL/);
  });
  test("refuses an implicit Redis", () => {
    expect(() => assertProductionConfig(prod({ DATABASE_URL: "postgres://u:p@db:5432/spare" }))).toThrow(/REDIS_URL/);
  });
  test("refuses a local-fork chain id", () => {
    expect(() =>
      assertProductionConfig(
        prod({ DATABASE_URL: "postgres://u:p@db:5432/spare", REDIS_URL: "redis://:pw@r:6379", CHAIN_ID: "31337" }),
      ),
    ).toThrow(/31337/);
  });
  test("warns (not throws) on passwordless Redis and the public RPC", () => {
    const w = assertProductionConfig(prod({ DATABASE_URL: "postgres://u:p@db:5432/spare", REDIS_URL: "redis://r:6379" }));
    expect(w.some((x) => /password/.test(x))).toBe(true);
    expect(w.some((x) => /RPC_URL/.test(x))).toBe(true);
  });
  test("no-op outside production", () => {
    expect(assertProductionConfig(parseEnv({}))).toEqual([]);
  });
  test("redisHasPassword", () => {
    expect(redisHasPassword("redis://:secret@h:1")).toBe(true);
    expect(redisHasPassword("redis://h:1")).toBe(false);
  });
  test("production CORS is exactly the configured list; dev adds local frontends", () => {
    expect(corsOrigins(["https://trysparerh.com"], true)).toEqual([
      "https://trysparerh.com",
    ]);
    expect(corsOrigins(["https://trysparerh.com"], false)).toContain("http://localhost:8080");
  });
});
