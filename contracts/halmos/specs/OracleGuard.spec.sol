// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleGuard} from "spare/libraries/OracleGuard.sol";

/// @dev A Chainlink-shaped feed whose every field (and whether it reverts) is set
///      from the spec's symbolic inputs. Also stands in for the L2 sequencer
///      uptime feed (answer 0 = up, startedAt = when that status began).
contract SymFeed {
    int256 internal _answer;
    uint256 internal _startedAt;
    uint256 internal _updatedAt;
    bool internal _reverts;

    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_, bool reverts_) external {
        _answer = answer_;
        _startedAt = startedAt_;
        _updatedAt = updatedAt_;
        _reverts = reverts_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!_reverts);
        return (1, _answer, _startedAt, _updatedAt, 1);
    }
}

/// @dev The ERC-8056 pause surface OracleGuard reads.
contract SymToken {
    bool public paused;
    bool public oraclePaused;

    function set(bool paused_, bool oraclePaused_) external {
        paused = paused_;
        oraclePaused = oraclePaused_;
    }
}

/// @notice Symbolic specs for OracleGuard.check (SPARE-BUILD.md §3.4): for every
///         feed answer, timestamp, heartbeat, pause flag and sequencer state —
///         a stale price, a future `updatedAt`, a non-positive answer, a paused
///         token, and a down / unreadable / just-restarted / future-`startedAt`
///         sequencer are NEVER OK, OK is returned only with every guard passed
///         and the price exactly normalised to 1e18, and check() returns a status,
///         never a revert, for every answer up to type(uint256).max / 1e10.
/// @dev Feeds are 8 dp (every RHC feed); `test/unit/OracleGuard.t.sol` covers the
///      other decimal paths. Run from contracts/:
///      halmos --root halmos --contract OracleGuardSpec
contract OracleGuardSpec is Test {
    uint8 internal constant DEC = 8;
    uint256 internal constant GRACE = 1 hours; // STALENESS_GRACE and SEQUENCER_GRACE

    SymFeed internal feed;
    SymFeed internal seq;
    SymToken internal token;

    function setUp() public {
        feed = new SymFeed();
        seq = new SymFeed();
        token = new SymToken();
    }

    /// @dev One fully symbolic world: price feed, sequencer feed, token flags, clock.
    struct World {
        int256 answer;
        uint256 updatedAt;
        bool feedReverts;
        int256 seqAnswer;
        uint256 seqStartedAt;
        bool seqReverts;
        bool paused;
        bool oraclePaused;
        uint32 heartbeat;
        uint256 now_;
    }

    function _set(World memory w) internal {
        // Answers a real 8-dp feed can carry; scaling them to 1e18 cannot overflow.
        vm.assume(w.answer < int256(uint256(type(uint128).max)));
        _setAnyAnswer(w);
    }

    function _setAnyAnswer(World memory w) internal {
        vm.assume(w.now_ < type(uint64).max);
        vm.warp(w.now_);
        feed.set(w.answer, 0, w.updatedAt, w.feedReverts);
        seq.set(w.seqAnswer, w.seqStartedAt, 0, w.seqReverts);
        token.set(w.paused, w.oraclePaused);
    }

    function _check(World memory w, bool withSequencer) internal returns (OracleGuard.Status s, uint256 p) {
        _set(w);
        (s, p) = OracleGuard.check(address(token), address(feed), DEC, w.heartbeat, withSequencer ? address(seq) : address(0));
    }

    function _sequencerUp(World memory w) internal pure returns (bool) {
        return !w.seqReverts && w.seqAnswer == 0 && w.seqStartedAt != 0 && w.seqStartedAt <= w.now_
            && w.now_ - w.seqStartedAt > GRACE;
    }

    function _priceUsable(World memory w) internal pure returns (bool) {
        return !w.feedReverts && w.answer > 0 && w.updatedAt != 0 && w.updatedAt <= w.now_
            && w.now_ - w.updatedAt <= uint256(w.heartbeat) + GRACE;
    }

    /// @dev Every guard check() applies passes: all that is left is to scale and return OK.
    function _guardsPass(World memory w, bool withSequencer) internal pure returns (bool) {
        return (!withSequencer || _sequencerUp(w)) && !w.paused && !w.oraclePaused && _priceUsable(w);
    }

    // ── never OK ─────────────────────────────────────────────────────────

    function check_staleIsNeverOk(World memory w, bool withSequencer) public {
        vm.assume(w.updatedAt <= w.now_ && w.now_ - w.updatedAt > uint256(w.heartbeat) + GRACE);
        (OracleGuard.Status s, uint256 p) = _check(w, withSequencer);
        assert(s != OracleGuard.Status.OK);
        assert(p == 0);
    }

    function check_futureUpdatedAtIsNeverOk(World memory w, bool withSequencer) public {
        vm.assume(w.updatedAt > w.now_);
        (OracleGuard.Status s, uint256 p) = _check(w, withSequencer);
        assert(s != OracleGuard.Status.OK);
        assert(p == 0);
    }

    function check_nonPositiveAnswerIsNeverOk(World memory w, bool withSequencer) public {
        vm.assume(w.answer <= 0);
        (OracleGuard.Status s, uint256 p) = _check(w, withSequencer);
        assert(s != OracleGuard.Status.OK);
        assert(p == 0);
    }

    function check_unreadableFeedIsNeverOk(World memory w, bool withSequencer) public {
        vm.assume(w.feedReverts);
        (OracleGuard.Status s, uint256 p) = _check(w, withSequencer);
        assert(s != OracleGuard.Status.OK);
        assert(p == 0);
    }

    function check_pausedTokenIsNeverOk(World memory w, bool withSequencer) public {
        vm.assume(w.paused || w.oraclePaused);
        (OracleGuard.Status s, uint256 p) = _check(w, withSequencer);
        assert(s != OracleGuard.Status.OK);
        assert(p == 0);
    }

    /// Down, unreadable, uninitialised (startedAt 0), FUTURE startedAt, or still
    /// inside the restart grace: always SEQUENCER_DOWN, whatever the price feed says.
    function check_sequencerNotSafelyUpIsAlwaysDown(World memory w) public {
        vm.assume(!_sequencerUp(w));
        (OracleGuard.Status s, uint256 p) = _check(w, true);
        assert(s == OracleGuard.Status.SEQUENCER_DOWN);
        assert(p == 0);
    }

    function check_futureSequencerStartedAtIsNeverOk(World memory w) public {
        vm.assume(w.seqStartedAt > w.now_);
        (OracleGuard.Status s,) = _check(w, true);
        assert(s == OracleGuard.Status.SEQUENCER_DOWN);
    }

    // ── OK means every guard passed ──────────────────────────────────────

    /// The converse, so the list above is complete: OK iff the sequencer (when
    /// configured) is safely up, the token is unpaused, and the answer is
    /// positive, not from the future and within heartbeat + grace — and then
    /// the price is the answer scaled from 8 to 18 decimals.
    function check_okIffEveryGuardPasses(World memory w, bool withSequencer) public {
        (OracleGuard.Status s, uint256 p) = _check(w, withSequencer);
        bool expectOk = _guardsPass(w, withSequencer);
        assert((s == OracleGuard.Status.OK) == expectOk);
        if (expectOk) assert(p == uint256(w.answer) * 1e10);
        else assert(p == 0);
    }

    // ── a status, never a revert ─────────────────────────────────────────
    //
    // SweepExecutor reads oracleStatus outside its try/catch: a revert here would
    // revert a whole sweep instead of deferring one leg. Proved in two checks
    // because the one-query form ("check() never reverts" for answer < 2^128)
    // cannot be decided: the 8 -> 18 dp scaling is a checked `answer * 1e10`,
    // whose overflow test solc emits as `div(product, answer) == 1e10`, a 256-bit
    // division by a symbolic divisor. That query TIMEOUTs at 60 s, and its core
    // alone, `(c * x) / x == c` with x < 2^16, runs past 5 min in yices 2.6.4
    // (z3 past 10 min). Neither check below hands the solver a symbolic division.

    /// For EVERY answer (any int256) and every other input, the only revert
    /// check() can raise is Panic(0x11), and only once every guard has passed: the
    /// feed and sequencer reads, the pause reads and the staleness / restart
    /// arithmetic never revert, so the 8 -> 18 dp scaling is the only candidate.
    function check_neverRevertsExceptScalingOverflow(World memory w, bool withSequencer) public {
        _setAnyAnswer(w);
        try this.callCheck(w, withSequencer) {}
        catch (bytes memory reason) {
            assert(keccak256(reason) == keccak256(abi.encodeWithSignature("Panic(uint256)", 0x11)));
            assert(_guardsPass(w, withSequencer));
        }
    }

    /// ...and the scaling fits at the largest answer it can carry,
    /// type(uint256).max / 1e10 (~1.2e67; a Chainlink aggregator reports an int192,
    /// at most ~3.1e57), in every world. A checked `x * 1e10` that fits at that
    /// bound fits for every smaller x, so with the check above: check() returns a
    /// status, never a revert, for every answer up to the bound.
    function check_neverRevertsUpToTheScalingBound(World memory w, bool withSequencer) public {
        w.answer = int256(type(uint256).max / 1e10);
        _setAnyAnswer(w);
        try this.callCheck(w, withSequencer) returns (OracleGuard.Status s, uint256 p) {
            assert((s == OracleGuard.Status.OK) == _guardsPass(w, withSequencer));
            if (s == OracleGuard.Status.OK) assert(p == uint256(w.answer) * 1e10);
        } catch {
            assert(false);
        }
    }

    /// The bound is exact, so the exception in the first check is real: one unit
    /// above it, a world whose guards all pass reverts with Panic(0x11), and every
    /// other world still returns its non-OK status.
    function check_oneAboveTheScalingBoundRevertsOnlyWhenOk(World memory w, bool withSequencer) public {
        w.answer = int256(type(uint256).max / 1e10 + 1);
        _setAnyAnswer(w);
        try this.callCheck(w, withSequencer) returns (OracleGuard.Status s, uint256) {
            assert(!_guardsPass(w, withSequencer));
            assert(s != OracleGuard.Status.OK);
        } catch (bytes memory reason) {
            assert(_guardsPass(w, withSequencer));
            assert(keccak256(reason) == keccak256(abi.encodeWithSignature("Panic(uint256)", 0x11)));
        }
    }

    /// @dev External hop, so a revert inside OracleGuard.check can be caught.
    function callCheck(World memory w, bool withSequencer) external view returns (OracleGuard.Status, uint256) {
        address sequencer = withSequencer ? address(seq) : address(0);
        return OracleGuard.check(address(token), address(feed), DEC, w.heartbeat, sequencer);
    }
}
