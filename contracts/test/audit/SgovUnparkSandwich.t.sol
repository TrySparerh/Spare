// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Vm} from "forge-std/Vm.sol";
import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {AuditBase, RawSwapper} from "./AuditBase.sol";

/// @notice Attacker holding SGOV inventory: sell SGOV, trigger the sweep (which
///         un-parks every swept account's SGOV through the same pool), buy the SGOV
///         back — one transaction. Worked while sweep() was permissionless.
contract UnparkSandwicher is RawSwapper {
    constructor(IPoolManager pm_) RawSwapper(pm_) {}

    function attack(PoolKey memory key, address sgov, uint256 sgovFront, SweepExecutor exec, address[] memory accts)
        external
        returns (int256 sgovProfit)
    {
        uint256 s0 = IERC20(sgov).balanceOf(address(this));
        // key is USDG(c0)/SGOV(c1): SGOV -> USDG is oneForZero.
        uint256 usdgGot = swapExactIn(key, false, sgovFront);
        exec.sweep(accts, new SweepExecutor.Limit[](0));
        swapExactIn(key, true, usdgGot);
        sgovProfit = int256(IERC20(sgov).balanceOf(address(this))) - int256(s0);
    }
}

/// @notice REGRESSION (was the AUDIT repro "atomic SGOV un-park sandwich"). The
///         attacker can no longer trigger the sweep, so the atomic un-park sandwich
///         reverts and nothing is un-parked. The keeper's own sweep realises the
///         parked SGOV within the adapter's 1% slippage of NAV.
/// @dev The un-park sell itself is bounded by the adapter's oracle slippage and the
///      router band only — the keeper's quote limits cover the BUY legs, not this
///      sell (see the report).
contract SgovUnparkSandwichTest is AuditBase {
    address alice = makeAddr("alice");
    UnparkSandwicher attacker;

    function setUp() public override {
        super.setUp();
        attacker = new UnparkSandwicher(IPoolManager(POOL_MANAGER));
        vm.startPrank(owner);
        SgovParkAdapter sg = new SgovParkAdapter(USDG, SGOV, address(park), router, 100);
        router.setCaller(address(sg), true);
        park.setAdapter(sg);
        vm.stopPrank();
    }

    function test_unparkSandwich_attackerCannotTriggerSweep() public {
        uint256 v = 1_000e6;
        _onboard(alice, v);
        _setMix(alice, SPY);
        _accrue(alice, v);
        vm.prank(keeper);
        park.park(_one(alice));
        uint256 units = park.units(alice);
        assertGt(units, 0);

        deal(SGOV, address(attacker), 1_000e18);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        attacker.attack(sgovKey(), SGOV, 1_000e18, exec, _one(alice));
        assertEq(park.units(alice), units, "nothing un-parked");

        (, uint256 price) = router.oracleStatus(SGOV);
        uint256 fairUsdg = router.oracleUsdgFor(units, price);
        vm.recordLogs();
        assertEq(_keeperSweep(_one(alice)), 1);
        uint256 got = _sweptAmount();
        assertEq(park.units(alice), 0, "un-parked by the keeper's sweep");
        assertGe(got, (fairUsdg * 9_900) / 10_000, "realised within the adapter's 1% of NAV");
        emit log_named_decimal_uint("fair value at SGOV oracle (USDG)", fairUsdg, 6);
        emit log_named_decimal_uint("un-park realised by the keeper sweep (USDG)", got, 6);
    }

    /// @dev usdg amount from the AccountSwept event (topic0, then data = epoch, usdg).
    function _sweptAmount() internal returns (uint256 amt) {
        bytes32 sig = keccak256("AccountSwept(address,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(exec) && logs[i].topics[0] == sig) {
                (, amt) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }
}
