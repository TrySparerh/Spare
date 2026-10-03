// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title SpareAuth
/// @notice Shared access control for SPARE contracts.
/// @dev Three separate powers, deliberately not collapsed into one key:
///      - owner  (should be a multisig at deploy) configures and curates
///      - keeper (a hot key the engine runs) performs routine operations
///      - pauser can halt NEW activity fast, without owner latency
///      Pausing never gates a user's exit — contracts that hold value expose an
///      exit path that ignores `paused` (spec law 5: "exit never gated").
abstract contract SpareAuth is Ownable2Step {
    mapping(address => bool) public isKeeper;
    address public pauser;
    bool public paused;

    event KeeperSet(address indexed keeper, bool enabled);
    event PauserSet(address indexed pauser);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error NotKeeper();
    error NotPauser();
    error IsPaused();
    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) {}

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    function setKeeper(address keeper, bool enabled) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = enabled;
        emit KeeperSet(keeper, enabled);
    }

    function setPauser(address pauser_) external onlyOwner {
        pauser = pauser_;
        emit PauserSet(pauser_);
    }

    /// @notice Pauser or owner can stop new activity immediately.
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauser();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Only the owner can resume — unpausing is the riskier direction.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }
}
