// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IParkAdapter} from "../interfaces/IParkAdapter.sol";

/// @title UsdgParkAdapter
/// @notice The fallback park: holds USDG as-is. No yield, always fresh, cannot fail.
/// @dev This is the LAUNCH DEFAULT. It is the spec's "USDG fallback", and it is the
///      only adapter with zero market or oracle dependency, which makes it the right
///      starting point before a yield adapter has run in production.
contract UsdgParkAdapter is IParkAdapter {
    using SafeERC20 for IERC20;

    address public immutable usdg;
    address public immutable park;

    error NotPark();

    constructor(address usdg_, address park_) {
        usdg = usdg_;
        park = park_;
    }

    modifier onlyPark() {
        if (msg.sender != park) revert NotPark();
        _;
    }

    function underlying() external view returns (address) {
        return usdg;
    }

    function deposit(uint256 amount) external onlyPark returns (uint256) {
        return amount; // 1 unit = 1 USDG base unit
    }

    function redeem(uint256 units, address to) external onlyPark returns (uint256) {
        IERC20(usdg).safeTransfer(to, units);
        return units;
    }

    function exitInKind(uint256 units, address to) external onlyPark {
        IERC20(usdg).safeTransfer(to, units);
    }

    function valueOf(uint256 units) external pure returns (uint256) {
        return units;
    }

    function isFresh() external pure returns (bool) {
        return true;
    }
}
