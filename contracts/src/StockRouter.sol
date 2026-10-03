// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {SpareAuth} from "./SpareAuth.sol";
import {AssetRegistry} from "./AssetRegistry.sol";
import {OracleGuard} from "./libraries/OracleGuard.sol";

/// @title StockRouter
/// @notice Buys (and sells) registry assets through their allowlisted Uniswap v4
///         pool, and refuses any fill that disagrees with Chainlink.
/// @dev Spec law 3 — every buy: allowlisted venue, per-leg slippage cap, Chainlink
///      sanity with staleness / oraclePaused guards. Each maps to a check here:
///        venue     -> the pool comes from AssetRegistry, never from the caller
///        slippage  -> `minOut`, supplied per leg by the caller
///        sanity    -> fill vs oracle within the asset's `bandBps`
///        staleness -> OracleGuard must return OK before any swap
///
///      A failed check REVERTS; the caller (SweepExecutor) catches it and defers
///      the leg (the USDG returns to the park). The router itself never
///      "partially" honours a guard. Per-sweep keeper limits (a same-block quote)
///      arrive as `minOut`; the oracle band is the backstop.
///
///      Measured on RHC mainnet, a $5 buy fills within 0.25% of Chainlink for SPY,
///      QQQ, NVDA, AAPL, TSLA and SGOV — well inside the 1.5% default band, which
///      exists to absorb the feed's own 0.5% update threshold plus pool fees.
contract StockRouter is SpareAuth, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    AssetRegistry public immutable registry;
    address public immutable usdg;

    /// @notice L2 sequencer uptime feed, or address(0) to skip (none published for RHC yet).
    address public sequencerFeed;
    /// @notice Contracts allowed to route through here (SweepExecutor, park adapters).
    mapping(address => bool) public isCaller;

    struct SwapData {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address tokenIn;
        address tokenOut;
        address recipient;
    }

    event Bought(address indexed token, uint256 usdgIn, uint256 tokensOut, uint256 oraclePrice1e18);
    event Sold(address indexed token, uint256 tokensIn, uint256 usdgOut, uint256 oraclePrice1e18);
    event CallerSet(address indexed caller, bool enabled);
    event SequencerFeedSet(address indexed feed);

    error NotCaller();
    error NotPoolManager();
    error AssetInactive(address token);
    error OracleNotOk(OracleGuard.Status status);
    error BelowMinOut(uint256 out, uint256 minOut);
    error OutsideOracleBand(uint256 out, uint256 floor);
    error PartialFill(uint256 paid, uint256 amountIn);

    constructor(address owner_, IPoolManager poolManager_, AssetRegistry registry_) SpareAuth(owner_) {
        poolManager = poolManager_;
        registry = registry_;
        usdg = registry_.usdg();
    }

    modifier onlyCaller() {
        if (!isCaller[msg.sender]) revert NotCaller();
        _;
    }

    function setCaller(address caller, bool enabled) external onlyOwner {
        isCaller[caller] = enabled;
        emit CallerSet(caller, enabled);
    }

    function setSequencerFeed(address feed) external onlyOwner {
        sequencerFeed = feed;
        emit SequencerFeedSet(feed);
    }

    // ── public reads ───────────────────────────────────────────────────────

    /// @notice Oracle status + price for an asset, with the router's guards applied.
    function oracleStatus(address token) public view returns (OracleGuard.Status status, uint256 price1e18) {
        AssetRegistry.Asset memory a = registry.get(token);
        return OracleGuard.check(a.token, a.feed, a.feedDecimals, a.heartbeat, sequencerFeed);
    }

    /// @notice Tokens a USDG amount should buy at the oracle price (18 dp).
    function oracleTokensFor(uint256 usdgIn, uint256 price1e18) public pure returns (uint256) {
        // USDG has 6 decimals: scale to 18, then divide by the 1e18 USD price.
        return (usdgIn * 1e12 * 1e18) / price1e18;
    }

    /// @notice USDG a token amount is worth at the oracle price (6 dp).
    function oracleUsdgFor(uint256 tokensIn, uint256 price1e18) public pure returns (uint256) {
        return (tokensIn * price1e18) / 1e18 / 1e12;
    }

    // ── swaps ──────────────────────────────────────────────────────────────

    /// @notice USDG -> asset. Pulls `usdgIn` from the caller; tokens go to `recipient`.
    /// @dev Treats 1 USDG as $1. A USDG depeg makes the fill look expensive against
    ///      the USD oracle, so the band rejects it — buying stock with a depegged
    ///      stablecoin is exactly the case that should not proceed silently.
    function buy(address token, uint256 usdgIn, uint256 minOut, address recipient)
        external
        onlyCaller
        nonReentrant
        returns (uint256 out)
    {
        AssetRegistry.Asset memory a = registry.get(token);
        if (!a.active) revert AssetInactive(token);
        (OracleGuard.Status status, uint256 price) =
            OracleGuard.check(a.token, a.feed, a.feedDecimals, a.heartbeat, sequencerFeed);
        if (status != OracleGuard.Status.OK) revert OracleNotOk(status);

        IERC20(usdg).safeTransferFrom(msg.sender, address(this), usdgIn);
        uint256 paid;
        (paid, out) = _swap(a.poolKey, usdg, token, usdgIn, recipient);

        if (out < minOut) revert BelowMinOut(out, minOut);
        uint256 floor = (oracleTokensFor(paid, price) * (10_000 - a.bandBps)) / 10_000;
        if (out < floor) revert OutsideOracleBand(out, floor);

        emit Bought(token, paid, out, price);
    }

    /// @notice Asset -> USDG. Used by park adapters to unpark (e.g. SGOV).
    function sell(address token, uint256 tokensIn, uint256 minOut, address recipient)
        external
        onlyCaller
        nonReentrant
        returns (uint256 out)
    {
        AssetRegistry.Asset memory a = registry.get(token);
        (OracleGuard.Status status, uint256 price) =
            OracleGuard.check(a.token, a.feed, a.feedDecimals, a.heartbeat, sequencerFeed);
        if (status != OracleGuard.Status.OK) revert OracleNotOk(status);

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        uint256 paid;
        (paid, out) = _swap(a.poolKey, token, usdg, tokensIn, recipient);

        if (out < minOut) revert BelowMinOut(out, minOut);
        uint256 floor = (oracleUsdgFor(paid, price) * (10_000 - a.bandBps)) / 10_000;
        if (out < floor) revert OutsideOracleBand(out, floor);

        emit Sold(token, paid, out, price);
    }

    // ── v4 ─────────────────────────────────────────────────────────────────

    function _swap(PoolKey memory key, address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        internal
        returns (uint256 paid, uint256 received)
    {
        bool zeroForOne = Currency.unwrap(key.currency0) == tokenIn;
        bytes memory ret = poolManager.unlock(
            abi.encode(SwapData(key, zeroForOne, amountIn, tokenIn, tokenOut, recipient))
        );
        (paid, received) = abi.decode(ret, (uint256, uint256));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapData memory s = abi.decode(data, (SwapData));

        // Negative amountSpecified = exact input (v4-core convention).
        BalanceDelta delta = poolManager.swap(
            s.key,
            SwapParams({
                zeroForOne: s.zeroForOne,
                amountSpecified: -int256(s.amountIn),
                sqrtPriceLimitX96: s.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // From the caller's side: negative = owed to the pool, positive = owed to us.
        int128 inDelta = s.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outDelta = s.zeroForOne ? delta.amount1() : delta.amount0();
        uint256 paid = uint256(uint128(-inDelta));
        uint256 received = uint256(uint128(outDelta));
        // Exact input or nothing. A partial fill (pool exhausted) or a hook claiming
        // more than we specified both revert, so the caller never holds unattributed
        // leftovers — it safe-settles the leg instead.
        if (paid != s.amountIn) revert PartialFill(paid, s.amountIn);

        Currency cin = Currency.wrap(s.tokenIn);
        poolManager.sync(cin);
        IERC20(s.tokenIn).safeTransfer(address(poolManager), paid);
        poolManager.settle();
        poolManager.take(Currency.wrap(s.tokenOut), s.recipient, received);

        return abi.encode(paid, received);
    }
}
