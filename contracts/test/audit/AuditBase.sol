// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

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

/// @notice Raw exact-input swapper against the v4 PoolManager: what any third
///         party (or a hook) can do in the same transaction as a sweep.
contract RawSwapper is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) public returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, bool z, uint256 amt) = abi.decode(data, (PoolKey, bool, uint256));
        BalanceDelta d = pm.swap(
            key,
            SwapParams({
                zeroForOne: z,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 inD = z ? BalanceDeltaLibrary.amount0(d) : BalanceDeltaLibrary.amount1(d);
        int128 outD = z ? BalanceDeltaLibrary.amount1(d) : BalanceDeltaLibrary.amount0(d);
        Currency cin = z ? key.currency0 : key.currency1;
        Currency cout = z ? key.currency1 : key.currency0;
        pm.sync(cin);
        IERC20(Currency.unwrap(cin)).transfer(address(pm), uint256(uint128(-inD)));
        pm.settle();
        pm.take(cout, address(this), uint256(uint128(outD)));
        return abi.encode(uint256(uint128(outD)));
    }
}

/// @notice Atomic sandwich of the sweep: front-run, sweep, back-run, all in one
///         transaction (no mempool visibility needed — the attacker triggers the
///         victim trade itself). This worked while sweep() was permissionless; it
///         is now keeper-only, so `attack` reverts NotKeeper.
contract SweepSandwicher is RawSwapper {
    IERC20 public immutable usdg;

    constructor(IPoolManager pm_, IERC20 usdg_) RawSwapper(pm_) {
        usdg = usdg_;
    }

    function attack(PoolKey memory key, uint256 front, SweepExecutor exec, address[] memory accounts)
        external
        returns (int256 profit)
    {
        uint256 u0 = usdg.balanceOf(address(this));
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        uint256 tok = front == 0 ? 0 : swapExactIn(key, usdgIs0, front); // USDG -> token (push price up)
        exec.sweep(accounts, new SweepExecutor.Limit[](0));
        if (tok != 0) swapExactIn(key, !usdgIs0, tok); // token -> USDG (unwind)
        profit = int256(usdg.balanceOf(address(this))) - int256(u0);
    }
}

abstract contract AuditBase is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA_HOOK = 0xA0D185c901E4abD21f94D4E3ba8FAbc3E29E80c4;
    address constant SGOV_HOOK = 0xc52fc52698479E42F0dA9a8a75296EC3871454c0;
    /// Stock-token beacon, which is also the ACCESS_CONTROLLED_REGISTRY (blocklist + global pause).
    address constant STOCK_REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    uint256 constant FORK_BLOCK = 76_122_176;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    AssetRegistry registry;
    RuleRegistry rules;
    ElectionRegistry elections;
    ScreeningGate screening;
    StockRouter router;
    CashPark park;
    FeeVault vault;
    SweepExecutor exec;
    /// Simulates a same-block v4 quote for the keeper (see `_quoteLimit`).
    RawSwapper quoter;

    /// @dev The public RPC is not an archive node (it serves roughly the last hour
    ///      of state), and these suites push pools and deal to fresh addresses, so
    ///      they need a RECENT block. Opt in with
    ///        export AUDIT_FORK_BLOCK=$(( $(cast block-number --rpc-url $RHC_RPC_URL) - 20 ))
    ///      on a weekday (US-equity feeds must be fresh). Without it the fork-backed
    ///      audit suites are skipped (as AuditFunds / ProbeSgovPause already were);
    ///      the suite's pinned 76_122_176 only has the slots test/fork touches cached.
    function setUp() public virtual {
        uint256 blk = vm.envOr("AUDIT_FORK_BLOCK", uint256(0));
        if (blk == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envString("RHC_RPC_URL"), blk);
        vm.etch(address(0x64), address(new MockArbSys()).code);
        quoter = new RawSwapper(IPoolManager(POOL_MANAGER));

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
        registry.setAsset(SPY, SPY_FEED, 86_400, 150, spyKey());
        registry.setAsset(NVDA, NVDA_FEED, 86_400, 150, nvdaKey());
        registry.setAsset(SGOV, SGOV_FEED, 86_400, 150, sgovKey());
        registry.setActive(SPY, true);
        registry.setActive(NVDA, true);
        registry.setActive(SGOV, true);
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

    function _key(address c0, address c1, uint24 fee, int24 ts, address hooks) internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, ts, IHooks(hooks));
    }

    function spyKey() internal pure returns (PoolKey memory) {
        return _key(SPY, USDG, 3000, 60, address(0));
    }

    function nvdaKey() internal pure returns (PoolKey memory) {
        return _key(USDG, NVDA, 0, 1, NVDA_HOOK);
    }

    function sgovKey() internal pure returns (PoolKey memory) {
        return _key(USDG, SGOV, 0, 200, SGOV_HOOK);
    }

    function _onboard(address user, uint256 amount) internal {
        deal(USDG, user, amount);
        vm.startPrank(user);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDG, address(exec), type(uint160).max, uint48(block.timestamp + 30 days));
        rules.linkSelf();
        rules.setRule(1, 1, type(uint64).max, true);
        vm.stopPrank();
    }

    function _setMix(address user, address asset) internal {
        ElectionRegistry.Leg[] memory m = new ElectionRegistry.Leg[](1);
        m[0] = ElectionRegistry.Leg(asset, 10_000);
        vm.prank(user);
        elections.setMix(m);
    }

    function _accrue(address user, uint256 amount) internal {
        uint256 buf = exec.finalityBuffer();
        vm.roll(block.number + buf + 10);
        uint256 to = block.number - buf - 1;
        vm.prank(keeper);
        exec.accrue(user, user, amount, to);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    // ── keeper sweeps ────────────────────────────────────────────────────

    /// @dev Limits for every registered asset from the oracle with a 1.5% tolerance
    ///      (= the executor's oracle backstop). What a keeper passes when it has no
    ///      tighter quote; 1 for an asset whose oracle is not OK (it defers anyway).
    function _oracleLimits() internal view returns (SweepExecutor.Limit[] memory l) {
        address[] memory toks = registry.tokens();
        l = new SweepExecutor.Limit[](toks.length);
        for (uint256 i; i < toks.length; ++i) {
            (OracleGuard.Status s, uint256 p) = router.oracleStatus(toks[i]);
            uint256 m = s == OracleGuard.Status.OK ? (router.oracleTokensFor(1e6, p) * 9_850) / 10_000 : 1;
            l[i] = SweepExecutor.Limit(toks[i], m);
        }
    }

    /// @dev The keeper's quote-derived limit: simulate `usdgIn` USDG -> `asset`
    ///      through the allowlisted pool at the CURRENT state (as a same-block v4
    ///      quoter would), then allow `tolBps` below it. Tokens (18 dp) per 1 USDG.
    function _quoteLimit(address asset, uint256 usdgIn, uint256 tolBps) internal returns (uint256) {
        PoolKey memory key = registry.get(asset).poolKey;
        uint256 s = vm.snapshotState();
        deal(USDG, address(quoter), usdgIn);
        uint256 out = quoter.swapExactIn(key, Currency.unwrap(key.currency0) == USDG, usdgIn);
        vm.revertToState(s);
        return (((out * 1e6) / usdgIn) * (10_000 - tolBps)) / 10_000;
    }

    function _limit1(address asset, uint256 minOutPerUsdg) internal pure returns (SweepExecutor.Limit[] memory l) {
        l = new SweepExecutor.Limit[](1);
        l[0] = SweepExecutor.Limit(asset, minOutPerUsdg);
    }

    function _keeperSweep(address[] memory accounts, SweepExecutor.Limit[] memory l) internal returns (uint256) {
        vm.prank(keeper);
        return exec.sweep(accounts, l);
    }

    function _keeperSweep(address[] memory accounts) internal returns (uint256) {
        return _keeperSweep(accounts, _oracleLimits());
    }
}
