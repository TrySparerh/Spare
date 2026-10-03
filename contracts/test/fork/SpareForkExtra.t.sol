// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {RuleRegistry} from "../../src/RuleRegistry.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {ScreeningGate} from "../../src/ScreeningGate.sol";
import {StockRouter} from "../../src/StockRouter.sol";
import {CashPark} from "../../src/CashPark.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {SweepExecutor} from "../../src/SweepExecutor.sol";
import {UsdgParkAdapter} from "../../src/park/UsdgParkAdapter.sol";
import {SgovParkAdapter} from "../../src/park/SgovParkAdapter.sol";
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";
import {MockArbSys} from "../mocks/MockArbSys.sol";

/// @notice More end-to-end coverage on a Robinhood Chain MAINNET fork: SGOV parking
///         redeemed inside a sweep, in-kind exit on a stale SGOV feed, a 4-leg mix,
///         a large netted buy into a thin QQQ pool (deferred), and different mixes
///         netted in one batch. Real Uniswap v4 pools, Chainlink feeds, Permit2,
///         stock tokens. Every sweep is a keeper sweep with oracle-derived limits.
/// @dev The public RHC RPC is not an archive node: it serves roughly the last ~7k
///      L2 blocks of state. Foundry caches every slot a run touches under
///      ~/.foundry/cache/rpc/4663/<block>, so a pinned block keeps working after it
///      ages out ONLY for state already cached. This suite therefore pins its own
///      block (US-equity feeds fresh, Tuesday overnight session) rather than
///      SpareFork's 76_122_176, whose cache does not hold the QQQ/AAPL/TSLA state.
///      Override with SPARE_FORK_EXTRA_BLOCK to re-pin to a recent block if the
///      cache is lost.
contract SpareForkExtraTest is Test {
    // ── mainnet addresses (verified 2026-09-29) ──────────────────────────
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant QQQ_FEED = 0x80901d846d5D7B030F26B480776EE3b29374C2ae;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA_HOOK = 0xA0D185c901E4abD21f94D4E3ba8FAbc3E29E80c4;
    address constant SGOV_HOOK = 0xc52fc52698479E42F0dA9a8a75296EC3871454c0;
    uint256 constant FORK_BLOCK = 76_153_581;

    bytes32 constant ACCOUNT_SWEPT = keccak256("AccountSwept(address,uint256,uint256)");
    bytes32 constant ASSET_SWEPT = keccak256("AssetSwept(address,uint256,uint256,uint256)");
    bytes32 constant SAFE_SETTLED = keccak256("SafeSettled(address,address,uint256,string)");
    bytes32 constant DEFERRED = keccak256("Deferred(address,address,uint256,uint8)");
    bytes32 constant SWAP_DEFERRED = keccak256("SwapDeferred(address,uint256,bytes)");

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    AssetRegistry registry;
    RuleRegistry rules;
    ElectionRegistry elections;
    ScreeningGate screening;
    StockRouter router;
    CashPark park;
    FeeVault vault;
    SweepExecutor exec;

    function setUp() public {
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), vm.envOr("SPARE_FORK_EXTRA_BLOCK", FORK_BLOCK));
        // Nitro serves 0xfe at 0x64; put a real ArbSys there so L2Clock takes its
        // production branch on the fork.
        vm.etch(address(0x64), address(new MockArbSys()).code);

        vm.startPrank(owner);
        registry = new AssetRegistry(owner, USDG);
        rules = new RuleRegistry();
        elections = new ElectionRegistry(owner, registry);
        screening = new ScreeningGate(owner, owner, false);
        router = new StockRouter(owner, IPoolManager(POOL_MANAGER), registry);
        park = new CashPark(owner, IERC20(USDG));
        vault = new FeeVault(owner);
        exec = new SweepExecutor(
            owner, IAllowanceTransfer(PERMIT2), rules, elections, screening, router, park, vault
        );

        // Exact pool keys, hook included — the venue allowlist. Keys for SPY, NVDA
        // and SGOV match SpareFork; AAPL and TSLA use their plain 0.3% pools; QQQ is
        // pinned to its THIN 1% pool (fee 10000, tickSpacing 200, no hook) on purpose.
        registry.setAsset(SPY, SPY_FEED, 86_400, 150, _key(SPY, USDG, 3000, 60, address(0)));
        registry.setAsset(NVDA, NVDA_FEED, 86_400, 150, _key(USDG, NVDA, 0, 1, NVDA_HOOK));
        registry.setAsset(SGOV, SGOV_FEED, 86_400, 150, _key(USDG, SGOV, 0, 200, SGOV_HOOK));
        registry.setAsset(AAPL, AAPL_FEED, 86_400, 150, _key(USDG, AAPL, 3000, 60, address(0)));
        registry.setAsset(TSLA, TSLA_FEED, 86_400, 150, _key(TSLA, USDG, 3000, 60, address(0)));
        registry.setAsset(QQQ, QQQ_FEED, 86_400, 150, _key(USDG, QQQ, 10_000, 200, address(0)));
        registry.setActive(SPY, true);
        registry.setActive(NVDA, true);
        registry.setActive(SGOV, true);
        registry.setActive(AAPL, true);
        registry.setActive(TSLA, true);
        registry.setActive(QQQ, true);

        router.setCaller(address(exec), true);
        park.setExecutor(address(exec));
        park.setAdapter(new UsdgParkAdapter(USDG, address(park)));
        park.setKeeper(keeper, true);
        exec.setKeeper(keeper, true);

        ElectionRegistry.Leg[] memory d = new ElectionRegistry.Leg[](2);
        d[0] = ElectionRegistry.Leg(SPY, 6000);
        d[1] = ElectionRegistry.Leg(NVDA, 4000);
        elections.setDefaultMix(d);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _key(address c0, address c1, uint24 fee, int24 ts, address hooks) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(hooks));
    }

    /// @dev Fund, link, rule ($1, 1x, `cap`/wk), capped Permit2 allowance of `cap`.
    function _onboard(address user, uint256 fund, uint64 cap) internal {
        deal(USDG, user, fund);
        vm.startPrank(user);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), uint160(cap), uint48(block.timestamp + 30 days));
        rules.linkSelf();
        rules.setRule(1, 1, cap, true);
        vm.stopPrank();
    }

    function _pastFinality() internal returns (uint256 toBlock) {
        uint256 buf = exec.finalityBuffer();
        vm.roll(block.number + buf + 10);
        toBlock = block.number - buf - 1;
    }

    function _accrue(address user, uint256 amount) internal {
        uint256 to = _pastFinality();
        vm.prank(keeper);
        exec.accrue(user, user, amount, to);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    /// @dev The keeper's per-asset limits, derived from the oracle with a 1.5%
    ///      tolerance (fills on these pools measure within ~0.3% of Chainlink; in
    ///      production the keeper uses a same-block v4 quote instead). An asset
    ///      whose oracle is not OK gets 1 — its leg defers regardless.
    function _limits() internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        l = new SweepExecutor.Limit[](toks.length);
        for (uint256 i; i < toks.length; ++i) {
            (OracleGuard.Status s, uint256 p) = router.oracleStatus(toks[i]);
            uint256 m = s == OracleGuard.Status.OK ? (router.oracleTokensFor(1e6, p) * 9_850) / 10_000 : 1;
            l[i] = SweepExecutor.Limit(toks[i], m);
        }
    }

    /// @dev Keeper sweep. Limits are computed BEFORE the prank so no external read
    ///      consumes it.
    function _sweepBatch(address[] memory accts) internal returns (uint256) {
        SweepExecutor.Limit[] memory l = _limits();
        vm.prank(keeper);
        return exec.sweep(accts, l);
    }

    function _fee(uint256 x) internal pure returns (uint256) {
        return (x * 25) / 10_000;
    }

    function _mix(address a, uint16 ba, address b, uint16 bb) internal pure returns (ElectionRegistry.Leg[] memory l) {
        if (bb == 0) {
            l = new ElectionRegistry.Leg[](1);
            l[0] = ElectionRegistry.Leg(a, ba);
        } else {
            l = new ElectionRegistry.Leg[](2);
            l[0] = ElectionRegistry.Leg(a, ba);
            l[1] = ElectionRegistry.Leg(b, bb);
        }
    }

    function _price(address token) internal view returns (uint256 p) {
        OracleGuard.Status s;
        (s, p) = router.oracleStatus(token);
        assertEq(uint8(s), uint8(OracleGuard.Status.OK), "feed must be fresh at the fork block");
    }

    function _useSgovPark() internal returns (SgovParkAdapter sgov) {
        vm.startPrank(owner);
        sgov = new SgovParkAdapter(USDG, SGOV, address(park), router, 100);
        router.setCaller(address(sgov), true);
        park.setAdapter(sgov);
        vm.stopPrank();
    }

    function _assertNoResidue(address[6] memory toks) internal view {
        for (uint256 i; i < toks.length; ++i) {
            if (toks[i] == address(0)) continue;
            assertEq(IERC20(toks[i]).balanceOf(address(exec)), 0, "executor residue");
            assertEq(IERC20(toks[i]).balanceOf(address(router)), 0, "router residue");
        }
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0, address indexed1) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(exec) || logs[i].topics[0] != topic0) continue;
            if (indexed1 == address(0) || logs[i].topics[1] == bytes32(uint256(uint160(indexed1)))) n++;
        }
    }

    // ── SGOV parking inside a sweep ──────────────────────────────────────

    /// Parked SGOV is sold back to USDG through the allowlisted pool during the
    /// sweep, at realised market proceeds, and the proceeds buy the mix.
    function test_sgovRedeemedDuringSweep() public {
        SgovParkAdapter sgov = _useSgovPark();
        _onboard(alice, 100e6, 50e6);
        _accrue(alice, 20e6);
        vm.prank(keeper);
        park.park(_one(alice));
        uint256 units = park.units(alice);
        assertGt(units, 0, "parked in SGOV");
        assertEq(park.pending(alice), 0);
        assertEq(IERC20(SGOV).balanceOf(address(sgov)), units);
        uint256 nav = park.valueOf(alice);
        uint256 pSpy = _price(SPY);
        uint256 pNvda = _price(NVDA);

        vm.recordLogs();
        assertEq(_sweepBatch(_one(alice)), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 got;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(exec) && logs[i].topics[0] == ACCOUNT_SWEPT) {
                (, got) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }

        assertEq(park.units(alice), 0, "units redeemed");
        assertEq(park.totalUnits(), 0);
        assertEq(park.valueOf(alice), 0);
        assertEq(IERC20(SGOV).balanceOf(address(sgov)), 0, "adapter sold its SGOV");
        assertApproxEqRel(got, nav, 0.015e18, "realised within the oracle band of NAV");

        uint256 spyLeg = (got * 6000) / 10_000;
        uint256 nvdaLeg = got - spyLeg;
        assertApproxEqRel(IERC20(SPY).balanceOf(alice), router.oracleTokensFor(spyLeg - _fee(spyLeg), pSpy), 0.015e18);
        assertApproxEqRel(
            IERC20(NVDA).balanceOf(alice), router.oracleTokensFor(nvdaLeg - _fee(nvdaLeg), pNvda), 0.015e18
        );
        assertEq(IERC20(USDG).balanceOf(address(vault)), _fee(spyLeg) + _fee(nvdaLeg), "fee on realised USDG");
        _assertNoResidue([USDG, SGOV, SPY, NVDA, address(0), address(0)]);
        emit log_named_decimal_uint("NAV before sweep", nav, 6);
        emit log_named_decimal_uint("realised from SGOV", got, 6);
    }

    /// Law 5 on the real chain: over a weekend the SGOV feed goes stale, the market
    /// path refuses to sell, and exit hands over SGOV itself plus the pending USDG.
    function test_exitInKindWhenSgovFeedStale() public {
        SgovParkAdapter sgov = _useSgovPark();
        _onboard(alice, 100e6, 50e6);
        _accrue(alice, 20e6);
        vm.prank(keeper);
        park.park(_one(alice));
        _accrue(alice, 3e6); // stays pending
        uint256 units = park.units(alice);

        vm.warp(block.timestamp + 3 days);
        (OracleGuard.Status s,) = router.oracleStatus(SGOV);
        assertEq(uint8(s), uint8(OracleGuard.Status.STALE), "SGOV feed stale after the warp");
        assertFalse(park.isFresh(), "stale NAV");

        // Law 4: while NAV is stale, new accrual stays un-parked.
        _accrue(alice, 1e6);
        vm.prank(keeper);
        park.park(_one(alice));
        assertEq(park.pending(alice), 4e6, "held as plain USDG");
        assertEq(park.units(alice), units);

        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        (uint256 out, uint256 inKind) = park.exit();
        assertEq(inKind, units, "all units in kind");
        assertEq(out, 4e6, "pending USDG returned");
        assertEq(IERC20(SGOV).balanceOf(alice), units, "SGOV delivered in kind");
        assertEq(IERC20(USDG).balanceOf(alice) - usdgBefore, 4e6);
        assertEq(park.totalUnits(), 0);
        assertEq(park.totalPending(), 0);
        assertEq(IERC20(SGOV).balanceOf(address(sgov)), 0);
    }

    // ── a 4-leg mix ──────────────────────────────────────────────────────

    function test_fourLegMix() public {
        _onboard(alice, 100e6, 50e6);
        ElectionRegistry.Leg[] memory l = new ElectionRegistry.Leg[](4);
        l[0] = ElectionRegistry.Leg(SPY, 4000);
        l[1] = ElectionRegistry.Leg(NVDA, 3000);
        l[2] = ElectionRegistry.Leg(AAPL, 2000);
        l[3] = ElectionRegistry.Leg(TSLA, 1000);
        vm.prank(alice);
        elections.setMix(l);
        _accrue(alice, 20e6);

        uint256[4] memory legs = [uint256(8e6), 6e6, 4e6, 2e6];
        uint256[4] memory prices;
        for (uint256 i; i < 4; ++i) {
            prices[i] = _price(l[i].asset);
        }

        vm.recordLogs();
        assertEq(_sweepBatch(_one(alice)), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, ASSET_SWEPT, address(0)), 4, "one swap per leg");

        for (uint256 i; i < 4; ++i) {
            uint256 bal = IERC20(l[i].asset).balanceOf(alice);
            assertGt(bal, 0, "leg delivered");
            assertApproxEqRel(bal, router.oracleTokensFor(legs[i] - _fee(legs[i]), prices[i]), 0.015e18, "at reference");
        }
        assertEq(IERC20(USDG).balanceOf(address(vault)), 50_000, "0.25% of $20");
        assertEq(park.valueOf(alice), 0);
        _assertNoResidue([USDG, SPY, NVDA, AAPL, TSLA, address(0)]);
        emit log_named_decimal_uint("AAPL bought", IERC20(AAPL).balanceOf(alice), 18);
        emit log_named_decimal_uint("TSLA bought", IERC20(TSLA).balanceOf(alice), 18);
    }

    // ── a thin pool cannot take a large netted buy ───────────────────────

    /// Control: the pinned QQQ pool (1%, tickSpacing 200, no hook) cannot absorb a
    /// $600 buy at all — at the pinned block it runs out of liquidity after ~$322
    /// and the router refuses the partial fill outright (exact input or nothing).
    function test_thinQqqPoolRefusesLargeBuyDirectly() public {
        vm.prank(owner);
        router.setCaller(address(this), true);
        deal(USDG, address(this), 600e6);
        IERC20(USDG).approve(address(router), type(uint256).max);
        vm.expectPartialRevert(StockRouter.PartialFill.selector);
        router.buy(QQQ, 600e6, 0, address(this));
        assertEq(IERC20(USDG).balanceOf(address(this)), 600e6, "nothing spent");
    }

    /// Four all-QQQ accounts net to ~$600 of QQQ through the thin pool. That leg
    /// cannot execute, so it DEFERS: each contributor's $150 goes back to the park
    /// (it used to be paid out as USDG — a market condition must never become a
    /// USDG payout). The rest of the batch (alice's SPY/NVDA) still converts, one
    /// bad leg never reverts the whole sweep, and no fee is taken on the failed leg.
    function test_largeNettedQqqBuyDefersInsteadOfReverting() public {
        _onboard(alice, 100e6, 50e6);
        address[4] memory q = [makeAddr("q1"), makeAddr("q2"), makeAddr("q3"), makeAddr("q4")];
        for (uint256 i; i < 4; ++i) {
            _onboard(q[i], 200e6, 200e6);
            vm.prank(q[i]);
            elections.setMix(_mix(QQQ, 10_000, address(0), 0));
            _accrue(q[i], 150e6);
        }
        _accrue(alice, 10e6);
        (OracleGuard.Status sq,) = router.oracleStatus(QQQ);
        assertEq(uint8(sq), uint8(OracleGuard.Status.OK), "QQQ oracle fine: this is an EXECUTION failure");

        address[] memory batch = new address[](5);
        batch[0] = alice;
        for (uint256 i; i < 4; ++i) {
            batch[i + 1] = q[i];
        }
        vm.recordLogs();
        assertEq(_sweepBatch(batch), 5, "whole batch swept, nothing reverted");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i; i < 4; ++i) {
            assertEq(IERC20(QQQ).balanceOf(q[i]), 0, "no QQQ");
            assertEq(IERC20(USDG).balanceOf(q[i]), 50e6, "nothing paid out as USDG");
            assertEq(park.pending(q[i]), 150e6, "the full $150 leg is back in the park");
            assertEq(exec.sweptEpoch(q[i]), exec.currentEpoch(), "epoch consumed; retried next epoch");
        }
        assertEq(_count(logs, SAFE_SETTLED, address(0)), 0, "no SafeSettled: a failed swap is not a payout");
        assertEq(_count(logs, DEFERRED, address(0)), 4, "one Deferred notice per QQQ contributor");
        assertEq(_count(logs, SWAP_DEFERRED, QQQ), 1, "one SwapDeferred for the netted QQQ leg");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(exec) || logs[i].topics[0] != SWAP_DEFERRED) continue;
            (uint256 amt, bytes memory reason) = abi.decode(logs[i].data, (uint256, bytes));
            assertEq(amt, 600e6, "the whole netted leg");
            assertEq(bytes4(reason), StockRouter.PartialFill.selector, "the router refused the partial fill");
        }
        assertEq(_count(logs, ASSET_SWEPT, address(0)), 2, "SPY and NVDA still swapped");
        assertGt(IERC20(SPY).balanceOf(alice), 0);
        assertGt(IERC20(NVDA).balanceOf(alice), 0);
        assertEq(IERC20(USDG).balanceOf(address(vault)), 25_000, "fee only on alice's converted $10");
        _assertNoResidue([USDG, QQQ, SPY, NVDA, address(0), address(0)]);
    }

    // ── different mixes netted in one batch ──────────────────────────────

    function test_differentMixesNettedInOneBatch() public {
        _onboard(alice, 100e6, 50e6);
        _onboard(bob, 100e6, 50e6);
        _onboard(carol, 100e6, 50e6);
        _onboard(dave, 100e6, 50e6);
        vm.prank(alice);
        elections.setMix(_mix(SPY, 10_000, address(0), 0));
        vm.prank(bob);
        elections.setMix(_mix(NVDA, 5000, AAPL, 5000));
        // carol keeps the 60/40 SPY/NVDA default
        vm.prank(dave);
        elections.setMix(_mix(TSLA, 5000, SGOV, 5000));

        _accrue(alice, 10e6);
        _accrue(bob, 20e6);
        _accrue(carol, 10e6);
        _accrue(dave, 8e6);
        uint256 pSpy = _price(SPY);
        uint256 pNvda = _price(NVDA);
        uint256 pAapl = _price(AAPL);
        uint256 pTsla = _price(TSLA);
        uint256 pSgov = _price(SGOV);

        address[] memory batch = new address[](4);
        batch[0] = alice;
        batch[1] = bob;
        batch[2] = carol;
        batch[3] = dave;
        vm.recordLogs();
        assertEq(_sweepBatch(batch), 4);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, ASSET_SWEPT, address(0)), 5, "one netted swap per distinct asset");

        // SPY netted from alice ($10) and carol ($6): split 10:6 of one fill.
        uint256 aSpy = IERC20(SPY).balanceOf(alice);
        uint256 cSpy = IERC20(SPY).balanceOf(carol);
        assertApproxEqRel(aSpy * 6, cSpy * 10, 1e12, "SPY pro-rata 10:6");
        // NVDA netted from bob ($10) and carol ($4): split 10:4.
        uint256 bNvda = IERC20(NVDA).balanceOf(bob);
        uint256 cNvda = IERC20(NVDA).balanceOf(carol);
        assertApproxEqRel(bNvda * 4, cNvda * 10, 1e12, "NVDA pro-rata 10:4");

        assertApproxEqRel(aSpy, router.oracleTokensFor(10e6 - _fee(10e6), pSpy), 0.015e18);
        assertApproxEqRel(bNvda, router.oracleTokensFor(10e6 - _fee(10e6), pNvda), 0.015e18);
        assertApproxEqRel(IERC20(AAPL).balanceOf(bob), router.oracleTokensFor(10e6 - _fee(10e6), pAapl), 0.015e18);
        assertApproxEqRel(IERC20(TSLA).balanceOf(dave), router.oracleTokensFor(4e6 - _fee(4e6), pTsla), 0.015e18);
        assertApproxEqRel(IERC20(SGOV).balanceOf(dave), router.oracleTokensFor(4e6 - _fee(4e6), pSgov), 0.015e18);
        assertEq(IERC20(AAPL).balanceOf(alice) + IERC20(AAPL).balanceOf(carol) + IERC20(AAPL).balanceOf(dave), 0);

        assertEq(
            IERC20(USDG).balanceOf(address(vault)),
            _fee(16e6) + _fee(14e6) + _fee(10e6) + _fee(4e6) + _fee(4e6),
            "fee per netted asset leg"
        );
        _assertNoResidue([USDG, SPY, NVDA, AAPL, TSLA, SGOV]);
    }
}
