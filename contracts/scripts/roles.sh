#!/usr/bin/env bash
# Live inventory of every privileged role on a SPARE deployment, read from the chain.
#
#   contracts/scripts/roles.sh [rpc-url]
#
# Reads contracts/addresses/<chain id>.json (SPARE_ADDRESSES overrides, relative to
# contracts/). Mapping roles (keepers, StockRouter callers) cannot be listed from
# storage, so the candidates come from every KeeperSet / CallerSet log since the
# deployment block and each one is re-read live: a role granted and later revoked
# shows as revoked. With SPARE_TIMELOCK (+ SPARE_TIMELOCK_BLOCK, printed by
# DeployTimelock) it also lists the timelock's delay and its live role holders the
# same way. Read-only: only eth_call / eth_getLogs.
#
# RPC: the argument, else $RHC_RPC_URL (never printed), else the public endpoint.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib/common.sh"
need cast

RPC="${1:-${RHC_RPC_URL:-$PUBLIC_RHC_RPC}}"
cd "$CONTRACTS"
CHAIN=$(cast chain-id --rpc-url "$RPC") || die "RPC did not answer"
BOOK="${SPARE_ADDRESSES:-addresses/$CHAIN.json}"
[ -f "$BOOK" ] || die "no addresses file contracts/$BOOK"

get() { js -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(process.argv[2].split(".").reduce((o, k) => o[k], j));' "$BOOK" "$1"; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" | awk '{print $1}'; }

# Unique indexed addresses (topic 1) of <event> logs emitted by <address>.
indexed_addrs() { # <address> <event signature> <from block>
  cast logs --from-block "$3" --to-block latest --address "$1" "$2" --json --rpc-url "$RPC" | js -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const seen = new Set();
      for (const l of JSON.parse(s || "[]")) seen.add("0x" + l.topics[1].slice(26));
      for (const a of seen) console.log(a);
    });'
}

START=$(get startBlock)
OWNED=(AssetRegistry ElectionRegistry ScreeningGate StockRouter CashPark FeeVault SweepExecutor)
declare -A A
for n in "${OWNED[@]}" RuleRegistry UsdgParkAdapter SgovParkAdapter; do A[$n]=$(get "contracts.$n"); done
USDG_ADDR=$(get external.USDG)
BLOCK=$(cast block-number --rpc-url "$RPC")

echo "SPARE roles - chain $CHAIN, block $BLOCK, $(date -u +%Y-%m-%dT%H:%M:%SZ), addresses contracts/$BOOK"
echo
echo "== ownership and pause (Ownable2Step + SpareAuth)"
printf '%-17s %-43s %-43s %-43s %s\n' contract owner pendingOwner pauser paused
for n in "${OWNED[@]}"; do
  printf '%-17s %-43s %-43s %-43s %s\n' "$n" "$(call "${A[$n]}" 'owner()(address)')" \
    "$(call "${A[$n]}" 'pendingOwner()(address)')" "$(call "${A[$n]}" 'pauser()(address)')" \
    "$(call "${A[$n]}" 'paused()(bool)')"
done

echo
echo "== keepers (KeeperSet logs since block $START, each re-read live with isKeeper)"
for n in "${OWNED[@]}"; do
  while read -r k; do
    [ -n "$k" ] || continue
    printf '%-17s %-43s isKeeper=%s\n' "$n" "$(cast to-check-sum-address "$k")" "$(call "${A[$n]}" 'isKeeper(address)(bool)' "$k")"
  done < <(indexed_addrs "${A[$n]}" "KeeperSet(address indexed,bool)" "$START")
done

echo
echo "== StockRouter callers (CallerSet logs, re-read live with isCaller)"
while read -r c; do
  [ -n "$c" ] || continue
  printf '%-43s isCaller=%s\n' "$(cast to-check-sum-address "$c")" "$(call "${A[StockRouter]}" 'isCaller(address)(bool)' "$c")"
