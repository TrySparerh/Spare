// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {AuditBase} from "./AuditBase.sol";

interface INvdaHook {
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function setPaused(bool) external;
}

/// @notice REGRESSION (was the AUDIT repro "hook owner pause forces safe-settle").
///         The allowlisted NVDA pool's hook is controlled by a single EOA. A
///         hook-side pause makes the swap revert while the oracle says OK. That
///         used to safe-settle every NVDA leg to USDG (and burn the epoch); now a
///         reverted swap DEFERS — the USDG goes back to the park and converts on a
///         later epoch once the pool is live again.
contract HookControlAudit is AuditBase {
    address alice = makeAddr("alice");

    function test_hookOwnerPause_defersNotSafeSettles() public {
        address hookOwner = INvdaHook(NVDA_HOOK).owner();
        emit log_named_address("NVDA hook owner", hookOwner);
        emit log_named_uint("hook owner code size (0 = EOA)", hookOwner.code.length);

        // Short epochs so the retry can run while the feeds are still fresh.
        uint256 fb = exec.finalityBuffer();
        uint256 th = exec.threshold();
        uint16 fee = exec.feeBps();
        uint16 slip = exec.slippageBps();
        vm.prank(owner);
        exec.setParams(fb, th, fee, slip, 1 hours);

        _onboard(alice, 100e6);
        _setMix(alice, NVDA);
        _accrue(alice, 10e6);

        vm.prank(hookOwner);
        INvdaHook(NVDA_HOOK).setPaused(true);
        assertTrue(INvdaHook(NVDA_HOOK).paused());
        (OracleGuard.Status st,) = router.oracleStatus(NVDA);
        assertEq(uint8(st), uint8(OracleGuard.Status.OK), "oracle says go");

        uint256 before = IERC20(USDG).balanceOf(alice);
        assertEq(_keeperSweep(_one(alice)), 1);
        assertEq(IERC20(NVDA).balanceOf(alice), 0, "no NVDA while the hook is paused");
        assertEq(IERC20(USDG).balanceOf(alice), before, "nothing paid out as USDG");
        assertEq(park.pending(alice), 10e6, "the whole leg deferred back to the park");
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "no fee");

        // The hook owner unpauses; the next epoch converts the deferred USDG.
        vm.prank(hookOwner);
        INvdaHook(NVDA_HOOK).setPaused(false);
        vm.warp(block.timestamp + 1 hours);
        assertEq(_keeperSweep(_one(alice)), 1);
        assertGt(IERC20(NVDA).balanceOf(alice), 0, "retried and bought");
        assertEq(park.valueOf(alice), 0);
        emit log_named_decimal_uint("alice NVDA after retry", IERC20(NVDA).balanceOf(alice), 18);
    }
}
