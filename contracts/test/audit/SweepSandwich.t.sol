// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {AuditBase, SweepSandwicher} from "./AuditBase.sol";

/// @notice REGRESSION (was the AUDIT repro "atomic sandwich of the permissionless
///         sweep"). sweep() used to be permissionless, so an attacker could
///         front-run, trigger the netted sweep and back-run in ONE transaction,
///         bounded only by the oracle minOut (1%) and the router band (1.5%). Now:
///           1. only the keeper can sweep: the atomic attack reverts NotKeeper;
///           2. the keeper passes a limit taken from a same-block quote with a tight
///              tolerance, so a pool push that lands BEFORE the keeper's sweep can
///              move the victim's fill by at most that tolerance — past it, the leg
///              DEFERS and the victim's USDG goes back to the park untouched.
contract SweepSandwichTest is AuditBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// The keeper's tolerance below its own same-block quote.
    uint256 constant QUOTE_TOL_BPS = 30;

    address victim = makeAddr("victim");
    SweepSandwicher attacker;

    function setUp() public override {
        super.setUp();
        attacker = new SweepSandwicher(IPoolManager(POOL_MANAGER), IERC20(USDG));
    }

    struct Result {
        uint256 baseline; // victim tokens, keeper sweep, no attack
        uint256 floor; // swapIn * keeper limit
        uint256 firstDefer; // smallest push on the grid that made the leg defer
        uint256 maxLossBps; // worst victim shortfall vs baseline among filled pushes
    }

    function _run(address asset, PoolKey memory key, uint256 v) internal returns (Result memory r) {
        _onboard(victim, v);
        _setMix(victim, asset);
        _accrue(victim, v);
        uint256 usdg0 = IERC20(USDG).balanceOf(victim);
        uint256 swapIn = v - (v * exec.feeBps()) / 10_000;
        uint256 limit = _quoteLimit(asset, swapIn, QUOTE_TOL_BPS);
        r.floor = (swapIn * limit) / 1e6;

        // 1. The atomic sandwich cannot even start: the attacker cannot sweep.
        deal(USDG, address(attacker), 1_000e6);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        attacker.attack(key, 1_000e6, exec, _one(victim));

        uint256 s0 = vm.snapshotState();
        _keeperSweep(_one(victim), _limit1(asset, limit));
        r.baseline = IERC20(asset).balanceOf(victim);
        if (r.baseline == 0) {
            // The pool cannot take this size within the bounds even unattacked:
            // the leg defers, and still nothing is paid out.
            assertEq(park.pending(victim), v, "deferred, not paid out");
            assertEq(IERC20(USDG).balanceOf(victim), usdg0);
            vm.revertToState(s0);
            return r;
        }
        assertGe(r.baseline, r.floor);

        // 2. Front-run (tx 1), keeper sweep (tx 2), back-run (tx 3), growing pushes.
        bool usdgIs0 = Currency.unwrap(key.currency0) == USDG;
        for (uint256 f = 10e6; f <= 10_000_000e6; f *= 2) {
            vm.revertToState(s0);
            deal(USDG, address(attacker), f);
            uint256 tok = attacker.swapExactIn(key, usdgIs0, f);
            _keeperSweep(_one(victim), _limit1(asset, limit));
            attacker.swapExactIn(key, !usdgIs0, tok);

            uint256 got = IERC20(asset).balanceOf(victim);
            if (got == 0) {
                assertEq(park.pending(victim), v, "the whole leg is back in the park");
                assertEq(IERC20(USDG).balanceOf(victim), usdg0, "nothing paid out as USDG");
                assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "no fee on a deferred leg");
                assertEq(exec.sweptEpoch(victim), exec.currentEpoch());
                r.firstDefer = f;
                break;
            }
            assertGe(got, r.floor, "never filled below the keeper's quote limit");
            uint256 loss = got >= r.baseline ? 0 : ((r.baseline - got) * 10_000) / r.baseline;
            if (loss > r.maxLossBps) r.maxLossBps = loss;
        }
        vm.revertToState(s0);
        assertGt(r.firstDefer, 0, "a large enough push makes the leg defer");
        assertLe(r.maxLossBps, QUOTE_TOL_BPS, "victim loss bounded by the keeper's quote tolerance");
    }

    function _report(string memory label, uint256 v, Result memory r) internal {
        emit log_string(label);
        emit log_named_decimal_uint("  sweep size (USDG)", v, 6);
        emit log_named_decimal_uint("  baseline tokens", r.baseline, 18);
        emit log_named_decimal_uint("  keeper floor tokens", r.floor, 18);
        emit log_named_decimal_uint("  smallest push that defers (USDG)", r.firstDefer, 6);
        emit log_named_uint("  worst victim loss while filling (bps)", r.maxLossBps);
    }

    // NVDA: hooked pool, LP fee 0 (the venue pinned in the fork suite).
    function test_sandwich_NVDA_100() public {
        _report("NVDA hooked pool, $100 sweep", 100e6, _run(NVDA, nvdaKey(), 100e6));
    }

    function test_sandwich_NVDA_1000() public {
        _report("NVDA hooked pool, $1,000 sweep", 1_000e6, _run(NVDA, nvdaKey(), 1_000e6));
    }

    function test_sandwich_NVDA_2000() public {
        _report("NVDA hooked pool, $2,000 sweep", 2_000e6, _run(NVDA, nvdaKey(), 2_000e6));
    }

    // SPY: plain pool, LP fee 0.30% (the venue pinned in the fork suite).
    function test_sandwich_SPY_100() public {
        _report("SPY fee-3000 pool, $100 sweep", 100e6, _run(SPY, spyKey(), 100e6));
    }

    function test_sandwich_SPY_1000() public {
        _report("SPY fee-3000 pool, $1,000 sweep", 1_000e6, _run(SPY, spyKey(), 1_000e6));
    }

    function test_sandwich_SPY_10000() public {
        _report("SPY fee-3000 pool, $10,000 sweep", 10_000e6, _run(SPY, spyKey(), 10_000e6));
    }

    function test_poolState() public {
        _poolInfo("SPY/USDG fee 3000", spyKey());
        _poolInfo("USDG/NVDA hooked fee 0", nvdaKey());
        _poolInfo("USDG/SGOV hooked fee 0", sgovKey());
    }

    function _poolInfo(string memory label, PoolKey memory key) internal {
        PoolId id = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
        uint128 L = IPoolManager(POOL_MANAGER).getLiquidity(id);
        emit log_string(label);
        emit log_named_uint("  sqrtPriceX96", sqrtP);
        emit log_named_uint("  active liquidity L", L);
    }
}
