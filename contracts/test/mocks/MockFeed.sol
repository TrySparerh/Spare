// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Chainlink AggregatorV3 stand-in with every field settable. Also usable
///         as an L2 sequencer-uptime feed (answer 0 = up, 1 = down; `startedAt` is
///         when the current status began).
contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    bool public reverts;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    /// @notice New answer, stamped now.
    function setAnswer(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
        roundId++;
    }

    function setRound(int256 a, uint256 updatedAt_) external {
        answer = a;
        updatedAt = updatedAt_;
        roundId++;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setStartedAt(uint256 t) external {
        startedAt = t;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "MockFeed: down");
        return (roundId, answer, startedAt, updatedAt, roundId);
    }

    function latestAnswer() external view returns (int256) {
        require(!reverts, "MockFeed: down");
        return answer;
    }
}
