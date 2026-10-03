# SPARE — owner hand-over to a Safe and a 48 h timelock

**Status: prepared and rehearsed on a mainnet fork, NOT executed.** Today one EOA,
`0x56B67D71039365083727b661Dbe9Bdb7f7D15189`, is owner, pauser and attestor of every
SPARE contract and can take all parked USDG in one transaction
([`ROLES.md`](ROLES.md)). This runbook moves those powers without redeploying anything
(the 7 owned contracts are `Ownable2Step`):

| Role | Today | After |
|---|---|---|
| owner of the 7 | the EOA | `TimelockController`, minDelay 48 h, administers itself |
| who drives the timelock | — | the **owner Safe**, 2 of 3 hardware signers: only proposer, canceller and executor |
| pauser of the 7 | the EOA | a separate **pauser Safe** (instant, no delay) |
| `ScreeningGate` attestor | the EOA | the pauser Safe (or `SPARE_ATTESTOR`) |
| keeper | `0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03` | unchanged (bounded, see `ROLES.md`) |

Tooling, all in `contracts/`:

| File | What it does |
|---|---|
| `script/governance/DeployTimelock.s.sol` | step 1: checks the owner Safe, deploys the timelock, re-checks it |
| `script/governance/HandOver.s.sol` | step 2 (owner EOA): pauser + attestor first, then `transferOwnership(timelock)` on all 7 |
| `script/governance/TimelockBatch.s.sol` | steps 3 and 5, and every owner action afterwards: read-only, prints the owner Safe's Safe Transaction Builder JSON |
| `deployments/4663-pauser-pause-all.json` | the pauser Safe's emergency stop (7 × `pause()`) |
| `script/AcceptOwnership.s.sol` | with the timelock as pending owner: says so, prints no direct Safe batch, points to `TimelockBatch.s.sol` |
| `script/AddAssets.s.sol` | registry changes from the config; with the timelock as owner it prints them for `TimelockBatch.s.sol` |
| `scripts/rehearse-governance.sh` | the whole runbook on a local anvil fork of mainnet, with real Safe proxies, then an `AddAssets` change through the timelock |
| `scripts/roles.sh` | live role inventory, before and after |
| `deployments/governance-rehearsal-2026-10-02.txt` | the rehearsal log (hand-over) |
| `deployments/governance-rehearsal-addassets-2026-10-02.txt` | the rehearsal log (hand-over, `AcceptOwnership`, an `AddAssets` change through the timelock) |

Every script refuses before sending anything unless the Safes and the timelock pass
their checks (canonical Safe v1.4.1, owner Safe ≥ 2 of 3, no module, no guard, no hot
key among the signers; the timelock's runtime code equals the OpenZeppelin 5.0.2
`TimelockController` built here, minDelay ≥ 48 h, the owner Safe is its only
proposer / canceller / executor and nobody but the timelock is admin, confirmed by
re-reading every `RoleGranted` log). Broadcasting on chain 4663 also needs
`SPARE_MAINNET_ACK=owner-approved`. Run every step from the same checkout: the
timelock code check compares against this repo's own build of `TimelockController`.

## Why 48 h on acceptance, not a zero-delay bootstrap

The alternative is to deploy the timelock with `minDelay = 0`, accept ownership
immediately, then `updateDelay(48 h)`. This runbook does not do that:

1. **The timelock never runs weaker than advertised.** With a bootstrap there is a
   window where the "timelock" has no delay and the Safe has instant power over every
   contract. If the `updateDelay` step is forgotten, fails, or is never executed,
   SPARE looks governed and is not.
2. **Bootstrap operations outlive the bootstrap.** OpenZeppelin checks the delay when an
   operation is scheduled. Anything scheduled while `minDelay` was 0 stays executable at
   any time, even after the delay is raised.
3. **Waiting costs nothing.** Until the accept executes, the EOA stays owner: nothing is
   worse than today, it can still pause, and the hand-over can be aborted (the owner Safe
   cancels the operation; the EOA can re-nominate).
4. **It is public notice.** The scheduled `acceptOwnership` batch announces the
   hand-over on-chain 48 h before it happens, exactly like every later owner action.

`DeployTimelock.s.sol` refuses any delay under 172800 s.

