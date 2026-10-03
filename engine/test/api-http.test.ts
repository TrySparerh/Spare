/**
 * The engine's HTTP edge: tRPC batches are capped at MAX_BATCH_SIZE and pay
 * the rate limiter per call (B-M3), and the limiter keys on the address our
 * own proxy wrote, not on whatever the client put in X-Forwarded-For (B-L4).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp, MAX_BATCH_SIZE, trpcCalls } from "../src/app.ts";
import { clientAddress, rateLimit, rateLimitKey, type RateLimitOptions } from "../src/middleware/rateLimit.ts";
import { parseEnv } from "../src/env.ts";
import type { RequestInfo } from "../src/trpc.ts";
import { makeCtx, NOT_DEPLOYED } from "./helpers/context.ts";

/** createApp over a test context, counting how often a procedure reached the address book. */
function appCountingProcedures() {
  let bookReads = 0;
  const ctx = makeCtx({
    book: () => {
      bookReads++;
      return NOT_DEPLOYED;
    },
  });
  return { app: createApp(() => ctx), reads: () => bookReads };
}

const batchUrl = (n: number) =>
  `/trpc/${Array.from({ length: n }, () => "universe.list").join(",")}?batch=1&input=${encodeURIComponent("{}")}`;

describe("tRPC batch limit", () => {
  test("MAX_BATCH_SIZE is 5", () => {
    expect(MAX_BATCH_SIZE).toBe(5);
  });

  test("a GET batch of 6 is a 400 and no procedure runs", async () => {
    const { app, reads } = appCountingProcedures();
    const res = await app.request(batchUrl(6));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Batch call exceeds maximum size");
    expect(reads()).toBe(0);
  });

  test("a POST batch of 6 is refused the same way", async () => {
    const { app, reads } = appCountingProcedures();
    const body = JSON.stringify(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), {}])));
    const res = await app.request(`/trpc/${Array(6).fill("universe.list").join(",")}?batch=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Batch call exceeds maximum size");
    expect(reads()).toBe(0);
  });

  test("a batch of 5 runs all five", async () => {
    const { app, reads } = appCountingProcedures();
    const res = await app.request(batchUrl(5));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { result: { data: { available: boolean; code: string } } }[];
    expect(out).toHaveLength(5);
    for (const r of out) expect(r.result.data).toMatchObject({ available: false, code: "not_deployed" });
    expect(reads()).toBe(5);
  });

  test("trpcCalls counts the procedures a request names, as tRPC parses them", () => {
    expect(trpcCalls("http://e/trpc/health")).toBe(1);
    expect(trpcCalls("http://e/trpc/health,rule.get?input=%7B%7D")).toBe(1); // not a batch
    expect(trpcCalls("http://e/trpc/health,rule.get,mix.get?batch=1")).toBe(3);
    expect(trpcCalls("http://e/trpc/health%2Crule.get?batch=1")).toBe(2); // tRPC decodes before splitting
    expect(trpcCalls(`http://e/trpc/${Array(50).fill("rule.preview").join(",")}?batch=1`)).toBe(MAX_BATCH_SIZE);
    expect(trpcCalls("http://e/trpc/%E0%A4%A?batch=1")).toBe(MAX_BATCH_SIZE);
  });

  test("the /trpc limiter charges per call: a batch of 5 spends 5 tokens", async () => {
    const app = new Hono();
    app.use("/trpc/*", rateLimit({ burst: 10, windowMs: 60_000, cost: (c) => trpcCalls(c.req.url) }));
    app.get("/trpc/*", (c) => c.text("ok"));
    expect((await app.request(batchUrl(5))).status).toBe(200);
    expect((await app.request(batchUrl(5))).status).toBe(200);
    const third = await app.request(batchUrl(5));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

function limited(opts: RateLimitOptions) {
  const app = new Hono();
  app.use("*", rateLimit({ burst: 3, windowMs: 60_000, ...opts }));
  app.get("/x", (c) => c.text("ok"));
  return app;
}

/** Bun hands Hono the server as env; requestIP is the TCP peer. */
const socket = (address: string) => ({ requestIP: () => ({ address }) });

async function statuses(app: Hono, reqs: { headers?: Record<string, string>; env?: unknown }[]) {
  const out: number[] = [];
  for (const r of reqs) out.push((await app.request("/x", { headers: r.headers ?? {} }, r.env)).status);
  return out;
}

describe("rate limiter: X-Forwarded-For spoofing (B-L4)", () => {
  test("rotating the client-written entries no longer mints a fresh bucket per request", async () => {
    const app = limited({ trustedProxyHops: 1 });
    // What the proxy in front of the service forwards when a client sends its own rotating X-Forwarded-For.
    const reqs = Array.from({ length: 8 }, (_, i) => ({ headers: { "x-forwarded-for": `10.9.${i}.${i}, 203.0.113.7` } }));
    expect(await statuses(app, reqs)).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
  });

  test("distinct real clients still get their own buckets", async () => {
    const app = limited({ trustedProxyHops: 1 });
    const a = Array(3).fill({ headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.7" } });
    const b = Array(3).fill({ headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.4" } });
    expect(await statuses(app, [...a, ...b])).toEqual([200, 200, 200, 200, 200, 200]);
  });

  test("X-Real-IP is client-settable and ignored: the socket address keys the bucket", async () => {
    const app = limited({ trustedProxyHops: 1 });
    const env = socket("198.51.100.1");
    const reqs = Array.from({ length: 4 }, (_, i) => ({ headers: { "x-real-ip": `10.0.0.${i}` }, env }));
    expect(await statuses(app, reqs)).toEqual([200, 200, 200, 429]);
  });

  test("two trusted hops (a CDN in front of the hosting proxy): the client is second from the right", async () => {
    const app = limited({ trustedProxyHops: 2 });
    const reqs = Array.from({ length: 4 }, (_, i) => ({
      headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7, 172.64.0.${i}` },
    }));
    expect(await statuses(app, reqs)).toEqual([200, 200, 200, 429]);
  });

  test("0 trusted hops: the header is ignored entirely (Bun's { server } env shape too)", async () => {
    const app = limited({ trustedProxyHops: 0 });
    const env = { server: socket("198.51.100.2") };
    const reqs = Array.from({ length: 4 }, (_, i) => ({ headers: { "x-forwarded-for": `10.0.0.${i}` }, env }));
    expect(await statuses(app, reqs)).toEqual([200, 200, 200, 429]);
  });

  test("rotating within one IPv6 /64 shares a bucket", async () => {
    const app = limited({ trustedProxyHops: 1 });
    const reqs = ["2001:db8:1:2::1", "2001:db8:1:2:ffff::9", "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::abcd"].map(
      (ip) => ({ headers: { "x-forwarded-for": `9.9.9.9, ${ip}` } }),
    );
    expect(await statuses(app, reqs)).toEqual([200, 200, 200, 429]);
  });

  test("clientAddress picks the entry the outermost trusted proxy wrote", () => {
    expect(clientAddress("spoof, 203.0.113.7", "10.0.0.1", 1)).toBe("203.0.113.7");
    expect(clientAddress(" 203.0.113.7 ", "10.0.0.1", 1)).toBe("203.0.113.7");
    expect(clientAddress("spoof, 203.0.113.7, 172.64.0.1", "10.0.0.1", 2)).toBe("203.0.113.7");
    // Fewer entries than hops: it did not come through the proxies.
    expect(clientAddress("203.0.113.7", "10.0.0.1", 2)).toBe("10.0.0.1");
    expect(clientAddress("spoof, 203.0.113.7", "10.0.0.1", 0)).toBe("10.0.0.1");
    expect(clientAddress(undefined, undefined, 1)).toBe("unknown");
    expect(clientAddress("1.2.3.4, ", "10.0.0.1", 1)).toBe("10.0.0.1");
  });

  test("rateLimitKey: IPv4 as is, mapped IPv4 unwrapped, IPv6 by /64", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("[2001:DB8:1:2:3:4:5:6]")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
    expect(rateLimitKey("unknown")).toBe("unknown");
  });
});

describe("tRPC health: the detail is for HEALTH_TOKEN holders only", () => {
  const TOKEN = "h".repeat(40);
  const DETAIL = ["keeper", "deployment", "database"];
  /** The real app: createContext gets the request's Authorization header (app.ts). */
  const appWith = (healthToken: string | undefined) =>
    createApp((req?: RequestInfo) => makeCtx({ healthToken, authorization: req?.authorization ?? null, keeperAddress: "0x8ba1f109551bD432803012645Ac136ddd64DBA72" }));
  async function health(app: Hono, headers: Record<string, string> = {}) {
    const res = await app.request("/trpc/health", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { data: Record<string, unknown> } }).result.data;
  }

  test("no token, a wrong one, or a token configured nowhere: the public snapshot, no keeper, deployment or database detail", async () => {
    const app = appWith(TOKEN);
    const tries: Record<string, string>[] = [{}, { authorization: `Bearer ${"x".repeat(40)}` }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }];
    for (const headers of tries) {
      const h = await health(app, headers);
      expect(h).toMatchObject({ ok: true, service: "spare-engine", db: "down", redis: "down" });
      for (const k of DETAIL) expect(h).not.toHaveProperty(k);
    }
    const unset = await health(appWith(undefined), { authorization: `Bearer ${TOKEN}` });
    for (const k of DETAIL) expect(unset).not.toHaveProperty(k);
  });

  test("the bearer token gets the detail", async () => {
    const h = await health(appWith(TOKEN), { authorization: `Bearer ${TOKEN}` });
    expect(h.keeper).toEqual({ configured: true, address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", broadcast: false });
    expect(h).toHaveProperty("deployment", null); // nothing deployed in the test book
    expect(h).toHaveProperty("database", null); // database down
  });

  test("GET /health (the hosting platform's healthcheck) never carries the detail", async () => {
    const res = await appWith(TOKEN).request("/health", { headers: { authorization: `Bearer ${TOKEN}` } });
    const h = (await res.json()) as Record<string, unknown>;
    for (const k of DETAIL) expect(h).not.toHaveProperty(k);
  });
});

describe("rule.preview's per-client gate keys on the limiter's own client key", () => {
  test("the tRPC context carries the trusted X-Forwarded-For entry, grouped like the rate limiter (IPv6 by /64)", async () => {
    const seen: string[] = [];
    const app = createApp((req?: RequestInfo) => {
      seen.push(req!.clientKey);
      return makeCtx({});
    });
    const url = `/trpc/universe.list?input=${encodeURIComponent("{}")}`;
    for (const xff of ["10.0.0.1, 203.0.113.7", "10.9.9.9, 203.0.113.7", "1.1.1.1, 2001:db8:1:2::1", "1.1.1.1, 2001:db8:1:2:ffff::9"]) {
      expect((await app.request(url, { headers: { "x-forwarded-for": xff } })).status).toBe(200);
    }
    expect(seen).toEqual(["203.0.113.7", "203.0.113.7", "2001:db8:1:2::/64", "2001:db8:1:2::/64"]);
  });
});

describe("env: preview and proxy limits", () => {
  test("defaults", () => {
    const e = parseEnv({});
    expect(e.TRUSTED_PROXY_HOPS).toBe(1);
    expect(e.LOGS_MAX_RANGE).toBe(2_000_000);
    expect(e.PREVIEW_MAX_CHUNKS).toBe(250);
    expect(e.PREVIEW_MAX_LOGS).toBe(20_000);
    expect(e.PREVIEW_TIMEOUT_MS).toBe(20_000);
    expect(e.PREVIEW_MAX_INFLIGHT).toBe(4);
    expect(e.PREVIEW_MAX_INFLIGHT_PER_CLIENT).toBe(1);
  });
  test("bounds", () => {
    expect(parseEnv({ TRUSTED_PROXY_HOPS: "0" }).TRUSTED_PROXY_HOPS).toBe(0);
    expect(() => parseEnv({ TRUSTED_PROXY_HOPS: "-1" })).toThrow();
    expect(() => parseEnv({ PREVIEW_MAX_INFLIGHT: "0" })).toThrow();
    expect(() => parseEnv({ PREVIEW_MAX_INFLIGHT_PER_CLIENT: "0" })).toThrow();
    expect(() => parseEnv({ PREVIEW_MAX_LOGS: "10" })).toThrow();
    expect(() => parseEnv({ PREVIEW_TIMEOUT_MS: "999999" })).toThrow();
  });
});
