# Spare — Operations Runbook

Mainnet: Robinhood Chain (chain id **4663**). Explorer: <https://robinhoodchain.blockscout.com>.
Address book: `contracts/addresses/4663.json`. Design and review history: `docs/SPARE-BUILD.md`.

Rules for everyone using this runbook:

- Keys stay in their files and the hosting platform's sealed variables. Load them with `set -a; . contracts/.env; set +a`
  and do not print or log them. The commands below use `$DEPLOYER_PK` and `$RHC_RPC_URL` from
  `contracts/.env`, so only the holder of the owner key can run them.
- Every `cast send` below is a mainnet transaction. Run the same line with `cast call` first where it
  makes sense, and read the target address twice.
- **A user's exit never depends on anything in this document.** `CashPark.exit()` (the Exit button
  in the Balance window) and `SweepExecutor.claim(token)` ignore pause and need no keeper, owner or
  oracle.

---

## 0. Quick reference

### Contracts (immutable, no proxies)

| Contract | Address | Holds value |
|---|---|---|
| AssetRegistry | `0x6dA6e49E2c59b622697a208a83bF266D5268c937` | no |
| RuleRegistry | `0x477504Fdd8929fC75Ac6836C2aa131D765e85f78` | no (no owner at all) |
| ElectionRegistry | `0x05fB5B11B676BC0Fbf893480b4101fB7C8Db0543` | no |
| ScreeningGate | `0xC3289C38c53055d58009B2fa9499c753b3dBCED3` | no |
| StockRouter | `0x1Fec3654Fea787a63104a6634C9781B837B5e17E` | transiently, inside a swap |
| CashPark | `0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb` | **yes**: every account's parked USDG |
| FeeVault | `0xF5B9C500998D122fbBB606f23DBEe91Aa5549add` | fees |
| SweepExecutor | `0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab` | `claimable` deliveries |
| UsdgParkAdapter (live) | `0x1E29fD4F78cDfabdE3Df605e66aE3d78a8980DD8` | parked units (1 unit = 1 USDG) |
| SgovParkAdapter (standby) | `0x4197a7Eb8e08a35fd55273afA3D0f8Cb3bd98525` | nothing until switched |

### Roles

