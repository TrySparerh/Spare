// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {SpareAuth} from "../src/SpareAuth.sol";
import {SpareBase} from "./lib/SpareBase.sol";

/// @title AcceptOwnership
/// @notice Completes the Ownable2Step hand-over started by Deploy.
/// @dev Two uses:
///        - DRY RUN (no --broadcast): prints the acceptOwnership() calls still
///          pending, as plain {to, data} and as a Safe Transaction Builder batch
///          JSON the multisig can import. Nothing is written or sent.
///        - --broadcast with the OWNER's key (dev forks, or an EOA owner): accepts
///          on every contract whose pendingOwner is the broadcaster. Idempotent —
///          contracts already accepted are skipped.
///      A multisig owner cannot use --broadcast (it has no private key); it
///      executes the printed batch instead.
///
///      When the pending owner is a TimelockController (the hand-over in
///      docs/GOVERNANCE.md), only the timelock itself can accept, through an
///      operation the owner Safe schedules and executes 48 h later. A direct Safe
///      batch would revert (the Safe is not the pending owner), so none is printed:
///      the script names the timelock and points to TimelockBatch.s.sol, and
///      refuses --broadcast.
contract AcceptOwnership is SpareBase {
    bytes4 internal constant ACCEPT = bytes4(keccak256("acceptOwnership()"));

    /// @return pending      contracts still awaiting acceptOwnership()
    /// @return viaTimelock  their pending owner is a TimelockController, so no
    ///                      direct batch was printed (see TimelockBatch.s.sol)
    function run() external returns (uint256 pending, bool viaTimelock) {
        (Deployment memory d,, string memory rel) = _loadDeployment();
        (SpareAuth[7] memory c, string[7] memory n) = _owned(d);

        console2.log("SPARE AcceptOwnership");
        console2.log("  chain     ", block.chainid);
        console2.log("  addresses ", rel);

        address nominee;
        for (uint256 i; i < 7; ++i) {
            address p = c[i].pendingOwner();
            if (p == address(0)) {
                console2.log(string.concat("  ", n[i], ": accepted, owner ", vm.toString(c[i].owner())));
                continue;
            }
            if (nominee == address(0)) nominee = p;
            if (p != nominee) revert("contracts are pending to DIFFERENT owners; resolve manually");
            ++pending;
            console2.log(string.concat("  ", n[i], ": pending -> ", vm.toString(p)));
        }
        if (pending == 0) {
            console2.log("Nothing to accept.");
            return (0, false);
        }

        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        (bool isTimelock, uint256 minDelay) = _timelockDelay(nominee);
        if (isTimelock) {
            _printTimelock(nominee, minDelay, pending);
            if (broadcasting) revert("the pending owner is a TimelockController: no key can accept for it");
            return (pending, true);
        }
        if (!broadcasting) {
            _printBatch(c, n);
            return (pending, false);
        }

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        if (sender != nominee) revert("broadcaster is not the pending owner");
        for (uint256 i; i < 7; ++i) {
            if (c[i].pendingOwner() == sender) c[i].acceptOwnership();
        }
        vm.stopBroadcast();

        for (uint256 i; i < 7; ++i) {
            if (c[i].owner() != sender || c[i].pendingOwner() != address(0)) revert("acceptance incomplete");
        }
        console2.log(string.concat("Accepted ownership on ", vm.toString(pending), " contract(s)."));
    }

    function _printTimelock(address tl, uint256 minDelay, uint256 pending) internal pure {
        console2.log("");
        console2.log(
            string.concat(
                "The pending owner ", vm.toString(tl), " is a TimelockController (minDelay ", vm.toString(minDelay),
                " s)."
            )
        );
        console2.log("Only the timelock can call acceptOwnership(), through an operation the owner Safe schedules");
        console2.log("and executes once the delay has passed. A direct Safe batch would revert (the Safe is not");
        console2.log("the pending owner), so none is printed. Generate the schedule / execute transactions with:");
        console2.log(
            string.concat(
                "  SPARE_TIMELOCK=", vm.toString(tl),
                " SPARE_TIMELOCK_BLOCK=<its deploy block> SPARE_OWNER_SAFE=<owner Safe> \\"
            )
        );
        console2.log("    forge script script/governance/TimelockBatch.s.sol --skip test --rpc-url \"$RHC_RPC_URL\"");
        console2.log("  (its default batch is acceptOwnership() on all 7; docs/GOVERNANCE.md, steps 3-5)");
        if (pending < 7) {
            console2.log(
                string.concat(
                    "  [warn] only ", vm.toString(pending), "/7 are pending to the timelock: the default batch would",
                    " revert on EXECUTE. Re-run script/governance/HandOver.s.sol first (idempotent)."
                )
            );
        }
    }

    function _printBatch(SpareAuth[7] memory c, string[7] memory n) internal view {
        string memory data = vm.toString(abi.encodePacked(ACCEPT));
        console2.log("");
        console2.log("Pending calls (value 0), for the owner to execute:");
        string memory txs;
        bool first = true;
        for (uint256 i; i < 7; ++i) {
            if (c[i].pendingOwner() == address(0)) continue;
            console2.log(string.concat("  to ", vm.toString(address(c[i])), "  data ", data, "  (", n[i], ".acceptOwnership)"));
            txs = string.concat(
                txs,
                first ? "" : ",",
                "{\"to\":\"", vm.toString(address(c[i])), "\",\"value\":\"0\",\"data\":\"", data,
                "\",\"contractMethod\":null,\"contractInputsValues\":null}"
            );
            first = false;
        }
        console2.log("");
        console2.log("Safe Transaction Builder batch JSON:");
        console2.log(
            string.concat(
                "{\"version\":\"1.0\",\"chainId\":\"", vm.toString(block.chainid),
                "\",\"meta\":{\"name\":\"SPARE: acceptOwnership x7\",\"description\":\"Completes the Ownable2Step hand-over started by Deploy.s.sol\"},\"transactions\":[",
                txs, "]}"
            )
        );
    }
}
