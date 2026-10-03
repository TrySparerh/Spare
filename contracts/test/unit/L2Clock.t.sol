// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {L2Clock} from "../../src/libraries/L2Clock.sol";
import {MockArbSys} from "../mocks/MockArbSys.sol";
import {MockArbSysSettable} from "../mocks/MockArbSysSettable.sol";

contract L2ClockHarness {
    function blockNumber() external view returns (uint256) {
        return L2Clock.blockNumber();
    }
}

/// @notice L2Clock: reads ArbSys.arbBlockNumber() (the L2 block that equals RPC
///         eth_blockNumber), and falls back to block.number, cheaply, when 0x64 is
///         not a working precompile.
contract L2ClockTest is Test {
    L2ClockHarness h;

    function setUp() public {
        vm.roll(76_000_000);
        h = new L2ClockHarness();
    }

    function test_readsArbSys() public {
        vm.etch(address(0x64), address(new MockArbSysSettable()).code);
        MockArbSysSettable(address(0x64)).set(99_999_999);
        assertEq(h.blockNumber(), 99_999_999);
    }

    function test_mockArbSysMirrorsForkBlock() public {
        vm.etch(address(0x64), address(new MockArbSys()).code);
        assertEq(h.blockNumber(), block.number);
    }

    function test_noCodeFallsBack() public {
        vm.etch(address(0x64), "");
        assertEq(h.blockNumber(), block.number);
    }

    /// Nitro nodes serve 0xfe (INVALID) at 0x64 on a fork. The call is capped, so it
    /// falls back without burning the transaction's gas.
    function test_invalidOpcodeFallsBackCheaply() public {
        vm.etch(address(0x64), hex"fe");
        uint256 g = gasleft();
        uint256 n = h.blockNumber();
        uint256 used = g - gasleft();
        assertEq(n, block.number);
        assertLt(used, 40_000, "INVALID at 0x64 must not eat the caller's gas");
    }

    /// A precompile answer of the wrong shape (no return data) is not trusted.
    function test_shortReturnFallsBack() public {
        vm.etch(address(0x64), hex"00"); // STOP: success, zero bytes returned
        assertEq(h.blockNumber(), block.number);
    }
}
