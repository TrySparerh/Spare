// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {RuleRegistry} from "../../src/RuleRegistry.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {ScreeningGate} from "../../src/ScreeningGate.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {CashPark} from "../../src/CashPark.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {UsdgParkAdapter} from "../../src/park/UsdgParkAdapter.sol";
import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {IStockToken} from "../../src/interfaces/IExternal.sol";
import {MockArbSys} from "../mocks/MockArbSys.sol";
import {RawSwapper} from "./AuditBase.sol";

/// @notice Attacker: pushes an allowlisted v4 pool, calls `sweep`, then unwinds —
///         all in one transaction (`run`, dead now that sweep is keeper-only), or
///         as separate transactions around the keeper's sweep (`front` / `back`).
contract Sandwicher is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager immutable pm;
    SweepExecutor immutable exec;
    address immutable usdg;

    struct D {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    constructor(IPoolManager pm_, SweepExecutor exec_, address usdg_) {
        pm = pm_;
        exec = exec_;
        usdg = usdg_;
    }

    function run(PoolKey calldata key, uint256 usdgIn, address[] calldata victims) external returns (int256 pnl) {
        uint256 start = IERC20(usdg).balanceOf(address(this));
        bool usdgIs0 = Currency.unwrap(key.currency0) == usdg;
        address tok = usdgIs0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        // 1) push the pool: buy the stock with USDG
        pm.unlock(abi.encode(D(key, usdgIs0, usdgIn)));
        // 2) the victims' sweep executes against the pushed price
        exec.sweep(victims, new SweepExecutor.Limit[](0));
        // 3) unwind: sell everything back
        uint256 bal = IERC20(tok).balanceOf(address(this));
        pm.unlock(abi.encode(D(key, !usdgIs0, bal)));
        pnl = int256(IERC20(usdg).balanceOf(address(this))) - int256(start);
    }

    /// Push the pool (its own transaction, landing before the keeper's sweep).
    function front(PoolKey calldata key, uint256 usdgIn) external {
        pm.unlock(abi.encode(D(key, Currency.unwrap(key.currency0) == usdg, usdgIn)));
    }

    /// Unwind everything bought in `front`; returns the USDG now held.
    function back(PoolKey calldata key) external returns (uint256) {
        bool usdgIs0 = Currency.unwrap(key.currency0) == usdg;
        address tok = usdgIs0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        uint256 bal = IERC20(tok).balanceOf(address(this));
        if (bal != 0) pm.unlock(abi.encode(D(key, !usdgIs0, bal)));
        return IERC20(usdg).balanceOf(address(this));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        D memory d = abi.decode(data, (D));
        BalanceDelta delta = pm.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency cin, Currency cout) =
            d.zeroForOne ? (d.key.currency0, d.key.currency1) : (d.key.currency1, d.key.currency0);
        int128 din = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 dout = d.zeroForOne ? delta.amount1() : delta.amount0();
        uint256 paid = uint256(uint128(-din));
        uint256 got = uint256(uint128(dout));
        pm.sync(cin);
        IERC20(Currency.unwrap(cin)).transfer(address(pm), paid);
        pm.settle();
        pm.take(cout, address(this), got);
        return "";
    }
}

