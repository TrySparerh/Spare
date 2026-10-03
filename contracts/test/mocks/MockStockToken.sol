// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockERC20} from "./MockERC20.sol";

/// @notice Stands in for a Robinhood Chain stock token (the ERC-8056 surface SPARE
///         reads): 18 decimals, `paused()` / `oraclePaused()` toggles, a raw
///         `uiMultiplier`, and the compliance blocklist inherited from MockERC20.
/// @dev While `paused` (and `pauseBlocksTransfers`), every transfer reverts. That is
///      the realistic behaviour of a paused issuer token, and the case in which an
///      in-kind exit of that token cannot move.
contract MockStockToken is MockERC20 {
    bool public paused;
    bool public oraclePaused;
    bool public pauseBlocksTransfers = true;
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;

    error TokenPaused();

    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 18) {}

    function setPaused(bool p) external {
        paused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    function setPauseBlocksTransfers(bool b) external {
        pauseBlocksTransfers = b;
    }

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
        newUIMultiplier = m;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused && pauseBlocksTransfers) revert TokenPaused();
        super._update(from, to, value);
    }
}
