// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {UnitBase} from "./UnitBase.sol";

/// @notice Audit A-M1 (accepted on-chain, routed around off-chain): a sweep nets
///         every account's leg in an asset into ONE all-or-nothing swap, and marks
///         each account swept for the epoch BEFORE any leg runs. So one large leg
///         sets the swap for everyone it is batched with:
///           - inside the oracle band, every co-batched account fills at the
///             whale's average price (its price impact, shared pro-rata);
///           - past the band, every co-batched leg in that asset defers, epoch
///             after epoch, and the whale pays nothing for it.
///         The contracts are immutable, so the fix is the keeper's batching. The
///         last two tests pin down what that routing has to look like.
/// @dev The REAL StockRouter over a MockPoolManager whose USDG/NVDA pair is a
///      constant-product pool ($500k a side at the $100 oracle price), so size has
///      price impact. Keeper limits mirror engine/src/keeper: a same-block quote of
///      the exact netted swap, less QUOTE_TOLERANCE_BPS (plan.ts limitFromQuote).
contract NettedWhaleTest is UnitBase {
    uint256 internal constant POOL_USDG = 500_000e6;
    uint256 internal constant POOL_NVDA = 5_000e18; // $500k at $100
    uint256 internal constant QUOTE_TOLERANCE_BPS = 50; // engine default

    address internal mallory = makeAddr("mallory");

    event SwapDeferred(address indexed asset, uint256 usdg, bytes reason);

    function _realRouter() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        pm.setLiquidity(address(usdg), POOL_USDG, address(nvda), POOL_NVDA);
    }

    // ── fixture ──────────────────────────────────────────────────────────

    /// @dev Onboard with a cap equal to `amount` and accrue all of it.
    function _fund(address user, uint256 amount) internal {
        _onboard(user, amount, uint64(amount));
        _accrue(user, amount);
    }

    function _allIn(address user, address asset) internal {
        vm.prank(user);
        elections.setMix(_mix1(asset));
    }

    function _swapIn(uint256 total) internal view returns (uint256) {
        return total - (total * exec.feeBps()) / 10_000;
    }

    /// @dev What a keeper sends today: net the batch exactly as `_collect` /
    ///      `_addLeg` will, quote each netted swap, then limitFromQuote.
    function _keeperLimits(address[] memory accts) internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        uint256[] memory totals = new uint256[](toks.length);
        uint256 n;
        for (uint256 i; i < accts.length; ++i) {
            address a = accts[i];
            uint256 got = park.valueOf(a);
            if (exec.sweptEpoch(a) == exec.currentEpoch() || got < exec.threshold()) continue;
            ElectionRegistry.Leg[] memory mix = elections.mixOf(a);
            uint256 left = got;
            for (uint256 k; k < mix.length; ++k) {
                uint256 amt = k == mix.length - 1 ? left : (got * mix[k].bps) / 10_000;
                left -= amt;
                for (uint256 t; t < toks.length; ++t) {
                    if (toks[t] != mix[k].asset) continue;
                    if (totals[t] == 0) ++n;
                    totals[t] += amt;
                }
            }
        }
        l = new SweepExecutor.Limit[](n);
        uint256 j;
        for (uint256 t; t < toks.length; ++t) {
            if (totals[t] == 0) continue;
            uint256 swapIn = _swapIn(totals[t]);
            uint256 quoted = pm.quote(address(usdg), toks[t], swapIn);
            l[j++] = SweepExecutor.Limit(toks[t], (quoted * 1e6 * (10_000 - QUOTE_TOLERANCE_BPS)) / 10_000 / swapIn);
        }
    }

    function _keeperSweep(address[] memory accts) internal returns (uint256) {
        return _sweepWith(accts, _keeperLimits(accts));
    }

    /// @dev Next epoch, with every feed re-stamped so staleness never muddies
    ///      why a leg deferred.
    function _nextEpoch() internal {
        vm.warp(vm.getBlockTimestamp() + exec.epochLength());
        spyFeed.setAnswer(SPY_PX);
        nvdaFeed.setAnswer(NVDA_PX);
        qqqFeed.setAnswer(QQQ_PX);
    }

    function _bpsWorse(uint256 got, uint256 ref) internal pure returns (uint256) {
        return got >= ref ? 0 : ((ref - got) * 10_000) / ref;
    }

    // ── the finding ──────────────────────────────────────────────────────

    /// $10 of Alice's NVDA is netted with Mallory's $5,000. One swap carries both,
    /// and Alice's tokens per USDG are exactly Mallory's: ~98 bps worse than a
    /// batch of Alice alone would have filled. Every bound passes, so nothing
    /// on-chain refuses it.
    function test_AM1_oneWhaleLegSetsTheNettedFillForEveryCoBatchedAccount() public {
        _fund(alice, 10e6);
        _allIn(alice, address(nvda));
        _fund(mallory, 5_000e6);
        _allIn(mallory, address(nvda));
        uint256 solo = pm.quote(address(usdg), address(nvda), _swapIn(10e6));

        assertEq(_keeperSweep(_two(alice, mallory)), 2);
        assertEq(pm.swapCount(), 1, "one netted NVDA swap for both legs");

        uint256 a = nvda.balanceOf(alice);
        uint256 out = a + nvda.balanceOf(mallory);
        assertEq(out, _quotedAtStart(5_010e6), "exactly the netted swap's output");
        assertEq(a, (out * 10e6) / 5_010e6, "Alice gets the whale's average price, pro-rata");
        uint256 worse = _bpsWorse(a, solo);
        emit log_named_uint("Alice vs her solo fill, bps worse", worse);
        assertGe(worse, 95, "the whale's impact lands on Alice");
        assertLt(worse, BAND, "inside the oracle band: nothing refuses it");
        assertEq(usdg.balanceOf(address(vault)), (5_010e6 * 25) / 10_000, "fee on the whole netted leg");
    }

    /// Mallory's $10,000 pushes the netted swap ~196 bps off the oracle: the keeper's
    /// own quote of that swap is met, the executor's 150 bps oracle backstop (the
    /// same width as the router band) is not, so the whole NVDA leg defers —
    /// Alice's included — and both accounts are spent for the epoch. Seven
    /// epochs: Alice never gets NVDA, Mallory never pays a cent.
    function test_AM1_whaleBeyondTheBandDefersEveryCoBatchedLegEveryEpoch() public {
        _fund(alice, 10e6);
        _allIn(alice, address(nvda));
        _fund(mallory, 10_000e6);
        _allIn(mallory, address(nvda));

        address[] memory batch = _two(alice, mallory);
        for (uint256 e; e < 7; ++e) {
            SweepExecutor.Limit[] memory l = _keeperLimits(batch);
            uint256 swapIn = _swapIn(10_010e6);
            uint256 out = pm.quote(address(usdg), address(nvda), swapIn);
            uint256 backstop =
                (router.oracleTokensFor(swapIn, uint256(NVDA_PX) * 1e10) * (10_000 - exec.slippageBps())) / 10_000;
            assertEq(l.length, 1);
            assertEq(l[0].asset, address(nvda));
            assertGe(out, (swapIn * l[0].minOutPerUsdg) / 1e6, "the keeper's own limit is met");
            bytes memory reason = abi.encodeWithSelector(StockRouter.BelowMinOut.selector, out, backstop);
            vm.expectEmit(true, false, false, true, address(exec));
            emit SwapDeferred(address(nvda), 10_010e6, reason);
            assertEq(_sweepWith(batch, l), 2, "both marked swept for the epoch");

            // sweptEpoch was set before the leg ran: Alice cannot be retried alone now.
            assertEq(_keeperSweep(_one(alice)), 0, "no second chance this epoch");
            assertEq(nvda.balanceOf(alice), 0);
            assertEq(park.valueOf(alice), 10e6, "Alice's leg deferred back to the park");
            assertEq(park.valueOf(mallory), 10_000e6, "the whale loses nothing by blocking");
            _nextEpoch();
        }
        assertEq(pm.swapCount(), 0, "nothing ever converted");
        assertEq(usdg.balanceOf(address(vault)), 0, "no fee on a deferred leg");
    }

    /// Under the default 60/40 SPY/NVDA mix the SPY leg still converts while the
    /// whale blocks NVDA, and every deferred NVDA dollar is re-split 60/40 the next
    /// epoch: $50 becomes $46.80 of SPY and no NVDA instead of a 60/40 position.
    function test_AM1_defaultMixDriftsIntoSpyWhileTheWhaleBlocksNvda() public {
        _fund(alice, 50e6);
        _fund(mallory, 10_000e6);
        _allIn(mallory, address(nvda));

        uint256 epochs;
        while (park.valueOf(alice) >= exec.threshold()) {
            _keeperSweep(_two(alice, mallory));
            _nextEpoch();
            ++epochs;
        }
        assertEq(epochs, 3, "$50 -> $20 -> $8 -> $3.20, under the $5 threshold");
        assertEq(nvda.balanceOf(alice), 0, "0% NVDA instead of 40%");
        assertEq(
            spy.balanceOf(alice),
            _fair(_swapIn(30e6), SPY_PX) + _fair(_swapIn(12e6), SPY_PX) + _fair(_swapIn(4_800_000), SPY_PX),
            "every converted dollar went to SPY"
        );
        assertEq(park.valueOf(alice), 3_200_000);
        assertEq(park.valueOf(mallory), 10_000e6);
    }

    // ── what the keeper's routing has to do ─────────────────────────────

    /// Isolation works with the contracts as deployed: the small account in its
    /// own batch first fills at its own size, and the whale's impact stays with
    /// the whale in a batch of its own.
    function test_AM1_isolatingTheWhaleLastRestoresEveryoneElsesFill() public {
        _fund(alice, 10e6);
        _allIn(alice, address(nvda));
        _fund(mallory, 5_000e6);
        _allIn(mallory, address(nvda));
        uint256 solo = pm.quote(address(usdg), address(nvda), _swapIn(10e6));

        assertEq(_keeperSweep(_one(alice)), 1);
        assertEq(nvda.balanceOf(alice), solo, "Alice fills at her own size");
        assertEq(_keeperSweep(_one(mallory)), 1);
        uint256 fair = _fair(_swapIn(5_000e6), NVDA_PX);
        assertGe(_bpsWorse(nvda.balanceOf(mallory), fair), 95, "the impact is the whale's own");
    }

    /// Order matters: the pool does not snap back inside a block. Swept FIRST, the
    /// whale leaves the pool ~2% rich, so the next batch — even a lone $10 leg
    /// quoted afresh — falls outside the 150 bps oracle bound and defers. Isolate
    /// the whale LAST (or a block later, after arbitrage), never first.
    function test_AM1_whaleFirstLeavesItsImpactInThePoolForTheNextBatch() public {
        _fund(alice, 10e6);
        _allIn(alice, address(nvda));
        _fund(mallory, 5_000e6);
        _allIn(mallory, address(nvda));

        assertEq(_keeperSweep(_one(mallory)), 1);
        assertGt(nvda.balanceOf(mallory), 0);
        assertEq(_keeperSweep(_one(alice)), 1);
        assertEq(nvda.balanceOf(alice), 0, "deferred: the pool still carries the whale's impact");
        assertEq(park.valueOf(alice), 10e6);
    }

    /// @dev Output of one swap of `total` (before fee) against the pool as set up.
    function _quotedAtStart(uint256 total) internal view returns (uint256) {
        uint256 swapIn = _swapIn(total);
        return (POOL_NVDA * swapIn) / (POOL_USDG + swapIn);
    }
}
