// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// AUDIT findings — lens: math, units, oracles. Now REGRESSIONS against the fixed
// contracts (F1, F2, F4, F5, F6 asserted BLOCKED); F3 and F7 are still-open
// behaviours kept as live repros (see each comment).
// Run: AUDIT_FORK_BLOCK=$(( $(cast block-number --rpc-url $RHC_RPC_URL) - 20 )) \
//      forge test --mc MathOracleAudit -vv

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
import {RoundUp} from "../../src/libraries/RoundUp.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockArbSys} from "../mocks/MockArbSys.sol";

/// @dev Minimal exact-input v4 swapper with NO guards — what any third party can deploy.
contract AuditSwapper is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    struct S {
        PoolKey key;
        address tin;
        address tout;
        uint256 amt;
    }

    function swap(PoolKey memory key, address tin, address tout, uint256 amt) public returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(S(key, tin, tout, amt))), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        S memory s = abi.decode(data, (S));
        bool z = Currency.unwrap(s.key.currency0) == s.tin;
        BalanceDelta d = pm.swap(
            s.key,
            SwapParams({
                zeroForOne: z,
                amountSpecified: -int256(s.amt),
                sqrtPriceLimitX96: z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 i = z ? d.amount0() : d.amount1();
        int128 o = z ? d.amount1() : d.amount0();
        pm.sync(Currency.wrap(s.tin));
        IERC20(s.tin).transfer(address(pm), uint256(uint128(-i)));
        pm.settle();
        pm.take(Currency.wrap(s.tout), address(this), uint256(uint128(o)));
        return abi.encode(uint256(uint128(o)));
    }

    /// Atomic: push the pool, trigger the sweep, unwind. Dead now: sweep is keeper-only.
    function sandwich(PoolKey memory key, address usdg, address stock, uint256 push, SweepExecutor exec, address[] memory accts)
        external
        returns (uint256 stockBought, uint256 usdgBack)
    {
        stockBought = swap(key, usdg, stock, push);
        exec.sweep(accts, new SweepExecutor.Limit[](0));
        usdgBack = swap(key, stock, usdg, stockBought);
    }
}

/// @dev Chainlink L2 sequencer-uptime feed stand-in.
contract MockSeqFeed {
    int256 public answer;
    uint256 public startedAt;

    function set(int256 a, uint256 s) external {
        answer = a;
        startedAt = s;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }
}

contract MathOracleAuditTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// The keeper's tolerance below its own same-block quote.
    uint256 constant QUOTE_TOL_BPS = 30;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");

    AssetRegistry registry;
    RuleRegistry rules;
    ElectionRegistry elections;
    ScreeningGate screening;
    StockRouter router;
    CashPark park;
    FeeVault vault;
    SweepExecutor exec;
    PoolKey nvdaKey;

    function setUp() public {
        // The public RPC only serves RECENT state: opt in with AUDIT_FORK_BLOCK.
        uint256 blk = vm.envOr("AUDIT_FORK_BLOCK", uint256(0));
        if (blk == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), blk);
        vm.etch(address(0x64), address(new MockArbSys()).code);

        vm.startPrank(owner);
        registry = new AssetRegistry(owner, USDG);
        rules = new RuleRegistry();
        elections = new ElectionRegistry(owner, registry);
        screening = new ScreeningGate(owner, owner, false);
        router = new StockRouter(owner, IPoolManager(POOL_MANAGER), registry);
        park = new CashPark(owner, IERC20(USDG));
        vault = new FeeVault(owner);
        exec = new SweepExecutor(owner, IAllowanceTransfer(PERMIT2), rules, elections, screening, router, park, vault);

        nvdaKey = PoolKey(
            Currency.wrap(USDG), Currency.wrap(NVDA), 0, 1, IHooks(0xA0D185c901E4abD21f94D4E3ba8FAbc3E29E80c4)
        );
        registry.setAsset(
            SPY,
            SPY_FEED,
            86_400,
            150,
            PoolKey(Currency.wrap(SPY), Currency.wrap(USDG), 3000, 60, IHooks(address(0)))
        );
        registry.setAsset(NVDA, NVDA_FEED, 86_400, 150, nvdaKey); // 1.5% band, as the spec defaults
        registry.setActive(SPY, true);
        registry.setActive(NVDA, true);
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
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _onboard(address user, uint64 weeklyCap, uint160 permitAllowance) internal {
        deal(USDG, user, 1_000e6);
        vm.startPrank(user);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), permitAllowance, uint48(block.timestamp + 30 days));
        rules.linkSelf();
        rules.setRule(1, 1, weeklyCap, true);
        vm.stopPrank();
    }

    function _pastFinality() internal returns (uint256 toBlock) {
        uint256 buf = exec.finalityBuffer();
        vm.roll(vm.getBlockNumber() + buf + 10);
        toBlock = vm.getBlockNumber() - buf - 1;
    }

    function _accrue(address user, uint256 amount) internal {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        exec.accrue(user, user, amount, to);
    }

    function _nvdaOnly(address user) internal {
        ElectionRegistry.Leg[] memory m = new ElectionRegistry.Leg[](1);
        m[0] = ElectionRegistry.Leg(NVDA, 10_000);
        vm.prank(user);
        elections.setMix(m);
    }

    function _victims(uint256 n, uint256 each) internal returns (address[] memory v) {
        v = new address[](n);
        for (uint256 i; i < n; ++i) {
            v[i] = makeAddr(string(abi.encodePacked("victim", vm.toString(i))));
            _onboard(v[i], uint64(each), uint160(each));
            _nvdaOnly(v[i]);
            _accrue(v[i], each);
        }
    }

    function _sumBal(address token, address[] memory who) internal view returns (uint256 s) {
        for (uint256 i; i < who.length; ++i) s += IERC20(token).balanceOf(who[i]);
    }

    /// Oracle-derived limits (1.5% tolerance = the executor's oracle backstop).
    function _oracleLimits() internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        l = new SweepExecutor.Limit[](toks.length);
        for (uint256 i; i < toks.length; ++i) {
            (OracleGuard.Status s, uint256 p) = router.oracleStatus(toks[i]);
            uint256 m = s == OracleGuard.Status.OK ? (router.oracleTokensFor(1e6, p) * 9_850) / 10_000 : 1;
            l[i] = SweepExecutor.Limit(toks[i], m);
        }
    }

    function _nvdaLimit(uint256 minOutPerUsdg) internal pure returns (SweepExecutor.Limit[] memory l) {
        l = new SweepExecutor.Limit[](1);
        l[0] = SweepExecutor.Limit(NVDA, minOutPerUsdg);
    }

    function _keeperSweep(address[] memory a, SweepExecutor.Limit[] memory l) internal returns (uint256) {
        vm.prank(keeper);
        return exec.sweep(a, l);
    }

    /// The keeper's same-block quote for the NVDA leg, less QUOTE_TOL_BPS, per 1 USDG.
    function _nvdaQuoteLimit(AuditSwapper atk, uint256 swapIn) internal returns (uint256) {
        uint256 q = _legFillAfterPush(atk, 0, swapIn);
        return (((q * 1e6) / swapIn) * (10_000 - QUOTE_TOL_BPS)) / 10_000;
    }

    /// @dev 0 when the pushed pool cannot take the push or the leg at all (pushed
    ///      past its last liquidity: v4 PriceLimitAlreadyExceeded) — "below any bound".
    function _legFillAfterPush(AuditSwapper atk, uint256 push, uint256 swapIn) internal returns (uint256 fill) {
        uint256 s = vm.snapshotState();
        deal(USDG, address(atk), push + swapIn);
        bool pushed = true;
        if (push != 0) {
            try atk.swap(nvdaKey, USDG, NVDA, push) {}
            catch {
                pushed = false;
            }
        }
        if (pushed) {
            try atk.swap(nvdaKey, USDG, NVDA, swapIn) returns (uint256 o) {
                fill = o;
            } catch {}
        }
        vm.revertToState(s);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F1 (FIXED). The weekly cap was a FIXED epoch-aligned bucket (weeks start
    //     Thursday 00:00 UTC), so 2x the cap could be pulled within two seconds.
    //     It is now a rolling window of 7 UTC days.
    // ═════════════════════════════════════════════════════════════════════
    function test_F1_weeklyCapCannotDoubleAcrossBucketBoundary() public {
        _onboard(alice, 50e6, 100e6); // cap $50/wk, Permit2 allowance $100
        uint256 boundary = (vm.getBlockTimestamp() / 1 weeks + 1) * 1 weeks;
        assertEq((boundary / 1 days + 4) % 7, 4, "old bucket started on a Thursday");

        vm.warp(boundary - 1);
        _accrue(alice, 50e6);
        vm.warp(boundary + 1);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 100e6, 50e6));
        exec.accrue(alice, alice, 50e6, to);
        assertEq(park.valueOf(alice), 50e6, "one cap, not two, across the old bucket boundary");
    }

    // ═════════════════════════════════════════════════════════════════════
    // F2 (FIXED). Turning the rule OFF froze the cursor, so once back ON the
    //     keeper could accrue round-ups for payments made while it was OFF. The
    //     cursor floor now includes rules.activeSince (the re-enable block).
    // ═════════════════════════════════════════════════════════════════════
    function test_F2_disabledWindowCannotBeAccruedAfterReenable() public {
        _onboard(alice, 50e6, 50e6);
        _accrue(alice, 1e6);
        uint256 cursorBefore = exec.lastAccruedBlock(alice);

        vm.roll(vm.getBlockNumber() + 100);
        vm.prank(alice);
        rules.setRule(1, 1, 50e6, false); // user switches round-ups OFF
        uint256 offAt = vm.getBlockNumber();

        vm.roll(vm.getBlockNumber() + 50_000); // ~83 min of payments while OFF
        vm.prank(alice);
        rules.setRule(1, 1, 50e6, true); // back ON
        uint256 onAt = vm.getBlockNumber();
        assertEq(rules.activeSince(alice), onAt);

        uint256 to = _pastFinality();
        // A range that ends inside the OFF window is refused ...
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, onAt, offAt + 1));
        exec.accrue(alice, alice, 20e6, offAt + 1);
        // ... and a range (cursorBefore, to] is only accrued from the re-enable block.
        vm.expectEmit(true, true, false, true, address(exec));
        emit SweepExecutor.Accrued(alice, alice, 20e6, onAt, to);
        vm.prank(keeper);
        exec.accrue(alice, alice, 20e6, to);
        assertLt(cursorBefore, offAt);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F3 (OPEN — informational, unchanged). RoundUp.delta does not round to
    //     cents; spare.ts roundUpDelta does (Math.round(.. * 100) / 100). Values
    //     below are the on-chain side; the spare.ts side (roundup_diff.ts, same
    //     inputs): 250000, 750000, 0, 0, 1000000.
    // ═════════════════════════════════════════════════════════════════════
    function test_F3_roundUpSubCentDivergesFromFrontend() public pure {
        assertEq(RoundUp.delta(3_751_234, 1, 1), 248_766); // spare.ts -> $0.25   = 250_000
        assertEq(RoundUp.delta(3_751_234, 1, 3), 746_298); // spare.ts -> $0.75   = 750_000
        assertEq(RoundUp.delta(4_999_999, 1, 1), 1); //       spare.ts -> $0.00   = 0
        assertEq(RoundUp.delta(4_999_999, 5, 5), 5); //       spare.ts -> $0.00   = 0
        assertEq(RoundUp.delta(5_000_001, 1, 1), 999_999); // spare.ts -> $1.00   = 1_000_000
        assertEq(RoundUp.delta(3_745_000, 1, 1), 255_000); // spare.ts -> $0.25 (float half-up fails)
    }

    // ═════════════════════════════════════════════════════════════════════
    // F4 (FIXED). Permissionless sweep + oracle-derived minOut let anyone
    //     atomically push the pool, call sweep() and unwind, extracting up to
    //     ~slippageBps of every swept dollar. Now (a) the atomic version reverts
    //     NotKeeper, and (b) the push that used to be "best" (largest push still
    //     clearing the oracle minOut) lands below the keeper's quote limit, so the
    //     leg defers and the victims keep every dollar.
    // ═════════════════════════════════════════════════════════════════════
    function test_F4_sandwichBlocked_pushedFillDefers() public {
        uint256 nV = 5;
        address[] memory v = _victims(nV, 50e6); // 5 accounts x $50 -> 100% NVDA
        AuditSwapper atk = new AuditSwapper(IPoolManager(POOL_MANAGER));
        (, uint256 px) = router.oracleStatus(NVDA);
        uint256 total = nV * 50e6;
        uint256 swapIn = total - (total * 25) / 10_000;
        uint256 backstop = (router.oracleTokensFor(swapIn, px) * (10_000 - exec.slippageBps())) / 10_000;
        uint256 limit = _nvdaQuoteLimit(atk, swapIn);

        // (a) The atomic sandwich cannot trigger the sweep.
        deal(USDG, address(atk), 1_000e6);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        atk.sandwich(nvdaKey, USDG, NVDA, 1_000e6, exec, v);

        // (b) The old best push: the largest that still clears the oracle backstop.
        uint256 lo = 0;
        uint256 hi = 1_000e6;
        while (_legFillAfterPush(atk, hi, swapIn) >= backstop) hi *= 2;
        for (uint256 it; it < 14; ++it) {
            uint256 mid = (lo + hi) / 2;
            if (_legFillAfterPush(atk, mid, swapIn) >= (backstop * 10_005) / 10_000) lo = mid;
            else hi = mid;
        }
        uint256 best = lo;
        assertGt(best, 0, "found a push that clears the oracle backstop");
        assertLt(_legFillAfterPush(atk, best, swapIn), (swapIn * limit) / 1e6, "...but not the keeper's quote");

        // Front-run, keeper sweep, back-run as separate transactions.
        uint256[] memory usdgBefore = new uint256[](nV);
        for (uint256 i; i < nV; ++i) usdgBefore[i] = IERC20(USDG).balanceOf(v[i]);
        deal(USDG, address(atk), best);
        uint256 bought = atk.swap(nvdaKey, USDG, NVDA, best);
        _keeperSweep(v, _nvdaLimit(limit));
        uint256 back = atk.swap(nvdaKey, NVDA, USDG, bought);

        assertEq(_sumBal(NVDA, v), 0, "not filled at the pushed price");
        for (uint256 i; i < nV; ++i) {
            assertEq(IERC20(USDG).balanceOf(v[i]), usdgBefore[i], "nothing paid out as USDG");
            assertEq(park.pending(v[i]), 50e6, "deferred whole, retried next epoch");
        }
        assertLe(back, best, "the attacker's round trip earns nothing");
        console2.log("push (USDG units)        :", best);
        console2.log("attacker USDG back       :", back);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F5 (FIXED). The executor's minOut (oracle - 1%) was tighter than the
    //     router's band (1.5%), so the band never bound, and a fill 1.0-1.5% off
    //     oracle safe-settled the whole leg to USDG — a push could force that on
    //     every sweep. Now slippageBps == bandBps, a fill inside the band converts
    //     under oracle-only limits, and against the keeper's quote limit the same
    //     push makes the leg DEFER rather than pay out USDG.
    // ═════════════════════════════════════════════════════════════════════
    function test_F5_fillInsideBandConvertsOrDefers_neverSafeSettles() public {
        address[] memory v = _victims(4, 50e6);
        AuditSwapper atk = new AuditSwapper(IPoolManager(POOL_MANAGER));
        assertEq(exec.slippageBps(), registry.get(NVDA).bandBps, "executor backstop == asset band");
        (, uint256 px) = router.oracleStatus(NVDA);
        uint256 total = 200e6;
        uint256 swapIn = total - (total * 25) / 10_000;
        uint256 ref = router.oracleTokensFor(swapIn, px);
        uint256 bandFloor = (ref * (10_000 - 150)) / 10_000;
        uint256 limit = _nvdaQuoteLimit(atk, swapIn);

        // Binary-search the push at which the leg's fill sits ~1.25% under oracle.
        uint256 target = (ref * (10_000 - 125)) / 10_000;
        uint256 lo = 0;
        uint256 hi = 1_000e6;
        while (_legFillAfterPush(atk, hi, swapIn) > target) hi *= 2;
        for (uint256 it; it < 14; ++it) {
            uint256 mid = (lo + hi) / 2;
            if (_legFillAfterPush(atk, mid, swapIn) > target) lo = mid;
            else hi = mid;
        }
        uint256 chosen = hi;
        uint256 fillAtChosen = _legFillAfterPush(atk, chosen, swapIn);
        assertGe(fillAtChosen, bandFloor, "fill is inside the asset's oracle band");
        assertLt(fillAtChosen, (swapIn * limit) / 1e6, "fill is below the keeper's quote limit");

        deal(USDG, address(atk), chosen);
        atk.swap(nvdaKey, USDG, NVDA, chosen);
        uint256[] memory usdgBefore = new uint256[](v.length);
        for (uint256 i; i < v.length; ++i) usdgBefore[i] = IERC20(USDG).balanceOf(v[i]);
        uint256 s = vm.snapshotState();

        // Oracle-only limits: the band (not a tighter executor bound) decides — it converts.
        _keeperSweep(v, _oracleLimits());
        assertGe(_sumBal(NVDA, v), bandFloor - v.length, "a fill inside the band converts");
        vm.revertToState(s);

        // With the keeper's quote limit the pushed fill is refused: the leg DEFERS.
        _keeperSweep(v, _nvdaLimit(limit));
        assertEq(_sumBal(NVDA, v), 0, "no NVDA bought at the pushed price");
        for (uint256 i; i < v.length; ++i) {
            assertEq(IERC20(USDG).balanceOf(v[i]), usdgBefore[i], "never paid out as USDG");
            assertEq(park.pending(v[i]), 50e6, "back in the park");
        }
        console2.log("fill deviation vs oracle (bps):", (ref - fillAtChosen) * 10_000 / ref);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F6 (FIXED). Sequencer guard (latent — sequencerFeed is address(0) today):
    //     (a) startedAt == 0 ("round not initialised") was read as "up" -> OK;
    //     (b) startedAt > block.timestamp underflowed inside the try's success
    //         block and reverted the whole sweep batch instead of deferring.
    //     Both are SEQUENCER_DOWN now.
    // ═════════════════════════════════════════════════════════════════════
    function test_F6a_sequencerStartedAtZeroIsDown() public {
        MockSeqFeed seq = new MockSeqFeed();
        vm.prank(owner);
        router.setSequencerFeed(address(seq));
        seq.set(0, 0);
        (OracleGuard.Status s,) = router.oracleStatus(SPY);
        assertEq(uint8(s), uint8(OracleGuard.Status.SEQUENCER_DOWN), "uninitialised sequencer round refused");
    }

    function test_F6b_sequencerFutureStartedAtDefersNotReverts() public {
        _onboard(alice, 50e6, 50e6);
        _accrue(alice, 10e6);
        MockSeqFeed seq = new MockSeqFeed();
        vm.prank(owner);
        router.setSequencerFeed(address(seq));
        seq.set(0, vm.getBlockTimestamp() + 5);
        (OracleGuard.Status s,) = router.oracleStatus(SPY);
        assertEq(uint8(s), uint8(OracleGuard.Status.SEQUENCER_DOWN));
        address[] memory a = new address[](1);
        a[0] = alice;
        uint256 before = IERC20(USDG).balanceOf(alice);
        assertEq(_keeperSweep(a, _oracleLimits()), 1, "the batch does not revert");
        assertEq(park.pending(alice), 10e6, "every leg deferred");
        assertEq(IERC20(USDG).balanceOf(alice), before);
    }

    // ═════════════════════════════════════════════════════════════════════
    // F7 (OPEN — not addressed by the fixes). A DEFERRED leg does not "stay
    //     parked": withdrawForSweep has already sold ALL the account's SGOV, and
    //     the deferred USDG comes back as un-parked pending. Every epoch the leg
    //     keeps deferring, the park position is sold and (after park()) re-bought.
    // ═════════════════════════════════════════════════════════════════════
    function test_F7_deferredLegUnparksSgov() public {
        address SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
        address SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
        vm.startPrank(owner);
        registry.setAsset(
            SGOV,
            SGOV_FEED,
            86_400,
            150,
            PoolKey(Currency.wrap(USDG), Currency.wrap(SGOV), 0, 200, IHooks(0xc52fc52698479E42F0dA9a8a75296EC3871454c0))
        );
        registry.setActive(SGOV, true);
        SgovParkAdapter sg = new SgovParkAdapter(USDG, SGOV, address(park), router, 100);
        router.setCaller(address(sg), true);
        park.setAdapter(sg);
        vm.stopPrank();

        _onboard(alice, 50e6, 50e6);
        _accrue(alice, 20e6);
        address[] memory a = new address[](1);
        a[0] = alice;
        vm.prank(keeper);
        park.park(a);
        uint256 unitsParked = park.units(alice);
        assertGt(unitsParked, 0);
        uint256 navBefore = park.valueOf(alice);

        // NVDA (40% leg) under a corporate action: oraclePaused -> DEFER.
        vm.mockCall(NVDA, abi.encodeWithSignature("oraclePaused()"), abi.encode(true));
        _keeperSweep(a, _oracleLimits());

        assertEq(park.units(alice), 0, "SGOV position fully sold");
        assertGt(park.pending(alice), 0, "deferred 40% now sits as un-parked USDG");
        console2.log("SGOV units before sweep     :", unitsParked);
        console2.log("value before (USDG units)   :", navBefore);
        console2.log("pending after (deferred leg):", park.pending(alice));
    }
}
