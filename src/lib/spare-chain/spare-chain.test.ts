import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encodeErrorResult, getAddress, recoverTypedDataAddress, UserRejectedRequestError, BaseError, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EXTERNAL, SPARE, START_BLOCK, assetNameOf, forgetAssets, isDeployed, rememberAssets, resetDeployedCache, symbolOf } from './addresses';
import { FIXTURE_TOKENS } from '@/test/assetFixtures';
import { MAX_LOG_RANGE, WEEK_BLOCKS, chunkRange, dedupeBookkeeping, olderWindow, type ActivityEvent } from './activity';
import { SPARE_ERRORS_ABI, decodeRevertData, humanizeError } from './errors';
import { LINK_DOMAIN, linkTypedData, loadPendingLinks, savePendingLinks, upsertPendingLink, removePendingLink } from './link';

describe('addresses', () => {
  it('are checksummed and named', () => {
    expect(SPARE.SweepExecutor).toBe(getAddress('0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab'));
    expect(EXTERNAL.Permit2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    expect(symbolOf(EXTERNAL.USDG)).toBe('USDG');
    expect(symbolOf('0x1111111111111111111111111111111111111111')).toBe('0x1111…1111');
  });

  it('name stock tokens only from what the registry read remembered', () => {
    forgetAssets();
    // Before the registry answers: a short address, not a ticker.
    expect(symbolOf(FIXTURE_TOKENS.SPY)).toBe('0x117c…4C0C');
    expect(rememberAssets([{ token: FIXTURE_TOKENS.SPY, symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust' }])).toBe(true);
    expect(symbolOf(FIXTURE_TOKENS.SPY.toLowerCase())).toBe('SPY');
    expect(assetNameOf(FIXTURE_TOKENS.SPY)).toBe('SPDR S&P 500 ETF Trust');
    // Same answer again: nothing changes (no re-render churn).
    expect(rememberAssets([{ token: FIXTURE_TOKENS.SPY, symbol: 'SPY' }])).toBe(false);
    forgetAssets();
  });
});

describe('isDeployed', () => {
  beforeEach(() => resetDeployedCache());
  it('caches a negative answer briefly and a positive answer for good', async () => {
    const getCode = vi.fn().mockResolvedValue('0x');
    expect(await isDeployed({ getCode } as never)).toBe(false);
    expect(await isDeployed({ getCode } as never)).toBe(false);
    expect(getCode).toHaveBeenCalledTimes(1);

    resetDeployedCache();
    getCode.mockResolvedValue('0x6080');
    expect(await isDeployed({ getCode } as never)).toBe(true);
    getCode.mockResolvedValue('0x');
    expect(await isDeployed({ getCode } as never)).toBe(true);
    expect(getCode).toHaveBeenCalledTimes(2);
  });
});

describe('activity chunking', () => {
  it('never exceeds 50,000 blocks per chunk and covers the range exactly', () => {
    const from = 76_209_411n;
    const to = from + 123_456n;
    const chunks = chunkRange(from, to, MAX_LOG_RANGE);
    expect(chunks[0].from).toBe(from);
    expect(chunks[chunks.length - 1].to).toBe(to);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].to - chunks[i].from + 1n <= MAX_LOG_RANGE).toBe(true);
      if (i > 0) expect(chunks[i].from).toBe(chunks[i - 1].to + 1n);
    }
    expect(chunkRange(10n, 9n, MAX_LOG_RANGE)).toEqual([]);
  });
  it('pages back a week at a time, floored at the deployment block', () => {
    const w = olderWindow(START_BLOCK + WEEK_BLOCKS * 2n);
    expect(w).toEqual({ from: START_BLOCK + WEEK_BLOCKS, to: START_BLOCK + WEEK_BLOCKS * 2n - 1n });
    expect(olderWindow(START_BLOCK + 10n)).toEqual({ from: START_BLOCK, to: START_BLOCK + 9n });
    expect(olderWindow(START_BLOCK)).toBeNull();
  });
  it('hides CashPark bookkeeping that duplicates an executor event in the same tx', () => {
    const ev = (name: string, source: ActivityEvent['source'], tx: string, i: number): ActivityEvent => ({
      id: `${tx}:${i}`, name, source, args: {}, blockNumber: 1n, logIndex: i, txHash: tx as Hex,
    });
    const out = dedupeBookkeeping([
      ev('Accrued', 'SweepExecutor', '0xa', 1),
      ev('Credited', 'CashPark', '0xa', 0),
      ev('Credited', 'CashPark', '0xb', 0),
      ev('Exited', 'CashPark', '0xc', 0),
    ]);
    expect(out.map((e) => `${e.name}@${e.txHash}`)).toEqual(['Accrued@0xa', 'Credited@0xb', 'Exited@0xc']);
  });
});

describe('errors', () => {
  it('decodes SPARE custom errors into sentences', () => {
    const data = encodeErrorResult({
      abi: SPARE_ERRORS_ABI,
      errorName: 'AlreadyLinked',
      args: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
    });
    expect(decodeRevertData(data)).toMatch(/already linked to account 0x2222…2222/);
    const total = encodeErrorResult({ abi: SPARE_ERRORS_ABI, errorName: 'BadTotal', args: [9000n] });
    expect(decodeRevertData(total)).toMatch(/exactly 100% \(got 90%\)/);
    expect(decodeRevertData('0xdeadbeef')).toBeNull();
  });
  it('says plainly when the user rejected the request', () => {
    const err = new UserRejectedRequestError(new Error('User denied'));
    expect(humanizeError(err)).toMatch(/rejected the request/);
    expect(humanizeError({ code: 4001 })).toMatch(/rejected the request/);
  });
  it('finds raw revert data buried in a wallet error', () => {
    const data = encodeErrorResult({ abi: SPARE_ERRORS_ABI, errorName: 'TooManyWallets' });
    const inner = Object.assign(new Error('execution reverted'), { data });
    const err = new BaseError('gas estimation failed', { cause: inner });
    expect(humanizeError(err)).toMatch(/maximum of 8 linked wallets/);
  });
});

describe('link signatures', () => {
  const walletKey = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const account = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');

  it('uses the RuleRegistry EIP-712 domain', () => {
    expect(LINK_DOMAIN).toEqual({ name: 'SPARE RuleRegistry', version: '1', chainId: 4663, verifyingContract: SPARE.RuleRegistry });
  });
  it('recovers to the signing wallet', async () => {
    const typed = linkTypedData(account, walletKey.address, 1n, 2_000_000_000n);
    const sig = await walletKey.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(walletKey.address);
  });
  it('stores handoffs with bigints intact and replaces older ones', () => {
    localStorage.clear();
    const base = { account, wallet: walletKey.address, nonce: 3n, deadline: 2_000_000_000n, signature: '0xab' as Hex, createdAt: 1 };
    let list = upsertPendingLink([], base, 1_000);
    list = upsertPendingLink(list, { ...base, nonce: 4n }, 1_000);
    savePendingLinks(list);
    const back = loadPendingLinks();
    expect(back).toHaveLength(1);
    expect(back[0].nonce).toBe(4n);
    expect(removePendingLink(back, account.toLowerCase(), walletKey.address)).toEqual([]);
  });
  it('drops expired handoffs on upsert', () => {
    const old = { account, wallet: account, nonce: 1n, deadline: 10n, signature: '0x' as Hex, createdAt: 0 };
    const fresh = { ...old, wallet: walletKey.address, deadline: 5_000n };
    expect(upsertPendingLink([old], fresh, 100)).toEqual([fresh]);
  });
});
