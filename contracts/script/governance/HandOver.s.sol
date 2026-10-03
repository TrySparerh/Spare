// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {SpareAuth} from "../../src/SpareAuth.sol";
import {GovernanceBase} from "./GovernanceBase.sol";

/// @title HandOver
/// @notice Step 2 of the owner hand-over (docs/GOVERNANCE.md), sent by the CURRENT
///         owner EOA. In this order:
///           1. setPauser(pauser Safe) on all 7 Ownable2Step contracts
///           2. ScreeningGate.setAttestor(SPARE_ATTESTOR, default the pauser Safe)
///           3. transferOwnership(timelock) on all 7
///         Roles move FIRST because after step 3 every owner-only call, including
///         setPauser, needs the timelock. Ownable2Step only NOMINATES the timelock:
///         the EOA stays owner until the owner Safe executes the acceptOwnership
///         batch through the timelock 48 h later (TimelockBatch.s.sol, step 3).
/// @dev Idempotent: steps already done are skipped. Refuses before sending anything
///      unless the timelock (exact code, >= 48 h, owner Safe as its only proposer /
///      canceller / executor, no other admin, full role-log scan), both Safes, the
///      attestor and the current ownership all check out. The keeper is not touched.
///      Env:
///        SPARE_TIMELOCK, SPARE_TIMELOCK_BLOCK   printed by DeployTimelock
///        SPARE_OWNER_SAFE, SPARE_PAUSER_SAFE    the two Safes
///        SPARE_ATTESTOR                         optional (default SPARE_PAUSER_SAFE)
///        SPARE_MAINNET_ACK=owner-approved       to BROADCAST on 4663
///
///        # dry run (simulates every call as the owner, sends nothing)
///        forge script script/governance/HandOver.s.sol --rpc-url "$RHC_RPC_URL" --sender <owner EOA>
contract HandOver is GovernanceBase {
    function run() external {
        (Deployment memory d, string memory aj, string memory rel) = _loadDeployment();
        (SpareAuth[7] memory c, string[7] memory n) = _owned(d);
        TimelockController tl = TimelockController(payable(vm.envAddress("SPARE_TIMELOCK")));
        uint256 tlBlock = vm.envUint("SPARE_TIMELOCK_BLOCK");
        address ownerSafe = vm.envAddress("SPARE_OWNER_SAFE");
        address pauserSafe = vm.envAddress("SPARE_PAUSER_SAFE");
        address attestor = vm.envOr("SPARE_ATTESTOR", pauserSafe);
        address sender = _sender();
        address[] memory hot = _hotKeys(d, aj, sender);

        console2.log("SPARE HandOver");
        console2.log("  chain       ", block.chainid);
        console2.log("  addresses   ", rel);
        console2.log("  timelock    ", address(tl));
        console2.log("  owner Safe  ", ownerSafe);
        console2.log("  pauser Safe ", pauserSafe);
        console2.log("  attestor    ", attestor);
        console2.log("  sender      ", sender);
        console2.log("  mode        ", _broadcasting() ? "BROADCAST" : "dry run (simulation only)");

        if (vm.parseJsonUint(aj, ".chainId") != block.chainid) revert Refused("addresses file is for a different chain");
        _requireMainnetAck();

        _resetCounts();
        _checkTimelock(tl, ownerSafe, tlBlock);
        _checkSafe("owner Safe", ownerSafe, 2, 3, hot);
        _checkSafe("pauser Safe", pauserSafe, 1, 2, hot);

        _section("separation of powers");
        _check(pauserSafe != ownerSafe, "pauser Safe is not the owner Safe");
        _check(pauserSafe != address(tl), "pauser is not the timelock (pausing must not wait 48 h)");
        bool attestorOk = attestor != address(0) && attestor != address(tl);
        for (uint256 i; i < hot.length; ++i) {
            if (attestor == hot[i]) attestorOk = false;
        }
        _check(attestorOk, "attestor is not 0x0, the timelock, the outgoing owner, the deployer or the keeper");

        _section("ownership before");
        for (uint256 i; i < 7; ++i) {
            address o = c[i].owner();
            address p = c[i].pendingOwner();
            if (o == address(tl)) {
                _info(string.concat(n[i], ": already owned by the timelock"));
                _check(c[i].pauser() == pauserSafe, string.concat(n[i], ": pauser already moved (now only the timelock can)"));
            } else {
                _check(o == sender, string.concat(n[i], ": owner ", vm.toString(o), " = sender"));
                _check(p == address(0) || p == address(tl), string.concat(n[i], ": no pending owner other than the timelock"));
            }
        }
        if (_failed != 0) revert Refused("preflight failed; nothing sent");

        uint256 sent;
        vm.startBroadcast();
        // 1 + 2. Roles that must not wait 48 h, while the EOA can still set them.
        for (uint256 i; i < 7; ++i) {
            if (c[i].owner() == sender && c[i].pauser() != pauserSafe) {
                c[i].setPauser(pauserSafe);
                ++sent;
            }
        }
        if (d.screening.owner() == sender && d.screening.attestor() != attestor) {
            d.screening.setAttestor(attestor);
            ++sent;
        }
        // 3. Nominate the timelock. It accepts through its own 48 h delay.
        for (uint256 i; i < 7; ++i) {
            if (c[i].owner() == sender && c[i].pendingOwner() != address(tl)) {
                c[i].transferOwnership(address(tl));
                ++sent;
            }
        }
        vm.stopBroadcast();

        _section("after");
        uint256 pending;
        for (uint256 i; i < 7; ++i) {
            _check(c[i].pauser() == pauserSafe, string.concat(n[i], ".pauser = pauser Safe"));
            address o = c[i].owner();
            address p = c[i].pendingOwner();
            if (o == address(tl)) {
                _check(p == address(0), string.concat(n[i], ": owner = timelock (accepted)"));
            } else {
                ++pending;
                _check(p == address(tl), string.concat(n[i], ": pendingOwner = timelock"));
            }
        }
        _check(d.screening.attestor() == attestor, "ScreeningGate.attestor = SPARE_ATTESTOR");

        console2.log("");
        console2.log(
            string.concat(
                "SUMMARY: ", vm.toString(_passed), " passed, ", vm.toString(_failed), " failed, ", vm.toString(_warned),
                " warnings; ", vm.toString(sent), " call(s) ", _broadcasting() ? "sent" : "simulated", "; ",
                vm.toString(pending), "/7 awaiting acceptOwnership through the timelock"
            )
        );
        if (_failed != 0) revert Refused("post-check failed");
        if (pending != 0) {
            console2.log("Next (step 3): the owner Safe schedules the acceptOwnership batch -");
            console2.log("  forge script script/governance/TimelockBatch.s.sol --rpc-url \"$RHC_RPC_URL\"");
            console2.log("Until it executes (>= 48 h after scheduling) this EOA is still the owner of every contract.");
        }
    }
}
