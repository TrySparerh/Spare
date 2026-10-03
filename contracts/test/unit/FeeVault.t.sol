// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice FeeVault: the conversion fee lands here from converted legs only, and
///         only the owner moves it out — any token, never to address(0), with a
///         two-step ownership handover and no pause gate on the way out.
contract FeeVaultTest is UnitBase {
    address internal treasury = makeAddr("treasury");

    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    function _withdraw(address token, address to, uint256 amount) internal {
        vm.prank(owner);
        vault.withdraw(IERC20(token), to, amount);
    }

    function test_constructor_ownerIsTheDeployersChoice() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), address(0));
        assertFalse(vault.paused());
    }

    function test_withdraw_movesTheTokenAndEmits() public {
        usdg.mint(address(vault), 10e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Withdrawn(address(usdg), treasury, 4e6);
        _withdraw(address(usdg), treasury, 4e6);
        assertEq(usdg.balanceOf(treasury), 4e6);
        assertEq(usdg.balanceOf(address(vault)), 6e6);
    }

    function test_withdraw_anyTokenTheVaultHolds() public {
        spy.mint(address(vault), 3e18);
        _withdraw(address(spy), treasury, 3e18);
        assertEq(spy.balanceOf(treasury), 3e18);
        assertEq(spy.balanceOf(address(vault)), 0);
    }

    function test_withdraw_onlyOwner() public {
        usdg.mint(address(vault), 1e6);
        address[3] memory notOwner = [stranger, keeper, attestor];
        for (uint256 i; i < notOwner.length; ++i) {
            vm.prank(notOwner[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, notOwner[i]));
            vault.withdraw(IERC20(address(usdg)), notOwner[i], 1e6);
        }
        assertEq(usdg.balanceOf(address(vault)), 1e6);
    }

    function test_withdraw_zeroRecipientReverts() public {
        usdg.mint(address(vault), 1e6);
        vm.prank(owner);
        vm.expectRevert(SpareAuth.ZeroAddress.selector);
        vault.withdraw(IERC20(address(usdg)), address(0), 1e6);
    }

    function test_withdraw_moreThanHeldReverts() public {
        usdg.mint(address(vault), 1e6);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 1e6, 1e6 + 1)
        );
        vault.withdraw(IERC20(address(usdg)), treasury, 1e6 + 1);
    }

    /// SafeERC20: a token that refuses the transfer reverts the withdraw instead
    /// of silently reporting success.
    function test_withdraw_aRefusedTransferReverts() public {
        usdg.mint(address(vault), 1e6);
        usdg.setBlocked(treasury, true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.Blocked.selector, treasury));
        vault.withdraw(IERC20(address(usdg)), treasury, 1e6);
    }

    /// Pause stops new activity; it never traps collected fees.
    function test_withdraw_worksWhilePaused() public {
        usdg.mint(address(vault), 1e6);
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());
        _withdraw(address(usdg), treasury, 1e6);
        assertEq(usdg.balanceOf(treasury), 1e6);
    }

    /// End to end: a sweep's converted legs pay 25 bps into the vault, and the
    /// owner withdraws exactly that.
    function test_feesFromASweepAreWithdrawable() public {
        _onboard(alice, 100e6, 100e6);
        _accrue(alice, 10e6);
        assertEq(_sweep(_one(alice)), 1);
        uint256 fees = (6e6 * 25) / 10_000 + (4e6 * 25) / 10_000;
        assertEq(usdg.balanceOf(address(vault)), fees);
        _withdraw(address(usdg), treasury, fees);
        assertEq(usdg.balanceOf(treasury), fees);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    /// Ownable2Step: the old owner keeps the power until the new one accepts.
    function test_ownership_handoverIsTwoStep() public {
        address next = makeAddr("next-owner");
        usdg.mint(address(vault), 2e6);
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.pendingOwner(), next);

        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, next));
        vault.withdraw(IERC20(address(usdg)), next, 1e6);
        _withdraw(address(usdg), treasury, 1e6);

        vm.prank(next);
        vault.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vault.withdraw(IERC20(address(usdg)), owner, 1e6);
        vm.prank(next);
        vault.withdraw(IERC20(address(usdg)), next, 1e6);
        assertEq(usdg.balanceOf(next), 1e6);
    }
}
