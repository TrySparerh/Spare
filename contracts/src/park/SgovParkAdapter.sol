// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IParkAdapter} from "../interfaces/IParkAdapter.sol";
import {StockRouter} from "../StockRouter.sol";
import {AssetRegistry} from "../AssetRegistry.sol";
import {IAggregatorV3} from "../interfaces/IExternal.sol";
import {OracleGuard} from "../libraries/OracleGuard.sol";

/// @title SgovParkAdapter
/// @notice Parks idle spare in SGOV — the tokenized iShares 0–3 Month Treasury Bond
///         ETF — so it earns T-bill yield until it is invested.
/// @dev SGOV is a genuine treasury exposure. syrupUSDG also exists on RHC, but it is
///      Maple private credit; parking there and calling it "treasury yield" would be
///      false, so it is deliberately not the treasury adapter.
///
///      SGOV trades 24/5 and its feed follows US market hours. Outside them the
///      adapter reports not-fresh, and CashPark holds new accrual as plain USDG
///      rather than buying at an untrusted price (spec law 4). Buys and sells go
///      through StockRouter, so the same venue allowlist and oracle band apply.
///      `exitInKind` hands over SGOV itself and touches no oracle or pool, so a
///      user's exit never depends on the market being open.
contract SgovParkAdapter is IParkAdapter {
    using SafeERC20 for IERC20;

    address public immutable usdg;
    address public immutable sgov;
    address public immutable park;
    StockRouter public immutable router;
    AssetRegistry public immutable registry;
    /// @notice minOut tolerance vs oracle for parking legs (router band still applies).
    uint16 public immutable slippageBps;

    error NotPark();

    constructor(address usdg_, address sgov_, address park_, StockRouter router_, uint16 slippageBps_) {
        usdg = usdg_;
        sgov = sgov_;
        park = park_;
        router = router_;
        registry = router_.registry();
        slippageBps = slippageBps_;
        IERC20(usdg_).forceApprove(address(router_), type(uint256).max);
        IERC20(sgov_).forceApprove(address(router_), type(uint256).max);
    }

    modifier onlyPark() {
        if (msg.sender != park) revert NotPark();
        _;
    }

    function underlying() external view returns (address) {
        return sgov;
    }

    function deposit(uint256 amount) external onlyPark returns (uint256 units) {
        (, uint256 price) = router.oracleStatus(sgov);
        uint256 minOut = (router.oracleTokensFor(amount, price) * (10_000 - slippageBps)) / 10_000;
        units = router.buy(sgov, amount, minOut, address(this));
    }

    function redeem(uint256 units, address to) external onlyPark returns (uint256 usdgOut) {
        (, uint256 price) = router.oracleStatus(sgov);
        uint256 minOut = (router.oracleUsdgFor(units, price) * (10_000 - slippageBps)) / 10_000;
        usdgOut = router.sell(sgov, units, minOut, to);
    }

    function exitInKind(uint256 units, address to) external onlyPark {
        IERC20(sgov).safeTransfer(to, units);
    }

    /// @dev Values at the latest feed answer even when stale: a 0–3 month T-bill ETF
    ///      barely moves over a weekend, and this is for display and thresholds.
    ///      Anything that actually moves money redeems at market through the router.
    function valueOf(uint256 units) external view returns (uint256) {
        if (units == 0) return 0;
        AssetRegistry.Asset memory a = registry.get(sgov);
        (, int256 answer,,,) = IAggregatorV3(a.feed).latestRoundData();
        if (answer <= 0) return 0;
        uint256 price1e18 = uint256(answer) * 10 ** (18 - a.feedDecimals);
        return router.oracleUsdgFor(units, price1e18);
    }

    function isFresh() external view returns (bool) {
        (OracleGuard.Status s,) = router.oracleStatus(sgov);
        return s == OracleGuard.Status.OK;
    }
}
