import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_4663, parseBook, resolveAsset, symbolOf } from './book.js';
import { setAssetDirectory } from './assets.js';
import { FIXTURE_TOKENS, fixtureDirectory } from './testFixtures.js';
import { oracleTokensFor, oracleUsdgFor, poolIdOf } from './reads.js';

const here = dirname(fileURLToPath(import.meta.url));
const deployFile = resolve(here, '../../../contracts/addresses/4663.json');

describe('Spare address book', () => {
  it.skipIf(!existsSync(deployFile))('matches contracts/addresses/4663.json exactly (no drift after a redeploy)', () => {
    const onDisk = JSON.parse(readFileSync(deployFile, 'utf8'));
    const a = parseBook(onDisk);
    const b = parseBook(DEPLOYMENT_4663);
    expect(b).toEqual(a);
  });

  it('parses and checksums the mainnet book', () => {
    const b = parseBook(DEPLOYMENT_4663);
    expect(b.chainId).toBe(4663);
    expect(b.startBlock).toBe(76_221_269n);
    expect(Object.keys(b.contracts)).toHaveLength(10);
    expect(b.parkAdapter.live).toBe('UsdgParkAdapter');
    expect(() => parseBook({ ...DEPLOYMENT_4663, contracts: { ...DEPLOYMENT_4663.contracts, CashPark: 'nope' } })).toThrow(/CashPark/);
  });

  it('carries no stock list: tickers resolve only through a registry read', () => {
    const b = parseBook(DEPLOYMENT_4663);
    expect(Object.keys(b)).not.toContain('assets');
    setAssetDirectory(null);
    expect(resolveAsset('spy', b)).toBeNull();
    expect(symbolOf(FIXTURE_TOKENS.SPY, b)).toBeNull();
    expect(symbolOf(b.external.USDG, b)).toBe('USDG');
  });

  it('resolves tickers and addresses from the registry read', () => {
    const b = parseBook(DEPLOYMENT_4663);
    const dir = fixtureDirectory();
    expect(resolveAsset('spy', b, dir)).toBe(FIXTURE_TOKENS.SPY);
    expect(resolveAsset('$NVDA', b, dir)).toBe(FIXTURE_TOKENS.NVDA);
    expect(resolveAsset(FIXTURE_TOKENS.TSLA.toLowerCase(), b, dir)).toBe(FIXTURE_TOKENS.TSLA);
    expect(resolveAsset('DOGE', b, dir)).toBeNull();
    expect(symbolOf(FIXTURE_TOKENS.AAPL.toLowerCase(), b, dir)).toBe('AAPL');
  });
});

describe('StockRouter math parity', () => {
  it('oracleTokensFor / oracleUsdgFor match the contract formulas', () => {
    const price = 770_441_341_380_000_000_000n; // $770.44134138, 1e18
    const out = oracleTokensFor(4_987_500n, price); // $4.9875 after the 25 bps fee
    expect(out).toBe((4_987_500n * 10n ** 30n) / price);
    expect(oracleUsdgFor(out, price)).toBe(4_987_499n); // floors, like Solidity
    expect(oracleTokensFor(1n, 0n)).toBe(0n);
  });

  it('poolIdOf = keccak256(abi.encode(PoolKey)) — stable for the pinned SPY pool', () => {
    const b = parseBook(DEPLOYMENT_4663);
    const id = poolIdOf({
      currency0: FIXTURE_TOKENS.SPY,
      currency1: b.external.USDG,
      fee: 3000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
    });
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      poolIdOf({ currency0: FIXTURE_TOKENS.SPY, currency1: b.external.USDG, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' }),
    ).toBe(id);
  });
});
