// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {SpareAuth} from "../../src/SpareAuth.sol";
import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {RuleRegistry} from "../../src/RuleRegistry.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {ScreeningGate} from "../../src/ScreeningGate.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {CashPark} from "../../src/CashPark.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {UsdgParkAdapter} from "../../src/park/UsdgParkAdapter.sol";
import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {IAggregatorV3} from "../../src/interfaces/IExternal.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";

import {SpareConfig} from "./SpareConfig.sol";

/// @title SpareBase
/// @notice Shared by Deploy, VerifyDeployment and the dev scripts: the deployment
///         record, reading/writing contracts/addresses/<chainid>.json, and the full
///         wiring check. Deploy runs the same check on its own result before it
///         writes an addresses file, so a deploy and a later verification can never
///         disagree about what "correctly wired" means.
abstract contract SpareBase is Script {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    struct Deployment {
        address deployer;
        uint256 startBlock;
        AssetRegistry registry;
        RuleRegistry rules;
        ElectionRegistry elections;
        ScreeningGate screening;
        StockRouter router;
        CashPark park;
        FeeVault vault;
        SweepExecutor exec;
        UsdgParkAdapter usdgAdapter;
        SgovParkAdapter sgovAdapter;
    }

    uint256 internal constant MAINNET = 4663;

    /// @notice Longest heartbeat an asset may be registered with. The RHC equity
    ///         feeds post at least every 24 h; 2 h of slack, and no more, so a dead
    ///         feed reads STALE within about a day.
    uint32 internal constant MAX_HEARTBEAT = 26 hours;

    /// @notice v4 permission bits that let a hook change a swap's amounts (take a
    ///         cut of the input or output), not just set the fee or revert.
    uint160 internal constant RETURNS_DELTA_FLAGS = Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
        | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;

    /// @notice docs/GOVERNANCE.md: the 7 owned contracts belong to a
    ///         TimelockController with at least this delay.
    uint256 internal constant POLICY_MIN_DELAY = 48 hours;

    /// @notice One requirement on a config asset, with what was observed. Deploy and
    ///         AddAssets refuse on the first one broken; VerifyDeployment checks all.
    struct Rule {
        bool ok;
        string what;
    }

    uint256 internal _passed;
    uint256 internal _failed;
    uint256 internal _warned;
    uint256 internal _pendingOwnership;

    // ── reporting ──────────────────────────────────────────────────────────

    function _check(bool ok, string memory what) internal {
        if (ok) {
            ++_passed;
            console2.log(string.concat("  [ok]   ", what));
        } else {
            ++_failed;
            console2.log(string.concat("  [FAIL] ", what));
        }
    }

    function _warn(string memory what) internal {
        ++_warned;
        console2.log(string.concat("  [warn] ", what));
    }

    function _info(string memory what) internal pure {
        console2.log(string.concat("  [info] ", what));
    }

    function _section(string memory title) internal pure {
        console2.log("");
        console2.log(string.concat("== ", title));
    }

    // ── paths ──────────────────────────────────────────────────────────────

    function _addressesPath() internal view returns (string memory rel) {
        rel = vm.envOr("SPARE_ADDRESSES", string.concat("addresses/", vm.toString(block.chainid), ".json"));
    }

    // ── addresses file ─────────────────────────────────────────────────────

    function _readDeployment(string memory j) internal view returns (Deployment memory d) {
        d.deployer = vm.parseJsonAddress(j, ".deployer");
        d.startBlock = vm.parseJsonUint(j, ".startBlock");
        d.registry = AssetRegistry(vm.parseJsonAddress(j, ".contracts.AssetRegistry"));
        d.rules = RuleRegistry(vm.parseJsonAddress(j, ".contracts.RuleRegistry"));
        d.elections = ElectionRegistry(vm.parseJsonAddress(j, ".contracts.ElectionRegistry"));
        d.screening = ScreeningGate(vm.parseJsonAddress(j, ".contracts.ScreeningGate"));
        d.router = StockRouter(vm.parseJsonAddress(j, ".contracts.StockRouter"));
        d.park = CashPark(vm.parseJsonAddress(j, ".contracts.CashPark"));
        d.vault = FeeVault(vm.parseJsonAddress(j, ".contracts.FeeVault"));
        d.exec = SweepExecutor(vm.parseJsonAddress(j, ".contracts.SweepExecutor"));
        d.usdgAdapter = UsdgParkAdapter(vm.parseJsonAddress(j, ".contracts.UsdgParkAdapter"));
        if (vm.keyExistsJson(j, ".contracts.SgovParkAdapter")) {
            d.sgovAdapter = SgovParkAdapter(vm.parseJsonAddress(j, ".contracts.SgovParkAdapter"));
        }
    }

    /// @dev Virtual so test/script/ can hand a script a deployment built in memory.
    function _loadDeployment()
        internal
        view
        virtual
        returns (Deployment memory d, string memory json, string memory rel)
    {
        rel = _addressesPath();
        json = vm.readFile(string.concat(vm.projectRoot(), "/", rel));
        d = _readDeployment(json);
    }

    function _q(string memory s) private pure returns (string memory) {
        return string.concat("\"", s, "\"");
    }

    function _kv(string memory k, string memory v) private pure returns (string memory) {
        return string.concat("    ", _q(k), ": ", v);
    }

    function _addr(address a) private pure returns (string memory) {
        return _q(vm.toString(a));
    }

    /// @dev Hand-built so the key order is stable and the file diffs cleanly.
    function _deploymentJson(SpareConfig.Config memory cfg, Deployment memory d) internal view returns (string memory) {
        string memory contracts_ = string.concat(
            "  \"contracts\": {\n",
            _kv("AssetRegistry", _addr(address(d.registry))), ",\n",
            _kv("RuleRegistry", _addr(address(d.rules))), ",\n",
            _kv("ElectionRegistry", _addr(address(d.elections))), ",\n",
            _kv("ScreeningGate", _addr(address(d.screening))), ",\n",
            _kv("StockRouter", _addr(address(d.router))), ",\n"
        );
        contracts_ = string.concat(
            contracts_,
            _kv("CashPark", _addr(address(d.park))), ",\n",
            _kv("FeeVault", _addr(address(d.vault))), ",\n",
            _kv("SweepExecutor", _addr(address(d.exec))), ",\n",
            _kv("UsdgParkAdapter", _addr(address(d.usdgAdapter))), ",\n",
            _kv("SgovParkAdapter", _addr(address(d.sgovAdapter))), "\n  },\n"
        );

        string memory roles_ = string.concat(
            "  \"roles\": {\n",
            _kv("owner", _addr(cfg.roles.owner)), ",\n",
            _kv("keeper", _addr(cfg.roles.keeper)), ",\n",
            _kv("pauser", _addr(cfg.roles.pauser)), ",\n",
            _kv("attestor", _addr(cfg.roles.attestor)), "\n  },\n"
        );

        string memory external_ = string.concat(
            "  \"external\": {\n",
            _kv("USDG", _addr(cfg.usdg)), ",\n",
            _kv("Permit2", _addr(cfg.permit2)), ",\n",
            _kv("PoolManager", _addr(cfg.poolManager)), "\n  },\n"
        );

        string memory assets_ = "  \"assets\": {\n";
        for (uint256 i; i < cfg.assets.length; ++i) {
            assets_ = string.concat(
                assets_,
                _kv(cfg.assets[i].symbol, _addr(cfg.assets[i].token)),
                i + 1 < cfg.assets.length ? ",\n" : "\n"
            );
        }
        assets_ = string.concat(assets_, "  },\n");

        string memory head = string.concat(
            "{\n",
            "  \"chainId\": ", vm.toString(block.chainid), ",\n",
            "  \"network\": ", _q(cfg.network), ",\n",
            "  \"deployer\": ", _addr(d.deployer), ",\n",
            "  \"startBlock\": ", vm.toString(d.startBlock), ",\n",
            "  \"deployedAt\": ", vm.toString(block.timestamp), ",\n",
            "  \"config\": { \"source\": ", _q(cfg.source), ", \"hash\": ", _q(vm.toString(cfg.hash)), " },\n",
            "  \"parkAdapter\": { \"live\": \"UsdgParkAdapter\", \"standby\": ",
            cfg.deploySgovAdapter ? "\"SgovParkAdapter\"" : "null",
            " },\n"
        );
        return string.concat(head, contracts_, roles_, external_, assets_, "  \"screeningEnforced\": ",
            cfg.screeningEnforced ? "true" : "false", "\n}\n");
    }

    // ── owner kind ─────────────────────────────────────────────────────────

    /// @notice Whether `a` is a contract, i.e. acts only through calls made to it.
    ///         An EIP-7702 delegation designator (0xef0100 || address, 23 bytes) is
    ///         not: that account is an EOA and still signs with its own key.
    function _isContract(address a) internal view returns (bool) {
        bytes memory code = a.code;
        if (code.length == 0) return false;
        return code.length != 23 || bytes3(code) != 0xef0100;
    }

    /// @notice Whether `a` is a TimelockController (code, and getMinDelay() answers
    ///         one word). Such an owner acts only through a scheduled, delayed
    ///         operation: no key and no Safe can send its calls directly.
    function _timelockDelay(address a) internal view returns (bool isTimelock, uint256 minDelay) {
        if (a.code.length == 0) return (false, 0);
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeWithSignature("getMinDelay()"));
        if (!ok || ret.length != 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    // ── the check ──────────────────────────────────────────────────────────

    function _owned(Deployment memory d) internal pure returns (SpareAuth[7] memory c, string[7] memory n) {
        c = [
            SpareAuth(address(d.registry)),
            SpareAuth(address(d.elections)),
            SpareAuth(address(d.screening)),
            SpareAuth(address(d.router)),
            SpareAuth(address(d.park)),
            SpareAuth(address(d.vault)),
            SpareAuth(address(d.exec))
        ];
        n = ["AssetRegistry", "ElectionRegistry", "ScreeningGate", "StockRouter", "CashPark", "FeeVault", "SweepExecutor"];
    }

    /// @notice Assert every wire of a deployment against its config. Returns the
    ///         number of failed checks (0 = correctly wired).
    function _verify(SpareConfig.Config memory cfg, Deployment memory d) internal returns (uint256) {
        _passed = 0;
        _failed = 0;
        _warned = 0;
        _pendingOwnership = 0;

        _verifyCode(cfg, d);
        if (_failed != 0) return _failed; // nothing else is meaningful without code
        _verifyLinks(cfg, d);
        _verifyRoles(cfg, d);
        _verifyOwnership(cfg, d);
        _verifyGovernance(d, _requireTimelock());
        _verifyParams(cfg, d);
        _verifyAssets(cfg, d);
        _verifyMix(cfg, d);
        _verifyPark(cfg, d);

        console2.log("");
        console2.log(
            string.concat(
                "SUMMARY: ", vm.toString(_passed), " passed, ", vm.toString(_failed), " failed, ",
                vm.toString(_warned), " warnings; ownership pending acceptance on ",
                vm.toString(_pendingOwnership), "/7 contracts"
            )
        );
        return _failed;
    }

    function _verifyCode(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("code");
        _check(address(d.registry).code.length != 0, "AssetRegistry has code");
        _check(address(d.rules).code.length != 0, "RuleRegistry has code");
        _check(address(d.elections).code.length != 0, "ElectionRegistry has code");
        _check(address(d.screening).code.length != 0, "ScreeningGate has code");
        _check(address(d.router).code.length != 0, "StockRouter has code");
        _check(address(d.park).code.length != 0, "CashPark has code");
        _check(address(d.vault).code.length != 0, "FeeVault has code");
        _check(address(d.exec).code.length != 0, "SweepExecutor has code");
        _check(address(d.usdgAdapter).code.length != 0, "UsdgParkAdapter has code");
        if (cfg.deploySgovAdapter) {
            _check(address(d.sgovAdapter).code.length != 0, "SgovParkAdapter has code");
        } else {
            _check(address(d.sgovAdapter) == address(0), "no SgovParkAdapter (not configured)");
        }
    }

    function _verifyLinks(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("immutables / cross-links");
        _check(d.registry.usdg() == cfg.usdg, "AssetRegistry.usdg = USDG");
        _check(address(d.elections.registry()) == address(d.registry), "ElectionRegistry.registry = AssetRegistry");
        _check(address(d.router.poolManager()) == cfg.poolManager, "StockRouter.poolManager = v4 PoolManager");
        _check(address(d.router.registry()) == address(d.registry), "StockRouter.registry = AssetRegistry");
        _check(d.router.usdg() == cfg.usdg, "StockRouter.usdg = USDG");
        _check(address(d.park.usdg()) == cfg.usdg, "CashPark.usdg = USDG");
        _check(address(d.exec.permit2()) == cfg.permit2, "SweepExecutor.permit2 = Permit2");
        _check(address(d.exec.usdg()) == cfg.usdg, "SweepExecutor.usdg = USDG");
        _check(address(d.exec.rules()) == address(d.rules), "SweepExecutor.rules = RuleRegistry");
        _check(address(d.exec.elections()) == address(d.elections), "SweepExecutor.elections = ElectionRegistry");
        _check(address(d.exec.registry()) == address(d.registry), "SweepExecutor.registry = AssetRegistry");
        _check(address(d.exec.screening()) == address(d.screening), "SweepExecutor.screening = ScreeningGate");
        _check(address(d.exec.router()) == address(d.router), "SweepExecutor.router = StockRouter");
        _check(address(d.exec.cashPark()) == address(d.park), "SweepExecutor.cashPark = CashPark");
        _check(address(d.exec.feeVault()) == address(d.vault), "SweepExecutor.feeVault = FeeVault");
        _check(
            IERC20(cfg.usdg).allowance(address(d.exec), address(d.router)) >= type(uint256).max / 2,
            "SweepExecutor -> StockRouter USDG allowance effectively unlimited (USDG decrements even a max approval)"
        );
        _check(
            IERC20(cfg.usdg).allowance(address(d.exec), address(d.park)) >= type(uint256).max / 2,
            "SweepExecutor -> CashPark USDG allowance effectively unlimited (USDG decrements even a max approval)"
        );
    }

    function _verifyRoles(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("roles");
        address k = cfg.roles.keeper;
        _check(d.router.isCaller(address(d.exec)), "StockRouter caller: SweepExecutor");
        if (cfg.deploySgovAdapter) {
            _check(d.router.isCaller(address(d.sgovAdapter)), "StockRouter caller: SgovParkAdapter (pre-authorised)");
        }
        _check(!d.router.isCaller(address(d.usdgAdapter)), "StockRouter NOT caller: UsdgParkAdapter (never swaps)");
        _check(!d.router.isCaller(d.deployer), "StockRouter NOT caller: deployer");
        _check(!d.router.isCaller(k), "StockRouter NOT caller: keeper");
        _check(d.router.sequencerFeed() == cfg.sequencerFeed, "StockRouter.sequencerFeed = config");

        _check(d.park.executor() == address(d.exec), "CashPark.executor = SweepExecutor");
        _check(d.park.isKeeper(k), "CashPark keeper = config keeper");
        _check(d.exec.isKeeper(k), "SweepExecutor keeper = config keeper");
        if (d.deployer != k) {
            _check(!d.exec.isKeeper(d.deployer), "SweepExecutor: deployer is NOT a keeper");
            _check(!d.park.isKeeper(d.deployer), "CashPark: deployer is NOT a keeper");
        }

        _check(d.screening.attestor() == cfg.roles.attestor, "ScreeningGate.attestor = config attestor");
        _check(d.screening.enforced() == cfg.screeningEnforced, "ScreeningGate.enforced = config");

        (SpareAuth[7] memory c, string[7] memory n) = _owned(d);
        for (uint256 i; i < 7; ++i) {
            _check(c[i].pauser() == cfg.roles.pauser, string.concat(n[i], ".pauser = config pauser"));
            _check(!c[i].paused(), string.concat(n[i], " is not paused"));
        }
    }

    function _verifyOwnership(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("ownership (Ownable2Step)");
        (SpareAuth[7] memory c, string[7] memory n) = _owned(d);
        address want = cfg.roles.owner;
        for (uint256 i; i < 7; ++i) {
            address o = c[i].owner();
            address p = c[i].pendingOwner();
            if (o == want) {
                _check(p == address(0), string.concat(n[i], ": owner = config owner (accepted)"));
            } else {
                ++_pendingOwnership;
                _check(
                    o == d.deployer && p == want,
                    string.concat(n[i], ": pendingOwner = config owner, owner still deployer (awaiting acceptOwnership)")
                );
            }
        }
    }

    function _requireTimelock() internal view returns (bool) {
        return vm.envOr("SPARE_REQUIRE_TIMELOCK", false);
    }

    /// @notice The owner policy of docs/GOVERNANCE.md, one line per distinct owner:
    ///         a TimelockController with minDelay >= 48 h passes; an EOA, any other
    ///         contract, or a shorter delay is a warning, or a failure when `strict`
    ///         (SPARE_REQUIRE_TIMELOCK=true).
    function _verifyGovernance(Deployment memory d, bool strict) internal {
        _section("governance policy (owner = TimelockController, minDelay >= 48 h)");
        (SpareAuth[7] memory c,) = _owned(d);
        address[7] memory owners;
        address[7] memory pending;
        for (uint256 i; i < 7; ++i) {
            owners[i] = c[i].owner();
            pending[i] = c[i].pendingOwner();
        }
        for (uint256 i; i < 7; ++i) {
            if (_seenBefore(owners, i)) continue;
            (bool ok, string memory kind) = _ownerKind(owners[i]);
            string memory line = string.concat(
                "owner ", vm.toString(owners[i]), " (", vm.toString(_count(owners, owners[i])), "/7 contracts) is ", kind
            );
            if (ok || strict) _check(ok, line);
            else _warn(line);
        }
        for (uint256 i; i < 7; ++i) {
            if (pending[i] == address(0) || _seenBefore(pending, i)) continue;
            (, string memory kind) = _ownerKind(pending[i]);
            _info(
                string.concat(
                    "pending owner ", vm.toString(pending[i]), " (", vm.toString(_count(pending, pending[i])),
                    "/7 contracts) is ", kind
                )
            );
        }
    }

    function _ownerKind(address o) internal view returns (bool meetsPolicy, string memory kind) {
        if (!_isContract(o)) {
            return (false, "an EOA: its owner calls take effect at once (policy: a 48 h TimelockController, docs/GOVERNANCE.md)");
        }
        (bool isTimelock, uint256 minDelay) = _timelockDelay(o);
        if (!isTimelock) {
            return (false, "a contract that is not a TimelockController: no enforced delay (policy: 48 h)");
        }
        meetsPolicy = minDelay >= POLICY_MIN_DELAY;
        kind = string.concat(
            "a TimelockController, minDelay ", vm.toString(minDelay), " s ", meetsPolicy ? ">=" : "<", " 172800 s (48 h)"
        );
    }

    function _seenBefore(address[7] memory xs, uint256 i) private pure returns (bool) {
        for (uint256 j; j < i; ++j) {
            if (xs[j] == xs[i]) return true;
        }
        return false;
    }

    function _count(address[7] memory xs, address x) private pure returns (uint256 n) {
        for (uint256 i; i < 7; ++i) {
            if (xs[i] == x) ++n;
        }
    }

    function _verifyParams(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("SweepExecutor params");
        _check(d.exec.threshold() == cfg.params.threshold, string.concat("threshold = ", vm.toString(cfg.params.threshold)));
        _check(d.exec.feeBps() == cfg.params.feeBps, string.concat("feeBps = ", vm.toString(cfg.params.feeBps)));
        _check(
            d.exec.slippageBps() == cfg.params.slippageBps,
            string.concat("slippageBps = ", vm.toString(cfg.params.slippageBps))
        );
        _check(
            d.exec.epochLength() == cfg.params.epochLength,
            string.concat("epochLength = ", vm.toString(cfg.params.epochLength))
        );
        _check(
            d.exec.finalityBuffer() == cfg.params.finalityBuffer,
            string.concat("finalityBuffer = ", vm.toString(cfg.params.finalityBuffer))
        );
    }

    function _verifyAssets(SpareConfig.Config memory cfg, Deployment memory d) internal {
        _section("AssetRegistry");
        address[] memory toks = d.registry.tokens();
        _check(toks.length == cfg.assets.length, string.concat("registry holds exactly ", vm.toString(cfg.assets.length), " assets"));
        for (uint256 i; i < toks.length; ++i) {
            bool known;
            for (uint256 j; j < cfg.assets.length; ++j) {
                if (cfg.assets[j].token == toks[i]) known = true;
            }
            if (!known) _check(false, string.concat("unexpected registered token ", vm.toString(toks[i])));
        }
        for (uint256 i; i < cfg.assets.length; ++i) {
            _verifyAsset(cfg, d, cfg.assets[i]);
        }
    }

    function _verifyAsset(SpareConfig.Config memory cfg, Deployment memory d, SpareConfig.Asset memory a) private {
        string memory s = a.symbol;
        if (!d.registry.isRegistered(a.token)) {
            _check(false, string.concat(s, " registered"));
            return;
        }
        AssetRegistry.Asset memory r = d.registry.get(a.token);
        bool fieldsOk = r.token == a.token && r.feed == a.feed && r.heartbeat == a.heartbeat && r.bandBps == a.bandBps
            && r.feedDecimals == IAggregatorV3(a.feed).decimals();
        _check(fieldsOk, string.concat(s, ": feed / decimals / heartbeat / band match config"));
        _check(r.active == a.active, string.concat(s, a.active ? ": ACTIVE" : ": registered INACTIVE (by config)"));
        _check(
            keccak256(abi.encode(r.poolKey)) == keccak256(abi.encode(a.key)),
            string.concat(s, ": PoolKey = config (fee ", vm.toString(a.key.fee), ", tickSpacing ",
                vm.toString(a.key.tickSpacing), ", hooks ", vm.toString(address(a.key.hooks)), ")")
        );

        PoolId id = a.key.toId();
        (uint160 sqrtP,,,) = IPoolManager(cfg.poolManager).getSlot0(id);
        uint128 liq = IPoolManager(cfg.poolManager).getLiquidity(id);
        _check(sqrtP != 0, string.concat(s, ": pool initialised, id ", vm.toString(PoolId.unwrap(id))));
        if (a.active) _check(liq != 0, string.concat(s, ": in-range liquidity ", vm.toString(liq)));
        else _info(string.concat(s, ": in-range liquidity ", vm.toString(liq), " (inactive)"));
        if (address(a.key.hooks) != address(0)) {
            _check(address(a.key.hooks).code.length != 0, string.concat(s, ": hook has code"));
        }
        Rule[] memory rules = _assetRules(a);
        for (uint256 i; i < rules.length; ++i) {
            _check(rules[i].ok, string.concat(s, ": ", rules[i].what));
        }
        _reportHookFee(cfg, a);

        (OracleGuard.Status st, uint256 px) = d.router.oracleStatus(a.token);
        (,,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        string memory line = string.concat(
            s, ": oracle ", _status(st), ", price1e18 ", vm.toString(px), ", age ",
            vm.toString(block.timestamp >= updatedAt ? block.timestamp - updatedAt : 0), "s"
        );
        // STALE is the weekend, not a wiring fault: report it, never fail on it.
        if (st == OracleGuard.Status.OK) _info(line);
        else _warn(line);
    }

    // ── asset rules ────────────────────────────────────────────────────────

    /// @notice What AssetRegistry.setAsset does not check and SPARE relies on:
    ///         an 18-decimal token, a heartbeat of at most 26 h and, for a hooked
    ///         pool, a hook that can only set the fee or revert (no *_RETURNS_DELTA
    ///         permission), whose runtime code and fee authority are the ones the
    ///         config pinned, and whose keeper fee ceiling sits inside the band.
    function _assetRules(SpareConfig.Asset memory a) internal view returns (Rule[] memory rules) {
        Rule[] memory buf = new Rule[](6);
        uint256 n;

        (bool read, bytes memory ret) = a.token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!read || ret.length != 32) {
            buf[n++] = Rule({ok: false, what: "token decimals() unreadable (the router's math assumes 18)"});
        } else {
            uint256 dec = abi.decode(ret, (uint256));
            buf[n++] = Rule({
                ok: dec == 18,
                what: string.concat(
                    "token decimals ", vm.toString(dec), dec == 18 ? "" : ", not 18", " (the router's math assumes 18)"
                )
            });
        }

        bool hbOk = a.heartbeat <= MAX_HEARTBEAT;
        buf[n++] = Rule({
            ok: hbOk,
            what: string.concat("heartbeat ", vm.toString(a.heartbeat), " s ", hbOk ? "<=" : ">", " 93600 s (26 h ceiling)")
        });

        address h = address(a.key.hooks);
        if (h == address(0)) {
            if (a.hookCodehash != 0 || a.hookAuthority != address(0) || a.hookMaxFeePips != 0) {
                buf[n++] = Rule({ok: false, what: "hookCodehash / hookAuthority / hookMaxFeePips set for a hookless pool"});
            }
        } else {
            uint160 flags = uint160(h) & Hooks.ALL_HOOK_MASK;
            bool feeOnly = flags & RETURNS_DELTA_FLAGS == 0;
            buf[n++] = Rule({
                ok: feeOnly,
                what: string.concat(
                    "hook flags ",
                    vm.toString(abi.encodePacked(uint16(flags))),
                    feeOnly
                        ? ": no *_RETURNS_DELTA permission (it can set the fee or revert, not move amounts)"
                        : ": a *_RETURNS_DELTA permission (it could take a cut of the swap)"
                )
            });

            bytes32 code = h.codehash;
            bool pinned = a.hookCodehash != 0;
            buf[n++] = Rule({
                ok: pinned && code == a.hookCodehash,
                what: string.concat(
                    "hook codehash ",
                    vm.toString(code),
                    !pinned
                        ? " is not pinned (config hookCodehash)"
                        : code == a.hookCodehash ? " = config" : string.concat(" != config ", vm.toString(a.hookCodehash))
                )
            });

            if (a.hookAuthority != address(0)) {
                (read, ret) = h.staticcall(abi.encodeWithSignature("authority()"));
                if (!read || ret.length != 32 || abi.decode(ret, (uint256)) >> 160 != 0) {
                    buf[n++] = Rule({
                        ok: false,
                        what: string.concat("hook authority() unreadable; config pins ", vm.toString(a.hookAuthority))
                    });
                } else {
                    address auth = abi.decode(ret, (address));
                    buf[n++] = Rule({
                        ok: auth == a.hookAuthority,
                        what: string.concat(
                            "hook authority ",
                            vm.toString(auth),
                            auth == a.hookAuthority ? " = config" : string.concat(" != config ", vm.toString(a.hookAuthority))
                        )
                    });
                }
            }

            if (a.hookMaxFeePips != 0) {
                uint256 bandPips = uint256(a.bandBps) * 100;
                bool inside = a.hookMaxFeePips < bandPips;
                buf[n++] = Rule({
                    ok: inside,
                    what: string.concat(
                        "keeper's hook fee ceiling ", vm.toString(a.hookMaxFeePips), " pips ", inside ? "<" : ">=", " band ",
                        vm.toString(bandPips), " pips (", vm.toString(a.bandBps), " bps)"
                    )
                });
            }
        }

        rules = new Rule[](n);
        for (uint256 i; i < n; ++i) {
            rules[i] = buf[i];
        }
    }

    /// @return broken whether any rule fails; `what` names the first that does
    function _firstBroken(Rule[] memory rules) internal pure returns (bool broken, string memory what) {
        for (uint256 i; i < rules.length; ++i) {
            if (!rules[i].ok) return (true, rules[i].what);
        }
    }

    /// @dev The MU and GME hooks expose currentFee(PoolId, zeroForOne) and
    ///      maxFee(PoolId); for a hook that answers both, report the fee a buy pays
    ///      now against the pool's cap and the keeper's ceiling. Above the ceiling
    ///      is a warning (a liveness matter: the band defers what the keeper does
    ///      not hold), never a failure.
    function _reportHookFee(SpareConfig.Config memory cfg, SpareConfig.Asset memory a) internal {
        address h = address(a.key.hooks);
        if (h == address(0) || h.code.length == 0) return;
        bytes32 id = PoolId.unwrap(a.key.toId());
        bool buyZeroForOne = Currency.unwrap(a.key.currency0) == cfg.usdg;
        (bool ok1, bytes memory fee) = h.staticcall(abi.encodeWithSignature("currentFee(bytes32,bool)", id, buyZeroForOne));
        (bool ok2, bytes memory cap) = h.staticcall(abi.encodeWithSignature("maxFee(bytes32)", id));
        if (!ok1 || !ok2 || fee.length != 32 || cap.length != 32) return;
        uint256 feeNow = abi.decode(fee, (uint256));
        string memory line = string.concat(
            a.symbol, ": hook fee for a buy now ", vm.toString(feeNow), " pips, pool cap ",
            vm.toString(abi.decode(cap, (uint256))), " pips"
        );
        if (a.hookMaxFeePips == 0) {
            _info(line);
        } else if (feeNow <= a.hookMaxFeePips) {
            _info(string.concat(line, ", keeper ceiling ", vm.toString(a.hookMaxFeePips), " pips"));
        } else {
            _warn(string.concat(line, " - above the keeper ceiling ", vm.toString(a.hookMaxFeePips), " pips"));
        }
    }

    function _verifyMix(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("default mix");
        ElectionRegistry.Leg[] memory m = d.elections.defaultMix();
        _check(m.length == cfg.defaultMix.length, string.concat("default mix has ", vm.toString(cfg.defaultMix.length), " legs"));
        uint256 n = m.length < cfg.defaultMix.length ? m.length : cfg.defaultMix.length;
        for (uint256 i; i < n; ++i) {
            _check(
                m[i].asset == cfg.defaultMix[i].token && m[i].bps == cfg.defaultMix[i].bps,
                string.concat("leg ", vm.toString(i), ": ", cfg.defaultMix[i].symbol, " ", vm.toString(cfg.defaultMix[i].bps), " bps")
            );
        }
    }

    function _verifyPark(SpareConfig.Config memory cfg, Deployment memory d) private {
        _section("CashPark adapters");
        string memory expect = vm.envOr("SPARE_EXPECT_PARK_ADAPTER", string("usdg"));
        bool wantSgov = keccak256(bytes(expect)) == keccak256("sgov");
        address live = address(d.park.adapter());
        if (wantSgov) {
            _check(live == address(d.sgovAdapter) && live != address(0), "CashPark.adapter = SgovParkAdapter (post-switch)");
        } else {
            _check(live == address(d.usdgAdapter), "CashPark.adapter = UsdgParkAdapter (launch default)");
        }
        _check(d.usdgAdapter.usdg() == cfg.usdg, "UsdgParkAdapter.usdg = USDG");
        _check(d.usdgAdapter.park() == address(d.park), "UsdgParkAdapter.park = CashPark");
        _check(d.usdgAdapter.underlying() == cfg.usdg, "UsdgParkAdapter.underlying = USDG");
        if (cfg.deploySgovAdapter) {
            SgovParkAdapter g = d.sgovAdapter;
            _check(g.usdg() == cfg.usdg, "SgovParkAdapter.usdg = USDG");
            _check(g.sgov() == cfg.sgov, "SgovParkAdapter.sgov = config SGOV");
            _check(g.park() == address(d.park), "SgovParkAdapter.park = CashPark");
            _check(address(g.router()) == address(d.router), "SgovParkAdapter.router = StockRouter");
            _check(address(g.registry()) == address(d.registry), "SgovParkAdapter.registry = AssetRegistry");
            _check(g.slippageBps() == cfg.sgovSlippageBps, "SgovParkAdapter.slippageBps = config");
            _check(
                IERC20(cfg.usdg).allowance(address(g), address(d.router)) >= type(uint256).max / 2
                    && IERC20(cfg.sgov).allowance(address(g), address(d.router)) >= type(uint256).max / 2,
                "SgovParkAdapter -> StockRouter USDG + SGOV allowances effectively unlimited"
            );
            _check(d.registry.isRegistered(cfg.sgov), "SGOV registered (adapter prerequisite)");
            if (!d.registry.isEligible(cfg.sgov)) _warn("SGOV is INACTIVE: SgovParkAdapter.deposit would revert");
        }
        _info(
            string.concat(
                "CashPark totals: pending ", vm.toString(d.park.totalPending()), ", units ",
                vm.toString(d.park.totalUnits())
            )
        );
    }

    function _status(OracleGuard.Status s) internal pure returns (string memory) {
        if (s == OracleGuard.Status.OK) return "OK";
        if (s == OracleGuard.Status.STALE) return "STALE";
        if (s == OracleGuard.Status.PAUSED) return "PAUSED";
        if (s == OracleGuard.Status.SEQUENCER_DOWN) return "SEQUENCER_DOWN";
        return "BAD_ANSWER";
    }
}