/// @notice FUNDS + ACCESS-CONTROL audit findings, now REGRESSIONS against the fixed
///         contracts (F1, F2, F3, F4, F6 asserted BLOCKED; F5, F7, F8 are open /
///         trust-model findings kept as live repros). Run against a RECENT RHC
///         mainnet fork. The public RPC is not an archive node, so pin a block that
///         is a few blocks behind the head:
///           export AUDIT_FORK_BLOCK=$(( $(cast block-number --rpc-url $RHC_RPC_URL) - 20 ))
///         US-equity feeds must be inside heartbeat+grace at that block (weekdays).
contract AuditFundsTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA_HOOK = 0xA0D185c901E4abD21f94D4E3ba8FAbc3E29E80c4;
    address constant SGOV_HOOK = 0xc52fc52698479E42F0dA9a8a75296EC3871454c0;
    /// Storage slot the stock-token implementation's `paused()` reads (found with
    /// vm.accesses in ProbeSgovPause.t.sol; setting it makes transfers revert).
    bytes32 constant STOCK_PAUSED_SLOT = 0x8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc01;
    /// The keeper's tolerance below its own same-block quote.
    uint256 constant QUOTE_TOL_BPS = 30;

    event ExitUnitsKept(address indexed account, uint256 units);

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

    PoolKey nvdaKey;
    PoolKey spyKey;
    RawSwapper quoter;

    function setUp() public {
        uint256 blk = vm.envOr("AUDIT_FORK_BLOCK", uint256(0));
        if (blk == 0) {
            vm.skip(true); // opt-in: needs a recent block (public RPC is not archive)
            return;
        }
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), blk);
        vm.etch(address(0x64), address(new MockArbSys()).code);
        quoter = new RawSwapper(IPoolManager(POOL_MANAGER));

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
        spyKey = _key(SPY, USDG, 3000, 60, address(0));
        nvdaKey = _key(USDG, NVDA, 0, 1, NVDA_HOOK);
        registry.setAsset(SPY, SPY_FEED, 86_400, 150, spyKey);
        registry.setAsset(NVDA, NVDA_FEED, 86_400, 150, nvdaKey);
        registry.setAsset(SGOV, SGOV_FEED, 86_400, 150, _key(USDG, SGOV, 0, 200, SGOV_HOOK));
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

        _onboard(alice, 50e6, 1_000e6);
        _onboard(bob, 50e6, 1_000e6);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _key(address c0, address c1, uint24 fee, int24 ts, address hooks) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(hooks));
    }

    function _onboard(address user, uint64 weeklyCap, uint160 allowance) internal {
        deal(USDG, user, 1_000e6);
        vm.startPrank(user);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), allowance, uint48(block.timestamp + 365 days));
        rules.linkSelf();
        rules.setRule(1, 1, weeklyCap, true);
        vm.stopPrank();
    }

    function _pastFinality(SweepExecutor e) internal returns (uint256 toBlock) {
        uint256 buf = e.finalityBuffer();
        vm.roll(block.number + buf + 10);
        toBlock = block.number - buf - 1;
    }

    function _accrue(address user, uint256 amount) internal {
        uint256 to = _pastFinality(exec);
        vm.prank(keeper);
        exec.accrue(user, user, amount, to);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _requireFresh(address asset) internal view {
        (OracleGuard.Status s,) = router.oracleStatus(asset);
        require(s == OracleGuard.Status.OK, "feed not fresh at AUDIT_FORK_BLOCK - rerun on a weekday");
    }

    /// 20 victims, $50 each, 100% NVDA -> one $1,000 netted NVDA leg.
    function _nvdaVictims(uint256 n) internal returns (address[] memory v) {
        v = new address[](n);
        ElectionRegistry.Leg[] memory m = new ElectionRegistry.Leg[](1);
        m[0] = ElectionRegistry.Leg(NVDA, 10_000);
        for (uint256 i; i < n; ++i) {
            v[i] = makeAddr(string.concat("victim", vm.toString(i)));
            _onboard(v[i], 50e6, 1_000e6);
            vm.prank(v[i]);
            elections.setMix(m);
        }
        uint256 to = _pastFinality(exec);
        vm.startPrank(keeper);
        for (uint256 i; i < n; ++i) exec.accrue(v[i], v[i], 50e6, to);
        vm.stopPrank();
    }

    function _sumBal(address token, address[] memory who) internal view returns (uint256 s) {
        for (uint256 i; i < who.length; ++i) s += IERC20(token).balanceOf(who[i]);
    }

    function _oracleLimits() internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        l = new SweepExecutor.Limit[](toks.length);
        for (uint256 i; i < toks.length; ++i) {
            (OracleGuard.Status s, uint256 p) = router.oracleStatus(toks[i]);
            uint256 m = s == OracleGuard.Status.OK ? (router.oracleTokensFor(1e6, p) * 9_850) / 10_000 : 1;
            l[i] = SweepExecutor.Limit(toks[i], m);
        }
    }

    /// The keeper's same-block quote for `usdgIn` USDG -> NVDA, less QUOTE_TOL_BPS.
    function _nvdaQuoteLimit(uint256 usdgIn) internal returns (SweepExecutor.Limit[] memory l) {
        uint256 s = vm.snapshotState();
        deal(USDG, address(quoter), usdgIn);
        uint256 out = quoter.swapExactIn(nvdaKey, true, usdgIn); // USDG is currency0
        vm.revertToState(s);
        l = new SweepExecutor.Limit[](1);
        l[0] = SweepExecutor.Limit(NVDA, (((out * 1e6) / usdgIn) * (10_000 - QUOTE_TOL_BPS)) / 10_000);
    }

    function _keeperSweep(address[] memory a, SweepExecutor.Limit[] memory l) internal returns (uint256) {
        vm.prank(keeper);
        return exec.sweep(a, l);
    }

    function _keeperSweep(address[] memory a) internal returns (uint256) {
        return _keeperSweep(a, _oracleLimits());
    }

    // ═════════════════════════════════════════════════════════════════════
    // F1 (FIXED)  The permissionless sweep was atomically sandwichable. Now the
    //     atomic attack reverts NotKeeper, and a push landed before the keeper's
    //     sweep either stays within the keeper's quote tolerance or defers the leg.
    // ═════════════════════════════════════════════════════════════════════

    function test_F1_sandwichBlocked_keeperQuoteBoundsTheFill() public {
        _requireFresh(NVDA);
        address[] memory v = _nvdaVictims(20);
        Sandwicher atk = new Sandwicher(IPoolManager(POOL_MANAGER), exec, USDG);

        // (a) Atomic: the attacker cannot trigger the victims' trade.
        deal(USDG, address(atk), 1_000e6);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        atk.run(nvdaKey, 1_000e6, v);

        // (b) Separate transactions around the keeper's quote-limited sweep.
        uint256 swapIn = 1_000e6 - (1_000e6 * 25) / 10_000;
        SweepExecutor.Limit[] memory l = _nvdaQuoteLimit(swapIn);
        uint256 floor = (swapIn * l[0].minOutPerUsdg) / 1e6;
        uint256 usdgBefore = _sumBal(USDG, v);
        uint256 snap = vm.snapshotState();
        _keeperSweep(v, l);
        uint256 baseline = _sumBal(NVDA, v);
        assertGe(baseline, floor, "honest keeper sweep converts");

        uint256[7] memory xs = [uint256(250e6), 500e6, 1_000e6, 2_000e6, 4_000e6, 8_000e6, 16_000e6];
        bool deferred;
        for (uint256 i; i < xs.length; ++i) {
            vm.revertToState(snap);
            deal(USDG, address(atk), xs[i]);
            atk.front(nvdaKey, xs[i]);
            _keeperSweep(v, l);
            int256 pnl = int256(atk.back(nvdaKey)) - int256(xs[i]);
            uint256 got = _sumBal(NVDA, v);
            console2.log("push USDG", xs[i] / 1e6);
            console2.logInt(pnl);
            console2.log("  victims NVDA", got, got == 0 ? "(DEFERRED - USDG back in the park)" : "");
            if (got == 0) {
                deferred = true;
                assertEq(_sumBal(USDG, v), usdgBefore, "nothing paid out as USDG");
                assertEq(park.pending(v[0]), 50e6, "whole leg back in the park");
            } else {
                assertGe(got, floor, "never below the keeper's quote limit");
            }
        }
        assertTrue(deferred, "a large enough push makes the leg defer");
    }

    // ═════════════════════════════════════════════════════════════════════
    // F2 (FIXED)  A pool push used to force every leg of an asset to SAFE-SETTLE
    //     (a USDG payout) and burn the epoch. Now the leg DEFERS: nothing is paid
    //     out, and the next epoch converts it.
    // ═════════════════════════════════════════════════════════════════════

    function test_F2_poolPushDefers_retriedNextEpoch() public {
        _requireFresh(NVDA);
        // Short epochs so the retry runs while the feeds are still fresh.
        uint256 fb = exec.finalityBuffer();
        uint256 th = exec.threshold();
        uint16 fee = exec.feeBps();
        uint16 slip = exec.slippageBps();
        vm.prank(owner);
        exec.setParams(fb, th, fee, slip, 1 hours);

        address[] memory v = _nvdaVictims(20);
        Sandwicher atk = new Sandwicher(IPoolManager(POOL_MANAGER), exec, USDG);
        uint256 usdgBefore = _sumBal(USDG, v);
        uint256 swapIn = 1_000e6 - (1_000e6 * 25) / 10_000;
        SweepExecutor.Limit[] memory l = _nvdaQuoteLimit(swapIn);

        uint256 x = 16_000e6;
        deal(USDG, address(atk), x);
        atk.front(nvdaKey, x);
        _keeperSweep(v, l);
        int256 pnl = int256(atk.back(nvdaKey)) - int256(x);

        assertEq(_sumBal(NVDA, v), 0, "no victim bought at the pushed price");
        assertEq(_sumBal(USDG, v), usdgBefore, "nothing paid out as USDG");
        assertEq(park.valueOf(v[0]), 50e6, "all of it back in the park");
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "no fee");
        console2.log("attacker cost of the push (USDG 1e6, signed):");
        console2.logInt(pnl);

        // Next epoch, the pool unwound: a fresh quote, and the deferred USDG converts.
        vm.warp(block.timestamp + 1 hours);
        _keeperSweep(v, _nvdaQuoteLimit(swapIn));
        assertGt(_sumBal(NVDA, v), 0, "retried and bought");
        assertEq(park.valueOf(v[0]), 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F3 (FIXED)  A third-party hook owner pausing the allowlisted pool used to
    //     SAFE-SETTLE the leg to USDG; it now DEFERS.
    // ═════════════════════════════════════════════════════════════════════

    function test_F3_hookOwnerPause_defersNotSafeSettles() public {
        _requireFresh(SPY);
        _requireFresh(NVDA);
        _accrue(alice, 10e6);

        (bool ok, bytes memory ret) = NVDA_HOOK.staticcall(abi.encodeWithSignature("owner()"));
        require(ok, "owner()");
        address hookOwner = abi.decode(ret, (address));
        console2.log("NVDA pool hook owner (third party):", hookOwner);
        vm.prank(hookOwner);
        (ok,) = NVDA_HOOK.call(abi.encodeWithSelector(bytes4(0x16c38b3c), true)); // setPaused(bool)
        assertTrue(ok, "hook owner can pause the pool");

        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        _keeperSweep(_one(alice));
        assertEq(IERC20(NVDA).balanceOf(alice), 0, "no NVDA");
        assertEq(IERC20(USDG).balanceOf(alice), usdgBefore, "NVDA leg NOT paid out as USDG");
        assertEq(park.pending(alice), 4e6, "NVDA leg deferred back to the park for retry");
        assertGt(IERC20(SPY).balanceOf(alice), 0, "the SPY leg still converts");
    }

    // ═════════════════════════════════════════════════════════════════════
    // F4 (FIXED)  exit() was all-or-nothing: a paused SGOV trapped the PENDING
    //     USDG too. Pending now always comes out; stuck units stay booked.
    // ═════════════════════════════════════════════════════════════════════

    function _useSgovAdapter() internal returns (SgovParkAdapter a) {
        vm.startPrank(owner);
        a = new SgovParkAdapter(USDG, SGOV, address(park), router, 100);
        router.setCaller(address(a), true);
        park.setAdapter(a);
        vm.stopPrank();
    }

    function test_F4_exitWithSgovPaused_stillPaysPendingUsdg() public {
        _requireFresh(SGOV);
        _useSgovAdapter();
        _accrue(alice, 20e6);
        vm.prank(keeper);
        park.park(_one(alice));
        _accrue(alice, 7e6); // lands in pending (plain USDG held by CashPark)
        uint256 units = park.units(alice);
        assertGt(units, 0);
        assertEq(park.pending(alice), 7e6);

        // The real stock-token implementation: paused -> transfers revert.
        bytes32 prev = vm.load(SGOV, STOCK_PAUSED_SLOT);
        vm.store(SGOV, STOCK_PAUSED_SLOT, bytes32(uint256(1)));
        assertTrue(IStockToken(SGOV).paused());

        // redeem -> router.sell -> OracleGuard PAUSED -> revert (caught);
        // exitInKind -> SGOV.transfer -> revert (caught): units kept, pending paid.
        uint256 before = IERC20(USDG).balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(park));
        emit ExitUnitsKept(alice, units);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = park.exit();
        assertEq(out, 7e6, "the plain USDG comes out");
        assertEq(inKind, 0);
        assertEq(IERC20(USDG).balanceOf(alice) - before, 7e6);
        assertEq(park.pending(alice), 0);
        assertEq(park.units(alice), units, "SGOV units stay booked to alice");

        // SGOV unpaused: a second exit collects the units.
        vm.store(SGOV, STOCK_PAUSED_SLOT, prev);
        vm.prank(alice);
        (out, inKind) = park.exit();
        assertEq(park.units(alice), 0);
        assertEq(park.totalUnits(), 0);
        assertTrue(out > 0 || IERC20(SGOV).balanceOf(alice) == units, "redeemed or handed over in kind");
    }

    // ═════════════════════════════════════════════════════════════════════
    // F5 (OPEN — not addressed by the fixes)  setAdapter can be blocked
    //     indefinitely by one small holder
    // ═════════════════════════════════════════════════════════════════════

    function test_F5_setAdapterBlockedBySubThresholdHolder() public {
        _requireFresh(SGOV);
        _useSgovAdapter();
        _accrue(bob, 4e6); // below the $5 sweep threshold
        vm.prank(keeper);
        park.park(_one(bob));
        assertGt(park.units(bob), 0);

        // Sweep cannot clear bob (below threshold); nothing else can move his units.
        assertEq(_keeperSweep(_one(bob)), 0);
        UsdgParkAdapter fallbackAdapter = new UsdgParkAdapter(USDG, address(park));
        vm.prank(owner);
        vm.expectRevert(CashPark.AdapterInUse.selector);
        park.setAdapter(fallbackAdapter);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F6 (FIXED)  The weekly cap was a calendar week, not a rolling 7 days: 2x cap
    //     in 2 s. The second pull across the boundary is now refused.
    // ═════════════════════════════════════════════════════════════════════

    function test_F6_weeklyCapDoesNotDoubleAcrossWeekBoundary() public {
        uint256 boundary = (vm.getBlockTimestamp() / 1 weeks + 1) * 1 weeks;
        vm.warp(boundary - 1);
        uint256 to1 = _pastFinality(exec);
        vm.prank(keeper);
        exec.accrue(alice, alice, 50e6, to1);

        vm.warp(boundary + 1);
        uint256 to2 = _pastFinality(exec);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 100e6, 50e6));
        exec.accrue(alice, alice, 50e6, to2);

        assertEq(park.valueOf(alice), 50e6, "one $50 weekly cap across the boundary");
    }

    // ═════════════════════════════════════════════════════════════════════
    // F7 (OPEN — not addressed by the fixes)  Executor migration: cursors and
    //     the rolling-cap counters do not carry over
    // ═════════════════════════════════════════════════════════════════════

    function test_F7_executorMigration_sameRangeAccruedTwice() public {
        uint256 to = _pastFinality(exec);
        vm.prank(keeper);
        exec.accrue(alice, alice, 10e6, to);

        vm.startPrank(owner);
        SweepExecutor exec2 = new SweepExecutor(
            owner, IAllowanceTransfer(PERMIT2), rules, elections, screening, router, park, vault
        );
        exec2.setKeeper(keeper, true);
        router.setCaller(address(exec2), true);
        park.setExecutor(address(exec2));
        vm.stopPrank();
        vm.prank(alice); // user re-approves to keep using the product
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec2), 1_000e6, uint48(block.timestamp + 365 days));

        vm.prank(keeper);
        exec2.accrue(alice, alice, 10e6, to); // the exact same (linkedAt, to] range
        assertEq(park.valueOf(alice), 20e6, "same payment range pulled twice");
    }

    // ═════════════════════════════════════════════════════════════════════
    // F8 (OPEN — owner trust model, not addressed by the fixes)  CashPark owner
    //     key == custody of every parked dollar (no delay)
    // ═════════════════════════════════════════════════════════════════════

    function test_F8_ownerSetExecutorDrainsParkedFunds() public {
        _accrue(alice, 30e6);
        _accrue(bob, 30e6);
        address thief = makeAddr("thief");
        vm.prank(owner);
        park.setExecutor(thief);
        vm.startPrank(thief);
        park.withdrawForSweep(alice);
        park.withdrawForSweep(bob);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(thief), 60e6, "all parked USDG taken in one block");
    }
}