| Role | Holder | Key lives in | Power |
|---|---|---|---|
| owner | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189` (EOA) | `contracts/.env` `DEPLOYER_PK` | every `onlyOwner` setter on the 7 owned contracts |
| pauser | same EOA | same | `pause()` on any owned contract (the owner can too) |
| attestor | same EOA | same | `ScreeningGate.clear` / `revoke` (screening is OFF) |
| keeper | `0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03` | the `spare-keeper` service's `KEEPER_PK` only | `accrue`, `accrueBatch`, `sweep`, `CashPark.park` |

The engine API and its workers (`engine/src/index.ts`, `src/workers`) never sign: they take the
keeper's address as `KEEPER_ADDRESS`, ignore a `KEEPER_PK` and warn at boot while one is still
in their environment (remove it there). Their tRPC `health` detail (database binding, cursors,
keeper) needs `Authorization: Bearer <HEALTH_TOKEN>` (32+ characters, sealed); `GET /health` and
callers without the token get the public snapshot only. `rule.preview` takes one request in
flight per client (`PREVIEW_MAX_INFLIGHT_PER_CLIENT`) under the engine-wide gate.

The owner is a single EOA with no timelock: it can take every parked USDG in one transaction
(`CashPark.setExecutor(self)` then `withdrawForSweep` per account). Moving it to a Safe plus a
48 h timelock is [`GOVERNANCE.md`](GOVERNANCE.md) (summary in 3.6); the monitor already watches
a timelock once `TIMELOCK_ADDRESS` is set.

### What pause does, and what it does not

Each owned contract has its own `paused` flag. Only these functions check it:

| Paused contract | Stops |
|---|---|
| SweepExecutor | `accrue`, `accrueBatch`, `sweep`: no new round-up pulls, no stock buys |
| CashPark | `park` (moving pending USDG into the adapter) |
| AssetRegistry, ElectionRegistry, ScreeningGate, StockRouter, FeeVault | nothing (the flag is not checked anywhere) |

Pause does **not** stop:

- `CashPark.exit()` and `SweepExecutor.claim(token)`: users can always leave (design law 5 in `SPARE-BUILD.md`).
- Users' own actions: `RuleRegistry.setRule` / `unlink` / `invalidateNonce`, `ElectionRegistry.setMix`,
  Permit2 `approve` / `lockdown`.
- **Any owner setter**, including `CashPark.setExecutor`, `setKeeper`, `setAsset`, `setParams`,
  `FeeVault.withdraw`, `transferOwnership`, and `unpause` itself. Pause is a brake against a bad
  keeper or a bad market, **not** against a compromised owner key.
- `CashPark.withdrawForSweep` / `credit` / `returnFromSweep`: they are executor-only, not pause-gated.
  With the real SweepExecutor paused nobody reaches them; an executor swapped by the owner reaches
  them regardless of pause.

```bash
set -a; . contracts/.env; set +a
X=0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab   # SweepExecutor
P=0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb   # CashPark
# pause (pauser or owner)
cast send $X "pause()" --rpc-url "$RHC_RPC_URL" --private-key "$DEPLOYER_PK"
cast send $P "pause()" --rpc-url "$RHC_RPC_URL" --private-key "$DEPLOYER_PK"
# check
cast call $X "paused()(bool)" --rpc-url "$RHC_RPC_URL"
# unpause (owner only, and only once the cause is fixed)
cast send $X "unpause()" --rpc-url "$RHC_RPC_URL" --private-key "$DEPLOYER_PK"
cast send $P "unpause()" --rpc-url "$RHC_RPC_URL" --private-key "$DEPLOYER_PK"
```

The keeper notices a paused executor on its own ("executor paused; skipping") and resumes on the
next tick after `unpause`; it does not need a restart.

---

## 1. The monitor (`engine/src/monitor`)

A small read-only Bun + viem process. It holds no key and never sends a transaction.

### 1.1 What it watches

**Every privileged event, one alert each** (keyed by tx hash + log index, so it is never sent
twice). `engine/test/monitor-coverage.test.ts` reads `contracts/src` and fails if any `onlyOwner`,
pauser or attestor function emits an event the monitor does not watch, or if a watched event's
types / indexed flags differ from the Solidity.

| Contract | Events |
|---|---|
| all 7 owned | `OwnershipTransferStarted`, `OwnershipTransferred`, `KeeperSet`, `PauserSet`, `Paused`, `Unpaused` |
| AssetRegistry | `AssetSet` (register / re-pin), `AssetActive` (activate / deactivate) |
| ElectionRegistry | `DefaultMixSet` |
| ScreeningGate | `AttestorSet`, `EnforcedSet`, `Revoked` (`Cleared` is logged only) |
| StockRouter | `CallerSet`, `SequencerFeedSet` |
| CashPark | `ExecutorSet`, `AdapterSet`, and operational `ExitUnitsKept` |
| FeeVault | `Withdrawn` |
| SweepExecutor | `ParamsSet`, and operational `SwapDeferred`, `DeliveryHeld` |
| Timelock (`TIMELOCK_ADDRESS`) | `CallScheduled` (the call is decoded, e.g. `CashPark.setExecutor(0x…)`), `CallExecuted`, `Cancelled`, `MinDelayChange`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` |
| Third-party pool hooks (`HOOK_PINS`: MU, GME) | for the pinned pools only: `FeePoked`, `PokeCleared`, `PoolAsymmetrySet`, `PoolConfigured`, `DayOverridesSet`, `SessionHoursSet`, `DstModeSet`, `EarlyCloseSet` (the hook operator's fee settings; accepted risk A-L3 in `SECURITY.md`) |
| The hooks' AccessManager (each pin's `hookAuthority`: `0xA362D98B33A7bb5B5E2180a05f995A70FB404f30`) | `RoleGranted` (critical for a new member, warning for a delay change), `RoleRevoked`, `RoleGrantDelayChanged`, `RoleAdminChanged`, `RoleGuardianChanged`, and for a pinned hook (critical; other targets are information) `TargetFunctionRoleUpdated`, `TargetAdminDelayUpdated`, `OperationScheduled`, plus `TargetClosed`, `OperationExecuted`, `OperationCanceled`: who can set the MU and GME fees, and what is queued on their hooks |

Severity depends on who: re-enabling the known keeper is a warning, enabling any other address is
critical; `ExecutorSet` to the SweepExecutor is a warning, to anything else critical; and so on.

**State checks** (every `CHECK_EVERY_MS`, 5 min): keeper / owner / pauser ETH, the keeper's nonce,
and 35 wiring invariants read live: `owner`, `pendingOwner`, `paused`, `pauser` on all 7 owned
contracts; CashPark `executor`, `adapter`, `isKeeper`; SweepExecutor `isKeeper`; StockRouter
`isCaller(SweepExecutor)`; ScreeningGate `attestor`, `enforced`; and for each pinned hook, its
`authority()` and its pool's `maxFee` against the pin. A mismatch stays open (and is re-sent every
`REPEAT_MINUTES`) until it is fixed, so an event the scan missed still surfaces.

**Liveness** (every `LIVENESS_EVERY_MS`, 10 min), from the linked-wallet set it rebuilds from the
deploy block:

- `keeper.idle`: a linked wallet the keeper must act on (active rule, Permit2 + USDG consent,
  weekly-cap room, a USDG balance) and no keeper transaction or accrual / sweep activity for
  `KEEPER_IDLE_MINUTES` (18 h). The keeper pulls such a wallet's round-ups, or zero-advances its
  cursor every `IDLE_ADVANCE_BLOCKS` (500,000 blocks, about 14 h), so 18 h of silence is a miss.
  Not market-gated: accrual runs around the clock.
