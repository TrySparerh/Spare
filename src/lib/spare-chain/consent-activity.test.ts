import { describe, it, expect } from 'vitest';
import {
  HttpRequestError,
  LimitExceededRpcError,
  encodeAbiParameters,
  encodeEventTopics,
  maxUint160,
  maxUint256,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { sweepExecutorAbi } from './abis';
import { SPARE } from './addresses';
import { collectionState, consentView, type WalletConsent } from './consent';
import {
  exclusionSet,
  isRateLimited,
  priceAccrualWindows,
  sweepOutcomeFromLogs,
  type ActivityEvent,
  type WalletTransfer,
} from './activity';

const NOW = 1_800_000_000;
const YEAR = NOW + 365 * 86_400;
const CAP = 50_000_000n; // $50

describe('consentView', () => {
  it('is AUTHORIZED only when both legs are live and cover the weekly cap', () => {
    const v = consentView({ erc20: maxUint256, p2Amount: maxUint160, p2Expiration: YEAR }, { now: NOW, weeklyCap: CAP });
    expect(v).toMatchObject({ label: 'AUTHORIZED', ok: true, pullable: true, p2Live: true });
    const covers = consentView({ erc20: CAP, p2Amount: maxUint160, p2Expiration: YEAR }, { now: NOW, weeklyCap: CAP });
    expect(covers.label).toBe('AUTHORIZED');
  });
  it('flags a USDG→Permit2 approval below the weekly cap as LOW ALLOWANCE', () => {
    const v = consentView({ erc20: 370_000n, p2Amount: maxUint160, p2Expiration: YEAR }, { now: NOW, weeklyCap: CAP });
    expect(v).toMatchObject({ label: 'LOW ALLOWANCE', tone: 'warn', pullable: true, ok: false });
    expect(v.detail).toMatch(/\$0\.37/);
  });
  it('keeps Revoke available while the Permit2 leg is live but USDG is unapproved', () => {
    const v = consentView({ erc20: 0n, p2Amount: maxUint160, p2Expiration: YEAR }, { now: NOW, weeklyCap: CAP });
    expect(v).toMatchObject({ label: 'PARTIAL', pullable: false, ok: false, p2Live: true });
  });
  it('treats an allowance inside the keeper expiry margin as not pullable', () => {
    const v = consentView({ erc20: maxUint256, p2Amount: maxUint160, p2Expiration: NOW + 30 }, { now: NOW, weeklyCap: CAP });
    expect(v).toMatchObject({ label: 'EXPIRED', pullable: false, p2Live: true });
    expect(consentView({ erc20: 0n, p2Amount: 0n, p2Expiration: 0 }, { now: NOW }).label).toBe('NOT AUTHORIZED');
    expect(consentView(undefined, { now: NOW }).label).toBe('READING');
  });
});

describe('collectionState', () => {
  const rule = { roundTo: 1, multiplier: 1, weeklyCap: CAP, enabled: true };
  const w = (wallet: string, erc20: bigint, p2Amount: bigint): WalletConsent => ({
    wallet,
    consent: consentView({ erc20, p2Amount, p2Expiration: YEAR }, { now: NOW, weeklyCap: CAP }),
  });
  it('never says ON when nothing can be collected', () => {
    expect(collectionState(rule, []).label).toBe('ON · NO WALLET');
    const none = collectionState(rule, [w('0x1111111111111111111111111111111111111111', 0n, 0n)]);
    expect(none).toMatchObject({ label: 'ON · NOT AUTHORIZED', collecting: false, tone: 'warn' });
    const some = collectionState(rule, [
      w('0x1111111111111111111111111111111111111111', maxUint256, maxUint160),
      w('0x2222222222222222222222222222222222222222', 0n, maxUint160),
    ]);
    expect(some).toMatchObject({ label: 'ON · 1/2 AUTHORIZED', collecting: true });
    expect(collectionState(rule, [w('0x1111111111111111111111111111111111111111', maxUint256, maxUint160)]).label).toBe('ROUND-UPS ON');
    expect(collectionState({ ...rule, enabled: false }, []).label).toBe('ROUND-UPS OFF');
  });
});

describe('isRateLimited', () => {
  it('backs off on throttling but still splits real result caps', () => {
    const http429 = new HttpRequestError({ url: 'https://rpc', status: 429, details: 'Too Many Requests' });
    expect(isRateLimited(http429)).toBe(true);
    expect(isRateLimited(new Error('{"code":429,"message":"Too Many Requests"}'))).toBe(true);
    expect(isRateLimited(new LimitExceededRpcError(new Error('query returned more than 10000 results')))).toBe(false);
    expect(isRateLimited(new Error('block range is too wide'))).toBe(false);
  });
});

describe('priceAccrualWindows', () => {
  const account = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const wallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
  const merchant = '0x3333333333333333333333333333333333333333' as Address;
  const accrued = (id: string, amount: bigint, fromBlock: bigint, toBlock: bigint): ActivityEvent => ({
    id, source: 'SweepExecutor', name: 'Accrued', args: { account, wallet, amount, fromBlock, toBlock },
    blockNumber: toBlock + 3_000n, logIndex: 0, txHash: '0x01' as Hash,
  });
  it('re-prices each window from its own payments, skipping non-payments', () => {
    const transfers: WalletTransfer[] = [
      { to: merchant, amount: 4_550_000n, blockNumber: 101n }, // $4.55 → $0.45
      { to: SPARE.SweepExecutor, amount: 450_000n, blockNumber: 150n }, // the executor's own pull
      { to: account, amount: 9_990_000n, blockNumber: 160n }, // to the account: not spending
      { to: merchant, amount: 2_100_000n, blockNumber: 250n }, // next window: $0.90
    ];
    const excluded = exclusionSet(account, [wallet]);
    const out = priceAccrualWindows(
      [accrued('a', 0n, 100n, 200n), accrued('b', 900_000n, 200n, 300n), accrued('c', 0n, 300n, 400n)],
      new Map([[wallet.toLowerCase(), transfers]]),
      excluded,
      () => ({ roundTo: 1, multiplier: 1 }),
    );
    expect(out.get('a')).toEqual({ payments: 1, due: 450_000n }); // $0.45 owed, $0 pulled → NOT COLLECTED
    expect(out.get('b')).toEqual({ payments: 1, due: 900_000n });
    expect(out.get('c')).toEqual({ payments: 0, due: 0n }); // truly idle
  });
  it('leaves a window out when the rule in force is unknown', () => {
    const out = priceAccrualWindows([accrued('a', 0n, 1n, 2n)], new Map([[wallet.toLowerCase(), []]]), new Set(), () => null);
    expect(out.has('a')).toBe(false);
  });
});

describe('sweepOutcomeFromLogs', () => {
  const account = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
  const spy = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C' as Address;
  const nvda = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address;
  const abi = sweepExecutorAbi as unknown as Abi;
  const log = (eventName: string, args: Record<string, unknown>, data: Hex) => ({
    address: SPARE.SweepExecutor,
    topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[],
    data,
  });
  const u = (...vs: bigint[]) => encodeAbiParameters(vs.map(() => ({ type: 'uint256' })), vs);
  const deferred = (asset: Address, usdg: bigint, status: number) =>
    log('Deferred', { account, asset }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [usdg, status]));

  it('reports a sweep whose every leg deferred as nothing settled', () => {
    const logs = [
      log('AccountSwept', { account }, u(7n, 5_200_000n)),
      deferred(spy, 3_120_000n, 0),
      deferred(nvda, 2_080_000n, 1),
    ];
    const o = sweepOutcomeFromLogs(logs, account, '0x01' as Hash, 10n);
    expect(o).toMatchObject({ epoch: 7n, withdrawn: 5_200_000n, deferred: 5_200_000n, settled: 0n });
    expect(o?.deferredLegs.map((l) => l.status)).toEqual([0, 1]);
  });
  it('nets out a partial deferral', () => {
    const o = sweepOutcomeFromLogs([log('AccountSwept', { account }, u(7n, 5_000_000n)), deferred(nvda, 2_000_000n, 1)], account, '0x01' as Hash, 10n);
    expect(o?.settled).toBe(3_000_000n);
  });
});