## What only the owner can do first

1. **Create the owner Safe** on Robinhood Chain (4663): Safe v1.4.1, **3 signers,
   threshold 2**, each signer a hardware wallet (Ledger, Trezor, Keystone, GridPlus)
   held by a different person or place. None of them may be the deployer EOA, the keeper
   key or any key that has been in a `.env` file. No modules, no guard. The canonical
   Safe v1.4.1 contracts are on 4663 with canonical bytecode (checked 2026-10-02):
   SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, SafeProxyFactory
   `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, CompatibilityFallbackHandler
   `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`, MultiSend
   `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526`, MultiSendCallOnly
   `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`.
2. **Create the pauser Safe**: a different Safe, **2 signers, threshold 1**, hardware
   wallets (the same devices may be used, on different account indexes). One person must
   be able to stop SPARE at 3 a.m. A Safe rather than a bare EOA so that a lost device is
   replaced by the Safe itself, instantly, instead of by a 48 h owner operation. Trade-off:
   one compromised pauser device can pause; pausing moves no money, exits stay open, and
   replacing the pauser and unpausing is one 48 h operation.
3. **Choose the attestor.** Screening is off (`enforced = false`). Default: the pauser
   Safe (it can `clear` / `revoke` directly). Signed clearances (`submitClearance`) verify
   a plain ECDSA signature, so if screening is later turned on with gasless clearances the
   attestor must be an EOA: schedule `setAttestor` through the timelock then.
4. **Hand over the addresses**: owner Safe, pauser Safe and every signer address.
5. **Approve each mainnet step** below (the `SPARE_MAINNET_ACK=owner-approved` value is
   that approval) and **sign** steps 3 and 5 with two owner-Safe signers.

Safe{Wallet} (app.safe.global) support for chain 4663 is unconfirmed: its API answered
HTTP 403 when this was written. Everything below works either way: with any Safe UI that
loads Transaction Builder JSON, or with the CLI path at the end.

## Runbook

```bash
cd contracts
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . ./.env; set +a          # loads RHC_RPC_URL and DEPLOYER_PK; never echo them
OWNER_EOA=0x56B67D71039365083727b661Dbe9Bdb7f7D15189
export SPARE_OWNER_SAFE=0x...      # from "What only the owner can do", 1
export SPARE_PAUSER_SAFE=0x...     # 2
# export SPARE_ATTESTOR=0x...      # 3, optional (default: the pauser Safe)
```

`RHC_RPC_URL` in `contracts/.env` is the public endpoint today. It works for every step
but was slow at times on 2026-10-02 and keeps only recent state; a keyed endpoint makes
the dry runs and the role-log scans faster.

**0. Rehearse and check the live state.** No key needed; nothing touches mainnet.

```bash
scripts/rehearse-governance.sh deployments/governance-rehearsal-$(date +%F).txt   # must end "0 failed"
../scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"                # must end "PASS"
scripts/roles.sh
```

**1. Deploy the timelock** (owner EOA; it gains no role). Dry run, then broadcast:

```bash
forge script script/governance/DeployTimelock.s.sol --skip test --rpc-url "$RHC_RPC_URL" --sender $OWNER_EOA
SPARE_MAINNET_ACK=owner-approved forge script script/governance/DeployTimelock.s.sol --skip test \
  --rpc-url "$RHC_RPC_URL" --broadcast --private-key "$DEPLOYER_PK"
export SPARE_TIMELOCK=0x...        # the two lines it prints
export SPARE_TIMELOCK_BLOCK=...
```

**2. Hand over** (owner EOA). Dry run, then broadcast. 15 transactions: 7 × `setPauser`,
`setAttestor`, 7 × `transferOwnership(timelock)`. Pauser and attestor change at once;
ownership is only **nominated** — the EOA is still owner after this step.

```bash
forge script script/governance/HandOver.s.sol --skip test --rpc-url "$RHC_RPC_URL" --sender $OWNER_EOA
SPARE_MAINNET_ACK=owner-approved forge script script/governance/HandOver.s.sol --skip test \
  --rpc-url "$RHC_RPC_URL" --broadcast --private-key "$DEPLOYER_PK"
