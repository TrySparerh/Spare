/**
 * Hooked pools (audit A-L3). Two active assets swap through third-party
 * dynamic-fee hooks: MU via FablesRWA, GME via FablesRamp. Both inherit
 * FablesBaseHook (Sourcify-verified, not proxies, permissions beforeInitialize
 * + beforeSwap only, so no return-delta flags): the hook cannot touch a swap's
 * amounts, but it sets the LP fee of every swap.
 *
 * How that fee is set (FablesBaseHook, verified source): beforeSwap returns
 * `_resolveFee(poolId, params) | OVERRIDE_FEE_FLAG`, so the PoolKey fee is the
 * dynamic flag and StateView's slot0.lpFee stays 0. `_resolveFee` is the
 * hook's autonomous fee (FablesRWA: a market-session schedule from
 * `setPoolConfig`, with an opening descent and a closing ramp; FablesRamp: the
 * pool's flat fee), plus a directional premium (`setPoolAsymmetry`), replaced
 * by a live operator poke (`pokeFee`, TTL up to 72 h), clamped to the pool's
 * cap `maxFee(poolId)`. An OpenZeppelin AccessManager (`authority()`) gates
 * every one of those setters; the caps are 5% (MU) and 2% (GME), under the
 * hooks' ABSOLUTE_MAX_FEE of 5%.
 *
 * The real fee the keeper's swap pays is `currentFee(poolId, zeroForOne)`:
 * the same resolver with a zero-amount probe, which these hooks do not size.
 * The keeper reads it in place of slot0.lpFee and holds the asset (fail
 * closed) when the pool is not pinned here, when the hook's code, authority or
 * fee cap is not the pinned one, when the fee is above the pin's ceiling, or
 * when any of it cannot be read. The monitor alerts on every fee-setting
 * event for the pinned pools (monitor/watch.ts).
 */
import { getAddress, isAddress, isHex, parseAbi, type Address, type Hex } from "viem";
import { z } from "zod";

export interface HookPin {
  symbol: string;
  /** The registry asset whose pinned PoolKey names this hook. */
  token: Address;
  hook: Address;
  /** v4 PoolId of the asset's pinned PoolKey (hook included). */
  poolId: Hex;
  /** keccak256 of the hook's runtime code (the verified build). */
  hookCodehash: Hex;
  /** The AccessManager that gates the hook's fee setters. */
  hookAuthority: Address;
  /** The pool's fee cap, `maxFee(poolId)`, in pips: a cap raised above it holds the asset. */
  hookFeeCap: number;
  /** The most the pool may charge the keeper's swap direction now (`currentFee`), in pips; above it the asset is held. */
  hookMaxFeePips: number;
}

/**
 * Read on 4663 at block ~78.50M (2026-10-02, cast, read-only). Each ceiling
 * (hookMaxFeePips) is the most the pool's own published config charges in the
 * hours the keeper buys, so only an operator change or the opening spike
 * holds it:
 *   MU  FablesRWA floorConfig (3000, 2000, 1000, 5, 12000, 1800, 4000, 1800, 1800):
 *       open 0.30%, overnight 0.20%, closed 0.10%, closing ramp to 0.40%; the
 *       open descends from 1.0% (1.2% after a closure) over 30 minutes, held
 *       above 0.40%. currentFee was 4000 at the 16:00 ET bell. Ceiling 4000.
 *   GME FablesRamp flatFee 500 (0.05%), pokeFloor 300, no live poke, no
 *       premium. Ceiling 500: any poke above the flat fee holds it.
 * Caps: maxFee 50000 (MU) and 20000 (GME). Authority 0xA362…4f30 on both.
 * hookCodehash, hookAuthority and hookMaxFeePips are the names (and values)
 * contracts/config/4663.json records for the deploy scripts; the keeper's own
 * test (test/keeper/hooks.test.ts) fails if the two ever differ.
 */
export const DEFAULT_HOOK_PINS: readonly HookPin[] = [
  {
    symbol: "MU",
    token: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
    hook: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080",
    poolId: "0x8e36bc9877b9383ae306dd937d40ab0e9df65811e7fdfb6bad25e7102bc398b2",
    hookCodehash: "0x577978ad29223268205cb40a5215c46839f5c27a1218beac7d4a0f7cd0aaa341",
    hookAuthority: "0xA362D98B33A7bb5B5E2180a05f995A70FB404f30",
    hookFeeCap: 50_000,
    hookMaxFeePips: 4_000,
  },
  {
    symbol: "GME",
    token: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
    hook: "0x08E52564Bad99E05a694b4809F397edcA417A080",
    poolId: "0xbb15d6b62c893a86912b5d4b14599f9cc72111e5898327dcadefa0352f20ae11",
    hookCodehash: "0xbb52b2dc4a14fc6c3f90d0a268b51680d7adbdaa392b211bc524b6fd9368bb85",
    hookAuthority: "0xA362D98B33A7bb5B5E2180a05f995A70FB404f30",
    hookFeeCap: 20_000,
    hookMaxFeePips: 500,
  },
];

