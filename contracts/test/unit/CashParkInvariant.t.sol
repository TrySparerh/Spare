// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CashPark} from "../../src/CashPark.sol";
import {MockParkAdapter} from "../mocks/MockParkAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Drives CashPark through random credit / park / withdraw / return / exit
///         sequences with NAV freshness, redeemability, in-kind movability and
///         pause flipping. Counts any exit() that reverts (law 5: none may).
contract CashParkHandler is Test {
    CashPark public immutable cp;
    MockParkAdapter public immutable ad;
    MockERC20 public immutable usdg;
    address public immutable exe;
    address public immutable keeper;
    address public immutable owner;
    address[4] public actors;
    uint256 public exitReverts;

    constructor(
        CashPark cp_,
        MockParkAdapter ad_,
        MockERC20 usdg_,
        address exe_,
        address keeper_,
        address owner_,
        address[4] memory actors_
    ) {
        cp = cp_;
        ad = ad_;
        usdg = usdg_;
        exe = exe_;
        keeper = keeper_;
        owner = owner_;
        actors = actors_;
    }

    function _batch(uint256 seed, uint256 n) internal view returns (address[] memory b) {
        b = new address[](bound(n, 0, 6));
        for (uint256 i; i < b.length; ++i) {
            b[i] = actors[(seed >> (i * 8)) % 4];
        }
    }

    function credit(uint256 s, uint256 amt) external {
        amt = bound(amt, 0, 1_000e6);
        usdg.mint(exe, amt);
        vm.prank(exe);
        cp.credit(actors[s % 4], amt);
    }

    function park(uint256 seed, uint256 n) external {
        if (cp.paused()) return;
        address[] memory b = _batch(seed, n);
        vm.prank(keeper);
        cp.park(b);
    }

    function withdrawForSweep(uint256 s) external {
        vm.prank(exe);
        cp.withdrawForSweep(actors[s % 4]);
    }

    function returnFromSweep(uint256 s, uint256 amt) external {
        amt = bound(amt, 0, usdg.balanceOf(exe));
        vm.prank(exe);
        cp.returnFromSweep(actors[s % 4], amt);
    }

    function exit(uint256 s) external {
        address a = actors[s % 4];
        vm.prank(a);
        try cp.exit() {}
        catch {
            exitReverts++;
        }
    }

    function setFresh(bool f) external {
        ad.setFresh(f);
    }

    function setRedeemDown(bool d) external {
        ad.setRedeemReverts(d);
    }

    /// The underlying itself cannot move (paused issuer token): exit then pays the
    /// pending USDG and keeps the units booked.
    function setInKindDown(bool d) external {
        ad.setExitInKindReverts(d);
    }

    function setPaused(bool p) external {
        vm.prank(owner);
        if (p) cp.pause();
        else cp.unpause();
    }
}

/// @notice CashPark invariants: totalPending == sum(pending), USDG backs pending,
///         units are conserved and backed by the adapter.
contract CashParkInvariantTest is UnitBase {
    CashPark internal cp;
    MockParkAdapter internal ad;
    CashParkHandler internal h;
    address internal exe = makeAddr("executor");

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        cp = new CashPark(owner, IERC20(address(usdg)));
        ad = new MockParkAdapter(address(usdg), address(cp));
        cp.setAdapter(ad);
        cp.setExecutor(exe);
        cp.setKeeper(keeper, true);
        vm.stopPrank();
        ad.setRate(3e12, 7); // non-integral units per USDG: exercises every floor
        vm.prank(exe);
        usdg.approve(address(cp), type(uint256).max);

        h = new CashParkHandler(cp, ad, usdg, exe, keeper, owner, [alice, bob, carol, dave]);
        targetContract(address(h));
    }

    function invariant_totalPendingIsSumOfPending() public view {
        uint256 sum = cp.pending(alice) + cp.pending(bob) + cp.pending(carol) + cp.pending(dave);
        assertEq(cp.totalPending(), sum);
    }

    function invariant_usdgBacksPending() public view {
        assertGe(usdg.balanceOf(address(cp)), cp.totalPending());
    }

    function invariant_unitsConserved() public view {
        uint256 sum = cp.units(alice) + cp.units(bob) + cp.units(carol) + cp.units(dave);
        assertEq(cp.totalUnits(), sum);
        assertEq(ad.share().balanceOf(address(ad)), cp.totalUnits(), "every unit is held by the adapter");
    }

    /// Law 5: exit is never gated, whatever the adapter or pause state.
    function invariant_exitNeverReverts() public view {
        assertEq(h.exitReverts(), 0);
    }

    function invariant_adapterSolvent() public view {
        assertGe(usdg.balanceOf(address(ad)), ad.valueOf(cp.totalUnits()));
    }
}
