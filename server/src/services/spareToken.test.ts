import { afterEach, describe, expect, it } from "vitest";
import { emptyTierDistribution, getSpareTokenStatus, getTokenLedgerStats } from "./spareToken.js";

describe("$SPARE token (not launched)", () => {
  afterEach(() => {
    delete process.env.SPARE_TOKEN_ADDRESS;
  });

  it("status is coming_soon with no address", () => {
    delete process.env.SPARE_TOKEN_ADDRESS;
    const s = getSpareTokenStatus();
    expect(s.launched).toBe(false);
    expect(s.address).toBeNull();
  });

  it("ledger stats carry exactly the Spare buyback fields, all zero", () => {
    const stats = getTokenLedgerStats();
    expect(Object.keys(stats).sort()).toEqual(
      [
        "token",
        "enabled",
        "liveMode",
        "cumulativeUsdgRouted",
        "cumulativeSpareBoughtBack",
        "last24hUsdgRouted",
        "last24hSpareBoughtBack",
        "buybackEventCount",
        "pending",
        "lastBuyback",
        "config",
      ].sort(),
    );
    expect(stats.cumulativeSpareBoughtBack).toBe(0);
    expect(stats.lastBuyback).toBeNull();
  });

  it("empty tier distribution reports its build time as buildMs", () => {
    const d = emptyTierDistribution();
    expect(d.buildMs).toBe(0);
    expect(d.totalHolders).toBe(0);
  });
});
