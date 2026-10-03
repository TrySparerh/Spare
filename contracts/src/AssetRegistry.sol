// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SpareAuth} from "./SpareAuth.sol";
import {IAggregatorV3} from "./interfaces/IExternal.sol";

/// @title AssetRegistry
/// @notice The eligible universe: which tokenized assets SPARE may buy, how each
///         is priced, and the ONE pool each may be bought through.
/// @dev Fail-closed (spec law 2): an asset that is not registered, or registered
///      but inactive, can never be elected or bought.
///
///      Pools are pinned by exact PoolKey, hook included. ~1000 v4 pools touch
///      these tokens on RHC and most are junk (85–95% fee tiers); the best fills
///      for several assets run through HOOKED pools, and a hook is arbitrary code.
///      Discovering pools at runtime would let anyone steer SPARE's order flow
///      into a pool they control, so the allowlist is the venue safety boundary.
contract AssetRegistry is SpareAuth {
    struct Asset {
        address token;
        address feed;
        uint8 feedDecimals;
        uint32 heartbeat; // seconds; staleness is judged against this, not minutes
        uint16 bandBps; // max fill deviation from oracle, e.g. 150 = 1.5%
        bool active;
        PoolKey poolKey; // USDG/token v4 pool
    }

    /// @notice USDG — the settlement currency every pool must pair against.
    address public immutable usdg;

    mapping(address token => Asset) internal _assets;
    address[] internal _tokens;

    uint16 public constant MAX_BAND_BPS = 1000; // 10% — anything wider is not a sanity check

    event AssetSet(address indexed token, address feed, uint32 heartbeat, uint16 bandBps, bytes32 poolId);
    event AssetActive(address indexed token, bool active);

    error UnknownAsset(address token);
    error PoolMismatch();
    error BadBand(uint16 bandBps);
    error BadHeartbeat();

    constructor(address owner_, address usdg_) SpareAuth(owner_) {
        if (usdg_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
    }

    /// @notice Register or update an asset. Newly registered assets start INACTIVE:
    ///         activation is a separate, deliberate step.
    function setAsset(address token, address feed, uint32 heartbeat, uint16 bandBps, PoolKey calldata key)
        external
        onlyOwner
    {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        if (heartbeat == 0) revert BadHeartbeat();
        if (bandBps == 0 || bandBps > MAX_BAND_BPS) revert BadBand(bandBps);
        _checkPool(token, key);

        Asset storage a = _assets[token];
        bool isNew = a.token == address(0);
        a.token = token;
        a.feed = feed;
        a.feedDecimals = IAggregatorV3(feed).decimals();
        a.heartbeat = heartbeat;
        a.bandBps = bandBps;
        a.poolKey = key;
        if (isNew) _tokens.push(token);
        emit AssetSet(token, feed, heartbeat, bandBps, keccak256(abi.encode(key)));
    }

    function setActive(address token, bool active) external onlyOwner {
        if (_assets[token].token == address(0)) revert UnknownAsset(token);
        _assets[token].active = active;
        emit AssetActive(token, active);
    }

    function isEligible(address token) external view returns (bool) {
        return _assets[token].active;
    }

    function isRegistered(address token) external view returns (bool) {
        return _assets[token].token != address(0);
    }

    function get(address token) external view returns (Asset memory a) {
        a = _assets[token];
        if (a.token == address(0)) revert UnknownAsset(token);
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @dev The pool must be exactly USDG <-> token, in v4's sorted order.
    function _checkPool(address token, PoolKey calldata key) internal view {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool ok = (c0 == usdg && c1 == token) || (c0 == token && c1 == usdg);
        if (!ok || c0 >= c1) revert PoolMismatch();
    }
}
