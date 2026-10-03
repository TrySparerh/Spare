import { describe, it, expect, vi } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  maxUint256,
  zeroAddress,
  type Hex,
} from 'viem';
import {
  ADDRESS_THIS,
  CHAINLINK_ETH_USD,
  CHAINLINK_MAX_AGE_SECONDS,
  CONTRACT_BALANCE,
  ETH_GAS_RESERVE_WEI,
  FUND_GAS,
  GAS_RESERVE_TXS,
  GAS_SAFETY_MULTIPLIER,
  IMPACT_BLOCK_BPS,
  IMPACT_PROBE_ETH_WEI,
  IMPACT_PROBE_USDG,
  PRICE_BLOCK_BPS,
  SPARE_TX_GAS,
  checkSwapPrice,
  ethSwapIsMeaningful,
  floorToDp,
  gasReserveWei,
  quoteWithProbe,
  readEthUsdReference,
  readUsdgPermit2State,
  referenceFromRound,
  usdgApprovalForSwap,
  usdgToEthEthNeeded,
  usdgToEthGas,
  usdgToEthTxCount,
  ETH_USDG_POOL,
  FEE_VAULT,
  FUND_FEE_BPS,
  FUND_SWAP_DEADLINE_SECONDS,
  MAX_FUND_FEE_BPS,
  PERMIT2,
  UNIVERSAL_ROUTER,
  USDG,
  V4_QUOTER,
  buildEthToUsdg,
  buildPermit2ApproveRouterTx,
  buildUsdgApprovePermit2Tx,
  buildUsdgToEth,
  edgeVsReferenceBps,
  feeOf,
  feedToUsd6,
  fundSwapErrorsAbi,
  maxEthSwapIn,
  parseAmount,
  parseFundFeeBps,
  permit2Abi,
  quoteEthToUsdg,
  splitQuote,
  txsCovered,
  universalRouterAbi,
  usdgPerEth,
  usdgSwapNeeds,
  v4QuoterAbi,
  weiToUsd6,
  withSlippage,
} from './fund-swap';
import { describeFundRevert, humanizeFundError, revertDataOf } from './fund-errors';
import { SPARE } from './addresses';
import { formatToken } from '../spare';

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;
/** UniversalRouter 2.1.x ExactInputSingleParams — 6 fields, minHopPriceX36 before hookData. */
const exactInSingleParams = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: poolKeyComponents },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'minHopPriceX36', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;
const addrUint = [{ type: 'address' }, { type: 'uint256' }] as const;
const addrAddrUint = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const;

function decodeExecute(data: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data });
  expect(functionName).toBe('execute');
  const [commands, inputs, deadline] = args as readonly [Hex, readonly Hex[], bigint];
  return { commands, inputs, deadline };
}

function decodeV4(input: Hex) {
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], input);
  return { actions, params };
}

const ONE_ETH = 10n ** 18n;

/* ------------------------------ fee / minOut ------------------------------ */

describe('fee and minimum-out math', () => {
  it('matches the router: fee = floor(gross * bps / 1e4), min = floor(net * (1e4 - slip) / 1e4)', () => {
    // The mainnet eth_call from recon: 0.01 ETH -> 26.667754 USDG gross, 25 bps, 50 bps slippage.
    const q = splitQuote(10n ** 16n, 26_667_754n, 25, 50);
    expect(q.fee).toBe(66_669n);
    expect(q.netOut).toBe(26_601_085n);
    expect(q.minAmountOut).toBe(26_468_079n);
    expect(q.fee + q.netOut).toBe(q.grossOut);
  });

  it('rounds the fee down, so a tiny swap pays 0 fee', () => {
    expect(feeOf(399n, 25)).toBe(0n);
    expect(feeOf(400n, 25)).toBe(1n);
    expect(feeOf(1_000_000n, 0)).toBe(0n);
  });

  it('withSlippage never loosens the floor and rejects bad bps', () => {
    expect(withSlippage(1_000_000n, 0)).toBe(1_000_000n);
    expect(withSlippage(1_000_000n, 50)).toBe(995_000n);
    expect(withSlippage(999n, 50)).toBe(994n); // 994.005 -> 994
    expect(() => withSlippage(1n, 10_000)).toThrow();
    expect(() => withSlippage(1n, -1)).toThrow();
    expect(() => withSlippage(1n, 0.5)).toThrow();
  });

  it('splitQuote refuses a fee above the cap', () => {
    expect(() => splitQuote(1n, 100n, MAX_FUND_FEE_BPS + 1, 50)).toThrow();
  });
});

