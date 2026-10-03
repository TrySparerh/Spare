import { describe, it, expect, vi } from "vitest";

vi.mock("./registry.js", () => {
  const engine = {
    name: "spare_roundup_preview",
    category: "Spare Engine",
    scope: "read",
    free: true,
    description: "Exact round-up.",
    params: [
      { name: "amountUsd", type: "string", description: "USD", required: true },
      { name: "roundTo", type: "integer", description: "1/5/10", required: false, default: 1 },
    ],
    handler: vi.fn(async (p: any) => {
      if (p.roundTo === 2) throw new RangeError("roundTo must be 1, 5 or 10 (got 2)");
      return { delta: { usd: "0.25" }, big: 10n };
    }),
  };
  const token = {
    name: "spare_token",
    category: "Spare Token",
    scope: "read",
    free: true,
    description: "$SPARE status.",
    params: [],
    handler: vi.fn(async () => ({ launched: false, address: null })),
  };
  return { TOOLS: [engine, token], REGISTRY: { [engine.name]: engine, [token.name]: token } };
});

import { handleRpcBody, handleRpcMessage, MAX_BATCH, parseToolset, RPC, SPARE_MCP_SERVER } from "./server.js";

const call = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("Spare MCP JSON-RPC", () => {
  it("initialize identifies as Spare MCP and negotiates the protocol version", async () => {
    const r: any = await handleRpcMessage(call("initialize", { protocolVersion: "2025-03-26", capabilities: {} }), {});
    expect(r.result.serverInfo.name).toBe("spare-mcp");
    expect(r.result.serverInfo.title).toBe("Spare MCP");
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.instructions).toMatch(/\$SPARE token has NOT launched/);
    const unknown: any = await handleRpcMessage(call("initialize", { protocolVersion: "1999-01-01" }), {});
    expect(unknown.result.protocolVersion).toBe(SPARE_MCP_SERVER.protocolVersions[0]);
  });

  it("notifications get no reply; an all-notification POST returns null (HTTP 202)", async () => {
    expect(await handleRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, {})).toBeNull();
    expect(await handleRpcBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], {})).toBeNull();
  });

  it("tools/list returns JSON-Schema tools with read-only annotations", async () => {
    const r: any = await handleRpcMessage(call("tools/list"), { toolset: "all" });
    const t = r.result.tools.find((x: any) => x.name === "spare_roundup_preview");
    expect(t.inputSchema).toEqual({
      type: "object",
      properties: {
        amountUsd: { type: "string", description: "USD" },
        roundTo: { type: "integer", description: "1/5/10", default: 1 },
      },
      required: ["amountUsd"],
    });
    expect(t.annotations.readOnlyHint).toBe(true);
    expect(t.description).toContain("[Spare Engine]");
  });

  it("tools/list advertises the Spare engine tools by default; toolset=all adds spare_token", async () => {
    const d: any = await handleRpcMessage(call("tools/list"), {});
    expect(d.result.tools.map((t: any) => t.name)).toEqual(["spare_roundup_preview"]);
    const all: any = await handleRpcMessage(call("tools/list"), { toolset: "all" });
    expect(all.result.tools.map((t: any) => t.name)).toEqual(["spare_roundup_preview", "spare_token"]);
    expect(parseToolset("ALL")).toBe("all");
    expect(parseToolset(undefined)).toBe("spare");
  });

  it("tools/call returns text + structuredContent (bigints serialised)", async () => {
    const r: any = await handleRpcMessage(call("tools/call", { name: "spare_roundup_preview", arguments: { amountUsd: "3.75" } }), {});
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent).toEqual({ delta: { usd: "0.25" }, big: "10" });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ delta: { usd: "0.25" }, big: "10" });
  });

  it("prefixed names outside the registry are unknown tools (-32602), not aliases", async () => {
    const r: any = await handleRpcMessage(call("tools/call", { name: "legacy_roundup_preview", arguments: { amountUsd: "1" } }), {});
    expect(r.error.code).toBe(RPC.INVALID_PARAMS);
    const bare: any = await handleRpcMessage(call("tools/call", { name: "roundup_preview", arguments: { amountUsd: "1" } }), {});
    expect(bare.result.isError).toBe(false);
    expect(bare.result.content[0].text).not.toMatch(/deprecat/i);
  });

  it("tool input errors come back as isError results, unknown tools as -32602", async () => {
    const bad: any = await handleRpcMessage(call("tools/call", { name: "spare_roundup_preview", arguments: { amountUsd: "1", roundTo: 2 } }), {});
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/invalid_params/);
    const unknown: any = await handleRpcMessage(call("tools/call", { name: "spare_nope" }), {});
    expect(unknown.error.code).toBe(RPC.INVALID_PARAMS);
  });

  it("every tool is callable with no key, and a tool outside the registry is unknown", async () => {
    const token: any = await handleRpcMessage(call("tools/call", { name: "spare_token" }), {});
    expect(token.result.structuredContent).toEqual({ launched: false, address: null });
    const gone: any = await handleRpcMessage(call("tools/call", { name: "spare_unknown_tool" }), {});
    expect(gone.error.code).toBe(RPC.INVALID_PARAMS);
  });

  it("batches, ping, unknown methods and malformed messages", async () => {
    const out: any = await handleRpcBody([call("ping", {}, 1), call("nope/nope", {}, 2)], {});
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: RPC.METHOD_NOT_FOUND, message: "Method not found: nope/nope" } },
    ]);
    expect(((await handleRpcBody("x", {})) as any).error.code).toBe(RPC.PARSE_ERROR);
    expect(((await handleRpcBody([], {})) as any).error.code).toBe(RPC.INVALID_REQUEST);
    expect(((await handleRpcMessage({ id: 3, method: "ping" }, {})) as any).error.code).toBe(RPC.INVALID_REQUEST);
  });

  it(`a batch holds at most ${MAX_BATCH} messages; a bigger one runs nothing`, async () => {
    const ok: any = await handleRpcBody(Array.from({ length: MAX_BATCH }, (_, i) => call("ping", {}, i)), {});
    expect(ok).toHaveLength(MAX_BATCH);
    const reg: any = await import("./registry.js");
    const handler = reg.REGISTRY.spare_roundup_preview.handler;
    handler.mockClear();
    const tooBig: any = await handleRpcBody(
      Array.from({ length: MAX_BATCH + 1 }, (_, i) => call("tools/call", { name: "spare_roundup_preview", arguments: { amountUsd: "1" } }, i)),
      {},
    );
    expect(tooBig.error.code).toBe(RPC.INVALID_REQUEST);
    expect(tooBig.error.message).toMatch(/at most 10/);
    expect(handler).not.toHaveBeenCalled();
  });
});
