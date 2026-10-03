// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mintable ERC20 with configurable decimals (USDG is 6, stock tokens 18)
///         and an optional transfer blocklist, so tests can model a token that
///         refuses to deliver to a particular recipient.
contract MockERC20 is ERC20 {
    uint8 internal immutable _dec;
    mapping(address => bool) public blocked;

    error Blocked(address account);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && blocked[from]) revert Blocked(from);
        if (to != address(0) && blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