```

**3. Schedule the acceptance** (owner Safe, 2 signatures). The generator only reads:

```bash
forge script script/governance/TimelockBatch.s.sol --skip test --rpc-url "$RHC_RPC_URL"
```

Import the `SCHEDULE` JSON it prints into the owner Safe (Transaction Builder) — one
call, `to` = timelock, value 0. Each signer checks that the hash on the device equals
`SCHEDULE_SAFE_TX_HASH` (valid while the Safe nonce equals `SAFE_NONCE`). Execute.
Running the generator again shows `state Waiting` and the ready time.

Do not use `script/AcceptOwnership.s.sol` for this. It is for an EOA or a Safe that
is itself the pending owner. Here the pending owner is the timelock, so a Safe batch
of `acceptOwnership()` would revert. When the common `pendingOwner` has code and
answers `getMinDelay()`, AcceptOwnership prints no Safe batch. It names the timelock and
its delay, prints the `TimelockBatch.s.sol` command above, and refuses `--broadcast`.
If fewer than 7 contracts are pending to the timelock, it warns that this step's default
batch would revert on execute: re-run HandOver (idempotent) first.

**4. Wait 48 h.** The EOA is still owner: use it for nothing. Watch the timelock for any
`CallScheduled` that is not this one; the owner Safe cancels anything unexpected
(`cancel(id)`).

**5. Execute the acceptance** (owner Safe, 2 signatures). Run the generator again: it
must show `state Ready`. Import the `EXECUTE` JSON, sign, execute. It then shows
`state Done`, and every contract's `owner()` is the timelock.

**6. Verify and update the books.**

- `contracts/config/4663.json` and `contracts/addresses/4663.json`: `roles.owner` = the
  timelock, `roles.pauser` = the pauser Safe, `roles.attestor` = the attestor. Then
  `SPARE_REQUIRE_ACCEPTED=true ../scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"`
  must PASS (the rehearsal runs exactly this check against the new roles).
- `SPARE_TIMELOCK=$SPARE_TIMELOCK SPARE_TIMELOCK_BLOCK=$SPARE_TIMELOCK_BLOCK scripts/roles.sh`.
- Off-chain readers of the owner: `server/src/spare/book.ts` (`roles.owner`; spare-api
  reports an owner mismatch otherwise), the site's address book (reads
  `addresses/4663.json`), the README line "The owner key is a single wallet",
  `docs/ROLES.md` and `docs/DEPLOYMENT-4663.md`.
- Monitoring: add the timelock's `CallScheduled`, `Cancelled`, `CallExecuted`,
  `MinDelayChange` and `RoleGranted`, and the pauser Safe's `ExecutionSuccess`.
- Retire the EOA: it holds no role. Remove `DEPLOYER_PK` from `contracts/.env` and keep
  the key offline; nothing routine needs it any more.

## Living with the timelock

| Action | Before | After |
|---|---|---|
| Pause (emergency stop) | EOA, instant | pauser Safe, 1 signature, instant |
| **Unpause** | EOA, instant | **≥ 48 h** (owner-only): after any pause, accrual and sweeps stay off for at least two days |
| Register or activate a stock (`setAsset`, `setActive`) | instant | ≥ 48 h |
| Deactivate a broken asset | instant | ≥ 48 h; a bad oracle already defers on its own, and pausing stops sweeps at once |
| Rotate the keeper | instant | pause at once; then one 48 h batch: `setKeeper(old, false)`, `setKeeper(new, true)`, `unpause()` × 7 |
| Fee / slippage / threshold (`setParams`) | instant | ≥ 48 h |
| Withdraw fees | instant | ≥ 48 h |
| Default mix, screening on/off, attestor, sequencer feed, router callers, park adapter (SGOV switch) | instant | ≥ 48 h |
| Change the delay or the timelock's roles | — | ≥ 48 h (the timelock administers itself) |

**Any owner action**, after the hand-over: build the calls, then schedule and later
execute them with the same generator and the **same salt label** (same label + same
calls = same operation id):

```bash
DATA=$(cast calldata "setActive(address,bool)" 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68 true)
SPARE_TIMELOCK_CALLS_JSON="[{\"to\":\"0x6dA6e49E2c59b622697a208a83bF266D5268c937\",\"data\":\"$DATA\"}]" \
SPARE_TIMELOCK_SALT="2026-10-09 activate QQQ" \
  forge script script/governance/TimelockBatch.s.sol --skip test --rpc-url "$RHC_RPC_URL"
```