describe('parseFundFeeBps (VITE_SPARE_FUND_FEE_BPS)', () => {
  it('defaults to 25 and clamps to 0..100', () => {
    expect(FUND_FEE_BPS).toBe(25);
    expect(MAX_FUND_FEE_BPS).toBe(100);
    expect(parseFundFeeBps(undefined)).toBe(25);
    expect(parseFundFeeBps('')).toBe(25);
    expect(parseFundFeeBps('abc')).toBe(25);
    expect(parseFundFeeBps('2.5')).toBe(25);
    expect(parseFundFeeBps('0')).toBe(0);
    expect(parseFundFeeBps(' 30 ')).toBe(30);
    expect(parseFundFeeBps('100')).toBe(100);
    expect(parseFundFeeBps('250')).toBe(100);
    expect(parseFundFeeBps('-5')).toBe(0);
  });
});

describe('gas reserve and coverage', () => {
  it('Max leaves 0.0003 ETH and never goes negative', () => {
    expect(ETH_GAS_RESERVE_WEI).toBe(300_000_000_000_000n);
    expect(maxEthSwapIn(ONE_ETH)).toBe(ONE_ETH - ETH_GAS_RESERVE_WEI);
    expect(maxEthSwapIn(ETH_GAS_RESERVE_WEI)).toBe(0n);
    expect(maxEthSwapIn(1n)).toBe(0n);
    expect(maxEthSwapIn(0n)).toBe(0n);
  });

  it('counts whole transactions at a gas price', () => {
    // 0.0003 ETH at 0.024 gwei * 250k gas = 6e12 wei per tx -> 50 txs
    expect(txsCovered(ETH_GAS_RESERVE_WEI, 24_000_000n, 250_000n)).toBe(50n);
    expect(txsCovered(0n, 24_000_000n)).toBe(0n);
    expect(txsCovered(ONE_ETH, 0n)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('parses decimal text exactly', () => {
    expect(parseAmount('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAmount('0.0003', 18)).toBe(ETH_GAS_RESERVE_WEI);
    expect(parseAmount('.5', 6)).toBe(500_000n);
    expect(parseAmount('2.', 6)).toBe(2_000_000n);
    expect(parseAmount(' 3 ', 6)).toBe(3_000_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
    expect(parseAmount('0', 6)).toBe(0n);
  });

  it('rejects anything that is not a plain non-negative decimal within precision', () => {
    for (const bad of ['', '.', 'abc', '1e5', '-1', '1,000', '1.2.3', '0x10', '1 000']) {
      expect(parseAmount(bad, 6)).toBeNull();
    }
    expect(parseAmount('0.0000001', 6)).toBeNull();
  });
});

describe('price helpers', () => {
  it('pool price in USDG (6 dp) per ETH, both directions', () => {
    expect(usdgPerEth(10n ** 16n, 26_667_754n, true)).toBe(2_666_775_400n);
    // 20 USDG -> 7,471,620,926,399,896 wei -> ≈ $2,676.80/ETH
    expect(usdgPerEth(20_000_000n, 7_471_620_926_399_896n, false)).toBe(2_676_795_329n);
    expect(usdgPerEth(0n, 1n, true)).toBeNull();
  });

  it('Chainlink 8 dp -> 6 dp, and the edge is signed from the user side', () => {
    const ref = feedToUsd6(266_727_000_000n, 8);
    expect(ref).toBe(2_667_270_000n);
    // selling ETH below the reference is worse (negative)
    expect(edgeVsReferenceBps(2_640_597_300n, ref, true)).toBe(-100);
    // buying ETH above the reference is worse (negative)
    expect(edgeVsReferenceBps(2_693_942_700n, ref, false)).toBe(-100);
    expect(edgeVsReferenceBps(2_693_942_700n, ref, true)).toBe(100);
    expect(weiToUsd6(ONE_ETH / 100n, ref)).toBe(26_672_700n);
  });
});

/* --------------------------------- builders -------------------------------- */

describe('buildEthToUsdg calldata', () => {
  const amountIn = 10n ** 16n;
  const minAmountOut = 26_468_079n;

  it('is execute(0x10 V4_SWAP) with value = amountIn and a ~10 min deadline', () => {
    const now = Math.floor(Date.now() / 1000);
    const tx = buildEthToUsdg({ amountIn, minAmountOut });
    expect(tx.to).toBe(UNIVERSAL_ROUTER);
    expect(tx.value).toBe(amountIn);
    const { commands, inputs, deadline } = decodeExecute(tx.data);
    expect(commands).toBe('0x10');
    expect(inputs).toHaveLength(1);
    expect(FUND_SWAP_DEADLINE_SECONDS).toBe(600);
    expect(Number(deadline) - now).toBeGreaterThanOrEqual(599);
    expect(Number(deadline) - now).toBeLessThanOrEqual(601);
  });

  it('encodes SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_PORTION(FeeVault), TAKE_ALL(min)', () => {
    const tx = buildEthToUsdg({ amountIn, minAmountOut, feeBps: 25, deadline: 123n });
    const { inputs, deadline } = decodeExecute(tx.data);
    expect(deadline).toBe(123n);
    const { actions, params } = decodeV4(inputs[0]);
    expect(actions).toBe('0x060c100f');
    expect(params).toHaveLength(4);

    // the swap params are ONE dynamic tuple: first word is the 0x20 offset
    expect(params[0].slice(0, 66)).toBe(`0x${'20'.padStart(64, '0')}`);
    const [swap] = decodeAbiParameters(exactInSingleParams, params[0]);
    expect(swap.poolKey).toEqual({ ...ETH_USDG_POOL });
    expect(swap.poolKey.currency0).toBe(zeroAddress);
    expect(swap.poolKey.currency1).toBe(USDG);
    expect(swap.poolKey.fee).toBe(500);
    expect(swap.poolKey.tickSpacing).toBe(10);
    expect(swap.zeroForOne).toBe(true);
    expect(swap.amountIn).toBe(amountIn);
    expect(swap.amountOutMinimum).toBe(0n); // the floor is on the NET amount, in TAKE_ALL
    expect(swap.minHopPriceX36).toBe(0n);
    expect(swap.hookData).toBe('0x');

    expect(decodeAbiParameters(addrUint, params[1])).toEqual([zeroAddress, amountIn]);
    expect(decodeAbiParameters(addrAddrUint, params[2])).toEqual([USDG, FEE_VAULT, 25n]);
    expect(decodeAbiParameters(addrUint, params[3])).toEqual([USDG, minAmountOut]);
  });

  it('pays the MAINNET FeeVault by default and a custom recipient when given', () => {
    expect(FEE_VAULT).toBe(getAddress('0xF5B9C500998D122fbBB606f23DBEe91Aa5549add'));
    expect(FEE_VAULT).toBe(SPARE.FeeVault);
    const other = getAddress('0x8DEf6bFE85c90B4412932e060A893ba864B031F7');
    const { inputs } = decodeExecute(buildEthToUsdg({ amountIn, minAmountOut, feeRecipient: other }).data);
    const { params } = decodeV4(inputs[0]);
    expect(decodeAbiParameters(addrAddrUint, params[2])[1]).toBe(other);
  });

  it('drops TAKE_PORTION when the fee is 0', () => {
    const { inputs } = decodeExecute(buildEthToUsdg({ amountIn, minAmountOut, feeBps: 0 }).data);
    const { actions, params } = decodeV4(inputs[0]);
    expect(actions).toBe('0x060c0f');
    expect(params).toHaveLength(3);
  });

  it('refuses unsafe parameters', () => {
    expect(() => buildEthToUsdg({ amountIn, minAmountOut: 0n })).toThrow(/slippage/);
    expect(() => buildEthToUsdg({ amountIn: 0n, minAmountOut })).toThrow();
    expect(() => buildEthToUsdg({ amountIn, minAmountOut, feeBps: 101 })).toThrow();
    expect(() => buildEthToUsdg({ amountIn, minAmountOut, feeBps: 2.5 })).toThrow();
    expect(() => buildEthToUsdg({ amountIn, minAmountOut, feeBps: -1 })).toThrow();
    expect(() => buildEthToUsdg({ amountIn, minAmountOut, poolKey: { ...ETH_USDG_POOL, currency0: USDG } })).toThrow();
  });
});

describe('buildUsdgToEth calldata', () => {
  const amountIn = 20_000_000n;
  const minAmountOut = 7_400_000_000_000_000n;

  it('is execute(0x10 V4_SWAP, 0x0b WRAP_ETH) with value 0; the fee ETH parks on the router then wraps to FeeVault', () => {
    const tx = buildUsdgToEth({ amountIn, minAmountOut, feeBps: 25 });
    expect(tx.to).toBe(UNIVERSAL_ROUTER);
    expect(tx.value).toBe(0n);
    const { commands, inputs } = decodeExecute(tx.data);
    expect(commands).toBe('0x100b');
    const { actions, params } = decodeV4(inputs[0]);
    expect(actions).toBe('0x060c100f');
    const [swap] = decodeAbiParameters(exactInSingleParams, params[0]);
    expect(swap.zeroForOne).toBe(false);
    expect(swap.amountIn).toBe(amountIn);
    expect(decodeAbiParameters(addrUint, params[1])).toEqual([USDG, amountIn]);
    expect(decodeAbiParameters(addrAddrUint, params[2])).toEqual([zeroAddress, ADDRESS_THIS, 25n]);
    expect(decodeAbiParameters(addrUint, params[3])).toEqual([zeroAddress, minAmountOut]);
    expect(decodeAbiParameters(addrUint, inputs[1])).toEqual([FEE_VAULT, CONTRACT_BALANCE]);
  });

  it('has no TAKE_PORTION / WRAP_ETH at fee 0', () => {
    const { commands, inputs } = decodeExecute(buildUsdgToEth({ amountIn, minAmountOut, feeBps: 0 }).data);
    expect(commands).toBe('0x10');
    expect(decodeV4(inputs[0]).actions).toBe('0x060c0f');
  });

  it('prepends PERMIT2_PERMIT for a signed permit and checks it', () => {
    const permitSingle = {
      details: { token: USDG, amount: amountIn, expiration: 2_000_000_000, nonce: 3 },
      spender: UNIVERSAL_ROUTER,
      sigDeadline: 2_000_000_000n,
    };
    const signature = `0x${'11'.repeat(65)}` as Hex;
    const { commands, inputs } = decodeExecute(buildUsdgToEth({ amountIn, minAmountOut, permit: { permitSingle, signature } }).data);
    expect(commands).toBe('0x0a100b');
    expect(inputs[0].slice(2 + 64 * 6, 2 + 64 * 7)).toBe('e0'.padStart(64, '0')); // six static words, then the bytes offset
    expect(() => buildUsdgToEth({ amountIn, minAmountOut, permit: { permitSingle: { ...permitSingle, spender: FEE_VAULT }, signature } })).toThrow();
    expect(() =>
      buildUsdgToEth({ amountIn, minAmountOut, permit: { permitSingle: { ...permitSingle, details: { ...permitSingle.details, amount: 1n } }, signature } }),
    ).toThrow();
  });
});

describe('approvals', () => {
  it('USDG.approve(Permit2, max) by default', () => {
    const tx = buildUsdgApprovePermit2Tx();
    expect(tx.to).toBe(USDG);
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(functionName).toBe('approve');
    expect(args).toEqual([PERMIT2, maxUint256]);
  });

  it('Permit2.approve(USDG, router, EXACT amount, short expiry)', () => {
    const tx = buildPermit2ApproveRouterTx(20_000_000n, 1_900_000_000);
    expect(tx.to).toBe(PERMIT2);
    const { functionName, args } = decodeFunctionData({ abi: permit2Abi, data: tx.data });
    expect(functionName).toBe('approve');
    expect(args).toEqual([USDG, UNIVERSAL_ROUTER, 20_000_000n, 1_900_000_000]);
    expect(() => buildPermit2ApproveRouterTx(0n)).toThrow();
    expect(() => buildPermit2ApproveRouterTx(1n, 2 ** 48)).toThrow();
  });

  it('usdgSwapNeeds reuses a covering approval and wants an allowance that outlives the deadline', () => {
    const now = 1_000_000;
    const base = { erc20Allowance: maxUint256, permit2Amount: 0n, permit2Expiration: 0, permit2Nonce: 0 };
    expect(usdgSwapNeeds(base, 5n, now)).toEqual({ erc20Approve: false, permit2Allowance: true });
    expect(usdgSwapNeeds({ ...base, erc20Allowance: 4n }, 5n, now).erc20Approve).toBe(true);
    const live = { ...base, permit2Amount: 5n, permit2Expiration: now + 3600 };
    expect(usdgSwapNeeds(live, 5n, now)).toEqual({ erc20Approve: false, permit2Allowance: false });
    expect(usdgSwapNeeds(live, 6n, now).permit2Allowance).toBe(true);
    // expires inside the swap deadline window -> re-approve
    expect(usdgSwapNeeds({ ...live, permit2Expiration: now + 60 }, 5n, now).permit2Allowance).toBe(true);
  });
});

/* ---------------------------------- quote ---------------------------------- */

describe('quoteEthToUsdg', () => {
  it('eth_calls the V4Quoter with the pool key and applies fee + slippage', async () => {
    const call = vi.fn().mockResolvedValue({
      data: encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [26_667_754n, 42_557n] }),
    });
    const q = await quoteEthToUsdg({ call } as never, 10n ** 16n, { feeBps: 25, slippageBps: 50 });
    expect(q).toMatchObject({ grossOut: 26_667_754n, fee: 66_669n, netOut: 26_601_085n, minAmountOut: 26_468_079n, gasEstimate: 42_557n });
    const arg = call.mock.calls[0][0] as { to: string; data: Hex };
    expect(arg.to).toBe(V4_QUOTER);
    const { args } = decodeFunctionData({ abi: v4QuoterAbi, data: arg.data });
    expect(args[0]).toMatchObject({ zeroForOne: true, exactAmount: 10n ** 16n, hookData: '0x' });
    expect(args[0].poolKey).toEqual({ ...ETH_USDG_POOL });
  });
});

/* --------------------------------- errors ---------------------------------- */

describe('fund swap error decoding', () => {
  const tooLittle = encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'V4TooLittleReceived', args: [26_601_086n, 26_601_085n] });

  it('finds revert bytes deep in a viem-style cause chain', () => {
    const err = { shortMessage: 'x', cause: { name: 'ExecutionRevertedError', cause: { name: 'RpcRequestError', data: tooLittle } } };
    expect(revertDataOf(err)).toBe(tooLittle);
    expect(humanizeFundError(err, { outSymbol: 'USDG', outDecimals: 6 })).toMatch(/pay you 26\.601085 USDG, below your minimum of 26\.601086 USDG/);
  });

  it('prints ETH amounts at full precision when the short form would read the same', () => {
    const eth = encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'V4TooLittleReceived', args: [7_451_839_719_296_502n, 7_451_839_719_296_501n] });
    expect(describeFundRevert(eth, { outSymbol: 'ETH', outDecimals: 18 })).toMatch(/pay you 0\.007451839719296501 ETH, below your minimum of 0\.007451839719296502 ETH/);
    const far = encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'V4TooLittleReceived', args: [8_000_000_000_000_000n, 7_451_839_719_296_501n] });
    expect(describeFundRevert(far, { outSymbol: 'ETH', outDecimals: 18 })).toMatch(/pay you 0\.00745184 ETH, below your minimum of 0\.008 ETH/);
  });

  it('unwraps ExecutionFailed and WrappedError', () => {
    const invalidNonce = encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'InvalidNonce' });
    const wrapped = encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'ExecutionFailed', args: [0n, invalidNonce] });
    expect(describeFundRevert(wrapped)).toMatch(/already used/);

    const expired = encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'AllowanceExpired', args: [0n] });
    const inner = encodeErrorResult({
      abi: fundSwapErrorsAbi, errorName: 'WrappedError',
      args: [PERMIT2, '0x36c78516', expired, '0x'],
    });
    expect(describeFundRevert(inner)).toMatch(/no live Permit2 allowance/);

    const transferFailed = `0x08c379a0${encodeAbiParameters([{ type: 'string' }], ['TRANSFER_FROM_FAILED']).slice(2)}` as Hex;
    expect(describeFundRevert(transferFailed)).toMatch(/could not pull your USDG/);
  });

  it('decodes the deadline and falls back for unknown data', () => {
    expect(describeFundRevert(encodeErrorResult({ abi: fundSwapErrorsAbi, errorName: 'TransactionDeadlinePassed' }))).toMatch(/deadline passed/);
    expect(describeFundRevert('0xdeadbeef')).toBeNull();
    expect(humanizeFundError(new Error('boom'))).toBe('boom');
  });
});

