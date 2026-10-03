#!/usr/bin/env bash
# Mutation testing (Certora Gambit) of the three contracts that hold or move value:
# SweepExecutor, CashPark and StockRouter.
#
#   contracts/mutation/run-mutants.sh [--resume] [Contract ...]
#
# 1. Copies contracts/ (src, test/unit, test/mocks, lib, foundry.toml) into a scratch
#    directory. The checkout itself is never modified.
# 2. Generates every mutant listed by gambit.conf.json. Gambit drops mutants that do
#    not compile.
# 3. Runs the offline suite once per mutant, in parallel workspaces: the mutant
#    replaces src/<Contract>.sol, then
#      forge test --offline --fail-fast
#    with via-IR and the optimizer off (seconds per compile instead of minutes),
#    a fixed fuzz seed, fuzz runs MUT_FUZZ_RUNS and invariants at
#    MUT_INVARIANT_RUNS x MUT_INVARIANT_DEPTH.
#    test/fork and test/audit need an RPC; test/script exercises the ops
#    scripts, which only compile under via-IR. None of the three is copied.
# 4. Writes results/<Contract>.csv next to this script, one row per mutant:
#      id,operator,location,original,mutated,status,killed_by
#    status is killed (a test failed; killed_by names the first one reported),
#    timeout (counted as killed), survived (the whole suite passed) or invalid (the
#    mutant does not compile without via-IR; not scored). Also writes
#    results/run-info.txt: the commit, the git blob ids of the mutated sources, the
#    config and this script, tool versions and settings.
#
# Contract arguments limit the forge runs (Gambit still generates every mutant).
# --resume keeps an existing scratch copy and its per-mutant results, and runs only
# the mutants that have none or whose run errored.
#
# Needs forge, gambit (cargo install --locked --git https://github.com/Certora/gambit
# --rev 072ff4c6d747397f859e0a15a20fe1ff05672332) and solc 0.8.26 (forge installs it
# under ~/.svm, or %APPDATA%\svm on Windows).
#
# Environment:
#   MUT_WORK             scratch directory outside the repository, wiped unless --resume
#                        (default: $TMPDIR/spare-mutation)
#   MUT_JOBS             parallel workspaces (default: logical cores / 8)
#   MUT_THREADS          forge test threads per workspace (default: logical cores / MUT_JOBS)
#   MUT_TIMEOUT          seconds per mutant before it counts as a timeout (default 900)
#   MUT_FUZZ_RUNS        default 512, as foundry.toml
#   MUT_FUZZ_SEED        default 0x5ba4e
#   MUT_INVARIANT_RUNS   default 128
#   MUT_INVARIANT_DEPTH  default 64
#   GAMBIT, SOLC         binaries, when they are not on PATH
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
HERE="$(dirname "$SELF")"
source "$HERE/../../scripts/lib/common.sh"

: "${MUT_WORK:=${TMPDIR:-/tmp}/spare-mutation}"
CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)
: "${MUT_JOBS:=$((CORES / 8 > 0 ? CORES / 8 : 1))}"
: "${MUT_THREADS:=$((CORES / MUT_JOBS > 0 ? CORES / MUT_JOBS : 1))}"
: "${MUT_TIMEOUT:=900}"
: "${MUT_FUZZ_RUNS:=512}"
: "${MUT_FUZZ_SEED:=0x5ba4e}"
: "${MUT_INVARIANT_RUNS:=128}"
: "${MUT_INVARIANT_DEPTH:=64}"
TREE="$MUT_WORK/tree"
GAMBIT_OUT="$TREE/mutation/gambit_out"
export MUT_WORK MUT_JOBS MUT_THREADS MUT_TIMEOUT TREE GAMBIT_OUT
export FOUNDRY_VIA_IR=false FOUNDRY_OPTIMIZER=false FOUNDRY_OFFLINE=true
export FOUNDRY_FUZZ_RUNS="$MUT_FUZZ_RUNS" FOUNDRY_FUZZ_SEED="$MUT_FUZZ_SEED"
export FOUNDRY_INVARIANT_RUNS="$MUT_INVARIANT_RUNS" FOUNDRY_INVARIANT_DEPTH="$MUT_INVARIANT_DEPTH"

# The contracts in gambit.conf.json, in order.
targets() { sed -n 's#.*"filename": *"\.\./src/\([A-Za-z0-9_]*\)\.sol".*#\1#p' "$HERE/gambit.conf.json"; }

