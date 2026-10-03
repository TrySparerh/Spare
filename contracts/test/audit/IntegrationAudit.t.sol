// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {ScreeningGate} from "../../src/ScreeningGate.sol";
import {RuleRegistry} from "../../src/RuleRegistry.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";
import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {AuditBase} from "./AuditBase.sol";

interface IStockRegistry {
    function blockAccounts(address[] calldata) external;
    function isBlocked(address) external view returns (bool);
    function pause() external;
    function paused() external view returns (bool);
    function hasRole(bytes32, address) external view returns (bool);
}

interface IStockTok {
    function pause() external;
    function paused() external view returns (bool);
    function tokenPaused() external view returns (bool);
}

/// @notice REGRESSIONS for the RHC stock-token integration findings (blocklist,
///         pauses) and netted-leg breach behaviour, driven through the REAL token /
///         registry code on a mainnet fork. Roles are granted by writing the
///         registry's own hasRole slot, located with vm.record, so no token
///         behaviour is mocked.
contract IntegrationAudit is AuditBase {
    bytes32 constant BLOCKLIST_ROLE = 0x8f2e0057cd5e35397007bcc8f5418f73dd64cc6e4073a0276563f247c3079037;
    bytes32 constant REG_PAUSER_ROLE = 0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a;
    bytes32 constant TOKEN_PAUSER_ROLE = 0xe95e22ec6dbf4c911d1fae59680a3e9cb71dd35b3a1c697d232e4b01a8ff30a2;

    event ExitUnitsKept(address indexed account, uint256 units);

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");
    address issuerOps = makeAddr("issuerOps");

    function _grant(bytes32 role, address who) internal {
        vm.record();
        IStockRegistry(STOCK_REGISTRY).hasRole(role, who);
        (bytes32[] memory reads,) = vm.accesses(STOCK_REGISTRY);
        for (uint256 i; i < reads.length; ++i) {
            bytes32 prev = vm.load(STOCK_REGISTRY, reads[i]);
            vm.store(STOCK_REGISTRY, reads[i], bytes32(uint256(1)));
            if (IStockRegistry(STOCK_REGISTRY).hasRole(role, who)) return;
            vm.store(STOCK_REGISTRY, reads[i], prev);
        }
        revert("role slot not found");
    }

    function _block(address who) internal {
        _grant(BLOCKLIST_ROLE, issuerOps);
        address[] memory a = new address[](1);
        a[0] = who;
        vm.prank(issuerOps);
        IStockRegistry(STOCK_REGISTRY).blockAccounts(a);
        assertTrue(IStockRegistry(STOCK_REGISTRY).isBlocked(who));
    }

    // ── 1. blocklisted account: batch survives, and claim cannot route around the blocklist ──

    /// Was: claim(token, to) let a blocklisted account send its held shares to any
    /// address. claim(token) now always pays msg.sender, so the issuer's blocklist
    /// keeps applying to the held balance.
    function test_blocklistedAccount_batchSurvives_claimCannotBypassBlocklist() public {
        _onboard(alice, 100e6);
        _onboard(bob, 100e6);
        _accrue(alice, 10e6);
        _accrue(bob, 10e6);
        _block(alice);

        address[] memory accts = new address[](2);
        accts[0] = alice;
        accts[1] = bob;
        assertEq(_keeperSweep(accts), 2, "one blocked account does not revert the netted sweep");
        assertGt(IERC20(SPY).balanceOf(bob), 0, "bob delivered");
        assertEq(IERC20(SPY).balanceOf(alice), 0, "alice push refused by the token");
        uint256 held = exec.claimable(alice, SPY);
        assertGt(held, 0, "alice's SPY held as claimable");

        // The issuer's blocklist refuses the claim to alice ...
        vm.prank(alice);
        vm.expectRevert();
        exec.claim(SPY);
        assertEq(exec.claimable(alice, SPY), held, "still held for alice");
        // ... and there is no other address alice can direct it to: claimable is
        // keyed by msg.sender, so a fresh address has nothing to claim.
        address fresh = makeAddr("fresh");
        vm.prank(fresh);
        exec.claim(SPY);
        assertEq(IERC20(SPY).balanceOf(fresh), 0, "blocklist not bypassed");
        assertEq(exec.claimable(alice, SPY), held);
    }

    // ── 2. registry-wide (issuer) pause: never a USDG payout ──

    /// Was informational: whether the executor saw the issuer pause, the SPY/NVDA
    /// buy failed and the legs were safe-settled to USDG. Any failure now defers.
    function test_registryPause_isNeverAUsdgPayout() public {
        _onboard(alice, 100e6);
        _accrue(alice, 10e6);
        _grant(REG_PAUSER_ROLE, issuerOps);
        vm.prank(issuerOps);
        IStockRegistry(STOCK_REGISTRY).pause();

        emit log_named_string("registry.paused()", IStockRegistry(STOCK_REGISTRY).paused() ? "true" : "false");
        emit log_named_string("SPY.paused()", IStockTok(SPY).paused() ? "true" : "false");
        (OracleGuard.Status st,) = router.oracleStatus(SPY);
        emit log_named_uint("router.oracleStatus(SPY) (0=OK,2=PAUSED)", uint8(st));

        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        assertEq(_keeperSweep(_one(alice)), 1);
        assertEq(IERC20(USDG).balanceOf(alice), usdgBefore, "a pause is never paid out as USDG");
        // Each leg either converted or is back in the park; nothing is lost.
        uint256 deferred = park.pending(alice);
        if (IERC20(SPY).balanceOf(alice) == 0) assertGe(deferred, 6e6, "SPY leg deferred");
        if (IERC20(NVDA).balanceOf(alice) == 0) assertGe(deferred, 4e6, "NVDA leg deferred");
        emit log_named_decimal_uint("alice value back in park (deferred)", deferred, 6);
        emit log_named_decimal_uint("alice SPY", IERC20(SPY).balanceOf(alice), 18);
    }

    // ── 3. SGOV adapter: a token pause no longer traps exit() or the pending USDG ──

    function _sgovPark(uint256 parked, uint256 pendingAfter) internal returns (SgovParkAdapter sg) {
        vm.startPrank(owner);
        sg = new SgovParkAdapter(USDG, SGOV, address(park), router, 100);
        router.setCaller(address(sg), true);
        park.setAdapter(sg);
        vm.stopPrank();
        _onboard(alice, parked + pendingAfter);
        _accrue(alice, parked);
        vm.prank(keeper);
        park.park(_one(alice));
        assertGt(park.units(alice), 0);
        if (pendingAfter != 0) _accrue(alice, pendingAfter);
    }

    /// Was: redeem reverted (caught), exitInKind reverted (NOT caught), and the whole
    /// exit reverted — including the 7 USDG that never touched SGOV.
    function test_sgovTokenPause_exitStillPaysPendingUsdg() public {
        _sgovPark(20e6, 7e6);
        assertEq(park.pending(alice), 7e6, "alice also holds plain un-parked USDG");
        uint256 units = park.units(alice);

        _grant(TOKEN_PAUSER_ROLE, issuerOps);
        vm.prank(issuerOps);
        IStockTok(SGOV).pause();
        assertTrue(IStockTok(SGOV).paused());

        uint256 before = IERC20(USDG).balanceOf(alice);
        vm.expectEmit(true, false, false, true, address(park));
        emit ExitUnitsKept(alice, units);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = park.exit();
        assertEq(out, 7e6, "pending USDG paid");
        assertEq(inKind, 0);
        assertEq(IERC20(USDG).balanceOf(alice) - before, 7e6);
        assertEq(park.pending(alice), 0);
        assertEq(park.units(alice), units, "SGOV units stay booked to alice, not lost");
        assertEq(park.totalUnits(), units);
    }

    /// Was informational ("exit() under registry-wide pause: REVERTED"). Exit now
    /// never reverts: units are redeemed, handed over in kind, or kept booked.
    function test_sgovRegistryPause_exitDoesNotRevert() public {
        _sgovPark(20e6, 3e6);
        uint256 units = park.units(alice);
        _grant(REG_PAUSER_ROLE, issuerOps);
        vm.prank(issuerOps);
        IStockRegistry(STOCK_REGISTRY).pause();

        uint256 before = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = park.exit();
        assertGe(out, 3e6, "pending USDG always paid");
        assertEq(IERC20(USDG).balanceOf(alice) - before, out);
        assertEq(park.pending(alice), 0);
        uint256 kept = park.units(alice);
        assertTrue(kept == 0 || kept == units, "units either left whole or stayed whole");
        if (kept == 0 && inKind == 0) assertGt(out, 3e6, "redeemed to USDG");
        if (inKind != 0) assertEq(IERC20(SGOV).balanceOf(alice), units, "handed over in kind");
        emit log_named_decimal_uint("exit USDG out", out, 6);
        emit log_named_decimal_uint("exit units in kind", inKind, 18);
        emit log_named_decimal_uint("units kept booked", kept, 18);
    }

    // ── 4. netted leg: nobody can pick the batch, and an unfillable leg is not paid out ──

    function _nvdaOnly(address u, uint256 amt) internal {
        _onboard(u, amt);
        _setMix(u, NVDA);
        _accrue(u, amt);
    }

    /// Was: mallory (anyone) swept [mallory $3,000, alice $100] together, the netted
    /// NVDA leg breached, and alice's buy was paid out as USDG with her epoch burned
    /// — at no cost to mallory. Now only the keeper chooses the batch, and even an
    /// oversized netted leg defers for every contributor instead of paying USDG.
    function test_nettedLeg_cannotBeForcedToUsdg() public {
        _nvdaOnly(alice, 100e6);
        _nvdaOnly(mallory, 3_000e6);
        address[] memory accts = new address[](2);
        accts[0] = mallory;
        accts[1] = alice;

        SweepExecutor.Limit[] memory l = _oracleLimits();
        vm.prank(mallory);
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.sweep(accts, l);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(SpareAuth.NotKeeper.selector);
        exec.sweep(accts, l);

        uint256 aliceUsdg = IERC20(USDG).balanceOf(alice);
        uint256 malUsdg = IERC20(USDG).balanceOf(mallory);
        assertEq(_keeperSweep(accts, l), 2);
        assertEq(IERC20(USDG).balanceOf(alice), aliceUsdg, "alice never paid out as USDG");
        assertEq(IERC20(USDG).balanceOf(mallory), malUsdg);
        bool filled = IERC20(NVDA).balanceOf(alice) > 0;
        if (!filled) {
            assertEq(park.pending(alice), 100e6, "alice's leg deferred whole");
            assertEq(park.pending(mallory), 3_000e6);
        } else {
            assertGt(IERC20(NVDA).balanceOf(mallory), 0, "one netted fill for both");
        }
        emit log_named_string("netted $3,100 NVDA leg", filled ? "filled within bounds" : "DEFERRED (not paid out)");
    }

    /// Informational: the largest netted NVDA leg that converts at this block (a
    /// larger one now defers rather than safe-settling).
    function test_nettedLeg_maxConvertibleSize_NVDA() public {
        _nvdaOnly(alice, 20_000e6);
        uint256 s = vm.snapshotState();
        // bisect on the account's parked amount by exiting the excess first
        uint256 lo = 500e6;
        uint256 hi = 20_000e6;
        for (uint256 i; i < 9; ++i) {
            vm.revertToState(s);
            uint256 mid = (lo + hi) / 2;
            vm.prank(alice);
            park.exit();
            vm.prank(alice);
            IERC20(USDG).transfer(address(0xdead), 20_000e6 - mid);
            _accrue(alice, mid);
            _keeperSweep(_one(alice));
            if (IERC20(NVDA).balanceOf(alice) > 0) {
                lo = mid;
            } else {
                assertEq(park.pending(alice), mid, "an unfillable leg defers whole");
                hi = mid;
            }
        }
        emit log_named_decimal_uint("largest netted NVDA leg that converts (USDG, +/- bracket)", lo, 6);
        emit log_named_decimal_uint("smallest netted NVDA leg that defers (USDG)", hi, 6);
    }

    // ── 5. accrueBatch: one wallet revoking Permit2 no longer reverts the batch ──

    function test_accrueBatch_oneRevokedPermit2IsSkipped() public {
        _onboard(alice, 100e6);
        _onboard(bob, 100e6);
        vm.roll(block.number + exec.finalityBuffer() + 10);
        uint256 to = block.number - exec.finalityBuffer() - 1;
        vm.prank(bob);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), 0, 0);
        SweepExecutor.Accrual[] memory b = new SweepExecutor.Accrual[](2);
        b[0] = SweepExecutor.Accrual(alice, alice, 1e6, to);
        b[1] = SweepExecutor.Accrual(bob, bob, 1e6, to);
        vm.prank(keeper);
        assertEq(exec.accrueBatch(b), 1, "alice accrued, bob skipped");
        assertEq(park.pending(alice), 1e6);
        assertEq(park.pending(bob), 0);
        assertEq(exec.lastAccruedBlock(bob), 0, "bob's range is retried later");
    }
}

