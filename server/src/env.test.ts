import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, afterEach } from "vitest";

/** Every non-test source file of the API. */
function sources(): Array<{ file: string; text: string }> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".ts") && !d.name.endsWith(".test.ts")) out.push({ file: p, text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

describe("env schema", () => {
  describe("NODE_ENV", () => {
    const saved = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = saved;
      vi.resetModules();
    });

    it("defaults to production when unset or empty", async () => {
      for (const v of [undefined, ""]) {
        if (v === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = v;
        vi.resetModules();
        const { env } = await import("./env.js");
        expect(env.NODE_ENV).toBe("production");
      }
    });
  });

  describe("signing keys", () => {
    afterEach(() => {
      delete process.env.KEEPER_PK;
      delete process.env.DEPLOYER_PK;
      vi.resetModules();
    });

    it("the API never reads a private key: the keeper address comes from the address book", async () => {
      process.env.KEEPER_PK = "0x" + "11".repeat(32);
      process.env.DEPLOYER_PK = "0x" + "22".repeat(32);
      vi.resetModules();
      const { env } = await import("./env.js");
      expect(env).not.toHaveProperty("KEEPER_PK");
      expect(env).not.toHaveProperty("DEPLOYER_PK");
      for (const { file, text } of sources()) {
        expect(text, file).not.toMatch(/KEEPER_PK|DEPLOYER_PK|PRIVATE_KEY|privateKeyToAccount|mnemonicToAccount|signTransaction|sendTransaction|writeContract/);
      }
    });
  });
});
