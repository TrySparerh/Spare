// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockArbSysSettable} from "../mocks/MockArbSysSettable.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice SweepExecutor accrual (SPARE-BUILD.md §3.1): keeper-attested but bounded
///         by the cursor, the link block, the rule's activeSince block, finality,
///         the ROLLING 7-day cap and Permit2. accrueBatch skips bad entries.
contract SweepExecutorAccrueTest is UnitBase {
    uint64 internal constant CAP = 50e6;

    event Accrued(address indexed account, address indexed wallet, uint256 amount, uint256 fromBlock, uint256 toBlock);
    event AccrualSkipped(address indexed account, address indexed wallet, uint256 toBlock, bytes reason);

    function setUp() public override {
        super.setUp();
        _onboard(alice, 1_000e6, CAP);
        _onboard(bob, 1_000e6, CAP);
    }

    function _accrueAt(address account, address wallet, uint256 amount, uint256 toBlock) internal {
        vm.prank(keeper);
        exec.accrue(account, wallet, amount, toBlock);
    }

    function _pulledFrom(address w, uint256 start) internal view returns (uint256) {
        return start - usdg.balanceOf(w);
    }

    // ── happy path ───────────────────────────────────────────────────────

    function test_accrue_pullsViaPermit2AndCredits() public {
        uint256 linked = rules.linkedAt(alice);
        uint256 to = _pastFinality();
        (uint160 allowBefore,,) = permit2.allowance(alice, address(usdg), address(exec));
        vm.expectEmit(true, true, false, true, address(exec));
        emit Accrued(alice, alice, 3e6, linked, to);
        _accrueAt(alice, alice, 3e6, to);

        assertEq(usdg.balanceOf(alice), 997e6);
        assertEq(park.pending(alice), 3e6);
        assertEq(park.valueOf(alice), 3e6);
        assertEq(usdg.balanceOf(address(exec)), 0, "nothing lingers in the executor");
        assertEq(exec.lastAccruedBlock(alice), to);
        assertEq(exec.pulledLast7Days(alice), 3e6);
        assertEq(exec.dayPulled(alice, block.timestamp / 1 days), 3e6);
        (uint160 allowAfter,,) = permit2.allowance(alice, address(usdg), address(exec));
        assertEq(allowBefore - allowAfter, 3e6, "Permit2 allowance consumed");
    }

    function test_accrue_onlyKeeper() public {
        uint256 to = _pastFinality();
        vm.prank(stranger);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.accrue(alice, alice, 1e6, to);
    }

    function test_accrue_revokedKeeperRejected() public {
        vm.prank(owner);
        exec.setKeeper(keeper, false);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.accrue(alice, alice, 1e6, to);
    }

    function test_accrue_pausedBlocks() public {
        address p = makeAddr("pauser");
        vm.prank(owner);
        exec.setPauser(p);
        vm.prank(p);
        exec.pause();
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(SpareAuth.IsPaused.selector);
        exec.accrue(alice, alice, 1e6, to);
    }

    // ── cursor ───────────────────────────────────────────────────────────

    function test_accrue_cursorAdvancesAndNeverRepeats() public {
        uint256 t1 = _pastFinality();
        _accrueAt(alice, alice, 1e6, t1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, t1, t1));
        exec.accrue(alice, alice, 1e6, t1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, t1, t1 - 1));
        exec.accrue(alice, alice, 1e6, t1 - 1);

        uint256 t2 = _pastFinality();
        vm.expectEmit(true, true, false, true, address(exec));
        emit Accrued(alice, alice, 2e6, t1, t2);
        _accrueAt(alice, alice, 2e6, t2);
        assertEq(exec.lastAccruedBlock(alice), t2);
        assertEq(park.pending(alice), 3e6);
    }

    /// The cursor is per wallet: bob's progress does not move alice's.
    function test_accrue_cursorIsPerWallet() public {
        uint256 t1 = _pastFinality();
        _accrueAt(bob, bob, 1e6, t1);
        assertEq(exec.lastAccruedBlock(alice), 0);
        _accrueAt(alice, alice, 1e6, t1);
        assertEq(exec.lastAccruedBlock(alice), t1);
    }

    // ── linkedAt floor ───────────────────────────────────────────────────

    function test_accrue_cannotReachBeforeLink() public {
        uint256 linked = rules.linkedAt(alice);
        _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, linked, linked));
        exec.accrue(alice, alice, 1e6, linked);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, linked, linked - 100));
        exec.accrue(alice, alice, 1e6, linked - 100);
        _accrueAt(alice, alice, 1e6, linked + 1);
        assertEq(park.pending(alice), 1e6);
    }

    /// Re-linking moves the floor to the NEW link block, above an older cursor, so
    /// payments made while unlinked can never be pulled.
    function test_accrue_relinkFloorBeatsOldCursor() public {
        uint256 t1 = _pastFinality();
        _accrueAt(alice, alice, 1e6, t1);
        vm.prank(alice);
        rules.unlink(alice);
        vm.roll(block.number + 20_000);
        vm.prank(alice);
        rules.linkSelf();
        uint256 relinked = rules.linkedAt(alice);
        assertGt(relinked, t1);

        _pastFinality();
        uint256 gap = t1 + 10_000; // a block while alice was unlinked
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, relinked, gap));
        exec.accrue(alice, alice, 1e6, gap);
    }

    // ── finality (L2 clock) ──────────────────────────────────────────────

    function test_accrue_finalityBoundary() public {
        vm.roll(block.number + 10_000);
        uint256 head = block.number;
        uint256 buf = exec.finalityBuffer();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.NotFinal.selector, head - buf + 1, head));
        exec.accrue(alice, alice, 1e6, head - buf + 1);
        _accrueAt(alice, alice, 1e6, head - buf);
        assertEq(exec.lastAccruedBlock(alice), head - buf);
    }

    /// On Nitro, block.number is an L1 estimate far below the L2 number. Finality is
    /// judged on ArbSys's L2 block (= RPC eth_blockNumber), which is what the
    /// engine's observer indexes by.
    function test_accrue_finalityUsesTheL2Clock() public {
        uint256 l2Head = block.number + 500_000;
        vm.etch(address(0x64), address(new MockArbSysSettable()).code);
        MockArbSysSettable(address(0x64)).set(l2Head);
        vm.roll(21_000_000); // Nitro's L1-estimate block.number
        uint256 buf = exec.finalityBuffer();

        _accrueAt(alice, alice, 1e6, l2Head - buf);
        assertEq(exec.lastAccruedBlock(alice), l2Head - buf);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.NotFinal.selector, l2Head - buf + 1, l2Head));
        exec.accrue(bob, bob, 1e6, l2Head - buf + 1);
    }

    // ── weekly cap (acceptance 7) ────────────────────────────────────────

    function test_accrue_weeklyCapExactlyReachable() public {
        _accrue(alice, 30e6);
        _accrue(alice, 20e6);
        assertEq(exec.remainingWeeklyCap(alice), 0);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, CAP + 1, CAP));
        exec.accrue(alice, alice, 1, to);
    }

    function test_accrue_weeklyCapSharedAcrossWallets() public {
        (address w2, uint256 k2) = makeAddrAndKey("second-wallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                rules.domainSeparator(),
                keccak256(abi.encode(rules.LINK_TYPEHASH(), alice, w2, uint256(0), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k2, digest);
        vm.prank(alice);
        rules.linkWallet(w2, deadline, abi.encodePacked(r, s, v));
        usdg.mint(w2, 100e6);
        vm.startPrank(w2);
        usdg.approve(address(permit2), type(uint256).max);
        permit2.approve(address(usdg), address(exec), 100e6, uint48(block.timestamp + 30 days));
        vm.stopPrank();

        _accrue(alice, 30e6);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 51e6, CAP));
        exec.accrue(alice, w2, 21e6, to);
        _accrueAt(alice, w2, 20e6, to);
        assertEq(park.pending(alice), 50e6);
        assertEq(usdg.balanceOf(w2), 80e6);
    }

    function test_accrue_weeklyCapRollsOverAfterAWeek() public {
        _accrue(alice, 50e6);
        assertEq(exec.remainingWeeklyCap(alice), 0);
        vm.warp(block.timestamp + 7 days);
        assertEq(exec.pulledLast7Days(alice), 0, "the pull's day has left the window");
        assertEq(exec.remainingWeeklyCap(alice), CAP, "a week later the cap is restored");
        _accrue(alice, 50e6);
        assertEq(park.pending(alice), 100e6);
    }

    /// SPARE-BUILD.md §3.1: the pull is bounded by weeklyCap over a ROLLING 7-day
    /// window. It used to reset on calendar-week boundaries (timestamp / 1 weeks),
    /// so the full cap could be pulled just before the boundary and again just
    /// after it: 2x the cap inside two hours. Now the second pull is refused, and
    /// keeps being refused until the first pull's UTC day leaves the window.
    /// @dev The window is 7 UTC-day buckets (today + the 6 before), so it frees up
    ///      at the start of day D+7, i.e. 6 to 7 days after a pull on day D.
    function test_accrue_weeklyCapIsARolling7DayWindow() public {
        uint256 boundary = (vm.getBlockTimestamp() / 1 weeks + 1) * 1 weeks;
        vm.warp(boundary - 1 hours); // day D = the last day of a calendar week
        uint256 start = usdg.balanceOf(alice);
        _accrue(alice, CAP);

        vm.warp(boundary + 1 hours); // a new calendar week, two hours later
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 2 * uint256(CAP), CAP));
        exec.accrue(alice, alice, CAP, to);
        assertEq(exec.remainingWeeklyCap(alice), 0);

        // Not even one more base unit on days D+1 .. D+6.
        for (uint256 d; d < 6; ++d) {
            vm.warp(boundary + d * 1 days + 12 hours);
            to = _pastFinality();
            vm.prank(keeper);
            vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, uint256(CAP) + 1, CAP));
            exec.accrue(alice, alice, 1, to);
        }
        assertEq(_pulledFrom(alice, start), CAP, "never more than weeklyCap inside the window");

        // Day D+7: day D is out of the window and the full cap is available again.
        vm.warp(boundary + 6 days);
        assertEq(exec.remainingWeeklyCap(alice), CAP);
        _accrue(alice, CAP);
        assertEq(_pulledFrom(alice, start), 2 * uint256(CAP));
    }

    /// Pulls on different days add up inside the window; the oldest drops out first.
    function test_accrue_rollingWindowSumsAcrossDays() public {
        uint256 day0 = vm.getBlockTimestamp() / 1 days + 1; // tomorrow, so every warp moves forward
        vm.warp(day0 * 1 days + 1 hours);
        _accrue(alice, 20e6);
        vm.warp((day0 + 3) * 1 days + 1 hours);
        _accrue(alice, 20e6);
        assertEq(exec.pulledLast7Days(alice), 40e6);
        assertEq(exec.remainingWeeklyCap(alice), 10e6);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 51e6, CAP));
        exec.accrue(alice, alice, 11e6, to);

        vm.warp((day0 + 7) * 1 days); // day0 leaves the window, day0+3 does not
        assertEq(exec.pulledLast7Days(alice), 20e6);
        assertEq(exec.remainingWeeklyCap(alice), 30e6);
        _accrue(alice, 30e6);
        assertEq(exec.remainingWeeklyCap(alice), 0);
    }

    /// weeklyCap == 0 means round-ups are OFF: refused as RuleDisabled, and not even
    /// a zero-amount accrual can walk the cursor across the disabled window.
    function test_accrue_zeroCapIsDisabled() public {
        vm.prank(alice);
        rules.setRule(1, 1, 0, true);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.RuleDisabled.selector, alice));
        exec.accrue(alice, alice, 1, to);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.RuleDisabled.selector, alice));
        exec.accrue(alice, alice, 0, to);
        assertEq(exec.lastAccruedBlock(alice), 0);
        assertEq(exec.remainingWeeklyCap(alice), 0);
    }

    function test_accrue_zeroAmountAdvancesCursorOnly() public {
        uint256 to = _pastFinality();
        vm.expectEmit(true, true, false, true, address(exec));
        emit Accrued(alice, alice, 0, rules.linkedAt(alice), to);
        _accrueAt(alice, alice, 0, to);
        assertEq(exec.lastAccruedBlock(alice), to);
        assertEq(park.pending(alice), 0);
        assertEq(usdg.balanceOf(alice), 1_000e6);
        assertEq(exec.pulledLast7Days(alice), 0);
    }

    /// A zero-amount accrual only walks the cursor. Permit2 is never called, so it
    /// still works for a wallet whose allowance has expired or been revoked.
    function test_accrue_zeroAmountNeverTouchesPermit2() public {
        vm.prank(alice);
        permit2.approve(address(usdg), address(exec), 0, uint48(block.timestamp - 1));
        uint256 to = _pastFinality();
        vm.expectCall(address(permit2), abi.encodeWithSelector(MockPermit2.transferFrom.selector), 0);
        _accrueAt(alice, alice, 0, to);
        assertEq(exec.lastAccruedBlock(alice), to);
        assertEq(park.pending(alice), 0);
    }

    // ── rule and link gates ──────────────────────────────────────────────

    function test_accrue_disabledRule() public {
        vm.prank(alice);
        rules.setRule(1, 1, CAP, false);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.RuleDisabled.selector, alice));
        exec.accrue(alice, alice, 1e6, to);
    }

    /// Turning round-ups OFF and back ON must not let the keeper reach back into
    /// the OFF window: the cursor floor jumps to the block the rule became active.
    function test_accrue_activeSinceBlocksTheDisabledWindow() public {
        uint256 t1 = _pastFinality();
        _accrueAt(alice, alice, 1e6, t1);

        vm.roll(block.number + 100);
        vm.prank(alice);
        rules.setRule(1, 1, CAP, false); // OFF
        uint256 offAt = vm.getBlockNumber(); // via-ir may re-read block.number after a roll
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.RuleDisabled.selector, alice));
        exec.accrue(alice, alice, 1e6, to);

        vm.roll(block.number + 50_000); // payments made while OFF
        vm.prank(alice);
        rules.setRule(1, 1, CAP, true); // back ON
        uint256 onAt = vm.getBlockNumber();
        assertEq(rules.activeSince(alice), onAt);
        assertGt(onAt, t1);

        uint256 head = _pastFinality();
        // A range ending inside the OFF window is refused outright ...
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, onAt, offAt + 10));
        exec.accrue(alice, alice, 1e6, offAt + 10);
        // ... and one that spans it starts at the re-enable block, not the old cursor.
        vm.expectEmit(true, true, false, true, address(exec));
        emit Accrued(alice, alice, 2e6, onAt, head);
        _accrueAt(alice, alice, 2e6, head);
        assertEq(park.pending(alice), 3e6);
    }

    /// Re-enabling via the cap (0 -> non-zero) is also a fresh consent point.
    function test_accrue_activeSinceAlsoMovesWhenTheCapIsRestored() public {
        vm.roll(block.number + 1_000);
        vm.prank(alice);
        rules.setRule(1, 1, 0, true); // cap 0 = OFF
        vm.roll(block.number + 20_000);
        vm.prank(alice);
        rules.setRule(1, 1, CAP, true);
        uint256 onAt = vm.getBlockNumber();
        uint256 to = _pastFinality();
        vm.expectEmit(true, true, false, true, address(exec));
        emit Accrued(alice, alice, 1e6, onAt, to);
        _accrueAt(alice, alice, 1e6, to);
    }

    function test_accrue_noRuleAtAll() public {
        vm.prank(carol);
        rules.linkSelf();
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.RuleDisabled.selector, carol));
        exec.accrue(carol, carol, 1e6, to);
    }

    function test_accrue_unlinkedWallet() public {
        vm.prank(alice);
        rules.unlink(alice);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.NotLinked.selector, alice));
        exec.accrue(alice, alice, 1e6, to);
    }

    function test_accrue_walletOfAnotherAccount() public {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.NotLinked.selector, alice));
        exec.accrue(bob, alice, 1e6, to);
    }

    function test_accrue_amountTooLarge() public {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(SweepExecutor.AmountTooLarge.selector);
        exec.accrue(alice, alice, uint256(type(uint160).max) + 1, to);
    }

    // ── Permit2 bounds ───────────────────────────────────────────────────

    function test_accrue_permit2AllowanceBoundsTheKeeper() public {
        vm.prank(alice);
        permit2.approve(address(usdg), address(exec), 2e6, uint48(block.timestamp + 1 days));
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockPermit2.InsufficientAllowance.selector, 2e6));
        exec.accrue(alice, alice, 3e6, to);
    }

    function test_accrue_permit2ExpiredAllowance() public {
        uint48 exp = uint48(block.timestamp + 1 hours);
        vm.prank(alice);
        permit2.approve(address(usdg), address(exec), 100e6, exp);
        vm.warp(block.timestamp + 2 hours);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockPermit2.AllowanceExpired.selector, exp));
        exec.accrue(alice, alice, 1e6, to);
    }

    // ── batch ────────────────────────────────────────────────────────────

    function test_accrueBatch_creditsEveryEntry() public {
        uint256 to = _pastFinality();
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](2);
        b[0] = SweepExecutor.Accrual(alice, alice, 2e6, to);
        b[1] = SweepExecutor.Accrual(bob, bob, 3e6, to);
        vm.prank(keeper);
        assertEq(exec.accrueBatch(b), 2);
        assertEq(park.pending(alice), 2e6);
        assertEq(park.pending(bob), 3e6);
    }

    function test_accrueBatch_onlyKeeperAndPausable() public {
        uint256 to = _pastFinality();
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](1);
        b[0] = SweepExecutor.Accrual(alice, alice, 2e6, to);
        vm.prank(stranger);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.accrueBatch(b);
        vm.prank(owner);
        exec.pause();
        vm.prank(keeper);
        vm.expectRevert(SpareAuth.IsPaused.selector);
        exec.accrueBatch(b);
    }

    /// accrueSelf is only the per-entry hop inside accrueBatch: nobody else (not
    /// even the keeper or the owner) can call it to bypass onlyKeeper / pause.
    function test_accrueSelf_onlyFromTheExecutorItself() public {
        uint256 to = _pastFinality();
        address[3] memory callers = [stranger, keeper, owner];
        for (uint256 i; i < 3; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SweepExecutor.NotSelf.selector);
            exec.accrueSelf(alice, alice, 1e6, to);
        }
        assertEq(park.pending(alice), 0);
        assertEq(exec.lastAccruedBlock(alice), 0);
    }

    function test_accrueBatch_tooLarge() public {
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](65);
        vm.prank(keeper);
        vm.expectRevert(SweepExecutor.BatchTooLarge.selector);
        exec.accrueBatch(b);
    }

    /// One bad entry no longer reverts everyone else's accrual: it is skipped with
    /// an AccrualSkipped notice carrying the revert reason, and the rest accrue.
    function test_accrueBatch_skipsBadEntry() public {
        uint256 to = _pastFinality();
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](3);
        b[0] = SweepExecutor.Accrual(alice, alice, 2e6, to);
        b[1] = SweepExecutor.Accrual(bob, carol, 3e6, to); // carol is not bob's wallet
        b[2] = SweepExecutor.Accrual(bob, bob, 4e6, to);
        vm.expectEmit(true, true, false, true, address(exec));
        emit AccrualSkipped(bob, carol, to, abi.encodeWithSelector(SweepExecutor.NotLinked.selector, carol));
        vm.prank(keeper);
        assertEq(exec.accrueBatch(b), 2, "two of three accrued");
        assertEq(park.pending(alice), 2e6);
        assertEq(park.pending(bob), 4e6, "the skipped entry pulled nothing");
        assertEq(exec.lastAccruedBlock(alice), to);
        assertEq(exec.lastAccruedBlock(carol), 0, "the skipped entry's cursor did not move");
        assertEq(usdg.balanceOf(address(exec)), 0);
    }

    /// A wallet that revoked its Permit2 allowance is skipped; its cursor stays put
    /// so the range is retried once the allowance is back.
    function test_accrueBatch_revokedPermit2Skipped() public {
        vm.prank(bob);
        permit2.approve(address(usdg), address(exec), 0, 0);
        uint256 to = _pastFinality();
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](2);
        b[0] = SweepExecutor.Accrual(bob, bob, 1e6, to);
        b[1] = SweepExecutor.Accrual(alice, alice, 1e6, to);
        vm.expectEmit(true, true, false, true, address(exec));
        emit AccrualSkipped(bob, bob, to, abi.encodeWithSelector(MockPermit2.InsufficientAllowance.selector, 0));
        vm.prank(keeper);
        assertEq(exec.accrueBatch(b), 1);
        assertEq(park.pending(alice), 1e6);
        assertEq(park.pending(bob), 0);
        assertEq(exec.lastAccruedBlock(bob), 0);
        assertEq(exec.pulledLast7Days(bob), 0, "no cap consumed by a skipped entry");
    }

    function test_accrueBatch_sequentialRangesForOneWallet() public {
        vm.roll(block.number + 10_000); // both ranges must sit after alice's link block
        uint256 t2 = _pastFinality();
        uint256 t1 = t2 - 1_000;
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](2);
        b[0] = SweepExecutor.Accrual(alice, alice, 1e6, t1);
        b[1] = SweepExecutor.Accrual(alice, alice, 2e6, t2);
        vm.prank(keeper);
        exec.accrueBatch(b);
        assertEq(park.pending(alice), 3e6);

        uint256 t3 = _pastFinality();
        b[0] = SweepExecutor.Accrual(alice, alice, 1e6, t3);
        b[1] = SweepExecutor.Accrual(alice, alice, 1e6, t3);
        vm.expectEmit(true, true, false, true, address(exec));
        emit AccrualSkipped(
            alice, alice, t3, abi.encodeWithSelector(SweepExecutor.CursorNotAdvancing.selector, t3, t3)
        );
        vm.prank(keeper);
        assertEq(exec.accrueBatch(b), 1, "the repeated range is skipped");
        assertEq(park.pending(alice), 4e6);
    }

    function test_accrueBatch_capIsCumulative() public {
        uint256 t2 = _pastFinality();
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](2);
        b[0] = SweepExecutor.Accrual(alice, alice, 30e6, t2 - 1);
        b[1] = SweepExecutor.Accrual(alice, alice, 21e6, t2);
        vm.expectEmit(true, true, false, true, address(exec));
        emit AccrualSkipped(
            alice, alice, t2, abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 51e6, CAP)
        );
        vm.prank(keeper);
        assertEq(exec.accrueBatch(b), 1);
        assertEq(park.pending(alice), 30e6, "the cap counted the earlier entry of the same batch");
        assertEq(exec.lastAccruedBlock(alice), t2 - 1);
    }

    // ── fuzz: the cap is never exceeded inside the rolling window ────────

    /// Eight accruals spread over up to 7 UTC days (one window), with calendar-week
    /// boundaries free to fall anywhere in between: never more than the cap.
    function testFuzz_accrue_neverExceedsCapInTheWindow(uint32[8] memory amounts, uint32[8] memory gaps) public {
        uint256 start = usdg.balanceOf(alice);
        uint256 t0 = vm.getBlockTimestamp();
        for (uint256 i; i < 8; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 19 hours));
            uint256 a = bound(amounts[i], 0, 30e6);
            uint256 to = _pastFinality();
            vm.prank(keeper);
            try exec.accrue(alice, alice, a, to) {} catch {}
        }
        assertLe(vm.getBlockTimestamp() / 1 days - t0 / 1 days, 6, "all inside one 7-day window");
        assertLe(start - usdg.balanceOf(alice), CAP);
        assertEq(start - usdg.balanceOf(alice), exec.pulledLast7Days(alice));
    }

    // ── params ───────────────────────────────────────────────────────────

    function test_setParams_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(SweepExecutor.BadParam.selector);
        exec.setParams(3_000, 5e6, 101, 100, 1 days); // fee > 1%
        vm.expectRevert(SweepExecutor.BadParam.selector);
        exec.setParams(3_000, 5e6, 25, 501, 1 days); // slippage > 5%
        vm.expectRevert(SweepExecutor.BadParam.selector);
        exec.setParams(3_000, 999_999, 25, 100, 1 days); // threshold < $1
        vm.expectRevert(SweepExecutor.BadParam.selector);
        exec.setParams(3_000, 5e6, 25, 100, 1 hours - 1); // epoch < 1h
        exec.setParams(6_000, 10e6, 50, 200, 12 hours);
        vm.stopPrank();
        assertEq(exec.finalityBuffer(), 6_000);
        assertEq(exec.threshold(), 10e6);
        assertEq(exec.feeBps(), 50);
        assertEq(exec.slippageBps(), 200);
        assertEq(exec.epochLength(), 12 hours);
    }

    function test_setParams_onlyOwner() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        exec.setParams(3_000, 5e6, 25, 100, 1 days);
    }

    function test_defaultsMatchTheSpec() public view {
        assertEq(exec.threshold(), 5_000_000, "$5 threshold");
        assertEq(exec.feeBps(), 25, "0.25% conversion fee");
        assertEq(exec.epochLength(), 1 days);
    }
}
