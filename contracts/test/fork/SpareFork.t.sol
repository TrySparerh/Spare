// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {RuleRegistry} from "../../src/RuleRegistry.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {ScreeningGate} from "../../src/ScreeningGate.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {CashPark} from "../../src/CashPark.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {UsdgParkAdapter} from "../../src/park/UsdgParkAdapter.sol";
import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {RoundUp} from "../../src/libraries/RoundUp.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockArbSys} from "../mocks/MockArbSys.sol";

/// @notice End-to-end against a Robinhood Chain MAINNET fork: real Uniswap v4
///         pools, real Chainlink feeds, real Permit2, real stock tokens.
/// @dev Pinned to a block where US equity feeds are fresh, so results are
///      deterministic and cached. Run with RHC_RPC_URL set.
contract SpareForkTest is Test {
    // ── mainnet addresses (verified 2026-09-29) ──────────────────────────
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 constant FORK_BLOCK = 76_122_176;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    AssetRegistry registry;
    RuleRegistry rules;
    ElectionRegistry elections;
    ScreeningGate screening;
    StockRouter router;
    CashPark park;
    FeeVault vault;
    SweepExecutor exec;

    function setUp() public {
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), FORK_BLOCK);
        // Nitro serves 0xfe at 0x64; put a real ArbSys there so L2Clock takes its
        // production branch on the fork.
        vm.etch(address(0x64), address(new MockArbSys()).code);

        vm.startPrank(owner);
        registry = new AssetRegistry(owner, USDG);
        rules = new RuleRegistry();
        elections = new ElectionRegistry(owner, registry);
        screening = new ScreeningGate(owner, owner, false);
        router = new StockRouter(owner, IPoolManager(POOL_MANAGER), registry);
        park = new CashPark(owner, IERC20(USDG));
        vault = new FeeVault(owner);
        exec = new SweepExecutor(
            owner, IAllowanceTransfer(PERMIT2), rules, elections, screening, router, park, vault
        );

        // Exact pool keys, hook included — the venue allowlist.
        registry.setAsset(SPY, SPY_FEED, 86_400, 150, _key(SPY, USDG, 3000, 60, address(0)));
        registry.setAsset(
            NVDA, NVDA_FEED, 86_400, 150, _key(USDG, NVDA, 0, 1, 0xA0D185c901E4abD21f94D4E3ba8FAbc3E29E80c4)
        );
        registry.setAsset(
            SGOV, SGOV_FEED, 86_400, 150, _key(USDG, SGOV, 0, 200, 0xc52fc52698479E42F0dA9a8a75296EC3871454c0)
        );
        registry.setActive(SPY, true);
        registry.setActive(NVDA, true);
        registry.setActive(SGOV, true);

        router.setCaller(address(exec), true);
        park.setExecutor(address(exec));
        park.setAdapter(new UsdgParkAdapter(USDG, address(park)));
        park.setKeeper(keeper, true);
        exec.setKeeper(keeper, true);

        ElectionRegistry.Leg[] memory d = new ElectionRegistry.Leg[](2);
        d[0] = ElectionRegistry.Leg(SPY, 6000);
        d[1] = ElectionRegistry.Leg(NVDA, 4000);
        elections.setDefaultMix(d);
        vm.stopPrank();

        _onboard(alice, 100e6);
        _onboard(bob, 100e6);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _key(address c0, address c1, uint24 fee, int24 ts, address hooks) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(hooks));
    }

    /// @dev Fund, link, rule ($1, 1x, $50/wk), and grant a capped Permit2 allowance.
    function _onboard(address user, uint256 usdgAmount) internal {
        deal(USDG, user, usdgAmount);
        vm.startPrank(user);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), uint160(50e6), uint48(block.timestamp + 30 days));
        rules.linkSelf();
        rules.setRule(1, 1, 50e6, true);
        vm.stopPrank();
    }

    /// @dev Move past the finality buffer and return the newest block that may be
    ///      accrued. Returned BEFORE any vm.prank: an external read inside a call's
    ///      argument list would otherwise consume the prank itself.
    function _pastFinality() internal returns (uint256 toBlock) {
        uint256 buf = exec.finalityBuffer();
        vm.roll(block.number + buf + 10);
        toBlock = block.number - buf - 1;
    }

    function _accrue(address user, uint256 amount) internal {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        exec.accrue(user, user, amount, to);
    }

    /// @dev The keeper's per-asset limits, derived from the oracle with a 1.5%
    ///      tolerance (fills on these pools measure within ~0.3% of Chainlink; in
    ///      production the keeper uses a same-block v4 quote instead). An asset
    ///      whose oracle is not OK gets 1 — its leg defers regardless.
    function _limits() internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        l = new SweepExecutor.Limit[](toks.length);
        for (uint256 i; i < toks.length; ++i) {
            (OracleGuard.Status s, uint256 p) = router.oracleStatus(toks[i]);
            uint256 m = s == OracleGuard.Status.OK ? (router.oracleTokensFor(1e6, p) * 9_850) / 10_000 : 1;
            l[i] = SweepExecutor.Limit(toks[i], m);
        }
    }

    /// @dev Keeper sweep. Limits are computed BEFORE the prank so no external read
    ///      consumes it.
    function _sweepBatch(address[] memory accts) internal returns (uint256) {
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(keeper);
        return exec.sweep(accts, l);
    }

    function _sweep(address a) internal returns (uint256) {
        address[] memory accts = new address[](1);
        accts[0] = a;
        return _sweepBatch(accts);
    }

    // ── acceptance ───────────────────────────────────────────────────────

    /// (1) $3.75 payment -> $0.25 accrual at 1x, $0.75 at 3x.
    function test_acceptance1_roundUpMath() public pure {
        assertEq(RoundUp.delta(3_750_000, 1, 1), 250_000);
        assertEq(RoundUp.delta(3_750_000, 1, 3), 750_000);
        assertEq(RoundUp.delta(5_000_000, 1, 1), 0, "boundary payment accrues nothing");
        assertEq(RoundUp.delta(12_400_000, 5, 1), 2_600_000);
        assertEq(RoundUp.delta(12_400_000, 10, 1), 7_600_000);
    }

    /// (2) Accrued >= $5 -> sweep buys 60/40 SPY/NVDA at reference, delivered.
    function test_acceptance2_sweepBuys6040AtReference() public {
        _accrue(alice, 10e6);
        assertEq(park.valueOf(alice), 10e6);

        (OracleGuard.Status sSpy, uint256 pSpy) = router.oracleStatus(SPY);
        (OracleGuard.Status sNvda, uint256 pNvda) = router.oracleStatus(NVDA);
        assertEq(uint8(sSpy), uint8(OracleGuard.Status.OK), "SPY feed must be fresh at fork block");
        assertEq(uint8(sNvda), uint8(OracleGuard.Status.OK), "NVDA feed must be fresh at fork block");

        assertEq(_sweep(alice), 1);

        uint256 spyGot = IERC20(SPY).balanceOf(alice);
        uint256 nvdaGot = IERC20(NVDA).balanceOf(alice);
        assertGt(spyGot, 0, "SPY delivered");
        assertGt(nvdaGot, 0, "NVDA delivered");

        // Fee 0.25% off each leg; each fill must sit within 1.5% of Chainlink.
        uint256 spyIn = (6e6 * 9975) / 10_000;
        uint256 nvdaIn = (4e6 * 9975) / 10_000;
        uint256 spyRef = router.oracleTokensFor(spyIn, pSpy);
        uint256 nvdaRef = router.oracleTokensFor(nvdaIn, pNvda);
        assertApproxEqRel(spyGot, spyRef, 0.015e18, "SPY at reference");
        assertApproxEqRel(nvdaGot, nvdaRef, 0.015e18, "NVDA at reference");

        assertEq(park.valueOf(alice), 0, "park emptied");
        assertEq(IERC20(USDG).balanceOf(address(vault)), 25_000, "0.25% fee on $10");
        emit log_named_decimal_uint("SPY bought", spyGot, 18);
        emit log_named_decimal_uint("NVDA bought", nvdaGot, 18);
    }

    /// (3) Idle spare parks in SGOV and shows value at published NAV.
    function test_acceptance3_sgovParkShowsNav() public {
        vm.startPrank(owner);
        SgovParkAdapter sgov = new SgovParkAdapter(USDG, SGOV, address(park), router, 100);
        router.setCaller(address(sgov), true);
        park.setAdapter(sgov);
        vm.stopPrank();

        _accrue(alice, 20e6);
        address[] memory a = new address[](1);
        a[0] = alice;
        vm.prank(keeper);
        park.park(a);

        assertEq(park.pending(alice), 0, "moved out of pending");
        assertGt(park.units(alice), 0, "holds SGOV units");
        // Valued at the SGOV feed: within 1.5% of the $20 parked.
        assertApproxEqRel(park.valueOf(alice), 20e6, 0.015e18);
        emit log_named_decimal_uint("SGOV units", park.units(alice), 18);
        emit log_named_decimal_uint("valued at NAV", park.valueOf(alice), 6);
    }

    /// (6) Suspended asset in the mix -> that leg falls to USDG with a notice.
    function test_acceptance6_suspendedAssetSafeSettles() public {
        _accrue(alice, 10e6);
        vm.prank(owner);
        registry.setActive(NVDA, false);

        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        _sweep(alice);

        assertGt(IERC20(SPY).balanceOf(alice), 0, "SPY leg still bought");
        assertEq(IERC20(NVDA).balanceOf(alice), 0, "no NVDA");
        assertEq(IERC20(USDG).balanceOf(alice) - usdgBefore, 4e6, "NVDA leg returned as USDG, no fee");
    }

    /// (7) The weekly cap is never exceeded.
    function test_acceptance7_weeklyCapNeverExceeded() public {
        _accrue(alice, 30e6);
        uint256 to_ = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 51e6, 50e6));
        exec.accrue(alice, alice, 21e6, to_);
        // Exactly up to the cap is fine.
        uint256 to2 = _pastFinality();
        vm.prank(keeper);
        exec.accrue(alice, alice, 20e6, to2);
        assertEq(exec.remainingWeeklyCap(alice), 0);
    }

    // ── safety properties ────────────────────────────────────────────────

    function test_doubleSweepImpossibleWithinEpoch() public {
        _accrue(alice, 10e6);
        assertEq(_sweep(alice), 1);
        _accrue(alice, 10e6);
        assertEq(_sweep(alice), 0, "second sweep in the same epoch does nothing");
        assertEq(park.valueOf(alice), 10e6, "second accrual waits, untouched");
        vm.warp(block.timestamp + 1 days);
        assertEq(_sweep(alice), 1, "next epoch sweeps it");
    }

    /// The weekend: stale feeds DEFER (money stays parked), never convert to USDG.
    function test_staleFeedDefersNotSettles() public {
        _accrue(alice, 10e6);
        vm.warp(block.timestamp + 3 days); // well past heartbeat + grace
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        _sweep(alice);
        assertEq(IERC20(SPY).balanceOf(alice), 0);
        assertEq(IERC20(USDG).balanceOf(alice), usdgBefore, "nothing paid out as USDG");
        assertEq(park.valueOf(alice), 10e6, "all of it back in the park");
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "no fee on a deferred leg");
    }

    function test_netSweepSplitsProRata() public {
        _accrue(alice, 10e6);
        _accrue(bob, 30e6);
        address[] memory accts = new address[](2);
        accts[0] = alice;
        accts[1] = bob;
        assertEq(_sweepBatch(accts), 2);
        // One swap per asset, split 1:3.
        assertApproxEqRel(IERC20(SPY).balanceOf(bob), IERC20(SPY).balanceOf(alice) * 3, 0.0001e18);
        assertApproxEqRel(IERC20(NVDA).balanceOf(bob), IERC20(NVDA).balanceOf(alice) * 3, 0.0001e18);
        assertEq(IERC20(SPY).balanceOf(address(exec)), 0, "no SPY left behind");
        assertEq(IERC20(NVDA).balanceOf(address(exec)), 0, "no NVDA left behind");
    }

    function test_unlinkStopsAccrualImmediately() public {
        vm.prank(alice);
        rules.unlink(alice);
        uint256 to_ = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.NotLinked.selector, alice));
        exec.accrue(alice, alice, 1e6, to_);
    }

    function test_cursorCannotReachBeforeLink() public {
        uint256 linked = rules.linkedAt(alice);
        _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, linked, linked));
        exec.accrue(alice, alice, 1e6, linked);
    }

    function test_rangeCannotBeAccruedTwice() public {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        exec.accrue(alice, alice, 1e6, to);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, to, to));
        exec.accrue(alice, alice, 1e6, to);
    }

    function test_unfinalisedRangeRejected() public {
        vm.prank(keeper);
        vm.expectRevert();
        exec.accrue(alice, alice, 1e6, block.number);
    }

    /// A keeper cannot pull more than the user's own Permit2 allowance, even under the cap.
    function test_permit2AllowanceBoundsKeeper() public {
        vm.prank(alice);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), uint160(2e6), uint48(block.timestamp + 1 days));
        uint256 to_ = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert();
        exec.accrue(alice, alice, 3e6, to_);
    }

    function test_onlyKeeperAccrues() public {
        uint256 to_ = _pastFinality();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("NotKeeper()"))));
        exec.accrue(alice, alice, 1e6, to_);
    }

    /// Exit is never gated — not even by pause.
    function test_exitWorksWhilePaused() public {
        _accrue(alice, 10e6);
        vm.startPrank(owner);
        exec.pause();
        park.pause();
        vm.stopPrank();
        uint256 before = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        park.exit();
        assertEq(IERC20(USDG).balanceOf(alice) - before, 10e6);
    }

    function test_pausedBlocksNewActivity() public {
        _accrue(alice, 10e6);
        vm.prank(owner);
        exec.pause();
        SweepExecutor.Limit[] memory l = _limits();
        address[] memory accts = new address[](1);
        accts[0] = alice;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("IsPaused()"))));
        exec.sweep(accts, l);
    }

    /// Only the keeper sweeps: nobody else can trigger the netted buy (and so
    /// nobody can wrap it in an atomic sandwich).
    function test_onlyKeeperSweeps() public {
        _accrue(alice, 10e6);
        SweepExecutor.Limit[] memory l = _limits();
        address[] memory accts = new address[](1);
        accts[0] = alice;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("NotKeeper()"))));
        exec.sweep(accts, l);
        assertEq(park.valueOf(alice), 10e6);
    }

    function test_screeningGatesBuying() public {
        vm.prank(owner);
        screening.setEnforced(true);
        _accrue(alice, 10e6);
        assertEq(_sweep(alice), 0, "uncleared account is not swept");
        assertEq(park.valueOf(alice), 10e6, "and keeps its spare");
        vm.prank(owner); // owner is the attestor in setUp
        screening.clear(alice, uint64(block.timestamp + 365 days));
        assertEq(_sweep(alice), 1);
    }

    function test_belowThresholdNotSwept() public {
        _accrue(alice, 4_990_000);
        assertEq(_sweep(alice), 0);
    }
}
