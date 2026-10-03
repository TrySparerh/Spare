// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdError} from "forge-std/StdError.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {SgovFixture} from "./SgovFixture.sol";

/// @notice SgovParkAdapter (the standby park, SPARE-BUILD.md §3.6) over the REAL
///         StockRouter and a MockPoolManager: buys and sells through the router at
///         the oracle less the adapter's own slippage, in-kind exits that touch no
///         oracle or pool, NAV at the latest feed answer, freshness from the
///         router's guards — then the same adapter driven through CashPark.
contract SgovParkAdapterTest is SgovFixture {
    event Bought(address indexed token, uint256 usdgIn, uint256 tokensOut, uint256 oraclePrice1e18);
    event Sold(address indexed token, uint256 tokensIn, uint256 usdgOut, uint256 oraclePrice1e18);

    uint256 internal constant PX18 = uint256(SGOV_PX) * 1e10;

    /// @dev CashPark transfers the USDG to the adapter, then calls deposit.
    function _deposit(uint256 amount) internal returns (uint256) {
        usdg.mint(address(sgovAdapter), amount);
        vm.prank(address(park));
        return sgovAdapter.deposit(amount);
    }

    function _redeem(uint256 units, address to) internal returns (uint256) {
        vm.prank(address(park));
        return sgovAdapter.redeem(units, to);
    }

    function _minOut(uint256 fair) internal pure returns (uint256) {
        return (fair * (10_000 - SGOV_SLIPPAGE)) / 10_000;
    }

    // ── wiring ───────────────────────────────────────────────────────────

    function test_constructor_wiresEverythingAndApprovesTheRouter() public view {
        assertEq(sgovAdapter.usdg(), address(usdg));
        assertEq(sgovAdapter.sgov(), address(sgov));
        assertEq(sgovAdapter.park(), address(park));
        assertEq(address(sgovAdapter.router()), address(router));
        assertEq(address(sgovAdapter.registry()), address(registry), "registry read from the router");
        assertEq(sgovAdapter.slippageBps(), SGOV_SLIPPAGE);
        assertEq(sgovAdapter.underlying(), address(sgov), "in-kind exits hand over SGOV");
        assertEq(usdg.allowance(address(sgovAdapter), address(router)), type(uint256).max);
        assertEq(sgov.allowance(address(sgovAdapter), address(router)), type(uint256).max);
    }

    function test_onlyPark_guardsEveryEntryThatMovesValue() public {
        vm.startPrank(stranger);
        vm.expectRevert(SgovParkAdapter.NotPark.selector);
        sgovAdapter.deposit(1e6);
        vm.expectRevert(SgovParkAdapter.NotPark.selector);
        sgovAdapter.redeem(1, stranger);
        vm.expectRevert(SgovParkAdapter.NotPark.selector);
        sgovAdapter.exitInKind(1, stranger);
        vm.stopPrank();
    }

    // ── deposit ──────────────────────────────────────────────────────────

    function test_deposit_buysSgovThroughTheRouterAtTheOracle() public {
        uint256 fair = _fair(100e6, SGOV_PX);
        usdg.mint(address(sgovAdapter), 100e6);
        vm.expectEmit(true, false, false, true, address(router));
        emit Bought(address(sgov), 100e6, fair, PX18);
        vm.prank(address(park));
        uint256 units = sgovAdapter.deposit(100e6);
        assertEq(units, fair, "1 unit = 1 SGOV base unit");
        assertEq(sgov.balanceOf(address(sgovAdapter)), units, "the adapter holds the SGOV");
        assertEq(usdg.balanceOf(address(sgovAdapter)), 0, "every USDG went into the buy");
        assertEq(pm.swapCount(), 1);
    }

    /// minOut is the oracle less the adapter's 100 bps — tighter than the router's
    /// 150 bps band, so a 1.01% shortfall that the band alone would accept fails.
    function test_deposit_minOutIsTheOracleLessTheAdaptersSlippage() public {
        uint256 fair = router.oracleTokensFor(100e6, PX18);
        _setPoolFill(address(sgov), SGOV_PX, 9_901);
        assertEq(_deposit(100e6), pm.quote(address(usdg), address(sgov), 100e6), "99 bps short is accepted");

        _setPoolFill(address(sgov), SGOV_PX, 9_899);
        uint256 out = pm.quote(address(usdg), address(sgov), 100e6);
        usdg.mint(address(sgovAdapter), 100e6);
        vm.prank(address(park));
        vm.expectRevert(abi.encodeWithSelector(StockRouter.BelowMinOut.selector, out, _minOut(fair)));
        sgovAdapter.deposit(100e6);
    }

    /// Off-hours the router reports price 0, and the adapter's minOut divides by
    /// it. CashPark never gets here: park() is a no-op while !isFresh().
    function test_deposit_revertsWhileTheOracleIsNotOk() public {
        _goStale();
        usdg.mint(address(sgovAdapter), 100e6);
        vm.prank(address(park));
        vm.expectRevert(stdError.divisionError);
        sgovAdapter.deposit(100e6);
    }

    // ── redeem ───────────────────────────────────────────────────────────

    function test_redeem_sellsToTheRecipientAtTheOracle() public {
        uint256 units = _deposit(100e6);
        uint256 expected = router.oracleUsdgFor(units, PX18);
        vm.expectEmit(true, false, false, true, address(router));
        emit Sold(address(sgov), units, expected, PX18);
        assertEq(_redeem(units, alice), expected);
        assertEq(usdg.balanceOf(alice), expected, "USDG straight to the recipient");
        assertEq(sgov.balanceOf(address(sgovAdapter)), 0);
        assertApproxEqAbs(expected, 100e6, 1, "round trip at the oracle loses only rounding");
    }

    function test_redeem_minOutIsTheOracleLessTheAdaptersSlippage() public {
        uint256 units = _deposit(100e6);
        uint256 fair = router.oracleUsdgFor(units, PX18);
        _setPoolFill(address(sgov), SGOV_PX, 9_899);
        uint256 out = pm.quote(address(sgov), address(usdg), units);
        vm.prank(address(park));
        vm.expectRevert(abi.encodeWithSelector(StockRouter.BelowMinOut.selector, out, _minOut(fair)));
        sgovAdapter.redeem(units, alice);

        _setPoolFill(address(sgov), SGOV_PX, 9_901);
        assertEq(_redeem(units, alice), pm.quote(address(sgov), address(usdg), units));
    }

    /// A stale SGOV feed makes the market path revert; CashPark catches that
    /// (sweep keeps the units parked, exit falls back to in-kind).
    function test_redeem_revertsWhileTheOracleIsNotOk() public {
        uint256 units = _deposit(100e6);
        _goStale();
        vm.prank(address(park));
        vm.expectRevert(abi.encodeWithSelector(StockRouter.OracleNotOk.selector, OracleGuard.Status.STALE));
        sgovAdapter.redeem(units, alice);
    }

    // ── exitInKind ───────────────────────────────────────────────────────

    /// The exit path depends on nothing but SGOV's own transfer: feed down, pool
    /// gone, and the units still move.
    function test_exitInKind_movesSgovWithNoOracleOrPool() public {
        uint256 units = _deposit(100e6);
        sgovFeed.setReverts(true);
        pm.setRate(address(sgov), address(usdg), 0, 0);
        vm.prank(address(park));
        sgovAdapter.exitInKind(units, alice);
        assertEq(sgov.balanceOf(alice), units);
        assertEq(sgov.balanceOf(address(sgovAdapter)), 0);
    }

    // ── valueOf ──────────────────────────────────────────────────────────

    function test_valueOf_zeroUnitsNeverReadsTheFeed() public {
        sgovFeed.setReverts(true);
        assertEq(sgovAdapter.valueOf(0), 0);
    }

    function test_valueOf_atTheLatestAnswer() public {
        uint256 units = _deposit(100e6);
        assertEq(sgovAdapter.valueOf(units), router.oracleUsdgFor(units, PX18));
        sgovFeed.setAnswer(101e8);
        assertEq(sgovAdapter.valueOf(units), router.oracleUsdgFor(units, 101e18), "NAV follows the feed");
    }

    /// By design a stale answer still values the units (display and thresholds);
    /// isFresh is what gates parking.
    function test_valueOf_staleAnswerStillValues() public {
        uint256 units = _deposit(100e6);
        uint256 v = sgovAdapter.valueOf(units);
        _goStale();
        assertFalse(sgovAdapter.isFresh());
        assertEq(sgovAdapter.valueOf(units), v);
    }

    function test_valueOf_nonPositiveAnswerIsZero() public {
        uint256 units = _deposit(100e6);
        sgovFeed.setAnswer(0);
        assertEq(sgovAdapter.valueOf(units), 0);
        sgovFeed.setAnswer(-1);
        assertEq(sgovAdapter.valueOf(units), 0);
    }

    /// The registry caches the feed's decimals at setAsset; valueOf scales by them.
    function test_valueOf_scalesTheFeedsDecimals() public {
        uint256 units = _deposit(100e6);
        uint256 v8 = sgovAdapter.valueOf(units);
        MockFeed f18 = new MockFeed(18, int256(PX18));
        MockFeed f6 = new MockFeed(6, SGOV_PX / 100);
        vm.startPrank(owner);
        registry.setAsset(address(sgov), address(f18), HEARTBEAT, BAND, _key(address(sgov)));
        assertEq(sgovAdapter.valueOf(units), v8, "18-dp feed");
        registry.setAsset(address(sgov), address(f6), HEARTBEAT, BAND, _key(address(sgov)));
        assertEq(sgovAdapter.valueOf(units), v8, "6-dp feed");
        vm.stopPrank();
    }

    /// Lead in the audit (standby only): valueOf has no try/catch, so a reverting
    /// SGOV feed reverts CashPark.valueOf, and with it every sweep that reaches an
    /// account holding parked units. Fix before enabling SGOV; the live
    /// UsdgParkAdapter has no feed.
    function test_valueOf_revertingFeedRevertsEverySweepThatTouchesParkedUnits() public {
        _switchToSgov();
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 20e6);
        vm.prank(keeper);
        park.park(_one(alice));
        assertGt(park.units(alice), 0);

        sgovFeed.setReverts(true);
        vm.expectRevert(bytes("MockFeed: down"));
        sgovAdapter.valueOf(1);
        vm.expectRevert(bytes("MockFeed: down"));
        park.valueOf(alice);
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(keeper);
        vm.expectRevert(bytes("MockFeed: down"));
        exec.sweep(_one(alice), l);
    }

    // ── isFresh ──────────────────────────────────────────────────────────

    function test_isFresh_tracksTheRoutersOracleStatus() public {
        assertTrue(sgovAdapter.isFresh());
        sgov.setOraclePaused(true);
        assertFalse(sgovAdapter.isFresh(), "oraclePaused");
        sgov.setOraclePaused(false);
        sgov.setPaused(true);
        assertFalse(sgovAdapter.isFresh(), "token paused");
        sgov.setPaused(false);
        sgovFeed.setAnswer(0);
        assertFalse(sgovAdapter.isFresh(), "bad answer");
        sgovFeed.setAnswer(SGOV_PX);
        assertTrue(sgovAdapter.isFresh());
        _goStale();
        assertFalse(sgovAdapter.isFresh(), "stale");
    }

    // ── through CashPark ─────────────────────────────────────────────────

    /// The whole standby path: accrue -> park into SGOV -> sweep redeems the
    /// units at market and buys the mix.
    function test_cashPark_parkThenSweepRedeemsAndBuysTheMix() public {
        _switchToSgov();
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 20e6);
        vm.prank(keeper);
        park.park(_one(alice));
        uint256 units = park.units(alice);
        assertEq(units, _fair(20e6, SGOV_PX));
        assertEq(park.pending(alice), 0);
        assertApproxEqAbs(park.valueOf(alice), 20e6, 1);

        uint256 got = router.oracleUsdgFor(units, PX18);
        assertEq(_sweep(_one(alice)), 1);
        assertEq(park.units(alice), 0, "units redeemed for the sweep");
        assertEq(sgov.balanceOf(address(sgovAdapter)), 0);
        uint256 spyLeg = (got * 6_000) / 10_000;
        assertEq(spy.balanceOf(alice), _fair(spyLeg - (spyLeg * 25) / 10_000, SPY_PX));
        uint256 nvdaLeg = got - spyLeg;
        assertEq(nvda.balanceOf(alice), _fair(nvdaLeg - (nvdaLeg * 25) / 10_000, NVDA_PX));
    }

    function test_cashPark_parkIsANoopWhileSgovIsStale() public {
        _switchToSgov();
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 20e6);
        _goStale();
        vm.prank(keeper);
        park.park(_one(alice));
        assertEq(park.units(alice), 0, "held as plain USDG");
        assertEq(park.pending(alice), 20e6);
        assertEq(pm.swapCount(), 0);
    }

    /// Off-hours exit: pending USDG paid, parked units handed over as SGOV.
    function test_cashPark_exitWhileStalePaysInKind() public {
        _switchToSgov();
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 20e6);
        vm.prank(keeper);
        park.park(_one(alice));
        uint256 units = park.units(alice);
        _accrue(alice, 5e6);
        _goStale();

        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        (uint256 usdgOut, uint256 inKind) = park.exit();
        assertEq(usdgOut, 5e6, "pending paid first, in USDG");
        assertEq(inKind, units);
        assertEq(sgov.balanceOf(alice), units, "units in kind");
        assertEq(usdg.balanceOf(alice), before + 5e6);
        assertEq(park.totalUnits(), 0);
        assertEq(IERC20(address(sgov)).balanceOf(address(sgovAdapter)), 0);
    }
}