/* ------------------------- gas line (Readiness = swap) ------------------------- */

describe('one gas line for Readiness and the swap reserve', () => {
  it('is max(0.0003 ETH, 10 SPARE transactions at the live price), the floor while unknown', () => {
    expect(GAS_RESERVE_TXS).toBe(10n);
    expect(gasReserveWei(undefined)).toBe(ETH_GAS_RESERVE_WEI);
    expect(gasReserveWei(null)).toBe(ETH_GAS_RESERVE_WEI);
    expect(gasReserveWei(0n)).toBe(ETH_GAS_RESERVE_WEI);
    // 0.024 gwei: 10 x 250k x 0.024 gwei = 0.00006 ETH < floor
    expect(gasReserveWei(24_000_000n)).toBe(ETH_GAS_RESERVE_WEI);
    // 1 gwei: 10 x 250k x 1 gwei = 0.0025 ETH > floor
    expect(gasReserveWei(1_000_000_000n)).toBe(10n * SPARE_TX_GAS * 1_000_000_000n);
  });

  it('a wallet that reads OK always has something to swap (0.0002 ETH reads LOW, not "OK, nothing to swap")', () => {
    const gp = 24_000_000n;
    const twoTenK = 200_000_000_000_000n; // 0.0002 ETH
    expect(twoTenK <= gasReserveWei(gp)).toBe(true); // LOW, not OK
    expect(maxEthSwapIn(twoTenK, gasReserveWei(gp))).toBe(0n);
  });

  it('only offers ETH -> USDG when the swappable ETH is worth ~$1', () => {
    const ref = 2_667_270_000n;
    expect(ethSwapIsMeaningful(0n, ref)).toBe(false);
    expect(ethSwapIsMeaningful(10n ** 13n, ref)).toBe(false); // 0.00001 ETH ≈ $0.03
    expect(ethSwapIsMeaningful(4n * 10n ** 14n, ref)).toBe(true); // 0.0004 ETH ≈ $1.07
    expect(ethSwapIsMeaningful(4n * 10n ** 14n, undefined)).toBe(false); // no price: 0.0005 ETH floor
    expect(ethSwapIsMeaningful(5n * 10n ** 14n, undefined)).toBe(true);
  });

  it('USDG -> ETH gas counts the approvals it needs, with a 2x wallet margin', () => {
    const none = { erc20Approve: false, permit2Allowance: false };
    const all = { erc20Approve: true, permit2Allowance: true };
    expect(usdgToEthGas(none)).toBe(FUND_GAS.usdgToEth);
    expect(usdgToEthGas(all)).toBe(FUND_GAS.usdgToEth + FUND_GAS.approveUsdgToPermit2 + FUND_GAS.permit2ApproveRouter);
    expect(usdgToEthTxCount(none)).toBe(1);
    expect(usdgToEthTxCount(all)).toBe(3);
    expect(GAS_SAFETY_MULTIPLIER).toBe(2n);
    // a wallet holding 0.0000027 ETH cannot afford a top-up at 0.024 gwei
    const need = usdgToEthEthNeeded(24_000_000n, { erc20Approve: false, permit2Allowance: true });
    expect(need).toBe((250_000n + 70_000n) * 24_000_000n * 2n);
    expect(2_700_000_000_000n < need).toBe(true);
    expect(usdgToEthEthNeeded(24_000_000n)).toBe(usdgToEthGas(all) * 24_000_000n * 2n); // default: worst case
  });
});

