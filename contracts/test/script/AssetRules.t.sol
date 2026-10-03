// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";

import {AddAssets} from "../../script/AddAssets.s.sol";
import {SpareBase} from "../../script/lib/SpareBase.sol";
import {SpareConfig} from "../../script/lib/SpareConfig.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {AddAssetsHarness, SafeLikeStub, ScriptOpsBase} from "./ScriptOpsBase.sol";

/// @dev The views a fee-only dynamic-fee hook exposes (the MU and GME hooks do):
///      who may set its fees, the fee a swap pays now, and the pool's cap.
contract FeeHookStub {
    address public immutable authority;
    uint24 internal immutable _fee;
    uint24 internal immutable _cap;

    constructor(address authority_, uint24 fee_, uint24 cap_) {
        authority = authority_;
        _fee = fee_;
        _cap = cap_;
    }

    function currentFee(bytes32, bool) external view returns (uint24) {
        return _fee;
    }

    function maxFee(bytes32) external view returns (uint24) {
        return _cap;
    }
}

/// @dev VerifyDeployment's asset and governance sections, on their own.
contract VerifyHarness is SpareBase {
    function exposed_verifyAssets(SpareConfig.Config memory cfg, Deployment memory d)
        external
        returns (uint256 passed, uint256 failed, uint256 warned)
    {
        _passed = 0;
        _failed = 0;
        _warned = 0;
        _verifyAssets(cfg, d);
        return (_passed, _failed, _warned);
    }

    function exposed_verifyGovernance(Deployment memory d, bool strict)
        external
        returns (uint256 passed, uint256 failed, uint256 warned)
    {
        return _governance(d, strict);
    }

    /// @dev Strictness from SPARE_REQUIRE_TIMELOCK, as VerifyDeployment reads it.
    function exposed_verifyGovernanceFromEnv(Deployment memory d)
        external
        returns (uint256 passed, uint256 failed, uint256 warned)
    {
        return _governance(d, _requireTimelock());
    }

    function _governance(Deployment memory d, bool strict) internal returns (uint256, uint256, uint256) {
        _passed = 0;
        _failed = 0;
        _warned = 0;
        _verifyGovernance(d, strict);
        return (_passed, _failed, _warned);
    }
}

