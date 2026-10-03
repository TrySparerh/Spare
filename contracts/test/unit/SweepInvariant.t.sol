// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {CashPark} from "../../src/CashPark.sol";
import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Drives the whole system — accrue, park, sweep (as the keeper, with
///         oracle-derived limits), exit, claim — while flipping every outcome lever:
///         stale feeds (defer), oracle pauses (defer), deactivation (safe-settle),
///         bad fills and partial fills (defer), recipient blocklists (claimable),
///         keeper limits dropped or tightened (defer), and time.
contract SweepHandler is Test {
    SweepExecutor public immutable exec;
    CashPark public immutable park;
    AssetRegistry public immutable registry;
    MockPoolManager public immutable pm;
    MockERC20 public immutable usdg;
    address public immutable keeper;
    address public immutable owner;

    address[4] public actors;
    MockStockToken[3] public toks;
    MockFeed[3] public feeds;
    int256[3] public px;
    bool[3] public stale;
    /// Per-asset keeper limit mode: 0 = oracle-derived (the backstop), 1 = missing,
    /// 2 = tight (a 10 bp quote tolerance, so worse fills defer).
    uint8[3] public limitMode;

    uint256 public sweeps;
    uint256 public sweptAccounts;

    constructor(
        SweepExecutor exec_,
        CashPark park_,
        AssetRegistry registry_,
        MockPoolManager pm_,
        MockERC20 usdg_,
        address keeper_,
        address owner_,
        address[4] memory actors_,
        MockStockToken[3] memory toks_,
        MockFeed[3] memory feeds_,
        int256[3] memory px_
    ) {
        exec = exec_;
        park = park_;
        registry = registry_;
        pm = pm_;
        usdg = usdg_;
        keeper = keeper_;
        owner = owner_;
        actors = actors_;
        toks = toks_;
        feeds = feeds_;
        px = px_;
    }

    function _batch(uint256 seed, uint256 n) internal view returns (address[] memory b) {
        b = new address[](bound(n, 1, 6));
        for (uint256 i; i < b.length; ++i) {
            b[i] = actors[(seed >> (i * 8)) % 4];
        }
    }

    /// Accrues for every actor whose bit is set in `mask` (at least one), amounts
    /// derived from `seed`, each bounded by that account's remaining weekly cap.
    function accrue(uint256 mask, uint256 seed) external {
        uint256 buf = exec.finalityBuffer();
        vm.roll(block.number + buf + 10);
        uint256 to = block.number - buf - 1;
        mask = (mask % 15) + 1;
        for (uint256 i; i < 4; ++i) {
            if (mask & (1 << i) == 0) continue;
            address a = actors[i];
            uint256 rem = exec.remainingWeeklyCap(a);
            uint256 amt = bound(uint256(keccak256(abi.encode(seed, i))), 0, rem > 120e6 ? 120e6 : rem);
            if (usdg.blocked(a)) continue;
            vm.prank(keeper);
            exec.accrue(a, a, amt, to);
        }
    }

    function _limits() internal view returns (SweepExecutor.Limit[] memory l) {
        l = new SweepExecutor.Limit[](3);
        StockRouter r = exec.router();
        uint256 slip = exec.slippageBps();
        for (uint256 i; i < 3; ++i) {
            (OracleGuard.Status s, uint256 p) = r.oracleStatus(address(toks[i]));
            uint256 m;
            if (limitMode[i] != 1) {
                m = s == OracleGuard.Status.OK ? r.oracleTokensFor(1e6, p) : 1;
                m = (m * (10_000 - (limitMode[i] == 2 ? 10 : slip))) / 10_000;
                if (m == 0) m = 1;
            }
            l[i] = SweepExecutor.Limit(address(toks[i]), m);
        }
    }

    /// Half the time the sweep runs in a fresh epoch (a new day: feeds that are not
    /// flagged stale have ticked), so the per-epoch gate does not starve the run.
    function sweep(uint256 seed, uint256 n) external {
        if (seed % 2 == 0) {
            vm.warp((block.timestamp / exec.epochLength() + 1) * exec.epochLength() + 60);
            for (uint256 i; i < 3; ++i) {
                if (!stale[i]) feeds[i].setUpdatedAt(block.timestamp);
            }
        }
        address[] memory b = _batch(seed >> 1, n);
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(keeper);
        sweptAccounts += exec.sweep(b, l);
        sweeps++;
    }

    function setLimitMode(uint256 w, uint256 mode) external {
        limitMode[w % 3] = uint8(mode % 6 < 4 ? 0 : mode % 6 - 3); // 2/3 of the time oracle-derived
    }

    function parkBatch(uint256 seed, uint256 n) external {
        address[] memory b = _batch(seed, n);
        vm.prank(keeper);
        park.park(b);
    }

    function exit(uint256 s) external {
        address a = actors[s % 4];
        vm.prank(a);
        park.exit();
    }

    /// claim() always pays the account itself, so it only goes through once the
    /// token no longer blocks that account.
    function claim(uint256 s, uint256 w) external {
        address a = actors[s % 4];
        MockERC20 t = w % 4 == 3 ? usdg : MockERC20(address(toks[w % 4]));
        if (t.blocked(a)) return;
        vm.prank(a);
        exec.claim(address(t));
    }

    // Outcome levers are biased toward "healthy" (each impairment ~1 in 4) so that
    // runs see many real swaps interleaved with defers, safe-settles and held
    // deliveries, instead of a system that is broken most of the time.

    function setStale(uint256 w, uint256 flag) external {
        uint256 i = w % 3;
        bool st = flag % 4 == 0;
        stale[i] = st;
        feeds[i].setUpdatedAt(st ? block.timestamp - 2 days : block.timestamp);
    }

    function setOraclePaused(uint256 w, uint256 flag) external {
        toks[w % 3].setOraclePaused(flag % 4 == 0);
    }

    function setActive(uint256 w, uint256 flag) external {
        vm.prank(owner);
        registry.setActive(address(toks[w % 3]), flag % 4 != 0);
    }

    /// Fills from 1.6% worse than oracle (breaches the 1.5% backstop and band) to
    /// 1% better.
    function setFill(uint256 w, uint256 bps) external {
        uint256 i = w % 3;
        bps = bound(bps, 9_840, 10_100);
        pm.setRate(address(usdg), address(toks[i]), 1e20 * bps, uint256(px[i]) * 10_000);
    }

    function setPartialFill(uint256 w, uint256 flag) external {
        pm.setCapIn(address(usdg), address(toks[w % 3]), flag % 4 == 0 ? 1e6 : 0);
    }

    function setBlocked(uint256 s, uint256 w, uint256 flag) external {
        address a = actors[s % 4];
        bool on = flag % 4 == 0;
        if (w % 4 == 3) usdg.setBlocked(a, on);
        else toks[w % 4].setBlocked(a, on);
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1 hours, 3 days);
        vm.warp(block.timestamp + dt);
        for (uint256 i; i < 3; ++i) {
            if (!stale[i]) feeds[i].setUpdatedAt(block.timestamp);
        }
    }
}

