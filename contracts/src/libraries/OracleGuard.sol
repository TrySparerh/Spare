// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAggregatorV3, IStockToken} from "../interfaces/IExternal.sol";

/// @title OracleGuard
/// @notice Decides whether an asset's price can be trusted right now.
/// @dev The outcome is a STATUS, not a revert. SweepExecutor defers EVERY
///      non-OK status (build spec §3.4, review fix): the value stays parked and
///      is retried next epoch — the weekend case (stock feeds are 24/5), a
///      paused token, a down sequencer, and a bad answer alike. A caller must
///      never turn an oracle condition into a user's stock buy being delivered
///      as USDG. `isDeferrable` is kept for off-chain / future callers that
///      want to tell "not now" from "bad data".
library OracleGuard {
    enum Status {
        OK,
        STALE,
        PAUSED,
        SEQUENCER_DOWN,
        BAD_ANSWER
    }

    /// @notice Grace added on top of a feed's heartbeat before calling it stale.
    uint256 internal constant STALENESS_GRACE = 1 hours;
    /// @notice After the sequencer restarts, prices are not trusted for this long.
    uint256 internal constant SEQUENCER_GRACE = 1 hours;

    /// @param token            asset token (queried for paused / oraclePaused)
    /// @param feed             Chainlink feed proxy
    /// @param feedDecimals     cached feed decimals
    /// @param heartbeat        feed heartbeat in seconds
    /// @param sequencerFeed    L2 uptime feed, or address(0) to skip. None is
    ///                         published for RHC yet; the check is wired so it
    ///                         can be switched on without a redeploy.
    /// @return status          whether the price may be used
    /// @return price1e18       USD per token, scaled to 1e18 (0 unless OK)
    function check(
        address token,
        address feed,
        uint8 feedDecimals,
        uint32 heartbeat,
        address sequencerFeed
    ) internal view returns (Status status, uint256 price1e18) {
        if (sequencerFeed != address(0)) {
            try IAggregatorV3(sequencerFeed).latestRoundData() returns (
                uint80, int256 answer, uint256 startedAt, uint256, uint80
            ) {
                // 0 = up, 1 = down
                if (answer != 0) return (Status.SEQUENCER_DOWN, 0);
                // startedAt 0 = round not initialised; in the future = bad data.
                // Neither may be read as "up for a long time".
                if (startedAt == 0 || startedAt > block.timestamp) return (Status.SEQUENCER_DOWN, 0);
                if (block.timestamp - startedAt <= SEQUENCER_GRACE) return (Status.SEQUENCER_DOWN, 0);
            } catch {
                return (Status.SEQUENCER_DOWN, 0);
            }
        }

        // Token-level pause. Both flags are best-effort reads: an asset that does
        // not implement them is treated as unpaused, and the staleness check below
        // remains the primary guard (the chain docs call oraclePaused advisory).
        if (_readBool(token, IStockToken.paused.selector)) return (Status.PAUSED, 0);
        if (_readBool(token, IStockToken.oraclePaused.selector)) return (Status.PAUSED, 0);

        try IAggregatorV3(feed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0 || updatedAt == 0) return (Status.BAD_ANSWER, 0);
            if (updatedAt > block.timestamp) return (Status.BAD_ANSWER, 0);
            if (block.timestamp - updatedAt > uint256(heartbeat) + STALENESS_GRACE) return (Status.STALE, 0);
            price1e18 = _to1e18(uint256(answer), feedDecimals);
            return (Status.OK, price1e18);
        } catch {
            return (Status.BAD_ANSWER, 0);
        }
    }

    /// @notice True for the "not now" family — the caller should defer, not settle.
    function isDeferrable(Status s) internal pure returns (bool) {
        return s == Status.STALE || s == Status.PAUSED || s == Status.SEQUENCER_DOWN;
    }

    function _to1e18(uint256 v, uint8 dec) private pure returns (uint256) {
        if (dec == 18) return v;
        if (dec < 18) return v * 10 ** (18 - dec);
        return v / 10 ** (dec - 18);
    }

    function _readBool(address target, bytes4 selector) private view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }
}