/// @notice The asset rules Deploy / AddAssets refuse on and VerifyDeployment
///         fails on (token decimals 18, heartbeat <= 26 h, a pinned fee-only
///         hook whose fee ceiling sits inside the band), and the governance
///         policy section (owner = a TimelockController with minDelay >= 48 h).
contract AssetRulesTest is ScriptOpsBase {
    address internal fablesAuthority = makeAddr("hook authority");
    MockStockToken internal hkd;
    MockFeed internal hkdFeed;
    VerifyHarness internal verifier;

    uint160 internal constant FEE_ONLY = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG; // 0x2080, as MU / GME
    uint160 internal constant RETURNS_DELTA = Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;

    function setUp() public override {
        super.setUp();
        hkd = new MockStockToken("Hooked", "HKD");
        hkdFeed = new MockFeed(8, 20e8);
        verifier = new VerifyHarness();
    }

    // ── fixture ────────────────────────────────────────────────────────────

    /// @dev A FeeHookStub at an address whose v4 permission bits are `flags`.
    function _hookAt(uint160 flags, address authority_, uint24 fee, uint24 cap) internal returns (address h) {
        h = address((uint160(uint256(keccak256(abi.encode("hook", flags)))) & ~Hooks.ALL_HOOK_MASK) | flags);
        vm.etch(h, address(new FeeHookStub(authority_, fee, cap)).code);
    }

    function _hookedKey(address token, address hook) internal view returns (PoolKey memory k) {
        k = _key(token);
        k.fee = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG
        k.tickSpacing = 10;
        k.hooks = IHooks(hook);
    }

    /// @dev HKD on a fee-only hook, pinned exactly as the live hook reads.
    function _wantHooked(uint24 feeNow, uint24 ceiling) internal returns (address hook) {
        hook = _hookAt(FEE_ONLY, fablesAuthority, feeNow, 50_000);
        _cfgAssets.push(
            SpareConfig.Asset(
                "HKD", address(hkd), address(hkdFeed), HEARTBEAT, BAND, true, _hookedKey(address(hkd), hook),
                hook.codehash, fablesAuthority, ceiling
            )
        );
    }

    function _last() internal view returns (uint256) {
        return _cfgAssets.length - 1;
    }

    /// @dev Registers the last config asset exactly as configured, so the only
    ///      thing VerifyDeployment can object to is the rule under test.
    function _registerLast() internal {
        SpareConfig.Asset memory a = _cfgAssets[_last()];
        vm.startPrank(owner);
        registry.setAsset(a.token, a.feed, a.heartbeat, a.bandBps, a.key);
        registry.setActive(a.token, a.active);
        vm.stopPrank();
    }

    function _addAssets() internal returns (uint256 n) {
        (n,) = new AddAssetsHarness(_deployment(), this).exposed_run();
    }

    function _addAssetsRefuses(string memory why) internal {
        AddAssetsHarness s = new AddAssetsHarness(_deployment(), this);
        vm.expectRevert(abi.encodeWithSelector(AddAssets.Refused.selector, why));
        s.exposed_run();
    }

    function _verifyAssets() internal returns (uint256 passed, uint256 failed, uint256 warned) {
        return verifier.exposed_verifyAssets(this.config(), _deployment());
    }

    // ── AddAssets refuses ──────────────────────────────────────────────────

    function test_addAssets_refusesATokenWithout18Decimals() public {
        _registryOwnedBySender();
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        _want("SIX", address(six), address(spyFeed), BAND, true);
        _addAssetsRefuses("SIX: token decimals 6, not 18 (the router's math assumes 18)");
    }

    function test_addAssets_refusesATokenWithoutDecimals() public {
        _registryOwnedBySender();
        address noDecimals = address(new SafeLikeStub());
        _want("NODEC", noDecimals, address(spyFeed), BAND, true);
        _addAssetsRefuses("NODEC: token decimals() unreadable (the router's math assumes 18)");
    }

    /// Also on a re-pin of an asset already registered: 26 h is the ceiling.
    function test_addAssets_refusesAHeartbeatOver26h() public {
        _registryOwnedBySender();
        _cfgAssets[0].heartbeat = 26 hours + 1;
        _addAssetsRefuses("SPY: heartbeat 93601 s > 93600 s (26 h ceiling)");

        _cfgAssets[0].heartbeat = 26 hours;
        assertEq(_addAssets(), 1, "26 h itself is accepted: one setAsset");
        assertEq(registry.get(address(spy)).heartbeat, 26 hours);
    }

    /// Each of the four v4 *_RETURNS_DELTA bits lets a hook move a swap's amounts.
    function test_addAssets_refusesAHookWithAnyReturnDeltaFlag() public {
        _registryOwnedBySender();
        uint160[4] memory delta = [
            Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_SWAP_FLAG,
            Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_FLAG,
            Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG,
            Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
        ];
        for (uint256 i; i < 4; ++i) {
            uint160 flags = FEE_ONLY | delta[i];
            address hook = _hookAt(flags, fablesAuthority, 500, 50_000);
            _cfgAssets.push(
                SpareConfig.Asset(
                    "HKD", address(hkd), address(hkdFeed), HEARTBEAT, BAND, true, _hookedKey(address(hkd), hook),
                    hook.codehash, fablesAuthority, 4000
                )
            );
            _addAssetsRefuses(
                string.concat(
                    "HKD: hook flags ", vm.toString(abi.encodePacked(uint16(flags))),
                    ": a *_RETURNS_DELTA permission (it could take a cut of the swap)"
                )
            );
            _cfgAssets.pop();
        }
    }

    function test_addAssets_refusesAHookWhoseCodeIsNotThePinnedCode() public {
        _registryOwnedBySender();
        address hook = _wantHooked(500, 4000);
        bytes32 pinned = keccak256("the build that was reviewed");
        _cfgAssets[_last()].hookCodehash = pinned;
        _addAssetsRefuses(
            string.concat("HKD: hook codehash ", vm.toString(hook.codehash), " != config ", vm.toString(pinned))
        );
    }

    function test_addAssets_refusesAnUnpinnedHook() public {
        _registryOwnedBySender();
        address hook = _wantHooked(500, 4000);
        _cfgAssets[_last()].hookCodehash = bytes32(0);
        _addAssetsRefuses(
            string.concat("HKD: hook codehash ", vm.toString(hook.codehash), " is not pinned (config hookCodehash)")
        );
    }

    function test_addAssets_refusesAHookUnderAnotherAuthority() public {
        _registryOwnedBySender();
        _wantHooked(500, 4000);
        address other = makeAddr("another authority");
        _cfgAssets[_last()].hookAuthority = other;
        _addAssetsRefuses(
            string.concat("HKD: hook authority ", vm.toString(fablesAuthority), " != config ", vm.toString(other))
        );
    }

    function test_addAssets_refusesAPinnedAuthorityTheHookCannotReport() public {
        _registryOwnedBySender();
        address hook = _wantHooked(500, 4000);
        vm.etch(hook, address(new SafeLikeStub()).code); // answers authority() with nothing
        _cfgAssets[_last()].hookCodehash = hook.codehash;
        _addAssetsRefuses(
            string.concat("HKD: hook authority() unreadable; config pins ", vm.toString(fablesAuthority))
        );
    }

    /// A ceiling at the band leaves no room under it: every such fill reverts.
    function test_addAssets_refusesAFeeCeilingOutsideTheBand() public {
        _registryOwnedBySender();
        _wantHooked(500, uint24(BAND) * 100);
        _addAssetsRefuses("HKD: keeper's hook fee ceiling 15000 pips >= band 15000 pips (150 bps)");

        _cfgAssets[_last()].hookMaxFeePips = uint24(BAND) * 100 - 1;
        assertEq(_addAssets(), 2, "14999 pips is inside the band: setAsset + activate");
    }

    function test_addAssets_refusesHookPinsOnAHooklessPool() public {
        _registryOwnedBySender();
        _cfgAssets[1].hookMaxFeePips = 4000;
        _addAssetsRefuses("NVDA: hookCodehash / hookAuthority / hookMaxFeePips set for a hookless pool");
    }

    function test_addAssets_registersAPinnedFeeOnlyHook() public {
        _registryOwnedBySender();
        address hook = _wantHooked(500, 4000);
        assertEq(_addAssets(), 2);
        AssetRegistry.Asset memory r = registry.get(address(hkd));
        assertEq(address(r.poolKey.hooks), hook);
        assertTrue(r.active);
    }

    /// The pinned-hook check runs in the owner-contract path too, before any call
    /// is printed for the timelock.
    function test_addAssets_timelockOwner_refusesAnUnpinnedHook() public {
        _registryOwnedByTimelock();
        address hook = _wantHooked(500, 4000);
        _cfgAssets[_last()].hookCodehash = bytes32(0);
        _addAssetsRefuses(
            string.concat("HKD: hook codehash ", vm.toString(hook.codehash), " is not pinned (config hookCodehash)")
        );
    }

    // ── VerifyDeployment fails ─────────────────────────────────────────────

    function test_verify_assetRulesPassOnAPinnedHook() public {
        _wantHooked(500, 4000);
        _registerLast();
        (uint256 passed, uint256 failed, uint256 warned) = _verifyAssets();
        assertEq(failed, 0);
        assertEq(warned, 0);
        // 4 assets: decimals + heartbeat each, and HKD's flags, codehash, authority, ceiling
        assertGe(passed, 4 * 2 + 4);
    }

    function test_verify_failsATokenWithout18Decimals() public {
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        _want("SIX", address(six), address(spyFeed), BAND, true);
        _registerLast();
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    function test_verify_failsAHeartbeatOver26h() public {
        _cfgAssets[0].heartbeat = 26 hours + 1;
        vm.prank(owner);
        registry.setAsset(address(spy), address(spyFeed), 26 hours + 1, BAND, _key(address(spy)));
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    function test_verify_failsAReturnDeltaHook() public {
        address hook =
            _hookAt(FEE_ONLY | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_FLAG, fablesAuthority, 500, 50_000);
        _cfgAssets.push(
            SpareConfig.Asset(
                "HKD", address(hkd), address(hkdFeed), HEARTBEAT, BAND, true, _hookedKey(address(hkd), hook),
                hook.codehash, fablesAuthority, 4000
            )
        );
        _registerLast();
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    /// The registry pins the hook's address; only the config pins its code.
    function test_verify_failsWhenTheHookCodeChanges() public {
        address hook = _wantHooked(500, 4000);
        _registerLast();
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 0);
        vm.etch(hook, address(new FeeHookStub(fablesAuthority, 500, 20_000)).code);
        (, failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    function test_verify_failsAnUnpinnedHook() public {
        _wantHooked(500, 4000);
        _cfgAssets[_last()].hookCodehash = bytes32(0);
        _registerLast();
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    function test_verify_failsAHookUnderAnotherAuthority() public {
        _wantHooked(500, 4000);
        _cfgAssets[_last()].hookAuthority = makeAddr("another authority");
        _registerLast();
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    function test_verify_failsAFeeCeilingOutsideTheBand() public {
        _wantHooked(500, uint24(BAND) * 100);
        _registerLast();
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    function test_verify_failsHookPinsOnAHooklessPool() public {
        _cfgAssets[1].hookCodehash = keccak256("pin");
        (, uint256 failed,) = _verifyAssets();
        assertEq(failed, 1);
    }

    /// The hook's live fee above the keeper's ceiling is the keeper's hold, not a
    /// wiring fault: a warning.
    function test_verify_warnsWhenTheHookFeeIsAboveTheCeiling() public {
        _wantHooked(4001, 4000);
        _registerLast();
        (, uint256 failed, uint256 warned) = _verifyAssets();
        assertEq(failed, 0);
        assertEq(warned, 1);
    }

    // ── the committed mainnet config ───────────────────────────────────────

    /// Every hooked pool in config/4663.json carries its pins, and every hookless
    /// one none; ceilings sit inside the band and heartbeats under 26 h. The live
    /// side (token decimals, the hook's code and authority) is VerifyDeployment's.
    function test_mainnetConfig_pinsEveryHookedPool() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/4663.json"));
        SpareConfig.Asset[] memory as_ = SpareConfig.parse(json, "config/4663.json").assets;
        uint256 hooked;
        for (uint256 i; i < as_.length; ++i) {
            SpareConfig.Asset memory a = as_[i];
            assertLe(a.heartbeat, 26 hours, a.symbol);
            if (address(a.key.hooks) == address(0)) {
                assertEq(a.hookCodehash, bytes32(0), a.symbol);
                assertEq(a.hookAuthority, address(0), a.symbol);
                assertEq(a.hookMaxFeePips, 0, a.symbol);
                continue;
            }
            ++hooked;
            assertEq(uint160(address(a.key.hooks)) & RETURNS_DELTA, 0, a.symbol);
            assertTrue(a.hookCodehash != bytes32(0), a.symbol);
            assertTrue(a.hookAuthority != address(0), a.symbol);
            assertGt(a.hookMaxFeePips, 0, a.symbol);
            assertLt(a.hookMaxFeePips, uint256(a.bandBps) * 100, a.symbol);
        }
        assertEq(hooked, 2, "MU and GME");

        SpareConfig.Asset memory mu = as_[SpareConfig.indexOf(as_, "MU")];
        assertEq(mu.hookCodehash, 0x577978ad29223268205cb40a5215c46839f5c27a1218beac7d4a0f7cd0aaa341);
        assertEq(mu.hookAuthority, 0xA362D98B33A7bb5B5E2180a05f995A70FB404f30);
        assertEq(mu.hookMaxFeePips, 4000);
        SpareConfig.Asset memory gme = as_[SpareConfig.indexOf(as_, "GME")];
        assertEq(gme.hookCodehash, 0xbb52b2dc4a14fc6c3f90d0a268b51680d7adbdaa392b211bc524b6fd9368bb85);
        assertEq(gme.hookAuthority, 0xA362D98B33A7bb5B5E2180a05f995A70FB404f30);
        assertEq(gme.hookMaxFeePips, 500);
    }

    // ── governance policy ──────────────────────────────────────────────────

    function _acceptAll(address newOwner) internal {
        _nominate(newOwner);
        SpareAuth[7] memory c = _seven();
        for (uint256 i; i < 7; ++i) {
            vm.prank(newOwner);
            c[i].acceptOwnership();
        }
    }

    function _governance(bool strict) internal returns (uint256 passed, uint256 failed, uint256 warned) {
        return verifier.exposed_verifyGovernance(_deployment(), strict);
    }

    function test_governance_eoaOwnerWarnsAndFailsWhenRequired() public {
        (uint256 passed, uint256 failed, uint256 warned) = _governance(false);
        assertEq(passed, 0);
        assertEq(failed, 0);
        assertEq(warned, 1, "one line for the one owner of all 7");
        (passed, failed, warned) = _governance(true);
        assertEq(failed, 1);
        assertEq(warned, 0);
    }

    function test_governance_48hTimelockPasses() public {
        _acceptAll(address(tl));
        for (uint256 s; s < 2; ++s) {
            (uint256 passed, uint256 failed, uint256 warned) = _governance(s == 1);
            assertEq(passed, 1);
            assertEq(failed, 0);
            assertEq(warned, 0);
        }
    }

    function test_governance_shortTimelockWarnsAndFailsWhenRequired() public {
        address[] memory onlySafe = new address[](1);
        onlySafe[0] = safe;
        TimelockController quick = new TimelockController(48 hours - 1, onlySafe, onlySafe, address(0));
        _acceptAll(address(quick));
        (, uint256 failed, uint256 warned) = _governance(false);
        assertEq(failed, 0);
        assertEq(warned, 1);
        (, failed, warned) = _governance(true);
        assertEq(failed, 1);
    }

    function test_governance_ownerContractThatIsNotATimelockWarns() public {
        _acceptAll(address(new SafeLikeStub()));
        (uint256 passed, uint256 failed, uint256 warned) = _governance(false);
        assertEq(passed, 0);
        assertEq(failed, 0);
        assertEq(warned, 1);
    }

    /// The EIP-7702 delegation designator is code, but the account still signs
    /// with its own key: an EOA for the policy.
    function test_governance_7702DelegatedOwnerIsAnEoa() public {
        vm.etch(owner, _delegation(address(new SafeLikeStub())));
        (uint256 passed,, uint256 warned) = _governance(false);
        assertEq(passed, 0);
        assertEq(warned, 1);
    }

    /// Mid hand-over: 6 accepted by the timelock, 1 still with the EOA. One line
    /// per distinct owner.
    function test_governance_oneLinePerDistinctOwner() public {
        _nominate(address(tl));
        SpareAuth[7] memory c = _seven();
        for (uint256 i; i < 6; ++i) {
            vm.prank(address(tl));
            c[i].acceptOwnership();
        }
        (uint256 passed, uint256 failed, uint256 warned) = _governance(false);
        assertEq(passed, 1);
        assertEq(failed, 0);
        assertEq(warned, 1);
    }

    function test_governance_spareRequireTimelockMakesItAFailure() public {
        vm.setEnv("SPARE_REQUIRE_TIMELOCK", "true");
        (, uint256 failed, uint256 warned) = verifier.exposed_verifyGovernanceFromEnv(_deployment());
        assertEq(failed, 1);
        assertEq(warned, 0);
        vm.setEnv("SPARE_REQUIRE_TIMELOCK", "false");
        (, failed, warned) = verifier.exposed_verifyGovernanceFromEnv(_deployment());
        assertEq(failed, 0);
        assertEq(warned, 1);
    }
}
