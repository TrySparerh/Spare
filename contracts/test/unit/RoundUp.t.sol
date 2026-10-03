// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RoundUp} from "../../src/libraries/RoundUp.sol";

contract RoundUpHarness {
    function delta(uint256 amount, uint8 roundTo, uint8 multiplier) external pure returns (uint256) {
        return RoundUp.delta(amount, roundTo, multiplier);
    }
}

/// @notice RoundUp (SPARE-BUILD.md §3.3): delta = (roundTo - amount mod roundTo) x
///         multiplier, and 0 on the boundary. USDG base units, 6 dp.
contract RoundUpTest is Test {
    RoundUpHarness h;

    function setUp() public {
        h = new RoundUpHarness();
    }

    /// Independent reference: next boundary at or above `amount` via ceiling
    /// division, minus the amount. Shares no code path with the library's modulo.
    function _ref(uint256 amount, uint8 roundTo, uint8 multiplier) internal pure returns (uint256) {
        uint256 step = uint256(roundTo) * 1_000_000;
        uint256 next = ((amount + step - 1) / step) * step;
        return (next - amount) * multiplier;
    }

    /// Second reference in the frontend's shape: split into whole dollars and
    /// micro-dollars, round the dollars up to the next multiple of roundTo.
    function _refDollars(uint256 amount, uint8 roundTo, uint8 multiplier) internal pure returns (uint256) {
        uint256 dollars = amount / 1e6;
        uint256 micros = amount % 1e6;
        if (micros == 0 && dollars % roundTo == 0) return 0;
        uint256 targetDollars = micros == 0 ? dollars : dollars + 1;
        if (targetDollars % roundTo != 0) targetDollars += roundTo - (targetDollars % roundTo);
        return (targetDollars * 1e6 - amount) * multiplier;
    }

    // ── acceptance (1) and fixed vectors ─────────────────────────────────

    function test_acceptance1() public view {
        assertEq(h.delta(3_750_000, 1, 1), 250_000, "$3.75 -> $0.25 at 1x");
        assertEq(h.delta(3_750_000, 1, 3), 750_000, "$3.75 -> $0.75 at 3x");
    }

    function test_vectors() public view {
        assertEq(h.delta(0, 1, 1), 0, "zero payment");
        assertEq(h.delta(5_000_000, 1, 1), 0, "on the $1 boundary");
        assertEq(h.delta(5_000_000, 5, 5), 0, "on the $5 boundary");
        assertEq(h.delta(10_000_000, 10, 2), 0, "on the $10 boundary");
        assertEq(h.delta(1, 1, 1), 999_999, "one base unit");
        assertEq(h.delta(999_999, 1, 1), 1);
        assertEq(h.delta(12_400_000, 5, 1), 2_600_000);
        assertEq(h.delta(12_400_000, 10, 1), 7_600_000);
        assertEq(h.delta(12_400_000, 10, 5), 38_000_000);
        assertEq(h.delta(5_000_001, 5, 1), 4_999_999);
    }

    // ── parameter validation ─────────────────────────────────────────────

    function testFuzz_rejectsBadRoundTo(uint8 roundTo, uint256 amount) public {
        vm.assume(roundTo != 1 && roundTo != 5 && roundTo != 10);
        vm.expectRevert(abi.encodeWithSelector(RoundUp.BadRoundTo.selector, roundTo));
        h.delta(amount, roundTo, 1);
    }

    function testFuzz_rejectsBadMultiplier(uint8 m, uint256 amount) public {
        vm.assume(m == 0 || m > 5);
        vm.expectRevert(abi.encodeWithSelector(RoundUp.BadMultiplier.selector, m));
        h.delta(amount, 1, m);
    }

    /// Parameters are validated even for a zero amount (no silent pass-through).
    function test_validatesEvenForZeroAmount() public {
        vm.expectRevert(abi.encodeWithSelector(RoundUp.BadRoundTo.selector, uint8(2)));
        h.delta(0, 2, 1);
    }

    // ── fuzz against the references ──────────────────────────────────────

    function _params(uint8 r, uint8 m) internal pure returns (uint8 roundTo, uint8 multiplier) {
        uint8[3] memory tos = [uint8(1), 5, 10];
        roundTo = tos[r % 3];
        multiplier = uint8(bound(m, 1, 5));
    }

    function testFuzz_matchesReference(uint256 amount, uint8 r, uint8 m) public view {
        amount = bound(amount, 0, type(uint128).max);
        (uint8 roundTo, uint8 multiplier) = _params(r, m);
        uint256 got = h.delta(amount, roundTo, multiplier);
        assertEq(got, _ref(amount, roundTo, multiplier), "ceil reference");
        assertEq(got, _refDollars(amount, roundTo, multiplier), "dollars reference");
    }

    /// Realistic payment sizes ($0 - $100k) exercise the cent-level tail heavily.
    function testFuzz_matchesReferenceRealistic(uint64 amount, uint8 r, uint8 m) public view {
        uint256 a = bound(amount, 0, 100_000e6);
        (uint8 roundTo, uint8 multiplier) = _params(r, m);
        assertEq(h.delta(a, roundTo, multiplier), _ref(a, roundTo, multiplier));
    }

    function testFuzz_properties(uint256 amount, uint8 r, uint8 m) public view {
        amount = bound(amount, 0, type(uint128).max);
        (uint8 roundTo, uint8 multiplier) = _params(r, m);
        uint256 step = uint256(roundTo) * 1e6;
        uint256 d = h.delta(amount, roundTo, multiplier);
        assertEq(d % multiplier, 0, "a whole multiple of the base round-up");
        uint256 base = d / multiplier;
        assertLt(base, step, "never a full increment");
        assertEq((amount + base) % step, 0, "lands exactly on the boundary");
        assertEq(d == 0, amount % step == 0, "zero iff already on the boundary");
        assertEq(d, h.delta(amount, roundTo, 1) * multiplier, "linear in the multiplier");
    }
}
