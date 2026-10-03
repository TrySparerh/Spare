// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract OracleGuardHarness {
    function check(address token, address feed, uint8 dec, uint32 hb, address seq)
        external
        view
        returns (OracleGuard.Status, uint256)
    {
        return OracleGuard.check(token, feed, dec, hb, seq);
    }

    function isDeferrable(OracleGuard.Status s) external pure returns (bool) {
        return OracleGuard.isDeferrable(s);
    }
}

/// @notice OracleGuard: every Status, the heartbeat-based staleness rule, decimal
///         normalisation, sequencer edge cases (startedAt 0 / in the future), and
///         the library's "not now" classification (SPARE-BUILD.md §3.4).
contract OracleGuardTest is Test {
    uint32 constant HB = 86_400;
    uint256 constant GRACE = 1 hours;

    OracleGuardHarness h;
    MockStockToken token;
    MockFeed feed;
    MockFeed seq;

    function setUp() public {
        vm.warp(1_790_000_000);
        h = new OracleGuardHarness();
        token = new MockStockToken("SPY", "SPY");
        feed = new MockFeed(8, 500e8);
        seq = new MockFeed(0, 0); // sequencer up
        seq.setStartedAt(block.timestamp - 2 days);
    }

    function _check() internal view returns (OracleGuard.Status s, uint256 p) {
        return h.check(address(token), address(feed), 8, HB, address(0));
    }

    function _checkSeq() internal view returns (OracleGuard.Status s, uint256 p) {
        return h.check(address(token), address(feed), 8, HB, address(seq));
    }

    function _eq(OracleGuard.Status a, OracleGuard.Status b) internal pure {
        assertEq(uint8(a), uint8(b));
    }

    // ── OK and normalisation ─────────────────────────────────────────────

    function test_ok_normalisesTo1e18() public view {
        (OracleGuard.Status s, uint256 p) = _check();
        _eq(s, OracleGuard.Status.OK);
        assertEq(p, 500e18);
    }

    function test_ok_decimalVariants() public {
        MockFeed f18 = new MockFeed(18, 500e18);
        MockFeed f6 = new MockFeed(6, 500e6);
        MockFeed f20 = new MockFeed(20, 500e20);
        (, uint256 p18) = h.check(address(token), address(f18), 18, HB, address(0));
        (, uint256 p6) = h.check(address(token), address(f6), 6, HB, address(0));
        (, uint256 p20) = h.check(address(token), address(f20), 20, HB, address(0));
        assertEq(p18, 500e18);
        assertEq(p6, 500e18);
        assertEq(p20, 500e18);
    }

    /// Feeds update on 0.5% deviation or the 24h heartbeat, so hours-old is normal.
    function test_ok_hoursOldIsNotStale() public {
        feed.setUpdatedAt(block.timestamp - 20 hours);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.OK);
    }

    // ── STALE ────────────────────────────────────────────────────────────

    function test_stale_boundary() public {
        feed.setUpdatedAt(block.timestamp - HB - GRACE);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.OK); // exactly heartbeat + grace is still fresh
        feed.setUpdatedAt(block.timestamp - HB - GRACE - 1);
        uint256 p;
        (s, p) = _check();
        _eq(s, OracleGuard.Status.STALE);
        assertEq(p, 0, "no price unless OK");
    }

    /// The weekend: 24/5 equity feeds go quiet; after a few days they are STALE.
    function test_stale_weekend() public {
        vm.warp(block.timestamp + 3 days);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.STALE);
    }

    function testFuzz_staleIffOlderThanHeartbeatPlusGrace(uint256 age) public {
        age = bound(age, 0, 30 days);
        feed.setUpdatedAt(block.timestamp - age);
        (OracleGuard.Status s,) = _check();
        _eq(s, age > HB + GRACE ? OracleGuard.Status.STALE : OracleGuard.Status.OK);
    }

    // ── PAUSED ───────────────────────────────────────────────────────────

    function test_paused_tokenPaused() public {
        token.setPaused(true);
        (OracleGuard.Status s, uint256 p) = _check();
        _eq(s, OracleGuard.Status.PAUSED);
        assertEq(p, 0);
    }

    function test_paused_oraclePaused() public {
        token.setOraclePaused(true);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.PAUSED);
    }

    /// A paused token is "not now" even if the feed also looks bad: defer wins.
    function test_paused_precedesFeedChecks() public {
        token.setOraclePaused(true);
        feed.setRound(0, block.timestamp);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.PAUSED);
    }

    /// Assets without the pause surface are treated as unpaused (best-effort reads).
    function test_paused_plainErc20AndEoaReadAsUnpaused() public {
        MockERC20 plain = new MockERC20("X", "X", 18);
        (OracleGuard.Status s,) = h.check(address(plain), address(feed), 8, HB, address(0));
        _eq(s, OracleGuard.Status.OK);
        (s,) = h.check(makeAddr("eoa-token"), address(feed), 8, HB, address(0));
        _eq(s, OracleGuard.Status.OK);
    }

    // ── SEQUENCER_DOWN ───────────────────────────────────────────────────

    function test_sequencer_upPasses() public view {
        (OracleGuard.Status s,) = _checkSeq();
        _eq(s, OracleGuard.Status.OK);
    }

    function test_sequencer_down() public {
        seq.setRound(1, block.timestamp);
        (OracleGuard.Status s,) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN);
    }

    function test_sequencer_gracePeriodAfterRestart() public {
        seq.setStartedAt(block.timestamp - 30 minutes);
        (OracleGuard.Status s,) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN);
        seq.setStartedAt(block.timestamp - GRACE);
        (s,) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN); // <= grace is still inside it
        seq.setStartedAt(block.timestamp - GRACE - 1);
        (s,) = _checkSeq();
        _eq(s, OracleGuard.Status.OK);
    }

    /// startedAt == 0 is Chainlink's "round not initialised"; it must not be read
    /// as "up for a very long time".
    function test_sequencer_startedAtZeroIsDown() public {
        seq.setStartedAt(0);
        (OracleGuard.Status s, uint256 p) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN);
        assertEq(p, 0);
    }

    /// startedAt in the future is bad data: SEQUENCER_DOWN, not an underflow revert
    /// escaping the try block (which would revert a whole sweep instead of deferring).
    function test_sequencer_startedAtInTheFutureIsDownNotRevert() public {
        seq.setStartedAt(block.timestamp + 1);
        (OracleGuard.Status s,) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN);
        seq.setStartedAt(type(uint256).max);
        (s,) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN);
    }

    function test_sequencer_feedRevertIsDown() public {
        seq.setReverts(true);
        (OracleGuard.Status s,) = _checkSeq();
        _eq(s, OracleGuard.Status.SEQUENCER_DOWN);
    }

    function test_sequencer_zeroAddressSkipsTheCheck() public {
        seq.setRound(1, block.timestamp);
        (OracleGuard.Status s,) = _check(); // sequencerFeed = address(0)
        _eq(s, OracleGuard.Status.OK);
    }

    // ── BAD_ANSWER ───────────────────────────────────────────────────────

    function test_bad_zeroAnswer() public {
        feed.setRound(0, block.timestamp);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.BAD_ANSWER);
    }

    function test_bad_negativeAnswer() public {
        feed.setRound(-1, block.timestamp);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.BAD_ANSWER);
    }

    function test_bad_zeroUpdatedAt() public {
        feed.setUpdatedAt(0);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.BAD_ANSWER);
    }

    function test_bad_updatedAtInTheFuture() public {
        feed.setUpdatedAt(block.timestamp + 1);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.BAD_ANSWER);
    }

    function test_bad_feedReverts() public {
        feed.setReverts(true);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.BAD_ANSWER);
    }

    // ── a status, never a revert ─────────────────────────────────────────

    /// Any feed, sequencer, pause and clock state yields a STATUS: SweepExecutor
    /// reads oracleStatus outside its try/catch, so a revert here would revert a
    /// whole sweep instead of deferring one leg. The fuzzed answer is capped at
    /// 2^128: only an answer above type(uint256).max / 1e10 overflows the 8 -> 18 dp
    /// scaling, which no real feed can report — see the next test.
    /// (halmos/specs/OracleGuard.spec.sol proves the same for every answer up to
    /// that bound, in two checks: the one-query form times out in the solver.)
    function testFuzz_neverRevertsForAnyFeedOrSequencerState(
        int256 answer,
        uint256 updatedAt,
        bool feedReverts,
        int256 seqAnswer,
        uint256 seqStartedAt,
        bool seqReverts,
        bool paused,
        bool oraclePaused,
        uint32 heartbeat,
        bool withSequencer
    ) public {
        answer = bound(answer, type(int256).min, int256(uint256(type(uint128).max)));
        feed.setRound(answer, updatedAt);
        feed.setReverts(feedReverts);
        seq.setRound(seqAnswer, block.timestamp);
        seq.setStartedAt(seqStartedAt);
        seq.setReverts(seqReverts);
        token.setPaused(paused);
        token.setOraclePaused(oraclePaused);

        try h.check(address(token), address(feed), 8, heartbeat, withSequencer ? address(seq) : address(0)) returns (
            OracleGuard.Status s, uint256 p
        ) {
            assertEq(p == 0, s != OracleGuard.Status.OK, "a price exactly when OK");
            if (s == OracleGuard.Status.OK) assertEq(p, uint256(answer) * 1e10);
        } catch {
            fail();
        }
    }

    /// The boundary of the property above, pinned: an 8-dp answer above
    /// type(uint256).max / 1e10 overflows the scaling inside the try block and
    /// reverts (Panic 0x11) rather than reading as BAD_ANSWER. Accepted: feeds are
    /// owner-registered Chainlink aggregators, whose answers are bounded far below.
    function test_overflowingAnswerRevertsRatherThanBadAnswer() public {
        feed.setRound(int256(type(uint256).max / 1e10 + 1), block.timestamp);
        vm.expectRevert(stdError.arithmeticError);
        h.check(address(token), address(feed), 8, HB, address(0));
        feed.setRound(int256(type(uint256).max / 1e10), block.timestamp);
        (OracleGuard.Status s,) = _check();
        _eq(s, OracleGuard.Status.OK);
    }

    // ── the "not now" family helper ──────────────────────────────────────

    /// The library's classification is unchanged. Note SweepExecutor no longer
    /// branches on it: EVERY non-OK status (BAD_ANSWER included) defers there —
    /// see SweepExecutorSweep.test_defer_badOracleAnswer.
    function test_isDeferrable_truthTable() public view {
        assertFalse(h.isDeferrable(OracleGuard.Status.OK));
        assertTrue(h.isDeferrable(OracleGuard.Status.STALE));
        assertTrue(h.isDeferrable(OracleGuard.Status.PAUSED));
        assertTrue(h.isDeferrable(OracleGuard.Status.SEQUENCER_DOWN));
        assertFalse(h.isDeferrable(OracleGuard.Status.BAD_ANSWER));
    }
}
