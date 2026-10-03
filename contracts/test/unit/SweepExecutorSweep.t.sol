// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {CashPark} from "../../src/CashPark.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {UsdgParkAdapter} from "../../src/park/UsdgParkAdapter.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockParkAdapter} from "../mocks/MockParkAdapter.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice SweepExecutor.sweep outcomes via MockRouter (SPARE-BUILD.md §3.4, §3.7):
///         keeper-only sweeps with per-asset keeper limits; swap / defer /
///         safe-settle per leg (a failed swap or bad oracle answer DEFERS, only a
///         delisted asset safe-settles), fee only on converted legs, netting with
///         exact pro-rata (dust to the last contributor), blocked recipients falling
///         back to claimable, and claim() (always to the account itself).
contract SweepExecutorSweepTest is UnitBase {
    event AccountSwept(address indexed account, uint256 epoch, uint256 usdg);
    event AssetSwept(address indexed asset, uint256 usdgIn, uint256 fee, uint256 tokensOut);
    event Delivered(address indexed account, address indexed token, uint256 amount);
    event DeliveryHeld(address indexed account, address indexed token, uint256 amount);
    event Deferred(address indexed account, address indexed asset, uint256 usdg, OracleGuard.Status status);
    event SafeSettled(address indexed account, address indexed asset, uint256 usdg, string reason);
    event Claimed(address indexed account, address indexed token, address to, uint256 amount);
    event SwapDeferred(address indexed asset, uint256 usdg, bytes reason);

    address[4] internal who;

    function setUp() public override {
        super.setUp();
        who = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            _onboard(who[i], 10_000e6, 1_000e6);
        }
    }

    function _fee(uint256 x) internal pure returns (uint256) {
        return (x * 25) / 10_000;
    }

    /// Whatever the executor still holds must be exactly what it owes as claimable.
    function _assertNoResidue() internal view {
        address[4] memory toks = [address(usdg), address(spy), address(nvda), address(qqq)];
        for (uint256 t; t < 4; ++t) {
            uint256 owed;
            for (uint256 i; i < 4; ++i) {
                owed += exec.claimable(who[i], toks[t]);
            }
            assertEq(IERC20(toks[t]).balanceOf(address(exec)), owed, "executor residue beyond claimables");
        }
    }

    function _setMix(address a, ElectionRegistry.Leg[] memory l) internal {
        vm.prank(a);
        elections.setMix(l);
    }

    // ── swap ─────────────────────────────────────────────────────────────

    /// Acceptance (2) at unit level: $10 -> 60/40 SPY/NVDA at the oracle, 0.25% fee.
    function test_swap_buysMixAtOracleAndChargesFee() public {
        _accrue(alice, 10e6);
        uint256 epoch = exec.currentEpoch();
        uint256 spyOut = _fair(6e6 - 15_000, SPY_PX);
        uint256 nvdaOut = _fair(4e6 - 10_000, NVDA_PX);

        vm.expectEmit(true, false, false, true, address(exec));
        emit AccountSwept(alice, epoch, 10e6);
        vm.expectEmit(true, false, false, true, address(exec));
        emit AssetSwept(address(spy), 6e6 - 15_000, 15_000, spyOut);
        assertEq(_sweep(_one(alice)), 1);

        assertEq(spy.balanceOf(alice), spyOut);
        assertEq(nvda.balanceOf(alice), nvdaOut);
        assertEq(usdg.balanceOf(address(vault)), 25_000, "0.25% of $10");
        assertEq(park.valueOf(alice), 0);
        assertEq(exec.sweptEpoch(alice), epoch);
        assertEq(mrouter.lastMinOut(address(spy)), (spyOut * 9_850) / 10_000, "minOut = oracle less 1.5%");
        _assertNoResidue();
    }

    function test_swap_fillAtExactlyMinOutIsAccepted() public {
        mrouter.setFillBps(address(spy), 9_850);
        _accrue(alice, 10e6);
        _sweep(_one(alice));
        assertEq(spy.balanceOf(alice), (_fair(6e6 - 15_000, SPY_PX) * 9_850) / 10_000);
        assertEq(usdg.balanceOf(address(vault)), 25_000);
    }

    // ── keeper-only sweep and keeper limits ──────────────────────────────

    /// Review HIGH: a permissionless sweep let anyone push the pool and trigger
    /// the victim trade in one transaction. Only a keeper may sweep now.
    function test_sweep_nonKeeperReverts() public {
        _accrue(alice, 10e6);
        SweepExecutor.Limit[] memory l = _limits();
        address[3] memory callers = [stranger, owner, alice];
        for (uint256 i; i < 3; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SpareAuth.NotKeeper.selector);
            exec.sweep(_one(alice), l);
        }
        vm.prank(owner);
        exec.setKeeper(keeper, false);
        vm.prank(keeper);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.sweep(_one(alice), l);
        assertEq(park.valueOf(alice), 10e6, "nothing moved");
        assertEq(exec.sweptEpoch(alice), 0);
    }

    /// An asset the keeper supplied no limit for is never bought blind: its leg
    /// defers (USDG back to the park) with a SwapDeferred notice.
    function test_defer_assetMissingFromLimits() public {
        _accrue(alice, 10e6);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapDeferred(address(nvda), 4e6, bytes("no keeper limit"));
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(nvda), 4e6, OracleGuard.Status.OK);
        assertEq(_sweepWith(_one(alice), _limitsWith(address(nvda), 0)), 1);

        assertEq(mrouter.buys(address(nvda)), 0, "no swap attempted without a limit");
        assertEq(nvda.balanceOf(alice), 0);
        assertEq(park.pending(alice), 4e6, "deferred leg back in the park");
        assertEq(usdg.balanceOf(alice), before, "not paid out as USDG");
        assertEq(spy.balanceOf(alice), _fair(6e6 - 15_000, SPY_PX), "the limited leg still converts");
        assertEq(usdg.balanceOf(address(vault)), 15_000, "no fee on the deferred leg");
        assertEq(exec.sweptEpoch(alice), exec.currentEpoch(), "epoch still consumed");
        _assertNoResidue();
    }

    /// An explicit zero limit, or no limits at all, is the same as a missing one.
    function test_defer_zeroOrEmptyLimits() public {
        _accrue(alice, 10e6);
        _accrue(bob, 10e6);
        SweepExecutor.Limit[] memory zero = new SweepExecutor.Limit[](2);
        zero[0] = SweepExecutor.Limit(address(spy), 0);
        zero[1] = SweepExecutor.Limit(address(nvda), 0);
        assertEq(_sweepWith(_one(alice), zero), 1);
        assertEq(_sweepWith(_one(bob), new SweepExecutor.Limit[](0)), 1);
        assertEq(park.pending(alice), 10e6);
        assertEq(park.pending(bob), 10e6);
        assertEq(mrouter.buys(address(spy)) + mrouter.buys(address(nvda)), 0);
        assertEq(usdg.balanceOf(address(vault)), 0);
        _assertNoResidue();
    }

    /// The keeper's quote limit is the PRIMARY bound: a fill 0.5% under the oracle
    /// is inside the 1.5% oracle backstop but below a 10 bp quote tolerance, so the
    /// leg defers instead of filling at that price.
    function test_keeperLimitBindsTighterThanOracle() public {
        uint256 perUsdg = _fair(1e6, SPY_PX);
        uint256 tight = (perUsdg * 9_990) / 10_000;
        mrouter.setFillBps(address(spy), 9_950);
        _accrue(alice, 10e6);
        _sweepWith(_one(alice), _limitsWith(address(spy), tight));
        assertEq(spy.balanceOf(alice), 0, "0.5% worse than the quote: not bought");
        assertEq(park.pending(alice), 6e6, "deferred, not paid out");
        assertGt(nvda.balanceOf(alice), 0);

        // Next epoch the pool is back at the quote: the same limit fills, and the
        // executor passes the keeper's bound (not the looser oracle one) as minOut.
        // The deferred $6 is re-split 60/40, so the SPY leg is $3.60.
        vm.warp(block.timestamp + 1 days);
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        mrouter.setFillBps(address(spy), 9_995);
        _sweepWith(_one(alice), _limitsWith(address(spy), tight));
        uint256 swapIn = 3_600_000 - _fee(3_600_000);
        assertEq(mrouter.lastMinOut(address(spy)), (swapIn * tight) / 1e6, "keeper limit is minOut");
        assertGt(mrouter.lastMinOut(address(spy)), (_fair(swapIn, SPY_PX) * 9_850) / 10_000);
        assertEq(spy.balanceOf(alice), (_fair(swapIn, SPY_PX) * 9_995) / 10_000);
    }

    /// A careless (or compromised) keeper cannot loosen execution past the oracle
    /// backstop: with a limit of 1 wei per USDG the minOut is still oracle - 1.5%.
    function test_oracleBackstopBindsWhenKeeperLimitIsLoose() public {
        mrouter.setFillBps(address(spy), 9_849);
        _accrue(alice, 10e6);
        _sweepWith(_one(alice), _limitsWith(address(spy), 1));
        assertEq(spy.balanceOf(alice), 0, "1.51% under the oracle: deferred");
        assertEq(park.pending(alice), 6e6);

        vm.warp(block.timestamp + 1 days);
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        mrouter.setFillBps(address(spy), 9_850);
        _sweepWith(_one(alice), _limitsWith(address(spy), 1));
        uint256 swapIn = 3_600_000 - _fee(3_600_000); // the deferred $6, re-split 60/40
        assertEq(mrouter.lastMinOut(address(spy)), (_fair(swapIn, SPY_PX) * 9_850) / 10_000, "oracle backstop");
        assertGt(spy.balanceOf(alice), 0);
    }

    // ── a failed swap DEFERS (it used to safe-settle) ────────────────────

    /// A fill past minOut is "not now", not a USDG payout: nobody can force a
    /// user's stock buy to be delivered as USDG by pushing the pool.
    function test_defer_slippageBreach() public {
        mrouter.setFillBps(address(spy), 9_849); // 1 bp past the 1.5% backstop
        _accrue(alice, 10e6);
        uint256 fair = _fair(6e6 - 15_000, SPY_PX);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapDeferred(
            address(spy),
            6e6,
            abi.encodeWithSelector(MockRouter.BelowMinOut.selector, (fair * 9_849) / 10_000, (fair * 9_850) / 10_000)
        );
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(spy), 6e6, OracleGuard.Status.OK);
        _sweep(_one(alice));
        assertEq(spy.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(alice), before, "never paid out as USDG");
        assertEq(park.pending(alice), 6e6, "the whole leg, gross, back in the park");
        assertEq(nvda.balanceOf(alice), _fair(4e6 - 10_000, NVDA_PX), "other leg unaffected");
        assertEq(usdg.balanceOf(address(vault)), 10_000, "fee only on the converted leg");
        assertEq(exec.sweptEpoch(alice), exec.currentEpoch(), "epoch consumed");
        _assertNoResidue();
    }

    function test_defer_routerRevert() public {
        mrouter.setReverts(address(nvda), true);
        _accrue(alice, 10e6);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(exec));
        emit SwapDeferred(address(nvda), 4e6, abi.encodeWithSelector(MockRouter.Breach.selector, address(nvda)));
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(nvda), 4e6, OracleGuard.Status.OK);
        _sweep(_one(alice));
        assertEq(usdg.balanceOf(alice), before);
        assertEq(park.pending(alice), 4e6);
        assertEq(usdg.balanceOf(address(vault)), 15_000);
        _assertNoResidue();
    }

    // ── safe-settle: ONLY a delisted asset ───────────────────────────────

    /// Acceptance (6): a suspended asset's leg is delivered as USDG with a notice.
    function test_safeSettle_suspendedAsset() public {
        _accrue(alice, 10e6);
        vm.prank(owner);
        registry.setActive(address(nvda), false);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(exec));
        emit SafeSettled(alice, address(nvda), 4e6, "asset suspended");
        _sweep(_one(alice));
        assertEq(nvda.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(alice) - before, 4e6);
        assertEq(spy.balanceOf(alice), _fair(6e6 - 15_000, SPY_PX));
        assertEq(usdg.balanceOf(address(vault)), 15_000);
        assertEq(mrouter.buys(address(nvda)), 0, "no swap attempted for a suspended asset");
        _assertNoResidue();
    }

    // ── defer ────────────────────────────────────────────────────────────

    /// A bad oracle answer (zero / negative / future / reverting feed) is not a
    /// reason to pay out USDG either: every non-OK status defers.
    function test_defer_badOracleAnswer() public {
        spyFeed.setRound(0, block.timestamp);
        _accrue(alice, 10e6);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(spy), 6e6, OracleGuard.Status.BAD_ANSWER);
        _sweep(_one(alice));
        assertEq(usdg.balanceOf(alice), before, "not paid out");
        assertEq(park.pending(alice), 6e6);
        assertEq(mrouter.buys(address(spy)), 0);
        _assertNoResidue();
    }

    function test_defer_feedReverts() public {
        nvdaFeed.setReverts(true);
        _accrue(alice, 10e6);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(nvda), 4e6, OracleGuard.Status.BAD_ANSWER);
        _sweep(_one(alice));
        assertEq(park.pending(alice), 4e6);
        assertGt(spy.balanceOf(alice), 0);
        _assertNoResidue();
    }

    function test_defer_staleFeed() public {
        _accrue(alice, 10e6);
        spyFeed.setUpdatedAt(block.timestamp - HEARTBEAT - 1 hours - 1);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(spy), 6e6, OracleGuard.Status.STALE);
        _sweep(_one(alice));
        assertEq(spy.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(alice), before, "a deferred leg never becomes a USDG payout");
        assertEq(park.pending(alice), 6e6, "deferred USDG is back in the park");
        assertEq(nvda.balanceOf(alice), _fair(4e6 - 10_000, NVDA_PX));
        assertEq(usdg.balanceOf(address(vault)), 10_000, "no fee on a deferred leg");
        _assertNoResidue();
    }

    function test_defer_tokenPaused() public {
        _accrue(alice, 10e6);
        spy.setPaused(true);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(spy), 6e6, OracleGuard.Status.PAUSED);
        _sweep(_one(alice));
        assertEq(park.pending(alice), 6e6);
        _assertNoResidue();
    }

    function test_defer_oraclePaused() public {
        _accrue(alice, 10e6);
        nvda.setOraclePaused(true);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(nvda), 4e6, OracleGuard.Status.PAUSED);
        _sweep(_one(alice));
        assertEq(park.pending(alice), 4e6);
        assertEq(spy.balanceOf(alice), _fair(6e6 - 15_000, SPY_PX));
    }

    function test_defer_sequencerDown() public {
        MockFeed seq = new MockFeed(0, 1); // 1 = down
        mrouter.setSequencerFeed(address(seq));
        _accrue(alice, 10e6);
        uint256 before = usdg.balanceOf(alice);
        _sweep(_one(alice));
        assertEq(park.pending(alice), 10e6, "every leg deferred");
        assertEq(usdg.balanceOf(alice), before);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    /// A sequencer feed with startedAt in the future used to underflow inside the
    /// guard and revert the whole batch; it now defers every leg.
    function test_defer_sequencerFutureStartedAtDoesNotRevert() public {
        MockFeed seq = new MockFeed(0, 0); // "up" ...
        seq.setStartedAt(block.timestamp + 5); // ... since a time in the future
        mrouter.setSequencerFeed(address(seq));
        _accrue(alice, 10e6);
        _accrue(bob, 10e6);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Deferred(alice, address(spy), 6e6, OracleGuard.Status.SEQUENCER_DOWN);
        assertEq(_sweep(_two(alice, bob)), 2, "batch did not revert");
        assertEq(park.pending(alice), 10e6);
        assertEq(park.pending(bob), 10e6);
        assertEq(usdg.balanceOf(address(vault)), 0);
        _assertNoResidue();
    }

    /// The weekend: everything defers, and is bought the next epoch the feeds are fresh.
    function test_defer_weekendThenRetriedNextEpoch() public {
        _accrue(alice, 10e6);
        vm.warp(block.timestamp + 3 days);
        uint256 before = usdg.balanceOf(alice);
        assertEq(_sweep(_one(alice)), 1);
        assertEq(park.valueOf(alice), 10e6, "all of it back in the park");
        assertEq(usdg.balanceOf(alice), before);
        assertEq(usdg.balanceOf(address(vault)), 0);

        // Markets reopen within the same epoch: the account already had its sweep.
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        assertEq(_sweep(_one(alice)), 0);

        vm.warp(block.timestamp + 1 days);
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        assertEq(_sweep(_one(alice)), 1);
        assertEq(spy.balanceOf(alice), _fair(6e6 - 15_000, SPY_PX));
        assertEq(park.valueOf(alice), 0);
    }

    /// All three outcomes in one sweep; the fee is charged only on the swapped leg.
    function test_threeOutcomesOneSweep() public {
        ElectionRegistry.Leg[] memory l = new ElectionRegistry.Leg[](3);
        l[0] = ElectionRegistry.Leg(address(spy), 5000);
        l[1] = ElectionRegistry.Leg(address(nvda), 3000);
        l[2] = ElectionRegistry.Leg(address(qqq), 2000);
        _setMix(alice, l);
        _accrue(alice, 10e6);
        vm.prank(owner);
        registry.setActive(address(qqq), false); // safe-settle
        nvdaFeed.setUpdatedAt(block.timestamp - 3 days); // defer
        uint256 before = usdg.balanceOf(alice);

        _sweep(_one(alice));
        assertEq(spy.balanceOf(alice), _fair(5e6 - 12_500, SPY_PX), "swapped");
        assertEq(park.pending(alice), 3e6, "deferred");
        assertEq(usdg.balanceOf(alice) - before, 2e6, "safe-settled");
        assertEq(usdg.balanceOf(address(vault)), 12_500, "fee on 5e6 only");
        _assertNoResidue();
    }

    // ── netting and distribution ─────────────────────────────────────────

    function test_net_oneSwapPerAssetSplitProRata() public {
        _accrue(alice, 10e6);
        _accrue(bob, 30e6);
        _accrue(carol, 20e6);
        assertEq(_sweep(_three(alice, bob, carol)), 3);
        assertEq(mrouter.buys(address(spy)), 1, "one SPY swap for the whole batch");
        assertEq(mrouter.buys(address(nvda)), 1);
        assertEq(mrouter.lastUsdgIn(address(spy)), 36e6 - _fee(36e6));

        uint256 out = _fair(36e6 - _fee(36e6), SPY_PX);
        assertEq(spy.balanceOf(alice), (out * 6e6) / 36e6);
        assertEq(spy.balanceOf(bob), (out * 18e6) / 36e6);
        assertEq(spy.balanceOf(alice) + spy.balanceOf(bob) + spy.balanceOf(carol), out);
        assertEq(spy.balanceOf(bob), 3 * spy.balanceOf(alice));
        assertEq(usdg.balanceOf(address(vault)), _fee(36e6) + _fee(24e6));
        _assertNoResidue();
    }

    function test_net_dustGoesToTheLastContributor() public {
        _setMix(alice, _mix1(address(spy)));
        _setMix(bob, _mix1(address(spy)));
        _setMix(carol, _mix1(address(spy)));
        _accrue(alice, 10e6);
        _accrue(bob, 7e6);
        _accrue(carol, 6e6);
        uint256 total = 23e6;
        uint256 out = _fair(total - _fee(total), SPY_PX) + 1; // an output 23 cannot divide
        mrouter.setFixedOut(address(spy), out);

        _sweep(_three(alice, bob, carol));
        uint256 a = (out * 10e6) / total;
        uint256 b = (out * 7e6) / total;
        uint256 cFloor = (out * 6e6) / total;
        uint256 dust = out - a - b - cFloor;
        assertGt(dust, 0, "scenario must produce dust");
        assertEq(spy.balanceOf(alice), a);
        assertEq(spy.balanceOf(bob), b);
        assertEq(spy.balanceOf(carol), cFloor + dust, "dust to the last contributor");
        assertEq(spy.balanceOf(alice) + spy.balanceOf(bob) + spy.balanceOf(carol), out, "exact conservation");
        assertEq(spy.balanceOf(address(exec)), 0);
    }

    /// The extreme of the dust rule: an output so small that every pro-rata share
    /// floors to zero ($1 legs into a token priced at $2e18). The last
    /// contributor takes all of it, and nobody gets a zero-amount delivery.
    function test_net_everyShareFloorsToZero_lastContributorTakesAll() public {
        (uint256 fb, uint16 fee, uint16 slip, uint64 epoch) =
            (exec.finalityBuffer(), exec.feeBps(), exec.slippageBps(), exec.epochLength());
        vm.prank(owner);
        exec.setParams(fb, 1_000_000, fee, slip, epoch); // the $1 minimum threshold
        spyFeed.setAnswer(2e26);
        address[3] memory abc = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            _setMix(abc[i], _mix1(address(spy)));
            _accrue(abc[i], 1e6);
        }
        mrouter.setFixedOut(address(spy), 2); // 2 base units for three equal legs
        SweepExecutor.Limit[] memory l = new SweepExecutor.Limit[](1);
        l[0] = SweepExecutor.Limit(address(spy), 1); // minOut = floor(2.9925) = 2

        vm.recordLogs();
        assertEq(_sweepWith(_three(alice, bob, carol), l), 3);
        assertEq(spy.balanceOf(alice), 0);
        assertEq(spy.balanceOf(bob), 0);
        assertEq(spy.balanceOf(carol), 2, "all of it to the last contributor");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 deliveries;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(exec) && logs[i].topics[0] == Delivered.selector) ++deliveries;
        }
        assertEq(deliveries, 1, "no zero-amount deliveries");
    }

    function test_net_differentMixesAcrossAccounts() public {
        _setMix(alice, _mix1(address(qqq)));
        _setMix(bob, _mix2(address(spy), 5000, address(qqq), 5000));
        // carol keeps the 60/40 default
        _accrue(alice, 10e6);
        _accrue(bob, 10e6);
        _accrue(carol, 10e6);
        assertEq(_sweep(_three(alice, bob, carol)), 3);
        assertEq(mrouter.buys(address(qqq)), 1);
        assertEq(mrouter.buys(address(spy)), 1);
        assertEq(mrouter.buys(address(nvda)), 1);

        uint256 qOut = _fair(15e6 - _fee(15e6), QQQ_PX);
        assertEq(qqq.balanceOf(alice), (qOut * 10e6) / 15e6);
        assertEq(qqq.balanceOf(alice) + qqq.balanceOf(bob), qOut);
        uint256 sOut = _fair(11e6 - _fee(11e6), SPY_PX);
        assertEq(spy.balanceOf(bob), (sOut * 5e6) / 11e6);
        assertEq(spy.balanceOf(bob) + spy.balanceOf(carol), sOut);
        assertEq(nvda.balanceOf(carol), _fair(4e6 - _fee(4e6), NVDA_PX));
        assertEq(nvda.balanceOf(alice) + nvda.balanceOf(bob), 0);
        assertEq(usdg.balanceOf(address(vault)), _fee(15e6) + _fee(11e6) + _fee(4e6));
        _assertNoResidue();
    }

    /// Mixed outcomes across accounts: only the accounts in a failing asset see it.
    function test_net_deferOnlyHitsThatAssetsContributors() public {
        _setMix(alice, _mix1(address(qqq)));
        _accrue(alice, 10e6);
        _accrue(bob, 10e6); // default SPY/NVDA
        mrouter.setReverts(address(qqq), true);
        uint256 aBefore = usdg.balanceOf(alice);
        uint256 bBefore = usdg.balanceOf(bob);
        assertEq(_sweep(_two(alice, bob)), 2);
        assertEq(usdg.balanceOf(alice), aBefore, "alice's leg not paid out");
        assertEq(park.pending(alice), 10e6, "alice's leg deferred");
        assertEq(usdg.balanceOf(bob), bBefore);
        assertEq(park.pending(bob), 0);
        assertGt(spy.balanceOf(bob), 0);
        assertEq(usdg.balanceOf(address(vault)), _fee(6e6) + _fee(4e6));
        _assertNoResidue();
    }

    // ── delivery failures ────────────────────────────────────────────────

    /// A blocklisted recipient must not revert everyone else's sweep: its share is
    /// held as claimable. claim() always pays the account itself, so the token's
    /// blocklist keeps applying; once the issuer lifts it, the account claims even
    /// while the executor is paused.
    function test_blockedRecipient_claimableThenClaim() public {
        _accrue(alice, 10e6);
        _accrue(bob, 10e6);
        spy.setBlocked(bob, true);
        uint256 out = _fair(12e6 - _fee(12e6), SPY_PX);
        uint256 bobShare = out - (out * 6e6) / 12e6;

        vm.expectEmit(true, true, false, true, address(exec));
        emit DeliveryHeld(bob, address(spy), bobShare);
        assertEq(_sweep(_two(alice, bob)), 2, "sweep did not revert");
        assertEq(spy.balanceOf(alice), (out * 6e6) / 12e6);
        assertEq(spy.balanceOf(bob), 0);
        assertEq(exec.claimable(bob, address(spy)), bobShare);
        assertEq(nvda.balanceOf(bob), _fair(4e6 - _fee(4e6), NVDA_PX), "unblocked token still delivered");
        _assertNoResidue();

        vm.prank(owner);
        exec.pause();

        // While the issuer still blocks bob, the claim reverts and nothing moves:
        // there is no recipient parameter to route around the blocklist with.
        vm.prank(bob);
        vm.expectRevert();
        exec.claim(address(spy));
        assertEq(exec.claimable(bob, address(spy)), bobShare);

        spy.setBlocked(bob, false);
        vm.expectEmit(true, true, false, true, address(exec));
        emit Claimed(bob, address(spy), bob, bobShare);
        vm.prank(bob);
        exec.claim(address(spy));
        assertEq(spy.balanceOf(bob), bobShare);
        assertEq(exec.claimable(bob, address(spy)), 0);
        assertEq(spy.balanceOf(address(exec)), 0);

        vm.prank(bob);
        exec.claim(address(spy)); // nothing left: a no-op, not a revert
        assertEq(spy.balanceOf(bob), bobShare);
    }

    function test_blockedUsdgRecipient_safeSettleBecomesClaimable() public {
        _accrue(alice, 10e6);
        usdg.setBlocked(alice, true);
        vm.prank(owner);
        registry.setActive(address(nvda), false);
        _sweep(_one(alice));
        assertEq(exec.claimable(alice, address(usdg)), 4e6);
        _assertNoResidue();
        usdg.setBlocked(alice, false);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        exec.claim(address(usdg));
        assertEq(usdg.balanceOf(alice) - before, 4e6);
        assertEq(usdg.balanceOf(address(exec)), 0);
    }

    function test_claim_onlyOwnBalance() public {
        _accrue(bob, 10e6);
        spy.setBlocked(bob, true);
        _sweep(_one(bob));
        uint256 held = exec.claimable(bob, address(spy));
        assertGt(held, 0);
        vm.prank(stranger);
        exec.claim(address(spy)); // stranger has nothing
        assertEq(spy.balanceOf(stranger), 0);
        assertEq(exec.claimable(bob, address(spy)), held);
    }

    function test_claim_nothingClaimableIsANoop() public {
        vm.recordLogs();
        vm.prank(alice);
        exec.claim(address(spy));
        assertEq(vm.getRecordedLogs().length, 0, "no transfer, no event");
    }

    /// With the fee at zero there is no fee transfer at all, not a zero-value one.
    function test_zeroFee_noTransferToTheVault() public {
        (uint256 fb, uint256 thr, uint16 slip, uint64 epoch) =
            (exec.finalityBuffer(), exec.threshold(), exec.slippageBps(), exec.epochLength());
        vm.prank(owner);
        exec.setParams(fb, thr, 0, slip, epoch);
        _accrue(alice, 10e6);

        vm.recordLogs();
        assertEq(_sweep(_one(alice)), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(usdg) || logs[i].topics[0] != transfer) continue;
            assertTrue(address(uint160(uint256(logs[i].topics[2]))) != address(vault), "no fee transfer");
        }
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(spy.balanceOf(alice), _fair(6e6, SPY_PX), "the whole leg converted");
    }

    // ── eligibility and idempotency ──────────────────────────────────────

    function test_threshold() public {
        _accrue(alice, 4_999_999);
        assertEq(_sweep(_one(alice)), 0, "below $5");
        assertEq(park.valueOf(alice), 4_999_999);
        _accrue(alice, 1);
        assertEq(_sweep(_one(alice)), 1, "exactly $5");
    }

    function test_oncePerEpoch() public {
        _accrue(alice, 10e6);
        assertEq(_sweep(_one(alice)), 1);
        _accrue(alice, 10e6);
        assertEq(_sweep(_one(alice)), 0);
        assertEq(park.valueOf(alice), 10e6);
        vm.warp(block.timestamp + 1 days);
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        assertEq(_sweep(_one(alice)), 1);
    }

    function test_duplicateAccountInBatchSweptOnce() public {
        _accrue(alice, 10e6);
        assertEq(_sweep(_three(alice, alice, alice)), 1);
        assertEq(mrouter.buys(address(spy)), 1);
        assertEq(spy.balanceOf(alice), _fair(6e6 - 15_000, SPY_PX));
        _assertNoResidue();
    }

    function test_unscreenedAccountSkipped() public {
        vm.prank(owner);
        screening.setEnforced(true);
        _accrue(alice, 10e6);
        assertEq(_sweep(_one(alice)), 0);
        assertEq(park.valueOf(alice), 10e6);
        vm.prank(attestor);
        screening.clear(alice, uint64(block.timestamp + 1 days));
        assertEq(_sweep(_one(alice)), 1);
    }

    /// A deployment whose ElectionRegistry has no default mix yet: an account
    /// with no mix of its own has nowhere to send its spare, so it is not swept
    /// and nothing leaves its park (withdrawn first, it would strand in the
    /// executor with no leg to settle it).
    function test_noMixAtAll_notSweptAndNothingLeavesThePark() public {
        vm.startPrank(owner);
        ElectionRegistry bare = new ElectionRegistry(owner, registry);
        CashPark park2 = new CashPark(owner, IERC20(address(usdg)));
        SweepExecutor exec2 = new SweepExecutor(
            owner, IAllowanceTransfer(address(permit2)), rules, bare, screening, StockRouter(address(mrouter)), park2, vault
        );
        park2.setAdapter(new UsdgParkAdapter(address(usdg), address(park2)));
        park2.setExecutor(address(exec2));
        exec2.setKeeper(keeper, true);
        vm.stopPrank();
        vm.prank(alice);
        permit2.approve(address(usdg), address(exec2), 100e6, uint48(block.timestamp + 1 days));
        assertEq(bare.mixOf(alice).length, 0);

        uint256 to = _pastFinality();
        vm.prank(keeper);
        exec2.accrue(alice, alice, 10e6, to);
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(keeper);
        assertEq(exec2.sweep(_one(alice), l), 0, "nothing to sweep into");
        assertEq(park2.valueOf(alice), 10e6, "still parked");
        assertEq(exec2.sweptEpoch(alice), 0, "not marked swept");
        assertEq(usdg.balanceOf(address(exec2)), 0);
    }

    function test_keeperOnlyAndPausable() public {
        _accrue(alice, 10e6);
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(owner);
        exec.pause();
        vm.prank(keeper);
        vm.expectRevert(SpareAuth.IsPaused.selector);
        exec.sweep(_one(alice), l);
        vm.prank(owner);
        exec.unpause();
        vm.prank(stranger);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.sweep(_one(alice), l);
        assertEq(_sweep(_one(alice)), 1, "the keeper sweeps");
    }

    /// Capacity: the sweep's working arrays are sized accounts x MAX_LEGS, so a
    /// full batch (MAX_BATCH accounts) of full mixes (MAX_LEGS legs each) settles
    /// every leg, one netted swap per asset.
    function test_fullBatchOfFullMixes_settlesEveryLeg() public {
        uint256 legs = elections.MAX_LEGS();
        address[3] memory listed = [address(spy), address(nvda), address(qqq)];
        ElectionRegistry.Leg[] memory mix = new ElectionRegistry.Leg[](legs);
        vm.startPrank(owner);
        for (uint256 l; l < legs; ++l) {
            address t = l < 3 ? listed[l] : address(new MockStockToken("Extra", "XTR"));
            if (l >= 3) _registerActive(t, address(new MockFeed(8, 100e8)));
            uint256 bps = 10_000 / legs + (l == legs - 1 ? 10_000 % legs : 0);
            mix[l] = ElectionRegistry.Leg(t, uint16(bps));
        }
        vm.stopPrank();

        uint256 n = exec.MAX_BATCH();
        address[] memory accts = new address[](n);
        for (uint256 i; i < n; ++i) {
            accts[i] = makeAddr(string.concat("full-batch-", vm.toString(i)));
            _onboard(accts[i], 100e6, 100e6);
            _setMix(accts[i], mix);
        }
        uint256 to = _pastFinality();
        for (uint256 i; i < n; ++i) {
            vm.prank(keeper);
            exec.accrue(accts[i], accts[i], 10e6, to);
        }

        assertEq(_sweep(accts), n);
        for (uint256 l; l < legs; ++l) {
            assertEq(mrouter.buys(mix[l].asset), 1, "one netted swap per asset");
            for (uint256 i; i < n; ++i) {
                assertGt(IERC20(mix[l].asset).balanceOf(accts[i]), 0, "every leg delivered");
            }
        }
        for (uint256 i; i < n; ++i) {
            assertEq(park.valueOf(accts[i]), 0);
        }
    }

    function test_batchTooLarge() public {
        address[] memory a = new address[](65);
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(keeper);
        vm.expectRevert(SweepExecutor.BatchTooLarge.selector);
        exec.sweep(a, l);
    }

    // ── parked units the adapter cannot redeem right now ─────────────────

    function _parkIntoMockAdapter(address a, uint256 amount) internal returns (MockParkAdapter ad) {
        ad = new MockParkAdapter(address(usdg), address(park));
        vm.prank(owner);
        park.setAdapter(ad);
        _accrue(a, amount);
        vm.prank(keeper);
        park.park(_one(a));
        assertEq(park.units(a), amount);
    }

    function test_unredeemableUnitsStayParked_pendingStillSwept() public {
        MockParkAdapter ad = _parkIntoMockAdapter(alice, 10e6);
        _accrue(alice, 6e6);
        ad.setRedeemReverts(true);
        assertEq(_sweep(_one(alice)), 1);
        assertEq(spy.balanceOf(alice), _fair(3_600_000 - _fee(3_600_000), SPY_PX));
        assertEq(park.units(alice), 10e6, "units still parked");
        assertEq(park.valueOf(alice), 10e6);
        _assertNoResidue();
    }

    function test_unredeemableUnitsBelowThreshold_returnedAndRetryable() public {
        MockParkAdapter ad = _parkIntoMockAdapter(alice, 10e6);
        _accrue(alice, 2e6);
        ad.setRedeemReverts(true);
        assertEq(_sweep(_one(alice)), 0);
        assertEq(park.pending(alice), 2e6, "the pending USDG was put back");
        assertEq(park.units(alice), 10e6);
        assertEq(exec.sweptEpoch(alice), 0, "not marked swept");
        _assertNoResidue();

        ad.setRedeemReverts(false);
        assertEq(_sweep(_one(alice)), 1, "retryable in the same epoch");
        assertEq(park.valueOf(alice), 0);
        assertEq(spy.balanceOf(alice), _fair(7_200_000 - _fee(7_200_000), SPY_PX));
    }

    // ── fuzz: netted distribution conserves every asset exactly ──────────

    function testFuzz_netDistributionConservesExactly(uint64[4] memory amts, uint8[4] memory mixes, uint64 extra)
        public
    {
        uint256[4] memory got;
        uint256 spyTotal;
        for (uint256 i; i < 4; ++i) {
            uint8 m = mixes[i] % 3;
            if (m == 1) _setMix(who[i], _mix1(address(spy)));
            if (m == 2) _setMix(who[i], _mix2(address(spy), 3333, address(qqq), 6667));
            got[i] = bound(amts[i], 5e6, 900e6);
            _accrue(who[i], got[i]);
            // Replicate the executor's leg split for the SPY leg.
            if (m == 0) spyTotal += (got[i] * 6000) / 10_000;
            if (m == 1) spyTotal += got[i];
            if (m == 2) spyTotal += (got[i] * 3333) / 10_000;
        }
        uint256 spyOut = _fair(spyTotal - _fee(spyTotal), SPY_PX) + bound(extra, 0, 1e18);
        mrouter.setFixedOut(address(spy), spyOut);

        address[] memory batch = new address[](4);
        for (uint256 i; i < 4; ++i) {
            batch[i] = who[i];
        }
        assertEq(_sweep(batch), 4);

        uint256 sumSpy;
        uint256 sumNvda;
        uint256 sumQqq;
        for (uint256 i; i < 4; ++i) {
            sumSpy += spy.balanceOf(who[i]);
            sumNvda += nvda.balanceOf(who[i]);
            sumQqq += qqq.balanceOf(who[i]);
            assertEq(park.valueOf(who[i]), 0);
        }
        assertEq(sumSpy, spyOut, "SPY conserved exactly");
        assertEq(sumNvda, nvda.totalSupply(), "NVDA conserved exactly");
        assertEq(sumQqq, qqq.totalSupply(), "QQQ conserved exactly");
        assertEq(spy.balanceOf(address(exec)) + nvda.balanceOf(address(exec)) + qqq.balanceOf(address(exec)), 0);
        assertEq(usdg.balanceOf(address(exec)), 0);
    }
}
