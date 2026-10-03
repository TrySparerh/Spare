/**
 * "Fund your wallet" swaps on Robinhood Chain (4663): native ETH <-> USDG through
 * the Uniswap Universal Router, with SPARE's fee taken from the OUTPUT and paid to
 * FeeVault in the SAME transaction, and a hard minimum on what the user receives.
 *
 * Router: UniversalRouter at 0x8876…0904. eip712Domain() = ("UniversalRouter", "2"),
 * and it exposes executeSigned/SPOKE_POOL but not PERMISSIONS_ADAPTER_FACTORY, so it
 * is release 2.1.1/2.1.2. Its v4-periphery ExactInputSingleParams has the extra
 * `minHopPriceX36` field (before hookData) — the pre-2.1 5-field layout does NOT decode.
 *
 * ETH -> USDG   execute(0x10 V4_SWAP), msg.value = amountIn
 *   SWAP_EXACT_IN_SINGLE(ETH/USDG 500/10, zeroForOne = true, amountIn)
 *   SETTLE_ALL(ETH, amountIn)            router pays the PoolManager out of msg.value
 *   TAKE_PORTION(USDG, FeeVault, bps)    fee = floor(grossOut * bps / 10_000) -> FeeVault
 *   TAKE_ALL(USDG, minOut)               the rest -> msg.sender; < minOut reverts V4TooLittleReceived
 *
 * USDG -> ETH   execute([0x0a PERMIT2_PERMIT,] 0x10 V4_SWAP, 0x0b WRAP_ETH), value = 0
 *   SWAP_EXACT_IN_SINGLE(zeroForOne = false, amountIn)
 *   SETTLE_ALL(USDG, amountIn)           Permit2.transferFrom(user -> PoolManager)
 *   TAKE_PORTION(ETH, router, bps)       fee ETH parked on the router
 *   TAKE_ALL(ETH, minOut)                native ETH -> msg.sender
 *   WRAP_ETH(FeeVault, CONTRACT_BALANCE) FeeVault has no receive(): native ETH to it
 *                                        reverts, so the fee lands as WETH (withdrawable
 *                                        with FeeVault.withdraw(WETH, to, amount)).
 *
 *   CONTRACT_BALANCE wraps the router's WHOLE native balance, not just the fee: ETH that
 *   someone else stranded on the router before this call goes to FeeVault too (fork-tested:
 *   0.001 ETH on the router -> FeeVault +0.001 WETH + the fee). The user is unaffected —
 *   TAKE_ALL already paid them — and the fee is only known on-chain, so this is the
 *   practical encoding. It does mean FeeVault's WETH balance is NOT "sum of fees": count
 *   SPARE's swap income from each receipt (the TAKE_PORTION amount, i.e. PoolManager ->
 *   router ETH less router -> user ETH), never from FeeVault's balance.
 *
 * The calldata never names the user: TAKE_ALL pays the router's msgSender(), i.e. whoever
 * sends the transaction. Only the optional PERMIT2_PERMIT carries a user signature.
 *
 * USDG -> ETH needs, once per wallet, USDG.approve(Permit2, max) and then EITHER an on-chain
 * Permit2.approve(USDG, router, amount, expiration) OR a signed PermitSingle passed as
 * `permit` (prepends PERMIT2_PERMIT; no extra transaction). The Fund Wallet app uses the
 * on-chain approval for EXACTLY the swap amount with a short expiry. When the wallet still
 * has a live Permit2 -> SweepExecutor allowance, the USDG -> Permit2 approval is sized to
 * the swap instead of unlimited (usdgApprovalForSwap), so a gas top-up never silently
 * switches round-up pulls back on.
 *
 * Price guards (checkSwapPrice) fail CLOSED: a swap needs a fresh Chainlink ETH/USD answer
 * (within the feed's 24 h heartbeat) within PRICE_BLOCK_BPS of the pool, AND a price impact
 * under IMPACT_BLOCK_BPS against a tiny probe quote in the same pool — that second check
 * does not depend on the feed at all.
 *
 * Everything here is bigint base units: wei for ETH, 6 dp for USDG, integer bps.
 * Pure apart from the eth_call quote helpers — no React, importable from scripts.
 */
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  maxUint256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import i18next from 'i18next';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID } from './addresses';

// The price-guard sentences live in the shell namespace (`fundGuard.*`) and are built
// when a check runs, so they come out in the live language. i18next directly, not
// '@/i18n' (Vite-only): scripts/fund-swap-fork.ts imports this file under bun.
const tf = i18next.getFixedT(null, 'shell');

/* ------------------------------- addresses -------------------------------- */

/** Uniswap Universal Router 2.1.x on Robinhood Chain. */
export const UNIVERSAL_ROUTER: Address = getAddress('0x8876789976decbfcbbbe364623c63652db8c0904');
/** Uniswap v4 V4Quoter (quote via eth_call; it reverts internally, never send it a tx). */
export const V4_QUOTER: Address = getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94');
/** WETH9 — the router's immutable WETH (embedded in its bytecode). */
export const WETH: Address = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
/** Chainlink ETH / USD on Robinhood Chain — a REFERENCE price for the UI only, never used to execute. */
export const CHAINLINK_ETH_USD: Address = getAddress('0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9');
/** decimals() of CHAINLINK_ETH_USD (read on-chain 2026-09-30). */
export const CHAINLINK_ETH_USD_DECIMALS = 8;
/**
 * CHAINLINK_ETH_USD's heartbeat. Scanning all 2,496 rounds on 2026-09-30, the longest gap
 * between updates was 24.01 h (six gaps of 24.00–24.01 h); otherwise it updates on a move.
 */
