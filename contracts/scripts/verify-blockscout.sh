#!/usr/bin/env bash
# Source verification of the 10 SPARE contracts on Robinhood Chain mainnet (4663),
# https://robinhoodchain.blockscout.com, from the committed creation record
# contracts/deployments/4663-contracts.json (contracts/broadcast is gitignored).
#
#   contracts/scripts/verify-blockscout.sh check      # read-only (the default)
#   contracts/scripts/verify-blockscout.sh status     # read-only
#   contracts/scripts/verify-blockscout.sh commands   # prints, runs nothing
#   contracts/scripts/verify-blockscout.sh json       # writes out-deploy/verify/*.json
#   SPARE_VERIFY_ACK=publish-source contracts/scripts/verify-blockscout.sh submit
#
# check     Builds src/ into out-deploy/ (cache-deploy/), then for every contract:
#           1. re-encodes the recorded constructor args with cast, appends them to
#              the creation bytecode built here and compares the result byte for
#              byte with the creation transaction's input, read from the chain;
#           2. asks forge for the exact standard-JSON input `submit` uploads,
#              compiles THAT with solc 0.8.26 and compares again, so what the
#              explorer will compile is proven to reproduce the chain;
#           3. checks the receipt's contractAddress and block against the record.
# status    Asks Blockscout, and Sourcify (Blockscout displays Sourcify matches),
#           whether each address is verified. Blockscout's API sits behind a bot
#           check that answers HTTP 403 to scripts on some networks: that is
#           reported as "unknown", never worked around.
# commands  The forge verify-contract command for each contract.
# json      Standard-JSON inputs for the explorer's manual "Verify & Publish ->
#           Solidity (Standard JSON input)" form, if the CLI is blocked.
# submit    PUBLISHES THE SOURCE CODE. Only with the owner's approval, given as
#           SPARE_VERIFY_ACK=publish-source. Runs `check` first, stops on any
#           mismatch. VERIFIER=sourcify submits to Sourcify instead of Blockscout.
#
# RPC: $RHC_RPC_URL when set (never printed), else the public RHC endpoint.
# ONLY=<ContractName> limits any mode to one contract. SPARE_CREATION_RECORD
# overrides the record path (relative to contracts/).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib/common.sh"
need forge
need cast
need curl

RECORD="${SPARE_CREATION_RECORD:-deployments/4663-contracts.json}" # relative to contracts/
EXPLORER="https://robinhoodchain.blockscout.com"
VERIFIER_URL="$EXPLORER/api/"
SOLC_LONG="0.8.26+commit.8a97fa7a"
OUT="out-deploy"
CACHE="cache-deploy"
RPC="${RHC_RPC_URL:-$PUBLIC_RHC_RPC}"
MODE="${1:-check}"

cd "$CONTRACTS"
[ -f "$RECORD" ] || die "missing contracts/$RECORD"

# name|source|address|creationTx|block|constructor|arg,arg,...
rows() {
  js -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (r.chainId !== 4663) throw new Error("record is not for chain 4663");
    for (const c of r.contracts) {
      if (process.argv[2] && c.name !== process.argv[2]) continue;
      console.log([c.name, c.source, c.address, c.creationTx, c.block, c.constructor, c.args.join(",")].join("|"));
    }' "$RECORD" "${ONLY:-}"
}

encode_args() { # <constructor signature> <comma-separated args>
  if [ "$1" = "constructor()" ]; then
    printf '0x'
    return
  fi
  local -a a
  IFS=',' read -ra a <<<"$2"
  cast abi-encode "$1" "${a[@]}"
}

lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

verify_cmd() { # <address> <source> <encoded args> [extra flags...]
  local addr=$1 src=$2 enc=$3
  shift 3
  local -a v
  if [ "${VERIFIER:-blockscout}" = "sourcify" ]; then
    v=(--verifier sourcify)
  else
    v=(--verifier blockscout --verifier-url "$VERIFIER_URL")
  fi
  forge verify-contract "$addr" "$src" --root . --chain 4663 "${v[@]}" \
    --compiler-version "v$SOLC_LONG" --num-of-optimizations 200 --via-ir --evm-version cancun \
    --constructor-args "$enc" "$@"
}

