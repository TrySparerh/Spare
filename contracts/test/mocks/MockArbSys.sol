// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Stands in for the Nitro ArbSys precompile on an anvil fork, where the
///         real precompile is not native. Returns the fork's own block number, so
///         tests exercise L2Clock's PRODUCTION branch rather than its fallback.
contract MockArbSys {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }
}