/// @notice REGRESSION: ScreeningGate.revoke now invalidates outstanding signed
///         clearances (it bumps the account's nonce).
contract ScreeningRevokeAudit is Test {
    function test_revokeKillsHeldSignature() public {
        (address attestor, uint256 pk) = makeAddrAndKey("attestor");
        address user = makeAddr("user");
        ScreeningGate g = new ScreeningGate(address(this), attestor, true);

        // Attestor issues a 1-year clearance; the user's client holds it.
        uint64 until = uint64(block.timestamp + 365 days);
        bytes32 structHash = keccak256(abi.encode(g.CLEARANCE_TYPEHASH(), user, until, g.nonces(user)));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SPARE ScreeningGate"),
                keccak256("1"),
                block.chainid,
                address(g)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        bytes memory sig = abi.encodePacked(r, s, v);

        // Screening later fails (e.g. the user turns out to be a US person). Revoke.
        vm.prank(attestor);
        g.revoke(user);
        assertFalse(g.isEligible(user));

        // The user submits the clearance it was already holding: refused.
        vm.prank(user);
        vm.expectRevert(ScreeningGate.BadSignature.selector);
        g.submitClearance(until, sig);
        assertFalse(g.isEligible(user), "revocation stands");
        assertEq(g.clearedUntil(user), 0);
    }
}

