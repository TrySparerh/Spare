/**
 * Readable sentences for Fund Wallet swap failures.
 *
 * A swap revert comes from the Universal Router, the v4 PoolManager/V4Router or Permit2,
 * often nested: ExecutionFailed(commandIndex, innerRevert) wraps a command's revert and
 * WrappedError(target, selector, reason, details) wraps a callee's. Those are unwrapped
 * and decoded against fundSwapErrorsAbi first; anything else falls through to the SPARE
 * humanizer (wallet rejections, insufficient funds, SPARE custom errors).
 *
 * Sentences live in the shell namespace (`fundErrors.*`); see ./errors for why this
 * uses i18next directly (it also runs in bun scripts/fund-swap-fork.ts).
 */
import i18next from 'i18next';
import { decodeErrorResult, type Hex } from 'viem';
import { humanizeError } from './errors';
import { fundSwapErrorsAbi } from './fund-swap';
import { formatFixed } from '../spare';

const tf = i18next.getFixedT(null, 'shell');

export interface FundErrorContext {
  /** Symbol and decimals of the token the user receives, for V4TooLittleReceived amounts. */
  outSymbol?: string;
  outDecimals?: number;
}

function amount(v: unknown, ctx: FundErrorContext, dp?: number): string {
  const raw = BigInt(v as bigint);
  if (ctx.outDecimals == null) return raw.toString();
  const s = formatFixed(raw, ctx.outDecimals, dp ?? Math.min(ctx.outDecimals, 8));
  return `${s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s}${ctx.outSymbol ? ` ${ctx.outSymbol}` : ''}`;
}

/** Received vs minimum, printed at full precision when the short form would read identically. */
function amountPair(got: unknown, min: unknown, ctx: FundErrorContext): [string, string] {
  const short: [string, string] = [amount(got, ctx), amount(min, ctx)];
  if (short[0] !== short[1] || ctx.outDecimals == null) return short;
  return [amount(got, ctx, ctx.outDecimals), amount(min, ctx, ctx.outDecimals)];
}

/** Decode revert bytes from a fund swap into one sentence; null if the selector is unknown. */
export function describeFundRevert(data: Hex | undefined | null, ctx: FundErrorContext = {}, depth = 0): string | null {
  if (!data || data.length < 10 || depth > 4) return null;
  let r: { errorName: string; args?: readonly unknown[] };
  try {
    r = decodeErrorResult({ abi: fundSwapErrorsAbi, data }) as { errorName: string; args?: readonly unknown[] };
  } catch {
    return null;
  }
  const a = r.args ?? [];
  switch (r.errorName) {
    case 'V4TooLittleReceived': {
      const [got, min] = amountPair(a[1], a[0], ctx);
      return tf('fundErrors.tooLittleReceived', { got, min });
    }
    case 'V4TooLittleReceivedPerHopSingle':
      return tf('fundErrors.pastPriceLimit');
    case 'TransactionDeadlinePassed':
      return tf('fundErrors.deadlinePassed');
    case 'ExecutionFailed':
      return describeFundRevert(a[1] as Hex, ctx, depth + 1) ?? tf('fundErrors.stepFailed', { step: Number(a[0]) + 1 });
    case 'WrappedError':
      return describeFundRevert(a[2] as Hex, ctx, depth + 1) ?? tf('fundErrors.poolRejected');
    case 'AllowanceExpired':
      return tf('fundErrors.allowanceExpired');
    case 'InsufficientAllowance':
      return tf('fundErrors.allowanceLow');
    case 'InvalidNonce':
      return tf('fundErrors.nonceUsed');
    case 'SignatureExpired':
      return tf('fundErrors.signatureExpired');
    case 'InsufficientETH':
      return tf('fundErrors.noEth');
    case 'InsufficientBalance':
    case 'InsufficientToken':
    case 'DeltaNotNegative':
    case 'DeltaNotPositive':
    case 'CurrencyNotSettled':
      return tf('fundErrors.notSettled');
    case 'PriceLimitAlreadyExceeded':
    case 'PriceLimitOutOfBounds':
      return tf('fundErrors.outsideLimit');
    case 'Error': {
      const reason = String(a[0] ?? '');
      if (/TRANSFER_FROM_FAILED/i.test(reason)) return tf('fundErrors.pullFailed');
      if (/TRANSFER_FAILED|ETH_TRANSFER/i.test(reason)) return tf('fundErrors.transferFailed');
      return tf('errors.reverted', { reason });
    }
    case 'Panic':
      return tf('fundErrors.panic', { code: String(a[0]) });
    default:
      return `${r.errorName}(${a.map((x) => String(x)).join(', ')})`;
  }
}

/** Revert bytes buried anywhere in a viem error chain (call, estimateGas, wallet RPC). */
export function revertDataOf(err: unknown): Hex | undefined {
  const isHex = (d: unknown): d is Hex => typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d);
  const pick = (e: unknown): Hex | undefined => {
    if (typeof e !== 'object' || e === null) return undefined;
    const o = e as { data?: unknown; raw?: unknown };
    if (isHex(o.raw)) return o.raw;
    if (isHex(o.data)) return o.data;
    if (typeof o.data === 'object' && o.data !== null && isHex((o.data as { data?: unknown }).data)) {
      return (o.data as { data: Hex }).data;
    }
    return undefined;
  };
  // Walk `.cause` by hand (not BaseError.walk) so a second viem copy in the bundle,
  // or a wallet's plain-object error, is still searched. viem puts the node's revert
  // bytes on the innermost RpcRequestError.
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur != null; i++) {
    const hit = pick(cur);
    if (hit) return hit;
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** One line for anything a fund swap, approval or quote can throw. */
export function humanizeFundError(err: unknown, ctx: FundErrorContext = {}): string {
  const decoded = describeFundRevert(revertDataOf(err), ctx);
  return decoded ?? humanizeError(err);
}