done < <(indexed_addrs "${A[StockRouter]}" "CallerSet(address indexed,bool)" "$START")
echo "sequencerFeed   $(call "${A[StockRouter]}" 'sequencerFeed()(address)')"

echo
echo "== CashPark"
echo "executor        $(call "${A[CashPark]}" 'executor()(address)')   (only it can credit / withdrawForSweep / returnFromSweep)"
echo "adapter         $(call "${A[CashPark]}" 'adapter()(address)')"
echo "totalPending    $(call "${A[CashPark]}" 'totalPending()(uint256)') USDG base units"
echo "totalUnits      $(call "${A[CashPark]}" 'totalUnits()(uint256)')"
echo "USDG held       $(call "$USDG_ADDR" 'balanceOf(address)(uint256)' "${A[CashPark]}") base units"

echo
echo "== ScreeningGate"
echo "attestor        $(call "${A[ScreeningGate]}" 'attestor()(address)')"
echo "enforced        $(call "${A[ScreeningGate]}" 'enforced()(bool)')"

echo
echo "== SweepExecutor params (owner-set; bounds MAX_FEE_BPS 100, MAX_SLIPPAGE_BPS 500, threshold >= 1e6, epoch >= 3600)"
for f in finalityBuffer threshold feeBps slippageBps epochLength; do
  printf '%-15s %s\n' "$f" "$(call "${A[SweepExecutor]}" "$f()(uint256)")"
done

echo
echo "== FeeVault"
echo "USDG held       $(call "$USDG_ADDR" 'balanceOf(address)(uint256)' "${A[FeeVault]}") base units (owner-withdrawable)"

echo
echo "== AssetRegistry"
TOKENS=$(cast call "${A[AssetRegistry]}" 'tokens()(address[])' --rpc-url "$RPC" | tr -d '[] ' | tr ',' '\n')
active=0
total=0
for t in $TOKENS; do
  total=$((total + 1))
  [ "$(call "${A[AssetRegistry]}" 'isEligible(address)(bool)' "$t")" = "true" ] && active=$((active + 1))
done
echo "registered $total, active $active"

echo
echo "== adapters (immutable wiring, no roles)"
echo "UsdgParkAdapter park = $(call "${A[UsdgParkAdapter]}" 'park()(address)')"
echo "SgovParkAdapter park = $(call "${A[SgovParkAdapter]}" 'park()(address)'), router = $(call "${A[SgovParkAdapter]}" 'router()(address)')"
echo "RuleRegistry: no admin role (users link, unlink and set rules for themselves only)"

if [ -n "${SPARE_TIMELOCK:-}" ]; then
  TL=$SPARE_TIMELOCK
  echo
  echo "== TimelockController $TL"
  echo "minDelay        $(call "$TL" 'getMinDelay()(uint256)') s"
  from=${SPARE_TIMELOCK_BLOCK:?SPARE_TIMELOCK_BLOCK is needed to scan the timelock role logs}
  cast logs --from-block "$from" --to-block latest --address "$TL" \
    "RoleGranted(bytes32 indexed,address indexed,address indexed)" --json --rpc-url "$RPC" | js -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const seen = new Set();
        for (const l of JSON.parse(s || "[]")) seen.add(l.topics[1] + " 0x" + l.topics[2].slice(26));
        for (const x of seen) console.log(x);
      });' | while read -r role acct; do
    case "$role" in
      0x0000000000000000000000000000000000000000000000000000000000000000) rn=DEFAULT_ADMIN_ROLE ;;
      "$(cast keccak PROPOSER_ROLE)") rn=PROPOSER_ROLE ;;
      "$(cast keccak EXECUTOR_ROLE)") rn=EXECUTOR_ROLE ;;
      "$(cast keccak CANCELLER_ROLE)") rn=CANCELLER_ROLE ;;
      *) rn=$role ;;
    esac
    printf '%-19s %-43s hasRole=%s\n' "$rn" "$(cast to-check-sum-address "$acct")" \
      "$(call "$TL" 'hasRole(bytes32,address)(bool)' "$role" "$acct")"
  done
fi
