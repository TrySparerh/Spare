// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ArbSys stand-in whose L2 block number can be set independently of the
///         EVM `block.number`. Etched at 0x64, it proves a contract reads the L2
///         clock (ArbSys) and not Nitro's L1-estimate `block.number`.
///         A stored value of 0 means "mirror block.number".
contract MockArbSysSettable {
    uint256 public l2Block;

    function set(uint256 n) external {
        l2Block = n;
    }

    function arbBlockNumber() external view returns (uint256) {
        return l2Block == 0 ? block.number : l2Block;
    }
}
