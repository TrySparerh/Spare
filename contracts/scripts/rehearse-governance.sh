#!/usr/bin/env bash
# Full rehearsal of the owner -> Safe + timelock hand-over (docs/GOVERNANCE.md) on a
# LOCAL anvil fork of Robinhood Chain mainnet, using the exact scripts the owner
# will run: script/governance/{DeployTimelock,HandOver,TimelockBatch}.s.sol and
# deployments/4663-pauser-pause-all.json, executed through REAL Safe v1.4.1 proxies
# created on the fork from the canonical factory.
#
#   contracts/scripts/rehearse-governance.sh [log file]
#
# Proves, and exits non-zero if any of it does not hold:
#   - VerifyDeployment passes on the fork before anything changes (the baseline);
#   - the Safe / timelock guards refuse bad inputs (short delay, 1-of-N owner Safe,
#     pauser = owner Safe) before anything is sent;
#   - HandOver moves pauser + attestor first, then nominates the timelock; re-running
#     it sends nothing;
#   - AcceptOwnership, with the timelock as pending owner, prints no direct Safe batch
#     (it would revert), points to TimelockBatch.s.sol and refuses --broadcast;
#   - the owner Safe (2 of 3) schedules acceptOwnership; one signature is refused; the
#     old EOA cannot schedule; execution reverts before 48 h and succeeds at 48 h;
#   - afterwards every owner function reverts for the old EOA and for the owner Safe
#     acting directly, and succeeds only through the timelock after 48 h (the unpause
#     batch, scheduled through the approveHash CLI path of docs/GOVERNANCE.md);
#   - the pauser Safe (1 of 2) pauses all 7 instantly, the keeper is stopped, the
#     pauser cannot unpause, and a user's CashPark.exit() still pays out;
#   - VerifyDeployment's role, ownership and wiring checks pass against the new roles
#     with SPARE_REQUIRE_ACCEPTED=true;
#   - AddAssets, with the timelock as registry owner, refuses --broadcast and prints a
#     config change (a standby asset, QQQ, made active) as TIMELOCK_CALLS_JSON;
#     TimelockBatch takes it as printed; the owner Safe schedules it, it cannot run
#     early, it runs at 48 h, the registry then matches and AddAssets plans 0 actions.
# A failure whose cause lies outside the governance tooling is printed as [known]
# with that cause and does not fail the run; every other failure does.
#
# Sends NOTHING to mainnet: every transaction goes to http://127.0.0.1:$PORT, which
# is checked to be anvil with chain id 4663 before anything is sent. The fork URL is
# $RHC_RPC_URL (else the public endpoint) and is scrubbed from all output. Test keys
# are derived from public labels (keccak), exist only on the fork, and are never
# printed; only their addresses are.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib/common.sh"
need anvil
need forge
need cast

FORK_URL="${RHC_RPC_URL:-$PUBLIC_RHC_RPC}"
PORT="${PORT:-8551}"
LOCAL="http://127.0.0.1:$PORT"
OUT="out-deploy" # gitignored; forge artifacts, broadcast logs and scratch for this run
CACHE_DIR="cache-deploy"
OUT_LOG="${1:-}"
[ -z "$OUT_LOG" ] || OUT_LOG="$(cd "$(dirname "$OUT_LOG")" && pwd)/$(basename "$OUT_LOG")"
cd "$CONTRACTS"

