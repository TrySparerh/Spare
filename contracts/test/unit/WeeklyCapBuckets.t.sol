// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Audit A-L1 (accepted, documented): the "rolling 7-day" weekly cap is
///         7 UTC-day BUCKETS (today + the 6 before), not a 168-hour window. A full
///         cap pulled in the last second of day D frees up at 00:00 of day D+7, so
///         2x weeklyCap can leave a wallet within 6 days and 1 second — and never
///         more than 2x in any true 168 hours. Only the keeper can trigger it, it
///         stays inside the user's own Permit2 allowance, and the USDG lands in the
///         user's own park. The contracts are immutable; this pins the bound.
contract WeeklyCapBucketsTest is UnitBase {
    uint64 internal constant CAP = 50e6;
    uint256 internal constant FUND = 1_000e6;

    function setUp() public override {
        super.setUp();
        _onboard(alice, FUND, CAP);
    }

    function _pulled() internal view returns (uint256) {
        return FUND - usdg.balanceOf(alice);
    }

    function _tryAccrue(uint256 amount) internal returns (bool ok) {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        try exec.accrue(alice, alice, amount, to) {
            ok = true;
        } catch {}
    }

    /// The exact worst case: the cap in the last second of day D, and the cap
    /// again at the first second of day D+7 — 6 days and 1 second apart.
    function test_AL1_twoFullCapsWithinSixDaysAndOneSecond() public {
        uint256 dayD = vm.getBlockTimestamp() / 1 days + 1;
        uint256 first = (dayD + 1) * 1 days - 1; // 23:59:59 on day D
        uint256 second = (dayD + 7) * 1 days; // 00:00:00 on day D+7

        vm.warp(first);
        _accrue(alice, CAP);

        // One second before day D+7, day D is still inside the 7 buckets.
        vm.warp(second - 1);
        uint256 to = _pastFinality();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, uint256(CAP) + 1, CAP));
        exec.accrue(alice, alice, 1, to);
        assertEq(exec.remainingWeeklyCap(alice), 0);

        vm.warp(second);
        assertEq(exec.pulledLast7Days(alice), 0, "day D has left the window");
        assertEq(exec.remainingWeeklyCap(alice), CAP);
        _accrue(alice, CAP);

        assertEq(second - first, 6 days + 1 seconds);
        assertEq(_pulled(), 2 * uint256(CAP), "2x weeklyCap inside 6 days and 1 second");
        assertEq(park.valueOf(alice), 2 * uint256(CAP), "all of it in the user's own park");
    }

    /// The same pull made at 00:00 of day D (the bucket's first second) is held
    /// for the full 7 days: the overshoot depends only on where in its day the
    /// first pull falls.
    function test_AL1_aPullAtTheStartOfItsDayHoldsTheFullSevenDays() public {
        uint256 dayD = vm.getBlockTimestamp() / 1 days + 1;
        vm.warp(dayD * 1 days);
        _accrue(alice, CAP);

        vm.warp((dayD + 7) * 1 days - 1); // 6 days 23:59:59 later
        assertFalse(_tryAccrue(1), "still inside the window");
        vm.warp((dayD + 7) * 1 days);
        assertTrue(_tryAccrue(CAP));
        assertEq(_pulled(), 2 * uint256(CAP));
    }

    /// The accepted bound, under fuzzing: pulls of any size at any spacing over
    /// ~3 weeks. Any 7 consecutive UTC-day buckets hold at most weeklyCap (what
    /// the code enforces), so any true 168-hour span — which touches at most 8
    /// buckets — holds at most 2x weeklyCap.
    function testFuzz_AL1_neverMoreThanTwoCapsInAnyRolling168Hours(uint32[16] memory gaps, uint32[16] memory amounts)
        public
    {
        uint256[16] memory at;
        uint256[16] memory amt;
        uint256 n;
        for (uint256 i; i < 16; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 36 hours));
            uint256 a = bound(amounts[i], 1, CAP);
            if (!_tryAccrue(a)) continue;
            at[n] = vm.getBlockTimestamp();
            amt[n] = a;
            ++n;
        }
        for (uint256 i; i < n; ++i) {
            uint256 inSpan;
            uint256 inBuckets;
            for (uint256 j; j <= i; ++j) {
                if (at[i] - at[j] < 7 days) inSpan += amt[j];
                if (at[i] / 1 days - at[j] / 1 days < 7) inBuckets += amt[j];
            }
            assertLe(inBuckets, CAP, "7 day-buckets never exceed weeklyCap");
            assertLe(inSpan, 2 * uint256(CAP), "168 hours never exceed 2x weeklyCap");
        }
        assertEq(_pulled(), park.valueOf(alice), "every pulled dollar is in the user's own park");
    }
}
