// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StockRouter} from "../../src/StockRouter.sol";
import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice The REAL StockRouter over a MockPoolManager: venue from the registry,
///         minOut, oracle band, exact-input-or-nothing, and executor integration.
contract StockRouterTest is UnitBase {
    address internal caller = makeAddr("router-caller");

    event Bought(address indexed token, uint256 usdgIn, uint256 tokensOut, uint256 oraclePrice1e18);
    event Sold(address indexed token, uint256 tokensIn, uint256 usdgOut, uint256 oraclePrice1e18);

    function _realRouter() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        router.setCaller(caller, true);
        usdg.mint(caller, 1_000_000e6);
        vm.startPrank(caller);
        usdg.approve(address(router), type(uint256).max);
        spy.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _buy(address token, uint256 usdgIn, uint256 minOut) internal returns (uint256) {
        vm.prank(caller);
        return router.buy(token, usdgIn, minOut, caller);
    }

    function _assertRouterEmpty() internal view {
        assertEq(usdg.balanceOf(address(router)), 0, "router USDG residue");
        assertEq(spy.balanceOf(address(router)), 0, "router SPY residue");
        assertEq(nvda.balanceOf(address(router)), 0, "router NVDA residue");
        assertEq(qqq.balanceOf(address(router)), 0, "router QQQ residue");
    }

    // ── buy ──────────────────────────────────────────────────────────────

    function test_buy_fillsThroughTheRegisteredPool() public {
        uint256 fair = _fair(100e6, SPY_PX);
        vm.expectEmit(true, false, false, true, address(router));
        emit Bought(address(spy), 100e6, fair, 500e18);
        uint256 out = _buy(address(spy), 100e6, fair);
        assertEq(out, fair);
        assertEq(spy.balanceOf(caller), fair);
        assertEq(usdg.balanceOf(address(pm)), 100e6, "USDG settled to the pool manager");
        assertEq(pm.swapCount(), 1);
        _assertRouterEmpty();
    }

    function test_buy_notCaller() public {
        vm.prank(stranger);
        vm.expectRevert(StockRouter.NotCaller.selector);
        router.buy(address(spy), 1e6, 0, stranger);
    }

    function test_setCaller_revokes() public {
        vm.prank(owner);
        router.setCaller(caller, false);
        assertFalse(router.isCaller(caller));
        vm.prank(caller);
        vm.expectRevert(StockRouter.NotCaller.selector);
        router.buy(address(spy), 1e6, 0, caller);
    }

    function test_buy_inactiveAsset() public {
        vm.prank(owner);
        registry.setActive(address(spy), false);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.AssetInactive.selector, address(spy)));
        router.buy(address(spy), 1e6, 0, caller);
    }

    function test_buy_unregisteredAsset() public {
        address junk = makeAddr("junk");
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.UnknownAsset.selector, junk));
        router.buy(junk, 1e6, 0, caller);
    }

    function test_buy_staleOracle() public {
        spyFeed.setUpdatedAt(block.timestamp - 2 days);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.OracleNotOk.selector, OracleGuard.Status.STALE));
        router.buy(address(spy), 1e6, 0, caller);
    }

    function test_buy_pausedToken() public {
        spy.setOraclePaused(true);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.OracleNotOk.selector, OracleGuard.Status.PAUSED));
        router.buy(address(spy), 1e6, 0, caller);
    }

    function test_buy_belowMinOut() public {
        _setPoolFill(address(spy), SPY_PX, 9_950);
        uint256 fair = _fair(10e6, SPY_PX);
        uint256 out = (fair * 9_950) / 10_000;
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.BelowMinOut.selector, out, fair));
        router.buy(address(spy), 10e6, fair, caller);
    }

    /// The oracle band is enforced independently of minOut (SPARE-BUILD.md §3.5).
    function test_buy_outsideOracleBandEvenWithZeroMinOut() public {
        _setPoolFill(address(spy), SPY_PX, 9_849); // 1.51% worse than oracle; band is 1.5%
        uint256 fair = _fair(10e6, SPY_PX);
        uint256 out = (10e6 * 1e20 * 9_849) / (uint256(SPY_PX) * 10_000);
        uint256 floor = (fair * (10_000 - BAND)) / 10_000;
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.OutsideOracleBand.selector, out, floor));
        router.buy(address(spy), 10e6, 0, caller);
    }

    function test_buy_atTheBandEdgeIsAccepted() public {
        _setPoolFill(address(spy), SPY_PX, 9_850);
        uint256 out = _buy(address(spy), 10e6, 0);
        assertEq(out, (_fair(10e6, SPY_PX) * 9_850) / 10_000);
    }

    /// The band is per asset: tightening SPY's to 0.5% rejects a 0.6%-worse fill
    /// that the default 1.5% band would accept.
    function test_buy_perAssetBandIsRespected() public {
        vm.prank(owner);
        registry.setAsset(address(spy), address(spyFeed), HEARTBEAT, 50, _key(address(spy)));
        _setPoolFill(address(spy), SPY_PX, 9_940);
        vm.prank(caller);
        vm.expectRevert(); // 0.6% worse breaches a 0.5% band
        router.buy(address(spy), 10e6, 0, caller);
    }

    function test_buy_partialFillReverts() public {
        pm.setCapIn(address(usdg), address(spy), 40e6);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.PartialFill.selector, 40e6, 100e6));
        router.buy(address(spy), 100e6, 0, caller);
        _assertRouterEmpty();
    }

    function test_buy_sequencerDown() public {
        MockFeed seq = new MockFeed(0, 1);
        vm.prank(owner);
        router.setSequencerFeed(address(seq));
        (OracleGuard.Status s,) = router.oracleStatus(address(spy));
        assertEq(uint8(s), uint8(OracleGuard.Status.SEQUENCER_DOWN));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(StockRouter.OracleNotOk.selector, OracleGuard.Status.SEQUENCER_DOWN));
        router.buy(address(spy), 1e6, 0, caller);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.prank(stranger);
        vm.expectRevert(StockRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    /// v4 sorts currencies, so the router must pick zeroForOne from the key: buys
    /// work whether the asset sorts below or above USDG.
    function test_buy_bothPoolOrientations() public {
        MockStockToken low;
        MockStockToken high;
        for (uint256 i; i < 64 && (address(low) == address(0) || address(high) == address(0)); ++i) {
            MockStockToken t = new MockStockToken("T", "T");
            if (address(t) < address(usdg) && address(low) == address(0)) low = t;
            if (address(t) > address(usdg) && address(high) == address(0)) high = t;
        }
        assertTrue(address(low) != address(0) && address(high) != address(0), "found both orientations");
        MockFeed f = new MockFeed(8, 250e8);
        vm.startPrank(owner);
        _registerActive(address(low), address(f));
        _registerActive(address(high), address(f));
        vm.stopPrank();
        _setPoolFill(address(low), 250e8, 10_000);
        _setPoolFill(address(high), 250e8, 10_000);
        assertEq(_buy(address(low), 5e6, 0), _fair(5e6, 250e8));
        assertEq(_buy(address(high), 5e6, 0), _fair(5e6, 250e8));
        assertEq(low.balanceOf(caller), _fair(5e6, 250e8));
        assertEq(high.balanceOf(caller), _fair(5e6, 250e8));
    }

    // ── sell ─────────────────────────────────────────────────────────────

    function test_sell_atOracle() public {
        spy.mint(caller, 2e18);
        vm.expectEmit(true, false, false, true, address(router));
        emit Sold(address(spy), 2e18, 1_000e6, 500e18);
        vm.prank(caller);
        uint256 out = router.sell(address(spy), 2e18, 0, caller);
        assertEq(out, 1_000e6);
        _assertRouterEmpty();
    }

    function test_sell_outsideBand() public {
        spy.mint(caller, 2e18);
        _setPoolFill(address(spy), SPY_PX, 9_800);
        vm.prank(caller);
        vm.expectRevert();
        router.sell(address(spy), 2e18, 0, caller);
    }

    // ── math ─────────────────────────────────────────────────────────────

    function testFuzz_oracleMathRoundTrips(uint64 usdgIn, uint64 px8) public view {
        uint256 u = bound(usdgIn, 1e6, 1e15);
        uint256 p = bound(px8, 1e6, 1e14) * 1e10; // $0.01 .. $1m per token
        uint256 tokens = router.oracleTokensFor(u, p);
        uint256 back = router.oracleUsdgFor(tokens, p);
        assertLe(back, u, "never rounds in the user's favour twice");
        assertGe(back + 1, u, "loses at most one base unit");
    }

    // ── executor over the real router ────────────────────────────────────

    function test_executor_realRouterSwap() public {
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 10e6);
        assertEq(_sweep(_one(alice)), 1);
        assertEq(spy.balanceOf(alice), _fair(6e6 - 15_000, SPY_PX));
        assertEq(nvda.balanceOf(alice), _fair(4e6 - 10_000, NVDA_PX));
        assertEq(usdg.balanceOf(address(vault)), 25_000);
        _assertRouterEmpty();
        assertEq(usdg.balanceOf(address(exec)), 0);
    }

    /// A fill outside the band is "not now": the leg defers back to the park, it
    /// is never paid out as USDG.
    function test_executor_bandBreachDefers() public {
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 10e6);
        _setPoolFill(address(spy), SPY_PX, 9_700);
        uint256 before = usdg.balanceOf(alice);
        _sweep(_one(alice));
        assertEq(spy.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(alice), before, "not paid out");
        assertEq(park.pending(alice), 6e6, "deferred");
        assertEq(usdg.balanceOf(address(vault)), 10_000);
        _assertRouterEmpty();
        assertEq(usdg.balanceOf(address(exec)), 0);
    }

    /// An exhausted pool (partial fill) reverts inside the router; the executor
    /// defers that leg for every contributor and the rest of the batch converts.
    function test_executor_partialFillDefersNotReverts() public {
        _onboard(alice, 100e6, 100e6);
        _onboard(bob, 100e6, 100e6);
        _accrue(alice, 10e6);
        _accrue(bob, 10e6);
        pm.setCapIn(address(usdg), address(spy), 1e6);
        uint256 aBefore = usdg.balanceOf(alice);
        assertEq(_sweep(_two(alice, bob)), 2);
        assertEq(usdg.balanceOf(alice), aBefore, "not paid out");
        assertEq(park.pending(alice), 6e6);
        assertEq(park.pending(bob), 6e6);
        assertGt(nvda.balanceOf(alice), 0);
        assertGt(nvda.balanceOf(bob), 0);
        _assertRouterEmpty();
        assertEq(usdg.balanceOf(address(exec)), 0);
        assertEq(IERC20(address(spy)).balanceOf(address(exec)), 0);
    }

    /// Over the REAL router: a keeper quote limit tighter than the oracle band
    /// refuses a fill the band alone would accept.
    function test_executor_keeperLimitBindsInsideTheBand() public {
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 10e6);
        _setPoolFill(address(spy), SPY_PX, 9_900); // 1% worse: inside the 1.5% band
        uint256 tight = (_fair(1e6, SPY_PX) * 9_970) / 10_000; // quote less 30 bp
        _sweepWith(_one(alice), _limitsWith(address(spy), tight));
        assertEq(spy.balanceOf(alice), 0, "refused by the keeper limit");
        assertEq(park.pending(alice), 6e6);
        assertGt(nvda.balanceOf(alice), 0);
        _assertRouterEmpty();
    }
}
