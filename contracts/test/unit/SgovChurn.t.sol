// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {IParkAdapter} from "../../src/interfaces/IParkAdapter.sol";
import {SgovFixture} from "./SgovFixture.sol";

/// @notice Audit A-L2 (accepted while SGOV stays on standby): `park` and `sweep`
///         are keeper calls with no holding period between them. On the SGOV
///         adapter a malicious keeper can park an account's USDG into SGOV and
///         sweep it straight back out with no limits: the units are sold, every
///         leg defers ("no keeper limit"), and the USDG returns to pending — one
///         SGOV round trip per epoch, each fill inside the adapter's 100 bps
///         slippage and the router's 150 bps band. The keeper gains nothing; the
///         user bleeds ~1.9% an epoch to the pool. On the LIVE UsdgParkAdapter the
///         same churn costs exactly zero. Before SGOV is ever enabled: a keeper
///         minOut on unpark, a holding period, and a tighter band.
contract SgovChurnTest is SgovFixture {
    uint256 internal constant START = 1_000e6;
    uint256 internal constant EPOCHS = 10;
    /// @dev Fill 95 bps off the oracle on both the buy and the sell: inside every
    ///      bound the contracts apply (adapter 100 bps, executor/router 150 bps).
    uint256 internal constant FILL_BPS = 9_905;

    function setUp() public override {
        super.setUp();
        _onboard(alice, START, uint64(START));
        _accrue(alice, START);
    }

    /// One malicious-keeper cycle: park everything, then sweep with no limits.
    function _churn() internal {
        vm.prank(keeper);
        park.park(_one(alice));
        assertGt(park.units(alice), 0, "parked");
        assertEq(_sweepWith(_one(alice), new SweepExecutor.Limit[](0)), 1, "swept: every leg deferred");
        assertEq(park.units(alice), 0, "unparked by the sweep");
        _nextEpoch();
    }

    function test_AL2_keeperChurnOnSgovCostsAboutTwoPercentAnEpoch() public {
        _switchToSgov();
        _setPoolFill(address(sgov), SGOV_PX, FILL_BPS);

        for (uint256 e; e < EPOCHS; ++e) {
            uint256 before = park.valueOf(alice);
            _churn();
            uint256 lostBps = ((before - park.valueOf(alice)) * 10_000) / before;
            assertGe(lostBps, 188, "~1.89% per round trip");
            assertLe(lostBps, 189);
        }
        uint256 left = park.valueOf(alice);
        emit log_named_decimal_uint("USDG left of $1,000 after 10 epochs", left, 6);
        assertGe(left, 826e6, "$1,000 -> ~$826");
        assertLt(left, 827e6);
        assertEq(park.pending(alice), left, "all of it back as plain USDG");

        assertEq(spy.balanceOf(alice) + nvda.balanceOf(alice), 0, "nothing was ever bought");
        assertEq(usdg.balanceOf(address(vault)), 0, "no fee: no leg converted");
        assertEq(usdg.balanceOf(keeper) + sgov.balanceOf(keeper), 0, "the keeper gains nothing");
    }

    /// Same keeper, same calls, on the adapter that is actually live.
    function test_AL2_theSameChurnIsFreeOnTheLiveUsdgAdapter() public {
        assertEq(address(park.adapter()), address(usdgAdapter));
        for (uint256 e; e < EPOCHS; ++e) {
            _churn();
        }
        assertEq(park.valueOf(alice), START, "not one base unit lost");
        assertEq(pm.swapCount(), 0, "no market touched");
    }

    /// The churn needs an adapter that is fresh: off-hours, park() is a no-op and
    /// there is nothing to round-trip.
    function test_AL2_noChurnWhileSgovIsStale() public {
        _switchToSgov();
        _goStale();
        IParkAdapter a = park.adapter();
        assertFalse(a.isFresh());
        vm.prank(keeper);
        park.park(_one(alice));
        assertEq(park.units(alice), 0);
        assertEq(park.valueOf(alice), START);
    }
}
