// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
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
import {OracleGuard} from "../../src/libraries/OracleGuard.sol";

import {MockArbSys} from "../mocks/MockArbSys.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";

/// @notice Shared no-fork fixture: the real SPARE contracts wired over mocks.
/// @dev Units follow SPARE-BUILD.md §3.9: USDG 6 dp, stock tokens 18 dp, Chainlink
///      8 dp. By default the executor routes through MockRouter (scriptable fills);
///      suites that override `_realRouter()` get the REAL StockRouter over a
///      MockPoolManager instead.
abstract contract UnitBase is Test {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21, mid-week
    uint256 internal constant B0 = 76_000_000;
    int256 internal constant SPY_PX = 500e8; // $500
    int256 internal constant NVDA_PX = 100e8; // $100
    int256 internal constant QQQ_PX = 400e8; // $400
    uint32 internal constant HEARTBEAT = 86_400;
    uint16 internal constant BAND = 150;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal attestor;
    uint256 internal attestorKey;

    MockERC20 internal usdg;
    MockStockToken internal spy;
    MockStockToken internal nvda;
    MockStockToken internal qqq;
    MockFeed internal spyFeed;
    MockFeed internal nvdaFeed;
    MockFeed internal qqqFeed;
    MockPermit2 internal permit2;

    AssetRegistry internal registry;
    RuleRegistry internal rules;
    ElectionRegistry internal elections;
    ScreeningGate internal screening;
    CashPark internal park;
    FeeVault internal vault;
    SweepExecutor internal exec;
    UsdgParkAdapter internal usdgAdapter;

    MockRouter internal mrouter; // when !_realRouter()
    StockRouter internal router; // when _realRouter()
    MockPoolManager internal pm; // when _realRouter()

    function _realRouter() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(B0);
        // Production branch of L2Clock: an ArbSys at 0x64 that mirrors block.number.
        vm.etch(address(0x64), address(new MockArbSys()).code);
        (attestor, attestorKey) = makeAddrAndKey("attestor");

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        spy = new MockStockToken("SPDR S&P 500", "SPY");
        nvda = new MockStockToken("NVIDIA", "NVDA");
        qqq = new MockStockToken("Invesco QQQ", "QQQ");
        spyFeed = new MockFeed(8, SPY_PX);
        nvdaFeed = new MockFeed(8, NVDA_PX);
        qqqFeed = new MockFeed(8, QQQ_PX);
        permit2 = new MockPermit2();

        vm.startPrank(owner);
        registry = new AssetRegistry(owner, address(usdg));
        rules = new RuleRegistry();
        elections = new ElectionRegistry(owner, registry);
        screening = new ScreeningGate(owner, attestor, false);
        park = new CashPark(owner, IERC20(address(usdg)));
        vault = new FeeVault(owner);

        _registerActive(address(spy), address(spyFeed));
        _registerActive(address(nvda), address(nvdaFeed));
        _registerActive(address(qqq), address(qqqFeed));

        // Acceptance (2) default preset: 60/40 SPY/NVDA.
        ElectionRegistry.Leg[] memory d = new ElectionRegistry.Leg[](2);
        d[0] = ElectionRegistry.Leg(address(spy), 6000);
        d[1] = ElectionRegistry.Leg(address(nvda), 4000);
        elections.setDefaultMix(d);

        address routerAddr;
        if (_realRouter()) {
            pm = new MockPoolManager();
            router = new StockRouter(owner, IPoolManager(address(pm)), registry);
            routerAddr = address(router);
        } else {
            mrouter = new MockRouter(registry);
            routerAddr = address(mrouter);
        }

        exec = new SweepExecutor(
            owner, IAllowanceTransfer(address(permit2)), rules, elections, screening, StockRouter(routerAddr), park, vault
        );
        if (_realRouter()) router.setCaller(address(exec), true);
        usdgAdapter = new UsdgParkAdapter(address(usdg), address(park));
        park.setAdapter(usdgAdapter);
        park.setExecutor(address(exec));
        park.setKeeper(keeper, true);
        exec.setKeeper(keeper, true);
        vm.stopPrank();

        if (_realRouter()) {
            _setPoolFill(address(spy), SPY_PX, 10_000);
            _setPoolFill(address(nvda), NVDA_PX, 10_000);
            _setPoolFill(address(qqq), QQQ_PX, 10_000);
        }
    }

    // ── fixture helpers ─────────────────────────────────────────────────────

    /// @dev Sorted USDG/token key, fee 3000, tickSpacing 60, no hook.
    function _key(address token) internal view returns (PoolKey memory) {
        (address c0, address c1) = token < address(usdg) ? (token, address(usdg)) : (address(usdg), token);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
    }

    /// @dev Caller must already be pranking as owner.
    function _registerActive(address token, address feed) internal {
        registry.setAsset(token, feed, HEARTBEAT, BAND, _key(token));
        registry.setActive(token, true);
    }

    /// @dev MockPoolManager fills at `fillBps` of the oracle-fair amount, both ways.
    function _setPoolFill(address token, int256 px8, uint256 fillBps) internal {
        uint256 p = uint256(px8);
        pm.setRate(address(usdg), token, 1e20 * fillBps, p * 10_000);
        pm.setRate(token, address(usdg), p * fillBps, 1e20 * 10_000);
    }

    /// @dev Fund, grant Permit2 allowance, link self, rule ($1 round-up, 1x, `cap`/wk).
    function _onboard(address user, uint256 fund, uint64 cap) internal {
        usdg.mint(user, fund);
        vm.startPrank(user);
        usdg.approve(address(permit2), type(uint256).max);
        permit2.approve(address(usdg), address(exec), uint160(fund), uint48(block.timestamp + 365 days));
        rules.linkSelf();
        rules.setRule(1, 1, cap, true);
        vm.stopPrank();
    }

    /// @dev Roll past the finality buffer; returns the newest accruable L2 block.
    ///      Returned BEFORE any prank so an external read cannot consume it.
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

    /// @dev The keeper's per-asset limits for every registered asset: the oracle's
    ///      tokens per 1 USDG less the executor's slippage (i.e. exactly the
    ///      oracle backstop), or 1 when the oracle is not OK (the leg defers anyway).
    function _limits() internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        l = new SweepExecutor.Limit[](toks.length);
        StockRouter r = exec.router(); // MockRouter exposes the same surface
        uint256 slip = exec.slippageBps();
        for (uint256 i; i < toks.length; ++i) {
            (OracleGuard.Status s, uint256 p) = r.oracleStatus(toks[i]);
            uint256 m = s == OracleGuard.Status.OK ? (r.oracleTokensFor(1e6, p) * (10_000 - slip)) / 10_000 : 1;
            l[i] = SweepExecutor.Limit(toks[i], m);
        }
    }

    /// @dev `_limits()` with one asset's limit overridden (0 = drop it entirely).
    function _limitsWith(address asset, uint256 minOutPerUsdg) internal view returns (SweepExecutor.Limit[] memory l) {
        SweepExecutor.Limit[] memory all = _limits();
        uint256 n = minOutPerUsdg == 0 ? all.length - 1 : all.length;
        l = new SweepExecutor.Limit[](n);
        uint256 j;
        for (uint256 i; i < all.length; ++i) {
            if (all[i].asset == asset) {
                if (minOutPerUsdg == 0) continue;
                all[i].minOutPerUsdg = minOutPerUsdg;
            }
            l[j++] = all[i];
        }
    }

    /// @dev Keeper sweep with oracle-derived limits for every registered asset.
    function _sweep(address[] memory accts) internal returns (uint256) {
        return _sweepWith(accts, _limits());
    }

    function _sweepWith(address[] memory accts, SweepExecutor.Limit[] memory l) internal returns (uint256) {
        vm.prank(keeper);
        return exec.sweep(accts, l);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _three(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _mix1(address a) internal pure returns (ElectionRegistry.Leg[] memory l) {
        l = new ElectionRegistry.Leg[](1);
        l[0] = ElectionRegistry.Leg(a, 10_000);
    }

    function _mix2(address a, uint16 ba, address b, uint16 bb) internal pure returns (ElectionRegistry.Leg[] memory l) {
        l = new ElectionRegistry.Leg[](2);
        l[0] = ElectionRegistry.Leg(a, ba);
        l[1] = ElectionRegistry.Leg(b, bb);
    }

    /// @dev Oracle-fair tokens for a USDG amount at an 8-dp price.
    function _fair(uint256 usdgIn, int256 px8) internal pure returns (uint256) {
        return (usdgIn * 1e12 * 1e18) / (uint256(px8) * 1e10);
    }
}
