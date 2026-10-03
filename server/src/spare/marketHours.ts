/**
 * US-equity market hours, exactly as the keeper applies them.
 *
 * `easternOffsetSeconds`, `equitySessionOpenedAt` and `equityMarketOpen` are
 * copied operation for operation from engine/src/keeper/plan.ts, and
 * marketHours.test.ts runs the engine's own cases against them. The keeper
 * (engine/src/keeper/keeper.ts) buys an equity leg only when OracleGuard says
 * OK AND `equityMarketOpen(blockTimestamp, feed.updatedAt)` holds; otherwise
 * the leg WAITS, and because a sweep is all-or-nothing per account, the whole
 * account waits.
 *
 * Why the API needs this: OracleGuard only calls a feed STALE after
 * heartbeat + 1 h (~25 h for these daily feeds), so a frozen Friday close
 * still reads status OK well into Saturday. Labelling that price "LIVE", or
 * saying a sweep "would buy", contradicts what the keeper will actually do.
 */

/** Session every Spare stock token trades on (engine/src/chain/constants.ts FEEDS[].hours). */
export const EQUITY_SESSION = 'us_equities_24_5' as const;

/**
 * The keeper's MARKET_HOURS_GATE (engine/src/keeper/config.ts, default "1").
 * The API cannot read the keeper's env; set SPARE_MARKET_HOURS_GATE=0 here
 * only if the keeper service runs with MARKET_HOURS_GATE=0.
 */
export function keeperMarketHoursGate(): boolean {
  return (process.env.SPARE_MARKET_HOURS_GATE ?? '1').trim() !== '0';
}

/**
 * UTC offset of US Eastern time at `tsSec`: EDT (-4h) from the second Sunday
 * of March 07:00 UTC to the first Sunday of November 06:00 UTC, else EST (-5h).
 */
export function easternOffsetSeconds(tsSec: number): number {
  const year = new Date(tsSec * 1000).getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(year, 2, nthSunday(2, 2), 7) / 1000;
  const end = Date.UTC(year, 10, nthSunday(10, 1), 6) / 1000;
  return tsSec >= start && tsSec < end ? -4 * 3600 : -5 * 3600;
}

/**
 * The 24/5 tokenized-equity session runs Sunday 20:00 ET to Friday 20:00 ET.
 * Returns the UTC second the CURRENT session opened, or null when closed.
 */
export function equitySessionOpenedAt(tsSec: number): number | null {
  const off = easternOffsetSeconds(tsSec);
  const local = tsSec + off;
  const day = Math.floor(local / 86_400);
  const dow = (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  const secOfDay = local - day * 86_400;
  const OPEN = 20 * 3600;
  const open = (dow === 0 && secOfDay >= OPEN) || (dow >= 1 && dow <= 4) || (dow === 5 && secOfDay < OPEN);
  if (!open) return null;
  return (day - dow) * 86_400 + OPEN - off;
}

/**
 * The keeper sweeps an equity leg only while its session is open AND its feed
 * has published since the session opened (a holiday Monday has no post).
 */
export function equityMarketOpen(tsSec: number, feedUpdatedAt: number, graceSec = 3_600): boolean {
  const opened = equitySessionOpenedAt(tsSec);
  return opened !== null && feedUpdatedAt >= opened - graceSec;
}

export interface MarketView {
  session: typeof EQUITY_SESSION;
  /** Whether the keeper's market-hours gate is on (it is by default). */
  gate: boolean;
  /** True when the keeper would buy this asset now as far as market hours go. */
  open: boolean;
  /** ISO time the current session opened; null while the session is closed. */
  sessionOpenedAt: string | null;
  /** Session open, but the feed has not posted since the open (e.g. a holiday). */
  awaitingFirstPrint: boolean;
  /** Why the keeper waits, or null when `open`. */
  reason: string | null;
}

const isoSec = (s: number) => new Date(s * 1000).toISOString();

/**
 * Market-hours view for one equity feed at a block timestamp. `feedUpdatedAt`
 * is the feed's latestRoundData().updatedAt (0 / null when unread: then the
 * gate treats the feed as not having posted since the open, like the keeper).
 */
export function marketView(blockTsSec: number, feedUpdatedAt: number | null, gate: boolean = keeperMarketHoursGate()): MarketView {
  const opened = equitySessionOpenedAt(blockTsSec);
  const sessionOpenedAt = opened === null ? null : isoSec(opened);
  if (!gate) {
    return { session: EQUITY_SESSION, gate, open: true, sessionOpenedAt, awaitingFirstPrint: false, reason: null };
  }
  const open = equityMarketOpen(blockTsSec, feedUpdatedAt ?? 0);
  const awaitingFirstPrint = opened !== null && !open;
  return {
    session: EQUITY_SESSION,
    gate,
    open,
    sessionOpenedAt,
    awaitingFirstPrint,
    reason: open
      ? null
      : opened === null
        ? 'market closed (keeper market-hours gate): the US-equities 24/5 session runs Sunday 20:00 to Friday 20:00 ET'
        : 'market closed (keeper market-hours gate): no Chainlink update since the session opened',
  };
}

/** Session state alone (no feed), for /health and summaries. */
export function sessionView(blockTsSec: number, gate: boolean = keeperMarketHoursGate()) {
  const opened = equitySessionOpenedAt(blockTsSec);
  return {
    session: EQUITY_SESSION,
    gate,
    sessionOpen: opened !== null,
    sessionOpenedAt: opened === null ? null : isoSec(opened),
  };
}
