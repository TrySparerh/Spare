// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {SpareAuth} from "../src/SpareAuth.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {RuleRegistry} from "../src/RuleRegistry.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {ScreeningGate} from "../src/ScreeningGate.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {CashPark} from "../src/CashPark.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {SweepExecutor} from "../src/SweepExecutor.sol";
import {UsdgParkAdapter} from "../src/park/UsdgParkAdapter.sol";
import {SgovParkAdapter} from "../src/park/SgovParkAdapter.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

import {SpareBase} from "./lib/SpareBase.sol";
import {SpareConfig} from "./lib/SpareConfig.sol";

/// @title Deploy
/// @notice Deploys and wires the whole SPARE S1 system from a config JSON, then
///         starts the Ownable2Step hand-over to the configured owner.
///
/// @dev What it does, in order:
///        1. load contracts/config/<chainid>.json (see SpareConfig for how)
///        2. preflight — every external address has code, every pool key is
///           initialised, every asset meets SpareBase._assetRules (18-decimal
///           token, heartbeat <= 26 h, a pinned fee-only hook), roles are real,
///           and on 4663 the go-live guards hold. Nothing is broadcast if any of
///           this fails.
///        3. deploy all contracts with the DEPLOYER as temporary owner
///        4. wire: register + activate assets, default mix, router callers (incl.
///           the SGOV adapter), park executor/adapter/keeper, executor keeper +
///           params, pauser everywhere
///        5. transferOwnership(owner) on all 7 owned contracts — the owner must
///           then call acceptOwnership() on each (docs/RUNBOOK.md)
///        6. re-verify every wire with the same checks VerifyDeployment runs
///        7. on --broadcast only, write addresses/<chainid>.json
///
///      Launch park adapter is UsdgParkAdapter. SgovParkAdapter is deployed and
///      pre-authorised on StockRouter but NOT set on CashPark: switching is an
///      owner call to CashPark.setAdapter, allowed only while no units are parked.
///
///      Environment:
///        SPARE_CONFIG / SPARE_CONFIG_JSON  config location / contents (SpareConfig)
///        SPARE_MAINNET_ACK=owner-approved  required to BROADCAST on chain 4663
///        SPARE_ALLOW_EOA_OWNER=true        permit an EOA owner on 4663 (not advised)
///        SPARE_ALLOW_DEPLOYER_OWNER=true   permit owner == deployer on 4663 (no hand-over)
///        SPARE_ALLOW_SCREENING_OFF=true    permit screening.enforced = false on 4663
///        SPARE_REHEARSAL=true              dry-run ONLY: substitute labelled stand-in
///                                          addresses for placeholder roles so the real
///                                          mainnet config can be exercised on a fork
contract Deploy is SpareBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    string internal constant MAINNET_ACK = "owner-approved";
    uint256 internal constant MAX_LEGS = 6;

    error Refused(string why);

    function run() external returns (Deployment memory d) {
        SpareConfig.Config memory cfg = SpareConfig.load();
        bool rehearsal = _applyRehearsal(cfg);

        // Resolve the broadcaster first; nothing is sent in this bracket.
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        vm.stopBroadcast();

        _banner(cfg, deployer, rehearsal);
        _preflight(cfg, deployer, rehearsal);

        d.deployer = deployer;
        d.startBlock = block.number;

        vm.startBroadcast();
        _deploy(cfg, d);
        _wire(cfg, d);
        _handOver(cfg, d);
        vm.stopBroadcast();

        console2.log("");
        console2.log("Post-deploy verification (same checks as VerifyDeployment):");
        uint256 failed = _verify(cfg, d);
        if (failed != 0) revert Refused("post-deploy verification failed; see [FAIL] lines");

        _record(cfg, d);
    }

    // ── mode / guards ──────────────────────────────────────────────────────

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    /// @dev Rehearsal exists so the EXACT mainnet config (assets, keys, params) can
    ///      be exercised on a fork before the owner has filled in the roles. It is
    ///      refused in any broadcasting context, so it can never reach a chain.
    function _applyRehearsal(SpareConfig.Config memory cfg) internal returns (bool) {
        if (!vm.envOr("SPARE_REHEARSAL", false)) return false;
        if (!vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            revert Refused("SPARE_REHEARSAL is dry-run only; unset it to broadcast");
        }
        if (cfg.roles.owner == address(0)) cfg.roles.owner = _standIn("owner");
        if (cfg.roles.keeper == address(0)) cfg.roles.keeper = _standIn("keeper");
        if (cfg.roles.pauser == address(0)) cfg.roles.pauser = _standIn("pauser");
        if (cfg.roles.attestor == address(0)) cfg.roles.attestor = _standIn("attestor");
        return true;
    }

    function _standIn(string memory role) internal returns (address a) {
        a = vm.addr(uint256(keccak256(bytes(string.concat("spare.rehearsal.", role)))));
        vm.label(a, string.concat("rehearsal-", role));
    }

    function _banner(SpareConfig.Config memory cfg, address deployer, bool rehearsal) internal view {
        console2.log("SPARE Deploy");
        console2.log("  chain       ", block.chainid);
        console2.log("  config      ", cfg.source);
        console2.log("  config hash ", vm.toString(cfg.hash));
        console2.log("  deployer    ", deployer);
        console2.log("  owner       ", cfg.roles.owner);
        console2.log("  keeper      ", cfg.roles.keeper);
        console2.log("  pauser      ", cfg.roles.pauser);
        console2.log("  attestor    ", cfg.roles.attestor);
        console2.log("  screening   ", cfg.screeningEnforced ? "enforced" : "OFF");
        string memory mode = _broadcasting() ? "BROADCAST" : "dry run (simulation only)";
        if (rehearsal) mode = "REHEARSAL dry run: placeholder roles replaced by stand-ins";
        console2.log("  mode        ", mode);
    }

    function _preflight(SpareConfig.Config memory cfg, address deployer, bool rehearsal) internal view {
        if (block.chainid != cfg.chainId) {
            revert Refused(
                string.concat(
                    "config is for chain ", vm.toString(cfg.chainId), " but the RPC is chain ", vm.toString(block.chainid)
                )
            );
        }
        _preflightRoles(cfg, deployer, rehearsal);
        _preflightChain(cfg);
        _preflightAssets(cfg);
        _preflightMix(cfg);
        console2.log("Preflight passed.");
    }

    function _preflightRoles(SpareConfig.Config memory cfg, address deployer, bool rehearsal) internal view {
        SpareConfig.Roles memory r = cfg.roles;
        bool placeholder = r.owner == address(0) || r.keeper == address(0) || r.pauser == address(0)
            || r.attestor == address(0);
        if (placeholder) {
            if (block.chainid == MAINNET) {
                revert Refused(
                    "chain 4663 with PLACEHOLDER roles: the owner must fill roles.owner/keeper/pauser/attestor in config/4663.json"
                );
            }
            revert Refused("every role must be a real address");
        }
        if (r.keeper == r.owner) revert Refused("keeper must not be the owner (hot key vs multisig)");
        if (r.attestor == r.keeper) revert Refused("attestor must not be the keeper");

        if (block.chainid != MAINNET) return;
        if (!cfg.screeningEnforced && !vm.envOr("SPARE_ALLOW_SCREENING_OFF", false)) {
            revert Refused("chain 4663 requires screening.enforced = true (SPARE_ALLOW_SCREENING_OFF overrides)");
        }
        if (rehearsal) return;
        if (r.owner == deployer && !vm.envOr("SPARE_ALLOW_DEPLOYER_OWNER", false)) {
            revert Refused("chain 4663: owner must not be the deployer key (SPARE_ALLOW_DEPLOYER_OWNER overrides)");
        }
        if (r.owner.code.length == 0 && !vm.envOr("SPARE_ALLOW_EOA_OWNER", false)) {
            revert Refused("chain 4663: owner has no code; it must be the multisig (SPARE_ALLOW_EOA_OWNER overrides)");
        }
        if (_broadcasting()) {
            string memory ack = vm.envOr("SPARE_MAINNET_ACK", string(""));
            if (keccak256(bytes(ack)) != keccak256(bytes(MAINNET_ACK))) {
                revert Refused(
                    "chain 4663 BROADCAST needs SPARE_MAINNET_ACK=owner-approved (RUNBOOK go-live gate)"
                );
            }
        }
    }

    function _preflightChain(SpareConfig.Config memory cfg) internal view {
        if (cfg.usdg.code.length == 0) revert Refused("USDG has no code on this chain");
        if (cfg.permit2.code.length == 0) revert Refused("Permit2 has no code on this chain");
        if (cfg.poolManager.code.length == 0) revert Refused("v4 PoolManager has no code on this chain");
        if (IERC20Metadata(cfg.usdg).decimals() != 6) revert Refused("USDG decimals != 6");

        SpareConfig.Params memory p = cfg.params;
        // Mirrors SweepExecutor.setParams so a bad config fails here, before any gas is spent.
        if (p.feeBps > 100 || p.slippageBps > 500 || p.threshold < 1_000_000 || p.epochLength < 1 hours) {
            revert Refused("params outside SweepExecutor bounds");
        }
        if (p.finalityBuffer == 0) revert Refused("finalityBuffer must be > 0");
        if (cfg.deploySgovAdapter) {
            if (cfg.sgov == address(0)) revert Refused("park.sgovSymbol does not resolve to an asset");
            if (cfg.sgovSlippageBps == 0 || cfg.sgovSlippageBps > 500) revert Refused("park.sgovSlippageBps out of range");
        }
    }

    function _preflightAssets(SpareConfig.Config memory cfg) internal view {
        SpareConfig.Asset[] memory as_ = cfg.assets;
        if (as_.length == 0) revert Refused("no assets configured");
        for (uint256 i; i < as_.length; ++i) {
            SpareConfig.Asset memory a = as_[i];
            for (uint256 j; j < i; ++j) {
                if (as_[j].token == a.token || keccak256(bytes(as_[j].symbol)) == keccak256(bytes(a.symbol))) {
                    revert Refused(string.concat("duplicate asset ", a.symbol));
                }
            }
            if (a.token.code.length == 0) revert Refused(string.concat(a.symbol, ": token has no code"));
            if (a.feed.code.length == 0) revert Refused(string.concat(a.symbol, ": feed has no code"));
            uint8 dec = IAggregatorV3(a.feed).decimals();
            if (dec == 0 || dec > 18) revert Refused(string.concat(a.symbol, ": feed decimals out of range"));
            if (a.heartbeat == 0) revert Refused(string.concat(a.symbol, ": heartbeat 0"));
            if (a.bandBps == 0 || a.bandBps > 1000) revert Refused(string.concat(a.symbol, ": bandBps out of range"));

            address c0 = Currency.unwrap(a.key.currency0);
            address c1 = Currency.unwrap(a.key.currency1);
            bool pair = (c0 == cfg.usdg && c1 == a.token) || (c0 == a.token && c1 == cfg.usdg);
            if (!pair || c0 >= c1) revert Refused(string.concat(a.symbol, ": PoolKey is not sorted USDG/token"));
            address h = address(a.key.hooks);
            if (h != address(0) && h.code.length == 0) revert Refused(string.concat(a.symbol, ": hook has no code"));
            (bool broken, string memory why) = _firstBroken(_assetRules(a));
            if (broken) revert Refused(string.concat(a.symbol, ": ", why));

            (uint160 sqrtP,,,) = IPoolManager(cfg.poolManager).getSlot0(a.key.toId());
            if (sqrtP == 0) revert Refused(string.concat(a.symbol, ": pool not initialised (wrong PoolKey?)"));
            if (a.active && IPoolManager(cfg.poolManager).getLiquidity(a.key.toId()) == 0) {
                revert Refused(string.concat(a.symbol, ": active asset's pool has no in-range liquidity"));
            }
        }
    }

    function _preflightMix(SpareConfig.Config memory cfg) internal pure {
        SpareConfig.MixLeg[] memory m = cfg.defaultMix;
        if (m.length == 0 || m.length > MAX_LEGS) revert Refused("defaultMix must have 1..6 legs");
        uint256 total;
        for (uint256 i; i < m.length; ++i) {
            uint256 k = SpareConfig.indexOf(cfg.assets, m[i].symbol);
            if (!cfg.assets[k].active) revert Refused(string.concat("defaultMix leg is inactive: ", m[i].symbol));
            if (m[i].bps == 0) revert Refused(string.concat("defaultMix leg has 0 bps: ", m[i].symbol));
            for (uint256 j; j < i; ++j) {
                if (m[j].token == m[i].token) revert Refused(string.concat("defaultMix duplicate: ", m[i].symbol));
            }
            total += m[i].bps;
        }
        if (total != 10_000) revert Refused("defaultMix bps must sum to exactly 10000");
    }

    // ── deploy / wire / hand over ─────────────────────────────────────────

    function _deploy(SpareConfig.Config memory cfg, Deployment memory d) internal {
        address o = d.deployer; // temporary owner until the hand-over below
        d.registry = new AssetRegistry(o, cfg.usdg);
        d.rules = new RuleRegistry();
        d.elections = new ElectionRegistry(o, d.registry);
        d.screening = new ScreeningGate(o, cfg.roles.attestor, cfg.screeningEnforced);
        d.router = new StockRouter(o, IPoolManager(cfg.poolManager), d.registry);
        d.park = new CashPark(o, IERC20(cfg.usdg));
        d.vault = new FeeVault(o);
        d.exec = new SweepExecutor(
            o, IAllowanceTransfer(cfg.permit2), d.rules, d.elections, d.screening, d.router, d.park, d.vault
        );
        d.usdgAdapter = new UsdgParkAdapter(cfg.usdg, address(d.park));
        if (cfg.deploySgovAdapter) {
            d.sgovAdapter = new SgovParkAdapter(cfg.usdg, cfg.sgov, address(d.park), d.router, cfg.sgovSlippageBps);
        }
    }

    function _wire(SpareConfig.Config memory cfg, Deployment memory d) internal {
        // Venue allowlist. setAsset registers INACTIVE; activation is its own step.
        for (uint256 i; i < cfg.assets.length; ++i) {
            SpareConfig.Asset memory a = cfg.assets[i];
            d.registry.setAsset(a.token, a.feed, a.heartbeat, a.bandBps, a.key);
            if (a.active) d.registry.setActive(a.token, true);
        }

        ElectionRegistry.Leg[] memory legs = new ElectionRegistry.Leg[](cfg.defaultMix.length);
        for (uint256 i; i < legs.length; ++i) {
            legs[i] = ElectionRegistry.Leg(cfg.defaultMix[i].token, cfg.defaultMix[i].bps);
        }
        d.elections.setDefaultMix(legs);

        d.router.setCaller(address(d.exec), true);
        if (cfg.deploySgovAdapter) d.router.setCaller(address(d.sgovAdapter), true);
        if (cfg.sequencerFeed != address(0)) d.router.setSequencerFeed(cfg.sequencerFeed);

        d.park.setExecutor(address(d.exec));
        d.park.setAdapter(d.usdgAdapter);
        d.park.setKeeper(cfg.roles.keeper, true);

        d.exec.setKeeper(cfg.roles.keeper, true);
        SpareConfig.Params memory p = cfg.params;
        d.exec.setParams(p.finalityBuffer, p.threshold, p.feeBps, p.slippageBps, p.epochLength);

        (SpareAuth[7] memory c,) = _owned(d);
        for (uint256 i; i < 7; ++i) {
            c[i].setPauser(cfg.roles.pauser);
        }
    }

    /// @dev Ownable2Step: this only NOMINATES the owner. Until it calls
    ///      acceptOwnership() on each contract, the deployer is still the owner —
    ///      accept promptly and re-run VerifyDeployment.
    function _handOver(SpareConfig.Config memory cfg, Deployment memory d) internal {
        if (cfg.roles.owner == d.deployer) return;
        (SpareAuth[7] memory c,) = _owned(d);
        for (uint256 i; i < 7; ++i) {
            c[i].transferOwnership(cfg.roles.owner);
        }
    }

    // ── output ────────────────────────────────────────────────────────────

    function _record(SpareConfig.Config memory cfg, Deployment memory d) internal {
        string memory json = _deploymentJson(cfg, d);
        string memory rel = _addressesPath();
        console2.log("");
        if (_broadcasting()) {
            vm.writeFile(string.concat(vm.projectRoot(), "/", rel), json);
            console2.log(string.concat("Wrote ", rel, ". Next: owner calls acceptOwnership() on all 7 contracts,"));
            console2.log("then re-run VerifyDeployment (docs/RUNBOOK.md).");
        } else {
            console2.log("Dry run: NO addresses file written. The deployment would record:");
        }
        console2.log(json);
    }
}
