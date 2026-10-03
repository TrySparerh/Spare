/**
 * Tool-argument helpers shared by the tool handlers (tools.ts) and the read
 * budget (budget.ts), so the price of a call is decided from exactly the
 * argument the handler will act on.
 */

/** The first of `keys` with a value; undefined, null and '' count as absent. */
export function pick(p: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
  return undefined;
}

/** spare_roundup_preview replays a wallet's real payments when one of these is given (first present wins). */
export const REPLAY_WALLET_KEYS = ['wallet', 'address', 'account'] as const;
