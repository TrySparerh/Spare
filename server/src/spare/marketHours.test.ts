/**
 * The keeper's market-hours cases (engine/test/keeper-plan.test.ts), run
 * against the API's copy so the two cannot drift.
 */
import { describe, expect, it } from 'vitest';
import { easternOffsetSeconds, equityMarketOpen, equitySessionOpenedAt, marketView, sessionView } from './marketHours.js';

const utc = (s: string) => Date.parse(s) / 1000;

describe('US-equity market hours (keeper parity)', () => {
  it('DST switches at 07:00 UTC in March and 06:00 UTC in November', () => {
    expect(easternOffsetSeconds(utc('2026-03-08T06:59:59Z'))).toBe(-5 * 3600);
    expect(easternOffsetSeconds(utc('2026-03-08T07:00:00Z'))).toBe(-4 * 3600);
    expect(easternOffsetSeconds(utc('2026-11-01T05:59:59Z'))).toBe(-4 * 3600);
    expect(easternOffsetSeconds(utc('2026-11-01T06:00:00Z'))).toBe(-5 * 3600);
  });

  it('session opens Sunday 20:00 ET and closes Friday 20:00 ET (EDT)', () => {
    const open = utc('2026-09-28T00:00:00Z'); // Sun 2026-09-27 20:00 EDT
    expect(equitySessionOpenedAt(open - 1)).toBeNull();
    expect(equitySessionOpenedAt(open)).toBe(open);
    expect(equitySessionOpenedAt(utc('2026-09-30T12:00:00Z'))).toBe(open);
    expect(equitySessionOpenedAt(utc('2026-10-02T23:59:59Z'))).toBe(open);
    expect(equitySessionOpenedAt(utc('2026-10-03T00:00:00Z'))).toBeNull();
    expect(equitySessionOpenedAt(utc('2026-10-03T12:00:00Z'))).toBeNull();
  });

  it('winter (EST) boundaries are an hour later in UTC', () => {
    expect(equitySessionOpenedAt(utc('2026-12-07T00:30:00Z'))).toBeNull();
    expect(equitySessionOpenedAt(utc('2026-12-07T01:00:00Z'))).toBe(utc('2026-12-07T01:00:00Z'));
    expect(equitySessionOpenedAt(utc('2026-12-12T00:59:59Z'))).not.toBeNull();
    expect(equitySessionOpenedAt(utc('2026-12-12T01:00:00Z'))).toBeNull();
  });

  it('mainnet SPY feed: the frozen Friday price is not swept over the weekend', () => {
    const fri = utc('2026-09-25T16:03:00Z');
    expect(equityMarketOpen(utc('2026-09-25T20:00:00Z'), fri)).toBe(true);
    expect(equityMarketOpen(utc('2026-09-26T10:00:00Z'), fri)).toBe(false);
    expect(equityMarketOpen(utc('2026-09-28T00:10:00Z'), utc('2026-09-28T00:00:40Z'))).toBe(true);
  });

  it('holiday Monday (Labor Day 2026-09-07): no feed post since the open -> closed', () => {
    const lastFri = utc('2026-09-04T15:12:39Z');
    expect(equityMarketOpen(utc('2026-09-07T15:00:00Z'), lastFri)).toBe(false);
    expect(equityMarketOpen(utc('2026-09-08T01:00:00Z'), utc('2026-09-08T00:00:51Z'))).toBe(true);
  });
});

describe('marketView', () => {
  it('Saturday 10:00 ET with a Friday 15:00 ET print: closed, with the keeper reason', () => {
    const v = marketView(utc('2026-10-03T14:00:00Z'), utc('2026-10-02T19:00:00Z'), true);
    expect(v.open).toBe(false);
    expect(v.sessionOpenedAt).toBeNull();
    expect(v.awaitingFirstPrint).toBe(false);
    expect(v.reason).toMatch(/^market closed \(keeper market-hours gate\)/);
  });

  it('session open but no print since the open: closed, awaiting the first print', () => {
    const v = marketView(utc('2026-09-07T15:00:00Z'), utc('2026-09-04T15:12:39Z'), true);
    expect(v.open).toBe(false);
    expect(v.awaitingFirstPrint).toBe(true);
    expect(v.sessionOpenedAt).toBe('2026-09-07T00:00:00.000Z');
  });

  it('gate off: always open (keeper MARKET_HOURS_GATE=0)', () => {
    expect(marketView(utc('2026-10-03T14:00:00Z'), 0, false).open).toBe(true);
  });

  it('sessionView reports the session alone', () => {
    expect(sessionView(utc('2026-09-30T12:00:00Z'), true)).toEqual({
      session: 'us_equities_24_5',
      gate: true,
      sessionOpen: true,
      sessionOpenedAt: '2026-09-28T00:00:00.000Z',
    });
  });
});
