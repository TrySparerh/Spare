/**
 * Hooked-pool pins (audit A-L3): the verdict on what the keeper read from a
 * FablesBaseHook, HOOK_PINS parsing, and the built-in pins against the
 * contracts' own config (contracts/config/4663.json), so the keeper and the
 * deploy scripts can never pin different pools, code or authority.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { loadConfig } from "../../src/keeper/config.ts";
import { DEFAULT_HOOK_PINS, hookVerdict, parseHookPins, type HookPin, type HookRead } from "../../src/keeper/hooks.ts";
import { TEST_PK } from "../helpers/fake-rpc-spare.ts";

const MU = DEFAULT_HOOK_PINS[0]!;
const ok: HookRead = { codehash: MU.hookCodehash, authority: MU.hookAuthority, maxFee: 50_000, currentFee: 3_000 };
const pool = { hook: MU.hook, poolId: MU.poolId };

describe("hookVerdict", () => {
  test("on its pin: the hook's fee is the swap's LP fee (the ceiling itself included)", () => {
    expect(hookVerdict(MU, pool, ok)).toEqual({ feePips: 3_000 });
    expect(hookVerdict(MU, pool, { ...ok, currentFee: 4_000 })).toEqual({ feePips: 4_000 });
    expect(hookVerdict(MU, { hook: MU.hook.toLowerCase() as Address, poolId: MU.poolId.toUpperCase().replace("0X", "0x") as Hex }, ok)).toEqual({ feePips: 3_000 });
  });

  test("off its pin, or unread: held, with why", () => {
    const held = (pin: HookPin | undefined, read: Partial<HookRead>, p = pool) => (hookVerdict(pin, p, { ...ok, ...read }) as { held: string }).held;
    expect(held(undefined, {})).toBe(`hooked pool (hook ${MU.hook}) has no pin (HOOK_PINS)`);
    expect(held(MU, {}, { ...pool, hook: DEFAULT_HOOK_PINS[1]!.hook })).toBe(`pool ${MU.poolId} on hook ${DEFAULT_HOOK_PINS[1]!.hook} is not the pinned MU pool`);
    for (const k of ["codehash", "authority", "maxFee", "currentFee"] as const) expect(held(MU, { [k]: null })).toBe("hook state unreadable");
    expect(held(MU, { codehash: `0x${"00".repeat(32)}` })).toBe(`hook code 0x${"00".repeat(32)} is not the pinned build`);
    expect(held(MU, { authority: "0x0000000000000000000000000000000000000bad" })).toBe(
      `hook authority 0x0000000000000000000000000000000000000bad is not the pinned ${MU.hookAuthority}`,
    );
    expect(held(MU, { maxFee: 50_001 })).toBe("hook fee cap 50001 pips is above the pinned 50000");
    expect(held(MU, { currentFee: 4_001 })).toBe("hook fee 4001 pips is above the keeper's 4000");
    expect(held(MU, { maxFee: 0 })).toBe("hook reports the pool unconfigured");
    expect(held(MU, { currentFee: 0 })).toBe("hook reports the pool unconfigured");
    // A cap lowered under the pin is no risk: still swept.
    expect(hookVerdict(MU, pool, { ...ok, maxFee: 20_000 })).toEqual({ feePips: 3_000 });
  });
});

describe("HOOK_PINS", () => {
  test("defaults to the built-in pins; a JSON array replaces them, checksummed and lower-cased hashes", () => {
    expect(loadConfig({ KEEPER_PK: TEST_PK }).HOOK_PINS).toEqual([...DEFAULT_HOOK_PINS]);
    const raised = { ...MU, token: MU.token.toLowerCase(), poolId: MU.poolId.toUpperCase().replace("0X", "0x"), hookMaxFeePips: 10_000 };
    expect(loadConfig({ KEEPER_PK: TEST_PK, HOOK_PINS: JSON.stringify([raised]) }).HOOK_PINS).toEqual([{ ...MU, hookMaxFeePips: 10_000 }]);
    expect(loadConfig({ KEEPER_PK: TEST_PK, HOOK_PINS: "[]" }).HOOK_PINS).toEqual([]);
  });

  test("refuses anything malformed rather than running unpinned", () => {
    const bad: [string, RegExp][] = [
      ["not json", /HOOK_PINS: HOOK_PINS must be a JSON array of hook pins/],
      [JSON.stringify({ ...MU }), /HOOK_PINS/],
      [JSON.stringify([{ ...MU, hook: "0x1234" }]), /must be a 0x address/],
      [JSON.stringify([{ ...MU, hookCodehash: "0x1234" }]), /must be 0x \+ 64 hex chars/],
      [JSON.stringify([{ ...MU, hookMaxFeePips: 1_000_001 }]), /HOOK_PINS/],
      [JSON.stringify([{ ...MU, hookMaxFeePips: 1.5 }]), /HOOK_PINS/],
      [JSON.stringify([MU, { ...MU, symbol: "MU2" }]), /pins 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD twice/],
    ];
    for (const [json, why] of bad) expect(() => loadConfig({ KEEPER_PK: TEST_PK, HOOK_PINS: json })).toThrow(why);
    expect(() => parseHookPins("[{}]")).toThrow();
  });
});

// Skipped where contracts/ is not beside engine/ (an engine-only checkout or image build).
const CONFIG_4663 = resolve(import.meta.dir, "../../../contracts/config/4663.json");

describe.skipIf(!existsSync(CONFIG_4663))("the built-in pins match the contracts' config", () => {
  type Asset = { symbol: string; token: string; active: boolean; poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string } } & Record<string, unknown>;
  const config = (existsSync(CONFIG_4663) ? JSON.parse(readFileSync(CONFIG_4663, "utf8")) : { assets: [] }) as { assets: Asset[] };
  const hooked = config.assets.filter((a) => BigInt(a.poolKey.hooks) !== 0n);
  const poolIdOf = (k: Asset["poolKey"]) =>
    keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0 as Address, k.currency1 as Address, k.fee, k.tickSpacing, k.hooks as Address]));

  test("every hooked asset in the config has exactly one pin, for the same hook and PoolId; no pin for anything else", () => {
    expect(hooked.length).toBeGreaterThan(0);
    expect(DEFAULT_HOOK_PINS.map((p) => p.token).sort()).toEqual(hooked.map((a) => getAddress(a.token)).sort());
    for (const a of hooked) {
      const pin = DEFAULT_HOOK_PINS.find((p) => p.token === getAddress(a.token))!;
      expect({ symbol: pin.symbol, hook: pin.hook, poolId: pin.poolId }).toEqual({ symbol: a.symbol, hook: getAddress(a.poolKey.hooks), poolId: poolIdOf(a.poolKey) });
      expect(pin.hookMaxFeePips).toBeLessThanOrEqual(pin.hookFeeCap);
    }
  });

  test("the config's own hookCodehash / hookAuthority / hookMaxFeePips (and hookFeeCap), where recorded, are the keeper's", () => {
    for (const a of hooked) {
      const pin = DEFAULT_HOOK_PINS.find((p) => p.token === getAddress(a.token))!;
      const recorded = { symbol: a.symbol } as Record<string, unknown>;
      const keeper = { symbol: pin.symbol } as Record<string, unknown>;
      if (typeof a.hookCodehash === "string") [recorded.hookCodehash, keeper.hookCodehash] = [a.hookCodehash.toLowerCase(), pin.hookCodehash];
      if (typeof a.hookAuthority === "string") [recorded.hookAuthority, keeper.hookAuthority] = [getAddress(a.hookAuthority), pin.hookAuthority];
      if (a.hookMaxFeePips !== undefined) [recorded.hookMaxFeePips, keeper.hookMaxFeePips] = [Number(a.hookMaxFeePips), pin.hookMaxFeePips];
      if (a.hookFeeCap !== undefined) [recorded.hookFeeCap, keeper.hookFeeCap] = [Number(a.hookFeeCap), pin.hookFeeCap];
      expect(recorded).toEqual(keeper);
    }
  });
});
