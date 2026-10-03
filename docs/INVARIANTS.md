# SPARE — invariants

The properties that must hold after **any** sequence of calls, how they are checked, and
where. Ten stateful invariants (Foundry) cover the two contracts that hold or move user
money, `CashPark` and `SweepExecutor`, the second one wired to the real `StockRouter`.
Symbolic specs (Halmos) cover two libraries: `OracleGuard`, which every buy goes through,
and `RoundUp`. No deployed contract calls `RoundUp`: round-ups are computed off-chain by
the keeper and attested on-chain (`SECURITY.md`, accepted risks), so its proofs are no
on-chain guarantee. `RoundUp.sol` is the reference the keeper's copy is checked against
(`npm run prove` runs both on a fork for every payment). Design background:
[`SPARE-BUILD.md`](SPARE-BUILD.md) §3–§4.

## Run config

| Setting | Value | Where |
|---|---|---|
| Invariant runs × depth | `runs = 1600`, `depth = 64`: **102,400 handler calls per invariant** per `forge test` | [`contracts/foundry.toml`](../contracts/foundry.toml) `[invariant]` |
| Reverting handler calls | counted, not failures (`fail_on_revert` is off, the Foundry default); handlers bound their inputs so the system is driven, not fuzzed into reverts | `foundry.toml` (default) |
| Fuzz runs (property tests) | `runs = 512` | `foundry.toml` `[fuzz]` |
| CI | job `contracts` of `.github/workflows/ci.yml` runs this suite on every push and pull request, job `halmos` the specs below; the commands here run the same locally | `.github/workflows/ci.yml` |

```bash
cd contracts
forge test --match-path 'test/unit/*Invariant.t.sol'            # the 10 invariants
FOUNDRY_INVARIANT_RUNS=10000 forge test --match-path 'test/unit/*Invariant.t.sol'   # deeper, locally
```

Local runs at this config (2026-10-02): all 10 pass, 102,400 calls each. The CashPark suite
sees no reverting calls; the system suite a few dozen per invariant (deliberately impaired
oracles, fills and blocklists). The two suites run in parallel in under 1.5 minutes on top
of the build.

## CashPark

[`contracts/test/unit/CashParkInvariant.t.sol`](../contracts/test/unit/CashParkInvariant.t.sol),
contract `CashParkInvariantTest`. A real `CashPark` over `MockParkAdapter` at a non-integral
rate (3e12 / 7 units per USDG, so every rounding floor is exercised), four accounts. The
handler `CashParkHandler` credits, parks (keeper), withdraws for and returns from sweeps
(executor) and exits (users), while flipping NAV freshness, redeem failure, in-kind failure
(a paused issuer token) and the pause flag.

| Invariant | What it asserts | Test |
|---|---|---|
| Pending is fully booked | `totalPending() == Σ pending(account)` | `CashParkInvariant.t.sol::invariant_totalPendingIsSumOfPending` |
| Pending is fully backed | `USDG.balanceOf(CashPark) >= totalPending()` | `CashParkInvariant.t.sol::invariant_usdgBacksPending` |
| Units are conserved | `totalUnits() == Σ units(account)`, and the adapter's share balance equals `totalUnits()` (every unit is held by the adapter) | `CashParkInvariant.t.sol::invariant_unitsConserved` |
| Exit is never gated (law 5) | no `exit()` call has reverted, whatever the adapter state (stale NAV, redeem down, in-kind down) and whether paused | `CashParkInvariant.t.sol::invariant_exitNeverReverts` |
| The adapter is solvent | `USDG.balanceOf(adapter) >= adapter.valueOf(totalUnits())` | `CashParkInvariant.t.sol::invariant_adapterSolvent` |

## The system: SweepExecutor, CashPark and the real StockRouter

[`contracts/test/unit/SweepInvariant.t.sol`](../contracts/test/unit/SweepInvariant.t.sol),
contract `SweepInvariantTest`. Real `SweepExecutor`, `CashPark` (identity USDG adapter),
`AssetRegistry`, `ElectionRegistry` and `StockRouter` over a `MockPoolManager` venue; four
accounts with a $1 × 1 rule and a $1,000 cap, on the default 60/40 mix, all-QQQ and a
3-leg mix. The handler `SweepHandler` accrues (keeper, within each account's remaining
cap), parks, sweeps (keeper; limits oracle-derived, missing or 10 bp tight; half the time
in a fresh epoch), exits and claims, while flipping every outcome lever: stale feeds
(defer), oracle pauses (defer), deactivation (safe-settle), fills from 1.6% worse to 1%
better than the oracle, partial fills (defer), recipient blocklists (held as claimable) and
time.

