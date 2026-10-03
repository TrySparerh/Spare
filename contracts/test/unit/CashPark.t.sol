// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CashPark} from "../../src/CashPark.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {MockParkAdapter} from "../mocks/MockParkAdapter.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice CashPark in isolation: a dedicated instance whose executor is a test
///         address, over the configurable MockParkAdapter.
contract CashParkTest is UnitBase {
    CashPark internal cp;
    MockParkAdapter internal ad;
    address internal exe = makeAddr("executor");
    address internal pauser = makeAddr("pauser");

    event Credited(address indexed account, uint256 amount);
    event Parked(uint256 usdgIn, uint256 unitsOut, uint256 accounts);
    event WithdrawnForSweep(address indexed account, uint256 usdgOut, uint256 unitsLeft);
    event Returned(address indexed account, uint256 amount);
    event Exited(address indexed account, uint256 usdgOut, uint256 unitsInKind);
    event ExitUnitsKept(address indexed account, uint256 units);

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        cp = new CashPark(owner, IERC20(address(usdg)));
        ad = new MockParkAdapter(address(usdg), address(cp));
        cp.setAdapter(ad);
        cp.setExecutor(exe);
        cp.setKeeper(keeper, true);
        cp.setPauser(pauser);
        vm.stopPrank();
        usdg.mint(exe, 10_000_000e6);
        vm.prank(exe);
        usdg.approve(address(cp), type(uint256).max);
    }

    function _credit(address a, uint256 amt) internal {
        vm.prank(exe);
        cp.credit(a, amt);
    }

    function _park(address[] memory accts) internal {
        vm.prank(keeper);
        cp.park(accts);
    }

    /// @dev No USDG Transfer out of the park among `logs`. A zero-value transfer
    ///      is still a transfer — some tokens revert on one — so the park never
    ///      makes one for a balance that is empty.
    function _assertNoUsdgOutOfPark(Vm.Log[] memory logs) internal view {
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(usdg) || logs[i].topics[0] != transfer) continue;
            assertTrue(address(uint160(uint256(logs[i].topics[1]))) != address(cp), "USDG moved out of the park");
        }
    }

    // ── credit ───────────────────────────────────────────────────────────

    function test_credit_pullsFromExecutor() public {
        uint256 before = usdg.balanceOf(exe);
        vm.expectEmit(true, false, false, true, address(cp));
        emit Credited(alice, 3e6);
        _credit(alice, 3e6);
        assertEq(cp.pending(alice), 3e6);
        assertEq(cp.totalPending(), 3e6);
        assertEq(usdg.balanceOf(address(cp)), 3e6);
        assertEq(before - usdg.balanceOf(exe), 3e6);
        assertEq(cp.valueOf(alice), 3e6);
    }

    function test_credit_onlyExecutor() public {
        vm.prank(stranger);
        vm.expectRevert(CashPark.NotExecutor.selector);
        cp.credit(alice, 1e6);
    }

    function test_credit_zeroIsNoop() public {
        vm.recordLogs();
        _credit(alice, 0);
        assertEq(vm.getRecordedLogs().length, 0, "no transfer, no event");
        assertEq(cp.pending(alice), 0);
        assertEq(cp.totalPending(), 0);
    }

    // ── park ─────────────────────────────────────────────────────────────

    function test_park_movesPendingIntoUnits() public {
        ad.setRate(1e12, 1); // 18-dp shares per USDG base unit
        _credit(alice, 3e6);
        _credit(bob, 1e6);
        vm.expectEmit(false, false, false, true, address(cp));
        emit Parked(4e6, 4e18, 2);
        _park(_two(alice, bob));
        assertEq(cp.pending(alice), 0);
        assertEq(cp.pending(bob), 0);
        assertEq(cp.totalPending(), 0);
        assertEq(cp.units(alice), 3e18);
        assertEq(cp.units(bob), 1e18);
        assertEq(cp.totalUnits(), 4e18);
        assertEq(usdg.balanceOf(address(ad)), 4e6, "one netted deposit");
        assertEq(ad.depositCalls(), 1);
        assertEq(ad.share().balanceOf(address(ad)), cp.totalUnits());
        assertEq(cp.valueOf(alice), 3e6);
    }

    function test_park_duplicatesInTheBatchCountOnce() public {
        _credit(alice, 3e6);
        _credit(bob, 1e6);
        address[] memory b = new address[](4);
        b[0] = alice;
        b[1] = bob;
        b[2] = alice;
        b[3] = alice;
        _park(b);
        assertEq(usdg.balanceOf(address(ad)), 4e6, "alice's pending deposited once");
        assertEq(cp.units(alice), 3e6);
        assertEq(cp.units(bob), 1e6);
        assertEq(cp.totalUnits(), 4e6);
    }

    function test_park_dustGoesToTheLastRecipient() public {
        ad.setRate(10, 7); // out = floor(7e6 * 10 / 7) = 10e6
        _credit(alice, 1e6);
        _credit(bob, 2e6);
        _credit(carol, 4e6);
        _park(_three(alice, bob, carol));
        uint256 out = 10e6;
        assertEq(cp.units(alice), (out * 1e6) / 7e6);
        assertEq(cp.units(bob), (out * 2e6) / 7e6);
        uint256 carolFloor = (out * 4e6) / 7e6;
        uint256 dust = out - cp.units(alice) - cp.units(bob) - carolFloor;
        assertGt(dust, 0, "scenario must produce dust");
        assertEq(cp.units(carol), carolFloor + dust);
        assertEq(cp.units(alice) + cp.units(bob) + cp.units(carol), out, "no unit left unowned");
        assertEq(cp.totalUnits(), out);
    }

    /// With a duplicate at the end of the batch, the dust goes to the last entry
    /// that actually contributed, and still no unit is lost.
    function test_park_dustWithTrailingDuplicate() public {
        ad.setRate(10, 7);
        _credit(alice, 1e6);
        _credit(bob, 2e6);
        _credit(carol, 4e6);
        address[] memory b = new address[](4);
        b[0] = alice;
        b[1] = bob;
        b[2] = carol;
        b[3] = alice;
        _park(b);
        assertEq(cp.units(alice) + cp.units(bob) + cp.units(carol), 10e6);
        assertEq(cp.units(alice), (uint256(10e6) * 1e6) / 7e6, "duplicate does not collect the dust");
    }

    /// Law 4: stale NAV holds accrual un-parked.
    function test_park_noopWhenStale() public {
        _credit(alice, 3e6);
        ad.setFresh(false);
        assertFalse(cp.isFresh());
        _park(_one(alice));
        assertEq(cp.pending(alice), 3e6);
        assertEq(cp.units(alice), 0);
        assertEq(ad.depositCalls(), 0);
        assertEq(usdg.balanceOf(address(cp)), 3e6);
    }

    /// The extreme of the dust rule: units so coarse that every pro-rata share
    /// floors to zero. The last contributor takes them all; none is unowned.
    function test_park_everyShareFloorsToZero_lastContributorTakesAll() public {
        ad.setRate(2, 3e6); // out = floor(3e6 * 2 / 3e6) = 2 units for three accounts
        _credit(alice, 1e6);
        _credit(bob, 1e6);
        _credit(carol, 1e6);
        _park(_three(alice, bob, carol));
        assertEq(cp.units(alice), 0);
        assertEq(cp.units(bob), 0);
        assertEq(cp.units(carol), 2, "all of it to the last contributor");
        assertEq(cp.totalUnits(), 2);
    }

    function test_park_noopWhenNothingPending() public {
        _park(_two(alice, bob));
        assertEq(ad.depositCalls(), 0);
        assertEq(cp.totalUnits(), 0);
    }

    function test_park_onlyKeeper() public {
        vm.prank(stranger);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        cp.park(_one(alice));
    }

    function test_park_pausedReverts() public {
        vm.prank(pauser);
        cp.pause();
        vm.prank(keeper);
        vm.expectRevert(SpareAuth.IsPaused.selector);
        cp.park(_one(alice));
    }

    function test_pause_onlyPauserOrOwner_unpauseOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(SpareAuth.NotPauser.selector);
        cp.pause();
        vm.prank(pauser);
        cp.pause();
        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauser));
        cp.unpause();
        vm.prank(owner);
        cp.unpause();
        assertFalse(cp.paused());
    }

    // ── withdrawForSweep / returnFromSweep ───────────────────────────────

    function test_withdrawForSweep_pendingAndUnits() public {
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 2e6);
        uint256 before = usdg.balanceOf(exe);
        vm.expectEmit(true, false, false, true, address(cp));
        emit WithdrawnForSweep(alice, 5e6, 0);
        vm.prank(exe);
        (uint256 out, uint256 left) = cp.withdrawForSweep(alice);
        assertEq(out, 5e6);
        assertEq(left, 0);
        assertEq(usdg.balanceOf(exe) - before, 5e6);
        assertEq(cp.pending(alice), 0);
        assertEq(cp.units(alice), 0);
        assertEq(cp.totalPending(), 0);
        assertEq(cp.totalUnits(), 0);
    }

    /// The adapter cannot redeem right now: units stay parked, only pending moves,
    /// and the sweep is not blocked.
    function test_withdrawForSweep_whenAdapterRevertsKeepsUnits() public {
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 2e6);
        ad.setRedeemReverts(true);
        vm.expectEmit(true, false, false, true, address(cp));
        emit WithdrawnForSweep(alice, 2e6, 3e6);
        vm.prank(exe);
        (uint256 out, uint256 left) = cp.withdrawForSweep(alice);
        assertEq(out, 2e6);
        assertEq(left, 3e6);
        assertEq(cp.units(alice), 3e6, "units stay parked");
        assertEq(cp.totalUnits(), 3e6);
        assertEq(cp.pending(alice), 0);
        assertEq(ad.share().balanceOf(address(ad)), 3e6);
    }

    /// Only what the account holds is touched: no USDG leaves the park for an
    /// account with nothing pending, and the adapter is never called for one
    /// with no units (on SGOV that would be a market sell of nothing, and off
    /// hours a revert).
    function test_withdrawForSweep_touchesOnlyWhatIsHeld() public {
        _credit(alice, 3e6);
        _park(_one(alice)); // alice: units only
        _credit(bob, 2e6); // bob: pending only

        vm.recordLogs();
        vm.prank(exe);
        (uint256 out,) = cp.withdrawForSweep(alice);
        assertEq(out, 3e6);
        _assertNoUsdgOutOfPark(vm.getRecordedLogs());

        vm.expectCall(address(ad), abi.encodeWithSelector(MockParkAdapter.redeem.selector), 0);
        vm.prank(exe);
        (out,) = cp.withdrawForSweep(bob);
        assertEq(out, 2e6);
    }

    function test_withdrawForSweep_onlyExecutor() public {
        vm.prank(stranger);
        vm.expectRevert(CashPark.NotExecutor.selector);
        cp.withdrawForSweep(alice);
    }

    function test_returnFromSweep_rejoinsPending() public {
        vm.expectEmit(true, false, false, true, address(cp));
        emit Returned(alice, 4e6);
        vm.prank(exe);
        cp.returnFromSweep(alice, 4e6);
        assertEq(cp.pending(alice), 4e6);
        assertEq(cp.totalPending(), 4e6);
        assertEq(usdg.balanceOf(address(cp)), 4e6);
        vm.prank(exe);
        cp.returnFromSweep(alice, 0); // no-op
        assertEq(cp.pending(alice), 4e6);
    }

    function test_returnFromSweep_zeroIsNoop() public {
        vm.recordLogs();
        vm.prank(exe);
        cp.returnFromSweep(alice, 0);
        assertEq(vm.getRecordedLogs().length, 0, "no transfer, no event");
        assertEq(cp.pending(alice), 0);
    }

    function test_returnFromSweep_onlyExecutor() public {
        vm.prank(stranger);
        vm.expectRevert(CashPark.NotExecutor.selector);
        cp.returnFromSweep(alice, 1);
    }

    // ── exit (law 5: never gated) ────────────────────────────────────────

    function test_exit_redeemsEverythingToUsdg() public {
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 2e6);
        vm.expectEmit(true, false, false, true, address(cp));
        emit Exited(alice, 5e6, 0);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = cp.exit();
        assertEq(out, 5e6);
        assertEq(inKind, 0);
        assertEq(usdg.balanceOf(alice), 5e6);
        assertEq(cp.valueOf(alice), 0);
        assertEq(cp.totalPending(), 0);
        assertEq(cp.totalUnits(), 0);
    }

    function test_exit_inKindFallbackWhenRedeemFails() public {
        ad.setRate(1e12, 1);
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 2e6);
        ad.setRedeemReverts(true);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = cp.exit();
        assertEq(out, 2e6, "pending still paid in USDG");
        assertEq(inKind, 3e18, "units handed over in kind");
        assertEq(usdg.balanceOf(alice), 2e6);
        assertEq(ad.share().balanceOf(alice), 3e18);
        assertEq(cp.units(alice), 0);
        assertEq(cp.totalUnits(), 0);
    }

    function test_exit_whilePaused() public {
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 2e6);
        vm.prank(pauser);
        cp.pause();
        vm.prank(alice);
        cp.exit();
        assertEq(usdg.balanceOf(alice), 5e6);
    }

    function test_exit_withNothingIsANoop() public {
        vm.prank(alice);
        (uint256 out, uint256 inKind) = cp.exit();
        assertEq(out, 0);
        assertEq(inKind, 0);
    }

    /// Same rule on the way out: an exit with nothing pending moves no USDG out of
    /// the park, one with no units never calls the adapter (neither redeem nor
    /// the in-kind fallback), and ExitUnitsKept is only for units actually kept.
    function test_exit_touchesOnlyWhatIsHeld() public {
        _credit(alice, 3e6);
        _park(_one(alice)); // alice: units only
        _credit(bob, 2e6); // bob: pending only

        vm.recordLogs();
        vm.prank(alice);
        (uint256 out,) = cp.exit();
        assertEq(out, 3e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertNoUsdgOutOfPark(logs);
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != ExitUnitsKept.selector, "nothing was kept back");
        }

        vm.expectCall(address(ad), abi.encodeWithSelector(MockParkAdapter.redeem.selector), 0);
        vm.expectCall(address(ad), abi.encodeWithSelector(MockParkAdapter.exitInKind.selector), 0);
        vm.prank(bob);
        (out,) = cp.exit();
        assertEq(out, 2e6);
        assertEq(usdg.balanceOf(bob), 2e6);
    }

    function test_exit_onlyTouchesTheCaller() public {
        _credit(alice, 3e6);
        _credit(bob, 4e6);
        _park(_two(alice, bob));
        vm.prank(alice);
        cp.exit();
        assertEq(cp.valueOf(bob), 4e6);
        assertEq(cp.units(bob), 4e6);
    }

    /// Law 5 ("exit never gated"; SPARE-BUILD.md §4 "Nothing can halt a user's
    /// exit"). If the parked units can move neither to USDG nor in kind (a paused
    /// or blocklisting underlying), the account's plain USDG `pending` — which sits
    /// in CashPark itself and has no dependency on the adapter — still comes out.
    /// (exit() used to be all-or-nothing and held the pending USDG hostage.) The
    /// stuck units stay booked to the account, flagged by ExitUnitsKept, and a
    /// later exit collects them once the underlying can move again.
    function test_exit_pendingNotHostageToStuckUnits() public {
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 2e6);
        ad.setRedeemReverts(true);
        ad.setExitInKindReverts(true);

        vm.expectEmit(true, false, false, true, address(cp));
        emit Exited(alice, 2e6, 0);
        vm.expectEmit(true, false, false, true, address(cp));
        emit ExitUnitsKept(alice, 3e6);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = cp.exit();
        assertEq(out, 2e6, "pending paid");
        assertEq(inKind, 0);
        assertEq(usdg.balanceOf(alice), 2e6);
        assertEq(cp.pending(alice), 0);
        assertEq(cp.totalPending(), 0);
        assertEq(cp.units(alice), 3e6, "units kept, not lost");
        assertEq(cp.totalUnits(), 3e6);
        assertEq(ad.share().balanceOf(address(ad)), 3e6, "still held by the adapter");

        // The underlying can move again: a second exit collects the units.
        ad.setExitInKindReverts(false);
        vm.prank(alice);
        (out, inKind) = cp.exit();
        assertEq(out, 0);
        assertEq(inKind, 3e6);
        assertEq(ad.share().balanceOf(alice), 3e6);
        assertEq(cp.units(alice), 0);
        assertEq(cp.totalUnits(), 0);
    }

    /// Stuck units do not block other accounts' exits or the adapter's accounting.
    function test_exit_stuckUnitsDoNotAffectOthers() public {
        _credit(alice, 3e6);
        _credit(bob, 4e6);
        _park(_two(alice, bob));
        ad.setRedeemReverts(true);
        ad.setExitInKindReverts(true);
        vm.prank(alice);
        cp.exit();
        ad.setRedeemReverts(false);
        vm.prank(bob);
        (uint256 out,) = cp.exit();
        assertEq(out, 4e6);
        assertEq(cp.units(alice), 3e6);
        assertEq(cp.totalUnits(), 3e6);
    }

    // ── adapter management ───────────────────────────────────────────────

    function test_setAdapter_blockedWhileUnitsOpen() public {
        _credit(alice, 3e6);
        _park(_one(alice));
        MockParkAdapter next = new MockParkAdapter(address(usdg), address(cp));
        vm.prank(owner);
        vm.expectRevert(CashPark.AdapterInUse.selector);
        cp.setAdapter(next);

        vm.prank(alice);
        cp.exit();
        vm.prank(owner);
        cp.setAdapter(next);
        assertEq(address(cp.adapter()), address(next));
    }

    function test_setAdapter_allowedWithOnlyPending() public {
        _credit(alice, 3e6);
        MockParkAdapter next = new MockParkAdapter(address(usdg), address(cp));
        vm.prank(owner);
        cp.setAdapter(next);
        assertEq(cp.valueOf(alice), 3e6);
    }

    function test_setAdapterAndExecutor_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cp.setAdapter(ad);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cp.setExecutor(stranger);
        vm.stopPrank();
    }

    function test_valueOf_followsAdapterNav() public {
        ad.setRate(1e12, 1);
        _credit(alice, 3e6);
        _park(_one(alice));
        _credit(alice, 1e6);
        assertEq(cp.valueOf(alice), 4e6);
        // NAV up 10%: each unit is worth more (and the adapter is funded for it).
        ad.setRate(10e12, 11);
        usdg.mint(address(ad), 1e6);
        assertEq(cp.valueOf(alice), 1e6 + (3e18 * 11) / 10e12);
        assertEq(cp.valueOf(alice), 4_300_000);
    }

    // ── fuzz: unit conservation ──────────────────────────────────────────

    /// park() splits the adapter's output pro-rata with floors, dust to the last
    /// contributor; the sum of units always equals what the adapter minted, and
    /// every non-last contributor gets exactly its floor share.
    function testFuzz_parkConservesUnits(uint64[4] memory amts, uint8[6] memory picks, uint64 num, uint32 den)
        public
    {
        address[4] memory who = [alice, bob, carol, dave];
        uint256 n = bound(num, 1, 1e13);
        uint256 d = bound(den, 1, 1e7);
        ad.setRate(n, d);

        uint256 total;
        for (uint256 i; i < 4; ++i) {
            uint256 a = bound(amts[i], 0, 1_000_000e6);
            _credit(who[i], a);
            total += a;
        }
        address[] memory batch = new address[](6);
        uint256[4] memory seen;
        for (uint256 i; i < 6; ++i) {
            batch[i] = who[picks[i] % 4];
        }
        // What each account contributes (duplicates count once) and who is last.
        uint256 batchTotal;
        uint256[4] memory contrib;
        int256 lastIdx = -1;
        for (uint256 i; i < 6; ++i) {
            uint256 k = picks[i] % 4;
            if (seen[k] == 0) {
                seen[k] = 1;
                contrib[k] = cp.pending(who[k]);
                batchTotal += contrib[k];
                if (contrib[k] != 0) lastIdx = int256(k);
            }
        }

        _park(batch);

        uint256 out = (batchTotal * n) / d;
        uint256 sumUnits;
        for (uint256 k; k < 4; ++k) {
            sumUnits += cp.units(who[k]);
            if (seen[k] == 1) assertEq(cp.pending(who[k]), 0, "batch pending cleared");
            if (seen[k] == 1 && contrib[k] != 0 && int256(k) != lastIdx) {
                assertEq(cp.units(who[k]), (out * contrib[k]) / batchTotal, "floor share");
            }
        }
        assertEq(sumUnits, out, "units conserved exactly");
        assertEq(cp.totalUnits(), out);
        assertEq(ad.share().balanceOf(address(ad)), out);
        assertEq(cp.totalPending(), total - batchTotal);
        assertEq(usdg.balanceOf(address(cp)), cp.totalPending());
    }

    /// Credit / withdraw / return / exit keep pending and units accounted exactly.
    function testFuzz_flowsConserveAccounting(uint64 a1, uint64 a2, uint64 r, bool redeemDown) public {
        uint256 x = bound(a1, 1, 1_000e6);
        uint256 y = bound(a2, 0, 1_000e6);
        _credit(alice, x);
        _park(_one(alice));
        _credit(alice, y);
        _credit(bob, x);
        ad.setRedeemReverts(redeemDown);

        vm.prank(exe);
        (uint256 out, uint256 left) = cp.withdrawForSweep(alice);
        assertEq(out, redeemDown ? y : x + y);
        assertEq(left, redeemDown ? x : 0);

        uint256 back = bound(r, 0, out);
        vm.prank(exe);
        cp.returnFromSweep(alice, back);

        assertEq(cp.totalPending(), cp.pending(alice) + cp.pending(bob));
        assertEq(cp.totalUnits(), cp.units(alice) + cp.units(bob));
        assertEq(usdg.balanceOf(address(cp)), cp.totalPending());

        vm.prank(alice);
        cp.exit();
        vm.prank(bob);
        cp.exit();
        assertEq(cp.totalPending(), 0);
        assertEq(cp.totalUnits(), 0);
        assertEq(usdg.balanceOf(address(cp)), 0);
    }
}
