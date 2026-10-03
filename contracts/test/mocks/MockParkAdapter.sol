// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IParkAdapter} from "../../src/interfaces/IParkAdapter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Configurable IParkAdapter for CashPark tests.
/// @dev Units are a real ERC20 share token held by the adapter, so in-kind exits
///      move something observable. units = usdg * num / den; value = units * den / num.
///      Toggles: `fresh` (NAV trustworthy), `redeemReverts` (market path down, e.g.
///      SGOV outside hours), `exitInKindReverts` (the underlying itself cannot move,
///      e.g. a paused or blocklisting issuer token).
contract MockParkAdapter is IParkAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    MockERC20 public immutable share;
    address public immutable park;

    uint256 public num = 1;
    uint256 public den = 1;
    bool public fresh = true;
    bool public redeemReverts;
    bool public exitInKindReverts;
    uint256 public depositCalls;

    error NotPark();
    error RedeemUnavailable();
    error InKindUnavailable();

    constructor(address usdg_, address park_) {
        usdg = IERC20(usdg_);
        park = park_;
        share = new MockERC20("Park Share", "pSHARE", 18);
    }

    modifier onlyPark() {
        if (msg.sender != park) revert NotPark();
        _;
    }

    function setRate(uint256 num_, uint256 den_) external {
        num = num_;
        den = den_;
    }

    function setFresh(bool f) external {
        fresh = f;
    }

    function setRedeemReverts(bool r) external {
        redeemReverts = r;
    }

    function setExitInKindReverts(bool r) external {
        exitInKindReverts = r;
    }

    function underlying() external view returns (address) {
        return address(share);
    }

    function deposit(uint256 amount) external onlyPark returns (uint256 units) {
        depositCalls++;
        units = (amount * num) / den;
        share.mint(address(this), units);
    }

    function redeem(uint256 units, address to) external onlyPark returns (uint256 usdgOut) {
        if (redeemReverts) revert RedeemUnavailable();
        share.burn(address(this), units);
        usdgOut = (units * den) / num;
        usdg.safeTransfer(to, usdgOut);
    }

    function exitInKind(uint256 units, address to) external onlyPark {
        if (exitInKindReverts) revert InKindUnavailable();
        IERC20(address(share)).safeTransfer(to, units);
    }

    function valueOf(uint256 units) external view returns (uint256) {
        return (units * den) / num;
    }

    function isFresh() external view returns (bool) {
        return fresh;
    }
}
