// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {SweepExecutor} from "../src/SweepExecutor.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {OracleGuard} from "../src/libraries/OracleGuard.sol";
import {SpareBase} from "./lib/SpareBase.sol";

/// @title DevSmoke
/// @notice End-to-end smoke of a LOCAL deployment (chain 31337 only): users
///         onboard, the keeper accrues, a sweep buys the mix, stock tokens land.
/// @dev Phases, because real blocks must be mined between them and the sweep is
///      sent by scripts/dev-smoke.sh with an explicit gas limit (see below):
///        onboard()  users: USDG->Permit2 approve, capped Permit2 allowance to
///                   SweepExecutor, linkSelf, setRule($1, 1x, $50/wk)
///        accrue()   keeper accrues each user up to head - finalityBuffer - 1
///        report()   read-only: for every user and every leg of its mix, the leg
///                   must have CONVERTED (token balance > 0) when the oracle is
///                   fresh, or been DEFERRED (value back in the park) when it is
///                   not. A safe-settled leg (USDG payout) fails the smoke.
///      Why the sweep is not sent from here: forge sizes each broadcast tx from
///      eth_estimateGas, and the NVDA pool's hook (0xA0D1...80c4) charges ~3% on
///      swaps from transactions with a low gas limit (measured 2026-09-29: <= 4M
///      on a direct buy; >= 4.5M pays ~0.3%; gasPrice 0 calls such as quoters pay
///      nothing). A 3% haircut breaches the 1% minOut, so the NVDA leg would
///      safe-settle. The keeper must send sweeps with a high gas limit; the
///      script does the same.
///      Env: SMOKE_USER_PKS (comma list), SMOKE_KEEPER_PK, SMOKE_AMOUNTS_USDG
///      (comma list of base units, one per user; default 6e6, 12e6, ...).
contract DevSmoke is SpareBase {
    uint160 internal constant CAP = 50e6; // $50 / week and Permit2 allowance

    function _guard() internal view {
        if (block.chainid != 31337) revert("DevSmoke runs on the local dev fork (31337) only");
    }

    function onboard() external {
        _guard();
        (Deployment memory d,,) = _loadDeployment();
        address usdg = address(d.exec.usdg());
        IAllowanceTransfer permit2 = d.exec.permit2();
        uint256[] memory pks = vm.envUint("SMOKE_USER_PKS", ",");
        for (uint256 i; i < pks.length; ++i) {
            address u = vm.addr(pks[i]);
            vm.startBroadcast(pks[i]);
            if (IERC20(usdg).allowance(u, address(permit2)) != type(uint256).max) {
                IERC20(usdg).approve(address(permit2), type(uint256).max);
            }
            permit2.approve(usdg, address(d.exec), CAP, uint48(block.timestamp + 30 days));
            if (!d.rules.isLinked(u, u)) d.rules.linkSelf();
            d.rules.setRule(1, 1, uint64(CAP), true);
            vm.stopBroadcast();
            console2.log("onboarded", u);
        }
    }

    function accrue() external {
        _guard();
        (Deployment memory d,,) = _loadDeployment();
        uint256[] memory pks = vm.envUint("SMOKE_USER_PKS", ",");
        uint256[] memory def = new uint256[](pks.length);
        for (uint256 i; i < def.length; ++i) {
            def[i] = 6e6 * (i + 1);
        }
        uint256[] memory amts = vm.envOr("SMOKE_AMOUNTS_USDG", ",", def);
        require(amts.length == pks.length, "one amount per user");

        // L2Clock reads MockArbSys at 0x64, which returns block.number on the fork.
        uint256 buf = d.exec.finalityBuffer();
        require(block.number > buf + 1, "mine finalityBuffer blocks first");
        uint256 toBlock = block.number - buf - 1;

        SweepExecutor.Accrual[] memory batch = new SweepExecutor.Accrual[](pks.length);
        for (uint256 i; i < pks.length; ++i) {
            address u = vm.addr(pks[i]);
            batch[i] = SweepExecutor.Accrual(u, u, amts[i], toBlock);
        }

        vm.startBroadcast(vm.envUint("SMOKE_KEEPER_PK"));
        d.exec.accrueBatch(batch);
        vm.stopBroadcast();
        console2.log("accrued to block", toBlock);
        for (uint256 i; i < pks.length; ++i) {
            console2.log("  park value", vm.addr(pks[i]), d.park.valueOf(vm.addr(pks[i])));
        }
    }

    function report() external {
        _guard();
        (Deployment memory d,,) = _loadDeployment();
        uint256[] memory pks = vm.envUint("SMOKE_USER_PKS", ",");
        ElectionRegistry.Leg[] memory mix = d.elections.defaultMix();
        IERC20 usdg = d.exec.usdg();

        uint256 fee = usdg.balanceOf(address(d.vault));
        console2.log("FeeVault USDG (base units)", fee);
        uint256 bad;
        for (uint256 i; i < pks.length; ++i) {
            address u = vm.addr(pks[i]);
            uint256 parked = d.park.valueOf(u);
            console2.log("");
            console2.log("user", u);
            console2.log(string.concat("  parked USDG (1e6) ", vm.toString(parked), ", swept epoch ",
                vm.toString(d.exec.sweptEpoch(u)), ", USDG wallet (1e6) ", vm.toString(usdg.balanceOf(u))));
            for (uint256 l; l < mix.length; ++l) {
                uint256 b = IERC20(mix[l].asset).balanceOf(u);
                (OracleGuard.Status st, uint256 px) = d.router.oracleStatus(mix[l].asset);
                string memory line = string.concat("  leg ", vm.toString(mix[l].asset), " (", vm.toString(mix[l].bps),
                    " bps) balance 1e18 ", vm.toString(b));
                if (st == OracleGuard.Status.OK) {
                    line = string.concat(line, " ~ $1e6 ", vm.toString(d.router.oracleUsdgFor(b, px)));
                    if (b == 0) {
                        ++bad;
                        line = string.concat(line, "  <-- NOT CONVERTED with a fresh oracle (safe-settled?)");
                    }
                } else {
                    line = string.concat(line, "  oracle ", _status(st));
                    if (b == 0 && parked == 0) {
                        ++bad;
                        line = string.concat(line, "  <-- neither converted nor deferred");
                    }
                }
                console2.log(line);
            }
        }
        require(bad == 0, "smoke: a leg was neither converted nor deferred");
        console2.log("");
        console2.log("DevSmoke report: OK");
    }
}
