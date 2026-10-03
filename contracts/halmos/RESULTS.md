# Halmos results

The symbolic specs in [`specs/`](specs/) (what each check proves: [`../README.md`](../README.md#symbolic-checks-halmos)), run in full.

| | |
|---|---|
| Result | **16 passed, 0 failed**: OracleGuardSpec 11/11, RoundUpSpec 5/5 |
| Date | 2026-10-02, 20:21:00Z to 20:23:00Z UTC (wall 1 m 59 s) |
| Source | [pre-release commit, not in the public history]; its `contracts/src`, `contracts/halmos/specs`, `halmos.toml` and `contracts/lib` are the same as in this release |
| Command | `halmos --root halmos`, from `contracts/` |
| halmos | 0.3.3 (PyPI), Python 3.11.9, in a fresh venv: `python -m venv .venv && .venv/Scripts/pip install halmos==0.3.3` |
| Solver | yices 2.6.4 (`yices-smt2` from the `yices-solver` 2.6.4.post23 wheel; halmos's default `yices`) |
| Settings | [`halmos.toml`](halmos.toml): `solver-timeout-assertion = "300s"`; [`foundry.toml`](foundry.toml): solc 0.8.26, cancun, no via-IR |
| Build | forge 1.5.1-stable; build cache current for the specs at that source |
| Machine | Windows 11, 64 hardware threads |

## OracleGuardSpec (`specs/OracleGuard.spec.sol`), 11 checks, 5.83 s

| Check | Paths | Time |
|---|---|---|
| `check_futureSequencerStartedAtIsNeverOk` | 8 | 0.10 s |
| `check_futureUpdatedAtIsNeverOk` | 22 | 0.30 s |
| `check_neverRevertsExceptScalingOverflow` | 29 | 0.84 s |
| `check_neverRevertsUpToTheScalingBound` | 28 | 1.00 s |
| `check_nonPositiveAnswerIsNeverOk` | 20 | 0.29 s |
| `check_okIffEveryGuardPasses` | 32 | 1.01 s |
| `check_oneAboveTheScalingBoundRevertsOnlyWhenOk` | 25 | 0.84 s |
| `check_pausedTokenIsNeverOk` | 22 | 0.35 s |
| `check_sequencerNotSafelyUpIsAlwaysDown` | 11 | 0.35 s |
| `check_staleIsNeverOk` | 25 | 0.44 s |
| `check_unreadableFeedIsNeverOk` | 18 | 0.24 s |

## RoundUpSpec (`specs/RoundUp.spec.sol`), 5 checks, 108.78 s

| Check | Paths | Time |
|---|---|---|
| `check_badMultiplierAlwaysReverts` | 3 | 0.04 s |
| `check_badRoundToAlwaysReverts` | 3 | 0.05 s |
| `check_roundTo1` | 16 | 37.97 s |
| `check_roundTo10` | 16 | 35.04 s |
| `check_roundTo5` | 15 | 35.66 s |

Every line reads `bounds: []`: no loop hit halmos's unrolling bound. The `roundTo` checks are the slow ones, about 36 s each against the 300 s assertion timeout.

The forge-lint `mixed-case-function` notes halmos prints while building (`check_*` is the naming halmos requires) are left out above.
