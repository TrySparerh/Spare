// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RoundUp
/// @notice The round-up rule, in USDG base units (6 decimals).
/// @dev Must stay byte-for-byte equivalent to `roundUpDelta` in the frontend's
///      `src/lib/spare.ts` and the engine's observer: all three compute the same
///      number from the same payment, which is what makes a keeper's accrual
///      independently checkable.
///
///      A payment already on the boundary yields ZERO. Rounding $5.00 up to $5.00
///      is nothing, and inventing a full increment there would take money the
///      user never agreed to give.
library RoundUp {
    uint256 internal constant ONE_DOLLAR = 1e6; // USDG has 6 decimals

    error BadRoundTo(uint8 roundTo);
    error BadMultiplier(uint8 multiplier);

    /// @param amount     payment in USDG base units
    /// @param roundTo    boundary in whole dollars: 1, 5 or 10
    /// @param multiplier 1..5 ("turbo round-ups")
    /// @return delta     spare change to accrue, in USDG base units
    function delta(uint256 amount, uint8 roundTo, uint8 multiplier) internal pure returns (uint256) {
        if (roundTo != 1 && roundTo != 5 && roundTo != 10) revert BadRoundTo(roundTo);
        if (multiplier == 0 || multiplier > 5) revert BadMultiplier(multiplier);
        if (amount == 0) return 0;
        uint256 step = uint256(roundTo) * ONE_DOLLAR;
        uint256 rem = amount % step;
        if (rem == 0) return 0;
        // Integer base units throughout — no floating tail to leak through the
        // multiplier, so no final rounding step is needed on-chain.
        return (step - rem) * multiplier;
    }
}
