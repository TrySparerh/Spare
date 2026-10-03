import { describe, it, expect } from "vitest";
import { normalizeToolName, TOOL_PREFIX } from "./normalize.js";

describe("normalizeToolName", () => {
  it("leaves spare_* unchanged", () => {
    expect(normalizeToolName("spare_roundup_preview")).toBe("spare_roundup_preview");
  });
  it("prefixes a bare name", () => {
    expect(normalizeToolName("roundup_preview")).toBe("spare_roundup_preview");
  });
  it("trims and lowercases", () => {
    expect(normalizeToolName("  Spare_Roundup_Preview ")).toBe("spare_roundup_preview");
  });
  it("has one canonical prefix and no alias namespace", () => {
    expect(TOOL_PREFIX).toBe("spare_");
    // Any other prefix is just part of a bare name, never remapped.
    expect(normalizeToolName("other_roundup_preview")).toBe("spare_other_roundup_preview");
  });
});
