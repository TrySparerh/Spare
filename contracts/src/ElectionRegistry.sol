// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SpareAuth} from "./SpareAuth.sol";
import {AssetRegistry} from "./AssetRegistry.sol";

/// @title ElectionRegistry
/// @notice Each account's target mix: which tokenized assets its spare change buys,
///         in what proportions. "Your mix, not a house ETF."
/// @dev Fail-closed (spec law 2): every leg must be an ACTIVE registry asset, the
///      bps must sum to exactly 10000, at most 6 legs, no duplicates. An invalid
///      mix reverts whole — there is no partial acceptance.
///
///      An asset that is deactivated AFTER being elected is not silently dropped
///      here; the executor safe-settles that leg to USDG with a notice at sweep
///      time (acceptance 6), so the user sees what happened.
contract ElectionRegistry is SpareAuth {
    struct Leg {
        address asset;
        uint16 bps;
    }

    uint256 public constant MAX_LEGS = 6;
    uint16 public constant TOTAL_BPS = 10_000;

    AssetRegistry public immutable registry;

    mapping(address account => Leg[]) internal _mix;
    /// @notice Used when an account has not elected a mix.
    Leg[] internal _defaultMix;

    event MixSet(address indexed account, Leg[] legs);
    event DefaultMixSet(Leg[] legs);
    event MixCleared(address indexed account);

    error BadLegCount(uint256 n);
    error BadTotal(uint256 total);
    error ZeroLeg(address asset);
    error DuplicateAsset(address asset);
    error IneligibleAsset(address asset);

    constructor(address owner_, AssetRegistry registry_) SpareAuth(owner_) {
        registry = registry_;
    }

    function setMix(Leg[] calldata legs) external {
        _validate(legs);
        delete _mix[msg.sender];
        for (uint256 i; i < legs.length; ++i) _mix[msg.sender].push(legs[i]);
        emit MixSet(msg.sender, legs);
    }

    /// @notice Drop back to the default mix.
    function clearMix() external {
        delete _mix[msg.sender];
        emit MixCleared(msg.sender);
    }

    function setDefaultMix(Leg[] calldata legs) external onlyOwner {
        _validate(legs);
        delete _defaultMix;
        for (uint256 i; i < legs.length; ++i) _defaultMix.push(legs[i]);
        emit DefaultMixSet(legs);
    }

    /// @notice The mix a sweep should use for `account`.
    function mixOf(address account) external view returns (Leg[] memory) {
        Leg[] storage own = _mix[account];
        return own.length > 0 ? own : _defaultMix;
    }

    function hasOwnMix(address account) external view returns (bool) {
        return _mix[account].length > 0;
    }

    function defaultMix() external view returns (Leg[] memory) {
        return _defaultMix;
    }

    function _validate(Leg[] calldata legs) internal view {
        uint256 n = legs.length;
        if (n == 0 || n > MAX_LEGS) revert BadLegCount(n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            address a = legs[i].asset;
            if (legs[i].bps == 0) revert ZeroLeg(a);
            if (!registry.isEligible(a)) revert IneligibleAsset(a);
            for (uint256 j; j < i; ++j) {
                if (legs[j].asset == a) revert DuplicateAsset(a);
            }
            total += legs[i].bps;
        }
        if (total != TOTAL_BPS) revert BadTotal(total);
    }
}