# first_failure <forge log>: suite.test of the first failing test in forge's
# "Failing tests:" summary. An invariant failure prints its call sequence between
# the [FAIL ...] line and the test name, so the name is matched by its
# "(gas: ...)" / "(runs: ...)" suffix rather than by position.
first_failure() {
  awk '
    /^Failing tests:/ { on = 1; next }
    on && /^Encountered [0-9]+ failing tests? in / { suite = $NF; next }
    on && suite != "" && match($0, /[A-Za-z_][A-Za-z0-9_]*\([^()]*\) \((gas|runs):/) {
      name = substr($0, RSTART, RLENGTH)
      sub(/\(.*/, "", name)
      print suite "." name
      exit
    }
  ' "$1"
}

# run_one <Contract> <mutant id>: one forge run in the first free workspace. The
# result goes to $MUT_WORK/results/<Contract>/<id> as "status<TAB>killed_by".
run_one() {
  local c=$1 id=$2
  local res="$MUT_WORK/results/$c/$id" log="$MUT_WORK/logs/$c-$id.log"
  if [ -f "$res" ] && ! grep -q '^error' "$res"; then return 0; fi
  local k rc status by
  WS=""
  while [ -z "$WS" ]; do
    for k in $(seq 1 "$MUT_JOBS"); do
      if mkdir "$MUT_WORK/w$k/.lock" 2>/dev/null; then
        WS="$MUT_WORK/w$k"
        break
      fi
    done
    [ -n "$WS" ] || sleep 1
  done
  # The workspace goes back clean and unlocked however this run ends (WS is
  # global so the trap still sees it after run_one returns).
  trap 'rm -rf "$WS/src"; cp -R "$TREE/src" "$WS/src"; rmdir "$WS/.lock"' EXIT
  rm -rf "$WS/src"
  cp -R "$TREE/src" "$WS/src"
  cp "$GAMBIT_OUT/$c/mutants/$id/src/$c.sol" "$WS/src/$c.sol"
  rc=0
  (cd "$WS" && timeout "$MUT_TIMEOUT" forge test --offline --fail-fast -j "$MUT_THREADS") >"$log" 2>&1 || rc=$?
  by=""
  if [ "$rc" -eq 0 ]; then
    status=survived
  elif [ "$rc" -eq 124 ]; then
    status=timeout
    by="(timeout after ${MUT_TIMEOUT}s)"
  elif grep -q "Compiler run failed" "$log"; then
    status=invalid
  else
    by=$(first_failure "$log")
    if [ -n "$by" ]; then status=killed; else status=error; fi
  fi
  printf '%s\t%s\n' "$status" "$by" >"$res.tmp"
  mv "$res.tmp" "$res"
  printf '%s %s %s %s\n' "$c" "$id" "$status" "$by" >&2
}

if [ "${1:-}" = "--one" ]; then
  run_one "$2" "$3"
  exit 0
fi

RESUME=0
if [ "${1:-}" = "--resume" ]; then
  RESUME=1
  shift
fi
ALL=$(targets)
RUN=("$@")
[ ${#RUN[@]} -gt 0 ] || read -r -a RUN <<<"$(echo $ALL)"
for c in "${RUN[@]}"; do
  grep -qx "$c" <<<"$ALL" || die "$c is not in gambit.conf.json (have: $(echo $ALL))"
done

need forge
need timeout
GAMBIT=${GAMBIT:-$(command -v gambit || true)}
[ -n "$GAMBIT" ] && [ -x "$GAMBIT" ] || die "gambit not found (set GAMBIT or put it on PATH)"
if [ -z "${SOLC:-}" ]; then
  for s in "$(command -v solc || true)" "$HOME/.svm/0.8.26/solc-0.8.26" "${APPDATA:-}/svm/0.8.26/solc-0.8.26"; do
    if [ -n "$s" ] && [ -x "$s" ] && "$s" --version | grep -q "Version: 0.8.26+"; then
      SOLC=$s
      break
    fi
  done
fi
[ -n "${SOLC:-}" ] || die "solc 0.8.26 not found (set SOLC; 'forge build' installs it under ~/.svm)"
"$SOLC" --version | grep -q "Version: 0.8.26+" || die "$SOLC is not solc 0.8.26"

# MUT_WORK gets wiped, so it must not be $HOME, the checkout, or anything holding it.
if [ -d "$MUT_WORK" ]; then
  work_abs=$(cd "$MUT_WORK" && pwd -P)
else
  work_abs=$(cd "$(dirname "$MUT_WORK")" 2>/dev/null && pwd -P) || die "the parent of MUT_WORK ($MUT_WORK) does not exist"
  work_abs="$work_abs/$(basename "$MUT_WORK")"
fi
root_abs=$(cd "$SPARE_ROOT" && pwd -P)
case "$work_abs/" in "$root_abs/"*) die "MUT_WORK ($MUT_WORK) is inside the repository" ;; esac
case "$root_abs/" in "$work_abs/"*) die "MUT_WORK ($MUT_WORK) contains the repository" ;; esac
[ "$work_abs" != "$(cd "$HOME" && pwd -P)" ] || die "MUT_WORK must not be \$HOME"

if [ "$RESUME" -eq 0 ] || [ ! -d "$GAMBIT_OUT" ]; then
  rm -rf "$MUT_WORK"
  mkdir -p "$TREE/test" "$TREE/mutation" "$MUT_WORK/bin"
  log "copying contracts/ to $TREE"
  (cd "$CONTRACTS" && tar -cf - src lib foundry.toml $(ls remappings.txt 2>/dev/null)) | (cd "$TREE" && tar -xf -)
  (cd "$CONTRACTS/test" && tar -cf - unit mocks) | (cd "$TREE/test" && tar -xf -)
  cp "$HERE/gambit.conf.json" "$TREE/mutation/"
  # What was copied, recorded now: the checkout may change during a long run.
  # hash-object gives the git blob id, which does not depend on line endings.
  {
    if commit=$(git -C "$CONTRACTS" rev-parse HEAD 2>/dev/null); then
      echo "commit: $commit"
      dirty=$(git -C "$CONTRACTS" status --porcelain -- src test/unit test/mocks foundry.toml)
      if [ -n "$dirty" ]; then
        echo "uncommitted changes copied (src, test/unit, test/mocks, foundry.toml):"
        sed 's/^/  /' <<<"$dirty"
      else
        echo "uncommitted changes copied: none (src, test/unit, test/mocks, foundry.toml match the commit)"
      fi
    else
      echo "commit: unknown (contracts/ is not in a git checkout)"
    fi
    for f in $(for c in $ALL; do echo "src/$c.sol"; done) mutation/gambit.conf.json mutation/run-mutants.sh; do
      echo "blob $f: $(git -C "$CONTRACTS" hash-object "$f" 2>/dev/null || echo unknown)"
    done
  } >"$MUT_WORK/stamp"

  # Gambit runs "solc" from PATH.
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) cp "$SOLC" "$MUT_WORK/bin/solc.exe" ;;
    *) ln -sf "$SOLC" "$MUT_WORK/bin/solc" ;;
  esac
  log "generating mutants (Gambit compiles each one; ~15 min)"
  (cd "$TREE" && PATH="$MUT_WORK/bin:$PATH" "$GAMBIT" mutate --json mutation/gambit.conf.json) >"$MUT_WORK/gambit.log" 2>&1 ||
    die "gambit failed, see $MUT_WORK/gambit.log"
  tail -n 1 "$MUT_WORK/gambit.log" >&2
