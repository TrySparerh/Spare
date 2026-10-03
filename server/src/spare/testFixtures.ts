/**
 * Test fixtures only: a few real registry tokens on Robinhood Chain mainnet
 * with the symbols their contracts return. The API never lists assets — it
 * reads AssetRegistry (assets.ts) — so offline tests install this directory
 * the way a registry read would.
 */
import type { Address } from 'viem';
import { makeDirectory, setAssetDirectory, type AssetDirectory } from './assets.js';

export const FIXTURE_TOKENS = {
  SPY: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
} as const satisfies Record<string, Address>;

export function fixtureDirectory(): AssetDirectory {
  return makeDirectory(
    Object.entries(FIXTURE_TOKENS).map(([symbol, token]) => ({ token, symbol, name: null, active: true, feed: null, bandBps: 150 })),
  );
}

/** Install the fixture directory as the "last registry read". */
export function installFixtureDirectory(): AssetDirectory {
  const d = fixtureDirectory();
  setAssetDirectory(d);
  return d;
}
