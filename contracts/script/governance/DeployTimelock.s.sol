// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GovernanceBase} from "./GovernanceBase.sol";

/// @title DeployTimelock
/// @notice Step 1 of the owner hand-over (docs/GOVERNANCE.md): deploys the
///         TimelockController that will own every SPARE contract.
///           minDelay  = SPARE_TIMELOCK_DELAY (default and floor: 48 h)
///           proposer  = canceller = executor = the owner Safe, nobody else
///           admin     = none (the timelock administers itself, so changing a role
///                       or the delay is itself a 48 h timelocked operation)
/// @dev Deploying grants the deployer nothing, so any funded key can send it; the
///      runbook uses the current owner EOA. Before anything is sent the owner Safe
///      must pass GovernanceBase._checkSafe (canonical Safe v1.4.1, >= 2-of-3, no
///      module, no guard, no hot key among the signers); after, the timelock's code,
///      delay and roles are re-read. Env:
///        SPARE_OWNER_SAFE       the owner Safe (required)
///        SPARE_TIMELOCK_DELAY   seconds, >= 172800 (default 172800)
///        SPARE_ADDRESSES        addresses file (default addresses/<chainid>.json)
///        SPARE_MAINNET_ACK      =owner-approved to BROADCAST on 4663
///
///        # dry run (simulates, sends nothing)
///        forge script script/governance/DeployTimelock.s.sol --rpc-url "$RHC_RPC_URL" --sender <owner EOA>
contract DeployTimelock is GovernanceBase {
    function run() external returns (TimelockController tl) {
        (Deployment memory d, string memory aj, string memory rel) = _loadDeployment();
        address ownerSafe = vm.envAddress("SPARE_OWNER_SAFE");
        uint256 delay = vm.envOr("SPARE_TIMELOCK_DELAY", MIN_DELAY);
        address sender = _sender();

        console2.log("SPARE DeployTimelock");
        console2.log("  chain      ", block.chainid);
        console2.log("  addresses  ", rel);
        console2.log("  owner Safe ", ownerSafe);
        console2.log("  minDelay   ", delay);
        console2.log("  sender     ", sender);
        console2.log("  mode       ", _broadcasting() ? "BROADCAST" : "dry run (simulation only)");

        if (vm.parseJsonUint(aj, ".chainId") != block.chainid) revert Refused("addresses file is for a different chain");
        if (delay < MIN_DELAY) revert Refused("SPARE_TIMELOCK_DELAY is below 48 h (172800 s)");
        _requireMainnetAck();

        _resetCounts();
        _checkSafe("owner Safe", ownerSafe, 2, 3, _hotKeys(d, aj, sender));
        if (_failed != 0) revert Refused("the owner Safe failed its checks; nothing deployed");

        address[] memory safeOnly = new address[](1);
        safeOnly[0] = ownerSafe;
        uint256 fromBlock = vm.getBlockNumber();

        vm.startBroadcast();
        tl = new TimelockController(delay, safeOnly, safeOnly, address(0));
        vm.stopBroadcast();

        // A timelock created in this run has no logs on the RPC yet: point checks
        // here; HandOver and TimelockBatch re-check it with the full role-log scan.
        _checkTimelock(tl, ownerSafe, 0);
        _check(tl.getMinDelay() == delay, string.concat("minDelay = requested ", vm.toString(delay), " s"));
        _check(!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), sender), "deployer is NOT admin");
        _check(!tl.hasRole(tl.PROPOSER_ROLE(), sender), "deployer is NOT proposer");
        _check(!tl.hasRole(tl.EXECUTOR_ROLE(), sender), "deployer is NOT executor");
        _check(!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), ownerSafe), "owner Safe is NOT admin (role changes go through the delay)");
        if (_failed != 0) revert Refused("the timelock failed its post-deploy checks");

        console2.log("");
        console2.log(
            string.concat("SUMMARY: ", vm.toString(_passed), " passed, ", vm.toString(_failed), " failed, ", vm.toString(_warned), " warnings")
        );
        console2.log(string.concat("TimelockController: ", vm.toString(address(tl))));
        console2.log("Next (docs/GOVERNANCE.md, step 2), with the owner EOA:");
        console2.log(string.concat("  export SPARE_TIMELOCK=", vm.toString(address(tl))));
        console2.log(string.concat("  export SPARE_TIMELOCK_BLOCK=", vm.toString(fromBlock)));
    }
}
