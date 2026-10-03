# Spare contracts

Foundry project for the ten contracts live on Robinhood Chain mainnet (chain 4663): AssetRegistry, RuleRegistry, ElectionRegistry, ScreeningGate, StockRouter, CashPark, FeeVault, SweepExecutor, UsdgParkAdapter (live park) and SgovParkAdapter (standby). They are immutable — no proxies. Addresses: [`addresses/4663.json`](addresses/4663.json). Design and the internal security review: [`../docs/SPARE-BUILD.md`](../docs/SPARE-BUILD.md).

The NatSpec in `src/` is part of the Sourcify-verified source, so it is not edited after
deployment. [Reading the NatSpec](#reading-the-natspec) lists the comments that describe the
state at launch rather than today.

## Reading the NatSpec

The comments in `src/` cite the build spec, [`../docs/SPARE-BUILD.md`](../docs/SPARE-BUILD.md):
"spec law N" is a design law in its laws table, "acceptance (N)" an acceptance test in its §6,
"build spec §N" one of its sections, and "review HIGH" / "review fix" a finding of the
pre-launch review in its §7. These comments describe launch-time state or plans, and this is
what holds today:

| Where | The comment says | Today |
|---|---|---|
| `SweepExecutor`, accrual trust model | the pull is capped by the weekly cap and, independently, by the Permit2 allowance, so a compromised keeper can pull at most what the user authorised | The app asks for a Permit2 allowance with no amount limit, so the weekly cap is the bound in practice. The cap is the account's: a wallet linked to another account is charged under that account's rule. The amount itself is keeper-attested (`SPARE-BUILD.md` §3.1). |
| `SweepExecutor._accrue` | two adjacent calendar buckets can never add up to twice the cap | Two pulls 6 days and 1 second apart can: accepted risk A-L1 in [`../SECURITY.md`](../SECURITY.md). |
| `CashPark` | batching parks is "the whole point of park-scheduler" | `park-scheduler` is a planned engine worker that does not exist, and the keeper never calls `park`. On the live USDG adapter accrued USDG stays in `pending`, which costs nothing (`SPARE-BUILD.md` §3.6). |
| `StockRouter._swap` | on a partial fill the caller "safe-settles the leg instead" | `SweepExecutor` defers the leg on any swap revert; only a deactivated asset is safe-settled (`SPARE-BUILD.md` §3.4). |
| `StockRouter` header | a $5 buy fills within 0.25% of Chainlink for SPY, QQQ, NVDA, AAPL, TSLA and SGOV | The launch measurement. QQQ is now on standby, and several active assets trade through 0.5–1% fee pools; the pins in use are in `config/4663.json`. |
| `ScreeningGate` | "on in production" | Enforcement is off on mainnet (`enforced() == false`), so there is no on-chain eligibility check. |
| `ScreeningGate` | the spec lists ScreeningGate among "reused" privacy-core contracts and none was found | S2 was planned around existing privacy contracts; none is deployed on Robinhood Chain, so this is Spare's own minimal gate (`SPARE-BUILD.md` §2). |
| `SpareAuth` | the owner "should be a multisig at deploy" | The owner of all 7 owned contracts is one EOA; the hand-over to a Safe and a timelock is [`../docs/GOVERNANCE.md`](../docs/GOVERNANCE.md). |
| `RoundUp` | the frontend's and the engine observer's copies, "all three", compute the same number | There are four copies (this library, the keeper's, spare-api's and the site's), and no deployed contract calls `RoundUp`: it is the reference the other copies are tested against (`SPARE-BUILD.md` §3.3). |
| `L2Clock` | "the engine's observer indexes by L2 block" | The keeper scans payments and computes its finality window by L2 block; the observer is a planned worker. |
| `FeeVault` | "S3 routes this to buyback and stakers" | Planned. No `$SPARE` token exists; fees stay in `FeeVault` until the owner withdraws them. |

## Build from a clone

```bash
git clone --recurse-submodules https://github.com/TrySparerh/Spare.git spare
cd spare/contracts
forge build          # Foundry 1.5.1, solc 0.8.26, via-IR, optimizer 200 runs
```

In a checkout made without `--recurse-submodules`, run `git submodule update --init --recursive` from the repository root.

The libraries are git submodules pinned to the exact upstream commits the live contracts were built from:

| Path | Upstream | Commit |
|---|---|---|
| `lib/forge-std` | foundry-rs/forge-std | `37a36ca3` (v1.16.2 + 6, 2026-08-07) |
| `lib/v4-core` | Uniswap/v4-core | `46c68346` |
| `lib/v4-periphery` | Uniswap/v4-periphery | `545a5d2a` |

`foundry.toml` remaps to one copy of each dependency: OpenZeppelin (`dbb6104c`) and solmate (`4b47a190`) from inside v4-core, permit2 (`cc56ad0f`) from inside v4-periphery. Nothing deeper is compiled.

**Windows:** Uniswap's own submodules nest four or five levels deep (OpenZeppelin → forge-std → ds-test …). Under a long checkout path git stops with `'$GIT_DIR' too big` on the deepest, test-only levels, and `core.longpaths` does not help. Clone to a short path, or initialise only the two levels the build uses:

```bash
git submodule update --init
git -C contracts/lib/v4-core submodule update --init lib/openzeppelin-contracts lib/solmate
git -C contracts/lib/v4-periphery submodule update --init lib/permit2
```

**Same bytecode as mainnet.** A clean clone (CRLF checkout, every submodule fetched fresh) builds a `forge inspect <Contract> deployedBytecode` identical, by sha256, to the working tree's for all ten contracts. Each one also matches `cast code <address>` on chain 4663 byte for byte once the immutable ranges (`deployedBytecode.immutableReferences` in `out/<Contract>.sol/<Contract>.json`) are zeroed. Checked on 2026-10-02.

## Test

```bash
forge test --no-match-path 'test/fork/*'                       # unit, invariant, the audit PoCs that need no fork
RHC_RPC_URL=<rpc> forge test --match-path 'test/fork/*'          # against a mainnet fork
AUDIT_FORK_BLOCK=<recent block> RHC_RPC_URL=<rpc> forge test --match-path 'test/audit/*'
forge coverage --ir-minimum --report summary --no-match-path 'test/fork/*' --no-match-coverage 'test/|script/'
```

- `test/unit/` — every contract over mocks (`test/mocks/`), including the REAL StockRouter over a v4-shaped `MockPoolManager` (fixed-rate or constant-product pools).
- `test/unit/*Invariant.t.sol` — 10 invariants on CashPark and SweepExecutor, at 1600 runs × depth 64 = 102,400 calls each (`[invariant]` in `foundry.toml`). They take `forge test` from ~4 s to ~50 s on a 64-thread machine; budget ~3 min on a 2-vCPU CI runner.
- `test/audit/` — proofs of concept from the internal review and the audit. All nine suites need a recent fork block (`AUDIT_FORK_BLOCK`; the public RPC is not an archive node) and skip without one, so CI and a plain `forge test` do not run them; the audit PoCs that need no fork (`WeeklyCapBuckets`, `NettedWhale`, `SgovChurn`) are in `test/unit/`.
- `test/fork/` — acceptance tests on a pinned mainnet fork (`RHC_RPC_URL`).
- `test/script/` — the ops scripts against the real contracts and an in-memory config: `AddAssets`, `AcceptOwnership` and `TimelockBatch` before and after the timelock hand-over (`GovernanceOps.t.sol`), and the asset rules and governance-policy section that `Deploy`, `AddAssets` and `VerifyDeployment` share, plus the hook pins in the committed `config/4663.json` (`AssetRules.t.sol`).
- Coverage needs `--ir-minimum`: `script/lib/SpareBase.sol` is too deep for the legacy pipeline.

### Accepted behaviour, pinned by tests

These are known, accepted properties of the deployed contracts (AI-assisted audit, 2026-10-02: [`docs/audits/`](../docs/audits/)). The tests fail if the behaviour changes, in either direction.

| Finding | Test | What it pins |
|---|---|---|
| A-M1 netted whale | `test/unit/NettedWhale.t.sol` | One account's large leg sets the single netted swap for every account batched with it: inside the 150 bps oracle bound, every co-batched account fills at the whale's average price (~98 bps worse for a $10 leg next to $5,000). Past the bound, the whole leg defers every epoch, at no cost to the whale. Each account is marked swept before its legs run, so a deferred account cannot be retried that epoch. The keeper has to route around this. Put the large account in its own batch and sweep it **last**, or in a later block: swept first, its price impact is still in the pool for the next batch. |
| A-L1 weekly cap | `test/unit/WeeklyCapBuckets.t.sol` | The "rolling 7 days" is 7 UTC-day buckets. 2× weeklyCap can be pulled within 6 days and 1 second, and never more than 2× in any 168 hours (fuzzed). The pull is keeper-only, stays inside the Permit2 allowance and lands in the user's own park. |
| A-L2 SGOV churn | `test/unit/SgovChurn.t.sol` | On the standby SGOV adapter, a keeper can `park` then `sweep` with no limits and cost the user ~1.89% an epoch ($1,000 → $826.21 over 10 epochs), with every fill inside its bounds. On the live UsdgParkAdapter the same churn costs nothing. Before enabling SGOV, add a keeper minOut on unpark and a holding period, and narrow the band. |

## Symbolic checks (Halmos)

`halmos/` is a separate Foundry root with symbolic specs for two libraries: `RoundUp`, the round-up reference the keeper's copy is tested against (no deployed contract calls it, so these proofs are not an on-chain guarantee), and `OracleGuard`, which every buy goes through:

- **RoundUp** (5 checks): for every uint256 payment and multiplier 1..5, at each boundary ($1, $5, $10; `check_roundTo1`, `check_roundTo5`, `check_roundTo10`):
  - the delta is below roundTo × multiplier dollars;
  - it is zero exactly on the boundary;
  - it is a multiple of the multiplier;
  - it lands the payment on the next boundary.
  
  Any other roundTo or multiplier always reverts (`check_badRoundToAlwaysReverts`, `check_badMultiplierAlwaysReverts`).
- **OracleGuard** (11 checks): each of these is never OK, whatever the other inputs (7 checks):
  - a stale price (`check_staleIsNeverOk`);
  - a future `updatedAt` (`check_futureUpdatedAtIsNeverOk`);
  - a non-positive answer (`check_nonPositiveAnswerIsNeverOk`);
  - an unreadable feed (`check_unreadableFeedIsNeverOk`);
  - a paused token (`check_pausedTokenIsNeverOk`);
  - a sequencer that is down, unreadable, uninitialised or inside its restart grace (`check_sequencerNotSafelyUpIsAlwaysDown`), or has a future `startedAt` (`check_futureSequencerStartedAtIsNeverOk`).

  OK is returned **if and only if** every guard passes, and the price is then exactly the answer scaled to 1e18 (`check_okIffEveryGuardPasses`).

  Never reverts up to the scaling bound (3 checks): the only revert `check()` can raise is the 8 → 18 dp scaling overflow, and only once every guard has passed (`check_neverRevertsExceptScalingOverflow`); the scaling fits at the largest answer it can carry, `type(uint256).max / 1e10`, far above any int192 a Chainlink aggregator reports (`check_neverRevertsUpToTheScalingBound`); one unit above it, only a world whose guards all pass reverts (`check_oneAboveTheScalingBoundRevertsOnlyWhenOk`). So `check()` returns a status, never a revert, for every answer up to the bound. Other feed decimals are fuzzed in `test/unit/OracleGuard.t.sol`.

```bash
python -m venv .venv && .venv/bin/pip install halmos==0.3.3   # on Windows: .venv\Scripts\pip
halmos --root halmos                                          # from contracts/: 16 checks, ~2 min
```

16/16 pass with halmos 0.3.3 and yices 2.6.4: per-check paths and times, the source and the machine are in [`halmos/RESULTS.md`](halmos/RESULTS.md).

## Mutation testing (Gambit)

[Certora Gambit](https://github.com/Certora/gambit) mutates the three contracts that hold or move value. Each mutant runs against the offline suite: `test/unit`, which has 328 unit, fuzz and invariant tests over `test/mocks`. A mutant is killed when a test fails. Everything needed to check or repeat the run is in [`mutation/`](mutation/):

| File | Contents |
|---|---|
| [`gambit.conf.json`](mutation/gambit.conf.json) | The three source files, solc 0.8.26 (cancun), the `foundry.toml` remappings, and all ten Gambit operators. |
| [`run-mutants.sh`](mutation/run-mutants.sh) | The runner. It copies `contracts/` to a scratch directory, generates the mutants, runs `forge test --fail-fast` once per mutant in parallel workspaces, and writes the results. |
| [`results/<Contract>.csv`](mutation/results/) | One row per mutant: Gambit's id, operator, `file:line:column`, original, mutated, status, and the first test that failed. |
| [`results/SUMMARY.md`](mutation/results/SUMMARY.md) | Scores per contract, the five surviving (equivalent) mutants, run settings and how to reproduce. |
| [`results/run-info.txt`](mutation/results/run-info.txt) | The run's source (the git blob ids of the mutated sources, the config and the runner, which match this repository's files), tool versions and settings. |

| Contract | Mutants | Killed | Survived | Score |
|---|---|---|---|---|
| SweepExecutor | 357 | 354 | 3 | 99.2% |
| CashPark | 152 | 150 | 2 | 98.7% |
| StockRouter | 120 | 120 | 0 | 100% |

**The run (2026-10-02):**
- Source: the pre-release tree; the git blob ids in `results/run-info.txt` match this repository's `src/` files, config and runner.
- Gambit 0.2.1 (`072ff4c6`), solc 0.8.26, forge 1.5.1.
- via-IR and the optimizer off, so each mutant compiles in seconds.
- Fuzz: 512 runs, seed `0x5ba4e`. Invariants: 128 runs × depth 64.
- No mutant timed out and none failed to compile.
- Three full runs and a SweepExecutor-only run gave the same status for every mutant. The test named first can differ between runs, because suites run in parallel: the last two full runs named the same test for 574 of 629 mutants.
- Gambit produced no mutants for 4 operators:
  - elim-delegate: the contracts have no `delegatecall`;
  - require: the contracts use no `require`, only custom errors;
  - function-call and swap-arguments-function: Gambit 0.2.1 does not implement them.

Some test directories do not run per mutant:
- `test/audit` and `test/fork` need an RPC.
- `test/script` covers the ops scripts, which compile only under via-IR.

**The 5 survivors are equivalent.** Each replaces an `if` condition with a constant, and none can change state, events, return values or reverts:
- **SweepExecutor 191** (`:334`, `k == b.na` → `true`):
  - `_addLeg` now appends a duplicate asset slot for every repeated leg.
  - The search above still stops at the first match, so the duplicate slots keep a total of 0.
  - `_settleAsset` returns on its first line for a zero total, before any call, transfer or event.
  - `b.na` stays ≤ `b.nc` ≤ `n × MAX_LEGS`, the array length.
- **SweepExecutor 199** (`:341`, `total == 0` → `false`): the branch is unreachable, because no leg is ever zero.
  - An account is split only when `got ≥ threshold`, and `setParams` keeps `threshold ≥ 1_000_000`.
  - `ElectionRegistry` rejects 0 bps legs (`ZeroLeg`), so every leg but the last is ≥ 100 base units.
  - The last leg gets the remainder, which is at least its own unfloored share.
  - `test_setParams_validation` and `test_setMix_zeroLegReverts` pin both rules.
- **SweepExecutor 289** (`:390`, `assigned < out && last != max` → `true`):
  - An asset enters `b.assets` only together with a contribution, so `last` is always set.
  - The floored shares sum to at most `out`.
  - When they equal `out`, the mutant calls `_deliver(…, 0)`, which returns before any transfer or event.
- **CashPark 101** (`:156`, `assigned < out` → `true`):
  - `park` has already returned when `total == 0`, so `last` is set.
  - The mutant adds `out - assigned = 0` to a balance, which leaves it unchanged.
- **CashPark 53** (`:133`, `p == 0` → `false`):
  - For an account with nothing pending (including a repeated address), the loop body writes 0 over 0 and adds 0 to `total`.
  - The distribution loop skips `amt[i] == 0` either way.

**An earlier pass of the same 629 mutants left 31 survivors.** That pass used the suite of the time, with invariants at 32 × 32. 26 of those survivors led to the tests that now kill them, for example SweepExecutor 79 → `test_accrue_zeroAmountNeverTouchesPermit2` and CashPark 113/124/146 → `test_exit_touchesOnlyWhatIsHeld`. The new tests cover:
- zero-amount paths: they must not touch Permit2, the adapter or the fee vault, and must not emit events;
- every share flooring to zero;
- `setCaller` revoking;
- a full batch of full mixes;
- an account with no mix at all.

`MockPoolManager` also now enforces v4's `sqrtPriceLimitX96` bounds. That change kills StockRouter 101–105 and 107–111.

To reproduce, from the repository root. Generating and validating the mutants took 13 to 16 min; running them took about 10 min on 64 threads:

```bash
cargo install --locked --git https://github.com/Certora/gambit --rev 072ff4c6d747397f859e0a15a20fe1ff05672332
contracts/mutation/run-mutants.sh          # or one contract: contracts/mutation/run-mutants.sh CashPark
```

The runner never modifies the checkout:
- It works in `MUT_WORK` (default `$TMPDIR/spare-mutation`).
- It stops if the unmutated suite fails.
- It rewrites `mutation/results/`.
- `--resume` continues an interrupted run.

## Deploy and verify

The scripts read `config/<chain id>.json` and write `addresses/<chain id>.json`. Run them through the wrapper, which loads the config and skips building tests:

```bash
scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"                  # read-only, from the repo root
SPARE_REHEARSAL=true scripts/spare-forge.sh Deploy --fork-url "$RHC_RPC_URL"      # dry run on a fork
```

- `Deploy.s.sol` broadcasts nothing without `--broadcast`.
- On chain 4663 it also refuses to broadcast without `SPARE_MAINNET_ACK=owner-approved`, and it checks every external address, pool key and role first.
- `Deploy.s.sol` and `AddAssets.s.sol` refuse, and `VerifyDeployment.s.sol` fails, on an asset the registry would accept but Spare should not: token `decimals()` other than 18, a heartbeat over 26 h, or a hooked pool whose hook has a `*_RETURNS_DELTA` permission, whose runtime codehash or `authority()` differs from the config's `hookCodehash` / `hookAuthority` (the codehash is required), or whose `hookMaxFeePips` is not below the asset's band.
- `VerifyDeployment.s.sol` re-checks every wire, immutable, registry entry and ownership state, and sends nothing even with `--broadcast`. Its governance-policy section warns while an owner is not a `TimelockController` with `minDelay` ≥ 48 h (an EOA today, see [`../docs/GOVERNANCE.md`](../docs/GOVERNANCE.md)); `SPARE_REQUIRE_TIMELOCK=true` makes that a failure. The latest mainnet run: [`deployments/4663-verify-2026-10-03.txt`](deployments/4663-verify-2026-10-03.txt).
- `AcceptOwnership.s.sol` prints the `acceptOwnership()` batch for the owner.