| Invariant | What it asserts | Test |
|---|---|---|
| Park pending accounting | `CashPark.totalPending() == Σ pending(account)` and the park's USDG balance covers it | `SweepInvariant.t.sol::invariant_parkPendingAccounting` |
| Park units accounting | `totalUnits() == Σ units(account)`; the identity adapter holds exactly `totalUnits()` USDG (1 unit = 1 USDG) | `SweepInvariant.t.sol::invariant_parkUnitsAccounting` |
| No residue in the executor | for USDG, SPY, NVDA and QQQ: `balanceOf(SweepExecutor) == Σ claimable(account, token)`; after any sequence of sweeps the executor holds only what it owes | `SweepInvariant.t.sol::invariant_executorHoldsOnlyClaimables` |
| The router holds nothing | `StockRouter` has a zero balance of USDG, SPY, NVDA and QQQ | `SweepInvariant.t.sol::invariant_routerHoldsNothing` |
| No USDG leaks | park + adapter + executor + `FeeVault` + venue + router + the four accounts `== USDG.totalSupply()`: no USDG reaches any other address, and claims only ever pay the account itself | `SweepInvariant.t.sol::invariant_usdgFullyAccounted` |

## What the invariants do not cover

- **Live venues and feeds.** The handlers run on mocks. Real pools, feeds and stock tokens
  are exercised by the fork suites (`contracts/test/fork/*`, opt-in, not in CI because
  they need an RPC and a recent block).
- **Owner powers.** The handlers use the owner only to pause, unpause and deactivate an
  asset. What the owner can do with its other setters is listed, with bounds, in
  [`ROLES.md`](ROLES.md); moving it behind a timelock is [`GOVERNANCE.md`](GOVERNANCE.md).
- **An inflated keeper amount.** The handler accrues within each account's remaining cap;
  the cap itself is a contract check, fuzzed separately in
  `SweepExecutorAccrue.t.sol::testFuzz_accrue_neverExceedsCapInTheWindow`.

## Symbolic properties (Halmos)

`contracts/halmos/` is a separate Foundry root (no via-IR) holding specs that hold for
**every** input, not a sample: 16 checks, 5 in
[`halmos/specs/RoundUp.spec.sol`](../contracts/halmos/specs/RoundUp.spec.sol) and 11 in
[`halmos/specs/OracleGuard.spec.sol`](../contracts/halmos/specs/OracleGuard.spec.sol). Run
from `contracts/`: `halmos --root halmos` (halmos 0.3.3 with yices; `halmos/halmos.toml`
gives each solver query 300 s). The last full run, 16 passed and 0 failed, with each
check's paths and time: [`contracts/halmos/RESULTS.md`](../contracts/halmos/RESULTS.md).

| Property | What it proves | Spec |
|---|---|---|
| Round-up math, $1 / $5 / $10 | for every uint256 payment and every multiplier 1–5: the delta is `< roundTo × multiplier` dollars, zero exactly on the boundary, a whole multiple of the multiplier, and the 1× round-up lands the payment on the next boundary | `RoundUp.spec.sol::check_roundTo1`, `check_roundTo5`, `check_roundTo10` |
| Bad rules always revert | any `roundTo` outside {1, 5, 10} reverts with `BadRoundTo`; any multiplier outside 1–5 reverts with `BadMultiplier`, even at amount 0 | `RoundUp.spec.sol::check_badRoundToAlwaysReverts`, `check_badMultiplierAlwaysReverts` |
| Never OK on a bad price | stale, future-dated, non-positive or unreadable answers and a paused token are never `OK` and return price 0 | `OracleGuard.spec.sol::check_staleIsNeverOk`, `check_futureUpdatedAtIsNeverOk`, `check_nonPositiveAnswerIsNeverOk`, `check_unreadableFeedIsNeverOk`, `check_pausedTokenIsNeverOk` |
| Sequencer guard | a sequencer that is down, unreadable, uninitialised, future-dated or inside the restart grace always yields `SEQUENCER_DOWN` | `OracleGuard.spec.sol::check_sequencerNotSafelyUpIsAlwaysDown`, `check_futureSequencerStartedAtIsNeverOk` |
| OK means every guard passed | `OK` if and only if every guard passes, and then the price is the 8-decimal answer scaled to 1e18 | `OracleGuard.spec.sol::check_okIffEveryGuardPasses` |
| Never reverts up to the scaling bound | `check()` returns a status, never a revert, for every answer up to `type(uint256).max / 1e10` (a Chainlink aggregator reports an int192, far below), so a feed cannot brick a sweep. Proved in three parts: the only revert possible is the 8 → 18 dp scaling overflow (`Panic(0x11)`), and only once every guard has passed; the scaling fits at the bound; one unit above it, the call reverts only when every guard passes and otherwise returns its non-OK status | `OracleGuard.spec.sol::check_neverRevertsExceptScalingOverflow`, `check_neverRevertsUpToTheScalingBound`, `check_oneAboveTheScalingBoundRevertsOnlyWhenOk` |
