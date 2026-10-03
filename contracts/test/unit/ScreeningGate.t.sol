// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ScreeningGate} from "../../src/ScreeningGate.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice ScreeningGate: attestor clearance (direct and EIP-712 signed), replay
///         protection, expiry, revocation, and the `enforced` switch.
contract ScreeningGateTest is UnitBase {
    event Cleared(address indexed account, uint64 validUntil);
    event Revoked(address indexed account);

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        screening.setEnforced(true);
    }

    function _domain(address gate) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SPARE ScreeningGate"),
                keccak256("1"),
                block.chainid,
                gate
            )
        );
    }

    function _sig(uint256 pk, address gate, address account, uint64 validUntil, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(screening.CLEARANCE_TYPEHASH(), account, validUntil, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(gate), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── enforced switch ──────────────────────────────────────────────────

    function test_notEnforcedClearsEveryone() public {
        vm.prank(owner);
        screening.setEnforced(false);
        assertTrue(screening.isEligible(alice));
        assertTrue(screening.isEligible(stranger));
    }

    function test_enforcedUnclearedIsIneligible() public view {
        assertFalse(screening.isEligible(alice));
    }

    function test_setEnforced_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        screening.setEnforced(false);
    }

    // ── direct clearance ─────────────────────────────────────────────────

    function test_clear_byAttestorUntilExpiry() public {
        uint64 until = uint64(block.timestamp + 30 days);
        vm.expectEmit(true, false, false, true, address(screening));
        emit Cleared(alice, until);
        vm.prank(attestor);
        screening.clear(alice, until);
        assertTrue(screening.isEligible(alice));
        vm.warp(until);
        assertTrue(screening.isEligible(alice), "valid through validUntil inclusive");
        vm.warp(uint256(until) + 1);
        assertFalse(screening.isEligible(alice), "expired");
    }

    function test_clear_byNonAttestorReverts() public {
        vm.prank(owner); // even the owner is not the attestor
        vm.expectRevert(ScreeningGate.NotAttestor.selector);
        screening.clear(alice, uint64(block.timestamp + 1 days));
    }

    // ── signed clearance ─────────────────────────────────────────────────

    function test_submitClearance_signedByAttestor() public {
        uint64 until = uint64(block.timestamp + 365 days);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(alice);
        screening.submitClearance(until, sig);
        assertTrue(screening.isEligible(alice));
        assertEq(screening.clearedUntil(alice), until);
        assertEq(screening.nonces(alice), 1);
    }

    function test_submitClearance_replayReverts() public {
        uint64 until = uint64(block.timestamp + 365 days);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(alice);
        screening.submitClearance(until, sig);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, sig);
    }

    /// Replaying an old, still-unexpired clearance after a revoke must not restore it.
    function test_submitClearance_replayAfterRevokeReverts() public {
        uint64 until = uint64(block.timestamp + 365 days);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(alice);
        screening.submitClearance(until, sig);
        vm.prank(attestor);
        screening.revoke(alice);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, sig);
        assertFalse(screening.isEligible(alice));
    }

    function test_submitClearance_expiredReverts() public {
        uint64 until = uint64(block.timestamp - 1);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.Expired.selector);
        screening.submitClearance(until, sig);
    }

    function test_submitClearance_wrongSignerReverts() public {
        (, uint256 fakeKey) = makeAddrAndKey("fake-attestor");
        uint64 until = uint64(block.timestamp + 1 days);
        bytes memory sig = _sig(fakeKey, address(screening), alice, until, 0);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, sig);
    }

    function test_submitClearance_boundToAccount() public {
        uint64 until = uint64(block.timestamp + 1 days);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(bob);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, sig);
    }

    function test_submitClearance_boundToValidUntil() public {
        uint64 until = uint64(block.timestamp + 1 days);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until + 365 days, sig);
    }

    function test_submitClearance_boundToGate() public {
        ScreeningGate other = new ScreeningGate(owner, attestor, true);
        uint64 until = uint64(block.timestamp + 1 days);
        bytes memory sig = _sig(attestorKey, address(other), alice, until, 0);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, sig);
    }

    // ── revocation ───────────────────────────────────────────────────────

    function test_revoke_byAttestor() public {
        vm.prank(attestor);
        screening.clear(alice, uint64(block.timestamp + 30 days));
        vm.expectEmit(true, false, false, false, address(screening));
        emit Revoked(alice);
        vm.prank(attestor);
        screening.revoke(alice);
        assertFalse(screening.isEligible(alice));
        assertEq(screening.clearedUntil(alice), 0);
    }

    function test_revoke_byOwner() public {
        vm.prank(attestor);
        screening.clear(alice, uint64(block.timestamp + 30 days));
        vm.prank(owner);
        screening.revoke(alice);
        assertFalse(screening.isEligible(alice));
    }

    function test_revoke_byStrangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(ScreeningGate.NotAttestor.selector);
        screening.revoke(alice);
    }

    /// "Attestor or owner can withdraw a clearance at any time." A clearance the
    /// attestor signed but the account has not yet submitted dies with the revoke
    /// (revoke bumps the account's nonce); otherwise the account would re-clear
    /// itself right after being revoked.
    function test_revoke_invalidatesOutstandingSignedClearance() public {
        uint64 until = uint64(block.timestamp + 365 days);
        bytes memory sig = _sig(attestorKey, address(screening), alice, until, 0);
        // Screening later finds alice ineligible and revokes her before she submits.
        vm.prank(attestor);
        screening.revoke(alice);
        assertEq(screening.nonces(alice), 1, "revoke bumped the nonce");

        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, sig);
        assertFalse(screening.isEligible(alice));

        // A clearance the attestor issues AFTER the revoke (over the new nonce) works.
        bytes memory fresh = _sig(attestorKey, address(screening), alice, until, 1);
        vm.prank(alice);
        screening.submitClearance(until, fresh);
        assertTrue(screening.isEligible(alice));
    }

    function test_revoke_byOwnerAlsoBumpsNonce() public {
        vm.prank(owner);
        screening.revoke(alice);
        vm.prank(owner);
        screening.revoke(alice);
        assertEq(screening.nonces(alice), 2);
        assertEq(screening.nonces(bob), 0, "only the revoked account's nonce moves");
    }

    // ── attestor rotation ────────────────────────────────────────────────

    function test_setAttestor_rotatesSigningAuthority() public {
        (address next, uint256 nextKey) = makeAddrAndKey("next-attestor");
        vm.prank(owner);
        screening.setAttestor(next);

        uint64 until = uint64(block.timestamp + 1 days);
        bytes memory oldSig = _sig(attestorKey, address(screening), alice, until, 0);
        vm.prank(alice);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        screening.submitClearance(until, oldSig);

        vm.prank(attestor);
        vm.expectRevert(ScreeningGate.NotAttestor.selector);
        screening.clear(alice, until);

        bytes memory newSig = _sig(nextKey, address(screening), alice, until, 0);
        vm.prank(alice);
        screening.submitClearance(until, newSig);
        assertTrue(screening.isEligible(alice));
    }

    function test_setAttestor_onlyOwner() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attestor));
        screening.setAttestor(stranger);
    }
}