fi

log "baseline: the unmutated suite must pass with these settings"
(cd "$TREE" && forge test --offline -j 0) >"$MUT_WORK/baseline.log" 2>&1 || die "baseline fails, see $MUT_WORK/baseline.log"
grep -E "^Ran [0-9]+ test suites" "$MUT_WORK/baseline.log" >&2

mkdir -p "$MUT_WORK/logs"
for k in $(seq 1 "$MUT_JOBS"); do
  if [ ! -d "$MUT_WORK/w$k" ]; then
    mkdir -p "$MUT_WORK/w$k"
    (cd "$TREE" && tar -cf - src test lib foundry.toml cache out $(ls remappings.txt 2>/dev/null)) | (cd "$MUT_WORK/w$k" && tar -xf -)
  fi
  rmdir "$MUT_WORK/w$k/.lock" 2>/dev/null || true
done

QUEUE="$MUT_WORK/queue"
: >"$QUEUE"
for c in "${RUN[@]}"; do
  mkdir -p "$MUT_WORK/results/$c"
  ls "$GAMBIT_OUT/$c/mutants" | sort -n | sed "s/^/$c /" >>"$QUEUE"
done
log "$(wc -l <"$QUEUE") mutants, $MUT_JOBS workspaces x $MUT_THREADS threads"
xargs -P "$MUT_JOBS" -L 1 bash "$SELF" --one <"$QUEUE" || warn "some runs failed; the rows marked error or missing say which"

