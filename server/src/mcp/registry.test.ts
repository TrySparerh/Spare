import { describe, it, expect } from "vitest";
import { REGISTRY, TOOLS, buildCatalog } from "./registry.js";

const ENGINE = [
  "spare_universe",
  "spare_account",
  "spare_roundup_preview",
  "spare_quote",
  "spare_activity",
  "spare_contracts",
  "spare_fees",
];

describe("registry", () => {
  it("buildCatalog returns well-formed entries with no handlers leaked", () => {
    const cat = buildCatalog();
    expect(cat.total).toBe(cat.tools.length);
    for (const t of cat.tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.startsWith("spare_")).toBe(true);
      expect(typeof t.category).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(Array.isArray(t.params)).toBe(true);
      expect((t as any).handler).toBeUndefined();
    }
  });

  it("tool names are unique and the catalog is branded Spare MCP", () => {
    const cat = buildCatalog();
    const names = cat.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(cat.server.title).toBe("Spare MCP");
    expect(cat.server.name).toBe("spare-mcp");
    expect(cat.prefix).toBe("spare_");
    expect(cat).not.toHaveProperty("aliases");
  });

  it("is exactly the seven Spare engine tools plus spare_token: no multi-provider gateway", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([...ENGINE, "spare_token"]);
    expect(Object.keys(REGISTRY).sort()).toEqual([...ENGINE, "spare_token"].sort());
    const all = buildCatalog("all");
    expect(all.total).toBe(8);
    expect(all.toolsets).toEqual({ spare: 7, all: 8 });
    for (const t of TOOLS) {
      expect(t.free, t.name).toBe(true);
      expect(t.scope, t.name).toBe("read");
    }
  });

  it("registers the free, read-only Spare engine tools first", () => {
    const cat = buildCatalog();
    expect(cat.tools.slice(0, ENGINE.length).map((t) => t.name)).toEqual(ENGINE);
    const spareOnly = buildCatalog("spare");
    // The seven tools the site and the docs list.
    expect(spareOnly.tools.map((t) => t.name)).toEqual(ENGINE);
    expect(spareOnly.toolset).toBe("spare");
    // spare_token: free and callable, listed only with toolset=all.
    expect(cat.tools.map((t) => t.name)).toContain("spare_token");
    expect(spareOnly.tools.map((t) => t.name)).not.toContain("spare_token");
    expect(spareOnly.tools[1].inputSchema.required).toEqual(["address"]);
    for (const n of ENGINE) expect(REGISTRY[n].category).toBe("Spare Engine");
  });

  it("spare_roundup_preview runs the RoundUp.sol math with no chain access", async () => {
    const out = (await REGISTRY["spare_roundup_preview"].handler({ amountUsd: "3.75", roundTo: 1, multiplier: 3 })) as any;
    expect(out.delta.usd).toBe("0.75");
    expect(out.delta1x.usd).toBe("0.25");
    const list = (await REGISTRY["spare_roundup_preview"].handler({ amounts: "[3.75, 12.40]", roundTo: 1 })) as any;
    expect(list.mode).toBe("amounts");
    expect(list.rows.map((r: any) => r.roundUp)).toEqual(["0.25", "0.6"]);
    expect(list.excluded).toEqual([]);
  });

  it("spare_token reports $SPARE as not launched, with no address", async () => {
    const out = (await REGISTRY["spare_token"].handler({})) as any;
    expect(out.launched).toBe(false);
    expect(out.address).toBeNull();
  });
});
