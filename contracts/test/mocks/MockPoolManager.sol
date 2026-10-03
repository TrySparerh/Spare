// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice The slice of the Uniswap v4 PoolManager that StockRouter drives
///         (unlock -> callback -> swap / sync / settle / take), with v4's flash
///         accounting: every currency delta must net to zero before unlock returns
///         (CurrencyNotSettled otherwise), and v4's sqrtPriceLimitX96 bounds.
/// @dev Pricing is a fixed rate per direction: out = paid * num / den. `capIn`
///      models an exhausted pool: the swap consumes at most `capIn` of the input
///      (a partial fill, which StockRouter must refuse). `take` pays out of the
///      manager's balance and mints any shortfall, so the manager is an infinite
///      counterparty for mock tokens.
///
///      A pair given `setLiquidity` prices by constant product instead (x * y = k,
///      no fee), and every swap moves its reserves: size has price impact and the
///      impact persists for the next swap, as in a real pool between arbitrages.
contract MockPoolManager {
    using SafeERC20 for IERC20;

    struct Rate {
        uint256 num;
        uint256 den;
        uint256 capIn;
    }

    mapping(address tokenIn => mapping(address tokenOut => Rate)) public rates;
    /// @notice Constant-product reserves: reserveOf[token][counterToken] is how
    ///         much of `token` the token/counterToken pool holds. 0 = fixed rate.
    mapping(address token => mapping(address counter => uint256)) public reserveOf;
    mapping(address token => int256) public deltaOf;
    address[] internal _touched;
    bool public unlocked;
    address public synced;
    uint256 public syncedReserves;
    uint256 public swapCount;

    error ManagerLocked();
    error CurrencyNotSettled(address token, int256 delta);
    error NoRate(address tokenIn, address tokenOut);
    error ExactInputOnly();
    error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96);

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rates[tokenIn][tokenOut].num = num;
        rates[tokenIn][tokenOut].den = den;
    }

    function setCapIn(address tokenIn, address tokenOut, uint256 capIn) external {
        rates[tokenIn][tokenOut].capIn = capIn;
    }

    /// @notice Switch the a/b pair to constant-product pricing over these reserves.
    function setLiquidity(address a, uint256 reserveA, address b, uint256 reserveB) external {
        reserveOf[a][b] = reserveA;
        reserveOf[b][a] = reserveB;
    }

    /// @notice What an exact-input swap of `amountIn` returns right now — the
    ///         V4Quoter read the keeper builds its sweep limit from.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 rIn = reserveOf[tokenIn][tokenOut];
        if (rIn != 0) return (reserveOf[tokenOut][tokenIn] * amountIn) / (rIn + amountIn);
        Rate memory r = rates[tokenIn][tokenOut];
        if (r.den == 0) revert NoRate(tokenIn, tokenOut);
        return (amountIn * r.num) / r.den;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        unlocked = false;
        for (uint256 i; i < _touched.length; ++i) {
            int256 d = deltaOf[_touched[i]];
            if (d != 0) revert CurrencyNotSettled(_touched[i], d);
        }
        delete _touched;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata)
        external
        returns (BalanceDelta)
    {
        if (!unlocked) revert ManagerLocked();
        if (params.amountSpecified >= 0) revert ExactInputOnly();
        // v4 Pool.swap reverts on a limit outside (MIN_SQRT_PRICE, MAX_SQRT_PRICE)
        // whatever the pool price: out of bounds on the swap's own side, already
        // exceeded on the other. (The price-relative check needs a pool price.)
        uint160 limit = params.sqrtPriceLimitX96;
        if (limit <= TickMath.MIN_SQRT_PRICE || limit >= TickMath.MAX_SQRT_PRICE) revert PriceLimitOutOfBounds(limit);
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        (address tin, address tout) = params.zeroForOne ? (c0, c1) : (c1, c0);
        Rate memory r = rates[tin][tout];

        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 paid = (r.capIn != 0 && r.capIn < amountIn) ? r.capIn : amountIn;
        uint256 out = quote(tin, tout, paid);
        if (reserveOf[tin][tout] != 0) {
            reserveOf[tin][tout] += paid;
            reserveOf[tout][tin] -= out;
        }
        _account(tin, -int256(paid));
        _account(tout, int256(out));
        swapCount++;

        int128 inD = -int128(int256(paid));
        int128 outD = int128(int256(out));
        return params.zeroForOne ? toBalanceDelta(inD, outD) : toBalanceDelta(outD, inD);
    }

    function sync(Currency currency) external {
        synced = Currency.unwrap(currency);
        syncedReserves = IERC20(synced).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        paid = IERC20(synced).balanceOf(address(this)) - syncedReserves;
        _account(synced, int256(paid));
        synced = address(0);
    }

    function take(Currency currency, address to, uint256 amount) external {
        address t = Currency.unwrap(currency);
        _account(t, -int256(amount));
        if (IERC20(t).balanceOf(address(this)) >= amount) IERC20(t).safeTransfer(to, amount);
        else MockERC20(t).mint(to, amount);
    }

    /// @dev Positive = owed by the manager to the locker; negative = owed to the manager.
    function _account(address t, int256 d) internal {
        if (deltaOf[t] == 0) _touched.push(t);
        deltaOf[t] += d;
    }
}
