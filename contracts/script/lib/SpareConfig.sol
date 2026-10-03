// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

/// @title SpareConfig
/// @notice Loads a SPARE deploy config (contracts/config/<chainid>.json) into a struct.
/// @dev WHERE THE JSON COMES FROM, in order:
///        1. env SPARE_CONFIG_JSON — the file's contents. The wrappers in scripts/
///           set this, so a config outside ./config works too (Foundry ignores
///           FOUNDRY_FS_PERMISSIONS from the environment).
///        2. vm.readFile(SPARE_CONFIG, default "config/<chainid>.json") —
///           foundry.toml's fs_permissions grants read on ./config.
///      Either way the content hash is recorded, so a deployment can be tied back
///      to the exact bytes it was built from.
library SpareConfig {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev The three hook* fields pin a hooked pool's third-party hook; all are
    ///      optional in the JSON and read as zero when absent. hookCodehash is the
    ///      keccak of the hook's runtime code, hookAuthority the account its fee
    ///      setters answer to, hookMaxFeePips the highest fee (pips, 1e6 = 100%)
    ///      the keeper will swap through on that pool.
    struct Asset {
        string symbol;
        address token;
        address feed;
        uint32 heartbeat;
        uint16 bandBps;
        bool active;
        PoolKey key;
        bytes32 hookCodehash;
        address hookAuthority;
        uint24 hookMaxFeePips;
    }

    struct MixLeg {
        string symbol;
        address token;
        uint16 bps;
    }

    struct Roles {
        address owner;
        address keeper;
        address pauser;
        address attestor;
    }

    struct Params {
        uint256 threshold;
        uint16 feeBps;
        uint16 slippageBps;
        uint64 epochLength;
        uint256 finalityBuffer;
    }

    struct Config {
        string source;
        bytes32 hash;
        string network;
        uint256 chainId;
        address usdg;
        address permit2;
        address poolManager;
        Roles roles;
        bool screeningEnforced;
        address sequencerFeed;
        Params params;
        bool deploySgovAdapter;
        string sgovSymbol;
        address sgov;
        uint16 sgovSlippageBps;
        Asset[] assets;
        MixLeg[] defaultMix;
    }

    uint256 internal constant MAX_ASSETS = 64;

    error ConfigUnreadable(string path);
    error UnknownSymbol(string symbol);
    error OutOfRange(string field);

    function load() internal view returns (Config memory c) {
        (string memory json, string memory source) = _read();
        return parse(json, source);
    }

    /// @notice A config from its JSON text; `source` is only recorded.
    function parse(string memory json, string memory source) internal view returns (Config memory c) {
        c.source = source;
        c.hash = keccak256(bytes(json));
        _parse(json, c);
    }

    function _read() private view returns (string memory json, string memory source) {
        string memory rel = vm.envOr("SPARE_CONFIG", string.concat("config/", vm.toString(block.chainid), ".json"));
        json = vm.envOr("SPARE_CONFIG_JSON", string(""));
        if (bytes(json).length != 0) return (json, rel);
        string memory path = string.concat(vm.projectRoot(), "/", rel);
        try vm.readFile(path) returns (string memory s) {
            return (s, rel);
        } catch {
            revert ConfigUnreadable(rel);
        }
    }

    function _parse(string memory j, Config memory c) private view {
        c.network = vm.parseJsonString(j, ".network");
        c.chainId = vm.parseJsonUint(j, ".chainId");

        c.usdg = vm.parseJsonAddress(j, ".core.usdg");
        c.permit2 = vm.parseJsonAddress(j, ".core.permit2");
        c.poolManager = vm.parseJsonAddress(j, ".core.poolManager");

        c.roles = Roles({
            owner: vm.parseJsonAddress(j, ".roles.owner"),
            keeper: vm.parseJsonAddress(j, ".roles.keeper"),
            pauser: vm.parseJsonAddress(j, ".roles.pauser"),
            attestor: vm.parseJsonAddress(j, ".roles.attestor")
        });

        c.screeningEnforced = vm.parseJsonBool(j, ".screening.enforced");
        c.sequencerFeed = vm.parseJsonAddress(j, ".router.sequencerFeed");

        c.params = Params({
            threshold: vm.parseJsonUint(j, ".params.thresholdUsdg"),
            feeBps: _u16(vm.parseJsonUint(j, ".params.feeBps"), "params.feeBps"),
            slippageBps: _u16(vm.parseJsonUint(j, ".params.slippageBps"), "params.slippageBps"),
            epochLength: _u64(vm.parseJsonUint(j, ".params.epochSeconds"), "params.epochSeconds"),
            finalityBuffer: vm.parseJsonUint(j, ".params.finalityBuffer")
        });

        c.deploySgovAdapter = vm.parseJsonBool(j, ".park.deploySgovAdapter");
        c.sgovSymbol = vm.parseJsonString(j, ".park.sgovSymbol");
        c.sgovSlippageBps = _u16(vm.parseJsonUint(j, ".park.sgovSlippageBps"), "park.sgovSlippageBps");

        c.assets = _assets(j);
        c.defaultMix = _mix(j, c.assets);
        if (c.deploySgovAdapter) c.sgov = tokenOf(c.assets, c.sgovSymbol);
    }

    function _assets(string memory j) private view returns (Asset[] memory out) {
        uint256 n;
        while (n < MAX_ASSETS && vm.keyExistsJson(j, string.concat(".assets[", vm.toString(n), "]"))) ++n;
        out = new Asset[](n);
        for (uint256 i; i < n; ++i) {
            string memory p = string.concat(".assets[", vm.toString(i), "]");
            Asset memory a = out[i];
            a.symbol = vm.parseJsonString(j, string.concat(p, ".symbol"));
            a.token = vm.parseJsonAddress(j, string.concat(p, ".token"));
            a.feed = vm.parseJsonAddress(j, string.concat(p, ".feed"));
            a.heartbeat = _u32(vm.parseJsonUint(j, string.concat(p, ".heartbeat")), "asset.heartbeat");
            a.bandBps = _u16(vm.parseJsonUint(j, string.concat(p, ".bandBps")), "asset.bandBps");
            a.active = vm.parseJsonBool(j, string.concat(p, ".active"));
            a.key = PoolKey({
                currency0: Currency.wrap(vm.parseJsonAddress(j, string.concat(p, ".poolKey.currency0"))),
                currency1: Currency.wrap(vm.parseJsonAddress(j, string.concat(p, ".poolKey.currency1"))),
                fee: _u24(vm.parseJsonUint(j, string.concat(p, ".poolKey.fee")), "poolKey.fee"),
                tickSpacing: _i24(vm.parseJsonInt(j, string.concat(p, ".poolKey.tickSpacing")), "poolKey.tickSpacing"),
                hooks: IHooks(vm.parseJsonAddress(j, string.concat(p, ".poolKey.hooks")))
            });
            if (vm.keyExistsJson(j, string.concat(p, ".hookCodehash"))) {
                a.hookCodehash = vm.parseJsonBytes32(j, string.concat(p, ".hookCodehash"));
            }
            if (vm.keyExistsJson(j, string.concat(p, ".hookAuthority"))) {
                a.hookAuthority = vm.parseJsonAddress(j, string.concat(p, ".hookAuthority"));
            }
            if (vm.keyExistsJson(j, string.concat(p, ".hookMaxFeePips"))) {
                a.hookMaxFeePips = _u24(vm.parseJsonUint(j, string.concat(p, ".hookMaxFeePips")), "asset.hookMaxFeePips");
            }
        }
    }

    function _mix(string memory j, Asset[] memory assets) private view returns (MixLeg[] memory out) {
        uint256 n;
        while (n < MAX_ASSETS && vm.keyExistsJson(j, string.concat(".defaultMix[", vm.toString(n), "]"))) ++n;
        out = new MixLeg[](n);
        for (uint256 i; i < n; ++i) {
            string memory p = string.concat(".defaultMix[", vm.toString(i), "]");
            out[i].symbol = vm.parseJsonString(j, string.concat(p, ".symbol"));
            out[i].token = tokenOf(assets, out[i].symbol);
            out[i].bps = _u16(vm.parseJsonUint(j, string.concat(p, ".bps")), "defaultMix.bps");
        }
    }

    // ── lookups ────────────────────────────────────────────────────────────

    function tokenOf(Asset[] memory assets, string memory symbol) internal pure returns (address) {
        return assets[indexOf(assets, symbol)].token;
    }

    function indexOf(Asset[] memory assets, string memory symbol) internal pure returns (uint256) {
        for (uint256 i; i < assets.length; ++i) {
            if (keccak256(bytes(assets[i].symbol)) == keccak256(bytes(symbol))) return i;
        }
        revert UnknownSymbol(symbol);
    }

    function symbolOf(Asset[] memory assets, address token) internal pure returns (string memory) {
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i].token == token) return assets[i].symbol;
        }
        return "?";
    }

    // ── narrowing ──────────────────────────────────────────────────────────

    function _u16(uint256 v, string memory f) private pure returns (uint16) {
        if (v > type(uint16).max) revert OutOfRange(f);
        return uint16(v);
    }

    function _u24(uint256 v, string memory f) private pure returns (uint24) {
        if (v > type(uint24).max) revert OutOfRange(f);
        return uint24(v);
    }

    function _u32(uint256 v, string memory f) private pure returns (uint32) {
        if (v > type(uint32).max) revert OutOfRange(f);
        return uint32(v);
    }

    function _u64(uint256 v, string memory f) private pure returns (uint64) {
        if (v > type(uint64).max) revert OutOfRange(f);
        return uint64(v);
    }

    function _i24(int256 v, string memory f) private pure returns (int24) {
        if (v > type(int24).max || v < type(int24).min) revert OutOfRange(f);
        return int24(v);
    }
}
