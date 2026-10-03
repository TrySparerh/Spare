/**
 * Live smoke test against Robinhood Chain mainnet. Skipped automatically when
 * the RPC is unreachable (offline CI) or when SPARE_LIVE_TESTS=0.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPARE_RPC_URL } from './book.js';
import { readAccount, readActivity, readContracts, readFees, readQuote, readUniverse } from './reads.js';

async function online(): Promise<boolean> {
  if (process.env.SPARE_LIVE_TESTS === '0') return false;
  try {
    const r = await fetch(process.env.SPARE_RPC_URL || DEFAULT_SPARE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await r.json()) as { result?: string };
    return j.result === '0x1237'; // 4663
  } catch {
    return false;
  }
}

const LIVE = await online();

describe.skipIf(!LIVE)('Spare engine — live mainnet reads', () => {
  it('spare_universe: the registry lists the four active launch stocks with OK-or-explained oracles', async () => {
    const u = await readUniverse();
    expect(u.counts.registered).toBeGreaterThanOrEqual(4);
    const active = u.assets.filter((a) => a.active).map((a) => a.symbol).sort();
    expect(active).toEqual(expect.arrayContaining(['AAPL', 'NVDA', 'SPY', 'TSLA']));
    for (const a of u.assets) {
      expect(a.pool?.poolId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(['OK', 'STALE', 'PAUSED', 'SEQUENCER_DOWN', 'BAD_ANSWER']).toContain(a.oracle.status);
      expect(typeof a.oracleStatus).toBe('number');
      expect(typeof a.marketOpen).toBe('boolean');
      // LIVE only inside the keeper's market-hours gate.
      if (a.oracleLabel === 'LIVE') expect(a.marketOpen && a.oracleStatus === 0).toBe(true);
    }
    expect(u.sweep.conversionFeeBps).toBe(25);
  }, 60_000);

  it('spare_quote: a $5 SPY quote returns tokens out through the pinned pool', async () => {
    const q = await readQuote('SPY', '5');
    expect(q.input.feeUsd).toBe('0.0125');
    expect(q.feeUsd).toBe('0.0125');
    expect(q.quote.ok).toBe(true);
    expect(q.expectedOut).not.toBeNull();
    expect(['buy', 'wait', 'defer', 'safe_settle']).toContain(q.outcome);
    if (!q.marketOpen) expect(q.outcome).not.toBe('buy');
    // The keeper mirror reads every token's ERC-8056 state and the pool's slot0 on mainnet.
    expect(['buy', 'wait', 'hold', 'defer', 'safe_settle']).toContain(q.keeperOutcome);
    expect(q.keeperChecks.multiplierChange).not.toBeNull();
    expect(q.keeperChecks.quoteVsOracle!.reference).not.toBeNull();
    expect(q.keeperChecks.quoteVsOracle!.poolFeeBps).toBeGreaterThan(5); // 5 bps LP fee + the protocol fee
  }, 60_000);

  it('spare_account + spare_activity read a real account without throwing', async () => {
    const acct = '0x7e57000000000000000000000000000000000001';
    const a = await readAccount(acct);
    expect(a.account.toLowerCase()).toBe(acct.toLowerCase());
    expect(typeof a.parkedUsd).toBe('string');
    expect(typeof a.mixIsDefault).toBe('boolean');
    expect(Array.isArray(a.mix)).toBe(true);
    for (const l of a.mix) {
      expect(['buy', 'wait', 'hold', 'defer', 'safe_settle']).toContain(l.keeperOutcome);
      if (l.keeperOutcome !== 'buy') expect(typeof l.reason).toBe('string');
    }
    const act = await readActivity({ address: acct, days: 1 });
    expect(act.window.getLogsCalls).toBeGreaterThan(0);
    expect(BigInt(act.window.toBlock) - BigInt(act.window.fromBlock) + 1n <= 864_000n).toBe(true);
  }, 120_000);

  it('spare_contracts + spare_fees: every contract has bytecode; FeeVault is readable', async () => {
    const c = await readContracts();
    expect(c.contractDetails.every((x) => x.deployed)).toBe(true);
    expect(c.contracts.AssetRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.roles.keeper).toMatch(/^0x/);
    const f = await readFees();
    expect(f.balances.USDG).not.toBeNull();
    expect(f.feeVault.usdg).not.toBeNull();
    expect(f.feeBps).toBe(25);
  }, 60_000);
});
