// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";

import {AcceptOwnership} from "../../script/AcceptOwnership.s.sol";
import {AddAssets} from "../../script/AddAssets.s.sol";
import {GovernanceBase} from "../../script/governance/GovernanceBase.sol";
import {TimelockBatch} from "../../script/governance/TimelockBatch.s.sol";

import {MockFeed} from "../mocks/MockFeed.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {AddAssetsHarness, SafeLikeStub, ScriptOpsBase} from "./ScriptOpsBase.sol";

contract AcceptOwnershipHarness is AcceptOwnership {
    Deployment internal _d;

    constructor(Deployment memory d) {
        _d = d;
    }

    function _loadDeployment() internal view override returns (Deployment memory, string memory, string memory) {
        return (_d, "", "(in-memory test deployment)");
    }
}

contract TimelockBatchHarness is TimelockBatch {
    /// @dev The batch TimelockBatch builds when SPARE_TIMELOCK_CALLS_JSON is unset.
    function exposed_defaultBatch(Deployment memory d, TimelockController tl)
        external
        view
        returns (address[] memory, bytes[] memory, bytes32)
    {
        Batch memory b = _batch(d, tl);
        return (b.targets, b.payloads, b.salt);
    }

    function exposed_customBatch(Deployment memory d, TimelockController tl, string memory callsJson)
        external
        view
        returns (address[] memory, uint256[] memory, bytes[] memory)
    {
        Batch memory b = _customBatch(d, tl, callsJson);
        return (b.targets, b.values, b.payloads);
    }

    /// @dev The per-call lines the generator prints under "== batch:".
    function exposed_customLabels(Deployment memory d, TimelockController tl, string memory callsJson)
        external
        view
        returns (string[] memory)
    {
        return _customBatch(d, tl, callsJson).labels;
    }
}

