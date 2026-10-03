// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IParkAdapter
/// @notice Where idle spare change waits between accrual and sweep.
/// @dev Only CashPark calls an adapter. "Units" are whatever the adapter holds per
///      parked dollar (USDG itself, SGOV tokens, vault shares), so each account's
///      yield is simply the appreciation of its own units — no share-price math.
interface IParkAdapter {
    /// @notice The asset actually held (for in-kind exits).
    function underlying() external view returns (address);

    /// @notice Park `usdg` (already transferred to the adapter). Returns units minted.
    function deposit(uint256 usdg) external returns (uint256 units);

    /// @notice Redeem `units` to USDG, sent to `to`. May revert if the market path
    ///         is unavailable — callers must be able to fall back to `exitInKind`.
    function redeem(uint256 units, address to) external returns (uint256 usdgOut);

    /// @notice Hand over the underlying for `units` directly. MUST NOT depend on
    ///         any oracle or market, so an exit can never be gated.
    function exitInKind(uint256 units, address to) external;

    /// @notice USDG value of `units` at the current NAV.
    function valueOf(uint256 units) external view returns (uint256);

    /// @notice Whether NAV is trustworthy right now. While false, new accruals are
    ///         held un-parked (spec law 4: "stale NAV -> hold accrual").
    function isFresh() external view returns (bool);
}
