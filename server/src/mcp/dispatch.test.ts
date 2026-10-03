import { describe, it, expect, vi } from "vitest";
import { HttpRequestError } from "viem";

vi.mock("./registry.js", () => {
  const handler = vi.fn(async (p: any) => ({ ok: true, echo: p }));
  return {
    REGISTRY: {
      spare_demo: { name: "spare_demo", free: true, handler },
    },
    __handler: handler,
  };
});

import { executeTool, resolveTool } from "./dispatch.js";

describe("resolveTool", () => {
  it("resolves canonical and bare names", () => {
    expect(resolveTool("spare_demo")?.name).toBe("spare_demo");
    expect(resolveTool("demo")?.name).toBe("spare_demo");
    expect(resolveTool("spare_nope")).toBeNull();
  });

  it("names outside the registry are unknown tools, not aliases", () => {
    for (const old of [
      "legacy_demo",
      "other_demo",
      "spare_demo_v2",
      "spare_unknown_status",
      "spare_unknown_tool",
    ]) {
      expect(resolveTool(old), old).toBeNull();
    }
  });
});

describe("executeTool", () => {
  it("dispatches a known tool (after normalization) with no key", async () => {
    const r = await executeTool("demo", { a: 1 });
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ ok: true, echo: { a: 1 } });
    expect(typeof r.body.latency_ms).toBe("number");
    expect(r.body.tool).toBeUndefined();
    expect(r.body.deprecation).toBeUndefined();
  });
  it("unknown tool -> 400 (including a foreign prefix)", async () => {
    for (const name of ["nope_nope", "legacy_demo", "spare_unknown_status"]) {
      const r = await executeTool(name, {});
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("unknown_tool");
    }
  });
  it("handler throw -> 500 tool_error, no stack", async () => {
    const reg = await import("./registry.js");
    (reg as any).__handler.mockRejectedValueOnce(new Error("boom"));
    const r = await executeTool("spare_demo", {});
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "tool_error", message: "boom" });
  });
  it("a viem RPC error -> one redacted line: no URL, key, request body or upstream reply", async () => {
    const reg = await import("./registry.js");
    const url = "https://robinhood-mainnet.g.alchemy.com/v2/fAkE-kEy-0123456789abcdef";
    const err = new HttpRequestError({ url, status: 401, body: { method: "eth_blockNumber" }, details: "Must be authenticated!" });
    expect(err.message).toContain(`URL: ${url}`);
    (reg as any).__handler.mockRejectedValueOnce(err);
    const r = await executeTool("spare_demo", {});
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "tool_error", message: "HTTP request failed." });
    expect(JSON.stringify(r.body)).not.toMatch(/fAkE-kEy|alchemy|URL:|eth_blockNumber|Must be authenticated/);
  });
  it("input errors (RangeError) -> 400 invalid_params", async () => {
    const reg = await import("./registry.js");
    (reg as any).__handler.mockRejectedValueOnce(new RangeError("roundTo must be 1, 5 or 10"));
    const r = await executeTool("spare_demo", {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_params");
  });
});
