import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import {
  REQUIRED_CONTRACTS,
  loadAddressBook,
  parseAddressBook,
  verifiedContracts,
} from "../src/chain/addresses.ts";
import { caller, deadClient, makeCtx, NOT_DEPLOYED } from "./helpers/context.ts";
import { createApp } from "../src/app.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const FULL = {
  chainId: 4663,
  deployBlock: 76_200_000,
  assetRegistry: A(1),
  ruleRegistry: A(2),
  electionRegistry: A(3),
  screeningGate: A(4),
  stockRouter: A(5),
  cashPark: A(6),
  feeVault: A(7),
  sweepExecutor: A(8),
  usdgParkAdapter: A(9),
};

describe("parseAddressBook", () => {
  test("a complete book for the right chain is deployed", () => {
    const b = parseAddressBook(FULL, 4663, "t");
    expect(b.deployed).toBe(true);
    if (!b.deployed) return;
    expect(b.addresses.sweepExecutor).toBe("0x0000000000000000000000000000000000000008");
    expect(b.addresses.deployBlock).toBe(76_200_000n);
    expect(b.addresses.sgovParkAdapter).toBeUndefined();
  });
  test("another chain's book is refused", () => {
    const b = parseAddressBook({ ...FULL, chainId: 46630 }, 4663, "t");
    expect(b.deployed).toBe(false);
    if (!b.deployed) expect(b.reason).toMatch(/chain 46630.*serves chain 4663/);
  });
  test("a book without chainId is refused (never guess the network)", () => {
    const { chainId: _, ...noChain } = FULL;
    const b = parseAddressBook(noChain, 4663, "t");
    expect(b.deployed).toBe(false);
    if (!b.deployed) expect(b.reason).toMatch(/no chainId/);
  });
  test("a partial deploy names what is missing", () => {
    const { sweepExecutor: _, cashPark: __, ...partial } = FULL;
    const b = parseAddressBook(partial, 4663, "t");
    expect(b.deployed).toBe(false);
    if (b.deployed) return;
    expect(b.missing).toEqual(["cashPark", "sweepExecutor"]);
    expect(b.present).toContain("ruleRegistry");
    expect(b.reason).toMatch(/missing cashPark, sweepExecutor/);
  });
  test("the zero address counts as not deployed", () => {
    const b = parseAddressBook({ ...FULL, sweepExecutor: "0x0000000000000000000000000000000000000000" }, 4663, "t");
    expect(b.deployed).toBe(false);
    if (!b.deployed) expect(b.reason).toMatch(/zero address for sweepExecutor/);
  });
  test("malformed addresses count as missing", () => {
    expect(parseAddressBook({ ...FULL, feeVault: "0x123" }, 4663, "t").deployed).toBe(false);
  });
  test("PascalCase aliases and a nested contracts object load", () => {
    const pascal = Object.fromEntries(
      Object.entries(FULL).map(([k, v]) => [k === "chainId" || k === "deployBlock" ? k : k[0]!.toUpperCase() + k.slice(1), v]),
    );
    expect(parseAddressBook(pascal, 4663, "t").deployed).toBe(true);
    const { chainId, deployBlock, ...contracts } = FULL;
    expect(parseAddressBook({ chainId, startBlock: String(deployBlock), contracts }, 4663, "t").deployed).toBe(true);
  });
  test("non-objects are refused", () => {
    expect(parseAddressBook(null, 4663, "t").deployed).toBe(false);
    expect(parseAddressBook([], 4663, "t").deployed).toBe(false);
    expect(parseAddressBook("x", 4663, "t").deployed).toBe(false);
  });
});

describe("loadAddressBook", () => {
  const dir = mkdtempSync(join(tmpdir(), "spare-book-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing file is 'not deployed', with the path in the reason", () => {
    const b = loadAddressBook({ chainId: 4663, file: join(dir, "4663.json") });
    expect(b.deployed).toBe(false);
    if (!b.deployed) expect(b.reason).toMatch(/SPARE is not deployed on chain 4663: no address book at/);
  });
  test("invalid JSON is 'not deployed', never a throw", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, "{ not json");
    const b = loadAddressBook({ chainId: 4663, file: f });
    expect(b.deployed).toBe(false);
  });
  test("reloads when the file changes (mtime cache)", () => {
    const f = join(dir, "live.json");
    writeFileSync(f, JSON.stringify({ chainId: 4663 }));
    utimesSync(f, new Date(1_000_000), new Date(1_000_000));
    expect(loadAddressBook({ chainId: 4663, file: f }).deployed).toBe(false);
    writeFileSync(f, JSON.stringify(FULL));
    utimesSync(f, new Date(2_000_000), new Date(2_000_000));
    expect(loadAddressBook({ chainId: 4663, file: f }).deployed).toBe(true);
  });
  test("ADDRESSES_JSON wins over the file and is validated the same way", () => {
    expect(loadAddressBook({ chainId: 4663, file: join(dir, "none.json"), json: JSON.stringify(FULL) }).deployed).toBe(true);
    const bad = loadAddressBook({ chainId: 4663, file: join(dir, "none.json"), json: "{oops" });
    expect(bad.deployed).toBe(false);
    if (!bad.deployed) expect(bad.source).toBe("ADDRESSES_JSON");
  });
});

