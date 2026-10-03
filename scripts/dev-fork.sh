#!/usr/bin/env bash
# dev-fork.sh — one command for a full local SPARE environment.
#
# Starts anvil forking Robinhood Chain MAINNET (real USDG, Permit2, Uniswap v4
# pools, Chainlink feeds, stock tokens) under chain id 31337, puts MockArbSys at
# the ArbSys precompile (0x64), deploys SPARE from the mainnet config with anvil
# test keys in every role and screening off, completes the ownership hand-over,
# verifies every wire, and funds two test users (fresh random keys) with ETH and USDG.
#
#   scripts/dev-fork.sh             start or reuse; idempotent
#   scripts/dev-fork.sh --smoke     ...then run scripts/dev-smoke.sh (accrue -> sweep, E2E)
#   scripts/dev-fork.sh --status    show what is running
#   scripts/dev-fork.sh --stop      stop the anvil this script started
#   scripts/dev-fork.sh --reset     stop, forget the local deployment, start fresh
#
# Environment
#   RHC_RPC_URL  upstream mainnet RPC. Default: the public RPC (see STATE WINDOW)
#   FORK_BLOCK   block to fork. Default: the upstream head at start
#   ANVIL_PORT   default 8545
#   ANVIL_CUPS   anvil's upstream request budget, compute units/s (default 100)
#   FUND_USDG    whole USDG given to each test user (default 1000)
#   FUND_ETH     whole ETH given to each test user (default 100)
#   USDG_WHALE   holder impersonated for funding (default in scripts/lib/common.sh)
#
# Roles (anvil default mnemonic, index -> role; keys are PUBLIC test keys)
#   0 deployer   1 owner   2 keeper   3 pauser   4 attestor   7, 8 used only by --smoke
# Test users alice and bob are NOT anvil keys: they are random keys made for this
# fork (scripts/.dev-fork/users.env, new ones after --reset), funded with
# anvil_setBalance and a USDG transfer from an impersonated holder. anvil's public
# keys carry EIP-7702 sweeper delegations on RHC mainnet (see fresh_key in
# scripts/lib/common.sh); the role keys above are cleared of that code on the fork.
#
# STATE WINDOW. The public RHC RPC is not an archive node: it serves state for
# only the most recent ~6-8k blocks (~10-13 minutes at ~0.1 s blocks). anvil reads
# mainnet state lazily AT THE FORK BLOCK, so once that block ages out, a call that
# touches mainnet state anvil has not cached yet fails with "historical state ...
# is not available". Setup touches (and so caches) what the deployment needs, and
# --smoke caches the SPY/NVDA swap path. For long sessions, or to pin an old block,
# point RHC_RPC_URL at an archive endpoint.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  # The header comment, however long it grows.
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
  exit 0
}

MODE=up
SMOKE=0
for a in "$@"; do
  case "$a" in
    --smoke) SMOKE=1 ;;
    --status) MODE=status ;;
    --stop) MODE=stop ;;
    --reset) MODE=reset ;;
    -h | --help) usage ;;
    *) die "unknown argument: $a (see --help)" ;;
  esac
done

need anvil
need cast
need forge

PORT=${ANVIL_PORT:-8545}
LOCAL="http://127.0.0.1:$PORT"
UPSTREAM=${RHC_RPC_URL:-$PUBLIC_RHC_RPC}
DEV_CHAIN_ID=31337
STATE="$SPARE_ROOT/scripts/.dev-fork"
CFG_REL="config/$DEV_CHAIN_ID.json"
ADDR_REL="addresses/$DEV_CHAIN_ID.json"
ADDR="$CONTRACTS/$ADDR_REL"
FUND=$((${FUND_USDG:-1000} * 1000000))
FUND_WEI="${FUND_ETH:-100}000000000000000000"
USERS="$STATE/users.env"

mkdir -p "$STATE"
[ -f "$STATE/.gitignore" ] || printf '*\n' >"$STATE/.gitignore"

# ── anvil lifecycle ─────────────────────────────────────────────────────────

