// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SpareAuth} from "./SpareAuth.sol";

/// @title FeeVault
/// @notice Collects SPARE's conversion fee (bps on USDG actually converted).
/// @dev "Boosts, not fees": there is no subscription. The only charge is a small bps
///      on conversions, and it is taken only when a leg actually converts — never on
///      a deferred or safe-settled leg. S3 routes this to buyback and stakers.
contract FeeVault is SpareAuth {
    using SafeERC20 for IERC20;

    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    constructor(address owner_) SpareAuth(owner_) {}

    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }
}