# Results: gambit's mutants.log (id,operator,file,line:col,original,mutated, quoted
# as CSV) joined with each mutant's status. A quoted field can span lines, so a
# record ends on the line that balances its quotes.
mkdir -p "$HERE/results"
for c in "${RUN[@]}"; do
  st="$MUT_WORK/results/$c.tsv"
  : >"$st"
  for f in "$MUT_WORK/results/$c"/*; do
    case "$f" in *.tmp) continue ;; esac
    printf '%s\t%s\n' "$(basename "$f")" "$(cat "$f")" >>"$st"
  done
  {
    echo "id,operator,location,original,mutated,status,killed_by"
    awk '
      FNR == NR { split($0, t, "\t"); st[t[1]] = t[2]; by[t[1]] = t[3]; next }
      {
        line = $0
        sub(/\r$/, "", line)
        if (!open) {
          split(line, f, ",")
          id = f[1]
          file = f[3]
          gsub(/\\/, "/", file)
          line = id "," f[2] "," file ":" f[4] substr(line, length(f[1] f[2] f[3] f[4]) + 4)
          rec = line
          q = 0
          open = 1
        } else {
          rec = rec "\n" line
        }
        q += gsub(/"/, "\"", line)
        if (q % 2 == 0) {
          print rec "," ((id in st) ? st[id] : "missing") "," by[id]
          open = 0
        }
      }
    ' "$st" "$GAMBIT_OUT/$c/mutants.log"
  } >"$HERE/results/$c.csv"
done

{
  cat "$MUT_WORK/stamp"
  echo "forge: $(forge --version | head -n 1)"
  echo "solc: $("$SOLC" --version | tail -n 1)"
  echo "gambit: $(grep -o 'gambit [^"]*' "$(dirname "$GAMBIT")/../.crates.toml" 2>/dev/null | head -n 1 || echo "$GAMBIT")"
  echo "settings: via_ir=false optimizer=false fuzz_runs=$MUT_FUZZ_RUNS fuzz_seed=$MUT_FUZZ_SEED invariant_runs=$MUT_INVARIANT_RUNS invariant_depth=$MUT_INVARIANT_DEPTH timeout=${MUT_TIMEOUT}s"
  echo "suite (unmutated): $(grep -oE '^Ran [0-9]+ test suites' "$MUT_WORK/baseline.log" | cut -d' ' -f2) suites, $(grep -oE '[0-9]+ tests passed, [0-9]+ failed, [0-9]+ skipped' "$MUT_WORK/baseline.log")"
  echo "finished: $(date -u +%Y-%m-%dT%H:%MZ)"
} >"$HERE/results/run-info.txt"

printf '\n%-14s %8s %7s %8s %8s %8s %7s\n' contract mutants killed timeout survived invalid score
bad=0
for c in "${RUN[@]}"; do
  st="$MUT_WORK/results/$c.tsv"
  count() { awk -F'\t' -v s="$1" '$2 == s' "$st" | wc -l | tr -d ' '; }
  n=$(ls "$GAMBIT_OUT/$c/mutants" | wc -l | tr -d ' ')
  kl=$(count killed) to=$(count timeout) sv=$(count survived) iv=$(count invalid) er=$(count error)
  ms=$((n - $(wc -l <"$st")))
  printf '%-14s %8s %7s %8s %8s %8s %6s%%\n' "$c" "$n" "$kl" "$to" "$sv" "$iv" \
    "$(awk -v k=$((kl + to)) -v n=$((n - iv)) 'BEGIN { printf "%.1f", n ? 100 * k / n : 0 }')"
  if [ $((er + ms)) -gt 0 ]; then
    warn "$c: $er runs errored and $ms have no result; see $MUT_WORK/logs"
    bad=1
  fi
  awk -F'\t' '$2 == "survived" { print "  survived: " $1 }' "$st" | sort -k2,2n
done
exit $bad
