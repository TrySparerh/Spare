# Mutation testing — results

| Contract | Mutants | Killed | Survived | Score |
|---|---:|---:|---:|---:|
| SweepExecutor | 357 | 354 | 3 (191, 199, 289) | 99.2% |
| CashPark | 152 | 150 | 2 (53, 101) | 98.7% |
| StockRouter | 120 | 120 | 0 | 100% |
| **Total** | **629** | **624** | **5** | **99.2%** |

No mutant timed out and none failed to compile.

## Run

- Source: the pre-release tree; the git blob ids in `run-info.txt` match this repository's files.
- Gambit 0.2.1 (`072ff4c6`), forge 1.5.1, solc 0.8.26.
- via-IR and the optimizer off for the mutant builds (production builds with via-IR at 200 runs; kill/survive semantics are unaffected).
- Fuzz 512 runs, seed `0x5ba4e`; invariants 128 runs × depth 64.
- Finished 2026-10-02 22:06 UTC.
- Per-mutant outcomes: `SweepExecutor.csv`, `CashPark.csv`, `StockRouter.csv` in this directory (mutant id, operator, file:line, original, mutated, killed/survived, first failing test).

## Survivors

All five are equivalent mutants: no input can tell them apart from the original. The argument for each one is in [`contracts/README.md` — Mutation testing](../../README.md#mutation-testing). SweepExecutor 199's equivalence relies on invariants enforced elsewhere (`setParams` keeps `threshold >= 1e6`, `ElectionRegistry` rejects zero legs), both pinned by existing tests.

## Reproduce

```bash
contracts/mutation/run-mutants.sh
```

It mutates a scratch copy of `contracts/` outside the repository (`MUT_WORK`, default `$TMPDIR`), runs `forge test --fail-fast` per mutant, and rewrites the CSVs here. About 25 minutes on an 8-core machine.
