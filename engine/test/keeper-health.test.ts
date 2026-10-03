/**
 * The keeper's public /health reveals liveness only (audit lead: "the keeper
 * /health is public"). The detail needs HEALTH_TOKEN.
 */
import { describe, expect, test } from "bun:test";
import { healthResponse } from "../src/keeper/health.ts";

const TOKEN = "t".repeat(40);
const detail = () => ({
  keeper: "0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03",
  eth: "0.42",
  recent: [{ kind: "sweep", detail: "1 accounts, $20.00", tx: "0xabc" }],
  walletsBackedOff: 2,
});
const get = (path: string, auth?: string) => new Request(`http://keeper.internal${path}`, auth ? { headers: { authorization: auth } } : {});

describe("keeper /health", () => {
  test("public: { ok } and nothing else, 200, not cacheable", async () => {
    const r = healthResponse(get("/health"), { ok: true, token: TOKEN, detail });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("not ok: still 200 for the deploy healthcheck, 503 with ?strict=1, and no reasons leak", async () => {
    const r = healthResponse(get("/health"), { ok: false, detail });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false });
    const s = healthResponse(get("/health?strict=1"), { ok: false, detail });
    expect(s.status).toBe(503);
    expect(await s.json()).toEqual({ ok: false });
  });

  test("the configured bearer token gets the detail", async () => {
    const r = healthResponse(get("/health", `Bearer ${TOKEN}`), { ok: true, token: TOKEN, detail });
    expect(await r.json()).toEqual({ ...detail(), ok: true });
  });

  test("a wrong token, another scheme, or no token configured -> liveness only", async () => {
    for (const [auth, token] of [
      [`Bearer ${TOKEN}x`, TOKEN],
      [`Basic ${TOKEN}`, TOKEN],
      [`Bearer ${TOKEN}`, undefined],
      ["Bearer ", undefined],
    ] as const) {
      const r = healthResponse(get("/health", auth), { ok: true, token, detail });
      expect(await r.json()).toEqual({ ok: true });
    }
  });
});
