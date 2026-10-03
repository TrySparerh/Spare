#!/usr/bin/env bash
# dev-smoke.sh — end-to-end smoke of the local SPARE dev fork (scripts/dev-fork.sh).
#
# Two fresh users (anvil #7, #8) are funded, link their own wallet, set a $1 / 1x /
# $50-a-week rule and grant SweepExecutor a capped Permit2 allowance. The chain is
# mined past the finality buffer, the keeper (anvil #2) accrues $6 and $12, and ONE
# netted sweep buys the default 60/40 SPY/NVDA mix through the real v4 pools,
# checked against the real Chainlink feeds. DevSmoke.report() then fails unless
# every leg either converted (fresh oracle) or was deferred back to the park
# (stale oracle, e.g. a weekend fork). A safe-settled leg fails the smoke.
#
# The sweep is sent with an explicit gas limit (SWEEP_GAS_LIMIT, default 8M), as
# the production keeper must: the NVDA pool's hook charges ~3% on swaps from
# low-gas-limit transactions (see DevSmoke.s.sol and docs/RUNBOOK.md).
#
# The dev users alice and bob (fresh keys, see dev-fork.sh) are left untouched. #7 and
# #8 are anvil's public keys: dev-fork.sh clears any mainnet EIP-7702 code from them
# on the fork, and they only ever hold fork funds. Re-running in the same
# epoch accrues again but sweeps nothing (one sweep per account per epoch); after
# four runs the $50 weekly cap stops further accruals — use dev-fork.sh --reset.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
need cast
need forge

PORT=${ANVIL_PORT:-8545}
LOCAL="http://127.0.0.1:$PORT"
[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null || true)" = "31337" ] || die "no SPARE dev fork on $LOCAL (run scripts/dev-fork.sh)"
[ -f "$CONTRACTS/addresses/31337.json" ] || die "contracts/addresses/31337.json missing (run scripts/dev-fork.sh)"
export SPARE_CONFIG=config/31337.json
STATE="$SPARE_ROOT/scripts/.dev-fork"
mkdir -p "$STATE"

U1_PK=$(anvil_key 7)
U2_PK=$(anvil_key 8)
U1=$(key_addr "$U1_PK")
U2=$(key_addr "$U2_PK")
export SMOKE_USER_PKS="$U1_PK,$U2_PK"
export SMOKE_KEEPER_PK
SMOKE_KEEPER_PK=$(anvil_key 2)

run() { # phase, extra forge args...
  local phase=$1
  shift
  spare_forge DevSmoke --sig "$phase()" --rpc-url "$LOCAL" "$@" >"$STATE/smoke-$phase.log" 2>&1 || {
    tail -n 40 "$STATE/smoke-$phase.log" >&2
    die "DevSmoke.$phase failed (log: scripts/.dev-fork/smoke-$phase.log)"
  }
}

log "smoke: funding $U1 and $U2 with 100 USDG"
fund_usdg "$LOCAL" "$U1" 100000000
fund_usdg "$LOCAL" "$U2" 100000000

log "smoke: onboarding (approve Permit2, capped allowance, linkSelf, setRule)"
run onboard --broadcast

exec_addr=$(json_get contracts/addresses/31337.json contracts.SweepExecutor)
buf=$(cast call "$exec_addr" "finalityBuffer()(uint256)" --rpc-url "$LOCAL" | awk '{print $1}')
log "smoke: mining $((buf + 10)) blocks past the finality buffer"
cast rpc anvil_mine "$(printf '0x%x' $((buf + 10)))" --rpc-url "$LOCAL" >/dev/null

log "smoke: keeper accrues \$6 and \$12"
run accrue --broadcast
grep -E "accrued to block|park value" "$STATE/smoke-accrue.log" | sed 's/^ */  /' >&2 || true

gas=${SWEEP_GAS_LIMIT:-8000000}
log "smoke: one netted sweep of both users (gas limit $gas)"
cast send "$exec_addr" "sweep(address[])" "[$U1,$U2]" --private-key "$SMOKE_KEEPER_PK" \
  --gas-limit "$gas" --rpc-url "$LOCAL" --json >"$STATE/sweep-receipt.json" || die "sweep transaction failed"
[ "$(json_get scripts/.dev-fork/sweep-receipt.json status)" = "0x1" ] || die "sweep reverted (scripts/.dev-fork/sweep-receipt.json)"
blk=$(json_get scripts/.dev-fork/sweep-receipt.json blockNumber)
log "  sweep tx $(json_get scripts/.dev-fork/sweep-receipt.json transactionHash) (block $((blk)), gas used $(($(json_get scripts/.dev-fork/sweep-receipt.json gasUsed))))"
settled=$(cast logs --rpc-url "$LOCAL" --address "$exec_addr" --from-block "$((blk))" --to-block "$((blk))" \
  "SafeSettled(address indexed,address indexed,uint256,string)" 2>/dev/null | grep -c "transactionHash" || true)
[ "${settled:-0}" = "0" ] || warn "  $settled SafeSettled event(s) in the sweep: a leg was paid out as USDG"

log "smoke: on-chain result"
run report
sed -n '/== Logs ==/,$p' "$STATE/smoke-report.log" | sed '1d' | sed '/^$/N;/^\n$/D' | grep -v "^Error" >&2 || true
log "smoke: PASS"
