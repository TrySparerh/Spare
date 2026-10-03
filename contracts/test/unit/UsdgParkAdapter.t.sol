// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UsdgParkAdapter} from "../../src/park/UsdgParkAdapter.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice UsdgParkAdapter, the LIVE park: 1 unit = 1 USDG base unit, always
///         fresh, no market or oracle anywhere, and only CashPark can move value.
contract UsdgParkAdapterTest is UnitBase {
    function test_wiring() public view {
        assertEq(usdgAdapter.usdg(), address(usdg));
        assertEq(usdgAdapter.park(), address(park));
        assertEq(usdgAdapter.underlying(), address(usdg), "in kind is USDG itself");
        assertEq(address(park.adapter()), address(usdgAdapter));
    }

    function test_onlyPark_guardsEveryEntryThatMovesValue() public {
        usdg.mint(address(usdgAdapter), 5e6);
        vm.startPrank(stranger);
        vm.expectRevert(UsdgParkAdapter.NotPark.selector);
        usdgAdapter.deposit(1e6);
        vm.expectRevert(UsdgParkAdapter.NotPark.selector);
        usdgAdapter.redeem(1e6, stranger);
        vm.expectRevert(UsdgParkAdapter.NotPark.selector);
        usdgAdapter.exitInKind(1e6, stranger);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(usdgAdapter)), 5e6);
    }

    function test_unitsAreUsdgOneForOne() public {
        usdg.mint(address(usdgAdapter), 7e6);
        vm.startPrank(address(park));
        assertEq(usdgAdapter.deposit(7e6), 7e6);
        assertEq(usdgAdapter.redeem(3e6, alice), 3e6);
        usdgAdapter.exitInKind(4e6, bob);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice), 3e6);
        assertEq(usdg.balanceOf(bob), 4e6);
        assertEq(usdg.balanceOf(address(usdgAdapter)), 0);
    }

    function testFuzz_valueIsUnitsAndAlwaysFresh(uint256 units, uint256 warp) public {
        vm.warp(vm.getBlockTimestamp() + bound(warp, 0, 3650 days));
        assertEq(usdgAdapter.valueOf(units), units);
        assertTrue(usdgAdapter.isFresh(), "no feed, never stale");
    }
}