describe("verifiedContracts (bytecode preflight)", () => {
  const book = parseAddressBook(FULL, 4663, "t");
  const stub = (codeless: Set<string>) =>
    ({ getCode: async ({ address }: { address: string }) => (codeless.has(address.toLowerCase()) ? undefined : "0x6001") }) as unknown as PublicClient;
  test("all contracts with code -> ok", async () => {
    const v = await verifiedContracts(stub(new Set()), book, REQUIRED_CONTRACTS);
    expect(v.ok).toBe(true);
  });
  test("an address with no bytecode is not deployed", async () => {
    const v = await verifiedContracts(stub(new Set([A(8)])), book, REQUIRED_CONTRACTS);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/no bytecode.*sweepExecutor/);
  });
  test("an optional contract that is absent from the book is reported", async () => {
    const v = await verifiedContracts(stub(new Set()), book, ["sgovParkAdapter"]);
    expect(v.ok).toBe(false);
  });
  test("a not-deployed book short-circuits without touching the RPC", async () => {
    const v = await verifiedContracts(deadClient(), NOT_DEPLOYED, REQUIRED_CONTRACTS);
    expect(v).toEqual({ ok: false, reason: NOT_DEPLOYED.reason });
  });
});

describe("routers when SPARE is not deployed: { available:false, reason } — never a 500, never a number", () => {
  const api = caller(makeCtx({}));
  const acct = { account: "0x1111111111111111111111111111111111111111" };
  const cases: [string, () => Promise<unknown>][] = [
    ["link.list", () => api.link.list(acct)],
    ["rule.get", () => api.rule.get(acct)],
    ["mix.get", () => api.mix.get(acct)],
    ["accrual.state", () => api.accrual.state(acct)],
    ["sweep.next", () => api.sweep.next(acct)],
    ["park.state", () => api.park.state({})],
    ["park.state (no input)", () => api.park.state()],
    ["universe.list", () => api.universe.list()],
  ];
  for (const [name, call] of cases) {
    test(name, async () => {
      const r = (await call()) as { available: boolean; code: string; reason: string };
      expect(r).toEqual({ available: false, code: "not_deployed", reason: NOT_DEPLOYED.reason });
    });
  }

  test("rule.preview without a what-if rule says why", async () => {
    // The chain check runs first; with an unreachable RPC that is the answer.
    const r = (await api.rule.preview({ ...acct, days: 7 })) as { available: boolean; code: string };
    expect(r.available).toBe(false);
    expect(["rpc_unavailable", "not_deployed"]).toContain(r.code);
  });

  test("oracle.status with an unreachable RPC is rpc_unavailable", async () => {
    const r = (await api.oracle.status()) as { available: boolean; code: string };
    expect(r).toMatchObject({ available: false, code: "rpc_unavailable" });
  });

  test("DB-only routers with the database down are db_unavailable", async () => {
    const l = (await api.accrual.ledger({ ...acct, limit: 10 })) as { code: string };
    const h = (await api.sweep.history({ ...acct, limit: 5 })) as { code: string };
    expect(l.code).toBe("db_unavailable");
    expect(h.code).toBe("db_unavailable");
  });

  test("invalid input is a 400-class error, not a 500", async () => {
    await expect(api.rule.get({ account: "0xnope" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.rule.get({ account: "0x0000000000000000000000000000000000000000" as never })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(api.rule.preview({ ...acct, days: 31 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("over HTTP: 200 with available:false, and /health stays 200 with every dependency down", async () => {
    const app = createApp(() => makeCtx({}));
    const res = await app.request(`/trpc/rule.get?input=${encodeURIComponent(JSON.stringify(acct))}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { data: { available: boolean; code: string } } };
    expect(body.result.data).toMatchObject({ available: false, code: "not_deployed" });

    const h = await app.request("/health");
    expect(h.status).toBe(200);
    const hb = (await h.json()) as Record<string, unknown>;
    expect(hb).toMatchObject({ ok: true, db: "down", redis: "down", contracts: { deployed: false } });
    expect((hb.chain as { rpc: string }).rpc).toBe("down");
  });
});