/* ------------------------------- display floor ------------------------------- */

describe('floorToDp (minimums never display above what is enforced)', () => {
  it('rounds down, so an 8 dp ETH minimum never reads high', () => {
    const enforced = 7_411_005_000_000_000n; // 0.007411005 ETH
    expect(formatToken(enforced, 18, 8)).toBe('0.00741101'); // half-up overstates
    const shown = floorToDp(enforced, 18, 8);
    expect(shown).toBe(7_411_000_000_000_000n);
    expect(formatToken(shown, 18, 8)).toBe('0.007411');
    expect(shown <= enforced).toBe(true);
    expect(floorToDp(26_468_079n, 6, 6)).toBe(26_468_079n); // USDG at full precision: untouched
    expect(floorToDp(0n, 18, 8)).toBe(0n);
  });
});

/* -------------------------------- price guards -------------------------------- */

describe('checkSwapPrice fails closed', () => {
  const now = 1_790_747_107;
  const ref = { usd6: 2_667_270_000n, updatedAt: now - 60 };
  // 0.01 ETH -> 26.683 USDG and a 0.001 ETH probe at the same price
  const fill = { amountIn: 10n ** 16n, grossOut: 26_683_000n };
  const probe = { amountIn: IMPACT_PROBE_ETH_WEI, grossOut: 2_668_300n };

  it('passes a normal fill with a fresh reference', () => {
    const c = checkSwapPrice({ zeroForOne: true, fill, probe, ref, now });
    expect(c.block).toBeNull();
    expect(c.poolUsd6).toBe(2_668_300_000n);
    expect(c.impactBps).toBe(0);
    expect(c.edgeBps).toBe(3);
    expect(c.refAgeSec).toBe(60);
  });

  it('blocks when the Chainlink answer is missing, in both directions', () => {
    expect(checkSwapPrice({ zeroForOne: true, fill, probe, ref: undefined, now }).block).toMatch(/unavailable/);
    const buyFill = { amountIn: 20_000_000n, grossOut: 7_495_000_000_000_000n };
    const buyProbe = { amountIn: IMPACT_PROBE_USDG, grossOut: 374_750_000_000_000n };
    expect(checkSwapPrice({ zeroForOne: false, fill: buyFill, probe: buyProbe, ref: null, now }).block).toMatch(/unavailable/);
  });

  it('blocks a stale answer (past the 24 h heartbeat + 1 h) but accepts the 5.4 h-old one seen on mainnet', () => {
    expect(CHAINLINK_MAX_AGE_SECONDS).toBe(90_000);
    const mainnet = { usd6: ref.usd6, updatedAt: 1_790_727_688 }; // 5.4 h before now
    expect(checkSwapPrice({ zeroForOne: true, fill, probe, ref: mainnet, now }).block).toBeNull();
    const stale = { usd6: ref.usd6, updatedAt: now - CHAINLINK_MAX_AGE_SECONDS - 1 };
    const c = checkSwapPrice({ zeroForOne: true, fill, probe, ref: stale, now });
    expect(c.block).toMatch(/25\.0 h old/);
    expect(c.edgeBps).toBeNull();
  });

  it('blocks the pool more than 5% below Chainlink', () => {
    expect(PRICE_BLOCK_BPS).toBe(500);
    const bad = { amountIn: 10n ** 16n, grossOut: 25_000_000n }; // $2,500 vs $2,667
    const badProbe = { amountIn: IMPACT_PROBE_ETH_WEI, grossOut: 2_500_000n };
    expect(checkSwapPrice({ zeroForOne: true, fill: bad, probe: badProbe, ref, now }).block).toMatch(/less than Chainlink/);
  });

  it('blocks > 3% price impact with NO feed involved — the 100 ETH fork fill', () => {
    expect(IMPACT_BLOCK_BPS).toBe(300);
    // fork, block 76275543: 100 ETH -> 156,379.317879 USDG (≈ $1,564/ETH) vs ≈ $2,668 for a tiny trade
    const whale = { amountIn: 100n * 10n ** 18n, grossOut: 156_379_317_879n };
    for (const r of [undefined, ref]) {
      const c = checkSwapPrice({ zeroForOne: true, fill: whale, probe, ref: r, now });
      expect(c.block).toMatch(/moves the pool price/);
      expect(c.impactBps).toBeGreaterThan(4000);
    }
  });

  it('blocks when the probe quote is missing', () => {
    expect(checkSwapPrice({ zeroForOne: true, fill, probe: null, ref, now }).block).toMatch(/small reference trade/);
  });

  it('measures impact from the user side when buying ETH', () => {
    // 1 USDG -> 0.0003748 ETH (≈ $2,668/ETH); 500 USDG -> 0.178 ETH (≈ $2,809/ETH): ~5% worse
    const p = { amountIn: IMPACT_PROBE_USDG, grossOut: 374_800_000_000_000n };
    const f = { amountIn: 500_000_000n, grossOut: 178_000_000_000_000_000n };
    const c = checkSwapPrice({ zeroForOne: false, fill: f, probe: p, ref, now });
    expect(c.impactBps).toBeGreaterThan(IMPACT_BLOCK_BPS);
    expect(c.block).toMatch(/moves the pool price/);
  });

  it('reads a latestRoundData tuple into a reference', () => {
    expect(referenceFromRound([1n, 266_727_000_000n, 1n, 1_790_727_688n, 1n])).toEqual({ usd6: 2_667_270_000n, updatedAt: 1_790_727_688 });
    expect(referenceFromRound([1n, 0n, 1n, 1n, 1n])).toBeUndefined();
    expect(referenceFromRound([1n, -5n, 1n, 1n, 1n])).toBeUndefined();
    expect(referenceFromRound(undefined)).toBeUndefined();
  });
});