rpc_chain() { cast chain-id --rpc-url "$LOCAL" 2>/dev/null || true; }
pid_alive() { [ -f "$STATE/anvil.pid" ] && kill -0 "$(cat "$STATE/anvil.pid")" 2>/dev/null; }

stop_anvil() {
  if pid_alive; then
    local pid winpid=""
    pid=$(cat "$STATE/anvil.pid")
    [ -r "/proc/$pid/winpid" ] && winpid=$(cat "/proc/$pid/winpid")
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pid_alive || break
      sleep 1
    done
    if pid_alive && [ -n "$winpid" ] && command -v taskkill >/dev/null 2>&1; then
      taskkill //F //PID "$winpid" >/dev/null 2>&1 || true
    fi
    pid_alive && die "could not stop anvil (pid $pid)"
    log "stopped anvil (pid $pid)"
  elif [ -n "$(rpc_chain)" ]; then
    warn "something is serving $LOCAL but it was not started by this script; leaving it alone"
  else
    log "no anvil running on $LOCAL"
  fi
  rm -f "$STATE/anvil.pid"
}

start_anvil() {
  local up_chain block
  up_chain=$(cast chain-id --rpc-url "$UPSTREAM") || die "cannot reach upstream RPC"
  [ "$up_chain" = "4663" ] || die "upstream RPC is chain $up_chain; the SPARE config targets RHC mainnet (4663)"
  block=${FORK_BLOCK:-$(cast block-number --rpc-url "$UPSTREAM")}
  if [ "$UPSTREAM" = "$PUBLIC_RHC_RPC" ]; then
    warn "public RPC: mainnet state is only served for ~10 min past the fork block (see --help, STATE WINDOW)"
  fi
  log "starting anvil: fork of RHC mainnet @ block $block -> $LOCAL (chain id $DEV_CHAIN_ID)"
  nohup anvil \
    --fork-url "$UPSTREAM" \
    --fork-block-number "$block" \
    --chain-id "$DEV_CHAIN_ID" \
    --port "$PORT" \
    --retries 30 \
    --fork-retry-backoff 1000 \
    --compute-units-per-second "${ANVIL_CUPS:-100}" \
    >"$STATE/anvil.log" 2>&1 &
  echo $! >"$STATE/anvil.pid"
  echo "$block" >"$STATE/fork-block"
  for _ in $(seq 1 120); do
    [ "$(rpc_chain)" = "$DEV_CHAIN_ID" ] && break
    if ! pid_alive; then
      tail -n 20 "$STATE/anvil.log" >&2 || true
      rm -f "$STATE/anvil.pid"
      die "anvil exited during startup (log: scripts/.dev-fork/anvil.log)"
    fi
    sleep 1
  done
  [ "$(rpc_chain)" = "$DEV_CHAIN_ID" ] || die "anvil did not come up (log: scripts/.dev-fork/anvil.log)"
  log "anvil up (pid $(cat "$STATE/anvil.pid"), log scripts/.dev-fork/anvil.log)"
}

ensure_anvil() {
  local c
  c=$(rpc_chain)
  if [ "$c" = "$DEV_CHAIN_ID" ]; then
    log "reusing the anvil already serving $LOCAL"
  elif [ -n "$c" ]; then
    die "$LOCAL serves chain $c, not a SPARE dev fork; stop it or set ANVIL_PORT"
  else
    start_anvil
  fi
}

