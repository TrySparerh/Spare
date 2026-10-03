// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SpareAuth} from "./SpareAuth.sol";
import {IParkAdapter} from "./interfaces/IParkAdapter.sol";

/// @title CashPark
/// @notice Holds each account's spare change between accrual and sweep, and parks
///         it in a yield adapter while it waits.
/// @dev Two balances per account:
///        pending — accrued USDG not yet parked (held here as plain USDG)
///        units   — parked units in the adapter
///      Accrual always lands in `pending`. The keeper's `park()` moves pending into
///      the adapter in one netted batch, and only while the adapter reports fresh
///      NAV (spec law 4, "stale NAV -> hold accrual"). Parking $0.25 at a time would
///      mean a swap per payment; batching is the whole point of park-scheduler.
///
///      Exit is never gated (law 5): `exit()` ignores `paused`, and if the adapter
///      cannot redeem to USDG right now, the user receives the underlying in kind.
contract CashPark is SpareAuth, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    IParkAdapter public adapter;
    /// @notice The only contract allowed to credit accruals and withdraw for sweeps.
    address public executor;

    mapping(address account => uint256) public pending;
    mapping(address account => uint256) public units;
    uint256 public totalPending;
    uint256 public totalUnits;

    event ExecutorSet(address indexed executor);
    event AdapterSet(address indexed adapter);
    event Credited(address indexed account, uint256 amount);
    event Parked(uint256 usdgIn, uint256 unitsOut, uint256 accounts);
    event WithdrawnForSweep(address indexed account, uint256 usdgOut, uint256 unitsLeft);
    event Returned(address indexed account, uint256 amount);
    event Exited(address indexed account, uint256 usdgOut, uint256 unitsInKind);
    event ExitUnitsKept(address indexed account, uint256 units);

    error NotExecutor();
    error AdapterInUse();

    constructor(address owner_, IERC20 usdg_) SpareAuth(owner_) {
        usdg = usdg_;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    function setExecutor(address executor_) external onlyOwner {
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    /// @notice Swap adapters. Only allowed with no open parked position — a live
    ///         migration would strand units in the old adapter.
    function setAdapter(IParkAdapter adapter_) external onlyOwner {
        if (totalUnits != 0) revert AdapterInUse();
        adapter = adapter_;
        emit AdapterSet(address(adapter_));
    }

    // ── executor ──────────────────────────────────────────────────────────

    /// @notice Record an accrual. Pulls the USDG from the executor.
    function credit(address account, uint256 amount) external onlyExecutor nonReentrant {
        if (amount == 0) return;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        pending[account] += amount;
        totalPending += amount;
        emit Credited(account, amount);
    }

    /// @notice Hand everything an account holds to the executor as USDG for a sweep.
    /// @dev Never blocks a sweep: if the adapter cannot redeem right now (e.g. SGOV
    ///      outside market hours), the parked units stay parked and only the
    ///      pending USDG moves. `unitsLeft` tells the executor what was held back.
    function withdrawForSweep(address account)
        external
        onlyExecutor
        nonReentrant
        returns (uint256 usdgOut, uint256 unitsLeft)
    {
        uint256 p = pending[account];
        if (p != 0) {
            pending[account] = 0;
            totalPending -= p;
            usdg.safeTransfer(msg.sender, p);
            usdgOut = p;
        }
        uint256 u = units[account];
        if (u != 0) {
            try adapter.redeem(u, msg.sender) returns (uint256 got) {
                units[account] = 0;
                totalUnits -= u;
                usdgOut += got;
            } catch {
                unitsLeft = u;
            }
        }
        emit WithdrawnForSweep(account, usdgOut, unitsLeft);
    }

    /// @notice Put USDG back (a deferred leg) — it rejoins the account's pending.
    function returnFromSweep(address account, uint256 amount) external onlyExecutor nonReentrant {
        if (amount == 0) return;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        pending[account] += amount;
        totalPending += amount;
        emit Returned(account, amount);
    }

    // ── keeper ────────────────────────────────────────────────────────────

    /// @notice Move pending USDG into the adapter for a batch of accounts, in one
    ///         deposit, then split the units pro-rata. No-op while NAV is stale.
    function park(address[] calldata accounts) external onlyKeeper whenNotPaused nonReentrant {
        if (!adapter.isFresh()) return;

        uint256 n = accounts.length;
        uint256[] memory amt = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 p = pending[accounts[i]];
            // A duplicated address in the batch must not be counted twice.
            if (p == 0) continue;
            amt[i] = p;
            pending[accounts[i]] = 0;
            total += p;
        }
        if (total == 0) return;
        totalPending -= total;

        usdg.safeTransfer(address(adapter), total);
        uint256 out = adapter.deposit(total);
        totalUnits += out;

        // Floor every share, then give the dust to the last recipient so no unit is
        // ever left unowned.
        uint256 assigned;
        uint256 last = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            if (amt[i] == 0) continue;
            uint256 share = (out * amt[i]) / total;
            units[accounts[i]] += share;
            assigned += share;
            last = i;
        }
        if (assigned < out) units[accounts[last]] += out - assigned;
        emit Parked(total, out, n);
    }

    // ── user ──────────────────────────────────────────────────────────────

    /// @notice Withdraw everything you hold. Deliberately NOT `whenNotPaused`.
    /// @dev Pending USDG is paid FIRST and unconditionally — it is plain USDG held
    ///      here and nothing about the adapter can trap it. Parked units are then
    ///      redeemed to USDG, or handed over in kind (e.g. SGOV itself). If even
    ///      the in-kind path fails (the token is paused), the units stay booked to
    ///      the account and `unitsKept` says so; call `exit` again later.
    function exit() external nonReentrant returns (uint256 usdgOut, uint256 unitsInKind) {
        address account = msg.sender;
        uint256 p = pending[account];
        if (p != 0) {
            pending[account] = 0;
            totalPending -= p;
            usdg.safeTransfer(account, p);
            usdgOut = p;
        }

        uint256 u = units[account];
        uint256 kept;
        if (u != 0) {
            units[account] = 0;
            totalUnits -= u;
            try adapter.redeem(u, account) returns (uint256 got) {
                usdgOut += got;
            } catch {
                try adapter.exitInKind(u, account) {
                    unitsInKind = u;
                } catch {
                    units[account] = u;
                    totalUnits += u;
                    kept = u;
                }
            }
        }
        emit Exited(account, usdgOut, unitsInKind);
        if (kept != 0) emit ExitUnitsKept(account, kept);
    }

    // ── views ─────────────────────────────────────────────────────────────

    /// @notice Current value of everything an account holds, in USDG.
    function valueOf(address account) public view returns (uint256) {
        uint256 u = units[account];
        return pending[account] + (u == 0 ? 0 : adapter.valueOf(u));
    }

    function isFresh() external view returns (bool) {
        return adapter.isFresh();
    }
}
