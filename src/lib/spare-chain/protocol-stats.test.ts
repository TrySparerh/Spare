import { describe, expect, it } from 'vitest';
import type { Hash } from 'viem';
import { applyLedgerLogs, emptyLedger, linkedNow, type LedgerLog } from './protocol-stats';

const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hash;
const log = (block: bigint, args: Record<string, unknown>, logIndex = 0): LedgerLog => ({ args, blockNumber: block, logIndex, txHash: tx(Number(block) + logIndex) });

describe('protocol ledger reducer', () => {
  it('starts empty just before the start block', () => {
    const l = emptyLedger(100n);
    expect(l.scannedTo).toBe(99n);
    expect(l.collectedUsdg).toBe(0n);
    expect(l.withdrawals).toEqual([]);
    expect(l.lastBuyBlock).toBeNull();
  });

  it('sums AssetSwept usdgIn and fee, and tracks the last buy', () => {
    const l = applyLedgerLogs(emptyLedger(1n), 'assetSwept', [
      log(10n, { usdgIn: 5_000_000n, fee: 12_500n, tokensOut: 1n }),
      log(30n, { usdgIn: 3_000_000n, fee: 7_500n, tokensOut: 1n }),
    ]);
    expect(l.buys).toBe(2);
    expect(l.convertedUsdg).toBe(8_000_000n);
    expect(l.feesUsdg).toBe(20_000n);
    expect(l.lastBuyBlock).toBe(30n);
  });

  it('sums Accrued amounts', () => {
    const l = applyLedgerLogs(emptyLedger(1n), 'accrued', [log(5n, { amount: 250_000n }), log(6n, { amount: 750_000n })]);
    expect(l.collections).toBe(2);
    expect(l.collectedUsdg).toBe(1_000_000n);
    expect(l.lastCollectedBlock).toBe(6n);
  });

  it('counts linked wallets net of unlinks, never below zero', () => {
    let l = applyLedgerLogs(emptyLedger(1n), 'linked', [log(2n, {}), log(3n, {})]);
    l = applyLedgerLogs(l, 'unlinked', [log(4n, {})]);
    expect(linkedNow(l)).toBe(1);
    l = applyLedgerLogs(l, 'unlinked', [log(5n, {}), log(6n, {})]);
    expect(linkedNow(l)).toBe(0);
  });

  it('keeps withdrawals newest first and does not mutate the input ledger', () => {
    const base = emptyLedger(1n);
    const a = applyLedgerLogs(base, 'withdrawn', [log(7n, { token: '0x1', to: '0x2', amount: 1n })]);
    const b = applyLedgerLogs(a, 'withdrawn', [log(9n, { token: '0x1', to: '0x2', amount: 2n }), log(9n, { token: '0x1', to: '0x2', amount: 3n }, 1)]);
    expect(base.withdrawals).toHaveLength(0);
    expect(a.withdrawals).toHaveLength(1);
    expect(b.withdrawals.map((w) => w.amount)).toEqual([3n, 2n, 1n]);
  });

  it('ignores an empty batch', () => {
    const base = emptyLedger(1n);
    expect(applyLedgerLogs(base, 'accrued', [])).toBe(base);
  });
});
