// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {SpareAuth} from "./SpareAuth.sol";
import {RuleRegistry} from "./RuleRegistry.sol";
import {ElectionRegistry} from "./ElectionRegistry.sol";
import {AssetRegistry} from "./AssetRegistry.sol";
import {ScreeningGate} from "./ScreeningGate.sol";
import {StockRouter} from "./StockRouter.sol";
import {CashPark} from "./CashPark.sol";
import {FeeVault} from "./FeeVault.sol";
import {OracleGuard} from "./libraries/OracleGuard.sol";
import {L2Clock} from "./libraries/L2Clock.sol";

/// @title SweepExecutor
/// @notice Turns observed payments into spare change (`accrue`) and spare change
///         into the user's chosen tokenized stocks (`sweep`).
///
/// @dev ACCRUAL TRUST MODEL (build spec §3.1)
///      A contract cannot verify an arbitrary past transfer, so accrual is
///      keeper-attested — but bounded and auditable:
///        - each accrual covers a block range and advances a per-wallet cursor, so
///          no range is ever accrued twice;
///        - the cursor never starts before the wallet's link block, so a new link
///          cannot reach back to payments made before consent;
///        - the range must be behind the head by `finalityBuffer` L2 blocks;
///        - the pull is capped ON-CHAIN by the user's weekly cap and, independently,
///          by the Permit2 allowance the user granted this contract.
///      A compromised keeper can pull at most what the user authorised, and anyone
///      can recompute every accrual from public chain data.
///
///      SWEEP OUTCOMES (build spec §3.4) — per asset leg:
///        swapped      -> tokens delivered, fee taken
///        deferred     -> anything "not now": oracle stale / paused / sequencer /
///                        bad answer, no keeper limit, or a swap that reverted
///                        (slippage, oracle band, hook pause, thin pool). The USDG
///                        goes back to the park untouched and is retried next
///                        epoch. A market condition never becomes a USDG payout.
///        safe-settled -> the asset was deactivated in the registry: the leg's
///                        USDG is delivered to the user as USDG with a notice.
///      Fees are charged only on legs that actually convert.
///
///      EXECUTION (review HIGH): `sweep` is keeper-only. The keeper supplies, per
///      asset, the minimum tokens per 1 USDG taken from a same-block v4 quote with
///      a tight tolerance. That limit — not the oracle band — is what stops a
///      sandwich; the router's oracle band stays as the backstop.
contract SweepExecutor is SpareAuth, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Accrual {
        address account;
        address wallet;
        uint256 amount;
        uint256 toBlock;
    }

    struct Contribution {
        address account;
        address asset;
        uint256 usdg;
    }

    /// @notice Keeper-supplied execution limit for one asset in a sweep.
    /// @param minOutPerUsdg minimum asset tokens (18 dp) per 1 USDG (1e6 base units)
    struct Limit {
        address asset;
        uint256 minOutPerUsdg;
    }

    enum Settle {
        DEFER,
        SAFE_SETTLE
    }

    IAllowanceTransfer public immutable permit2;
    IERC20 public immutable usdg;
    RuleRegistry public immutable rules;
    ElectionRegistry public immutable elections;
    AssetRegistry public immutable registry;
    ScreeningGate public immutable screening;
    StockRouter public immutable router;
    CashPark public immutable cashPark;
    FeeVault public immutable feeVault;

    /// @notice L2 blocks an accrual range must trail the head by (~0.1s blocks on RHC).
    uint256 public finalityBuffer = 3_000;
    /// @notice Sweep once an account holds at least this much (USDG base units). $5.
    uint256 public threshold = 5_000_000;
    /// @notice Conversion fee, bps. Taken only on legs that convert.
    uint16 public feeBps = 25;
    /// @notice Oracle backstop for minOut per leg (the keeper's quote limit is the
    ///         primary bound). Kept equal to the router band by default.
    uint16 public slippageBps = 150;
    /// @notice An account can be swept at most once per epoch.
    uint64 public epochLength = 1 days;

    uint16 public constant MAX_FEE_BPS = 100;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint256 public constant MAX_BATCH = 64;

    mapping(address wallet => uint256) public lastAccruedBlock;
    /// @notice USDG pulled per account per UTC day (block.timestamp / 1 days).
    ///         The weekly cap is enforced over a ROLLING 7-day window of these.
    mapping(address account => mapping(uint256 day => uint256)) public dayPulled;
    /// @notice Epoch (+1, so 0 means never) the account was last swept.
    mapping(address account => uint256) public sweptEpoch;
    /// @notice Deliveries that could not be pushed (e.g. a token blocklist); pull with `claim`.
    mapping(address account => mapping(address token => uint256)) public claimable;

    event Accrued(address indexed account, address indexed wallet, uint256 amount, uint256 fromBlock, uint256 toBlock);
    event AccountSwept(address indexed account, uint256 epoch, uint256 usdg);
    event AssetSwept(address indexed asset, uint256 usdgIn, uint256 fee, uint256 tokensOut);
    event Delivered(address indexed account, address indexed token, uint256 amount);
    event DeliveryHeld(address indexed account, address indexed token, uint256 amount);
    event Deferred(address indexed account, address indexed asset, uint256 usdg, OracleGuard.Status status);
    event SafeSettled(address indexed account, address indexed asset, uint256 usdg, string reason);
    event Claimed(address indexed account, address indexed token, address to, uint256 amount);
    event SwapDeferred(address indexed asset, uint256 usdg, bytes reason);
    event AccrualSkipped(address indexed account, address indexed wallet, uint256 toBlock, bytes reason);
    event ParamsSet(uint256 finalityBuffer, uint256 threshold, uint16 feeBps, uint16 slippageBps, uint64 epochLength);

    error NotLinked(address wallet);
    error RuleDisabled(address account);
    error CursorNotAdvancing(uint256 from, uint256 toBlock);
    error NotFinal(uint256 toBlock, uint256 head);
    error WeeklyCapExceeded(uint256 pulled, uint256 cap);
    error AmountTooLarge();
    error BatchTooLarge();
    error BadParam();
    error NotSelf();

    constructor(
        address owner_,
        IAllowanceTransfer permit2_,
        RuleRegistry rules_,
        ElectionRegistry elections_,
        ScreeningGate screening_,
        StockRouter router_,
        CashPark cashPark_,
        FeeVault feeVault_
    ) SpareAuth(owner_) {
        permit2 = permit2_;
        rules = rules_;
        elections = elections_;
        registry = elections_.registry();
        screening = screening_;
        router = router_;
        cashPark = cashPark_;
        feeVault = feeVault_;
        usdg = IERC20(router_.usdg());
        usdg.forceApprove(address(router_), type(uint256).max);
        usdg.forceApprove(address(cashPark_), type(uint256).max);
    }

    function setParams(
        uint256 finalityBuffer_,
        uint256 threshold_,
        uint16 feeBps_,
        uint16 slippageBps_,
        uint64 epochLength_
    ) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || slippageBps_ > MAX_SLIPPAGE_BPS) revert BadParam();
        if (threshold_ < 1_000_000 || epochLength_ < 1 hours) revert BadParam();
        finalityBuffer = finalityBuffer_;
        threshold = threshold_;
        feeBps = feeBps_;
        slippageBps = slippageBps_;
        epochLength = epochLength_;
        emit ParamsSet(finalityBuffer_, threshold_, feeBps_, slippageBps_, epochLength_);
    }

    // ── accrual ──────────────────────────────────────────────────────────

    function accrue(address account, address wallet, uint256 amount, uint256 toBlock)
        external
        onlyKeeper
        whenNotPaused
        nonReentrant
    {
        _accrue(account, wallet, amount, toBlock);
    }

    /// @notice Accrue many wallets. One bad entry (revoked Permit2 allowance,
    ///         unlinked wallet, cap hit) is skipped with `AccrualSkipped` instead
    ///         of reverting everyone else's accrual.
    function accrueBatch(Accrual[] calldata batch)
        external
        onlyKeeper
        whenNotPaused
        nonReentrant
        returns (uint256 accrued)
    {
        if (batch.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < batch.length; ++i) {
            Accrual calldata a = batch[i];
            try this.accrueSelf(a.account, a.wallet, a.amount, a.toBlock) {
                ++accrued;
            } catch (bytes memory reason) {
                emit AccrualSkipped(a.account, a.wallet, a.toBlock, reason);
            }
        }
    }

    /// @dev External hop so `accrueBatch` can try/catch each entry. Only callable
    ///      by this contract, i.e. from inside an `accrueBatch` the keeper sent.
    function accrueSelf(address account, address wallet, uint256 amount, uint256 toBlock) external {
        if (msg.sender != address(this)) revert NotSelf();
        _accrue(account, wallet, amount, toBlock);
    }

    function _accrue(address account, address wallet, uint256 amount, uint256 toBlock) internal {
        if (!rules.isLinked(account, wallet)) revert NotLinked(wallet);
        RuleRegistry.Rule memory r = rules.ruleOf(account);
        if (!r.enabled || r.weeklyCap == 0) revert RuleDisabled(account);

        // The cursor never starts before consent: not before the link, and not
        // before the rule was (re-)enabled — a disabled window is never accrued.
        uint256 from = lastAccruedBlock[wallet];
        uint256 linked = rules.linkedAt(wallet);
        if (linked > from) from = linked;
        uint256 active = rules.activeSince(account);
        if (active > from) from = active;
        if (toBlock <= from) revert CursorNotAdvancing(from, toBlock);
        uint256 head = L2Clock.blockNumber();
        if (toBlock + finalityBuffer > head) revert NotFinal(toBlock, head);
        lastAccruedBlock[wallet] = toBlock;

        if (amount != 0) {
            if (amount > type(uint160).max) revert AmountTooLarge();
            // Rolling 7 days (today + the 6 before it), so two adjacent calendar
            // buckets can never add up to twice the cap — acceptance (7).
            uint256 today = block.timestamp / 1 days;
            uint256 pulled = _pulled7d(account, today) + amount;
            if (pulled > r.weeklyCap) revert WeeklyCapExceeded(pulled, r.weeklyCap);
            dayPulled[account][today] += amount;

            // Reverts on its own if the user's Permit2 allowance is short or expired.
            permit2.transferFrom(wallet, address(this), uint160(amount), address(usdg));
            cashPark.credit(account, amount);
        }
        emit Accrued(account, wallet, amount, from, toBlock);
    }

    // ── sweep ────────────────────────────────────────────────────────────

    /// @dev Working state for one sweep. Held in a struct so the sweep loop stays
    ///      within the EVM's stack limit.
    struct Batch {
        Contribution[] c;
        address[] assets;
        uint256[] totals;
        uint256 nc;
        uint256 na;
        uint256 epoch;
    }

    /// @notice Sweep every eligible account in the batch. Keeper only.
    /// @dev Netted: each asset's USDG is summed across the batch and swapped ONCE,
    ///      then the output is split pro-rata to what each account contributed.
    ///      Any asset without a limit in `limits` is deferred, not bought.
    function sweep(address[] calldata accounts, Limit[] calldata limits)
        external
        onlyKeeper
        whenNotPaused
        nonReentrant
        returns (uint256 sweptCount)
    {
        uint256 n = accounts.length;
        if (n > MAX_BATCH) revert BatchTooLarge();
        uint256 cap = n * elections.MAX_LEGS();
        Batch memory b = Batch({
            c: new Contribution[](cap),
            assets: new address[](cap),
            totals: new uint256[](cap),
            nc: 0,
            na: 0,
            epoch: block.timestamp / epochLength + 1
        });

        for (uint256 i; i < n; ++i) {
            if (_collect(b, accounts[i])) ++sweptCount;
        }
        for (uint256 k; k < b.na; ++k) {
            _settleAsset(b.assets[k], b.totals[k], _limitOf(limits, b.assets[k]), b.c, b.nc);
        }
    }

    function _limitOf(Limit[] calldata limits, address asset) internal pure returns (uint256) {
        for (uint256 i; i < limits.length; ++i) {
            if (limits[i].asset == asset) return limits[i].minOutPerUsdg;
        }
        return 0;
    }

    /// @dev Withdraw one account's spare and split it across its mix. Returns
    ///      whether the account was swept.
    function _collect(Batch memory b, address a) internal returns (bool) {
        if (sweptEpoch[a] == b.epoch) return false;
        if (cashPark.valueOf(a) < threshold) return false;
        if (!screening.isEligible(a)) return false;
        ElectionRegistry.Leg[] memory mix = elections.mixOf(a);
        if (mix.length == 0) return false;

        (uint256 got,) = cashPark.withdrawForSweep(a);
        // Parked units that could not be redeemed right now stay parked; if what did
        // come out is under the threshold, put it back and try next epoch.
        if (got < threshold) {
            cashPark.returnFromSweep(a, got);
            return false;
        }
        sweptEpoch[a] = b.epoch;
        emit AccountSwept(a, b.epoch, got);

        uint256 left = got;
        for (uint256 l; l < mix.length; ++l) {
            uint256 amt = l == mix.length - 1 ? left : (got * mix[l].bps) / 10_000;
            left -= amt;
            _addLeg(b, a, mix[l].asset, amt);
        }
        return true;
    }

    function _addLeg(Batch memory b, address account, address asset, uint256 amt) internal pure {
        b.c[b.nc++] = Contribution(account, asset, amt);
        uint256 k;
        for (; k < b.na; ++k) {
            if (b.assets[k] == asset) break;
        }
        if (k == b.na) b.assets[b.na++] = asset;
        b.totals[k] += amt;
    }

    function _settleAsset(address asset, uint256 total, uint256 minOutPerUsdg, Contribution[] memory c, uint256 nc)
        internal
    {
        if (total == 0) return;

        // The only outcome that pays USDG out: the owner delisted the asset.
        if (!registry.isEligible(asset)) {
            _unwind(asset, c, nc, Settle.SAFE_SETTLE, OracleGuard.Status.OK, "asset suspended");
            return;
        }
        (OracleGuard.Status status, uint256 price) = router.oracleStatus(asset);
        if (status != OracleGuard.Status.OK) {
            _unwind(asset, c, nc, Settle.DEFER, status, "");
            return;
        }
        if (minOutPerUsdg == 0) {
            emit SwapDeferred(asset, total, "no keeper limit");
            _unwind(asset, c, nc, Settle.DEFER, OracleGuard.Status.OK, "");
            return;
        }

        uint256 fee = (total * feeBps) / 10_000;
        uint256 swapIn = total - fee;
        // Primary bound: the keeper's same-block quote. Backstop: the oracle.
        uint256 minOut = (swapIn * minOutPerUsdg) / 1e6;
        uint256 oracleMin = (router.oracleTokensFor(swapIn, price) * (10_000 - slippageBps)) / 10_000;
        if (oracleMin > minOut) minOut = oracleMin;

        try router.buy(asset, swapIn, minOut, address(this)) returns (uint256 out) {
            if (fee != 0) usdg.safeTransfer(address(feeVault), fee);
            _distribute(asset, out, total, c, nc);
            emit AssetSwept(asset, swapIn, fee, out);
        } catch (bytes memory reason) {
            // Slippage, the oracle band, a paused hook, a thin pool: all "not now".
            // The USDG goes back to the park; nobody can force a USDG payout.
            emit SwapDeferred(asset, total, reason);
            _unwind(asset, c, nc, Settle.DEFER, OracleGuard.Status.OK, "");
        }
    }

    /// @dev Pro-rata by gross contribution, so the fee is borne proportionally.
    ///      Floors every share; the dust goes to the last contributor.
    function _distribute(address asset, uint256 out, uint256 total, Contribution[] memory c, uint256 nc) internal {
        uint256 assigned;
        uint256 last = type(uint256).max;
        for (uint256 k; k < nc; ++k) {
            if (c[k].asset != asset) continue;
            uint256 share = (out * c[k].usdg) / total;
            assigned += share;
            last = k;
            _deliver(c[k].account, asset, share);
        }
        if (assigned < out && last != type(uint256).max) _deliver(c[last].account, asset, out - assigned);
    }

    function _unwind(
        address asset,
        Contribution[] memory c,
        uint256 nc,
        Settle mode,
        OracleGuard.Status status,
        string memory reason
    ) internal {
        for (uint256 k; k < nc; ++k) {
            if (c[k].asset != asset || c[k].usdg == 0) continue;
            if (mode == Settle.DEFER) {
                cashPark.returnFromSweep(c[k].account, c[k].usdg);
                emit Deferred(c[k].account, asset, c[k].usdg, status);
            } else {
                _deliver(c[k].account, address(usdg), c[k].usdg);
                emit SafeSettled(c[k].account, asset, c[k].usdg, reason);
            }
        }
    }

    /// @dev Push, and fall back to a claimable balance if the token refuses (a
    ///      blocklisted recipient must not be able to revert everyone else's sweep).
    function _deliver(address account, address token, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (account, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
            emit Delivered(account, token, amount);
        } else {
            claimable[account][token] += amount;
            emit DeliveryHeld(account, token, amount);
        }
    }

    /// @notice Collect a delivery that could not be pushed. Never gated by pause.
    /// @dev Always to the account itself: a recipient the token refuses must not
    ///      be able to route around the token's own blocklist.
    function claim(address token) external nonReentrant {
        uint256 amt = claimable[msg.sender][token];
        if (amt == 0) return;
        claimable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amt);
        emit Claimed(msg.sender, token, msg.sender, amt);
    }

    // ── views ────────────────────────────────────────────────────────────

    function currentEpoch() external view returns (uint256) {
        return block.timestamp / epochLength + 1;
    }

    /// @notice USDG pulled for `account` over the rolling 7 days ending today.
    function pulledLast7Days(address account) public view returns (uint256) {
        return _pulled7d(account, block.timestamp / 1 days);
    }

    function remainingWeeklyCap(address account) external view returns (uint256) {
        uint256 cap = rules.ruleOf(account).weeklyCap;
        uint256 used = pulledLast7Days(account);
        return used >= cap ? 0 : cap - used;
    }

    function _pulled7d(address account, uint256 today) internal view returns (uint256 sum) {
        mapping(uint256 => uint256) storage d = dayPulled[account];
        for (uint256 i; i < 7; ++i) {
            sum += d[today - i];
        }
    }
}