TimelockBatch takes at most 64 calls, each with value 0. It refuses a larger batch, or a
call with a non-zero `"value"`, rather than scheduling something else. It lists each
call as target name, address and 4-byte selector; `SCHEDULE_DATA` carries the full
calldata.

**Registry changes (`AddAssets.s.sol`).** Edit `config/4663.json` (register, re-pin,
activate or deactivate an asset) and commit it. Then dry-run AddAssets, with no
`--broadcast` and no `--sender`:

```bash
../scripts/spare-forge.sh AddAssets --rpc-url "$RHC_RPC_URL"
```

When `AssetRegistry.owner()` is a contract, AddAssets sends nothing and needs no key.
With `--broadcast` it refuses. It runs the same preflight and plan as for an EOA owner
and prints each action with its reason and calldata. It then simulates exactly those
calls, in order, as the owner and re-plans: the batch must leave nothing to do. It
refuses a plan of more than 64 calls; apply such a change in smaller steps. Last it
prints two lines for the generator:

- `TIMELOCK_CALLS_JSON [{"to":"<AssetRegistry>","value":"0","data":"0x..."}, ...]`
- `TIMELOCK_SALT AddAssets <config hash>`

It also prints the full command:

```bash
SPARE_TIMELOCK_CALLS_JSON='<TIMELOCK_CALLS_JSON>' SPARE_TIMELOCK_SALT='<TIMELOCK_SALT>' \
  forge script script/governance/TimelockBatch.s.sol --skip test --rpc-url "$RHC_RPC_URL"
```

Schedule with the owner Safe as in step 3. Before executing, re-run AddAssets: it must
print the same `TIMELOCK_CALLS_JSON` (if the plan changed, cancel the operation and
start over). Execute once the generator shows `state Ready`. AddAssets then reports
`0 actions`. The salt comes from the config hash, so re-applying an identical config
after an earlier operation is Done needs a new `SPARE_TIMELOCK_SALT` label. With an
EOA owner, AddAssets behaves as before: the sender must be the owner, and it applies
the calls itself. An EOA with an EIP-7702 delegation has code (the 23-byte delegation
designator) but still signs with its own key, so AddAssets treats it as an EOA.

The rehearsal (`deployments/governance-rehearsal-addassets-2026-10-02.txt`, phase 14)
does this on a mainnet fork. It activates the standby asset QQQ through a real owner
Safe and the timelock, and shows the batch cannot run before 48 h.

**Emergency stop:** import `deployments/4663-pauser-pause-all.json` into the pauser Safe
(Transaction Builder) and execute with one signature. `pause()` on `SweepExecutor` and
`CashPark` halts `accrue`, `accrueBatch`, `sweep` and `park`; the other five set a flag
nothing reads. `CashPark.exit` and `SweepExecutor.claim` are never paused.

## CLI path (no Safe UI on 4663)

A Safe v1.4.1 accepts "approved hash" signatures, so hardware wallets can sign on-chain
with `cast` alone:

```bash
SAFE=$SPARE_OWNER_SAFE; TO=$SPARE_TIMELOCK; DATA=0x...   # SCHEDULE_DATA or EXECUTE_DATA
NONCE=$(cast call $SAFE "nonce()(uint256)" --rpc-url "$RHC_RPC_URL")
HASH=$(cast call $SAFE "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  $TO 0 $DATA 0 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 $NONCE \
  --rpc-url "$RHC_RPC_URL")                                 # = the generator's SAFE_TX_HASH
# signer A (not the one who executes):
cast send $SAFE "approveHash(bytes32)" $HASH --ledger --rpc-url "$RHC_RPC_URL"
# signer B executes. One 65-byte entry per approving owner, sorted by address ascending:
#   <owner address left-padded to 32 bytes><32 zero bytes><01>
# B's own entry needs no approveHash (msg.sender is that owner).
cast send $SAFE "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  $TO 0 $DATA 0 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 $SIGS \
  --ledger --rpc-url "$RHC_RPC_URL"
```

The rehearsal executes the unpause schedule exactly this way.
