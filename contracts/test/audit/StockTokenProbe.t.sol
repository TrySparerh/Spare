// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

interface IReg {
    function blockAccounts(address[] calldata) external;
    function isBlocked(address) external view returns (bool);
    function pause() external;
    function paused() external view returns (bool);
    function hasRole(bytes32, address) external view returns (bool);
}

interface ITok {
    function pause() external;
    function paused() external view returns (bool);
    function tokenPaused() external view returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @notice AUDIT probe: learn which roles gate the stock-token pause and blocklist,
///         so the audit tests can drive the REAL mechanisms instead of mocks.
contract StockTokenProbe is Test {
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant REG = 0xe10b6f6B275de231345c20D14Ab812db62151b00;

    function setUp() public {
        uint256 blk = vm.envOr("AUDIT_FORK_BLOCK", uint256(0));
        if (blk == 0) {
            vm.skip(true); // opt-in: needs a recent block (public RPC is not archive)
            return;
        }
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), blk);
    }

    function test_probeRoles() public {
        address rando = makeAddr("rando");
        address[] memory a = new address[](1);
        a[0] = rando;

        vm.prank(rando);
        (bool ok, bytes memory ret) = REG.call(abi.encodeCall(IReg.blockAccounts, (a)));
        emit log_named_bytes("registry.blockAccounts revert", ret);
        assertFalse(ok);

        vm.prank(rando);
        (ok, ret) = REG.call(abi.encodeCall(IReg.pause, ()));
        emit log_named_bytes("registry.pause revert", ret);

        vm.prank(rando);
        (ok, ret) = SGOV.call(abi.encodeCall(ITok.pause, ()));
        emit log_named_bytes("SGOV.pause revert", ret);

        emit log_named_address("rando", rando);
    }
}
