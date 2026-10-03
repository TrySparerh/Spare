/**
 * The keeper as the API and its workers see it: a public address, never a key.
 *
 * Accruals and sweeps are sent by the keeper service alone (src/keeper/, `bun
 * run keeper`), which loads its own KEEPER_PK. This process only shows the
 * keeper's address (KEEPER_ADDRESS) and reads whether it is registered on
 * SweepExecutor and CashPark, so it holds nothing that can sign.
 */
import type { Address } from "viem";
import { env } from "../env.ts";

export function keeperAddress(): Address | null {
  return env.KEEPER_ADDRESS ?? null;
}

/** The keeper service's own KEEPER_BROADCAST, as configured here for the health report. */
export function broadcastEnabled(): boolean {
  return env.KEEPER_BROADCAST === "1";
}