# Nitro serves 0xfe (INVALID) at the ArbSys precompile; L2Clock would fall back to
# block.number. MockArbSys returns block.number through the real call path, so the
# contracts take their PRODUCTION branch on the fork.
ensure_arbsys() {
  local want have
  (cd "$CONTRACTS" && forge build test/mocks/MockArbSys.sol >/dev/null 2>&1) || die "could not build MockArbSys"
  want=$(json_get contracts/out/MockArbSys.sol/MockArbSys.json deployedBytecode.object)
  have=$(cast code 0x0000000000000000000000000000000000000064 --rpc-url "$LOCAL")
  if [ "$have" != "$want" ]; then
    cast rpc anvil_setCode 0x0000000000000000000000000000000000000064 "$want" --rpc-url "$LOCAL" >/dev/null
    [ "$(cast code 0x0000000000000000000000000000000000000064 --rpc-url "$LOCAL")" = "$want" ] ||
      die "anvil_setCode at 0x64 did not stick"
    log "MockArbSys set at 0x64"
  fi
  local head arb
  head=$(cast block-number --rpc-url "$LOCAL")
  arb=$(cast call 0x0000000000000000000000000000000000000064 "arbBlockNumber()(uint256)" --rpc-url "$LOCAL" | awk '{print $1}')
  [ "$arb" = "$head" ] || die "ArbSys.arbBlockNumber() = $arb but eth_blockNumber = $head"
}

# anvil's default keys are public, so on RHC mainnet sweeper bots have attached
# EIP-7702 delegations to them (code 0xef0100 + 8a67b502...408a, seen 2026-09-29).
# A fork inherits that code, turning the dev accounts into someone else's smart
# account. Strip it so every dev account is a plain EOA, as a developer expects.
ensure_plain_eoas() {
  local i a cleared=0
  for i in 0 1 2 3 4 5 6 7 8; do
    a=$(key_addr "$(anvil_key "$i")")
    if [ "$(cast code "$a" --rpc-url "$LOCAL")" != "0x" ]; then
      cast rpc anvil_setCode "$a" 0x --rpc-url "$LOCAL" >/dev/null
      cleared=$((cleared + 1))
    fi
  done
  [ "$cleared" = 0 ] || log "cleared mainnet EIP-7702 delegation code from $cleared anvil dev account(s)"
}

# ── keys / config ───────────────────────────────────────────────────────────

