// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice UnitBase plus the STANDBY park adapter: SGOV registered and active,
///         a SgovParkAdapter wired to the fixture's CashPark and pre-authorised on
///         the REAL StockRouter (as Deploy.s.sol does on mainnet), but NOT set on
///         CashPark — suites switch to it explicitly, like the owner would.
/// @dev SGOV is an 18-dp stock token with an 8-dp feed; the pool fills at the
///      oracle both ways until a suite moves it.
abstract contract SgovFixture is UnitBase {
    int256 internal constant SGOV_PX = 100.5e8; // $100.50
    /// @dev config/4663.json park.sgovSlippageBps, the live adapter's immutable.
    uint16 internal constant SGOV_SLIPPAGE = 100;

    MockStockToken internal sgov;
    MockFeed internal sgovFeed;
    SgovParkAdapter internal sgovAdapter;

    function _realRouter() internal pure override returns (bool) {
        return true;
    }

    function setUp() public virtual override {
        super.setUp();
        sgov = new MockStockToken("iShares 0-3 Month Treasury Bond ETF", "SGOV");
        sgovFeed = new MockFeed(8, SGOV_PX);
        vm.startPrank(owner);
        _registerActive(address(sgov), address(sgovFeed));
        sgovAdapter = new SgovParkAdapter(address(usdg), address(sgov), address(park), router, SGOV_SLIPPAGE);
        router.setCaller(address(sgovAdapter), true);
        vm.stopPrank();
        _setPoolFill(address(sgov), SGOV_PX, 10_000);
    }

    /// @dev The owner's switch from the live UsdgParkAdapter to SGOV.
    function _switchToSgov() internal {
        vm.prank(owner);
        park.setAdapter(sgovAdapter);
    }

    /// @dev Next epoch, every feed re-stamped (SGOV's included) so nothing is stale.
    function _nextEpoch() internal {
        vm.warp(vm.getBlockTimestamp() + exec.epochLength());
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        qqqFeed.setAnswer(QQQ_PX);
        sgovFeed.setAnswer(SGOV_PX);
    }

    /// @dev Past heartbeat + grace for every feed.
    function _goStale() internal {
        vm.warp(vm.getBlockTimestamp() + HEARTBEAT + 1 hours + 1);
    }
}