- `sweep.overdue`: during the 24/5 equity session (Sun 20:00 to Fri 20:00 ET), an account due a
  sweep (park value at or over the threshold, not swept this epoch, screening-eligible) for
  `SWEEP_OVERDUE_MINUTES` (2 h). The clock stops while the market is closed.

**Keeper process** (`KEEPER_HEALTH_URL`, every poll): `keeper.unhealthy` (its `/health` says
`ok:false`), `keeper.stalled` (its newest tick is older than 15 min; needs `KEEPER_HEALTH_TOKEN`),
`keeper.unreachable` (no answer for `RPC_DOWN_MINUTES`).

**RPC**: `rpc.down` once failures have lasted `RPC_DOWN_MINUTES` (5). Blips are silent. The cursor
never skips: blocks missed during an outage are scanned and alerted afterwards.

### 1.2 Alert meanings and first response

Conditions fire once, repeat every `REPEAT_MINUTES` (6 h) while still true, and send one
`[RESOLVED]` when they clear.

| Alert | Severity | Means | First response |
|---|---|---|---|
| `OwnershipTransferStarted` | critical | someone nominated a new owner | ours? if not: section 2.3 now |
| `OwnershipTransferred` | warning / critical | owner changed (critical if not the expected owner) | section 2.3 unless planned |
| `ExecutorSet` | critical unless SweepExecutor | CashPark's withdrawal right moved | section 2.3: users exit now |
| `KeeperSet` | critical if an unknown keeper is enabled | a new address can accrue | ours? else 2.3; disabling is a warning |
| `CallerSet` | critical if an unknown caller is enabled | a new address can route swaps | as above |
| `AdapterSet` | critical unless a known adapter | parked funds' venue changed | section 3.4 / 2.3 |
| `PauserSet`, `AttestorSet` | critical unless the expected holder | role moved | ours? else 2.3 |
| `Paused` | critical | accruals / sweeps stopped | find who and why; 2.1 |
| `Unpaused` | warning | resumed | confirm it was intended |
| `ParamsSet` | warning | fee / slippage / threshold / epoch / finality changed | confirm against the change log |
| `AssetSet`, `AssetActive` | warning | universe change (deactivation pays queued legs out as USDG) | expected after `AddAssets`; else 2.3 |
| `DefaultMixSet`, `EnforcedSet`, `SequencerFeedSet`, `Withdrawn` | warning | owner configuration | confirm intended |
| `Revoked` | info | a clearance was withdrawn | none |
| `SwapDeferred` | warning | a netted swap reverted; the USDG went back to the park | section 2.6 |
| `DeliveryHeld` | warning | a token refused a delivery; it is claimable | user calls `claim(token)` |
| `ExitUnitsKept` | warning | an exit could not redeem or pay in kind | adapter / token state; user retries `exit()` |
| `Timelock: call SCHEDULED` | critical | a timelocked owner call is queued | read the decoded call; cancel if not ours (3.6) |
| `Timelock` role / min-delay changes | critical | timelock governance changed | ours? else cancel / escalate |
| `balance.keeper` | critical | keeper ETH under `KEEPER_MIN_ETH` | send ETH to the keeper (2.7) |
| `balance.owner`, `balance.pauser` | warning | under `OWNER_MIN_ETH` / `PAUSER_MIN_ETH` | top up: this key must be able to pause |
| `wiring.<Contract>.owner` / `pendingOwner` | critical | ownership is not what the book says | 2.3 unless planned |
| `wiring.<Contract>.paused` | critical | a contract is paused right now | 2.1 |
| `wiring.<Contract>.pauser`, `wiring.ScreeningGate.attestor` | critical | role differs from the book | 2.3 unless planned |
| `wiring.CashPark.executor` / `adapter` | critical | the money path differs from the book | 2.3 |
| `wiring.*.isKeeper`, `wiring.StockRouter.isCaller` | critical | the keeper / executor lost a role: everything stops | re-grant (2.2) |
| `wiring.ScreeningGate.enforced` | warning | screening differs from the book | confirm intended |
| `Hook MU/GME`: fee poked, re-configured, premium or calendar set | critical if the keeper now holds the asset (fee above the pin's ceiling, cap above the pinned cap), else warning | the third-party operator changed the pool's fee (A-L3) | the keeper holds the asset by itself; if it lasts, deactivate or re-pin it (3.3) |
| `wiring.Hook <SYMBOL>.authority` / `.maxFee` | critical | the hook's operator or the pool's fee cap is no longer the pinned one; the keeper holds the asset | review the hook; re-pin (`HOOK_PINS`, `config/4663.json`) or deactivate the asset |
| `keeper.idle` | warning | a wallet waits on a keeper that is not sending | 2.7 |
| `sweep.overdue` | warning | due sweeps are not happening in market hours | 2.6 |
| `keeper.unhealthy` / `keeper.stalled` / `keeper.unreachable` | warning / critical | keeper process trouble | 2.7 |
| `rpc.down` | critical | the monitor cannot read the chain | 2.5 |
| `state.save` | warning | `STATE_FILE` is not writable | fix the volume (1.3), else restarts can repeat alerts |

### 1.3 Deploying it

Same repository, same image as the keeper, different start command. The monitor needs no key:
**never** give this service `KEEPER_PK` or `DEPLOYER_PK`.

1. On the hosting platform, create a new service from the repo, named `spare-monitor`.
2. Build from `engine/` with its `Dockerfile.keeper`; start command `bun run src/monitor/run.ts`;
   healthcheck path `/health`; restart policy: always.
3. Attach a volume mounted at `/data` and set `STATE_FILE=/data/monitor-state.json`. With it, a
   restart resumes at the saved cursor, alerts nothing twice, and still alerts whatever happened
   while it was down. `Dockerfile.keeper` runs as the unprivileged `bun` user (uid 1000): if the
   platform mounts volumes as root, make the mount writable for that user or run this service as
   root (it holds no key). If the file cannot be written the monitor says so with a `state.save`
   warning.
4. Variables:

| Variable | Value |
|---|---|
| `CHAIN_ID` | `4663` |
| `RPC_URL` | an endpoint from a **different provider than the keeper's**, so one outage cannot blind both. Sealed. |
| `ADDRESSES_JSON` | the full contents of `contracts/addresses/4663.json` (the container has no `../contracts`) |
| `PORT` | `8080` (serves `/health`) |
| `STATE_FILE` | `/data/monitor-state.json` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | see 1.4. Sealed. |
| `ALERT_WEBHOOK_URL` | Discord or Slack incoming webhook. Sealed. |
| `TELEGRAM_MIN_SEVERITY`, `WEBHOOK_MIN_SEVERITY` | `critical` / `warning` / `info` (default `info`) |
| `KEEPER_HEALTH_URL` | `http://<keeper's private hostname>:<keeper PORT>/health` (private network; the keeper listens on its optional `HOST`, default `::`, dual-stack, so an IPv6 private network reaches it) |
| `KEEPER_HEALTH_TOKEN` | the keeper's `HEALTH_TOKEN`, for the detailed body (`keeper.stalled`). Sealed. |
| `KEEPER_MIN_ETH`, `OWNER_MIN_ETH`, `PAUSER_MIN_ETH` | defaults `0.002`, `0.001`, `0.001`; `0` disables |
| `TIMELOCK_ADDRESS`, `OWNER_ADDRESS`, `KEEPER_ADDRESS`, `PAUSER_ADDRESS`, `ATTESTOR_ADDRESS` | only when roles move away from the book (2.2, 3.6) |

   Tuning knobs and their defaults are documented in `engine/src/monitor/config.ts`:
   `POLL_MS` 30 s, `CONFIRMATIONS` 64 blocks, `LOGS_RANGE` 50,000 blocks per `eth_getLogs`
   (halved for good if the provider caps it), `MAX_CHUNKS_PER_POLL` 200, `LOOKBACK_BLOCKS` 36,000
   (about an hour), `REPEAT_MINUTES` 360, `SINK_MAX_PER_MINUTE` 20.

5. Deploy. Like `spare-keeper`, this service does not redeploy on push: deploy the commit you
   want.
6. Verify, in the service logs (one JSON object per line):
   - `monitor starting` lists the contracts, roles and sinks, and never a URL or token;
   - `starting without saved state` on the very first boot, `resumed from saved state` after;
   - `checks` shows `"wiring":{"checked":35,"failing":[],"unread":[]}` and the ETH balances;
   - `linked-wallet discovery complete`, then a `liveness` line;
   - `GET /health?strict=1` answers 200 with `"ok":true`.
7. Prove the routing before an incident does: from the service shell (or locally with the same
   sink variables) run `bun run src/monitor/run.ts --test-alert`. It sends one alert to every sink
   and exits non-zero if any sink did not take it.

The keeper's KEEPER_MIN_ETH default comes from its measured gas on 4663: an `accrueBatch` used
75-81k gas at ~0.02 gwei (about 0.0000016 ETH); a sweep is capped at 24M gas (0.00084 ETH at
0.035 gwei); the busiest accrual cadence (one ~80k-gas batch per 60 s tick) costs about 0.004 ETH
a day. 0.002 ETH is half a day of that worst case plus one maximum sweep, and four times the
keeper's own `LOW_GAS_WEI`, so this alert lands well before the keeper reports itself unhealthy.

### 1.4 How alerts route

```
chain / keeper /health / RPC
        |
   Monitor.poll()  --->  one JSON log line per alert (always; the service logs)
        |
   Dispatcher: drop "history", sort critical first, pack into few messages
        |------------------------------|
   Telegram (>= TELEGRAM_MIN_SEVERITY)  Webhook (>= WEBHOOK_MIN_SEVERITY)
   <= SINK_MAX_PER_MINUTE each, queued, 3 attempts, then logged as lost
```

- Every alert is written to the log, pushed or not. Severity maps to the log level
  (critical = `error`, warning = `warn`).
- "History": on a start without saved state, events older than head minus `LOOKBACK_BLOCKS` are
  logged with `"pushed":false` and not sent, so a restart (or a `START_BLOCK` far back) never
  re-sends old alerts. With `STATE_FILE`, nothing after the saved cursor is ever history.
- A burst (e.g. `AddAssets` registering 30 assets = 60 events) is packed into a handful of messages.
- A `[RESOLVED]` keeps the severity of what it resolves, so it reaches the same sinks.
- Everything sent is redacted: every URL except explorer links, and the RPC URL, bot token, webhook
  URL and keeper health URL / token verbatim. Error messages are cut to their first line.
- Telegram: create a bot with @BotFather (token), add it to the alert group, send one message,
  read the chat id (negative for groups) from `https://api.telegram.org/bot<token>/getUpdates`.
  A common split: Telegram `critical` (phones), the webhook `info` (a Discord channel with everything).

### 1.5 Forensics: replay any range

```bash
cd engine
set -a; . ../contracts/.env; set +a; export RPC_URL="$RHC_RPC_URL"; unset KEEPER_PK DEPLOYER_PK
START_BLOCK=76221269 bun run src/monitor/run.ts --once > /tmp/spare-history.jsonl
```

`--once` scans `START_BLOCK` to head, runs every check once, prints a summary and exits. With no sink
variables set it only writes logs. Run on 2026-10-02 from the deploy block it decoded the real
history: 7 `OwnershipTransferred` (deploy, straight to the owner), 38 `AssetSet`, 27 `AssetActive`,
1 `DefaultMixSet`, 2 `CallerSet` (SweepExecutor, SgovParkAdapter), `ExecutorSet`, `AdapterSet`
(UsdgParkAdapter), 2 `KeeperSet`, `ParamsSet`, 7 `PauserSet`; plus the keeper's 2 `Accrued`
and 1 `Linked`. All 35 wiring checks passed.

---

## 2. Incident playbooks

### 2.1 Pause

Use it when the keeper, a market or an oracle is doing something wrong and new buys or pulls must
stop now. Pause `SweepExecutor` (stops accruals and sweeps) and `CashPark` (stops parking); the
commands are in section 0. Then:

1. Say so publicly (X, Telegram): "New round-ups and buys are paused. Your balance is safe and
   Exit works." Exit really does work: pause never gates it.
2. Find the cause with the keeper logs, the monitor's alerts and the explorer.
3. Unpause only with the owner key, once the cause is fixed. The keeper resumes by itself.

Pause will not save you from a compromised owner key (section 0); that is 2.3.

### 2.2 Keeper key compromised (or lost)

What a thief with `KEEPER_PK` can do, all bounded on-chain: accrue up to each linked wallet's
weekly cap and Permit2 allowance, but only into **that user's own** park balance (they can exit
it); send sweeps whose fills the router still holds to the oracle band (about 1.5% worse at most);
call `CashPark.park`; burn the keeper's ETH. It cannot withdraw, redirect a delivery or block an
exit.