export const CHAINLINK_ETH_USD_HEARTBEAT_SECONDS = 86_400;
/** An answer older than the heartbeat plus 1 h of grace is stale: swaps refuse to use it. */
export const CHAINLINK_MAX_AGE_SECONDS = CHAINLINK_ETH_USD_HEARTBEAT_SECONDS + 3_600;
export const USDG: Address = EXTERNAL.USDG;
export const PERMIT2: Address = EXTERNAL.Permit2;
/** Default fee recipient (SPARE FeeVault). */
export const FEE_VAULT: Address = SPARE.FeeVault;
/** v4 native currency. */
export const NATIVE_ETH: Address = zeroAddress;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  /** Pool LP fee in hundredths of a bip (500 = 0.05%). */
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Native ETH / USDG, 0.05%, no hook — the deepest ETH/USDG pool (fee 100 / ts 1 is close). */
export const ETH_USDG_POOL: PoolKey = {
  currency0: NATIVE_ETH,
  currency1: USDG,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
};

/* ------------------------------- constants -------------------------------- */

/** Universal Router command bytes (contracts/libraries/Commands.sol @ 2.1.x). */
export const Commands = {
  SWEEP: 0x04,
  PAY_PORTION: 0x06,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

/** v4-periphery Actions.sol. */
export const Actions = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
} as const;

/** ActionConstants: recipient placeholders and special amount values. */
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
export const CONTRACT_BALANCE = 1n << 255n;

/** Default SPARE fund-swap fee on the output, in bps (25 = 0.25%). */
export const FUND_FEE_BPS = 25;
/** Hard ceiling (1%). The env value is clamped to it and the builders refuse anything above. */
export const MAX_FUND_FEE_BPS = 100;
/** Default slippage tolerance applied to the quoted NET output. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Default execute() deadline from now. */
export const FUND_SWAP_DEADLINE_SECONDS = 10 * 60;
/** Lifetime of the exact-amount Permit2 allowance the app grants the router before a USDG -> ETH swap. */
export const PERMIT2_ROUTER_TTL_SECONDS = 20 * 60;

/** ETH left in the wallet for gas: "Max" and validation never let a swap spend below it. */
export const ETH_GAS_RESERVE_WEI = 300_000_000_000_000n; // 0.0003 ETH
/**
 * A typical SPARE transaction (approve, link, rule, swap) for "ETH covers ≈N transactions".
 * Nitro folds the L1 data cost into gas units, so this is above the pure L2 execution gas.
 */
export const SPARE_TX_GAS = 250_000n;

/**
 * Fallback gas per step when eth_estimateGas cannot run yet (no allowance, amount above
 * balance). L2 execution measured on a mainnet fork (ETH->USDG 140–154k, USDG->ETH 137–204k,
 * USDG.approve(Permit2) 58k, Permit2.approve(router) 48k) plus headroom for the L1 data
 * component Nitro adds (mainnet eth_estimateGas for ETH->USDG: ~176k).
 */
export const FUND_GAS = {
  ethToUsdg: 200_000n,
  usdgToEth: 250_000n,
  approveUsdgToPermit2: 80_000n,
  permit2ApproveRouter: 70_000n,
} as const;

/** The gas reserve always covers at least this many SPARE transactions at the live gas price. */
export const GAS_RESERVE_TXS = 10n;
/**
 * Wallets require balance >= gasLimit * maxFeePerGas, which sits above eth_gasPrice * estimate
 * (viem ~1.2x base fee + tip, MetaMask often more). ETH-for-gas checks demand this multiple.
 */
export const GAS_SAFETY_MULTIPLIER = 2n;

/**
 * The ONE gas line Fund Wallet uses everywhere: Readiness reads LOW at or below it, and no
 * ETH -> USDG swap (nor "Max") may leave less. max(0.0003 ETH, GAS_RESERVE_TXS SPARE
 * transactions at `gasPriceWei`); just the 0.0003 ETH floor while the price is unknown.
 */
export function gasReserveWei(gasPriceWei?: bigint | null): bigint {
  const byTxs = gasPriceWei != null && gasPriceWei > 0n ? GAS_RESERVE_TXS * SPARE_TX_GAS * gasPriceWei : 0n;
  return byTxs > ETH_GAS_RESERVE_WEI ? byTxs : ETH_GAS_RESERVE_WEI;
}

export interface UsdgSwapNeeds {
  erc20Approve: boolean;
  permit2Allowance: boolean;
}

/** Gas units for a USDG -> ETH swap plus the approvals it still needs. */
export function usdgToEthGas(needs: UsdgSwapNeeds, swapGas: bigint = FUND_GAS.usdgToEth): bigint {
  return (
    swapGas +
    (needs.erc20Approve ? FUND_GAS.approveUsdgToPermit2 : 0n) +
    (needs.permit2Allowance ? FUND_GAS.permit2ApproveRouter : 0n)
  );
}

/** Transactions a USDG -> ETH swap takes, approvals included. */
export function usdgToEthTxCount(needs: UsdgSwapNeeds): number {
  return 1 + (needs.erc20Approve ? 1 : 0) + (needs.permit2Allowance ? 1 : 0);
}