/** The FablesBaseHook reads the keeper needs (verified source). */
export const fablesHookAbi = parseAbi([
  "function currentFee(bytes32 poolId, bool zeroForOne) view returns (uint24)",
  "function maxFee(bytes32 poolId) view returns (uint24)",
  "function authority() view returns (address)",
]);

/** v4 LPFeeLibrary.MAX_LP_FEE: no hook fee or cap can be above 100%. */
const MAX_LP_FEE = 1_000_000;

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
const bytes32 = z
  .string()
  .refine((v) => isHex(v) && v.length === 66, "must be 0x + 64 hex chars")
  .transform((v) => v.toLowerCase() as Hex);
const pips = z.number().int().min(0).max(MAX_LP_FEE);

const PinSchema = z.object({
  symbol: z.string().min(1).max(16),
  token: address,
  hook: address,
  poolId: bytes32,
  hookCodehash: bytes32,
  hookAuthority: address,
  hookFeeCap: pips,
  hookMaxFeePips: pips,
});

/** HOOK_PINS (keeper and monitor config): a JSON array of pins replacing the table above, e.g. after an operator re-configures a pool. */
export function parseHookPins(json: string): HookPin[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("HOOK_PINS must be a JSON array of hook pins");
  }
  const pins = z.array(PinSchema).parse(raw);
  const seen = new Set<string>();
  for (const p of pins) {
    const k = p.token.toLowerCase();
    if (seen.has(k)) throw new Error(`HOOK_PINS pins ${p.token} twice`);
    seen.add(k);
  }
  return pins;
}

/** The HOOK_PINS setting: unset, the built-in pins; set, the JSON array that replaces them (refused if malformed). */
export function hookPinsSetting() {
  return z
    .string()
    .optional()
    .transform((s, ctx): HookPin[] => {
      if (s === undefined) return DEFAULT_HOOK_PINS.map((p) => ({ ...p }));
      try {
        return parseHookPins(s);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `HOOK_PINS: ${(err as Error).message}` });
        return z.NEVER;
      }
    });
}

/** Whether the keeper's swap on `token`'s pool is zeroForOne: it sells USDG, the lower address is currency0. */
export function keeperSwapsZeroForOne(token: Address, usdg: Address): boolean {
  return BigInt(usdg) < BigInt(token);
}

/** What the keeper read about a hooked pool at one block; null for a read that failed. */
export interface HookRead {
  codehash: Hex | null;
  authority: Address | null;
  maxFee: number | null;
  currentFee: number | null;
}

/**
 * Whether a hooked pool may be used, and its fee: the swap's LP fee (pips)
 * or why the asset is held. Fails closed: no pin, a pin for another hook or
 * pool, any unread value, or any value off its pin is a hold.
 */
export function hookVerdict(pin: HookPin | undefined, pool: { hook: Address; poolId: Hex }, read: HookRead): { feePips: number } | { held: string } {
  if (!pin) return { held: `hooked pool (hook ${pool.hook}) has no pin (HOOK_PINS)` };
  if (pin.hook.toLowerCase() !== pool.hook.toLowerCase() || pin.poolId.toLowerCase() !== pool.poolId.toLowerCase()) {
    return { held: `pool ${pool.poolId} on hook ${pool.hook} is not the pinned ${pin.symbol} pool` };
  }
  const { codehash, authority, maxFee, currentFee } = read;
  if (codehash === null || authority === null || maxFee === null || currentFee === null) return { held: "hook state unreadable" };
  if (codehash.toLowerCase() !== pin.hookCodehash.toLowerCase()) return { held: `hook code ${codehash} is not the pinned build` };
  if (authority.toLowerCase() !== pin.hookAuthority.toLowerCase()) return { held: `hook authority ${authority} is not the pinned ${pin.hookAuthority}` };
  if (maxFee === 0 || currentFee === 0) return { held: "hook reports the pool unconfigured" };
  if (maxFee > pin.hookFeeCap) return { held: `hook fee cap ${maxFee} pips is above the pinned ${pin.hookFeeCap}` };
  if (currentFee > pin.hookMaxFeePips) return { held: `hook fee ${currentFee} pips is above the keeper's ${pin.hookMaxFeePips}` };
  return { feePips: currentFee };
}