1. Pause `SweepExecutor` and `CashPark` (section 0). The monitor will show `Paused` and
   `wiring.*.paused`; that is expected.
2. Make a new keeper key offline (`cast wallet new`), keep it out of chat and logs.
3. Grant the new key, revoke the old one, on **both** contracts:

   ```bash
   NEW=0x...    # new keeper address
   OLD=0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03
   for C in 0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab 0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb; do
     cast send $C "setKeeper(address,bool)" $NEW true  --rpc-url "$RHC_RPC_URL" --private-key "$DEPLOYER_PK"
     cast send $C "setKeeper(address,bool)" $OLD false --rpc-url "$RHC_RPC_URL" --private-key "$DEPLOYER_PK"
   done
   ```

4. The `spare-keeper` service: replace `KEEPER_PK` (sealed). Fund the new address with ETH (at least
   `KEEPER_MIN_ETH`). Deploy by SHA and watch `/health` and its logs.
5. Monitor: set `KEEPER_ADDRESS=<new>` on `spare-monitor` (or update `roles.keeper` in its
   `ADDRESSES_JSON`), and update `roles.keeper` in `contracts/addresses/4663.json` and
   `contracts/config/4663.json` in git. Until then the monitor reports the new keeper as an
   unknown, critical `KeeperSet` and `wiring.*.isKeeper` as broken: expected during a rotation.