describe('quoteWithProbe / readEthUsdReference', () => {
  const quoterResult = (amountOut: bigint) => ({
    data: encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [amountOut, 40_000n] }),
  });

  it('quotes the amount and a 0.001 ETH probe in parallel; a tiny amount is its own probe', async () => {
    const call = vi.fn(async ({ data }: { data: Hex }) => {
      const { args } = decodeFunctionData({ abi: v4QuoterAbi, data });
      return quoterResult((args[0].exactAmount * 2_668n) / 10n ** 12n);
    });
    const { q, probe } = await quoteWithProbe({ call } as never, true, 10n ** 16n, { feeBps: 25, slippageBps: 50 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(q.amountIn).toBe(10n ** 16n);
    expect(probe).toEqual({ amountIn: IMPACT_PROBE_ETH_WEI, grossOut: 2_668_000n });

    call.mockClear();
    const small = await quoteWithProbe({ call } as never, true, IMPACT_PROBE_ETH_WEI);
    expect(call).toHaveBeenCalledTimes(1);
    expect(small.probe).toEqual({ amountIn: small.q.amountIn, grossOut: small.q.grossOut });
  });

  it('reads Chainlink and refuses a non-positive answer', async () => {
    const roundAbi = [
      {
        type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [],
        outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
      },
    ] as const;
    const answer = (a: bigint) => ({
      data: encodeFunctionResult({ abi: roundAbi, functionName: 'latestRoundData', result: [7n, a, 1n, 1_790_727_688n, 7n] }),
    });
    const call = vi.fn().mockResolvedValue(answer(266_727_000_000n));
    await expect(readEthUsdReference({ call } as never)).resolves.toEqual({ usd6: 2_667_270_000n, updatedAt: 1_790_727_688 });
    expect((call.mock.calls[0][0] as { to: string }).to).toBe(CHAINLINK_ETH_USD);
    call.mockResolvedValue(answer(0n));
    await expect(readEthUsdReference({ call } as never)).rejects.toThrow(/no usable price/);
  });
});

