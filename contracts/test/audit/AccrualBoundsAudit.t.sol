// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {RoundUp} from "../../src/libraries/RoundUp.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {AuditBase} from "./AuditBase.sol";

/// @notice AUDIT: the on-chain bounds on what the keeper path can pull (spec §3.1).
contract AccrualBoundsAudit is AuditBase {
    address alice = makeAddr("alice");

    function _accrueFrom(address account, address wallet, uint256 amount) internal {
        uint256 buf = exec.finalityBuffer();
        vm.roll(block.number + buf + 10);
        uint256 to = block.number - buf - 1;
        vm.prank(keeper);
        exec.accrue(account, wallet, amount, to);
    }

    /// REGRESSION. Spec §3.1 promises a ROLLING 7-day cap; the code used to reset on
    /// the UTC calendar week, so 2x the cap could be pulled within two minutes.
    function test_weeklyCap_isRollingNotCalendar() public {
        _onboard(alice, 200e6);
        vm.prank(alice);
        rules.setRule(1, 1, 50e6, true);

        uint256 boundary = (vm.getBlockTimestamp() / 1 weeks + 1) * 1 weeks;
        vm.warp(boundary - 60);
        _accrueFrom(alice, alice, 50e6);
        vm.warp(boundary + 60);
        uint256 buf = exec.finalityBuffer();
        vm.roll(block.number + buf + 10);
        uint256 to = block.number - buf - 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SweepExecutor.WeeklyCapExceeded.selector, 100e6, 50e6));
        exec.accrue(alice, alice, 50e6, to);
        assertEq(park.valueOf(alice), 50e6, "only one weekly cap across the calendar boundary");
        assertEq(exec.remainingWeeklyCap(alice), 0);
    }

    /// OPEN — not addressed by the fixes (kept as a live repro, see the report).
    /// The wallet's link signature commits to (account, wallet, nonce, deadline) only.
    /// The ACCOUNT alone sets roundTo / multiplier / weeklyCap afterwards, and those
    /// govern what is pulled from the WALLET.
    function test_accountRepricesLinkedWallet() public {
        (address wallet, uint256 pk) = makeAddrAndKey("wallet");
        address account = makeAddr("account");
        deal(USDG, wallet, 1_000e6);
        vm.startPrank(wallet);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        // Onboarding grants a non-decrementing Permit2 allowance (type(uint160).max).
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), type(uint160).max, uint48(block.timestamp + 365 days));
        vm.stopPrank();

        // Account starts with a gentle rule ($1, 1x, $50/wk) and gets the wallet's signature.
        vm.prank(account);
        rules.setRule(1, 1, 50e6, true);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 structHash = keccak256(abi.encode(rules.LINK_TYPEHASH(), account, wallet, rules.nonces(wallet), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", rules.domainSeparator(), structHash)));
        vm.prank(account);
        rules.linkWallet(wallet, deadline, abi.encodePacked(r, s, v));

        // After linking, the account alone switches to $10 / 5x / unlimited.
        vm.prank(account);
        rules.setRule(10, 5, type(uint64).max, true);

        // An honest keeper applies the on-chain rule to a 1-cent payment by the wallet.
        uint256 d = RoundUp.delta(10_000, 10, 5);
        assertEq(d, 49_950_000, "1 cent payment -> $49.95 round-up");
        for (uint256 i; i < 20; ++i) _accrueFrom(account, wallet, d);
        assertEq(IERC20(USDG).balanceOf(wallet), 1_000e6 - 20 * d, "~$999 pulled from the wallet for 20 cents of payments");

        // ... and the account can take it out immediately.
        vm.prank(account);
        park.exit();
        assertEq(IERC20(USDG).balanceOf(account), 20 * d);
    }
}