/**
 * ETH a wallet should hold before starting a USDG -> ETH top-up: every step's gas at
 * `gasPriceWei`, times GAS_SAFETY_MULTIPLIER. Assumes the Permit2 -> router approval is
 * needed (each swap uses its exact-amount allowance up) unless told otherwise.
 */
export function usdgToEthEthNeeded(
  gasPriceWei: bigint,
  needs: UsdgSwapNeeds = { erc20Approve: true, permit2Allowance: true },
  swapGas: bigint = FUND_GAS.usdgToEth,
): bigint {
  return usdgToEthGas(needs, swapGas) * gasPriceWei * GAS_SAFETY_MULTIPLIER;
}

/** Below this (USD, 6 dp) an ETH -> USDG swap is not worth offering. */
export const MIN_ETH_SWAP_USD6 = 1_000_000n; // $1
/** Fallback floor when no ETH/USD price is available. */
export const MIN_ETH_SWAP_WEI = 500_000_000_000_000n; // 0.0005 ETH

/** Is `wei` of swappable ETH worth offering an ETH -> USDG swap for? */
export function ethSwapIsMeaningful(wei: bigint, usd6PerEth?: bigint | null): boolean {
  if (wei <= 0n) return false;
  return usd6PerEth != null && usd6PerEth > 0n ? (wei * usd6PerEth) / 10n ** 18n >= MIN_ETH_SWAP_USD6 : wei >= MIN_ETH_SWAP_WEI;
}

const BPS = 10_000n;
const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/* ---------------------------------- ABIs ---------------------------------- */

export const universalRouterAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * Router, v4 and Permit2 errors a fund swap can surface (V4TooLittleReceived = slippage).
 * ExecutionFailed and WrappedError carry an inner revert — fund-errors.ts decodes it.
 */
export const fundSwapErrorsAbi = [
  { type: 'error', name: 'V4TooLittleReceived', inputs: [{ name: 'minAmountOutReceived', type: 'uint256' }, { name: 'amountReceived', type: 'uint256' }] },
  { type: 'error', name: 'V4TooMuchRequested', inputs: [{ name: 'maxAmountInRequested', type: 'uint256' }, { name: 'amountRequested', type: 'uint256' }] },
  { type: 'error', name: 'V4TooLittleReceivedPerHopSingle', inputs: [{ name: 'minPrice', type: 'uint256' }, { name: 'price', type: 'uint256' }] },
  { type: 'error', name: 'TransactionDeadlinePassed', inputs: [] },
  { type: 'error', name: 'ExecutionFailed', inputs: [{ name: 'commandIndex', type: 'uint256' }, { name: 'message', type: 'bytes' }] },
  { type: 'error', name: 'InvalidEthSender', inputs: [] },
  { type: 'error', name: 'InvalidBips', inputs: [] },
  { type: 'error', name: 'InsufficientETH', inputs: [] },
  { type: 'error', name: 'InsufficientToken', inputs: [] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'InvalidCommandType', inputs: [{ name: 'commandType', type: 'uint256' }] },
  { type: 'error', name: 'WrappedError', inputs: [{ name: 'target', type: 'address' }, { name: 'selector', type: 'bytes4' }, { name: 'reason', type: 'bytes' }, { name: 'details', type: 'bytes' }] },
  { type: 'error', name: 'DeltaNotNegative', inputs: [{ name: 'currency', type: 'address' }] },
  { type: 'error', name: 'DeltaNotPositive', inputs: [{ name: 'currency', type: 'address' }] },
  { type: 'error', name: 'InsufficientBalance', inputs: [] },
  { type: 'error', name: 'CurrencyNotSettled', inputs: [] },
  { type: 'error', name: 'PriceLimitAlreadyExceeded', inputs: [{ name: 'sqrtPriceCurrentX96', type: 'uint160' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] },
  { type: 'error', name: 'PriceLimitOutOfBounds', inputs: [{ name: 'sqrtPriceLimitX96', type: 'uint160' }] },
  { type: 'error', name: 'AllowanceExpired', inputs: [{ name: 'deadline', type: 'uint256' }] },
  { type: 'error', name: 'InsufficientAllowance', inputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'error', name: 'InvalidNonce', inputs: [] },
  { type: 'error', name: 'SignatureExpired', inputs: [{ name: 'signatureDeadline', type: 'uint256' }] },
] as const;

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export const v4QuoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: poolKeyComponents },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export const permit2Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

const erc20Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/* ------------------------------- encoders --------------------------------- */

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

const permitSingleParams = [
  {
    type: 'tuple',
    components: [
      {
        name: 'details',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
      },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
  },
  { type: 'bytes' },
] as const;

function bytesOf(codes: readonly number[]): Hex {
  return `0x${codes.map((c) => c.toString(16).padStart(2, '0')).join('')}` as Hex;
}

function encodeExactInSingle(poolKey: PoolKey, zeroForOne: boolean, amountIn: bigint): Hex {
  return encodeAbiParameters(exactInSingleParams, [
    {
      poolKey,
      zeroForOne,
      amountIn,
      // Slippage is enforced on the user's NET amount by TAKE_ALL below.
      amountOutMinimum: 0n,
      minHopPriceX36: 0n,
      hookData: '0x',
    },
  ]);
}

const currencyAndUint = [{ type: 'address' }, { type: 'uint256' }] as const;
const currencyAddressAndUint = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const;

/**
 * V4_SWAP input: exact-in single-pool swap, settle the whole input from msg.sender /
 * msg.value, skim `feeBps` of the output to `feeTo`, send the rest to msg.sender with a floor.
 */
export function encodeV4FeeSwap(args: {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  feeBps: number;
  feeTo: Address;
}): Hex {
  const { poolKey, zeroForOne, amountIn, minAmountOut, feeBps, feeTo } = args;
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const actions: number[] = [Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL];
  const params: Hex[] = [
    encodeExactInSingle(poolKey, zeroForOne, amountIn),
    encodeAbiParameters(currencyAndUint, [currencyIn, amountIn]),
  ];
  if (feeBps > 0) {
    actions.push(Actions.TAKE_PORTION);
    params.push(encodeAbiParameters(currencyAddressAndUint, [currencyOut, feeTo, BigInt(feeBps)]));
  }
  actions.push(Actions.TAKE_ALL);
  params.push(encodeAbiParameters(currencyAndUint, [currencyOut, minAmountOut]));

  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [bytesOf(actions), params]);
}

