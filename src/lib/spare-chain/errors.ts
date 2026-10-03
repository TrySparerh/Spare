/**
 * Turn wallet / RPC / revert errors into one readable sentence.
 *
 * Custom errors are decoded against every SPARE ABI (plus Permit2), so a
 * revert from any contract in a call chain — e.g. ElectionRegistry reverting
 * inside setMix, or Permit2 inside an approve — reads as a sentence instead of
 * a selector.
 *
 * The sentences live in the shell namespace (`errors.*` in
 * src/i18n/locales/<lang>/shell.json) and are built when an error is shown, so
 * they come out in the live language. This module also runs outside the app
 * (bun scripts/fund-swap-fork.ts imports fund-errors), so it talks to i18next
 * directly instead of '@/i18n' (which needs Vite); with no window and nobody
 * starting i18next, it starts it in English from the same dictionary.
 */
import i18next from 'i18next';
import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  decodeErrorResult,
  formatUnits,
  type Abi,
  type Hex,
} from 'viem';
import {
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  feeVaultAbi,
  permit2Abi,
  ruleRegistryAbi,
  screeningGateAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from './abis';
import { shortAddr, symbolOf } from './addresses';
import EN_SHELL from '../../i18n/locales/en/shell.json';

if (typeof window === 'undefined' && !i18next.isInitialized) {
  void i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['shell'],
    defaultNS: 'shell',
    resources: { en: { shell: EN_SHELL } },
    initAsync: false,
    interpolation: { escapeValue: false },
  });
}

const tf = i18next.getFixedT(null, 'shell');

/** Every custom error any SPARE call can surface, de-duplicated by signature. */
export const SPARE_ERRORS_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  const all = [
    ...ruleRegistryAbi, ...electionRegistryAbi, ...assetRegistryAbi, ...screeningGateAbi,
    ...stockRouterAbi, ...cashParkAbi, ...feeVaultAbi, ...sweepExecutorAbi, ...permit2Abi,
  ] as unknown as Abi;
  for (const item of all) {
    if (item.type !== 'error') continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(item);
  }
  return out;
})();

const usd = (v: unknown) => `$${Number(formatUnits(BigInt(v as bigint), 6)).toFixed(2)}`;
const addr = (v: unknown) => shortAddr(String(v));
const sym = (v: unknown) => symbolOf(String(v));

/** OracleGuard.Status as words, for OracleNotOk. */
function oracleStatus(n: number): string {
  switch (n) {
    case 0: return tf('errors.oracle.ok');
    case 1: return tf('errors.oracle.stale');
    case 2: return tf('errors.oracle.paused');
    case 3: return tf('errors.oracle.seqDown');
    case 4: return tf('errors.oracle.badAnswer');
    default: return tf('errors.oracle.unavailable');
  }
}

/** Readable sentence for a decoded custom error. Unknown names fall through to `Name(args)`. */
export function describeRevert(name: string, args: readonly unknown[] = []): string {
  const a = args;
  switch (name) {
    // RuleRegistry
    case 'BadRoundTo': return tf('errors.revert.badRoundTo', { got: String(a[0]) });
    case 'BadMultiplier': return tf('errors.revert.badMultiplier', { got: String(a[0]) });
    case 'AlreadyLinked': return tf('errors.revert.alreadyLinked', { wallet: addr(a[0]), account: addr(a[1]) });
    case 'NotLinked': return tf('errors.revert.notLinked', { wallet: addr(a[0]) });
    case 'TooManyWallets': return tf('errors.revert.tooManyWallets');
    case 'Expired': return tf('errors.revert.expired');
    case 'BadSignature': return tf('errors.revert.badSignature');
    // ElectionRegistry
    case 'BadLegCount': return tf('errors.revert.badLegCount', { got: String(a[0]) });
    case 'BadTotal': return tf('errors.revert.badTotal', { got: Number(a[0]) / 100 });
    case 'ZeroLeg': return tf('errors.revert.zeroLeg', { symbol: sym(a[0]) });
    case 'DuplicateAsset': return tf('errors.revert.duplicateAsset', { symbol: sym(a[0]) });
    case 'IneligibleAsset': return tf('errors.revert.ineligibleAsset', { symbol: sym(a[0]) });
    // AssetRegistry / StockRouter
    case 'UnknownAsset': return tf('errors.revert.unknownAsset', { symbol: sym(a[0]) });
    case 'AssetInactive': return tf('errors.revert.assetInactive', { symbol: sym(a[0]) });
    case 'OracleNotOk': return tf('errors.revert.oracleNotOk', { status: oracleStatus(Number(a[0])) });
    case 'BelowMinOut': case 'OutsideOracleBand': return tf('errors.revert.outsideBand');
    // SweepExecutor
    case 'RuleDisabled': return tf('errors.revert.ruleDisabled');
    case 'WeeklyCapExceeded': return tf('errors.revert.weeklyCapExceeded', { amount: usd(a[0]), cap: usd(a[1]) });
    case 'CursorNotAdvancing': return tf('errors.revert.cursorNotAdvancing');
    case 'NotFinal': return tf('errors.revert.notFinal');
    // Permit2
    case 'AllowanceExpired': return tf('errors.revert.allowanceExpired');
    case 'InsufficientAllowance': return tf('errors.revert.insufficientAllowance');
    // Shared
    case 'IsPaused': return tf('errors.revert.isPaused');
    case 'NotKeeper': return tf('errors.revert.notKeeper');
    case 'NotPauser': return tf('errors.revert.notPauser');
    case 'NotExecutor': return tf('errors.revert.notExecutor');
    case 'OwnableUnauthorizedAccount': return tf('errors.revert.notOwner');
    case 'ReentrancyGuardReentrantCall': return tf('errors.revert.reentrant');
    case 'SafeERC20FailedOperation': return tf('errors.revert.transferFailed', { symbol: sym(a[0]) });
    case 'ZeroAddress': return tf('errors.revert.zeroAddress');
    default: return `${name}(${a.map((x) => String(x)).join(', ')})`;
  }
}

/** Try to decode raw revert bytes against the SPARE error set. */
export function decodeRevertData(data: Hex | undefined | null): string | null {
  if (!data || data.length < 10) return null;
  try {
    const r = decodeErrorResult({ abi: SPARE_ERRORS_ABI, data });
    return describeRevert(r.errorName, (r.args ?? []) as readonly unknown[]);
  } catch {
    return null;
  }
}

function hasCode(e: unknown, code: number): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** One human-readable line for anything a write, sign or read can throw. */
export function humanizeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError || hasCode(e, 4001))) {
      return tf('errors.rejected');
    }
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      if (revert.data?.errorName) {
        const name = revert.data.errorName;
        if (name === 'Error' || name === 'Panic') return tf('errors.reverted', { reason: revert.reason ?? name });
        return describeRevert(name, (revert.data.args ?? []) as readonly unknown[]);
      }
      const decoded = decodeRevertData(revert.raw);
      if (decoded) return decoded;
      if (revert.reason) return tf('errors.reverted', { reason: revert.reason });
      return tf('errors.contractRejected');
    }
    // Wallet-side gas estimation often buries raw revert data in a nested cause.
    const withData = err.walk((e) => {
      const d = (e as { data?: unknown }).data;
      return typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d);
    }) as { data?: Hex } | null;
    const decoded = decodeRevertData(withData?.data);
    if (decoded) return decoded;
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return tf('errors.noGas');
    }
    return err.shortMessage || err.message.split('\n')[0];
  }
  if (hasCode(err, 4001)) return tf('errors.rejected');
  if (err instanceof Error) return err.message.split('\n')[0];
  return String(err);
}
