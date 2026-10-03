// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice StockRouter stand-in for SweepExecutor outcome tests. It exposes the
///         exact surface SweepExecutor calls (usdg, registry, oracleStatus,
///         oracleTokensFor, buy) and lets a test script each asset's fill:
///           - `reverts[token]`  -> buy reverts (a failed swap: the executor defers)
///           - `fillBps[token]`  -> fill quality vs the oracle (0 means 10000)
///           - `fixedOut[token]` -> exact tokens out (to force pro-rata dust)
/// @dev oracleStatus runs the REAL OracleGuard over the registry's feed data, so
///      deferral is driven by MockFeed / MockStockToken state exactly as in
///      production. buy() enforces `minOut` like the real router, pulls USDG from
///      the caller, and mints the stock token to `recipient`.
contract MockRouter {
    using SafeERC20 for IERC20;

    AssetRegistry public immutable registry;
    address public immutable usdg;
    address public sequencerFeed;

    mapping(address token => bool) public reverts;
    mapping(address token => uint256) public fillBps;
    mapping(address token => uint256) public fixedOut;
    /// @notice Successful buys per token (netting => one per asset per sweep).
    mapping(address token => uint256) public buys;
    mapping(address token => uint256) public lastUsdgIn;
    mapping(address token => uint256) public lastMinOut;

    error Breach(address token);
    error AssetInactive(address token);
    error OracleNotOk(OracleGuard.Status status);
    error BelowMinOut(uint256 out, uint256 minOut);

    constructor(AssetRegistry registry_) {
        registry = registry_;
        usdg = registry_.usdg();
    }

    function setReverts(address token, bool r) external {
        reverts[token] = r;
    }

    function setFillBps(address token, uint256 bps) external {
        fillBps[token] = bps;
    }

    function setFixedOut(address token, uint256 out) external {
        fixedOut[token] = out;
    }

    function setSequencerFeed(address feed) external {
        sequencerFeed = feed;
    }

    function oracleStatus(address token) public view returns (OracleGuard.Status status, uint256 price1e18) {
        AssetRegistry.Asset memory a = registry.get(token);
        return OracleGuard.check(a.token, a.feed, a.feedDecimals, a.heartbeat, sequencerFeed);
    }

    function oracleTokensFor(uint256 usdgIn, uint256 price1e18) public pure returns (uint256) {
        return (usdgIn * 1e12 * 1e18) / price1e18;
    }

    function oracleUsdgFor(uint256 tokensIn, uint256 price1e18) public pure returns (uint256) {
        return (tokensIn * price1e18) / 1e18 / 1e12;
    }

    function buy(address token, uint256 usdgIn, uint256 minOut, address recipient) external returns (uint256 out) {
        if (reverts[token]) revert Breach(token);
        if (!registry.isEligible(token)) revert AssetInactive(token);
        (OracleGuard.Status s, uint256 price) = oracleStatus(token);
        if (s != OracleGuard.Status.OK) revert OracleNotOk(s);

        IERC20(usdg).safeTransferFrom(msg.sender, address(this), usdgIn);
        uint256 f = fillBps[token] == 0 ? 10_000 : fillBps[token];
        out = fixedOut[token] != 0 ? fixedOut[token] : (oracleTokensFor(usdgIn, price) * f) / 10_000;
        if (out < minOut) revert BelowMinOut(out, minOut);

        buys[token]++;
        lastUsdgIn[token] = usdgIn;
        lastMinOut[token] = minOut;
        MockERC20(token).mint(recipient, out);
    }
}
