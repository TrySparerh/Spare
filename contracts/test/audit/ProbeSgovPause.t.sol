// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStockToken} from "../../src/interfaces/IExternal.sol";

/// @notice Exploratory: locate the real stock-token pause flag on the fork and
///         confirm that a paused token refuses transfers. Used by AuditFunds.t.sol.
contract ProbeSgovPauseTest is Test {
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;

    function test_probePauseLayout() public {
        uint256 blk = vm.envOr("AUDIT_FORK_BLOCK", uint256(0));
        if (blk == 0) {
            vm.skip(true); // opt-in: needs a recent block (public RPC is not archive)
            return;
        }
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), blk);
        vm.record();
        bool p = IStockToken(SGOV).paused();
        (bytes32[] memory reads,) = vm.accesses(SGOV);
        console2.log("paused()", p);
        for (uint256 i; i < reads.length; ++i) {
            console2.logBytes32(reads[i]);
            console2.logBytes32(vm.load(SGOV, reads[i]));
        }
        address holder = makeAddr("holder");
        deal(SGOV, holder, 1e18);
        // the slot paused() reads (found via vm.accesses above)
        bytes32 slot = 0x8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc01;
        vm.store(SGOV, slot, bytes32(uint256(1)));
        console2.log("paused() after store", IStockToken(SGOV).paused());
        vm.prank(holder);
        (bool ok, bytes memory ret) = SGOV.call(abi.encodeCall(IERC20.transfer, (address(0xBEEF), 1)));
        console2.log("transfer ok while paused", ok);
        console2.logBytes(ret);
    }
}
