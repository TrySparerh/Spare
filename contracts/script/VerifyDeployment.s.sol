// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {SpareBase} from "./lib/SpareBase.sol";
import {SpareConfig} from "./lib/SpareConfig.sol";

/// @title VerifyDeployment
/// @notice Read-only. Loads addresses/<chainid>.json and the config it was built
///         from, then asserts every wire: code, immutables, router callers,
///         park executor / adapter / keeper, executor keeper + params, pauser,
///         screening, registry entries (feed, heartbeat, band, active, exact
///         PoolKey), the asset rules (token decimals 18, heartbeat <= 26 h, a
///         hook's permission flags, codehash, authority and fee ceiling against
///         the config's pins), pool state, default mix, Ownable2Step state
///         (pending or accepted) and the governance policy (owner = a
///         TimelockController with minDelay >= 48 h; a warning unless required).
///         Reverts if any check fails.
/// @dev Never broadcasts — it opens no broadcast bracket, so even `--broadcast`
///      sends nothing. Env:
///        SPARE_ADDRESSES                addresses file (default addresses/<chainid>.json)
///        SPARE_CONFIG / _JSON           config (see SpareConfig)
///        SPARE_EXPECT_PARK_ADAPTER=sgov verify AFTER the owner switched adapters
///        SPARE_REQUIRE_ACCEPTED=true    also fail while any ownership is still pending
///        SPARE_REQUIRE_TIMELOCK=true    fail, not warn, when an owner misses the policy
contract VerifyDeployment is SpareBase {
    function run() external {
        SpareConfig.Config memory cfg = SpareConfig.load();
        (Deployment memory d, string memory aj, string memory rel) = _loadDeployment();

        console2.log("SPARE VerifyDeployment");
        console2.log("  chain     ", block.chainid);
        console2.log("  addresses ", rel);
        console2.log("  config    ", cfg.source);
        console2.log("  deployer  ", d.deployer);

        if (vm.parseJsonUint(aj, ".chainId") != block.chainid) revert("addresses file is for a different chain");
        bytes32 recorded = vm.parseJsonBytes32(aj, ".config.hash");

        uint256 failed = _verify(cfg, d);
        if (recorded != cfg.hash) {
            _warn(
                string.concat(
                    "config hash differs from the one recorded at deploy (",
                    vm.toString(recorded),
                    "); the checks above ran against the CURRENT config"
                )
            );
        }
        if (failed != 0) revert("VerifyDeployment: FAILED");
        if (vm.envOr("SPARE_REQUIRE_ACCEPTED", false) && _pendingOwnership != 0) {
            revert("VerifyDeployment: ownership not yet accepted on every contract");
        }
        console2.log("VerifyDeployment: PASS");
    }
}