/* -------------------------------- builders -------------------------------- */

export interface SwapTx {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface FundSwapParams {
  /** Exact input: wei for ETH -> USDG, USDG base units (6 dp) for USDG -> ETH. */
  amountIn: bigint;
  /** Hard floor on what the USER receives, after the fee. Must be > 0. */
  minAmountOut: bigint;
  /** Fee on the gross output, bps. Default FUND_FEE_BPS. 0 = no fee. */
  feeBps?: number;
  /** Default FeeVault (mainnet; it also exists in a mainnet fork's state). */
  feeRecipient?: Address;
  /** Unix seconds. Default now + FUND_SWAP_DEADLINE_SECONDS. */
  deadline?: bigint;
  /** Default ETH_USDG_POOL. Must be the native-ETH/USDG pair. */
  poolKey?: PoolKey;
  /** Router override (e.g. a fork). Default UNIVERSAL_ROUTER. */
  router?: Address;
}

export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

function assertFeeBps(feeBps: number) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FUND_FEE_BPS) {
    throw new Error(`feeBps must be an integer in [0, ${MAX_FUND_FEE_BPS}], got ${feeBps}`);
  }
}

function checkCommon(p: FundSwapParams) {
  const feeBps = p.feeBps ?? FUND_FEE_BPS;
  assertFeeBps(feeBps);
  if (p.amountIn <= 0n || p.amountIn > MAX_UINT128) throw new Error('amountIn must be in (0, 2^128)');
  if (p.minAmountOut <= 0n) throw new Error('minAmountOut must be > 0 (slippage protection is mandatory)');
  const poolKey = p.poolKey ?? ETH_USDG_POOL;
  if (poolKey.currency0 !== NATIVE_ETH) throw new Error('poolKey.currency0 must be native ETH');
  const deadline = p.deadline ?? BigInt(Math.floor(Date.now() / 1000) + FUND_SWAP_DEADLINE_SECONDS);
  return {
    feeBps,
    poolKey,
    deadline,
    feeTo: getAddress(p.feeRecipient ?? FEE_VAULT),
    router: getAddress(p.router ?? UNIVERSAL_ROUTER),
  };
}

function execute(router: Address, commands: number[], inputs: Hex[], deadline: bigint, value: bigint): SwapTx {
  return {
    to: router,
    data: encodeFunctionData({
      abi: universalRouterAbi,
      functionName: 'execute',
      args: [bytesOf(commands), inputs, deadline],
    }),
    value,
  };
}

/**
 * ETH -> USDG. Send with value = amountIn (exactly: any extra ETH would stay on the router).
 * FeeVault receives floor(grossUsdg * feeBps / 1e4) USDG; the sender receives the rest, at
 * least minAmountOut, or the whole tx reverts.
 */
export function buildEthToUsdg(p: FundSwapParams): SwapTx {
  const { feeBps, poolKey, deadline, feeTo, router } = checkCommon(p);
  const swap = encodeV4FeeSwap({
    poolKey,
    zeroForOne: true,
    amountIn: p.amountIn,
    minAmountOut: p.minAmountOut,
    feeBps,
    feeTo,
  });
  return execute(router, [Commands.V4_SWAP], [swap], deadline, p.amountIn);
}

/**
 * USDG -> native ETH. The sender needs USDG.approve(Permit2) and a Permit2 allowance for the
 * router — on-chain (buildPermit2ApproveRouterTx) or signed and passed as `permit`.
 * The sender receives >= minAmountOut ETH; FeeVault receives floor(grossEth * feeBps / 1e4)
 * as WETH (FeeVault cannot accept native ETH) — plus any native ETH already stranded on the
 * router, because the wrap uses CONTRACT_BALANCE. Track fee income from receipts, not from
 * FeeVault's WETH balance.
 */