find_solc() {
  local c
  for c in "${SOLC:-}" "$HOME/.svm/0.8.26/solc-0.8.26" "$HOME/.svm/0.8.26/solc-0.8.26.exe" \
    "$HOME/AppData/Roaming/svm/0.8.26/solc-0.8.26" "$HOME/AppData/Roaming/svm/0.8.26/solc-0.8.26.exe"; do
    [ -n "$c" ] && [ -x "$c" ] && "$c" --version 2>/dev/null | grep -q "$SOLC_LONG" && {
      printf '%s' "$c"
      return
    }
  done
  die "solc $SOLC_LONG not found (forge installs it on the first build; or set SOLC=/path/to/solc)"
}

# Creation bytecode of <Name> from a solc standard-JSON output file.
std_bytecode() { # <solc output json> <source path> <name>
  js -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const errs = (o.errors || []).filter((e) => e.severity === "error");
    if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
    console.log("0x" + o.contracts[process.argv[2]][process.argv[3]].evm.bytecode.object);' "$1" "$2" "$3"
}

check() {
  log "building src/ into contracts/$OUT (solc $SOLC_LONG, via-IR, optimizer 200, cancun, bytecode_hash none)"
  mkdir -p "$OUT"
  forge build --out "$OUT" --cache-path "$CACHE" --skip test --skip script >"$OUT/.verify-build.log" 2>&1 ||
    { cat "$OUT/.verify-build.log" >&2; die "forge build failed"; }
  # Relative on purpose: bun / node on Windows cannot open MSYS /tmp paths.
  local solc tmp="$OUT/.verify-check"
  solc=$(find_solc)
  rm -rf "$tmp"
  mkdir -p "$tmp"
  local failed=0 n=0 name src addr tx blk ctor args file enc input built std rca rblk
  while IFS='|' read -r name src addr tx blk ctor args; do
    n=$((n + 1))
    file=${src%%:*}
    enc=$(encode_args "$ctor" "$args")
    input=$(cast tx "$tx" input --rpc-url "$RPC")
    built="$(js -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).bytecode.object)' \
      "$OUT/$(basename "$file")/$name.json")${enc#0x}"
    verify_cmd "$addr" "$src" "$enc" --show-standard-json-input >"$tmp/$name.in.json"
    "$solc" --standard-json <"$tmp/$name.in.json" >"$tmp/$name.out.json"
    std="$(std_bytecode "$tmp/$name.out.json" "$file" "$name")${enc#0x}"
    rca=$(cast receipt "$tx" contractAddress --rpc-url "$RPC")
    rblk=$(cast receipt "$tx" blockNumber --rpc-url "$RPC")
    local ok=1 why=""
    [ "$(lower "$built")" = "$(lower "$input")" ] || { ok=0; why+=" forge-build!=chain"; }
    [ "$(lower "$std")" = "$(lower "$input")" ] || { ok=0; why+=" standard-json!=chain"; }
    [ "$(lower "$rca")" = "$(lower "$addr")" ] || { ok=0; why+=" receipt-address=$rca"; }
    [ "$rblk" = "$blk" ] || { ok=0; why+=" receipt-block=$rblk"; }
    if [ $ok = 1 ]; then
      printf '  [ok]   %-16s %s  block %s  creation input %s bytes = build + args = standard-JSON build + args\n' \
        "$name" "$addr" "$blk" "$(((${#input} - 2) / 2))"
    else
      printf '  [FAIL] %-16s %s %s\n' "$name" "$addr" "$why"
      failed=$((failed + 1))
    fi
  done < <(rows)
  rm -rf "$tmp"
  [ "$n" -gt 0 ] || die "no contract matched ONLY=${ONLY:-}"
  if [ $failed -ne 0 ]; then
    die "check: $failed of $n contract(s) do NOT reproduce their creation input"
  fi
  log "check: all $n contract(s) reproduce their on-chain creation input byte for byte"
}