/// @notice System invariants over the REAL StockRouter (MockPoolManager venue):
///         - CashPark.totalPending == sum(pending) and USDG covers it
///         - after any sequence of sweeps, SweepExecutor holds exactly what it owes
///           as claimable (no residual USDG or stock) and StockRouter holds nothing
///         - every USDG is somewhere accounted for (no leak to an unexpected
///           address; claims can only ever pay the account itself)
contract SweepInvariantTest is UnitBase {
    SweepHandler internal h;
    address[4] internal actors;

    function _realRouter() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        actors = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            usdg.mint(actors[i], 1_000_000e6);
            vm.startPrank(actors[i]);
            usdg.approve(address(permit2), type(uint256).max);
            permit2.approve(address(usdg), address(exec), type(uint160).max, type(uint48).max);
            rules.linkSelf();
            rules.setRule(1, 1, 1_000e6, true);
            vm.stopPrank();
        }
        // Mixed elections: default 60/40, all-QQQ, and a 3-leg mix.
        vm.prank(bob);
        elections.setMix(_mix1(address(qqq)));
        ElectionRegistry.Leg[] memory l = new ElectionRegistry.Leg[](3);
        l[0] = ElectionRegistry.Leg(address(spy), 3334);
        l[1] = ElectionRegistry.Leg(address(nvda), 3333);
        l[2] = ElectionRegistry.Leg(address(qqq), 3333);
        vm.prank(carol);
        elections.setMix(l);

        h = new SweepHandler(
            exec,
            park,
            registry,
            pm,
            usdg,
            keeper,
            owner,
            actors,
            [spy, nvda, qqq],
            [spyFeed, nvdaFeed, qqqFeed],
            [SPY_PX, NVDA_PX, QQQ_PX]
        );
        targetContract(address(h));
    }

    function _claimable(address token) internal view returns (uint256 sum) {
        for (uint256 i; i < 4; ++i) {
            sum += exec.claimable(actors[i], token);
        }
    }

    function invariant_parkPendingAccounting() public view {
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            sum += park.pending(actors[i]);
        }
        assertEq(park.totalPending(), sum, "totalPending == sum(pending)");
        assertGe(usdg.balanceOf(address(park)), park.totalPending(), "USDG balance >= totalPending");
    }

    function invariant_parkUnitsAccounting() public view {
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            sum += park.units(actors[i]);
        }
        assertEq(park.totalUnits(), sum);
        assertEq(usdg.balanceOf(address(usdgAdapter)), park.totalUnits(), "identity adapter: 1 unit = 1 USDG");
    }

    function invariant_executorHoldsOnlyClaimables() public view {
        assertEq(usdg.balanceOf(address(exec)), _claimable(address(usdg)), "residual USDG in executor");
        assertEq(spy.balanceOf(address(exec)), _claimable(address(spy)), "residual SPY in executor");
        assertEq(nvda.balanceOf(address(exec)), _claimable(address(nvda)), "residual NVDA in executor");
        assertEq(qqq.balanceOf(address(exec)), _claimable(address(qqq)), "residual QQQ in executor");
    }

    function invariant_routerHoldsNothing() public view {
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(spy.balanceOf(address(router)), 0);
        assertEq(nvda.balanceOf(address(router)), 0);
        assertEq(qqq.balanceOf(address(router)), 0);
    }

    function invariant_usdgFullyAccounted() public view {
        uint256 accounted = usdg.balanceOf(address(park)) + usdg.balanceOf(address(usdgAdapter))
            + usdg.balanceOf(address(exec)) + usdg.balanceOf(address(vault)) + usdg.balanceOf(address(pm))
            + usdg.balanceOf(address(router));
        for (uint256 i; i < 4; ++i) {
            accounted += usdg.balanceOf(actors[i]);
        }
        assertEq(accounted, usdg.totalSupply(), "USDG leaked to an unexpected address");
    }
}
