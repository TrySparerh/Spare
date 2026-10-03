// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RoundUp} from "spare/libraries/RoundUp.sol";

contract RoundUpCaller {
    function delta(uint256 amount, uint8 roundTo, uint8 multiplier) external pure returns (uint256) {
        return RoundUp.delta(amount, roundTo, multiplier);
    }
}

/// @notice Symbolic specs for RoundUp.delta (SPARE-BUILD.md §3.3), proved for
///         EVERY uint256 payment and every multiplier 1..5, one boundary
///         (roundTo = 1, 5, 10) per check so the modulus is a constant.
/// @dev `test/unit/RoundUp.t.sol` fuzzes the same properties; these hold them
///      for the whole input space. Run from contracts/:
///      halmos --root halmos --contract RoundUpSpec
contract RoundUpSpec is Test {
    uint256 internal constant ONE_DOLLAR = 1e6;

    RoundUpCaller internal caller;

    function setUp() public {
        caller = new RoundUpCaller();
    }

    /// @dev Every property of one (roundTo, multiplier) rule at one payment.
    function _holds(uint256 amount, uint8 roundTo, uint8 multiplier) internal pure {
        uint256 step = uint256(roundTo) * ONE_DOLLAR;
        uint256 d = RoundUp.delta(amount, roundTo, multiplier);
        uint256 rem = amount % step;
        // Bounded: strictly less than roundTo x multiplier dollars.
        assert(d < step * multiplier);
        // Zero exactly on the boundary, and only there.
        assert((d == 0) == (rem == 0));
        // A whole multiple of the multiplier: the 1x round-up, scaled.
        assert(d % multiplier == 0);
        // The 1x round-up lands the payment exactly on the next boundary.
        if (d != 0) assert(rem + d / multiplier == step);
    }

    function check_roundTo1(uint256 amount, uint8 multiplier) public pure {
        vm.assume(multiplier >= 1 && multiplier <= 5);
        _holds(amount, 1, multiplier);
    }

    function check_roundTo5(uint256 amount, uint8 multiplier) public pure {
        vm.assume(multiplier >= 1 && multiplier <= 5);
        _holds(amount, 5, multiplier);
    }

    function check_roundTo10(uint256 amount, uint8 multiplier) public pure {
        vm.assume(multiplier >= 1 && multiplier <= 5);
        _holds(amount, 10, multiplier);
    }

    /// Any roundTo outside {1, 5, 10} reverts, whatever the other inputs.
    function check_badRoundToAlwaysReverts(uint256 amount, uint8 roundTo, uint8 multiplier) public view {
        vm.assume(roundTo != 1 && roundTo != 5 && roundTo != 10);
        try caller.delta(amount, roundTo, multiplier) returns (uint256) {
            assert(false);
        } catch (bytes memory reason) {
            assert(keccak256(reason) == keccak256(abi.encodeWithSelector(RoundUp.BadRoundTo.selector, roundTo)));
        }
    }

    /// Any multiplier outside 1..5 reverts for a valid roundTo, even at amount 0.
    function check_badMultiplierAlwaysReverts(uint256 amount, uint8 multiplier) public view {
        vm.assume(multiplier == 0 || multiplier > 5);
        try caller.delta(amount, 5, multiplier) returns (uint256) {
            assert(false);
        } catch (bytes memory reason) {
            assert(
                keccak256(reason) == keccak256(abi.encodeWithSelector(RoundUp.BadMultiplier.selector, multiplier))
            );
        }
    }
}