export function buildUsdgToEth(
  p: FundSwapParams & { permit?: { permitSingle: PermitSingle; signature: Hex } },
): SwapTx {
  const { feeBps, poolKey, deadline, feeTo, router } = checkCommon(p);
  const commands: number[] = [];
  const inputs: Hex[] = [];

  if (p.permit) {
    const { permitSingle, signature } = p.permit;
    if (getAddress(permitSingle.details.token) !== getAddress(poolKey.currency1)) throw new Error('permit token must be USDG');
    if (getAddress(permitSingle.spender) !== router) throw new Error('permit spender must be the router');
    if (permitSingle.details.amount < p.amountIn) throw new Error('permit amount < amountIn');
    commands.push(Commands.PERMIT2_PERMIT);
    inputs.push(
      encodeAbiParameters(permitSingleParams, [
        {
          details: permitSingle.details,
          spender: permitSingle.spender,
          sigDeadline: permitSingle.sigDeadline,
        },
        signature,
      ]),
    );
  }

  commands.push(Commands.V4_SWAP);
  inputs.push(
    encodeV4FeeSwap({
      poolKey,
      zeroForOne: false,
      amountIn: p.amountIn,
      minAmountOut: p.minAmountOut,
      feeBps,
      feeTo: ADDRESS_THIS, // fee ETH parks on the router, then is wrapped to FeeVault
    }),
  );
  if (feeBps > 0) {
    // CONTRACT_BALANCE: wraps ALL native ETH on the router — the fee plus anything stranded
    // there earlier (see the header). Accepted: the exact fee is only known on-chain.
    commands.push(Commands.WRAP_ETH);
    inputs.push(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [feeTo, CONTRACT_BALANCE]));
  }
  return execute(router, commands, inputs, deadline, 0n);
}

/* ------------------------------ fee / amounts ------------------------------ */

export interface FundQuote {
  amountIn: bigint;
  /** Pool output before SPARE's fee. */
  grossOut: bigint;
  /** floor(grossOut * feeBps / 1e4) — exactly what the router skims. */
  fee: bigint;
  /** grossOut - fee: what the user would receive at the quoted price. */
  netOut: bigint;
  /** netOut less slippage: pass as minAmountOut. */
  minAmountOut: bigint;
  gasEstimate: bigint;
  feeBps: number;
  slippageBps: number;
}

/** floor(grossOut * feeBps / 1e4) — TAKE_PORTION's exact rounding. */
export function feeOf(grossOut: bigint, feeBps: number): bigint {
  return (grossOut * BigInt(feeBps)) / BPS;
}

/** amount less slippageBps, rounded down (the floor only ever gets stricter for the pool, never looser). */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('bad slippageBps');
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

/** Fee / net / minimum for a gross pool output — the same numbers the router will produce. */
export function splitQuote(amountIn: bigint, grossOut: bigint, feeBps: number, slippageBps: number, gasEstimate = 0n): FundQuote {
  assertFeeBps(feeBps);
  const fee = feeOf(grossOut, feeBps);
  const netOut = grossOut - fee;
  return { amountIn, grossOut, fee, netOut, minAmountOut: withSlippage(netOut, slippageBps), gasEstimate, feeBps, slippageBps };
}

/**
 * VITE_SPARE_FUND_FEE_BPS -> fee bps. Missing or not an integer -> FUND_FEE_BPS (25);
 * otherwise clamped to [0, MAX_FUND_FEE_BPS].
 */
export function parseFundFeeBps(raw: unknown): number {
  if (raw == null) return FUND_FEE_BPS;
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) return FUND_FEE_BPS;
  const n = Number(s);
  return Math.min(MAX_FUND_FEE_BPS, Math.max(0, n));
}

/** Largest ETH -> USDG input that still leaves `reserveWei` for gas (0 if the balance is at/below it). */
export function maxEthSwapIn(balanceWei: bigint, reserveWei: bigint = ETH_GAS_RESERVE_WEI): bigint {
  return balanceWei > reserveWei ? balanceWei - reserveWei : 0n;
}

/** How many transactions of `gasPerTx` the balance pays for at `gasPriceWei` (null if the price is unknown). */
export function txsCovered(balanceWei: bigint, gasPriceWei: bigint, gasPerTx: bigint = SPARE_TX_GAS): bigint | null {
  if (gasPriceWei <= 0n || gasPerTx <= 0n) return null;
  return balanceWei / (gasPriceWei * gasPerTx);
}

/**
 * Decimal text -> base units, exactly (no floats). null for anything that is not a plain
 * non-negative decimal with at most `decimals` fraction digits ("1.5", ".5", "2." are fine).
 */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (whole === '' && frac === '') return null;
  if (frac.length > decimals) return null;
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole === '' ? '0' : whole) * scale + (frac === '' ? 0n : BigInt(frac.padEnd(decimals, '0')));
}

/**
 * `value` (base units, `decimals`) rounded DOWN to `dp` decimals. Minimums and guarantees
 * are displayed through this: a half-up display could print more than the router enforces.
 */
export function floorToDp(value: bigint, decimals: number, dp: number): bigint {
  if (dp >= decimals || value <= 0n) return value;
  const unit = 10n ** BigInt(decimals - dp);
  return value - (value % unit);
}

/* ---------------------------------- price ---------------------------------- */

const ONE_ETH = 10n ** 18n;

/**
 * Pool execution price as USDG base units (6 dp) per 1 ETH, from a quote's gross numbers
 * (the pool's own 0.05% LP fee is inside it; SPARE's fee is not). null when undefined.
 */
export function usdgPerEth(amountIn: bigint, grossOut: bigint, zeroForOne: boolean): bigint | null {
  if (amountIn <= 0n || grossOut <= 0n) return null;
  return zeroForOne ? (grossOut * ONE_ETH) / amountIn : (amountIn * ONE_ETH) / grossOut;
}

/** Chainlink ETH/USD answer -> USD 6 dp per ETH (USDG taken at $1). */
export function feedToUsd6(answer: bigint, feedDecimals: number = CHAINLINK_ETH_USD_DECIMALS): bigint {
  if (feedDecimals === 6) return answer;
  return feedDecimals > 6 ? answer / 10n ** BigInt(feedDecimals - 6) : answer * 10n ** BigInt(6 - feedDecimals);
}