6. Unpause (owner).
7. Audit what the old key did: `START_BLOCK=<compromise block> bun run src/monitor/run.ts --once`
   and the explorer's transaction list for the old address. Every `Accrued` amount can be checked
   against the wallet's public payments (docs/SPARE-BUILD.md §3.1); the USDG is in each user's own
   park.

### 2.3 Owner key compromised

This is the worst case and there is no admin recovery: the contracts are immutable and the owner
is one EOA. A thief can `CashPark.setExecutor(self)` and `withdrawForSweep` every account's parked
USDG; `setKeeper(self)` and accrue fabricated round-ups (up to caps and allowances) to then take
them too; point an asset at a hostile pool; `transferOwnership` away. It cannot touch delivered
stock (already in users' wallets), `claimable` (paid only to the account), caps or links.

Signals: any critical `ExecutorSet`, `KeeperSet`, `CallerSet`, `AdapterSet`, `PauserSet`,
`AttestorSet`, `OwnershipTransferStarted` / `Transferred`, or a `wiring.*` mismatch you did not
cause.

1. Protect users first, in this order, publicly and on every channel:
   - **Exit now**: Balance window, Exit (`CashPark.exit()`). It is never gated.
   - Stop new pulls: turn round-ups off or unlink the wallet in the app (`RuleRegistry.setRule(...,
     enabled=false)` / `unlink`), and revoke Permit2: `Permit2.approve(USDG, SweepExecutor, 0, 0)`
     or `lockdown`. Permit2 is `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
2. If the legitimate holder still controls the key and the thief has only nominated a new owner
   (`OwnershipTransferStarted`, `wiring.*.pendingOwner`), overwrite the nomination on each
   contract with an address only you control (`transferOwnership(<fresh Safe>)`) and accept from
   it at once. It is a race against the same key: do it immediately, from a clean machine.
3. Rotate the keeper anyway (2.2), and take the frontend's buy and link flows offline.
4. Afterwards: a fresh deployment owned by a Safe plus timelock (3.6); users move by exiting and
   linking again.

### 2.4 Oracle or sequencer outage

`OracleGuard` returns a status, never a revert, and the executor **defers every non-OK leg**: the
USDG goes back to the park and is retried next epoch, with no fee and never a USDG payout.
Statuses in keeper logs (`waiting: <asset> oracle status N`) and `Deferred` events: 1 STALE
(older than heartbeat + 1 h), 2 PAUSED (token `paused` / `oraclePaused`), 3 SEQUENCER_DOWN,
4 BAD_ANSWER. The keeper also waits on its own market gate until a feed has posted since the session
opened, so a closed market or a holiday is a wait, not an incident.

- Stale or paused feed on a trading day: usually wait. If one asset holds every co-batched account
  back for long, consider deactivating it (`AssetRegistry.setActive(token, false)`): its queued
  legs are then **paid out as USDG** (`SafeSettled`) at the next sweep, a decision for the owner.
- A feed that is live but **wrong**: the oracle band trusts the oracle, so pause `SweepExecutor`
  first, then deactivate the asset.
- Stock splits: `OracleGuard` (on-chain) ignores the token's `uiMultiplier` / `effectiveAt`. The
  keeper holds such an asset back while its feed lags a multiplier change (log: `multiplier change
  not yet in the feed`), but a keeper is not a contract guarantee: if a split's effective time is
  near and the feed has not moved, deactivate the asset (or pause sweeps) until it does.
- Sequencer: no sequencer-uptime feed exists for RHC yet (`StockRouter.sequencerFeed` = 0). A
  sequencer halt stops every transaction, ours and anyone's. After a long halt, pause sweeps for
  an hour while prices settle. When Chainlink publishes an RHC uptime feed:
  `StockRouter.setSequencerFeed(feed)` (the monitor reports `SequencerFeedSet`).

### 2.5 RPC outage

- Keeper: ticks fail and are logged; nothing is sent, so no funds are at risk. After 5 failed ticks
  its `/health` says `ok:false` (monitor: `keeper.unhealthy`). Point `RPC_URL` on `spare-keeper` at
  a backup endpoint and redeploy.
- Monitor: `rpc.down` after `RPC_DOWN_MINUTES`; it catches up on recovery and alerts the gap. Give
  it a different provider from the keeper's.
- spare-api uses the public RPC; reads degrade but nothing is at risk.
- Never put a keyed RPC URL where an error can echo it to a client. The monitor redacts URLs from
  everything it logs or sends.

### 2.6 Stuck or deferred sweeps

Signals: `sweep.overdue`, `SwapDeferred` (with the decoded revert reason), and the keeper's sweep
log line, which names every asset it is holding back and why (`N due, none sweepable`,
`held this tick: <asset> (<why>)`, `(N waiting: <asset> <why>)`).

| Cause | Looks like | Do |
|---|---|---|
| market closed / no post since the open | keeper `waiting: … market closed` | nothing; the overdue clock stops while closed |
| oracle not OK | `waiting: … oracle status N`, `Deferred` | section 2.4 |
| pool cannot quote, or quotes too far from the oracle (drained, moved, hook paused) | `held this tick: <asset> (…)` | check the pool; if it persists re-pin or deactivate (3.3) |
| a hooked pool off its pin: fee above the ceiling, cap, authority or code changed | `held this tick: <asset> (hook fee N pips is above the keeper's M)` or `(hook … is not the pinned …)` | MU's opening descent (~26 min after the bell) clears by itself; otherwise review the hook and the monitor's hook alerts (1.2), re-pin (`HOOK_PINS`, `config/4663.json`) or deactivate (3.3) |
| an earlier isolated (whale) call's impact still in the pool (A-M1) | `held this tick: <asset> ($1 quote X bps under its value before an isolated sweep (max 10))`; keeper `/health` `assetsRecovering` | automatic: released once the $1 quote is back within `SWEEP_RECOVERY_BPS` (10) of its pre-sweep value, rebased by any oracle move, or after `SWEEP_RECOVERY_MAX_MS` (4 h). The hold lives in keeper memory: a restart forgets it |
| fill outside the band / under the keeper's limit | `SwapDeferred` reason `OutsideOracleBand` or `BelowMinOut` | pool price diverged or moved; re-measure; re-pin if it persists |
| pool too thin for the netted size | `SwapDeferred` reason `PartialFill` | smaller batches (keeper caps), or re-pin to a deeper pool |
| batch too large | keeper `estimate … gas; halving the batch` | automatic |
| a swap ran out of gas inside the sweep | `SwapDeferred` with an **empty** reason; keeper `OUT OF GAS: sweep …` and `out of gas, deferred: <asset>` | automatic: later sweeps go out at 2x, then 3x the estimate (`/health` `gasMultiplier`). The legs are back in the park and retried next epoch. If it recurs at 3x, capture the logs and the tx |
| executor paused | keeper `executor paused; skipping` | 2.1 |
| a delivery refused by the token | `DeliveryHeld` | the user calls `SweepExecutor.claim(token)`; never gated |

Accruals that wait are user-side: keeper lines `held: N no-consent` (no Permit2 / USDG approval),
`clamped-to-zero` (weekly cap used, balance or allowance 0). Nothing to do but tell the user.

### 2.7 Keeper out of gas, idle or stalled

- `balance.keeper`: send ETH to `0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03` from any wallet. No
  restart needed.
- `keeper.idle`: check `spare-keeper` is running and its latest log lines. Common causes: crashed
  or not redeployed, out of gas, `KEEPER_BROADCAST` not `1`, its RPC down, the executor paused.
- `keeper.stalled`: the process answers `/health` but its loop is stuck. Restart the service; if it
  recurs, capture the logs first.
- `keeper.unreachable`: the service is down, or the private URL / port is wrong. If it fires from
  the very first poll after setup, check `KEEPER_HEALTH_URL` (service name, the keeper's `PORT`).
  The keeper's `/health` listens on `HOST:PORT`; `HOST` is optional and defaults to `::`
  (dual-stack). On an IPv6 private network never set `HOST=0.0.0.0`: the keeper
  would answer on IPv4 only and the monitor could not reach it.
- Keeper log `OUT OF GAS: accrueBatch …` (an `AccrualSkipped` with an empty reason, or a keeper tx
  that reverted having used its whole gas limit): the executor caught an accrual that ran out of
  gas and the tx still succeeded. Nothing to do: the wallets are retried next tick without
  backoff and the keeper's gas multiple steps from 1.5x to 2x, then 3x of the estimate (`/health`
  `gasMultiplier`; a restart resets it). Only at 3x does a wallet that keeps failing back off. If
  it recurs at 3x, capture the logs and the tx and compare its gas used with its limit.

---

## 3. Owner operations

### 3.1 Go-live gate

`Deploy.s.sol` and `AddAssets.s.sol` refuse to broadcast on 4663 unless
`SPARE_MAINNET_ACK=owner-approved` is set. The owner sets it for the one run they approved, after
reading the dry run (the same command without `--broadcast`). Never leave it in a shell profile.

### 3.2 Accept ownership and verify the deployment

`Deploy.s.sol` deploys with the deployer as owner and, if `roles.owner` differs, only **nominates**
it (`transferOwnership`, Ownable2Step). The new owner must call `acceptOwnership()` on all 7 owned
contracts: `scripts/spare-forge.sh AcceptOwnership --rpc-url "$RHC_RPC_URL"` prints the pending
calls (and a Safe Transaction Builder batch); with an EOA owner add `--broadcast` and its key. When
the pending owner is a timelock it prints no batch and refuses `--broadcast`: follow 3.6.
Then verify every wire, read-only:

```bash
scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"
SPARE_REQUIRE_ACCEPTED=true scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"   # fail while any nomination is pending
```

The live deployment has owner = deployer, so no hand-over was needed (the monitor's replay shows 7
`OwnershipTransferred` from address(0) straight to the owner and no `OwnershipTransferStarted`).

### 3.3 Asset activation checklist

Source of truth: `contracts/config/4663.json`. `AddAssets.s.sol` makes the registry match it.

1. Measure real fills, not quotes: on an anvil fork, `StockRouter.buy` at $5 and $100 against the
   router's own Chainlink price. Activate only if both are at least -1.2%. Prefer hookless pools: the
   hooked NVDA pool quoted normally but filled about 3% worse (NVDA is pinned to the hookless
   fee-100 pool).
2. Record the PoolKey, `active` and the measurement in the config. For a hooked pool also record
   `hookCodehash`, `hookAuthority` and `hookMaxFeePips`. AddAssets and VerifyDeployment refuse a
   hook whose code hash is unpinned or different, whose authority is not the pinned one, that has a
   `*_RETURNS_DELTA` permission, or whose fee ceiling is not inside the band. Then give the keeper
   and the monitor the same pin (`HOOK_PINS`; built in at `engine/src/keeper/hooks.ts`): the keeper
   holds any hooked asset it has no pin for.
3. Dry run: `scripts/spare-forge.sh AddAssets --rpc-url "$RHC_RPC_URL" --sender <registry owner>`.
   Read the action list.
4. Apply with the owner key and `SPARE_MAINNET_ACK=owner-approved` (3.1).
5. Expect one `AssetSet` and (if activated) one `AssetActive` warning per asset from the monitor;
   anything else at that time is not yours.

The registry has no deregister: retire an asset by deactivating it (its queued legs safe-settle to
USDG).

### 3.4 Switching to the SGOV adapter

Do **not** switch while these audit items stand (they need a new adapter, since the deployed one is
immutable): SGOV churn by a malicious keeper (A-L2: park then sweep costs about 1.9% per epoch);
`SgovParkAdapter.valueOf` has no try/catch (one reverting feed blocks every sweep); no keeper
minOut on unpark, no holding period, no user minOut on `exit`; a 150 bps band is too wide for a
T-bill ETF (25-50 bps).

Mechanics, for when an adapter is ready: `CashPark.setAdapter(adapter)` reverts while any units are
parked (`totalUnits != 0`). The monitor raises `AdapterSet` and `wiring.CashPark.adapter` until its
`ADDRESSES_JSON` says `"parkAdapter": {"live": "SgovParkAdapter"}`. Verify with
`SPARE_EXPECT_PARK_ADAPTER=sgov scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"`.

### 3.5 Explicit gas limits for hooked pools

A Uniswap v4 hook is arbitrary code; the hooked NVDA pool charged about 3% on swaps sent with a low
gas limit. `scripts/dev-smoke.sh` therefore sends its sweep with an explicit `SWEEP_GAS_LIMIT`
(default 8M). Pin hookless pools where they exist (3.3); for any hooked pool, measure fills with the
gas limit the keeper actually sends.

### 3.6 Owner to a Safe plus a timelock (no redeploy)

The full procedure, with the commands, is [`GOVERNANCE.md`](GOVERNANCE.md); every script lives in
`contracts/` and checks the Safes and the timelock before it sends anything. In short:

0. Rehearse on a fork and check the live state (`scripts/rehearse-governance.sh`, `VerifyDeployment`,
   `scripts/roles.sh`). No key, nothing touches mainnet.
1. The owner EOA deploys the timelock (`script/governance/DeployTimelock.s.sol`): minDelay 48 h,
   the 2-of-3 owner Safe as its only proposer, canceller and executor.
2. The owner EOA hands over (`script/governance/HandOver.s.sol`): pauser and attestor to the pauser
   Safe at once, then `transferOwnership(timelock)` on all 7 (the monitor shows 7 critical
   `OwnershipTransferStarted`: expected). The EOA stays owner until step 5.
3. The owner Safe schedules the `acceptOwnership()` batch: `script/governance/TimelockBatch.s.sol`
   prints the `SCHEDULE` Safe Transaction Builder JSON. Not `AcceptOwnership.s.sol`: with the
   timelock as pending owner it prints no Safe batch and refuses `--broadcast`.
4. Wait 48 h; cancel anything scheduled that is not this batch.
5. The owner Safe executes it: `TimelockBatch.s.sol` again, once it shows `state Ready`, prints the
   `EXECUTE` JSON.
6. Verify and update the books: `SPARE_REQUIRE_ACCEPTED=true` `VerifyDeployment`, the address book
   and config roles, and the monitor (`TIMELOCK_ADDRESS`, `OWNER_ADDRESS=<timelock>`,
   `PAUSER_ADDRESS=<pauser Safe>`, `OWNER_MIN_ETH=0`, a `PAUSER_MIN_ETH`). Every owner action then
   appears first as a critical `Timelock: call SCHEDULED` with the decoded call, 48 h before it can
   execute; the owner Safe stops a hostile one with `cancel(id)`.

After the hand-over every owner action, registry changes from `AddAssets.s.sol` included, goes
through `TimelockBatch.s.sol` ("Living with the timelock" in `GOVERNANCE.md`).
