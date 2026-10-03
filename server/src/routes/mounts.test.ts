/**
 * The API mounts exactly the Spare path families below, with no alias or
 * Deprecation/Link plumbing. This reads the route table from app.ts source;
 * app.test.ts exercises the same table over HTTP.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../app.ts", import.meta.url)), "utf8");
const mounted = [...src.matchAll(/app\.(?:use|get|post)\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);

describe("mounted paths", () => {
  it("are exactly the Spare path families", () => {
    expect([...new Set(mounted)].sort()).toEqual(
      ["/", "/health", "/api/spare/token/holders", "/api/spare/token", "/api/spare", "/mcp", "/api/mcp"].sort(),
    );
  });

  it("set no Deprecation or Link successor headers", () => {
    expect(src).not.toMatch(/Deprecation|successor-version/);
  });
});