/**
 * How much better (+) or worse (−) the pool price is for the USER than the reference, in bps.
 * Selling ETH (zeroForOne): a higher USDG-per-ETH is better. Buying ETH: a lower one is better.
 */
export function edgeVsReferenceBps(poolUsd6: bigint, refUsd6: bigint, zeroForOne: boolean): number | null {
  if (poolUsd6 <= 0n || refUsd6 <= 0n) return null;
  const diff = zeroForOne ? poolUsd6 - refUsd6 : refUsd6 - poolUsd6;
  return Number((diff * BPS) / refUsd6);
}

/** Wei at a USD-6dp-per-ETH price -> USD 6 dp. */
export function weiToUsd6(wei: bigint, usd6PerEth: bigint): bigint {
  return (wei * usd6PerEth) / ONE_ETH;
}

/** A Chainlink ETH/USD reading: the answer in USD 6 dp and its updatedAt (unix seconds). */
export interface EthUsdReference {
  usd6: bigint;
  updatedAt: number;
}

/** latestRoundData() tuple -> reference; undefined while unread or for a non-positive answer. */
export function referenceFromRound(
  round: readonly [bigint, bigint, bigint, bigint, bigint] | undefined | null,
  feedDecimals: number = CHAINLINK_ETH_USD_DECIMALS,
): EthUsdReference | undefined {
  if (!round || round[1] <= 0n) return undefined;
  return { usd6: feedToUsd6(round[1], feedDecimals), updatedAt: Number(round[3]) };
}

/** Pool price this much worse than Chainlink (bps) warns; past BLOCK the swap is refused. */
export const PRICE_WARN_BPS = 100;
export const PRICE_BLOCK_BPS = 500;
/** Price impact vs a tiny probe quote (bps) that warns; past BLOCK the swap is refused. */
export const IMPACT_WARN_BPS = 100;
export const IMPACT_BLOCK_BPS = 300;
/** Probe sizes for the feed-independent price-impact check: 0.001 ETH / 1 USDG. */
export const IMPACT_PROBE_ETH_WEI = 10n ** 15n;
export const IMPACT_PROBE_USDG = 1_000_000n;

export function impactProbeIn(zeroForOne: boolean): bigint {
  return zeroForOne ? IMPACT_PROBE_ETH_WEI : IMPACT_PROBE_USDG;
}

export interface QuotedFill {
  amountIn: bigint;
  grossOut: bigint;
}

export interface PriceCheck {
  /** Pool execution price, USDG 6 dp per ETH (gross, pool LP fee inside). */
  poolUsd6: bigint | null;
  /** vs Chainlink, bps, + = better for the user. null without a usable reference. */
  edgeBps: number | null;
  /** vs the probe quote, bps, + = worse for the user (price impact). */
  impactBps: number | null;
  /** Seconds since the reference's updatedAt. */
  refAgeSec: number | null;
  /** Set when the swap must NOT go ahead — the sentence to show. */
  block: string | null;
}

