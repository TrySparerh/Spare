/**
 * OracleGuard.Status (contracts/src/libraries/OracleGuard.sol), in enum order.
 *
 *   OK              price usable
 *   STALE           feed older than heartbeat + 1h grace      -> DEFER (weekend case)
 *   PAUSED          token paused() or oraclePaused()          -> DEFER
 *   SEQUENCER_DOWN  L2 uptime feed down / in grace            -> DEFER
 *   BAD_ANSWER      answer <= 0, updatedAt 0 / future, revert -> SAFE-SETTLE
 *
 * Deferral keeps the value parked and retries next epoch; it must never turn a
 * user's stock buy into USDG. Safe-settle pays that leg out as USDG.
 */
export const ORACLE_STATUS = ["OK", "STALE", "PAUSED", "SEQUENCER_DOWN", "BAD_ANSWER"] as const;
export type OracleStatusName = (typeof ORACLE_STATUS)[number];

export function oracleStatusName(code: number): OracleStatusName | "UNKNOWN" {
  return ORACLE_STATUS[code] ?? "UNKNOWN";
}

/** Mirrors OracleGuard.isDeferrable. */
export function isDeferrable(code: number): boolean {
  return code === 1 || code === 2 || code === 3;
}

/** OracleGuard.STALENESS_GRACE. */
export const STALENESS_GRACE = 3_600n;

/**
 * TypeScript mirror of OracleGuard.check (sequencer check omitted: RHC
 * publishes no uptime feed and the router's is address(0)). Used ONLY where
 * no on-chain StockRouter exists to ask (pre-deploy), and labelled as such.
 */
export function mirrorOracleGuard(x: {
  answer: bigint;
  updatedAt: bigint;
  heartbeat: bigint;
  now: bigint;
  paused: boolean | null;
  oraclePaused: boolean | null;
}): number {
  if (x.paused === true || x.oraclePaused === true) return 2; // PAUSED
  if (x.answer <= 0n || x.updatedAt === 0n) return 4; // BAD_ANSWER
  if (x.updatedAt > x.now) return 4;
  if (x.now - x.updatedAt > x.heartbeat + STALENESS_GRACE) return 1; // STALE
  return 0;
}

/** What a sweep would do with a leg whose oracle reports `code`. */
export function legOutcome(code: number, active: boolean): "swap" | "defer" | "safe-settle" {
  if (!active) return "safe-settle";
  if (code === 0) return "swap";
  return isDeferrable(code) ? "defer" : "safe-settle";
}
