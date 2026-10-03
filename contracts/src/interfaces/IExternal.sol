// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Chainlink AggregatorV3 — the interface every RHC feed implements.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Robinhood Chain stock token surface SPARE depends on.
/// @dev Beacon proxies implementing ERC-8056 (Scaled UI Amount). `balanceOf` and
///      `totalSupply` are raw and never rebase; corporate actions move
///      `uiMultiplier`. Chainlink feeds already quote the multiplier-adjusted
///      per-token price, so the multiplier is never applied to a feed price.
interface IStockToken {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    /// @dev Advisory — set while a corporate action is being processed.
    function oraclePaused() external view returns (bool);
    function paused() external view returns (bool);
}