const pctText = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Seconds -> "42 s" / "12 min" / "5.4 h". */
export function referenceAgeText(sec: number): string {
  if (sec < 90) return `${Math.max(0, Math.round(sec))} s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/** referenceAgeText in the live language, for the block sentences. */
function ageText(sec: number): string {
  if (sec < 90) return tf('fundGuard.age.s', { n: Math.max(0, Math.round(sec)) });
  if (sec < 90 * 60) return tf('fundGuard.age.min', { n: Math.round(sec / 60) });
  return tf('fundGuard.age.h', { n: (sec / 3600).toFixed(1) });
}

/**
 * The price guards a fund swap must pass, failing CLOSED:
 *   - price impact vs a tiny probe quote in the same pool (independent of any feed)
 *   - a Chainlink ETH/USD answer that exists and is within CHAINLINK_MAX_AGE_SECONDS
 *   - the pool within PRICE_BLOCK_BPS of that answer
 * A missing probe, missing reference or stale reference BLOCKS — it never waves a swap through.
 */
export function checkSwapPrice(args: {
  zeroForOne: boolean;
  fill: QuotedFill;
  probe: QuotedFill | null | undefined;
  ref: EthUsdReference | null | undefined;
  now: number;
  maxRefAgeSec?: number;
}): PriceCheck {
  const { zeroForOne, fill, probe, ref, now } = args;
  const maxAge = args.maxRefAgeSec ?? CHAINLINK_MAX_AGE_SECONDS;
  const poolUsd6 = usdgPerEth(fill.amountIn, fill.grossOut, zeroForOne);
  const probeUsd6 = probe ? usdgPerEth(probe.amountIn, probe.grossOut, zeroForOne) : null;
  const vsProbe = poolUsd6 && probeUsd6 ? edgeVsReferenceBps(poolUsd6, probeUsd6, zeroForOne) : null;
  const impactBps = vsProbe == null ? null : 0 - vsProbe; // 0 - x, not -x: no -0
  const refAgeSec = ref ? now - ref.updatedAt : null;
  const refUsable = !!ref && ref.usd6 > 0n && refAgeSec != null && refAgeSec <= maxAge;
  const edgeBps = poolUsd6 && refUsable ? edgeVsReferenceBps(poolUsd6, ref.usd6, zeroForOne) : null;

  let block: string | null = null;
  if (!poolUsd6) block = tf('fundGuard.noQuote');
  else if (impactBps == null) block = tf('fundGuard.noProbe');
  else if (impactBps > IMPACT_BLOCK_BPS) {
    block = tf('fundGuard.impact', { pct: pctText(impactBps) });
  } else if (!ref || ref.usd6 <= 0n) {
    block = tf('fundGuard.noRef');
  } else if (!refUsable) {
    block = tf('fundGuard.staleRef', { age: ageText(refAgeSec as number), hours: CHAINLINK_ETH_USD_HEARTBEAT_SECONDS / 3600 });
  } else if (edgeBps != null && edgeBps < -PRICE_BLOCK_BPS) {
    block = tf('fundGuard.belowRef', { pct: pctText(-edgeBps) });
  }
  return { poolUsd6, edgeBps, impactBps, refAgeSec, block };
}

/* --------------------------------- quotes --------------------------------- */

/**
 * Anything with viem's eth_call (a PublicClient, wagmi's usePublicClient()). Plain `call` +
 * encode/decode keeps this independent of readContract's generics (which mis-infer under
 * this repo's `strict: false`).
 */
export type EthCallClient = Pick<PublicClient, 'call'>;

async function ethCall(client: EthCallClient, to: Address, data: Hex): Promise<Hex> {
  const { data: ret } = await client.call({ to, data });
  if (!ret) throw new Error(`empty eth_call result from ${to}`);
  return ret;
}

export interface QuoteOpts {
  feeBps?: number;
  slippageBps?: number;
  poolKey?: PoolKey;
  quoter?: Address;
}

async function quote(client: EthCallClient, zeroForOne: boolean, amountIn: bigint, opts: QuoteOpts): Promise<FundQuote> {
  const feeBps = opts.feeBps ?? FUND_FEE_BPS;
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ret = await ethCall(
    client,
    opts.quoter ?? V4_QUOTER,
    encodeFunctionData({
      abi: v4QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: opts.poolKey ?? ETH_USDG_POOL, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    }),
  );
  const [grossOut, gasEstimate] = decodeFunctionResult({
    abi: v4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    data: ret,
  }) as readonly [bigint, bigint];
  return splitQuote(amountIn, grossOut, feeBps, slippageBps, gasEstimate);
}

/** Quote ETH (wei) -> USDG (6 dp) with SPARE's fee and slippage applied. */
export function quoteEthToUsdg(client: EthCallClient, amountInWei: bigint, opts: QuoteOpts = {}): Promise<FundQuote> {
  return quote(client, true, amountInWei, opts);
}

/** Quote USDG (6 dp) -> ETH (wei) with SPARE's fee and slippage applied. */
export function quoteUsdgToEth(client: EthCallClient, amountInUsdg: bigint, opts: QuoteOpts = {}): Promise<FundQuote> {
  return quote(client, false, amountInUsdg, opts);
}

/**
 * The swap quote plus a tiny probe quote in the same direction and pool, for the
 * feed-independent price-impact check. At or below the probe size the quote is its own probe.
 */
export async function quoteWithProbe(
  client: EthCallClient,
  zeroForOne: boolean,
  amountIn: bigint,
  opts: QuoteOpts = {},
): Promise<{ q: FundQuote; probe: QuotedFill }> {
  const probeIn = impactProbeIn(zeroForOne);
  if (amountIn <= probeIn) {
    const q = await quote(client, zeroForOne, amountIn, opts);
    return { q, probe: { amountIn: q.amountIn, grossOut: q.grossOut } };
  }
  const [q, p] = await Promise.all([quote(client, zeroForOne, amountIn, opts), quote(client, zeroForOne, probeIn, opts)]);
  return { q, probe: { amountIn: p.amountIn, grossOut: p.grossOut } };
}

const latestRoundDataAbi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

/** Fresh Chainlink ETH/USD reading via eth_call. Throws if the feed answers nothing usable. */
export async function readEthUsdReference(client: EthCallClient, feed: Address = CHAINLINK_ETH_USD): Promise<EthUsdReference> {
  const ret = await ethCall(client, feed, encodeFunctionData({ abi: latestRoundDataAbi, functionName: 'latestRoundData' }));
  const round = decodeFunctionResult({ abi: latestRoundDataAbi, functionName: 'latestRoundData', data: ret }) as readonly [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const ref = referenceFromRound(round);
  // Shown to the user (FundWallet's swap error line), so in the live language.
  if (!ref) throw new Error(tf('fundGuard.noUsablePrice'));
  return ref;
}

/* ----------------------------- Permit2 helpers ---------------------------- */

/** One Permit2 allowance leg: Permit2.allowance(owner, token, spender).{amount, expiration}. */
export interface Permit2Leg {
  amount: bigint;
  expiration: number;
}

export interface UsdgPermit2State {
  /** USDG.allowance(owner, Permit2) */
  erc20Allowance: bigint;
  /** Permit2.allowance(owner, USDG, router) */
  permit2Amount: bigint;
  permit2Expiration: number;
  permit2Nonce: number;
  /**
   * Permit2.allowance(owner, USDG, SweepExecutor) — the round-up pull leg. Read so a swap's
   * USDG -> Permit2 approval never silently re-enables pulls (usdgApprovalForSwap).
   * undefined = unknown, treated as live.
   */
  sweep?: Permit2Leg;
}

export async function readUsdgPermit2State(
  client: EthCallClient,
  owner: Address,
  router: Address = UNIVERSAL_ROUTER,
  sweepExecutor: Address = SPARE.SweepExecutor,
): Promise<UsdgPermit2State> {
  const p2 = (spender: Address) =>
    ethCall(client, PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: 'allowance', args: [owner, USDG, spender] }));
  const [r1, r2, r3] = await Promise.all([
    ethCall(client, USDG, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2] })),
    p2(router),
    p2(sweepExecutor),
  ]);
  const erc20Allowance = decodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', data: r1 }) as bigint;
  const decodeP2 = (data: Hex) => decodeFunctionResult({ abi: permit2Abi, functionName: 'allowance', data }) as readonly [bigint, number, number];
  const [amount, expiration, nonce] = decodeP2(r2);
  const [sweepAmount, sweepExpiration] = decodeP2(r3);
  return {
    erc20Allowance,
    permit2Amount: amount,
    permit2Expiration: Number(expiration),
    permit2Nonce: Number(nonce),
    sweep: { amount: sweepAmount, expiration: Number(sweepExpiration) },
  };
}

/**
 * The USDG.approve(Permit2, amount) a USDG -> ETH swap of `amountIn` should send, when
 * usdgSwapNeeds says one is needed.
 *
 * Normally unlimited — the same approval round-ups use. But while the wallet's Permit2 ->
 * SweepExecutor allowance is live (or unknown), the ERC-20 leg is the only thing limiting
 * round-up pulls (consent.ts PARTIAL / LOW ALLOWANCE): an unlimited approval would switch
 * pulls back on without the user asking. Then approve exactly erc20Allowance + amountIn —
 * the swap spends amountIn of it, leaving the ERC-20 allowance where it was.
 */
export function usdgApprovalForSwap(
  erc20Allowance: bigint,
  amountIn: bigint,
  sweep: Permit2Leg | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): { amount: bigint; sized: boolean } {
  const sweepLive = !sweep || (sweep.amount > 0n && sweep.expiration > nowSec);
  if (!sweepLive) return { amount: maxUint256, sized: false };
  return { amount: erc20Allowance + amountIn, sized: true };
}

/**
 * What a USDG -> ETH swap of `amountIn` still needs before execute() can pull the USDG.
 * An existing USDG -> Permit2 approval (e.g. the one round-ups use) is reused when it covers
 * the amount. The Permit2 allowance must outlive the swap by `marginSec` (Permit2 reverts
 * AllowanceExpired once block.timestamp > expiration).
 */
export function usdgSwapNeeds(
  s: UsdgPermit2State,
  amountIn: bigint,
  nowSec = Math.floor(Date.now() / 1000),
  marginSec = FUND_SWAP_DEADLINE_SECONDS,
): UsdgSwapNeeds {
  return {
    erc20Approve: s.erc20Allowance < amountIn,
    permit2Allowance: s.permit2Amount < amountIn || s.permit2Expiration < nowSec + marginSec,
  };
}

/**
 * USDG.approve(Permit2, amount). Default max — the same approval SPARE round-ups use; pass
 * usdgApprovalForSwap(...).amount when a live SweepExecutor leg means it must be sized.
 */
export function buildUsdgApprovePermit2Tx(amount: bigint = maxUint256): SwapTx {
  return {
    to: USDG,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, amount] }),
    value: 0n,
  };
}

/**
 * On-chain Permit2 allowance for the router: EXACTLY `amount`, expiring at `expiration`
 * (default now + PERMIT2_ROUTER_TTL_SECONDS). The swap consumes it, leaving 0 behind.
 */
export function buildPermit2ApproveRouterTx(
  amount: bigint,
  expiration: number = Math.floor(Date.now() / 1000) + PERMIT2_ROUTER_TTL_SECONDS,
  router: Address = UNIVERSAL_ROUTER,
): SwapTx {
  if (amount <= 0n || amount > MAX_UINT160) throw new Error('amount must be in (0, 2^160)');
  if (!Number.isInteger(expiration) || expiration <= 0 || BigInt(expiration) > MAX_UINT48) throw new Error('expiration out of range');
  return {
    to: PERMIT2,
    data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [USDG, router, amount, expiration] }),
    value: 0n,
  };
}

export const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
} as const;

/**
 * EIP-712 PermitSingle for walletClient.signTypedData(). `nonce` = readUsdgPermit2State().permit2Nonce.
 * chainId must be the chain the tx lands on (31337 on the dev fork — Permit2 rebuilds its domain).
 */
export function usdgPermitTypedData(args: {
  nonce: number;
  amount: bigint;
  expiration?: number;
  sigDeadline?: bigint;
  chainId?: number;
  router?: Address;
}) {
  const now = Math.floor(Date.now() / 1000);
  const permitSingle: PermitSingle = {
    details: {
      token: USDG,
      amount: args.amount,
      expiration: args.expiration ?? now + 30 * 60,
      nonce: args.nonce,
    },
    spender: args.router ?? UNIVERSAL_ROUTER,
    sigDeadline: args.sigDeadline ?? BigInt(now + 30 * 60),
  };
  return {
    permitSingle,
    typedData: {
      domain: { name: 'Permit2', chainId: args.chainId ?? SPARE_CHAIN_ID, verifyingContract: PERMIT2 },
      types: PERMIT_SINGLE_TYPES,
      primaryType: 'PermitSingle' as const,
      message: permitSingle,
    },
  };
}
