// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RuleRegistry} from "../../src/RuleRegistry.sol";
import {MockArbSysSettable} from "../mocks/MockArbSysSettable.sol";
import {Mock1271Wallet} from "../mocks/Mock1271Wallet.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice RuleRegistry: rules and the activeSince consent floor, self-linking,
///         EIP-712 wallet linking, per-wallet nonces (consumed by every link, bumped
///         by unlink and invalidateNonce), the linkedAt consent floor, and the
///         MAX_WALLETS bound.
contract RuleRegistryTest is UnitBase {
    address internal wallet;
    uint256 internal walletKey;

    event Linked(address indexed account, address indexed wallet);
    event Unlinked(address indexed account, address indexed wallet);
    event RuleSet(address indexed account, uint8 roundTo, uint8 multiplier, uint64 weeklyCap, bool enabled);
    event NonceInvalidated(address indexed wallet, uint256 newNonce);

    function setUp() public override {
        super.setUp();
        (wallet, walletKey) = makeAddrAndKey("spending-wallet");
    }

    function _sig(RuleRegistry reg, uint256 pk, address account, address w, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(reg.LINK_TYPEHASH(), account, w, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _linkSigned(address account, address w, uint256 pk) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, pk, account, w, rules.nonces(w), deadline);
        vm.prank(account);
        rules.linkWallet(w, deadline, sig);
    }

    // ── rules ────────────────────────────────────────────────────────────

    function test_setRule_storesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(rules));
        emit RuleSet(alice, 5, 3, 25e6, true);
        vm.prank(alice);
        rules.setRule(5, 3, 25e6, true);
        RuleRegistry.Rule memory r = rules.ruleOf(alice);
        assertEq(r.roundTo, 5);
        assertEq(r.multiplier, 3);
        assertEq(r.weeklyCap, 25e6);
        assertTrue(r.enabled);
    }

    function test_setRule_acceptsEveryValidCombination() public {
        uint8[3] memory tos = [uint8(1), 5, 10];
        for (uint256 i; i < 3; ++i) {
            for (uint8 m = 1; m <= 5; ++m) {
                vm.prank(alice);
                rules.setRule(tos[i], m, 1e6, true);
                assertEq(rules.ruleOf(alice).roundTo, tos[i]);
                assertEq(rules.ruleOf(alice).multiplier, m);
            }
        }
    }

    function testFuzz_setRule_rejectsBadRoundTo(uint8 roundTo) public {
        vm.assume(roundTo != 1 && roundTo != 5 && roundTo != 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RuleRegistry.BadRoundTo.selector, roundTo));
        rules.setRule(roundTo, 1, 1e6, true);
    }

    function testFuzz_setRule_rejectsBadMultiplier(uint8 m) public {
        vm.assume(m == 0 || m > 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RuleRegistry.BadMultiplier.selector, m));
        rules.setRule(1, m, 1e6, true);
    }

    function test_ruleOf_defaultsToDisabled() public view {
        RuleRegistry.Rule memory r = rules.ruleOf(alice);
        assertFalse(r.enabled);
        assertEq(r.weeklyCap, 0);
        assertEq(rules.activeSince(alice), 0);
    }

    // ── activeSince ──────────────────────────────────────────────────────

    /// activeSince moves only on an inactive -> active transition (enabled AND a
    /// non-zero cap), to the L2 block of that transition.
    function test_activeSince_movesOnlyWhenTheRuleBecomesActive() public {
        vm.prank(alice);
        rules.setRule(1, 1, 50e6, true);
        uint256 first = vm.getBlockNumber(); // via-ir may re-read block.number after a roll
        assertEq(rules.activeSince(alice), first);

        // Editing an active rule (cap, roundTo, multiplier) is not a new consent point.
        vm.roll(block.number + 100);
        vm.prank(alice);
        rules.setRule(5, 3, 80e6, true);
        assertEq(rules.activeSince(alice), first, "still active: unchanged");

        // Disabling does not move it; re-enabling does.
        vm.roll(block.number + 100);
        vm.prank(alice);
        rules.setRule(5, 3, 80e6, false);
        assertEq(rules.activeSince(alice), first);
        vm.roll(block.number + 100);
        vm.prank(alice);
        rules.setRule(5, 3, 80e6, true);
        assertEq(rules.activeSince(alice), vm.getBlockNumber(), "re-enabled: moves forward");

        // A zero cap is inactive too: 0 -> non-zero is a fresh activation.
        uint256 before = rules.activeSince(alice);
        vm.roll(block.number + 100);
        vm.prank(alice);
        rules.setRule(1, 1, 0, true);
        assertEq(rules.activeSince(alice), before, "turning off does not move it");
        vm.roll(block.number + 100);
        vm.prank(alice);
        rules.setRule(1, 1, 10e6, true);
        assertEq(rules.activeSince(alice), vm.getBlockNumber());
    }

    function test_activeSince_notSetForAnInactiveRule() public {
        vm.startPrank(alice);
        rules.setRule(1, 1, 50e6, false);
        assertEq(rules.activeSince(alice), 0);
        rules.setRule(1, 1, 0, true);
        assertEq(rules.activeSince(alice), 0);
        vm.stopPrank();
    }

    /// activeSince is the L2 block (ArbSys), like linkedAt.
    function test_activeSince_readsTheL2Clock() public {
        vm.etch(address(0x64), address(new MockArbSysSettable()).code);
        MockArbSysSettable(address(0x64)).set(987_654_321);
        vm.prank(alice);
        rules.setRule(1, 1, 1e6, true);
        assertEq(rules.activeSince(alice), 987_654_321);
    }

    // ── linkSelf ─────────────────────────────────────────────────────────

    function test_linkSelf() public {
        vm.expectEmit(true, true, false, false, address(rules));
        emit Linked(alice, alice);
        vm.prank(alice);
        rules.linkSelf();
        assertEq(rules.accountOf(alice), alice);
        assertTrue(rules.isLinked(alice, alice));
        address[] memory w = rules.walletsOf(alice);
        assertEq(w.length, 1);
        assertEq(w[0], alice);
        assertEq(rules.linkedAt(alice), block.number);
    }

    function test_linkSelf_twiceReverts() public {
        vm.startPrank(alice);
        rules.linkSelf();
        vm.expectRevert(abi.encodeWithSelector(RuleRegistry.AlreadyLinked.selector, alice, alice));
        rules.linkSelf();
        vm.stopPrank();
    }

    /// linkedAt is the L2 block from ArbSys, not Nitro's L1-estimate block.number,
    /// so it lines up with the engine's eth_blockNumber-indexed cursor.
    function test_linkedAt_readsTheL2Clock() public {
        vm.etch(address(0x64), address(new MockArbSysSettable()).code);
        MockArbSysSettable(address(0x64)).set(123_456_789);
        vm.prank(alice);
        rules.linkSelf();
        assertEq(rules.linkedAt(alice), 123_456_789);
        assertTrue(rules.linkedAt(alice) != block.number);
    }

    // ── linkWallet (EIP-712) ─────────────────────────────────────────────

    function test_domainSeparator_matchesEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SPARE RuleRegistry"),
                keccak256("1"),
                block.chainid,
                address(rules)
            )
        );
        assertEq(rules.domainSeparator(), expected);
        assertEq(
            rules.LINK_TYPEHASH(), keccak256("Link(address account,address wallet,uint256 nonce,uint256 deadline)")
        );
    }

    function test_linkWallet_withWalletSignature() public {
        _linkSigned(alice, wallet, walletKey);
        assertEq(rules.accountOf(wallet), alice);
        assertTrue(rules.isLinked(alice, wallet));
        assertEq(rules.nonces(wallet), 1, "nonce consumed");
        assertEq(rules.linkedAt(wallet), block.number);
    }

    function test_linkWallet_replayWhileLinkedReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        rules.linkWallet(wallet, deadline, sig);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);
    }

    /// Unlinking withdraws consent; the old signature cannot bring the link back.
    function test_linkWallet_replayAfterUnlinkReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        rules.linkWallet(wallet, deadline, sig);
        vm.prank(wallet);
        rules.unlink(wallet);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);
        assertEq(rules.nonces(wallet), 2, "link + unlink");
        // A fresh signature over the new nonce works.
        _linkSigned(alice, wallet, walletKey);
        assertTrue(rules.isLinked(alice, wallet));
        assertEq(rules.nonces(wallet), 3);
    }

    /// Unlink itself bumps the nonce, so a signature the wallet handed out while
    /// linked (e.g. to move to another account) dies when it withdraws consent.
    function test_unlink_bumpsNonceSoAnOldSignatureCannotBeReplayed() public {
        _linkSigned(alice, wallet, walletKey);
        assertEq(rules.nonces(wallet), 1);
        uint256 deadline = block.timestamp + 30 days;
        bytes memory forBob = _sig(rules, walletKey, bob, wallet, 1, deadline); // current nonce

        vm.prank(wallet);
        rules.unlink(wallet);
        assertEq(rules.nonces(wallet), 2, "unlink bumped the nonce");

        vm.prank(bob);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, forBob);
        assertEq(rules.accountOf(wallet), address(0), "consent withdrawn stays withdrawn");
    }

    /// linkSelf also consumes the wallet's nonce: a signature issued before the
    /// wallet linked itself cannot be used after the wallet unlinks again.
    function test_linkSelf_consumesNonce() public {
        uint256 deadline = block.timestamp + 30 days;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.startPrank(wallet);
        rules.linkSelf();
        assertEq(rules.nonces(wallet), 1);
        rules.unlink(wallet);
        assertEq(rules.nonces(wallet), 2);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);
    }

    /// A wallet can kill every outstanding link signature without linking at all.
    function test_invalidateNonce_killsOutstandingSignatures() public {
        uint256 deadline = block.timestamp + 30 days;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.expectEmit(true, false, false, true, address(rules));
        emit NonceInvalidated(wallet, 1);
        vm.prank(wallet);
        rules.invalidateNonce();
        assertEq(rules.nonces(wallet), 1);

        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);

        // Only the caller's own nonce moves.
        assertEq(rules.nonces(alice), 0);
        _linkSigned(alice, wallet, walletKey); // a signature over nonce 1 works
        assertTrue(rules.isLinked(alice, wallet));
        assertEq(rules.nonces(wallet), 2);
    }

    function test_linkWallet_expiredReverts() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.Expired.selector);
        rules.linkWallet(wallet, deadline, sig);
    }

    function test_linkWallet_deadlineIsInclusive() public {
        uint256 deadline = block.timestamp;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        rules.linkWallet(wallet, deadline, sig);
        assertTrue(rules.isLinked(alice, wallet));
    }

    function test_linkWallet_wrongSignerReverts() public {
        (, uint256 otherKey) = makeAddrAndKey("impostor");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, otherKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);
    }

    /// The signature names the account: bob cannot use a signature made for alice.
    function test_linkWallet_signatureBoundToAccount() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(bob);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);
    }

    function test_linkWallet_signatureBoundToWallet() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(bob, deadline, sig);
    }

    function test_linkWallet_signatureBoundToDeadline() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline + 1, sig);
    }

    /// A signature for another RuleRegistry deployment (different domain) is refused.
    function test_linkWallet_signatureBoundToDomain() public {
        RuleRegistry other = new RuleRegistry();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(other, walletKey, alice, wallet, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(wallet, deadline, sig);
    }

    function test_linkWallet_erc1271SmartWallet() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("sw-signer");
        Mock1271Wallet sw = new Mock1271Wallet(signer);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, signerKey, alice, address(sw), 0, deadline);
        vm.prank(alice);
        rules.linkWallet(address(sw), deadline, sig);
        assertTrue(rules.isLinked(alice, address(sw)));

        (, uint256 badKey) = makeAddrAndKey("sw-impostor");
        Mock1271Wallet sw2 = new Mock1271Wallet(signer);
        bytes memory bad = _sig(rules, badKey, alice, address(sw2), 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rules.linkWallet(address(sw2), deadline, bad);
    }

    function test_linkWallet_alreadyLinkedElsewhereReverts() public {
        _linkSigned(bob, wallet, walletKey);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, walletKey, alice, wallet, 1, deadline);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RuleRegistry.AlreadyLinked.selector, wallet, bob));
        rules.linkWallet(wallet, deadline, sig);
    }

    // ── unlink ───────────────────────────────────────────────────────────

    function test_unlink_byAccount() public {
        _linkSigned(alice, wallet, walletKey);
        vm.expectEmit(true, true, false, false, address(rules));
        emit Unlinked(alice, wallet);
        vm.prank(alice);
        rules.unlink(wallet);
        assertFalse(rules.isLinked(alice, wallet));
        assertEq(rules.accountOf(wallet), address(0));
        assertEq(rules.walletsOf(alice).length, 0);
    }

    function test_unlink_byWalletItself() public {
        _linkSigned(alice, wallet, walletKey);
        vm.prank(wallet);
        rules.unlink(wallet);
        assertFalse(rules.isLinked(alice, wallet));
    }

    function test_unlink_byStrangerReverts() public {
        _linkSigned(alice, wallet, walletKey);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RuleRegistry.NotLinked.selector, wallet));
        rules.unlink(wallet);
    }

    function test_unlink_unknownReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RuleRegistry.NotLinked.selector, wallet));
        rules.unlink(wallet);
    }

    function test_unlink_keepsTheOtherWallets() public {
        (address w2, uint256 k2) = makeAddrAndKey("w2");
        (address w3, uint256 k3) = makeAddrAndKey("w3");
        _linkSigned(alice, wallet, walletKey);
        _linkSigned(alice, w2, k2);
        _linkSigned(alice, w3, k3);
        vm.prank(alice);
        rules.unlink(wallet);
        address[] memory w = rules.walletsOf(alice);
        assertEq(w.length, 2);
        assertTrue((w[0] == w2 && w[1] == w3) || (w[0] == w3 && w[1] == w2));
        assertTrue(rules.isLinked(alice, w2));
        assertTrue(rules.isLinked(alice, w3));
    }

    /// Re-linking moves the consent floor forward: linkedAt is the NEW link block.
    function test_relink_updatesLinkedAt() public {
        vm.prank(alice);
        rules.linkSelf();
        uint256 first = rules.linkedAt(alice);
        vm.prank(alice);
        rules.unlink(alice);
        vm.roll(block.number + 5_000);
        vm.prank(alice);
        rules.linkSelf();
        assertEq(rules.linkedAt(alice), first + 5_000);
    }

    /// After unlinking, a wallet may consent to a different account.
    function test_unlinkedWalletCanJoinAnotherAccount() public {
        _linkSigned(alice, wallet, walletKey);
        vm.prank(wallet);
        rules.unlink(wallet);
        _linkSigned(bob, wallet, walletKey);
        assertTrue(rules.isLinked(bob, wallet));
        assertFalse(rules.isLinked(alice, wallet));
    }

    function test_isLinked_zeroAccountIsNeverLinked() public view {
        assertFalse(rules.isLinked(address(0), wallet), "unlinked wallet has accountOf == 0");
    }

    // ── MAX_WALLETS ──────────────────────────────────────────────────────

    function test_maxWallets() public {
        assertEq(rules.MAX_WALLETS(), 8);
        address[8] memory ws;
        for (uint256 i; i < 8; ++i) {
            (address w, uint256 k) = makeAddrAndKey(string.concat("mw", vm.toString(i)));
            ws[i] = w;
            _linkSigned(alice, w, k);
        }
        assertEq(rules.walletsOf(alice).length, 8);

        (address ninth, uint256 k9) = makeAddrAndKey("mw-ninth");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(rules, k9, alice, ninth, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.TooManyWallets.selector);
        rules.linkWallet(ninth, deadline, sig);

        // linkSelf counts toward the same limit.
        vm.prank(alice);
        vm.expectRevert(RuleRegistry.TooManyWallets.selector);
        rules.linkSelf();

        // Freeing a slot makes room again.
        vm.prank(alice);
        rules.unlink(ws[3]);
        vm.prank(alice);
        rules.linkWallet(ninth, deadline, sig);
        assertEq(rules.walletsOf(alice).length, 8);
        assertTrue(rules.isLinked(alice, ninth));
    }
}
