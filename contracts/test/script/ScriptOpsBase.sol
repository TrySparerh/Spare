// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AddAssets} from "../../script/AddAssets.s.sol";
import {SpareBase} from "../../script/lib/SpareBase.sol";
import {SpareConfig} from "../../script/lib/SpareConfig.sol";
import {SpareAuth} from "../../src/SpareAuth.sol";

import {UnitBase} from "../unit/UnitBase.sol";

interface IConfigSource {
    function config() external view returns (SpareConfig.Config memory);
}

/// @dev Stands in for the v4 PoolManager in AddAssets' preflight: every pool reads
///      as initialised, with in-range liquidity.
contract PoolStateStub {
    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(uint256(1) << 96);
    }
}

/// @dev An owner contract that is not a timelock. Like a Safe proxy without a
///      fallback handler, it answers any unknown call with empty success.
contract SafeLikeStub {
    fallback() external {}
}

contract AddAssetsHarness is AddAssets {
    Deployment internal _d;
    IConfigSource internal immutable _src;

    constructor(Deployment memory d, IConfigSource src) {
        _d = d;
        _src = src;
    }

    function _loadDeployment() internal view override returns (Deployment memory, string memory, string memory) {
        return (_d, "", "(in-memory test deployment)");
    }

    function _loadConfig() internal view override returns (SpareConfig.Config memory) {
        return _src.config();
    }

    function exposed_run() external returns (uint256 nActions, string memory callsJson) {
        return _run();
    }
}

/// @notice The real SPARE contracts (StockRouter included) and a real OpenZeppelin
///         TimelockController, with the config the scripts read built in memory.
/// @dev In a test the scripts' broadcaster is forge's DEFAULT_SENDER.
abstract contract ScriptOpsBase is UnitBase, IConfigSource {
    uint256 internal constant DELAY = 48 hours;

    address internal safe = makeAddr("owner Safe");
    TimelockController internal tl;
    PoolStateStub internal poolState;

    /// @dev The `assets` of the config the scripts read (see config()).
    SpareConfig.Asset[] internal _cfgAssets;

    function _realRouter() internal pure override returns (bool) {
        return true; // the scripts read all 7 Ownable2Step contracts, StockRouter included
    }

    function setUp() public virtual override {
        super.setUp();
        address[] memory onlySafe = new address[](1);
        onlySafe[0] = safe;
        tl = new TimelockController(DELAY, onlySafe, onlySafe, address(0));
        poolState = new PoolStateStub();
        // Matches the registry UnitBase built: AddAssets starts at 0 actions.
        _want("SPY", address(spy), address(spyFeed), BAND, true);
        _want("NVDA", address(nvda), address(nvdaFeed), BAND, true);
        _want("QQQ", address(qqq), address(qqqFeed), BAND, true);
    }

    function config() external view returns (SpareConfig.Config memory c) {
        SpareConfig.Asset[] memory a = _cfgAssets;
        c.source = "(in-memory test config)";
        c.hash = keccak256(abi.encode(a));
        c.network = "unit";
        c.chainId = block.chainid;
        c.usdg = address(usdg);
        c.permit2 = address(permit2);
        c.poolManager = address(poolState);
        c.assets = a;
        c.defaultMix = new SpareConfig.MixLeg[](2);
        c.defaultMix[0] = SpareConfig.MixLeg("SPY", address(spy), 6000);
        c.defaultMix[1] = SpareConfig.MixLeg("NVDA", address(nvda), 4000);
    }

    function _want(string memory symbol, address token, address feed, uint16 band, bool active) internal {
        _cfgAssets.push(
            SpareConfig.Asset(symbol, token, feed, HEARTBEAT, band, active, _key(token), bytes32(0), address(0), 0)
        );
    }

    function _deployment() internal view returns (SpareBase.Deployment memory d) {
        d.deployer = owner;
        d.startBlock = B0;
        d.registry = registry;
        d.rules = rules;
        d.elections = elections;
        d.screening = screening;
        d.router = router;
        d.park = park;
        d.vault = vault;
        d.exec = exec;
        d.usdgAdapter = usdgAdapter;
    }

    function _seven() internal view returns (SpareAuth[7] memory) {
        return [
            SpareAuth(address(registry)),
            SpareAuth(address(elections)),
            SpareAuth(address(screening)),
            SpareAuth(address(router)),
            SpareAuth(address(park)),
            SpareAuth(address(vault)),
            SpareAuth(address(exec))
        ];
    }

    /// @dev HandOver's step 3: the owner EOA nominates `to` on all 7.
    function _nominate(address to) internal {
        SpareAuth[7] memory c = _seven();
        vm.startPrank(owner);
        for (uint256 i; i < 7; ++i) {
            c[i].transferOwnership(to);
        }
        vm.stopPrank();
    }

    /// @dev The owner Safe schedules a batch, waits the delay, executes it.
    function _throughTimelock(address[] memory targets, bytes[] memory payloads, bytes32 salt) internal {
        uint256[] memory values = new uint256[](targets.length);
        vm.prank(safe);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
    }

    function _registryOwnedByTimelock() internal {
        vm.prank(owner);
        registry.transferOwnership(address(tl));
        address[] memory t = new address[](1);
        t[0] = address(registry);
        bytes[] memory p = new bytes[](1);
        p[0] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        _throughTimelock(t, p, keccak256("accept AssetRegistry"));
        assertEq(registry.owner(), address(tl));
    }

    /// @dev The registry's owner becomes forge's DEFAULT_SENDER, the scripts'
    ///      broadcaster, so AddAssets runs its EOA path to the end.
    function _registryOwnedBySender() internal {
        vm.prank(owner);
        registry.transferOwnership(DEFAULT_SENDER);
        vm.prank(DEFAULT_SENDER);
        registry.acceptOwnership();
    }

    function _delegation(address to) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ef0100", to);
    }
}
