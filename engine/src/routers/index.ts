import { router } from "../trpc.ts";
import { healthProcedure } from "./health.ts";
import { linkRouter } from "./link.ts";
import { ruleRouter } from "./rule.ts";
import { mixRouter } from "./mix.ts";
import { accrualRouter } from "./accrual.ts";
import { sweepRouter } from "./sweep.ts";
import { parkRouter } from "./park.ts";
import { universeRouter } from "./universe.ts";
import { oracleRouter } from "./oracle.ts";

/**
 * READ-ONLY API for the SPARE desktop apps. Users write to the contracts
 * directly from their own wallets (setRule, linkSelf/linkWallet/unlink,
 * setMix, Permit2 approve, CashPark.exit); nothing here signs or sends.
 *
 * Every procedure resolves to `{ available: true, ... }` built from chain
 * reads or database rows, or `{ available: false, code, reason }`. Amounts are
 * `{ raw, decimals, display }` (base-unit strings; never floats).
 */
export const appRouter = router({
  health: healthProcedure,
  link: linkRouter,
  rule: ruleRouter,
  mix: mixRouter,
  accrual: accrualRouter,
  sweep: sweepRouter,
  park: parkRouter,
  universe: universeRouter,
  oracle: oracleRouter,
});

export type AppRouter = typeof appRouter;