/// @notice REGRESSION: RuleRegistry.linkSelf / unlink now consume the wallet's
///         nonce, so a link signature handed out earlier dies with them.
contract LinkReplayAudit is Test {
    function test_unlinkedWalletCannotBeRelinkedByOldSignature() public {
        RuleRegistry rr = new RuleRegistry();
        (address wallet, uint256 pk) = makeAddrAndKey("wallet");
        address account = makeAddr("account");

        uint256 deadline = block.timestamp + 30 days;
        bytes32 structHash = keccak256(abi.encode(rr.LINK_TYPEHASH(), account, wallet, rr.nonces(wallet), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", rr.domainSeparator(), structHash)));
        bytes memory sig = abi.encodePacked(r, s, v);

        // Wallet changes its mind before the account submits: it links itself, then
        // withdraws consent entirely. Both steps bump nonces[wallet].
        vm.startPrank(wallet);
        rr.linkSelf();
        rr.unlink(wallet);
        vm.stopPrank();
        assertEq(rr.accountOf(wallet), address(0));
        assertEq(rr.nonces(wallet), 2);

        vm.prank(account);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rr.linkWallet(wallet, deadline, sig);
        assertEq(rr.accountOf(wallet), address(0), "consent withdrawn stays withdrawn");
    }

    /// Without linking at all, a wallet can kill a signature it regrets.
    function test_invalidateNonceKillsOldSignature() public {
        RuleRegistry rr = new RuleRegistry();
        (address wallet, uint256 pk) = makeAddrAndKey("wallet");
        address account = makeAddr("account");
        uint256 deadline = block.timestamp + 30 days;
        bytes32 structHash = keccak256(abi.encode(rr.LINK_TYPEHASH(), account, wallet, uint256(0), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", rr.domainSeparator(), structHash)));

        vm.prank(wallet);
        rr.invalidateNonce();
        vm.prank(account);
        vm.expectRevert(RuleRegistry.BadSignature.selector);
        rr.linkWallet(wallet, deadline, abi.encodePacked(r, s, v));
    }
}