# alice and bob: random keys made once per fork and kept in $USERS (gitignored
# with the rest of scripts/.dev-fork) so a reused anvil keeps the same users.
load_users() {
  if [ ! -f "$USERS" ]; then
    {
      echo "# Generated by scripts/dev-fork.sh: random test-user keys for the LOCAL fork only."
      echo "ALICE_PK=$(fresh_key)"
      echo "BOB_PK=$(fresh_key)"
    } >"$USERS"
    log "made fresh keys for alice and bob (scripts/.dev-fork/users.env)"
  fi
  ALICE_PK=$(sed -n 's/^ALICE_PK=//p' "$USERS")
  BOB_PK=$(sed -n 's/^BOB_PK=//p' "$USERS")
  [[ "$ALICE_PK" =~ ^0x[0-9a-fA-F]{64}$ && "$BOB_PK" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
    die "scripts/.dev-fork/users.env is damaged; run scripts/dev-fork.sh --reset"
}

load_keys() {
  DEPLOYER_PK=$(anvil_key 0)
  OWNER_PK=$(anvil_key 1)
  KEEPER_PK=$(anvil_key 2)
  PAUSER_PK=$(anvil_key 3)
  ATTESTOR_PK=$(anvil_key 4)
  load_users
  DEPLOYER=$(key_addr "$DEPLOYER_PK")
  OWNER=$(key_addr "$OWNER_PK")
  KEEPER=$(key_addr "$KEEPER_PK")
  PAUSER=$(key_addr "$PAUSER_PK")
  ATTESTOR=$(key_addr "$ATTESTOR_PK")
  ALICE=$(key_addr "$ALICE_PK")
  BOB=$(key_addr "$BOB_PK")
}

write_dev_config() {
  (cd "$SPARE_ROOT" && js scripts/lib/spare-json.mjs dev-config \
    contracts/config/4663.json "contracts/$CFG_REL" "$DEV_CHAIN_ID" \
    "$OWNER" "$KEEPER" "$PAUSER" "$ATTESTOR") || die "could not write contracts/$CFG_REL"
  export SPARE_CONFIG="$CFG_REL"
}

# ── deployment ──────────────────────────────────────────────────────────────

deployed() {
  [ -f "$ADDR" ] || return 1
  local exec
  exec=$(json_get "contracts/$ADDR_REL" contracts.SweepExecutor 2>/dev/null) || return 1
  [ "$(cast code "$exec" --rpc-url "$LOCAL")" != "0x" ]
}

deploy() {
  log "deploying SPARE (deployer = anvil #0)..."
  spare_forge Deploy --rpc-url "$LOCAL" --broadcast --private-key "$DEPLOYER_PK" \
    >"$STATE/deploy.log" 2>&1 || {
    tail -n 40 "$STATE/deploy.log" >&2
    die "deploy failed (full log: scripts/.dev-fork/deploy.log)"
  }
  grep -E "SUMMARY:" "$STATE/deploy.log" | sed 's/^ */  /' >&2 || true
  log "wrote contracts/$ADDR_REL"
}

accept_ownership() {
  spare_forge AcceptOwnership --rpc-url "$LOCAL" --broadcast --private-key "$OWNER_PK" \
    >"$STATE/accept.log" 2>&1 || {
    tail -n 30 "$STATE/accept.log" >&2
    die "acceptOwnership failed (log: scripts/.dev-fork/accept.log)"
  }
  if grep -q "Accepted ownership" "$STATE/accept.log"; then
    log "owner (anvil #1) accepted ownership of all 7 contracts"
  fi
}

verify() {
  SPARE_REQUIRE_ACCEPTED=true spare_forge VerifyDeployment --rpc-url "$LOCAL" >"$STATE/verify.log" 2>&1
}

# ── status / env ────────────────────────────────────────────────────────────

write_env() {
  local f="$STATE/env.sh" k
  {
    echo "# Generated by scripts/dev-fork.sh — LOCAL anvil fork only. Role keys are anvil's PUBLIC test keys;"
    echo "# alice and bob are random keys made for this fork (scripts/.dev-fork/users.env)."
    echo "# Usage: source scripts/.dev-fork/env.sh"
    echo "export SPARE_RPC_URL=$LOCAL"
    echo "export SPARE_CHAIN_ID=$DEV_CHAIN_ID"
    echo "export SPARE_FORK_BLOCK=$(cat "$STATE/fork-block" 2>/dev/null || echo unknown)"
    echo "export SPARE_START_BLOCK=$(json_get "contracts/$ADDR_REL" startBlock)"
    echo "export SPARE_ADDRESSES_FILE=contracts/$ADDR_REL"
    for k in AssetRegistry RuleRegistry ElectionRegistry ScreeningGate StockRouter CashPark FeeVault SweepExecutor UsdgParkAdapter SgovParkAdapter; do
      echo "export SPARE_$(echo "$k" | sed 's/\([a-z]\)\([A-Z]\)/\1_\2/g' | tr '[:lower:]' '[:upper:]')=$(json_get "contracts/$ADDR_REL" "contracts.$k")"
    done
    echo "export SPARE_USDG=$USDG"
    echo "export SPARE_OWNER=$OWNER SPARE_OWNER_PK=$OWNER_PK"
    echo "export SPARE_KEEPER=$KEEPER SPARE_KEEPER_PK=$KEEPER_PK"
    echo "export SPARE_PAUSER=$PAUSER SPARE_PAUSER_PK=$PAUSER_PK"
    echo "export SPARE_ATTESTOR=$ATTESTOR SPARE_ATTESTOR_PK=$ATTESTOR_PK"
    echo "export SPARE_ALICE=$ALICE SPARE_ALICE_PK=$ALICE_PK"
    echo "export SPARE_BOB=$BOB SPARE_BOB_PK=$BOB_PK"
  } >"$f"
}

print_summary() {
  local k
  echo
  echo "SPARE dev fork — $LOCAL (chain id $DEV_CHAIN_ID, forked from RHC mainnet @ block $(cat "$STATE/fork-block" 2>/dev/null || echo '?'))"
  echo "  addresses : contracts/$ADDR_REL      config: contracts/$CFG_REL"
  echo "  env       : source scripts/.dev-fork/env.sh"
  echo
  for k in AssetRegistry RuleRegistry ElectionRegistry ScreeningGate StockRouter CashPark FeeVault SweepExecutor UsdgParkAdapter SgovParkAdapter; do
    printf '  %-17s %s\n' "$k" "$(json_get "contracts/$ADDR_REL" "contracts.$k")"
  done
  echo
  printf '  %-17s %s  (anvil #1)\n' owner "$OWNER"
  printf '  %-17s %s  (anvil #2)\n' keeper "$KEEPER"
  printf '  %-17s %s  (anvil #3)\n' pauser "$PAUSER"
  printf '  %-17s %s  (anvil #4)\n' attestor "$ATTESTOR"
  printf '  %-17s %s  (fresh key)  %s USDG, %s ETH\n' alice "$ALICE" "$(($(usdg_balance "$ALICE" "$LOCAL") / 1000000))" "$(cast from-wei "$(cast balance "$ALICE" --rpc-url "$LOCAL")")"
  printf '  %-17s %s  (fresh key)  %s USDG, %s ETH\n' bob "$BOB" "$(($(usdg_balance "$BOB" "$LOCAL") / 1000000))" "$(cast from-wei "$(cast balance "$BOB" --rpc-url "$LOCAL")")"
  echo
  echo "  Launch park adapter: UsdgParkAdapter. Screening: OFF. Stop: scripts/dev-fork.sh --stop"
}

status() {
  local c
  c=$(rpc_chain)
  if [ "$c" = "$DEV_CHAIN_ID" ]; then
    log "anvil serving $LOCAL, head $(cast block-number --rpc-url "$LOCAL"), fork block $(cat "$STATE/fork-block" 2>/dev/null || echo '?')"
    if deployed; then
      log "SPARE deployed: contracts/$ADDR_REL"
    else
      log "SPARE not deployed on this anvil"
    fi
  elif [ -n "$c" ]; then
    log "$LOCAL serves chain $c (not a SPARE dev fork)"
  else
    log "nothing running on $LOCAL"
  fi
}

# ── main ───────────────────────────────────────────────────────────────────

case "$MODE" in
  status)
    status
    exit 0
    ;;
  stop)
    stop_anvil
    exit 0
    ;;
  reset)
    stop_anvil
    rm -f "$ADDR" "$STATE/env.sh" "$STATE/fork-block" "$USERS"
    log "forgot the local deployment and the test users"
    ;;
