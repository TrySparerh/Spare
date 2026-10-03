/**
 * ABI fragments for the live Spare contracts — only what the read tools call.
 * Source of truth: contracts/src/*.sol (and the Foundry artifacts in
 * contracts/out-deploy). Human-readable so a reviewer can diff them against
 * the Solidity signatures directly.
 */
import { parseAbi } from 'viem';

const POOL_KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }';

export const spareAuthAbi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function pauser() view returns (address)',
  'function paused() view returns (bool)',
  'function isKeeper(address) view returns (bool)',
]);

export const assetRegistryAbi = parseAbi([
  POOL_KEY,
  'struct Asset { address token; address feed; uint8 feedDecimals; uint32 heartbeat; uint16 bandBps; bool active; PoolKey poolKey; }',
  'function tokens() view returns (address[])',
  'function get(address token) view returns (Asset)',
  'function isEligible(address token) view returns (bool)',
  'function usdg() view returns (address)',
]);

export const ruleRegistryAbi = parseAbi([
  'struct Rule { uint8 roundTo; uint8 multiplier; uint64 weeklyCap; bool enabled; }',
  'function ruleOf(address account) view returns (Rule)',
  'function walletsOf(address account) view returns (address[])',
  'function accountOf(address wallet) view returns (address)',
  'function linkedAt(address wallet) view returns (uint256)',
  'function activeSince(address account) view returns (uint256)',
  'event RuleSet(address indexed account, uint8 roundTo, uint8 multiplier, uint64 weeklyCap, bool enabled)',
  'event Linked(address indexed account, address indexed wallet)',
  'event Unlinked(address indexed account, address indexed wallet)',
]);

export const electionRegistryAbi = parseAbi([
  'struct Leg { address asset; uint16 bps; }',
  'function mixOf(address account) view returns (Leg[])',
  'function hasOwnMix(address account) view returns (bool)',
  'function defaultMix() view returns (Leg[])',
  'event MixSet(address indexed account, Leg[] legs)',
  'event MixCleared(address indexed account)',
]);

export const screeningGateAbi = parseAbi([
  'function isEligible(address account) view returns (bool)',
  'function enforced() view returns (bool)',
  'function attestor() view returns (address)',
  'function clearedUntil(address account) view returns (uint64)',
]);

export const stockRouterAbi = parseAbi([
  'function oracleStatus(address token) view returns (uint8 status, uint256 price1e18)',
  'function sequencerFeed() view returns (address)',
  'function isCaller(address) view returns (bool)',
]);

export const cashParkAbi = parseAbi([
  'function pending(address account) view returns (uint256)',
  'function units(address account) view returns (uint256)',
  'function valueOf(address account) view returns (uint256)',
  'function isFresh() view returns (bool)',
  'function adapter() view returns (address)',
  'function executor() view returns (address)',
  'function totalPending() view returns (uint256)',
  'function totalUnits() view returns (uint256)',
  'event Credited(address indexed account, uint256 amount)',
  'event Parked(uint256 usdgIn, uint256 unitsOut, uint256 accounts)',
  'event WithdrawnForSweep(address indexed account, uint256 usdgOut, uint256 unitsLeft)',
  'event Returned(address indexed account, uint256 amount)',
  'event Exited(address indexed account, uint256 usdgOut, uint256 unitsInKind)',
  'event ExitUnitsKept(address indexed account, uint256 units)',
]);

export const sweepExecutorAbi = parseAbi([
  'function threshold() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function slippageBps() view returns (uint16)',
  'function epochLength() view returns (uint64)',
  'function finalityBuffer() view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function MAX_FEE_BPS() view returns (uint16)',
  'function lastAccruedBlock(address wallet) view returns (uint256)',
  'function sweptEpoch(address account) view returns (uint256)',
  'function claimable(address account, address token) view returns (uint256)',
  'function pulledLast7Days(address account) view returns (uint256)',
  'function remainingWeeklyCap(address account) view returns (uint256)',
  'event Accrued(address indexed account, address indexed wallet, uint256 amount, uint256 fromBlock, uint256 toBlock)',
  'event AccountSwept(address indexed account, uint256 epoch, uint256 usdg)',
  'event AssetSwept(address indexed asset, uint256 usdgIn, uint256 fee, uint256 tokensOut)',
  'event SwapDeferred(address indexed asset, uint256 usdg, bytes reason)',
  'event Delivered(address indexed account, address indexed token, uint256 amount)',
  'event DeliveryHeld(address indexed account, address indexed token, uint256 amount)',
  'event Deferred(address indexed account, address indexed asset, uint256 usdg, uint8 status)',
  'event SafeSettled(address indexed account, address indexed asset, uint256 usdg, string reason)',
  'event Claimed(address indexed account, address indexed token, address to, uint256 amount)',
  'event AccrualSkipped(address indexed account, address indexed wallet, uint256 toBlock, bytes reason)',
]);

export const feeVaultAbi = parseAbi([
  'event Withdrawn(address indexed token, address indexed to, uint256 amount)',
]);

export const parkAdapterAbi = parseAbi([
  'function underlying() view returns (address)',
  'function isFresh() view returns (bool)',
  'function park() view returns (address)',
]);

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

/**
 * Robinhood stock tokens (ERC-8056 Scaled UI Amount). The multiplier moves
 * from uiMultiplier to newUIMultiplier at effectiveAt (0: never scheduled).
 */
export const stockTokenAbi = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
  'function paused() view returns (bool)',
  'function oraclePaused() view returns (bool)',
]);

/** Uniswap v4 StateView: the protocol fee and (for a dynamic-fee pool) the LP fee. */
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

export const aggregatorV3Abi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

export const v4QuoterAbi = parseAbi([
  POOL_KEY,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
