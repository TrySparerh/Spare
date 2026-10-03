// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {AssetRegistry} from "../src/AssetRegistry.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

import {SpareBase} from "./lib/SpareBase.sol";
import {SpareConfig} from "./lib/SpareConfig.sol";

/// @title AddAssets
/// @notice Brings an existing deployment's AssetRegistry in line with the config's
///         `assets` list: registers every asset that is missing, re-pins any whose
///         PoolKey / feed / heartbeat / band (or the feed's decimals) differs from
///         on-chain, and sets `active` to match. Idempotent: when the registry already
///         matches, it prints "0 actions" and sends nothing.
///
/// @dev Run through the wrapper so the config is loaded (fs_permissions only grants
///      ./addresses):
///
///        # dry run against mainnet: prints the exact actions, sends nothing
///        scripts/spare-forge.sh AddAssets --rpc-url "$RHC_RPC_URL" --sender <registry owner>
///        # apply (owner key; on 4663 also SPARE_MAINNET_ACK=owner-approved)
///        scripts/spare-forge.sh AddAssets --rpc-url "$RHC_RPC_URL" --broadcast --private-key ...
///
///      When AssetRegistry.owner() is a CONTRACT (after docs/GOVERNANCE.md, the 48 h
///      TimelockController) no key can send its calls, so the script never broadcasts.
///      (An EIP-7702-delegated owner is still an EOA: it keeps the EOA path.)
///      Run it without --broadcast (any --sender): after the same guards and plan it
///      prints the actions as TIMELOCK_CALLS_JSON, [{"to","value","data"}, ...] in
///      order, which script/governance/TimelockBatch.s.sol takes as
///      SPARE_TIMELOCK_CALLS_JSON (with the printed TIMELOCK_SALT) so the owner Safe
///      can schedule them. Before printing, it simulates exactly those calls as the
///      owner and re-plans: the batch is shown to bring the registry in line with the
///      config before anyone signs it.
///
///      Guards (all checked before anything is sent):
///        - the sender must be AssetRegistry.owner(), dry run included (an EOA owner)
///        - config chainId = RPC chain; registry.usdg = config USDG
///        - every config asset: token / feed / hook have code, feed decimals 1..18,
///          heartbeat 1..26 h, band 1..1000, PoolKey sorted USDG/token, pool
///          initialised, and an ACTIVE asset's pool has in-range liquidity
///        - every config asset meets SpareBase._assetRules: token decimals 18; a
///          hook has no *_RETURNS_DELTA permission, its codehash equals the config's
///          hookCodehash (required), its authority() the config's hookAuthority (when
///          set), and hookMaxFeePips (when set) is below the asset's band
///        - every defaultMix leg is active in the config
///        - never deactivates the live park adapter's asset (SGOV while SgovParkAdapter
///          is CashPark.adapter)
///        - broadcasting on 4663 needs SPARE_MAINNET_ACK=owner-approved
///      Order per asset: deactivate (if going inactive) -> setAsset -> activate, so an
///      asset is never active on a pool the config did not approve. setAsset on an
///      active asset keeps it active (one tx re-pins it). The registry has no
///      deregister, so a registered token missing from the config is only reported.
///      After applying, every config asset is re-checked against the registry.
contract AddAssets is SpareBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    string internal constant MAINNET_ACK = "owner-approved";

    enum Kind {
        Deactivate,
        SetAsset,
        Activate
    }

    struct Action {
        Kind kind;
        uint256 asset; // index into cfg.assets
        string why;
    }

    /// @notice TimelockBatch.s.sol parses at most this many calls per batch.
    uint256 internal constant MAX_TIMELOCK_CALLS = 64;

    error Refused(string why);

    function run() external returns (uint256 nActions) {
        (nActions,) = _run();
    }

    /// @return nActions   actions planned (sent, simulated, or printed for the owner)
    /// @return callsJson  the plan as TimelockBatch's SPARE_TIMELOCK_CALLS_JSON when the
    ///                    registry owner is a contract; empty otherwise
    function _run() internal returns (uint256 nActions, string memory callsJson) {
        SpareConfig.Config memory cfg = _loadConfig();
        (Deployment memory d,, string memory rel) = _loadDeployment();
        AssetRegistry reg = d.registry;

        // Resolve the broadcaster; nothing is sent in this bracket.
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        vm.stopBroadcast();
        address owner = reg.owner();
        bool ownerIsContract = _isContract(owner);

        console2.log("SPARE AddAssets");
        console2.log("  chain        ", block.chainid);
        console2.log("  config       ", cfg.source);
        console2.log("  config hash  ", vm.toString(cfg.hash));
        console2.log("  addresses    ", rel);
        console2.log("  AssetRegistry", address(reg));
        console2.log("  owner        ", owner);
        console2.log("  sender       ", sender);
        console2.log("  mode         ", _broadcasting() ? "BROADCAST" : "dry run (simulation only)");

        if (block.chainid != cfg.chainId) {
            revert Refused(
                string.concat("config is for chain ", vm.toString(cfg.chainId), ", RPC is chain ", vm.toString(block.chainid))
            );
        }
        if (address(reg).code.length == 0) revert Refused("AssetRegistry has no code at the recorded address");
        if (ownerIsContract) {
            if (_broadcasting()) {
                revert Refused(
                    string.concat(
                        "the AssetRegistry owner is a contract (the timelock): no key can send its calls. Run without",
                        " --broadcast and schedule the printed TIMELOCK_CALLS_JSON with script/governance/TimelockBatch.s.sol"
                    )
                );
            }
        } else if (sender != owner) {
            revert Refused(
                string.concat(
                    "sender ", vm.toString(sender), " is not the AssetRegistry owner ", vm.toString(owner),
                    " (dry run: pass --sender <owner>)"
                )
            );
        }
        if (block.chainid == MAINNET && _broadcasting()) {
            string memory ack = vm.envOr("SPARE_MAINNET_ACK", string(""));
            if (keccak256(bytes(ack)) != keccak256(bytes(MAINNET_ACK))) {
                revert Refused("chain 4663 BROADCAST needs SPARE_MAINNET_ACK=owner-approved");
            }
        }

        _preflight(cfg, d);
        _reportUnknown(cfg, reg);

        Action[] memory plan = _plan(cfg, reg);
        nActions = plan.length;

        _section("plan");
        if (nActions == 0) {
            console2.log(
                string.concat(
                    "AddAssets: 0 actions - registry already matches config (", vm.toString(cfg.assets.length), " assets)"
                )
            );
            return (0, "");
        }
        for (uint256 i; i < nActions; ++i) {
            _printAction(cfg, i + 1, plan[i]);
        }
        if (ownerIsContract) return (nActions, _forOwnerContract(cfg, reg, owner, plan));

        vm.startBroadcast();
        for (uint256 i; i < nActions; ++i) {
            Action memory a = plan[i];
            SpareConfig.Asset memory s = cfg.assets[a.asset];
            if (a.kind == Kind.SetAsset) reg.setAsset(s.token, s.feed, s.heartbeat, s.bandBps, s.key);
            else reg.setActive(s.token, a.kind == Kind.Activate);
        }
        vm.stopBroadcast();

        // Post-check: the registry must now match the config exactly.
        Action[] memory left = _plan(cfg, reg);
        if (left.length != 0) revert Refused(string.concat(vm.toString(left.length), " action(s) still pending after apply"));
        _section("result");
        console2.log(
            string.concat(
                "AddAssets: ", vm.toString(nActions), " action(s) ",
                _broadcasting() ? "sent" : "simulated (dry run - nothing sent)", "; registry matches config for all ",
                vm.toString(cfg.assets.length), " assets"
            )
        );
    }

    /// @dev Overridden by test/script/, which builds the config in memory.
    function _loadConfig() internal view virtual returns (SpareConfig.Config memory) {
        return SpareConfig.load();
    }

    // ── an owner contract (the timelock) ─────────────────────────────────

    /// @dev Nothing is broadcast: prints the plan for the owner to schedule, after
    ///      proving on the simulated state that those calls, sent in order by the
    ///      owner, leave nothing to do.
    function _forOwnerContract(SpareConfig.Config memory cfg, AssetRegistry reg, address owner, Action[] memory plan)
        internal
        returns (string memory json)
    {
        if (plan.length > MAX_TIMELOCK_CALLS) {
            revert Refused(
                string.concat(
                    vm.toString(plan.length), " actions exceed the ", vm.toString(MAX_TIMELOCK_CALLS),
                    "-call timelock batch; apply the config change in smaller steps"
                )
            );
        }
        bytes[] memory data = new bytes[](plan.length);
        for (uint256 i; i < plan.length; ++i) {
            data[i] = _calldata(cfg, plan[i]);
            json = string.concat(
                json, i == 0 ? "[" : ",", "{\"to\":\"", vm.toString(address(reg)), "\",\"value\":\"0\",\"data\":\"",
                vm.toString(data[i]), "\"}"
            );
        }
        json = string.concat(json, "]");

        vm.startPrank(owner);
        for (uint256 i; i < plan.length; ++i) {
            (bool ok, bytes memory ret) = address(reg).call(data[i]);
            if (!ok) {
                revert Refused(
                    string.concat("call ", vm.toString(i + 1), " reverts when the owner sends it: ", vm.toString(ret))
                );
            }
        }
        vm.stopPrank();
        Action[] memory left = _plan(cfg, reg);
        if (left.length != 0) {
            revert Refused(string.concat(vm.toString(left.length), " action(s) still pending after the simulated batch"));
        }

        (bool isTimelock, uint256 minDelay) = _timelockDelay(owner);
        string memory salt = string.concat("AddAssets ", vm.toString(cfg.hash));
        _section("for the owner contract (nothing sent)");
        console2.log(
            string.concat(
                "Simulated the ", vm.toString(plan.length), " call(s) above as the owner ", vm.toString(owner),
                ", in order: registry matches config for all ", vm.toString(cfg.assets.length), " assets"
            )
        );
        console2.log(string.concat("TIMELOCK_CALLS_JSON ", json));
        console2.log(string.concat("TIMELOCK_SALT ", salt));
        if (isTimelock) {
            console2.log(
                string.concat(
                    "The owner is a TimelockController (minDelay ", vm.toString(minDelay),
                    " s). The owner Safe schedules this batch, then executes it once Ready:"
                )
            );
            console2.log(
                string.concat(
                    "  SPARE_TIMELOCK=", vm.toString(owner),
                    " SPARE_TIMELOCK_BLOCK=<its deploy block> SPARE_OWNER_SAFE=<owner Safe> \\"
                )
            );
            console2.log(string.concat("  SPARE_TIMELOCK_CALLS_JSON='", json, "' \\"));
            console2.log(string.concat("  SPARE_TIMELOCK_SALT='", salt, "' \\"));
            console2.log("    forge script script/governance/TimelockBatch.s.sol --skip test --rpc-url \"$RHC_RPC_URL\"");
            console2.log("Same calls + same salt = same operation id; re-run this script before EXECUTE to confirm the");
            console2.log("plan is unchanged. If that operation is already Done, choose a new salt label.");
        } else {
            console2.log("The owner is a contract but not a TimelockController: it must send these calls itself, in order.");
        }
    }

    // ── planning ───────────────────────────────────────────────────────────

    function _plan(SpareConfig.Config memory cfg, AssetRegistry reg) internal view returns (Action[] memory out) {
        Action[] memory buf = new Action[](cfg.assets.length * 3);
        uint256 n;
        for (uint256 i; i < cfg.assets.length; ++i) {
            SpareConfig.Asset memory a = cfg.assets[i];
            bool registered = reg.isRegistered(a.token);
            bool onActive;
            string memory why;
            if (!registered) {
                why = "not registered";
            } else {
                AssetRegistry.Asset memory r = reg.get(a.token);
                onActive = r.active;
                why = _differences(a, r);
            }
            if (!a.active && onActive) {
                buf[n++] = Action({kind: Kind.Deactivate, asset: i, why: "config active=false, on-chain active=true"});
            }
            if (bytes(why).length != 0) buf[n++] = Action({kind: Kind.SetAsset, asset: i, why: why});
            if (a.active && !onActive) {
                buf[n++] = Action({
                    kind: Kind.Activate,
                    asset: i,
                    why: registered ? "config active=true, on-chain inactive" : "config active=true (setAsset registers INACTIVE)"
                });
            }
        }
        out = new Action[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = buf[i];
        }
    }

    function _differences(SpareConfig.Asset memory a, AssetRegistry.Asset memory r)
        internal
        view
        returns (string memory why)
    {
        if (r.feed != a.feed) why = _join(why, string.concat("feed ", vm.toString(r.feed), " -> ", vm.toString(a.feed)));
        if (r.heartbeat != a.heartbeat) {
            why = _join(why, string.concat("heartbeat ", vm.toString(r.heartbeat), " -> ", vm.toString(a.heartbeat)));
        }
        if (r.bandBps != a.bandBps) {
            why = _join(why, string.concat("bandBps ", vm.toString(r.bandBps), " -> ", vm.toString(a.bandBps)));
        }
        if (keccak256(abi.encode(r.poolKey)) != keccak256(abi.encode(a.key))) {
            why = _join(why, string.concat("PoolKey ", _keyStr(r.poolKey), " -> ", _keyStr(a.key)));
        }
        if (r.feed == a.feed && r.feedDecimals != IAggregatorV3(a.feed).decimals()) {
            why = _join(why, "feed decimals changed (re-cache)");
        }
    }

    // ── guards ─────────────────────────────────────────────────────────────

    function _preflight(SpareConfig.Config memory cfg, Deployment memory d) internal view {
        if (d.registry.usdg() != cfg.usdg) revert Refused("AssetRegistry.usdg != config core.usdg");
        SpareConfig.Asset[] memory as_ = cfg.assets;
        if (as_.length == 0) revert Refused("config has no assets");
        for (uint256 i; i < as_.length; ++i) {
            SpareConfig.Asset memory a = as_[i];
            string memory s = a.symbol;
            for (uint256 j; j < i; ++j) {
                if (as_[j].token == a.token || keccak256(bytes(as_[j].symbol)) == keccak256(bytes(s))) {
                    revert Refused(string.concat("duplicate asset ", s));
                }
            }
            if (a.token.code.length == 0) revert Refused(string.concat(s, ": token has no code"));
            if (a.feed.code.length == 0) revert Refused(string.concat(s, ": feed has no code"));
            uint8 dec = IAggregatorV3(a.feed).decimals();
            if (dec == 0 || dec > 18) revert Refused(string.concat(s, ": feed decimals out of range"));
            if (a.heartbeat == 0) revert Refused(string.concat(s, ": heartbeat 0"));
            if (a.bandBps == 0 || a.bandBps > d.registry.MAX_BAND_BPS()) {
                revert Refused(string.concat(s, ": bandBps out of range"));
            }
            address c0 = Currency.unwrap(a.key.currency0);
            address c1 = Currency.unwrap(a.key.currency1);
            bool pair = (c0 == cfg.usdg && c1 == a.token) || (c0 == a.token && c1 == cfg.usdg);
            if (!pair || c0 >= c1) revert Refused(string.concat(s, ": PoolKey is not sorted USDG/token"));
            address h = address(a.key.hooks);
            if (h != address(0) && h.code.length == 0) revert Refused(string.concat(s, ": hook has no code"));
            (bool broken, string memory why) = _firstBroken(_assetRules(a));
            if (broken) revert Refused(string.concat(s, ": ", why));
            PoolId id = a.key.toId();
            (uint160 sqrtP,,,) = IPoolManager(cfg.poolManager).getSlot0(id);
            if (sqrtP == 0) revert Refused(string.concat(s, ": pool not initialised (wrong PoolKey?)"));
            if (a.active && IPoolManager(cfg.poolManager).getLiquidity(id) == 0) {
                revert Refused(string.concat(s, ": active asset's pool has no in-range liquidity"));
            }
        }
        for (uint256 i; i < cfg.defaultMix.length; ++i) {
            uint256 k = SpareConfig.indexOf(as_, cfg.defaultMix[i].symbol);
            if (!as_[k].active) revert Refused(string.concat("defaultMix leg is inactive in config: ", as_[k].symbol));
        }
        if (address(d.sgovAdapter) != address(0) && address(d.park.adapter()) == address(d.sgovAdapter)) {
            address sgov = d.sgovAdapter.sgov();
            for (uint256 i; i < as_.length; ++i) {
                if (as_[i].token == sgov && !as_[i].active) {
                    revert Refused("SgovParkAdapter is the live park adapter; its asset (SGOV) must stay active");
                }
            }
        }
        console2.log("Preflight passed.");
    }

    function _reportUnknown(SpareConfig.Config memory cfg, AssetRegistry reg) internal view {
        address[] memory toks = reg.tokens();
        for (uint256 i; i < toks.length; ++i) {
            bool known;
            for (uint256 j; j < cfg.assets.length; ++j) {
                if (cfg.assets[j].token == toks[i]) known = true;
            }
            if (!known) {
                console2.log(
                    string.concat(
                        "  [warn] registered on-chain but absent from config: ", vm.toString(toks[i]),
                        reg.isEligible(toks[i]) ? " (ACTIVE)" : " (inactive)", " - AddAssets never deregisters"
                    )
                );
            }
        }
    }

    // ── output ─────────────────────────────────────────────────────────────

    function _printAction(SpareConfig.Config memory cfg, uint256 n, Action memory a) internal pure {
        SpareConfig.Asset memory s = cfg.assets[a.asset];
        string memory what;
        if (a.kind == Kind.SetAsset) {
            what = string.concat(
                "setAsset(", s.symbol, " ", vm.toString(s.token), ", feed ", vm.toString(s.feed), ", heartbeat ",
                vm.toString(s.heartbeat), ", bandBps ", vm.toString(s.bandBps), ", ", _keyStr(s.key), ")"
            );
        } else {
            what = string.concat(
                "setActive(", s.symbol, " ", vm.toString(s.token), a.kind == Kind.Activate ? ", true)" : ", false)"
            );
        }
        console2.log(string.concat("  [", vm.toString(n), "] AssetRegistry.", what));
        console2.log(string.concat("      why: ", a.why));
        console2.log(string.concat("      calldata: ", vm.toString(_calldata(cfg, a))));
    }

    /// @dev The exact AssetRegistry call for one action.
    function _calldata(SpareConfig.Config memory cfg, Action memory a) internal pure returns (bytes memory) {
        SpareConfig.Asset memory s = cfg.assets[a.asset];
        if (a.kind == Kind.SetAsset) {
            return abi.encodeCall(AssetRegistry.setAsset, (s.token, s.feed, s.heartbeat, s.bandBps, s.key));
        }
        return abi.encodeCall(AssetRegistry.setActive, (s.token, a.kind == Kind.Activate));
    }

    function _keyStr(PoolKey memory k) internal pure returns (string memory) {
        return string.concat(
            "key{", vm.toString(Currency.unwrap(k.currency0)), "/", vm.toString(Currency.unwrap(k.currency1)), " fee ",
            vm.toString(uint256(k.fee)), " ts ", vm.toString(int256(k.tickSpacing)), " hooks ", vm.toString(address(k.hooks)),
            "}"
        );
    }

    function _join(string memory a, string memory b) internal pure returns (string memory) {
        return bytes(a).length == 0 ? b : string.concat(a, "; ", b);
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }
}
