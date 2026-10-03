#!/usr/bin/env bash
# Run one of the SPARE forge scripts with its config loaded.
#
#   scripts/spare-forge.sh <Deploy|VerifyDeployment|AcceptOwnership|DevSmoke> [forge script args...]
#
# The config is contracts/$SPARE_CONFIG (default: config/<chain id of --rpc-url>.json).
# Every flag after the script name goes straight to `forge script`, so the usual
# rules apply: nothing is sent without --broadcast, and Deploy.s.sol enforces its
# own mainnet guards (placeholder roles, multisig owner, SPARE_MAINNET_ACK).
#
# Examples
#   # dry-run the real mainnet config on a fork, before roles are filled:
#   SPARE_REHEARSAL=true scripts/spare-forge.sh Deploy --fork-url "$RHC_RPC_URL"
#   # verify a deployment:
#   scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
need forge
need cast

[ $# -ge 1 ] || die "usage: scripts/spare-forge.sh <ScriptName> [forge script args...]"
name=$1
shift
[ -f "$CONTRACTS/script/$name.s.sol" ] || die "no such script: contracts/script/$name.s.sol"

if [ -z "${SPARE_CONFIG:-}" ]; then
  rpc=""
  prev=""
  for a in "$@"; do
    case "$prev" in --rpc-url | --fork-url | -f) rpc=$a ;; esac
    case "$a" in --rpc-url=* | --fork-url=*) rpc=${a#*=} ;; esac
    prev=$a
  done
  [ -n "$rpc" ] || die "pass --rpc-url/--fork-url, or set SPARE_CONFIG"
  chain=$(cast chain-id --rpc-url "$rpc") || die "cannot reach $rpc"
  export SPARE_CONFIG="config/$chain.json"
fi
log "config: contracts/$SPARE_CONFIG"
spare_forge "$name" "$@"
