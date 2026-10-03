// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice AssetRegistry: the eligible universe, pool allowlist, fail-closed reads.
contract AssetRegistryTest is UnitBase {
    address internal tsla = makeAddr("tsla-token");
    MockFeed internal tslaFeed;

    event AssetSet(address indexed token, address feed, uint32 heartbeat, uint16 bandBps, bytes32 poolId);
    event AssetActive(address indexed token, bool active);

    function setUp() public override {
        super.setUp();
        tslaFeed = new MockFeed(8, 300e8);
    }

    function _k(address c0, address c1, uint24 fee, int24 ts, address hook) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(hook));
    }

    // ── registration ─────────────────────────────────────────────────────

    function test_constructor_rejectsZeroUsdg() public {
        vm.expectRevert(SpareAuth.ZeroAddress.selector);
        new AssetRegistry(owner, address(0));
    }

    function test_setAsset_startsInactiveAndStoresEverything() public {
        MockFeed f18 = new MockFeed(18, 300e18);
        PoolKey memory key = _key(tsla);
        vm.prank(owner);
        registry.setAsset(tsla, address(f18), 3_600, 200, key);

        assertTrue(registry.isRegistered(tsla));
        assertFalse(registry.isEligible(tsla), "new assets start INACTIVE");
        AssetRegistry.Asset memory a = registry.get(tsla);
        assertEq(a.token, tsla);
        assertEq(a.feed, address(f18));
        assertEq(a.feedDecimals, 18, "decimals read from the feed, not assumed");
        assertEq(a.heartbeat, 3_600);
        assertEq(a.bandBps, 200);
        assertFalse(a.active);
        assertEq(keccak256(abi.encode(a.poolKey)), keccak256(abi.encode(key)), "exact PoolKey stored");

        address[] memory t = registry.tokens();
        assertEq(t.length, 4);
        assertEq(t[3], tsla);
    }

    function test_setAsset_emitsPoolId() public {
        PoolKey memory key = _key(tsla);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AssetSet(tsla, address(tslaFeed), HEARTBEAT, BAND, keccak256(abi.encode(key)));
        vm.prank(owner);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, key);
    }

    function test_setAsset_onlyOwner() public {
        PoolKey memory key = _key(tsla);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, key);
    }

    function test_setAsset_rejectsZeroToken() public {
        PoolKey memory key = _key(tsla);
        vm.prank(owner);
        vm.expectRevert(SpareAuth.ZeroAddress.selector);
        registry.setAsset(address(0), address(tslaFeed), HEARTBEAT, BAND, key);
    }

    function test_setAsset_rejectsZeroFeed() public {
        PoolKey memory key = _key(tsla);
        vm.prank(owner);
        vm.expectRevert(SpareAuth.ZeroAddress.selector);
        registry.setAsset(tsla, address(0), HEARTBEAT, BAND, key);
    }

    function test_setAsset_rejectsZeroHeartbeat() public {
        PoolKey memory key = _key(tsla);
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.BadHeartbeat.selector);
        registry.setAsset(tsla, address(tslaFeed), 0, BAND, key);
    }

    function test_setAsset_bandBounds() public {
        PoolKey memory key = _key(tsla);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadBand.selector, uint16(0)));
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, 0, key);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadBand.selector, uint16(1001)));
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, 1001, key);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, 1000, key); // MAX_BAND_BPS is allowed
        assertEq(registry.get(tsla).bandBps, 1000);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, 1, key);
        assertEq(registry.get(tsla).bandBps, 1);
        vm.stopPrank();
    }

    /// Fail-closed: a feed that cannot even report decimals cannot be registered.
    function test_setAsset_feedWithoutDecimalsReverts() public {
        PoolKey memory key = _key(tsla);
        vm.prank(owner);
        vm.expectRevert();
        registry.setAsset(tsla, makeAddr("not-a-feed"), HEARTBEAT, BAND, key);
    }

    // ── pool validation (the venue allowlist) ────────────────────────────

    function test_pool_rejectsPairWithoutUsdg() public {
        (address a, address b) = tsla < address(spy) ? (tsla, address(spy)) : (address(spy), tsla);
        PoolKey memory key = _k(a, b, 3000, 60, address(0));
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.PoolMismatch.selector);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, key);
    }

    function test_pool_rejectsAnotherAssetsPool() public {
        PoolKey memory spyKey = _key(address(spy));
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.PoolMismatch.selector);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, spyKey);
    }

    function test_pool_rejectsUnsortedCurrencies() public {
        PoolKey memory k = _key(tsla);
        PoolKey memory flipped = PoolKey(k.currency1, k.currency0, k.fee, k.tickSpacing, k.hooks);
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.PoolMismatch.selector);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, flipped);
    }

    function test_pool_rejectsUsdgAsItsOwnAsset() public {
        PoolKey memory key = _k(address(usdg), address(usdg), 3000, 60, address(0));
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.PoolMismatch.selector);
        registry.setAsset(address(usdg), address(tslaFeed), HEARTBEAT, BAND, key);
    }

    function test_pool_rejectsTokenPairedWithItself() public {
        PoolKey memory key = _k(tsla, tsla, 3000, 60, address(0));
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.PoolMismatch.selector);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, key);
    }

    function test_pool_acceptsBothSortOrders() public {
        address low = address(0x1000); // sorts below USDG
        address high = address(type(uint160).max - 7); // sorts above USDG
        assertLt(uint160(low), uint160(address(usdg)));
        assertGt(uint160(high), uint160(address(usdg)));
        vm.startPrank(owner);
        registry.setAsset(low, address(tslaFeed), HEARTBEAT, BAND, _k(low, address(usdg), 3000, 60, address(0)));
        registry.setAsset(high, address(tslaFeed), HEARTBEAT, BAND, _k(address(usdg), high, 3000, 60, address(0)));
        vm.stopPrank();
        assertTrue(registry.isRegistered(low));
        assertTrue(registry.isRegistered(high));
    }

    /// The hook address is part of the allowlisted key: it is stored exactly and
    /// only the owner can change it.
    function test_pool_hookIsPinnedInTheKey() public {
        address hook = address(0xA0D185c901E4abD21f94D4E3ba8FAbc3E29E80c4);
        PoolKey memory k = _key(tsla);
        k.hooks = IHooks(hook);
        k.fee = 0;
        k.tickSpacing = 1;
        vm.prank(owner);
        registry.setAsset(tsla, address(tslaFeed), HEARTBEAT, BAND, k);
        AssetRegistry.Asset memory a = registry.get(tsla);
        assertEq(address(a.poolKey.hooks), hook);
        assertEq(a.poolKey.fee, 0);
        assertEq(a.poolKey.tickSpacing, 1);
    }

    // ── updates and activation ───────────────────────────────────────────

    function test_setAsset_updateKeepsActivationAndDoesNotDuplicate() public {
        uint256 before = registry.tokens().length;
        PoolKey memory k = _key(address(spy));
        vm.prank(owner);
        registry.setAsset(address(spy), address(tslaFeed), 7_200, 300, k);
        assertTrue(registry.isEligible(address(spy)), "an update does not silently deactivate");
        assertEq(registry.tokens().length, before, "no duplicate entry");
        assertEq(registry.get(address(spy)).feed, address(tslaFeed));
        assertEq(registry.get(address(spy)).heartbeat, 7_200);
    }

    function test_setActive_toggles() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit AssetActive(address(spy), false);
        vm.prank(owner);
        registry.setActive(address(spy), false);
        assertFalse(registry.isEligible(address(spy)));
        assertTrue(registry.isRegistered(address(spy)), "deactivation is not deregistration");
        assertFalse(registry.get(address(spy)).active);
        vm.prank(owner);
        registry.setActive(address(spy), true);
        assertTrue(registry.isEligible(address(spy)));
    }

    function test_setActive_unknownReverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.UnknownAsset.selector, tsla));
        registry.setActive(tsla, true);
    }

    function test_setActive_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setActive(address(spy), false);
    }

    // ── fail-closed reads ────────────────────────────────────────────────

    function test_unknownAssetIsFailClosed() public {
        assertFalse(registry.isEligible(tsla));
        assertFalse(registry.isRegistered(tsla));
        assertFalse(registry.isEligible(address(0)));
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.UnknownAsset.selector, tsla));
        registry.get(tsla);
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        registry.transferOwnership(stranger);
        assertEq(registry.owner(), owner, "not transferred until accepted");
        vm.prank(stranger);
        registry.acceptOwnership();
        assertEq(registry.owner(), stranger);
    }
}
