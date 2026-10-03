/**
 * Test fixtures only: a few real registry tokens (Robinhood Chain mainnet) with
 * the symbols their token contracts return. Production code never lists
 * assets — it reads AssetRegistry (lib/spare-chain/universe.ts) — so tests
 * that render ticker text teach symbolOf() these names first.
 */
import type { Address } from 'viem';
import { rememberAssets } from '@/lib/spare-chain/addresses';

export const FIXTURE_TOKENS = {
  SPY: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
  QQQ: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
} as const satisfies Record<string, Address>;

/** What readAssetCatalog would have remembered after reading the registry. */
export function primeFixtureNames(): void {
  rememberAssets(Object.entries(FIXTURE_TOKENS).map(([symbol, token]) => ({ token, symbol })));
}