/// @notice The ops scripts after the owner -> Safe + 48 h timelock hand-over
///         (docs/GOVERNANCE.md): AcceptOwnership does not offer a Safe batch that
///         would revert, AddAssets prints the calls for the timelock instead of
///         refusing, and TimelockBatch takes them exactly as printed.
/// @dev The real SPARE contracts and a real OpenZeppelin TimelockController; the
///      scripts read this in-memory deployment and config instead of files. In a
///      test the scripts' broadcaster is forge's DEFAULT_SENDER.
contract GovernanceOpsTest is ScriptOpsBase {
    MockStockToken internal aapl;
    MockFeed internal aaplFeed;
    TimelockBatchHarness internal tb;

    function setUp() public override {
        super.setUp();
        aapl = new MockStockToken("Apple", "AAPL");
        aaplFeed = new MockFeed(8, 250e8);
        tb = new TimelockBatchHarness();
    }

    // ── fixture ────────────────────────────────────────────────────────────

    function _callsJson(uint256 n, string memory extra) internal view returns (string memory json) {
        for (uint256 i; i < n; ++i) {
            json = string.concat(
                json, i == 0 ? "[" : ",", "{\"to\":\"", vm.toString(address(registry)), "\",", extra,
                "\"data\":\"0x3f4ba83a\"}"
            );
        }
        json = string.concat(json, "]");
    }

    // ── AcceptOwnership ────────────────────────────────────────────────────

    /// The Safe is not the pending owner, so a Safe batch of acceptOwnership()
    /// would revert: none is printed, and the batch AcceptOwnership points to
    /// (TimelockBatch's default) is the one that completes the hand-over.
    function test_acceptOwnership_pendingTimelock_pointsToTimelockBatch() public {
        _nominate(address(tl));
        (uint256 pending, bool viaTimelock) = new AcceptOwnershipHarness(_deployment()).run();
        assertEq(pending, 7);
        assertTrue(viaTimelock, "a timelock nominee gets no direct Safe batch");

        (address[] memory t, bytes[] memory p,) = tb.exposed_defaultBatch(_deployment(), tl);
        _throughTimelock(t, p, keccak256("SPARE: acceptOwnership x7"));
        SpareAuth[7] memory c = _seven();
        for (uint256 i; i < 7; ++i) {
            assertEq(c[i].owner(), address(tl));
            assertEq(c[i].pendingOwner(), address(0));
        }
        (pending, viaTimelock) = new AcceptOwnershipHarness(_deployment()).run();
        assertEq(pending, 0);
        assertFalse(viaTimelock);
    }

    function test_acceptOwnership_pendingSafe_stillPrintsTheSafeBatch() public {
        _nominate(address(new SafeLikeStub()));
        (uint256 pending, bool viaTimelock) = new AcceptOwnershipHarness(_deployment()).run();
        assertEq(pending, 7);
        assertFalse(viaTimelock);
    }

    function test_acceptOwnership_pendingEoa_stillPrintsTheBatch() public {
        _nominate(makeAddr("new owner EOA"));
        (uint256 pending, bool viaTimelock) = new AcceptOwnershipHarness(_deployment()).run();
        assertEq(pending, 7);
        assertFalse(viaTimelock);
    }

    // ── AddAssets, owner = timelock ────────────────────────────────────────

    /// All three kinds of action: re-pin (NVDA band), deactivate (QQQ), register
    /// and activate (AAPL). The dry run prints them; TimelockBatch parses that
    /// JSON; scheduled and executed 48 h later, it leaves the registry matching
    /// the config.
    function test_addAssets_timelockOwner_printsTheBatchTheTimelockExecutes() public {
        _registryOwnedByTimelock();
        _cfgAssets[1].bandBps = 200;
        _cfgAssets[2].active = false;
        _want("AAPL", address(aapl), address(aaplFeed), BAND, true);
        AddAssetsHarness s = new AddAssetsHarness(_deployment(), this);

        uint256 snap = vm.snapshotState();
        (uint256 n, string memory json) = s.exposed_run();
        assertEq(n, 4);
        assertFalse(registry.isEligible(address(qqq)), "the dry run simulates the batch as the owner");
        vm.revertToState(snap);
        assertTrue(registry.isEligible(address(qqq)));
        assertFalse(registry.isRegistered(address(aapl)));

        (address[] memory to, uint256[] memory value, bytes[] memory data) =
            tb.exposed_customBatch(_deployment(), tl, json);
        bytes[4] memory want = [
            abi.encodeCall(AssetRegistry.setAsset, (address(nvda), address(nvdaFeed), HEARTBEAT, 200, _key(address(nvda)))),
            abi.encodeCall(AssetRegistry.setActive, (address(qqq), false)),
            abi.encodeCall(AssetRegistry.setAsset, (address(aapl), address(aaplFeed), HEARTBEAT, BAND, _key(address(aapl)))),
            abi.encodeCall(AssetRegistry.setActive, (address(aapl), true))
        ];
        assertEq(to.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(to[i], address(registry));
            assertEq(value[i], 0);
            assertEq(data[i], want[i]);
        }

        _throughTimelock(to, data, keccak256("AddAssets"));
        assertEq(registry.get(address(nvda)).bandBps, 200);
        assertTrue(registry.isEligible(address(nvda)));
        assertFalse(registry.isEligible(address(qqq)));
        assertTrue(registry.isEligible(address(aapl)));
        (n, json) = s.exposed_run();
        assertEq(n, 0);
        assertEq(bytes(json).length, 0);
    }

    function test_addAssets_ownerContractThatIsNotATimelock_alsoGetsTheCalls() public {
        SafeLikeStub other = new SafeLikeStub();
        vm.prank(owner);
        registry.transferOwnership(address(other));
        vm.prank(address(other));
        registry.acceptOwnership();
        _cfgAssets[2].active = false;
        (uint256 n, string memory json) = new AddAssetsHarness(_deployment(), this).exposed_run();
        assertEq(n, 1);
        (address[] memory to,, bytes[] memory data) = tb.exposed_customBatch(_deployment(), tl, json);
        assertEq(to.length, 1);
        assertEq(data[0], abi.encodeCall(AssetRegistry.setActive, (address(qqq), false)));
    }

    /// 33 new active assets = 66 calls: more than TimelockBatch takes in one batch.
    function test_addAssets_timelockOwner_refusesMoreCallsThanOneBatch() public {
        _registryOwnedByTimelock();
        for (uint256 i; i < 33; ++i) {
            address t = address(new MockStockToken("T", "T"));
            _want(string.concat("T", vm.toString(i)), t, address(spyFeed), BAND, true);
        }
        AddAssetsHarness s = new AddAssetsHarness(_deployment(), this);
        vm.expectRevert(
            abi.encodeWithSelector(
                AddAssets.Refused.selector,
                "66 actions exceed the 64-call timelock batch; apply the config change in smaller steps"
            )
        );
        s.exposed_run();
    }

    // ── AddAssets, owner = EOA (unchanged) ─────────────────────────────────

    function test_addAssets_eoaOwner_sendsAsBeforeAndPrintsNoCalls() public {
        vm.prank(owner);
        registry.transferOwnership(DEFAULT_SENDER);
        vm.prank(DEFAULT_SENDER);
        registry.acceptOwnership();
        _cfgAssets[2].active = false;
        (uint256 n, string memory json) = new AddAssetsHarness(_deployment(), this).exposed_run();
        assertEq(n, 1);
        assertEq(bytes(json).length, 0);
        assertFalse(registry.isEligible(address(qqq)));
    }

    function test_addAssets_eoaOwner_otherSenderStillRefused() public {
        AddAssetsHarness s = new AddAssetsHarness(_deployment(), this);
        vm.expectRevert(_notTheOwner());
        s.exposed_run();
    }

    /// An EIP-7702-delegated EOA has code (the 23-byte delegation designator) but
    /// still signs with its own key: it keeps the EOA path, sender check included.
    function test_addAssets_7702DelegatedEoaOwner_otherSenderStillRefused() public {
        vm.etch(owner, _delegation(address(new SafeLikeStub())));
        AddAssetsHarness s = new AddAssetsHarness(_deployment(), this);
        vm.expectRevert(_notTheOwner());
        s.exposed_run();
    }

    function test_addAssets_7702DelegatedEoaOwner_sendsAsBeforeAndPrintsNoCalls() public {
        vm.prank(owner);
        registry.transferOwnership(DEFAULT_SENDER);
        vm.prank(DEFAULT_SENDER);
        registry.acceptOwnership();
        vm.etch(DEFAULT_SENDER, _delegation(address(new SafeLikeStub())));
        _cfgAssets[2].active = false;
        (uint256 n, string memory json) = new AddAssetsHarness(_deployment(), this).exposed_run();
        assertEq(n, 1);
        assertEq(bytes(json).length, 0);
        assertFalse(registry.isEligible(address(qqq)));
    }

    function _notTheOwner() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            AddAssets.Refused.selector,
            string.concat(
                "sender ", vm.toString(DEFAULT_SENDER), " is not the AssetRegistry owner ", vm.toString(owner),
                " (dry run: pass --sender <owner>)"
            )
        );
    }

    // ── TimelockBatch custom batches ───────────────────────────────────────

    function test_timelockBatch_readsCallsWithAndWithoutValue() public view {
        (address[] memory to, uint256[] memory value, bytes[] memory data) =
            tb.exposed_customBatch(_deployment(), tl, _callsJson(2, ""));
        assertEq(to.length, 2);
        (to, value, data) = tb.exposed_customBatch(_deployment(), tl, _callsJson(3, "\"value\":\"0\","));
        assertEq(to.length, 3);
        assertEq(value[2], 0);
        assertEq(data[2], hex"3f4ba83a");
    }

    /// The line a signer reads for each call names the 4-byte selector, not a
    /// 32-byte word.
    function test_timelockBatch_labelsShowTheFourByteSelector() public view {
        string[] memory labels = tb.exposed_customLabels(_deployment(), tl, _callsJson(1, ""));
        assertEq(labels.length, 1);
        assertEq(labels[0], string.concat("AssetRegistry ", vm.toString(address(registry)), "  selector 0x3f4ba83a"));
    }

    function test_timelockBatch_refusesMoreThan64Calls() public {
        (address[] memory to,,) = tb.exposed_customBatch(_deployment(), tl, _callsJson(64, ""));
        assertEq(to.length, 64);
        vm.expectRevert(abi.encodeWithSelector(GovernanceBase.Refused.selector, "more than 64 calls; split the batch"));
        tb.exposed_customBatch(_deployment(), tl, _callsJson(65, ""));
    }

    function test_timelockBatch_refusesANonZeroValue() public {
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceBase.Refused.selector, "call 0 has a non-zero value; the batch sends none")
        );
        tb.exposed_customBatch(_deployment(), tl, _callsJson(1, "\"value\":\"1\","));
    }
}
