// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice ElectionRegistry (SPARE-BUILD.md §3.8): bps sum to exactly 10000, at most
///         6 legs, no duplicates, every asset active; invalid mixes revert whole.
contract ElectionRegistryTest is UnitBase {
    address[4] internal extra;

    event MixSet(address indexed account, ElectionRegistry.Leg[] legs);
    event MixCleared(address indexed account);

    function setUp() public override {
        super.setUp();
        // Four more active assets so 6- and 7-leg mixes can be built.
        vm.startPrank(owner);
        for (uint256 i; i < 4; ++i) {
            extra[i] = address(uint160(0x5000 + i));
            _registerActive(extra[i], address(spyFeed));
        }
        vm.stopPrank();
    }

    function _legs(uint256 n) internal view returns (ElectionRegistry.Leg[] memory l) {
        address[7] memory all = [address(spy), address(nvda), address(qqq), extra[0], extra[1], extra[2], extra[3]];
        l = new ElectionRegistry.Leg[](n);
        uint256 left = 10_000;
        for (uint256 i; i < n; ++i) {
            uint16 b = i == n - 1 ? uint16(left) : uint16(10_000 / n);
            l[i] = ElectionRegistry.Leg(all[i], b);
            left -= b;
        }
    }

    function _assertMix(address account, ElectionRegistry.Leg[] memory want) internal view {
        ElectionRegistry.Leg[] memory got = elections.mixOf(account);
        assertEq(got.length, want.length, "leg count");
        for (uint256 i; i < want.length; ++i) {
            assertEq(got[i].asset, want[i].asset);
            assertEq(got[i].bps, want[i].bps);
        }
    }

    // ── valid mixes ──────────────────────────────────────────────────────

    function test_setMix_valid() public {
        ElectionRegistry.Leg[] memory l = _mix2(address(qqq), 7000, address(spy), 3000);
        vm.expectEmit(true, false, false, true, address(elections));
        emit MixSet(alice, l);
        vm.prank(alice);
        elections.setMix(l);
        assertTrue(elections.hasOwnMix(alice));
        _assertMix(alice, l);
    }

    function test_setMix_singleLeg() public {
        vm.prank(alice);
        elections.setMix(_mix1(address(qqq)));
        _assertMix(alice, _mix1(address(qqq)));
    }

    function test_setMix_sixLegsIsTheMax() public {
        assertEq(elections.MAX_LEGS(), 6);
        ElectionRegistry.Leg[] memory l = _legs(6);
        vm.prank(alice);
        elections.setMix(l);
        _assertMix(alice, l);
    }

    // ── every validation branch ──────────────────────────────────────────

    function test_setMix_emptyReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.BadLegCount.selector, 0));
        elections.setMix(new ElectionRegistry.Leg[](0));
    }

    function test_setMix_sevenLegsReverts() public {
        ElectionRegistry.Leg[] memory l = _legs(7);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.BadLegCount.selector, 7));
        elections.setMix(l);
    }

    function test_setMix_zeroLegReverts() public {
        ElectionRegistry.Leg[] memory l = new ElectionRegistry.Leg[](3);
        l[0] = ElectionRegistry.Leg(address(spy), 10_000);
        l[1] = ElectionRegistry.Leg(address(nvda), 0);
        l[2] = ElectionRegistry.Leg(address(qqq), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.ZeroLeg.selector, address(nvda)));
        elections.setMix(l);
    }

    function test_setMix_unregisteredAssetReverts() public {
        address junk = makeAddr("junk-token");
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), 5000, junk, 5000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.IneligibleAsset.selector, junk));
        elections.setMix(l);
    }

    function test_setMix_inactiveAssetReverts() public {
        vm.prank(owner);
        registry.setActive(address(qqq), false);
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), 5000, address(qqq), 5000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.IneligibleAsset.selector, address(qqq)));
        elections.setMix(l);
    }

    function test_setMix_adjacentDuplicateReverts() public {
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), 5000, address(spy), 5000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.DuplicateAsset.selector, address(spy)));
        elections.setMix(l);
    }

    function test_setMix_distantDuplicateReverts() public {
        ElectionRegistry.Leg[] memory l = new ElectionRegistry.Leg[](3);
        l[0] = ElectionRegistry.Leg(address(spy), 3000);
        l[1] = ElectionRegistry.Leg(address(nvda), 3000);
        l[2] = ElectionRegistry.Leg(address(spy), 4000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.DuplicateAsset.selector, address(spy)));
        elections.setMix(l);
    }

    function test_setMix_underTotalReverts() public {
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), 5000, address(nvda), 4999);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.BadTotal.selector, 9999));
        elections.setMix(l);
    }

    function test_setMix_overTotalReverts() public {
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), 5000, address(nvda), 5001);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.BadTotal.selector, 10_001));
        elections.setMix(l);
    }

    /// Totals are summed in uint256: large uint16 legs cannot wrap around to 10000.
    function test_setMix_largeLegsDoNotWrap() public {
        ElectionRegistry.Leg[] memory l = new ElectionRegistry.Leg[](2);
        l[0] = ElectionRegistry.Leg(address(spy), 65_535);
        l[1] = ElectionRegistry.Leg(address(nvda), 10_001);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.BadTotal.selector, 75_536));
        elections.setMix(l);
    }

    function testFuzz_setMix_twoLegsValidIffExactTotal(uint16 a, uint16 b) public {
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), a, address(nvda), b);
        bool valid = a != 0 && b != 0 && uint256(a) + b == 10_000;
        vm.prank(alice);
        if (!valid) vm.expectRevert();
        elections.setMix(l);
        if (valid) _assertMix(alice, l);
    }

    // ── fail-closed: no partial acceptance ───────────────────────────────

    function test_invalidMixLeavesPreviousMixIntact() public {
        ElectionRegistry.Leg[] memory good = _mix2(address(qqq), 2500, address(nvda), 7500);
        vm.prank(alice);
        elections.setMix(good);

        ElectionRegistry.Leg[] memory bad = new ElectionRegistry.Leg[](3);
        bad[0] = ElectionRegistry.Leg(address(spy), 5000);
        bad[1] = ElectionRegistry.Leg(address(nvda), 4000);
        bad[2] = ElectionRegistry.Leg(makeAddr("junk"), 1000);
        vm.prank(alice);
        vm.expectRevert();
        elections.setMix(bad);

        _assertMix(alice, good);
    }

    function test_setMix_replacesWholly() public {
        vm.prank(alice);
        elections.setMix(_legs(3));
        vm.prank(alice);
        elections.setMix(_mix1(address(nvda)));
        _assertMix(alice, _mix1(address(nvda)));
    }

    // ── default mix ──────────────────────────────────────────────────────

    /// Acceptance (2) preset: an account with no election gets 60/40 SPY/NVDA.
    function test_defaultMixIs6040() public view {
        ElectionRegistry.Leg[] memory d = elections.defaultMix();
        assertEq(d.length, 2);
        assertEq(d[0].asset, address(spy));
        assertEq(d[0].bps, 6000);
        assertEq(d[1].asset, address(nvda));
        assertEq(d[1].bps, 4000);
        assertFalse(elections.hasOwnMix(alice));
        _assertMix(alice, d);
    }

    function test_clearMix_fallsBackToDefault() public {
        vm.prank(alice);
        elections.setMix(_mix1(address(qqq)));
        vm.expectEmit(true, false, false, false, address(elections));
        emit MixCleared(alice);
        vm.prank(alice);
        elections.clearMix();
        assertFalse(elections.hasOwnMix(alice));
        _assertMix(alice, elections.defaultMix());
    }

    function test_setDefaultMix_onlyOwner() public {
        ElectionRegistry.Leg[] memory l = _mix1(address(qqq));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        elections.setDefaultMix(l);
    }

    function test_setDefaultMix_isValidatedToo() public {
        ElectionRegistry.Leg[] memory l = _mix2(address(spy), 6000, address(nvda), 3000);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.BadTotal.selector, 9000));
        elections.setDefaultMix(l);
    }

    function test_setDefaultMix_replacesWholly() public {
        vm.prank(owner);
        elections.setDefaultMix(_mix1(address(qqq)));
        _assertMix(alice, _mix1(address(qqq)));
    }

    function test_noDefaultAndNoOwnMixIsEmpty() public {
        ElectionRegistry fresh = new ElectionRegistry(owner, registry);
        assertEq(fresh.mixOf(alice).length, 0);
    }

    /// An asset deactivated AFTER election is not silently dropped from the mix;
    /// the executor safe-settles that leg with a notice instead (acceptance 6).
    function test_deactivatedAssetStaysInMix() public {
        vm.prank(alice);
        elections.setMix(_mix2(address(spy), 5000, address(qqq), 5000));
        vm.prank(owner);
        registry.setActive(address(qqq), false);
        ElectionRegistry.Leg[] memory got = elections.mixOf(alice);
        assertEq(got.length, 2);
        assertEq(got[1].asset, address(qqq));
    }
}
