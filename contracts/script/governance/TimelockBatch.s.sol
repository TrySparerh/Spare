// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {SpareAuth} from "../../src/SpareAuth.sol";
import {GovernanceBase, ISafe} from "./GovernanceBase.sol";

/// @title TimelockBatch
/// @notice Read-only generator for the owner Safe. Wraps a batch of owner calls in
///         TimelockController.scheduleBatch / executeBatch and prints both as Safe
///         Transaction Builder JSON, with the operation id, its live state, and the
///         Safe transaction hash the signers must see on their hardware wallets.
///
///         Default batch (no SPARE_TIMELOCK_CALLS_JSON): acceptOwnership() on all 7
///         Ownable2Step contracts, i.e. step 3 of the hand-over. The same batch and
///         salt give the same operation id on every run, so the schedule printed on
///         day 0 and the execute printed on day 2 always refer to one operation.
/// @dev Never broadcasts: it opens no broadcast bracket. Env:
///        SPARE_TIMELOCK, SPARE_TIMELOCK_BLOCK   printed by DeployTimelock
///        SPARE_OWNER_SAFE                       the proposer / executor Safe
///        SPARE_TIMELOCK_CALLS_JSON              optional custom batch, value 0 each, at
///                                               most 64 calls, in execution order:
///                                               [{"to":"0x...","data":"0x..."}, ...]
///                                               (a "value" key is accepted and must be
///                                               0: AddAssets.s.sol prints that form)
///        SPARE_TIMELOCK_SALT                    label hashed into the salt; REQUIRED
///                                               with a custom batch (a reused salt +
///                                               batch collides with a Done operation)
///        SPARE_TIMELOCK_DELAY                   schedule delay (default = getMinDelay())
///
///        forge script script/governance/TimelockBatch.s.sol --rpc-url "$RHC_RPC_URL"
///
///      Machine-readable lines (scripts/rehearse-governance.sh parses them):
///      OPERATION_ID, SCHEDULE_DATA, EXECUTE_DATA, SAFE_NONCE, SCHEDULE_SAFE_TX_HASH.
contract TimelockBatch is GovernanceBase {
    string internal constant ACCEPT_SALT = "SPARE: acceptOwnership x7";
    uint256 internal constant MAX_CALLS = 64;

    struct Batch {
        address[] targets;
        uint256[] values;
        bytes[] payloads;
        string[] labels;
        bytes32 salt;
        string saltLabel;
        bool isAccept;
    }

    function run() external {
        (Deployment memory d,, string memory rel) = _loadDeployment();
        TimelockController tl = TimelockController(payable(vm.envAddress("SPARE_TIMELOCK")));
        uint256 tlBlock = vm.envUint("SPARE_TIMELOCK_BLOCK");
        address ownerSafe = vm.envAddress("SPARE_OWNER_SAFE");

        console2.log("SPARE TimelockBatch (read-only)");
        console2.log("  chain      ", block.chainid);
        console2.log("  addresses  ", rel);
        console2.log("  timelock   ", address(tl));
        console2.log("  owner Safe ", ownerSafe);

        _resetCounts();
        _checkTimelock(tl, ownerSafe, tlBlock);
        if (_failed != 0) revert Refused("the timelock failed its checks; no batch printed");

        Batch memory b = _batch(d, tl);
        uint256 delay = vm.envOr("SPARE_TIMELOCK_DELAY", tl.getMinDelay());
        if (delay < tl.getMinDelay()) revert Refused("SPARE_TIMELOCK_DELAY is below the timelock's minDelay");

        _section(string.concat("batch: ", vm.toString(b.targets.length), " call(s), salt label \"", b.saltLabel, "\""));
        for (uint256 i; i < b.targets.length; ++i) {
            console2.log(string.concat("  ", vm.toString(i + 1), ". ", b.labels[i]));
        }
        if (b.isAccept) _acceptReadiness(d, tl);

        bytes32 id = tl.hashOperationBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);
        bytes memory scheduleData = abi.encodeCall(
            TimelockController.scheduleBatch, (b.targets, b.values, b.payloads, bytes32(0), b.salt, delay)
        );
        bytes memory executeData =
            abi.encodeCall(TimelockController.executeBatch, (b.targets, b.values, b.payloads, bytes32(0), b.salt));

        _section("operation");
        console2.log(string.concat("OPERATION_ID ", vm.toString(id)));
        console2.log(string.concat("  salt        ", vm.toString(b.salt)));
        console2.log(string.concat("  delay       ", vm.toString(delay), " s"));
        console2.log(string.concat("  state       ", _state(tl, id)));
        uint256 ts = tl.getTimestamp(id);
        if (ts > 1) {
            console2.log(string.concat("  ready at    ", vm.toString(ts), " (unix); now ", vm.toString(block.timestamp)));
        }

        uint256 nonce = ISafe(ownerSafe).nonce();
        _section("owner Safe transactions (to = timelock, value 0, CALL)");
        console2.log(string.concat("SAFE_NONCE ", vm.toString(nonce)));
        console2.log(string.concat("SCHEDULE_DATA ", vm.toString(scheduleData)));
        console2.log(
            string.concat("SCHEDULE_SAFE_TX_HASH ", vm.toString(_safeTxHash(ownerSafe, address(tl), scheduleData, nonce)))
        );
        console2.log(string.concat("EXECUTE_DATA ", vm.toString(executeData)));
        console2.log(
            string.concat(
                "  execute safeTxHash if it is the Safe's next transaction (nonce ", vm.toString(nonce), "): ",
                vm.toString(_safeTxHash(ownerSafe, address(tl), executeData, nonce))
            )
        );

        string memory what = b.isAccept ? "acceptOwnership x7" : b.saltLabel;
        console2.log("");
        console2.log("Safe Transaction Builder JSON - SCHEDULE (sign now):");
        console2.log(
            _txBuilderJson(
                string.concat("SPARE timelock: schedule ", what),
                string.concat("TimelockController.scheduleBatch, operation ", vm.toString(id), ", delay ", vm.toString(delay), " s"),
                ownerSafe,
                address(tl),
                scheduleData
            )
        );
        console2.log("");
        console2.log("Safe Transaction Builder JSON - EXECUTE (only once the state above is Ready):");
        console2.log(
            _txBuilderJson(
                string.concat("SPARE timelock: execute ", what),
                string.concat("TimelockController.executeBatch, operation ", vm.toString(id)),
                ownerSafe,
                address(tl),
                executeData
            )
        );
    }

    function _batch(Deployment memory d, TimelockController tl) internal view returns (Batch memory b) {
        string memory callsJson = vm.envOr("SPARE_TIMELOCK_CALLS_JSON", string(""));
        if (bytes(callsJson).length == 0) {
            (SpareAuth[7] memory c, string[7] memory n) = _owned(d);
            b.targets = new address[](7);
            b.values = new uint256[](7);
            b.payloads = new bytes[](7);
            b.labels = new string[](7);
            for (uint256 i; i < 7; ++i) {
                b.targets[i] = address(c[i]);
                b.payloads[i] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
                b.labels[i] = string.concat(n[i], ".acceptOwnership()  ", vm.toString(address(c[i])));
            }
            b.saltLabel = vm.envOr("SPARE_TIMELOCK_SALT", string(ACCEPT_SALT));
            b.isAccept = true;
        } else {
            string memory label = vm.envOr("SPARE_TIMELOCK_SALT", string(""));
            if (bytes(label).length == 0) revert Refused("a custom batch needs SPARE_TIMELOCK_SALT (e.g. \"2026-10-09 activate QQQ\")");
            b = _customBatch(d, tl, callsJson);
            b.saltLabel = label;
        }
        b.salt = keccak256(bytes(b.saltLabel));
    }

    /// @notice Parses SPARE_TIMELOCK_CALLS_JSON. Refuses rather than truncates: a
    ///         batch over MAX_CALLS, or a call carrying a non-zero value (the batch
    ///         sends none), would otherwise be scheduled as something else.
    function _customBatch(Deployment memory d, TimelockController tl, string memory callsJson)
        internal
        view
        returns (Batch memory b)
    {
        uint256 k;
        while (k < MAX_CALLS && vm.keyExistsJson(callsJson, string.concat("[", vm.toString(k), "]"))) ++k;
        if (k == 0) revert Refused("SPARE_TIMELOCK_CALLS_JSON has no calls");
        if (vm.keyExistsJson(callsJson, string.concat("[", vm.toString(MAX_CALLS), "]"))) {
            revert Refused(string.concat("more than ", vm.toString(MAX_CALLS), " calls; split the batch"));
        }
        b.targets = new address[](k);
        b.values = new uint256[](k);
        b.payloads = new bytes[](k);
        b.labels = new string[](k);
        for (uint256 i; i < k; ++i) {
            string memory p = string.concat("[", vm.toString(i), "]");
            b.targets[i] = vm.parseJsonAddress(callsJson, string.concat(p, ".to"));
            b.payloads[i] = vm.parseJsonBytes(callsJson, string.concat(p, ".data"));
            if (b.payloads[i].length < 4) revert Refused(string.concat("call ", vm.toString(i), " has no selector"));
            string memory v = string.concat(p, ".value");
            if (vm.keyExistsJson(callsJson, v) && vm.parseJsonUint(callsJson, v) != 0) {
                revert Refused(string.concat("call ", vm.toString(i), " has a non-zero value; the batch sends none"));
            }
            // encodePacked: vm.toString has no bytes4 overload, and a bytes32 would
            // print the selector padded with 28 zero bytes.
            b.labels[i] = string.concat(
                _nameOf(d, tl, b.targets[i]), " ", vm.toString(b.targets[i]), "  selector ",
                vm.toString(abi.encodePacked(bytes4(b.payloads[i])))
            );
        }
    }

    /// @dev acceptOwnership from the timelock only succeeds once HandOver nominated it.
    ///      Scheduling first is allowed; executing before every contract is pending
    ///      to the timelock would revert the whole batch.
    function _acceptReadiness(Deployment memory d, TimelockController tl) internal {
        (SpareAuth[7] memory c, string[7] memory n) = _owned(d);
        _section("acceptOwnership readiness");
        for (uint256 i; i < 7; ++i) {
            address o = c[i].owner();
            address p = c[i].pendingOwner();
            if (p == address(tl)) _info(string.concat(n[i], ": pendingOwner = timelock (ready to accept)"));
            else if (o == address(tl)) _info(string.concat(n[i], ": already owned by the timelock (batch would revert)"));
            else _warn(string.concat(n[i], ": not nominated yet - run HandOver before EXECUTE"));
        }
    }

    function _nameOf(Deployment memory d, TimelockController tl, address a) internal pure returns (string memory) {
        if (a == address(tl)) return "TimelockController";
        (SpareAuth[7] memory c, string[7] memory n) = _owned(d);
        for (uint256 i; i < 7; ++i) {
            if (a == address(c[i])) return n[i];
        }
        return "(not a SPARE contract)";
    }

    function _state(TimelockController tl, bytes32 id) internal view returns (string memory) {
        TimelockController.OperationState s = tl.getOperationState(id);
        if (s == TimelockController.OperationState.Unset) return "Unset (not scheduled)";
        if (s == TimelockController.OperationState.Waiting) return "Waiting (scheduled, delay running)";
        if (s == TimelockController.OperationState.Ready) return "Ready (executable now)";
        return "Done (executed)";
    }
}