/* ------------------- USDG -> Permit2 approval vs round-up consent ------------------- */

describe('usdgApprovalForSwap never silently re-enables round-up pulls', () => {
  const now = 1_000_000;
  it('is unlimited when the Permit2 -> SweepExecutor leg is empty or expired', () => {
    expect(usdgApprovalForSwap(0n, 5_000_000n, { amount: 0n, expiration: 0 }, now)).toEqual({ amount: maxUint256, sized: false });
    expect(usdgApprovalForSwap(0n, 5_000_000n, { amount: 50_000_000n, expiration: now - 1 }, now)).toEqual({ amount: maxUint256, sized: false });
  });

  it('is sized to the swap while that leg is live (PARTIAL) or unknown', () => {
    const live = { amount: 50_000_000n, expiration: now + 30 * 86_400 };
    expect(usdgApprovalForSwap(0n, 5_000_000n, live, now)).toEqual({ amount: 5_000_000n, sized: true });
    expect(usdgApprovalForSwap(0n, 5_000_000n, undefined, now)).toEqual({ amount: 5_000_000n, sized: true });
    // LOW ALLOWANCE: 2 USDG left for pulls -> approve 2 + 5, the swap spends 5, pulls keep 2
    expect(usdgApprovalForSwap(2_000_000n, 5_000_000n, live, now)).toEqual({ amount: 7_000_000n, sized: true });
  });

  it('readUsdgPermit2State also reads the SweepExecutor leg', async () => {
    const me = getAddress('0x8DEf6bFE85c90B4412932e060A893ba864B031F7');
    const call = vi.fn(async ({ to, data }: { to: string; data: Hex }) => {
      if (getAddress(to) === getAddress(USDG)) return { data: encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: 0n }) };
      const { args } = decodeFunctionData({ abi: permit2Abi, data });
      const spender = getAddress(args[2] as string);
      const r: readonly [bigint, number, number] = spender === getAddress(SPARE.SweepExecutor) ? [50_000_000n, 2_000_000_000, 1] : [0n, 0, 4];
      return { data: encodeFunctionResult({ abi: permit2Abi, functionName: 'allowance', result: r }) };
    });
    const st = await readUsdgPermit2State({ call } as never, me);
    expect(call).toHaveBeenCalledTimes(3);
    expect(st).toMatchObject({ erc20Allowance: 0n, permit2Amount: 0n, permit2Nonce: 4, sweep: { amount: 50_000_000n, expiration: 2_000_000_000 } });
    expect(usdgApprovalForSwap(st.erc20Allowance, 5_000_000n, st.sweep, now).sized).toBe(true);
  });
});