esac

load_keys
ensure_anvil
ensure_arbsys
ensure_plain_eoas
write_dev_config

reused=0
if deployed; then
  reused=1
  log "SPARE already deployed on this anvil (contracts/$ADDR_REL); reusing"
else
  deploy
fi
accept_ownership
if ! verify; then
  if [ "$reused" = 1 ]; then
    warn "the existing deployment does not verify against the current config; redeploying"
    deploy
    accept_ownership
    verify || {
      tail -n 40 "$STATE/verify.log" >&2
      die "VerifyDeployment failed (log: scripts/.dev-fork/verify.log)"
    }
  else
    tail -n 40 "$STATE/verify.log" >&2
    die "VerifyDeployment failed (log: scripts/.dev-fork/verify.log)"
  fi
fi
grep -E "SUMMARY:" "$STATE/verify.log" | sed 's/^ */  /' >&2 || true
log "VerifyDeployment: PASS"

log "funding test users to ${FUND_ETH:-100} ETH and $((FUND / 1000000)) USDG"
for u in "$ALICE" "$BOB"; do
  [ "$(cast code "$u" --rpc-url "$LOCAL")" = "0x" ] || die "test user $u has code on the fork; run scripts/dev-fork.sh --reset"
  fund_eth "$LOCAL" "$u" "$FUND_WEI"
  fund_usdg "$LOCAL" "$u" "$FUND"
done

write_env
print_summary

if [ "$SMOKE" = 1 ]; then
  "$SPARE_ROOT/scripts/dev-smoke.sh"
fi