status() {
  local name src addr tx blk ctor args code body="$OUT/.verify-status.json" bs sf
  mkdir -p "$OUT"
  printf '%-16s %-42s %-34s %s\n' "contract" "address" "blockscout" "sourcify"
  while IFS='|' read -r name src addr tx blk ctor args; do
    code=$(curl -s -o "$body" -w '%{http_code}' -H 'accept: application/json' \
      "$EXPLORER/api/v2/smart-contracts/$addr" || true)
    if [ "$code" = "200" ]; then
      bs=$(js -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        console.log(j.is_verified ? (j.is_fully_verified ? "verified (full)" : "verified (partial)") : "NOT verified")' "$body")
    elif [ "$code" = "404" ]; then
      bs="NOT verified (no contract record)"
    elif grep -qi "just a moment\|challenge" "$body" 2>/dev/null; then
      bs="unknown: HTTP $code bot check"
    else
      bs="unknown: HTTP $code"
    fi
    rm -f "$body"
    sf=$(curl -s "https://sourcify.dev/server/v2/contract/4663/$addr" | js -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const j = JSON.parse(s); console.log(j.match ? j.match + " match" : "NOT verified"); }
        catch { console.log("unknown"); } });' || echo "unknown")
    printf '%-16s %-42s %-34s %s\n' "$name" "$addr" "$bs" "$sf"
  done < <(rows)
}

commands() {
  local name src addr tx blk ctor args enc
  while IFS='|' read -r name src addr tx blk ctor args; do
    enc=$(encode_args "$ctor" "$args")
    echo "# $name ($ctor)"
    if [ "${VERIFIER:-blockscout}" = "sourcify" ]; then
      echo "forge verify-contract $addr $src --root . --chain 4663 --verifier sourcify \\"
    else
      echo "forge verify-contract $addr $src --root . --chain 4663 --verifier blockscout --verifier-url $VERIFIER_URL \\"
    fi
    echo "  --compiler-version v$SOLC_LONG --num-of-optimizations 200 --via-ir --evm-version cancun \\"
    echo "  --constructor-args $enc --watch"
  done < <(rows)
}

json() {
  mkdir -p "$OUT/verify"
  local name src addr tx blk ctor args enc
  while IFS='|' read -r name src addr tx blk ctor args; do
    enc=$(encode_args "$ctor" "$args")
    verify_cmd "$addr" "$src" "$enc" --show-standard-json-input >"$OUT/verify/$name.json"
    printf '%s\n' "$enc" >"$OUT/verify/$name.constructor-args.txt"
    log "contracts/$OUT/verify/$name.json  ($src, compiler v$SOLC_LONG, constructor args in $name.constructor-args.txt)"
  done < <(rows)
}

submit() {
  [ "${SPARE_VERIFY_ACK:-}" = "publish-source" ] ||
    die "submit publishes the source code: it needs the owner's approval, given as SPARE_VERIFY_ACK=publish-source"
  check
  local name src addr tx blk ctor args enc failed=0
  while IFS='|' read -r name src addr tx blk ctor args; do
    enc=$(encode_args "$ctor" "$args")
    log "verifying $name $addr on ${VERIFIER:-blockscout}"
    if ! verify_cmd "$addr" "$src" "$enc" --watch; then
      warn "$name: verification request failed"
      failed=$((failed + 1))
    fi
  done < <(rows)
  if [ $failed -ne 0 ]; then
    warn "$failed submission(s) failed. If the explorer's bot check refused the CLI, run '$0 json'"
    warn "and upload each file at $EXPLORER/address/<address>?tab=contract (Verify & Publish ->"
    warn "Solidity (Standard JSON input), compiler v$SOLC_LONG, constructor args from the .txt file)."
    exit 1
  fi
  status
}

case "$MODE" in
  check) check ;;
  status) status ;;
  commands) commands ;;
  json) json ;;
  submit) submit ;;
  *) die "usage: $0 [check|status|commands|json|submit]" ;;
esac