# ── output: plain text, fork URL scrubbed ───────────────────────────────────
scrub() {
  SCRUB_URL="$FORK_URL" js -e '
    const u = process.env.SCRUB_URL;
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.on("line", (l) => console.log(l.replace(/\x1b\[[0-9;]*m/g, "").split(u).join("<RHC_RPC_URL>")));'
}
ANVIL_DIR="$OUT/.rehearsal-anvil"

# Re-run this script with all output piped through scrub (and tee), wait for it, and
# stop its anvil even if the inner run died without running its EXIT trap.
if [ -z "${_SPARE_REHEARSAL_INNER:-}" ]; then
  set +e
  _SPARE_REHEARSAL_INNER=1 "$CONTRACTS/scripts/rehearse-governance.sh" 2>&1 | scrub | tee "${OUT_LOG:-/dev/null}"
  status=${PIPESTATUS[0]}
  set -e
  if [ -f "$ANVIL_DIR/anvil.pid" ]; then kill "$(cat "$ANVIL_DIR/anvil.pid")" 2>/dev/null || true; fi
  rm -rf "$ANVIL_DIR"
  exit "$status"
fi

PASS=0
FAIL=0
KNOWN=0
pass() {
  PASS=$((PASS + 1))
  echo "  [ok]   $*"
}
fail() {
  FAIL=$((FAIL + 1))
  echo "  [FAIL] $*"
}
known() { # a failure caused outside the governance tooling, reported with that cause
  KNOWN=$((KNOWN + 1))
  echo "  [known] $*"
}
phase() {
  echo
  echo "== $*"
}
eq() { # <label> <got> <want>
  if [ "$(printf '%s' "$2" | tr 'A-F' 'a-f')" = "$(printf '%s' "$3" | tr 'A-F' 'a-f')" ]; then pass "$1 = $3"; else fail "$1: got $2, want $3"; fi
}

ANVIL_PID=""
cleanup() {
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$ANVIL_DIR"
}
trap cleanup EXIT

# ── chain helpers (LOCAL only) ──────────────────────────────────────────────
c() { cast call "$@" --rpc-url "$LOCAL" | awk '{print $1}'; }
send_key() { # <key> <to> <sig> [args...]
  local k=$1
  shift
  cast send "$@" --private-key "$k" --rpc-url "$LOCAL" >/dev/null
}
send_as() { # <unlocked from> <to> <sig> [args...]
  local f=$1
  shift
  cast send "$@" --from "$f" --unlocked --rpc-url "$LOCAL" >/dev/null
}
rpc() { cast rpc "$@" --rpc-url "$LOCAL" >/dev/null; }
warp_to() { # <unix timestamp of the next block>
  rpc evm_setNextBlockTimestamp "$1"
  rpc evm_mine
}
now() { cast block latest -f timestamp --rpc-url "$LOCAL"; }

# expect_revert <label> <expected selector or text> <cast call args...>
expect_revert() {
  local label=$1 want=$2
  shift 2
  local out
  if out=$(cast call "$@" --rpc-url "$LOCAL" 2>&1); then
    fail "$label: expected a revert ($want) but the call succeeded"
  elif grep -qi -- "$want" <<<"$out"; then
    pass "$label -> reverts $want"
  else
    fail "$label: reverted, but not with $want: $(head -c 240 <<<"$out" | tr '\n' ' ')"
  fi
}

# expect_send_revert: same, but submitted with cast send from the unlocked account, the
# way a wallet would: the node rejects it at gas estimation with the revert reason.
expect_send_revert() {
  local label=$1 want=$2 from=$3
  shift 3
  local out
  if out=$(cast send "$@" --from "$from" --unlocked --rpc-url "$LOCAL" 2>&1); then
    fail "$label: expected the transaction to revert ($want) but it was mined"
  elif grep -qi -- "$want" <<<"$out"; then
    pass "$label -> sent transaction rejected, $want"
  else
    fail "$label: reverted, but not with $want: $(head -c 240 <<<"$out" | tr '\n' ' ')"
  fi
}

# forge script against the local fork. Broadcast logs go under out-deploy/, never
# into contracts/broadcast/, so nothing here can be mistaken for a mainnet record.
fscript() { # <script path> [forge args...]
  FOUNDRY_BROADCAST="$OUT/rehearsal-broadcast" forge script "$1" --rpc-url "$LOCAL" --out "$OUT" \
    --cache-path "$CACHE_DIR" --skip test "${@:2}"
}

# ── Safe helpers ────────────────────────────────────────────────────────────
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
MULTISEND_CALL_ONLY=0x9641d764fc13c8B624c04430C7356C1C7C8102e2
ZERO=0x0000000000000000000000000000000000000000
GET_HASH="getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)"
EXEC_TX="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"

deploy_safe() { # <salt> <threshold> <owner>...   (prints the proxy address)
  local salt=$1 threshold=$2
  shift 2
  local owners init proxy
  owners="[$(IFS=,; echo "$*")]"
  init=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" \
    "$owners" "$threshold" "$ZERO" 0x "$SAFE_HANDLER" "$ZERO" 0 "$ZERO")
  proxy=$(c "$SAFE_FACTORY" "createProxyWithNonce(address,bytes,uint256)(address)" "$SAFE_L2" "$init" "$salt")
  send_key "$K_FUNDER" "$SAFE_FACTORY" "createProxyWithNonce(address,bytes,uint256)" "$SAFE_L2" "$init" "$salt"
  printf '%s' "$proxy"
}

safe_hash() { # <safe> <to> <data> <operation>
  c "$1" "$GET_HASH" "$2" 0 "$3" "$4" 0 0 0 "$ZERO" "$ZERO" "$(c "$1" 'nonce()(uint256)')"
}

# Signatures of <keys...> over <hash>, concatenated in ascending signer order (Safe rule).
safe_sigs() { # <hash> <key>...
  local h=$1
  shift
  local k lines=""
  for k in "$@"; do
    lines+="$(cast wallet address --private-key "$k" | tr 'A-F' 'a-f') $(cast wallet sign --no-hash --private-key "$k" "$h")"$'\n'
  done
  printf '0x'
  printf '%s' "$lines" | sort | awk 'NF {sub(/^0x/, "", $2); printf "%s", $2}'
}

safe_exec() { # <safe> <to> <data> <operation> <key>...   (first key sends)
  local safe=$1 to=$2 data=$3 op=$4
  shift 4
  local h sigs
  h=$(safe_hash "$safe" "$to" "$data" "$op")
  sigs=$(safe_sigs "$h" "$@")
  send_key "$1" "$safe" "$EXEC_TX" "$to" 0 "$data" "$op" 0 0 0 "$ZERO" "$ZERO" "$sigs"
}

# Safe v1.4.1 "approved hash" signatures (v = 1): the hardware-wallet CLI path in
# docs/GOVERNANCE.md. <approver> calls approveHash, <executor> sends execTransaction;
# one 65-byte entry per owner, ascending: <owner padded to 32 bytes><32 zero bytes><01>.
approved_sigs() { # <owner address>...
  local o
  printf '0x'
  printf '%s\n' "$@" | tr 'A-F' 'a-f' | sort | while read -r o; do
    printf '%064s' "${o#0x}" | tr ' ' 0
    printf '%064d01' 0
  done
}
safe_exec_approved() { # <safe> <to> <data> <operation> <approver key> <executor key>
  local safe=$1 to=$2 data=$3 op=$4 ka=$5 ke=$6 h
  h=$(safe_hash "$safe" "$to" "$data" "$op")
  send_key "$ka" "$safe" "approveHash(bytes32)" "$h"
  send_key "$ke" "$safe" "$EXEC_TX" "$to" 0 "$data" "$op" 0 0 0 "$ZERO" "$ZERO" \
    "$(approved_sigs "$(addr "$ka")" "$(addr "$ke")")"
}

# multiSend(bytes) payload for a Safe Transaction Builder JSON file (all CALL, value 0).
multisend_from_builder() { # <builder json>
  local packed
  packed=$(js -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    let p = "";
    for (const t of j.transactions) {
      const d = t.data.replace(/^0x/, "");
      p += "00" + t.to.replace(/^0x/, "").toLowerCase() + BigInt(t.value).toString(16).padStart(64, "0")
        + (d.length / 2).toString(16).padStart(64, "0") + d;
    }
    console.log("0x" + p);' "$1")
  cast calldata "multiSend(bytes)" "$packed"
}

field() { # <forge output file> <MARKER>   -> value after "MARKER "
  grep -o "$2 0x[0-9a-fA-F]*" "$1" | head -1 | awk '{print $2}'
}

# ── 0. fork ─────────────────────────────────────────────────────────────────
mkdir -p "$ANVIL_DIR"
echo "SPARE governance rehearsal - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  repo HEAD  $(git -C "$SPARE_ROOT" rev-parse --short HEAD) (working tree may carry uncommitted changes)"
echo "  forge      $(forge --version | head -1)"
echo "  fork of    <RHC_RPC_URL> (chain 4663)"
anvil --fork-url "$FORK_URL" --port "$PORT" --chain-id 4663 >"$ANVIL_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" >"$ANVIL_DIR/anvil.pid"
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break
  sleep 1
done
CLIENT=$(cast rpc web3_clientVersion --rpc-url "$LOCAL" 2>/dev/null || true)
CHAIN=$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null || true)
grep -qi anvil <<<"$CLIENT" || die "local node at $LOCAL is not anvil ($CLIENT); refusing to send anything"
[ "$CHAIN" = "4663" ] || die "local fork chain id $CHAIN, expected 4663"
FORK_BLOCK=$(cast block-number --rpc-url "$LOCAL")
echo "  local node $CLIENT at $LOCAL, chain $CHAIN, forked at block $FORK_BLOCK, time $(now)"

book() { js -e 'const j = JSON.parse(require("fs").readFileSync("addresses/4663.json", "utf8"));
  console.log(process.argv[1].split(".").reduce((o, k) => o[k], j));' "$1"; }
OWNER=$(book roles.owner)
KEEPER=$(book roles.keeper)
USDG=$(book external.USDG)
PERMIT2=$(book external.Permit2)
SPY=$(book assets.SPY)
NAMES=(AssetRegistry ElectionRegistry ScreeningGate StockRouter CashPark FeeVault SweepExecutor)
declare -A A
for n in "${NAMES[@]}" RuleRegistry; do A[$n]=$(book "contracts.$n"); done

# Test-only keys, derived from public labels. Fork use only; never printed.
key() { cast keccak "spare-governance-rehearsal/$1"; }
K_FUNDER=$(key funder)
K_O1=$(key owner-signer-1)
K_O2=$(key owner-signer-2)
K_O3=$(key owner-signer-3)
K_P1=$(key pauser-signer-1)
K_P2=$(key pauser-signer-2)
K_USER=$(key user)
addr() { cast wallet address --private-key "$1"; }
USER=$(addr "$K_USER")
for k in "$K_FUNDER" "$K_O1" "$K_O2" "$K_O3" "$K_P1" "$K_P2" "$K_USER"; do
  rpc anvil_setBalance "$(addr "$k")" 0x56BC75E2D63100000 # 100 ETH, fork only
done
for a in "$OWNER" "$KEEPER"; do
  rpc anvil_impersonateAccount "$a"
  rpc anvil_setBalance "$a" 0x56BC75E2D63100000
done

phase "0. baseline: VerifyDeployment on the fork, current roles"
# Also warms the fork's state cache while the fork block is fresh: the public RPC keeps
# only recent state, and step 12 re-reads the same slots minutes later.
G="$OUT/.rehearsal-forge.log"
if SPARE_CONFIG=config/4663.json SPARE_CONFIG_JSON="$(cat config/4663.json)" \
  fscript script/VerifyDeployment.s.sol >"$G" 2>&1; then
  grep -E "SUMMARY|VerifyDeployment: PASS" "$G" | grep -v "console::log" | sed 's/^ */  | /'
  pass "VerifyDeployment PASS on the fork before the hand-over (owner = pauser = attestor = EOA)"
else
  grep -E "\[FAIL\]|SUMMARY|Error" "$G" | grep -v "console::log" | sed 's/^ */  | /' || true
  die "VerifyDeployment fails on the fork BEFORE the hand-over; nothing below would mean anything"
fi

phase "1. Safes (canonical Safe v1.4.1 factory + SafeL2 singleton, on the fork)"
OSAFE=$(deploy_safe 4663001 2 "$(addr "$K_O1")" "$(addr "$K_O2")" "$(addr "$K_O3")")
PSAFE=$(deploy_safe 4663002 1 "$(addr "$K_P1")" "$(addr "$K_P2")")
echo "  owner Safe  $OSAFE  2 of 3: $(cast call "$OSAFE" 'getOwners()(address[])' --rpc-url "$LOCAL")"
echo "  pauser Safe $PSAFE  1 of 2: $(cast call "$PSAFE" 'getOwners()(address[])' --rpc-url "$LOCAL")"
eq "owner Safe threshold" "$(c "$OSAFE" 'getThreshold()(uint256)')" 2
eq "pauser Safe threshold" "$(c "$PSAFE" 'getThreshold()(uint256)')" 1

phase "2. a user with spare change in CashPark (before the hand-over, system live)"
fund_usdg "$LOCAL" "$USER" 50000000 2>&1 | sed 's/^/  /'
send_key "$K_USER" "${A[RuleRegistry]}" "setRule(uint8,uint8,uint64,bool)" 1 1 100000000 true
send_key "$K_USER" "${A[RuleRegistry]}" "linkSelf()"
send_key "$K_USER" "$USDG" "approve(address,uint256)" "$PERMIT2" 50000000
EXPIRY=$(($(now) + 30 * 86400))
send_key "$K_USER" "$PERMIT2" "approve(address,address,uint160,uint48)" "$USDG" "${A[SweepExecutor]}" 20000000 "$EXPIRY"
rpc anvil_mine 0xBB9 # 3001 blocks: past SweepExecutor.finalityBuffer (3000)
HEAD=$(cast block-number --rpc-url "$LOCAL")
TO_BLOCK=$((HEAD - 3000))
send_as "$KEEPER" "${A[SweepExecutor]}" "accrue(address,address,uint256,uint256)" "$USER" "$USER" 7000000 "$TO_BLOCK"
eq "CashPark.pending(user) after keeper accrue" "$(c "${A[CashPark]}" 'pending(address)(uint256)' "$USER")" 7000000
USER_USDG_BEFORE=$(c "$USDG" 'balanceOf(address)(uint256)' "$USER")

phase "3. DeployTimelock - guards (dry runs, nothing sent)"
if SPARE_OWNER_SAFE=$OSAFE SPARE_TIMELOCK_DELAY=3600 fscript script/governance/DeployTimelock.s.sol --sender "$OWNER" >"$G" 2>&1; then
  fail "DeployTimelock accepted a 1 h delay"
else
  grep -q "below 48 h" "$G" && pass "DeployTimelock refuses SPARE_TIMELOCK_DELAY=3600 (below 48 h)" || fail "DeployTimelock 1 h: wrong refusal"
fi
if SPARE_OWNER_SAFE=$PSAFE fscript script/governance/DeployTimelock.s.sol --sender "$OWNER" >"$G" 2>&1; then
  fail "DeployTimelock accepted a 1-of-2 Safe as the owner Safe"
else
  grep -q "\[FAIL\] threshold 1 of 2" "$G" && pass "DeployTimelock refuses a 1-of-2 owner Safe (policy 2 of 3)" || fail "DeployTimelock 1-of-2: wrong refusal"
fi

phase "4. DeployTimelock - broadcast by the owner EOA (to the local fork)"
SPARE_OWNER_SAFE=$OSAFE SPARE_MAINNET_ACK=owner-approved \
  fscript script/governance/DeployTimelock.s.sol --broadcast --unlocked --sender "$OWNER" >"$G" 2>&1 ||
  {
    cat "$G"
    die "DeployTimelock failed"
  }
grep -E "^\s+(\[ok\]|\[FAIL\]|\[warn\]|SUMMARY|TimelockController:)" "$G" | sed 's/^ */  | /'
TL=$(grep -o "export SPARE_TIMELOCK=0x[0-9a-fA-F]*" "$G" | head -1 | cut -d= -f2)
TL_BLOCK=$(grep -o "export SPARE_TIMELOCK_BLOCK=[0-9]*" "$G" | head -1 | cut -d= -f2)
[ -n "$TL" ] && [ "$(cast code "$TL" --rpc-url "$LOCAL")" != "0x" ] && pass "TimelockController deployed at $TL (scan from block $TL_BLOCK)" ||
  die "no timelock deployed"
eq "timelock minDelay" "$(c "$TL" 'getMinDelay()(uint256)')" 172800
export SPARE_TIMELOCK=$TL SPARE_TIMELOCK_BLOCK=$TL_BLOCK SPARE_OWNER_SAFE=$OSAFE

phase "5. HandOver - guard, then broadcast by the owner EOA, then idempotence"
if SPARE_PAUSER_SAFE=$OSAFE fscript script/governance/HandOver.s.sol --sender "$OWNER" >"$G" 2>&1; then
  fail "HandOver accepted pauser Safe = owner Safe"
else
  grep -q "\[FAIL\] pauser Safe is not the owner Safe" "$G" && pass "HandOver refuses pauser Safe = owner Safe" || fail "HandOver pauser=owner: wrong refusal"
fi
SPARE_PAUSER_SAFE=$PSAFE SPARE_MAINNET_ACK=owner-approved \
  fscript script/governance/HandOver.s.sol --broadcast --unlocked --sender "$OWNER" >"$G" 2>&1 ||
  {
    cat "$G"
    die "HandOver failed"
  }
grep -E "^\s+(\[FAIL\]|\[warn\]|SUMMARY)|live role holder|RoleGranted scan|is not the owner Safe|is not the timelock|attestor is not" "$G" |
  sed 's/^ */  | /'
grep -q "SUMMARY: .* 0 failed, .* 15 call(s) sent; 7/7 awaiting" "$G" && pass "HandOver sent 15 calls (7 setPauser, 1 setAttestor, 7 transferOwnership)" ||
  fail "HandOver summary unexpected: $(grep SUMMARY "$G")"
for n in "${NAMES[@]}"; do
  [ "$(c "${A[$n]}" 'pendingOwner()(address)')" = "$TL" ] && [ "$(c "${A[$n]}" 'owner()(address)')" = "$OWNER" ] &&
    [ "$(c "${A[$n]}" 'pauser()(address)')" = "$PSAFE" ] && pass "$n: owner still EOA, pendingOwner = timelock, pauser = pauser Safe" ||
    fail "$n: owner/pendingOwner/pauser not as expected"
done
eq "ScreeningGate.attestor" "$(c "${A[ScreeningGate]}" 'attestor()(address)')" "$PSAFE"
SPARE_PAUSER_SAFE=$PSAFE SPARE_MAINNET_ACK=owner-approved \
  fscript script/governance/HandOver.s.sol --broadcast --unlocked --sender "$OWNER" >"$G" 2>&1 || {
  cat "$G"
  die "HandOver re-run failed"
}
grep -q " 0 call(s) sent" "$G" && pass "HandOver re-run is idempotent: 0 calls sent" || fail "HandOver re-run sent calls"

phase "5b. AcceptOwnership with the timelock as pending owner (a direct Safe batch would revert)"
fscript script/AcceptOwnership.s.sol >"$G" 2>&1 || {
  cat "$G"
  die "AcceptOwnership dry run failed"
}
grep -E "pending -> |is a TimelockController|Only the timelock|TimelockBatch.s.sol" "$G" | grep -v "console::log" | sed 's/^ */  | /'
grep -q "The pending owner $TL is a TimelockController (minDelay 172800 s)" "$G" &&
  pass "AcceptOwnership names the timelock as the pending owner" || fail "AcceptOwnership did not detect the timelock"
grep -q "Safe Transaction Builder batch JSON" "$G" &&
  fail "AcceptOwnership printed a direct Safe batch (the Safe is not the pending owner)" ||
  pass "AcceptOwnership prints no direct Safe batch"
grep -q "forge script script/governance/TimelockBatch.s.sol" "$G" &&
  pass "AcceptOwnership points to TimelockBatch.s.sol" || fail "AcceptOwnership gave no TimelockBatch pointer"
if fscript script/AcceptOwnership.s.sol --broadcast --unlocked --sender "$OWNER" >"$G" 2>&1; then
  fail "AcceptOwnership --broadcast went through with the timelock as pending owner"
else
  grep -q "no key can accept for it" "$G" && pass "AcceptOwnership --broadcast refused: no key can accept for the timelock" ||
    fail "AcceptOwnership --broadcast: wrong refusal"
fi
eq "CashPark.pendingOwner() after both AcceptOwnership runs" "$(c "${A[CashPark]}" 'pendingOwner()(address)')" "$TL"

phase "6. TimelockBatch (acceptOwnership x7) and scheduling through the owner Safe"
fscript script/governance/TimelockBatch.s.sol >"$G" 2>&1 || {
  cat "$G"
  die "TimelockBatch failed"
}
OP=$(field "$G" OPERATION_ID)
SCHED=$(field "$G" SCHEDULE_DATA)
EXEC=$(field "$G" EXECUTE_DATA)
GEN_HASH=$(field "$G" SCHEDULE_SAFE_TX_HASH)
echo "  operation $OP"
echo "  Safe Transaction Builder JSON (schedule), as generated:"
grep -A1 "JSON - SCHEDULE" "$G" | tail -1 | sed 's/^ */    /'
eq "generator's SCHEDULE_SAFE_TX_HASH vs Safe.getTransactionHash" "$GEN_HASH" "$(safe_hash "$OSAFE" "$TL" "$SCHED" 0)"
expect_revert "old owner EOA calls timelock.scheduleBatch itself" 0xe2517d3f "$TL" "$SCHED" --from "$OWNER"
H=$(safe_hash "$OSAFE" "$TL" "$SCHED" 0)
expect_revert "owner Safe execTransaction with 1 of 3 signatures" GS020 "$OSAFE" "$EXEC_TX" "$TL" 0 "$SCHED" 0 0 0 0 "$ZERO" "$ZERO" \
  "$(safe_sigs "$H" "$K_O1")" --from "$(addr "$K_O1")"
safe_exec "$OSAFE" "$TL" "$SCHED" 0 "$K_O1" "$K_O2"
SCHEDULED_AT=$(now)
eq "operation state after the Safe schedules (1 = Waiting)" "$(c "$TL" 'getOperationState(bytes32)(uint8)' "$OP")" 1
eq "operation ready-at timestamp" "$(c "$TL" 'getTimestamp(bytes32)(uint256)' "$OP")" "$((SCHEDULED_AT + 172800))"

phase "7. the 48 h delay"
expect_revert "execute right after scheduling" 0x5ead8eb5 "$TL" "$EXEC" --from "$OSAFE"
eq "CashPark.owner() during the delay (EOA keeps control until acceptance)" "$(c "${A[CashPark]}" 'owner()(address)')" "$OWNER"
READY=$(c "$TL" 'getTimestamp(bytes32)(uint256)' "$OP")
warp_to $((READY - 120))
expect_revert "execute at 48 h - 2 min (block time $((READY - 120)))" 0x5ead8eb5 "$TL" "$EXEC" --from "$OSAFE"
warp_to "$READY"
safe_exec "$OSAFE" "$TL" "$EXEC" 0 "$K_O2" "$K_O3"
eq "operation state after execute (3 = Done)" "$(c "$TL" 'getOperationState(bytes32)(uint8)' "$OP")" 3
for n in "${NAMES[@]}"; do
  [ "$(c "${A[$n]}" 'owner()(address)')" = "$TL" ] && [ "$(c "${A[$n]}" 'pendingOwner()(address)')" = "$ZERO" ] &&
    pass "$n: owner = timelock, no pending owner" || fail "$n: not owned by the timelock"
done

phase "8. the old owner EOA has no power left"
UA=0x118cdaa7 # OwnableUnauthorizedAccount(address)
expect_send_revert "EOA CashPark.setExecutor(EOA) - the drain path" "$UA" "$OWNER" "${A[CashPark]}" "setExecutor(address)" "$OWNER"
eq "CashPark.executor() unchanged" "$(c "${A[CashPark]}" 'executor()(address)')" "${A[SweepExecutor]}"
expect_revert "EOA CashPark.setAdapter" "$UA" "${A[CashPark]}" "setAdapter(address)" "$OWNER" --from "$OWNER"
expect_revert "EOA AssetRegistry.setActive(SPY,false)" "$UA" "${A[AssetRegistry]}" "setActive(address,bool)" "$SPY" false --from "$OWNER"
expect_revert "EOA ElectionRegistry.setDefaultMix" "$UA" "${A[ElectionRegistry]}" "setDefaultMix((address,uint16)[])" "[($SPY,10000)]" --from "$OWNER"
expect_revert "EOA ScreeningGate.setEnforced(true)" "$UA" "${A[ScreeningGate]}" "setEnforced(bool)" true --from "$OWNER"
expect_revert "EOA ScreeningGate.setAttestor" "$UA" "${A[ScreeningGate]}" "setAttestor(address)" "$OWNER" --from "$OWNER"
expect_revert "EOA ScreeningGate.revoke (attestor-or-owner)" 0xdde328f8 "${A[ScreeningGate]}" "revoke(address)" "$USER" --from "$OWNER"
expect_revert "EOA StockRouter.setCaller(EOA,true)" "$UA" "${A[StockRouter]}" "setCaller(address,bool)" "$OWNER" true --from "$OWNER"
expect_revert "EOA StockRouter.setSequencerFeed" "$UA" "${A[StockRouter]}" "setSequencerFeed(address)" "$OWNER" --from "$OWNER"
expect_revert "EOA FeeVault.withdraw" "$UA" "${A[FeeVault]}" "withdraw(address,address,uint256)" "$USDG" "$OWNER" 1 --from "$OWNER"
expect_revert "EOA SweepExecutor.setParams(fee 1%, slippage 5%)" "$UA" "${A[SweepExecutor]}" "setParams(uint256,uint256,uint16,uint16,uint64)" 3000 5000000 100 500 86400 --from "$OWNER"
expect_revert "EOA SweepExecutor.setKeeper(EOA,true)" "$UA" "${A[SweepExecutor]}" "setKeeper(address,bool)" "$OWNER" true --from "$OWNER"
for n in "${NAMES[@]}"; do
  expect_revert "EOA $n.setPauser" "$UA" "${A[$n]}" "setPauser(address)" "$OWNER" --from "$OWNER"
  expect_revert "EOA $n.transferOwnership" "$UA" "${A[$n]}" "transferOwnership(address)" "$OWNER" --from "$OWNER"
  expect_revert "EOA $n.pause (neither pauser nor owner)" 0x492f6781 "${A[$n]}" "pause()" --from "$OWNER"
done
expect_revert "owner Safe calling CashPark.setExecutor directly (bypassing the timelock)" "$UA" "${A[CashPark]}" "setExecutor(address)" "$OSAFE" --from "$OSAFE"
expect_revert "owner Safe calling SweepExecutor.setKeeper directly" "$UA" "${A[SweepExecutor]}" "setKeeper(address,bool)" "$OSAFE" true --from "$OSAFE"

phase "9. the pauser Safe pauses instantly (deployments/4663-pauser-pause-all.json, 1 of 2)"
MS=$(multisend_from_builder deployments/4663-pauser-pause-all.json)
B0=$(cast block-number --rpc-url "$LOCAL")
safe_exec "$PSAFE" "$MULTISEND_CALL_ONLY" "$MS" 1 "$K_P1"
B1=$(cast block-number --rpc-url "$LOCAL")
echo "  pause tx mined in block $B1 (head before it: $B0): no delay, one signature"
for n in "${NAMES[@]}"; do eq "$n.paused() right after the pause tx" "$(c "${A[$n]}" 'paused()(bool)')" true; done
expect_revert "keeper SweepExecutor.sweep while paused" 0x1309a563 "${A[SweepExecutor]}" "sweep(address[],(address,uint256)[])" "[$USER]" "[]" --from "$KEEPER"
expect_revert "keeper SweepExecutor.accrue while paused" 0x1309a563 "${A[SweepExecutor]}" "accrue(address,address,uint256,uint256)" "$USER" "$USER" 1 "$TO_BLOCK" --from "$KEEPER"
expect_revert "keeper CashPark.park while paused" 0x1309a563 "${A[CashPark]}" "park(address[])" "[$USER]" --from "$KEEPER"
expect_revert "pauser Safe cannot unpause (owner-only)" "$UA" "${A[SweepExecutor]}" "unpause()" --from "$PSAFE"

phase "10. exit is never gated: the user withdraws while everything is paused"
send_key "$K_USER" "${A[CashPark]}" "exit()"
eq "CashPark.pending(user) after exit" "$(c "${A[CashPark]}" 'pending(address)(uint256)' "$USER")" 0
eq "user USDG gained by exit()" "$(($(c "$USDG" 'balanceOf(address)(uint256)' "$USER") - USER_USDG_BEFORE))" 7000000

phase "11. owner actions now run only through the timelock: unpause x7"
CALLS=$(js -e 'console.log(JSON.stringify(process.argv.slice(1).map((to) => ({ to, data: "0x3f4ba83a" }))))' \
  "${A[AssetRegistry]}" "${A[ElectionRegistry]}" "${A[ScreeningGate]}" "${A[StockRouter]}" "${A[CashPark]}" "${A[FeeVault]}" "${A[SweepExecutor]}")
if SPARE_TIMELOCK_CALLS_JSON=$CALLS fscript script/governance/TimelockBatch.s.sol >"$G" 2>&1; then
  fail "TimelockBatch accepted a custom batch without SPARE_TIMELOCK_SALT"
else
  grep -q "needs SPARE_TIMELOCK_SALT" "$G" && pass "TimelockBatch refuses a custom batch without a salt label" || fail "custom batch without salt: wrong refusal"
fi
SPARE_TIMELOCK_CALLS_JSON=$CALLS SPARE_TIMELOCK_SALT="rehearsal: unpause x7" \
  fscript script/governance/TimelockBatch.s.sol >"$G" 2>&1 || {
  cat "$G"
  die "TimelockBatch (unpause) failed"
}
OP2=$(field "$G" OPERATION_ID)
SCHED2=$(field "$G" SCHEDULE_DATA)
EXEC2=$(field "$G" EXECUTE_DATA)
SHORT=$(cast calldata "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)" \
  "[${A[SweepExecutor]}]" "[0]" "[0x3f4ba83a]" 0x0000000000000000000000000000000000000000000000000000000000000000 \
  "$(cast keccak short)" 3600)
expect_revert "owner Safe schedules with a 1 h delay" 0x54336609 "$TL" "$SHORT" --from "$OSAFE"
H2=$(safe_hash "$OSAFE" "$TL" "$SCHED2" 0)
expect_revert "approved-hash signatures where the other owner never approved" GS025 "$OSAFE" "$EXEC_TX" "$TL" 0 "$SCHED2" 0 0 0 0 \
  "$ZERO" "$ZERO" "$(approved_sigs "$(addr "$K_O2")" "$(addr "$K_O3")")" --from "$(addr "$K_O3")"
safe_exec_approved "$OSAFE" "$TL" "$SCHED2" 0 "$K_O1" "$K_O3"
pass "unpause batch scheduled through the CLI path: signer 1 approveHash($H2), signer 3 execTransaction"
expect_revert "unpause executed immediately" 0x5ead8eb5 "$TL" "$EXEC2" --from "$OSAFE"
READY2=$(c "$TL" 'getTimestamp(bytes32)(uint256)' "$OP2")
eq "unpause operation state after scheduling (1 = Waiting)" "$(c "$TL" 'getOperationState(bytes32)(uint8)' "$OP2")" 1
warp_to $((READY2 - 60))
expect_revert "unpause executed at 48 h - 1 min (block time $((READY2 - 60)))" 0x5ead8eb5 "$TL" "$EXEC2" --from "$OSAFE"
warp_to "$READY2"
expect_revert "executeBatch by a non-executor (the old EOA)" 0xe2517d3f "$TL" "$EXEC2" --from "$OWNER"
safe_exec "$OSAFE" "$TL" "$EXEC2" 0 "$K_O1" "$K_O2"
eq "unpause operation state (3 = Done)" "$(c "$TL" 'getOperationState(bytes32)(uint8)' "$OP2")" 3
for n in "${NAMES[@]}"; do eq "$n.paused() after the timelocked unpause" "$(c "${A[$n]}" 'paused()(bool)')" false; done

phase "12. VerifyDeployment against the post-hand-over roles (SPARE_REQUIRE_ACCEPTED=true)"
CFG=$(js -e '
  const j = JSON.parse(require("fs").readFileSync("config/4663.json", "utf8"));
  j.roles.owner = process.argv[1]; j.roles.pauser = process.argv[2]; j.roles.attestor = process.argv[2];
  console.log(JSON.stringify(j));' "$TL" "$PSAFE")
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
ALLOW_PARK=$(c "$USDG" 'allowance(address,address)(uint256)' "${A[SweepExecutor]}" "${A[CashPark]}")
echo "  SweepExecutor -> CashPark USDG allowance now $ALLOW_PARK"
eq "max - that allowance (USDG CashPark.credit pulled in step 2)" \
  "$(js -e 'console.log((BigInt(process.argv[1]) - BigInt(process.argv[2])).toString())' "$MAX" "$ALLOW_PARK")" 7000000
VERIFY_OK=0
SPARE_CONFIG=config/4663.json SPARE_CONFIG_JSON="$CFG" SPARE_REQUIRE_ACCEPTED=true \
  fscript script/VerifyDeployment.s.sol >"$G" 2>&1 && VERIFY_OK=1
grep -E "pauser = config pauser|owner = config owner|attestor = config|SUMMARY|VerifyDeployment: |\[FAIL\]|^Error|database error" "$G" |
  grep -v "console::log" | sort -u | cut -c1-240 | sed 's/^ */  | /' || true
if [ $VERIFY_OK = 1 ]; then
  pass "VerifyDeployment: PASS with owner = timelock, pauser = attestor = pauser Safe"
else
  OTHER=$(grep "\[FAIL\]" "$G" | grep -v "console::log" | grep -v "USDG allowance = max" || true)
  if [ -z "$OTHER" ] && grep -q "ownership pending acceptance on 0/7" "$G"; then
    pass "VerifyDeployment: every role, ownership (0/7 pending) and wiring check passes except the allowance one below"
    known "VerifyDeployment fails only 'USDG allowance = max'. USDG decrements even an unlimited allowance on transferFrom, so the exact-max check fails after ANY accrual or sweep, on mainnet too; not a hand-over effect (script/lib/SpareBase.sol accepts >= max/2 since 2026-10-02)"
  else
    fail "VerifyDeployment failed against the post-hand-over roles: $OTHER"
  fi
fi

phase "13. live role inventory after the hand-over (contracts/scripts/roles.sh)"
SPARE_TIMELOCK=$TL SPARE_TIMELOCK_BLOCK=$TL_BLOCK "$CONTRACTS/scripts/roles.sh" "$LOCAL" 2>&1 | sed 's/^/  | /'

phase "14. AddAssets with the timelock as registry owner: activate the standby asset QQQ"
QQQ=$(book assets.QQQ)
CFG_QQQ=$(js -e '
  const j = JSON.parse(require("fs").readFileSync("config/4663.json", "utf8"));
  j.assets.find((a) => a.symbol === "QQQ").active = true;
  console.log(JSON.stringify(j));')
addassets() { SPARE_CONFIG=config/4663.json SPARE_CONFIG_JSON="$CFG_QQQ" fscript script/AddAssets.s.sol "$@"; }
eq "AssetRegistry.isEligible(QQQ) before (standby)" "$(c "${A[AssetRegistry]}" 'isEligible(address)(bool)' "$QQQ")" false
if addassets --broadcast --unlocked --sender "$OWNER" >"$G" 2>&1; then
  fail "AddAssets --broadcast went through with the timelock as registry owner"
else
  grep -q "the AssetRegistry owner is a contract (the timelock): no key can send its calls" "$G" &&
    pass "AddAssets --broadcast refused: no key can send the timelock's calls" || fail "AddAssets --broadcast: wrong refusal"
fi
addassets >"$G" 2>&1 || {
  cat "$G"
  die "AddAssets dry run (timelock owner) failed"
}
grep -E "^\s+(owner|sender) |\[[0-9]+\] AssetRegistry\.|why: |Simulated the|TIMELOCK_SALT |is a TimelockController" "$G" |
  grep -v "console::log" | cut -c1-240 | sed 's/^ */  | /'
CALLS_QQQ=$(grep -o "TIMELOCK_CALLS_JSON \[.*\]" "$G" | head -1 | cut -d' ' -f2-)
SALT_QQQ=$(grep -o "TIMELOCK_SALT .*" "$G" | head -1 | cut -d' ' -f2- | tr -d '\r')
echo "  TIMELOCK_CALLS_JSON $CALLS_QQQ"
eq "AddAssets TIMELOCK_CALLS_JSON" "$CALLS_QQQ" \
  "[{\"to\":\"${A[AssetRegistry]}\",\"value\":\"0\",\"data\":\"$(cast calldata 'setActive(address,bool)' "$QQQ" true)\"}]"
grep -q "Simulated the 1 call(s) above as the owner $TL, in order: registry matches config" "$G" &&
  pass "AddAssets simulated the batch as the timelock: registry matches the config" || fail "AddAssets did not simulate the batch as the timelock"
SPARE_TIMELOCK_CALLS_JSON=$CALLS_QQQ SPARE_TIMELOCK_SALT=$SALT_QQQ \
  fscript script/governance/TimelockBatch.s.sol >"$G" 2>&1 || {
  cat "$G"
  die "TimelockBatch (AddAssets batch) failed"
}
grep -E "== batch: |AssetRegistry 0x|  state " "$G" | grep -v "console::log" | sed 's/^ */  | /'
OP3=$(field "$G" OPERATION_ID)
SCHED3=$(field "$G" SCHEDULE_DATA)
EXEC3=$(field "$G" EXECUTE_DATA)
eq "generator's SCHEDULE_SAFE_TX_HASH vs Safe.getTransactionHash" "$(field "$G" SCHEDULE_SAFE_TX_HASH)" \
  "$(safe_hash "$OSAFE" "$TL" "$SCHED3" 0)"
safe_exec "$OSAFE" "$TL" "$SCHED3" 0 "$K_O1" "$K_O3"
eq "AddAssets operation state after the Safe schedules (1 = Waiting)" "$(c "$TL" 'getOperationState(bytes32)(uint8)' "$OP3")" 1
expect_revert "AddAssets batch executed right after scheduling" 0x5ead8eb5 "$TL" "$EXEC3" --from "$OSAFE"
READY3=$(c "$TL" 'getTimestamp(bytes32)(uint256)' "$OP3")
warp_to $((READY3 - 60))
expect_revert "AddAssets batch executed at 48 h - 1 min (block time $((READY3 - 60)))" 0x5ead8eb5 "$TL" "$EXEC3" --from "$OSAFE"
eq "AssetRegistry.isEligible(QQQ) during the delay" "$(c "${A[AssetRegistry]}" 'isEligible(address)(bool)' "$QQQ")" false
warp_to "$READY3"
safe_exec "$OSAFE" "$TL" "$EXEC3" 0 "$K_O2" "$K_O3"
eq "AddAssets operation state (3 = Done)" "$(c "$TL" 'getOperationState(bytes32)(uint8)' "$OP3")" 3
eq "AssetRegistry.isEligible(QQQ) after the timelocked batch" "$(c "${A[AssetRegistry]}" 'isEligible(address)(bool)' "$QQQ")" true
addassets >"$G" 2>&1 || {
  cat "$G"
  die "AddAssets re-run failed"
}
grep -q "AddAssets: 0 actions - registry already matches config" "$G" &&
  pass "AddAssets re-run: 0 actions, the registry matches the QQQ-active config" || fail "AddAssets re-run still plans actions"

echo
echo "REHEARSAL SUMMARY: $PASS passed, $FAIL failed, $KNOWN known (caused outside the governance tooling) (fork block $FORK_BLOCK, chain 4663, local anvil only)"
[ "$FAIL" -eq 0 ] || exit 1
