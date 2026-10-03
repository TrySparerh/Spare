# shellcheck shell=bash
# Shared helpers for the SPARE shell scripts. Source, don't execute.

SPARE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS="$SPARE_ROOT/contracts"
export PATH="$HOME/.foundry/bin:$PATH"

PUBLIC_RHC_RPC="https://rpc.mainnet.chain.robinhood.com"
USDG="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
# Balance mapping slot of the USDG (Paxos) implementation, verified 2026-09-29 by
# matching keccak(holder . 1) against balanceOf. Used only as a funding fallback.
USDG_BALANCE_SLOT=1
# A large plain-EOA USDG holder found by scanning mainnet USDG Transfer logs on
# 2026-09-29 (~9.95M USDG, no code). Impersonated on the fork to fund test users.
DEFAULT_USDG_WHALE="0xf70da97812cb96acdf810712aa562db8dfa3dbef"
# anvil's well-known PUBLIC test mnemonic. These keys are for local forks only.
ANVIL_MNEMONIC="test test test test test test test test test test test junk"

log() { printf '\033[1;36m[spare]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[spare] %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[1;31m[spare] %s\033[0m\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' (Foundry lives in ~/.foundry/bin; JSON helpers need bun or node)"; }

js() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  elif command -v node >/dev/null 2>&1; then
    node "$@"
  else
    die "need bun or node for scripts/lib/spare-json.mjs"
  fi
}

# json_get <file> <dot.path>   (paths are passed relative to SPARE_ROOT so Windows
# runtimes never see an MSYS-style /c/... path)
json_get() { (cd "$SPARE_ROOT" && js scripts/lib/spare-json.mjs get "$1" "$2"); }

anvil_key() { cast wallet private-key "$ANVIL_MNEMONIC" "$1"; }
key_addr() { cast wallet address --private-key "$1"; }

# fresh_key: a new random private key, for a funded test user. Never use an anvil
# mnemonic key for one: those keys are public, so on RHC mainnet sweeper bots have
# attached EIP-7702 delegations to them (anvil #5 0x9965...A4dc carries
# 0xef0100 || 8a67b502...408a, seen 2026-10-02) whose code forwards any ETH it
# receives to the sweeper. A fork inherits that code: a USDG->ETH swap to such a
# user "pays out" and the ETH vanishes.
fresh_key() {
  local k
  k=$(cast wallet new | awk '/^Private key:/ {print $3}')
  [[ "$k" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "cast wallet new did not print a private key"
  printf '%s\n' "$k"
}

# uint_lt <a> <b>: a < b for unsigned decimal integers of any size (wei overflows
# bash arithmetic).
uint_lt() {
  local a=${1#"${1%%[!0]*}"} b=${2#"${2%%[!0]*}"}
  a=${a:-0}
  b=${b:-0}
  if [ ${#a} -ne ${#b} ]; then [ ${#a} -lt ${#b} ]; else [[ "$a" < "$b" ]]; fi
}

# fund_eth <rpc> <to> <target wei>
# Sets `to`'s ETH balance on the fork to `target` (anvil_setBalance) when it holds
# less. Idempotent; never lowers a balance.
fund_eth() {
  local rpc=$1 to=$2 target=$3 have
  have=$(cast balance "$to" --rpc-url "$rpc")
  if uint_lt "$have" "$target"; then
    cast rpc anvil_setBalance "$to" "$(cast to-hex "$target")" --rpc-url "$rpc" >/dev/null
    log "  $to set to $(cast from-wei "$target") ETH"
  else
    log "  $to already holds $(cast from-wei "$have") ETH"
  fi
}

# spare_forge <ScriptName> [forge script args...]
# Loads the config into SPARE_CONFIG_JSON (fs_permissions only grants ./addresses)
# and skips building tests, so an unrelated broken test cannot block a deploy.
spare_forge() {
  local name=$1
  shift
  local cfg="${SPARE_CONFIG:?SPARE_CONFIG must be set, e.g. config/4663.json}"
  [ -f "$CONTRACTS/$cfg" ] || die "config not found: contracts/$cfg"
  (
    cd "$CONTRACTS" &&
      SPARE_CONFIG="$cfg" SPARE_CONFIG_JSON="$(cat "$cfg")" \
        forge script "script/$name.s.sol" --skip test "$@"
  )
}

usdg_balance() { cast call "$USDG" "balanceOf(address)(uint256)" "$1" --rpc-url "$2" | awk '{print $1}'; }

# fund_usdg <rpc> <to> <target base units>
# Tops `to` up to `target` USDG. Impersonates a real holder first (a genuine
# transfer); falls back to writing the balance slot if the holder is short or the
# transfer is refused. Idempotent: never funds above target.
fund_usdg() {
  local rpc=$1 to=$2 target=$3
  local have need whale wbal
  have=$(usdg_balance "$to" "$rpc")
  if [ "$have" -ge "$target" ]; then
    log "  $to already holds $((have / 1000000)) USDG"
    return 0
  fi
  need=$((target - have))
  whale=${USDG_WHALE:-$DEFAULT_USDG_WHALE}
  wbal=$(usdg_balance "$whale" "$rpc" 2>/dev/null || echo 0)
  if [ "${wbal:-0}" -ge "$need" ]; then
    cast rpc anvil_impersonateAccount "$whale" --rpc-url "$rpc" >/dev/null
    cast rpc anvil_setBalance "$whale" 0xDE0B6B3A7640000 --rpc-url "$rpc" >/dev/null
    if cast send "$USDG" "transfer(address,uint256)" "$to" "$need" \
      --from "$whale" --unlocked --rpc-url "$rpc" >/dev/null 2>&1; then
      log "  $to <- $((need / 1000000)) USDG transferred from holder $whale"
    else
      warn "  transfer from $whale refused; writing the balance slot instead"
    fi
    cast rpc anvil_stopImpersonatingAccount "$whale" --rpc-url "$rpc" >/dev/null
  else
    warn "  holder $whale has only ${wbal:-0} base units at this fork block; writing the balance slot"
  fi
  have=$(usdg_balance "$to" "$rpc")
  if [ "$have" -lt "$target" ]; then
    local slot
    slot=$(cast index address "$to" "$USDG_BALANCE_SLOT")
    cast rpc anvil_setStorageAt "$USDG" "$slot" "$(cast to-uint256 "$target")" --rpc-url "$rpc" >/dev/null
    have=$(usdg_balance "$to" "$rpc")
    [ "$have" -ge "$target" ] || die "could not fund $to (USDG storage layout changed?)"
    log "  $to set to $((target / 1000000)) USDG via balance slot"
  fi
}
