// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice The subset of Permit2's AllowanceTransfer that SPARE uses, with the same
///         semantics and error selectors as the canonical contract
///         (lib/v4-periphery/lib/permit2/src/AllowanceTransfer.sol, which is pinned
///         to solc 0.8.17 and cannot be compiled under this project's 0.8.26):
///           - approve(): expiration 0 means "this block's timestamp"
///           - transferFrom(): reverts AllowanceExpired past expiration and
///             InsufficientAllowance over the amount, decrements unless the
///             allowance is type(uint160).max, then pulls via ERC20 transferFrom
///             (so the owner must also have ERC20-approved this contract).
contract MockPermit2 {
    using SafeERC20 for IERC20;

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance))) public allowance;

    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);

    event Approval(
        address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration
    );

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        PackedAllowance storage a = allowance[msg.sender][token][spender];
        a.amount = amount;
        a.expiration = expiration == 0 ? uint48(block.timestamp) : expiration;
        emit Approval(msg.sender, token, spender, amount, expiration);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage a = allowance[from][token][msg.sender];
        if (block.timestamp > a.expiration) revert AllowanceExpired(a.expiration);
        uint256 maxAmount = a.amount;
        if (maxAmount != type(uint160).max) {
            if (amount > maxAmount) revert InsufficientAllowance(maxAmount);
            unchecked {
                a.amount = uint160(maxAmount) - amount;
            }
        }
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}
