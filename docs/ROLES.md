# SPARE — roles and privileged functions

Every function on the 10 mainnet contracts (Robinhood Chain, chain 4663) that not
everyone can call: who can call it, who that is today, what bounds the contract puts
on it, and what it can never reach. Addresses and explorer links:
[`DEPLOYMENT-4663.md`](DEPLOYMENT-4663.md). The plan to move the owner to a Safe and
a 48 h timelock: [`GOVERNANCE.md`](GOVERNANCE.md).

Holders below were read live on 2026-10-03 at 00:39 UTC, block 78666930, with
`contracts/scripts/roles.sh` (its output:
[`contracts/deployments/4663-roles-2026-10-03.txt`](../contracts/deployments/4663-roles-2026-10-03.txt)).
Run it again at any time; it lists keepers and router callers from their `KeeperSet` /
`CallerSet` logs and re-reads each one live. Times here are UTC.

## Who holds what

| Role | Holder today | Kind | Where it counts |
|---|---|---|---|
| owner | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189` | EOA, software key (the deployer) | the 7 Ownable2Step contracts below |
| pending owner | none on any contract | — | — |
| pauser | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189` (same EOA) | EOA | the 7; the flag only gates `SweepExecutor` and `CashPark` |
| attestor | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189` (same EOA) | EOA | `ScreeningGate` (screening is OFF: `enforced = false`) |
| keeper | `0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03` | EOA hot key, keeper service only | `CashPark`, `SweepExecutor`. Granted 2026-10-02 23:31 UTC (blocks 78626507, 78626535), a fresh key before the public release; the original keeper `0xB7FE91DF829FD2F616c111EDFb9f7B5703FE84fD`, granted at deploy (blocks 76222004 on CashPark, 76222024 on SweepExecutor), was revoked at 23:35 UTC (blocks 78628466, 78628492). These six are all the `KeeperSet` events |
| executor | `SweepExecutor` `0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab` | contract | `CashPark` |
| router callers | `SweepExecutor`; `SgovParkAdapter` `0x4197a7Eb8e08a35fd55273afA3D0f8Cb3bd98525` (pre-authorised, standby) | contracts | `StockRouter` |
| park | `CashPark` `0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb` | contract, immutable | both park adapters |

**Ownable2Step (7):** `AssetRegistry`, `ElectionRegistry`, `ScreeningGate`,
`StockRouter`, `CashPark`, `FeeVault`, `SweepExecutor`. All inherit `SpareAuth`, which is
OpenZeppelin 5.0.2 `Ownable2Step` plus the keeper / pauser roles.
**No owner (3):** `RuleRegistry` has no admin at all; `UsdgParkAdapter` and
`SgovParkAdapter` have only immutable wiring and answer to `CashPark` alone.

Value held at block 78666930: `CashPark` 0 USDG (`totalPending` 0, `totalUnits` 0),
`FeeVault` 0 USDG. Registry at the same block: 36 assets registered, 26 active, 10 on
standby (the registry change of 2026-10-02 benched INTC and re-pinned MU to a
hooked pool).

### Outside Spare: the operator of the MU and GME pool hooks

Two active assets swap through pools whose Uniswap v4 hook belongs to a third party, so
someone who is not Spare sets the fee those swaps pay. Spare's owner cannot change it;
it can only re-pin or deactivate the asset (`AssetRegistry.setAsset` / `setActive`).

| Party | Address | Controls | Bounds (fee caps read on-chain at block 78513071; roles at block 78668723) | Cannot touch |
|---|---|---|---|---|
| Fables hook authority | `0xA362D98B33A7bb5B5E2180a05f995A70FB404f30`, an OpenZeppelin `AccessManager` (Spare holds no role in it). Its admin (`ADMIN_ROLE`, role 0): one account, `0x359856655934338d798F9ccE1f181486301D36a5`, a 7702-delegated EOA; its three fee pokers (`FEE_POKER`, role 1): `0xb9e8db60e88f8949ce0b91d451b269d0108c03d9`, `0x1b6a8808e1d26dba66ba11e52997803c43cad429`, `0x014f37fa6f0608c71a7bbc3adf3b587cc24a2163`; a pauser (`PAUSER`, role 4): `0x5cda43da9631fb84d390d91e750f549b7ada721c`; a calendar operator (`CALENDAR_OPS`, role 2): `0xb9e8db60e88f8949ce0b91d451b269d0108c03d9` (also a poker). The admin also holds `POKER_ADMIN` (role 5) and `PAUSER_ADMIN` (role 6), which administer roles 1 and 4. Every member acts with execution delay 0, except the calendar operator (3600 s). Role 9 (`setClaimFeeBps`) has no member. Moving a hook to another authority waits on its 1-day target admin delay (86400 s). The monitor alerts on its role, delay, target and operation events | the dynamic LP fee of the MU pool (hook FablesRWA `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080`) and the GME pool (hook FablesRamp `0x08E52564Bad99E05a694b4809F397edcA417A080`): the admin sets the fee schedule (`setPoolConfig`, the cap included) and a directional premium (`setPoolAsymmetry`); a poker pushes a fee (`pokeFee`) for up to 72 h, renewable; the pauser can `pause` a hook, `pausePool` a pool and `clearPoke` a pushed fee, on both hooks; the calendar operator can change the MU hook's trading calendar (`setSessionHours`, `setDayOverrides`, `setDstMode`, `setEarlyClose`), which drives MU's scheduled fee. Any of it at any time, without notice | fee per pool at most `maxFee(poolId)`: 50000 pips = 5% (MU) and 20000 = 2% (GME); the admin can raise a cap, never above the hooks' `ABSOLUTE_MAX_FEE` of 5%. The hooks have only beforeInitialize and beforeSwap permissions (no return-delta flags), so they set the fee or revert, never a swap's amounts | Spare's contracts, funds, registry or keeper. A paused hook or pool makes those legs revert and defer; a fee above Spare's limits makes them defer or wait (the router's 150 bps band, the executor's slippage cap, the keeper's quote checks); accepted risk A-L3 in [`SECURITY.md`](../SECURITY.md) |

## Privileged functions

"Bounds" are what the contract itself enforces. "Cannot touch" is what the caller
cannot reach through this function, whoever holds the role.

### On all 7 (`SpareAuth` / OpenZeppelin `Ownable2Step`)

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setKeeper(keeper, enabled)` | owner | EOA | `keeper != 0` | Only `CashPark.park` and `SweepExecutor.accrue/accrueBatch/sweep` read `isKeeper`; on the other five it is inert |
| `setPauser(pauser)` | owner | EOA | none (0 allowed: then only the owner can pause) | — |
| `pause()` | pauser or owner | EOA | sets `paused` | `CashPark.exit`, `SweepExecutor.claim`, every user setting. The flag gates only `SweepExecutor.accrue/accrueBatch/sweep` and `CashPark.park`; on `AssetRegistry`, `ElectionRegistry`, `ScreeningGate`, `StockRouter`, `FeeVault` no function reads it |
| `unpause()` | owner only | EOA | — | — (unpausing is the riskier direction, so the pauser cannot) |
| `transferOwnership(newOwner)` | owner | EOA | two-step: `newOwner` becomes `pendingOwner` only | ownership does not move until `acceptOwnership` |
| `acceptOwnership()` | pending owner | — | — | — |
| `renounceOwnership()` | owner | EOA | sets owner to 0, irreversible | — (freezes every owner setting forever; never part of any runbook) |

### `AssetRegistry` `0x6dA6e49E2c59b622697a208a83bF266D5268c937`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setAsset(token, feed, heartbeat, bandBps, key)` | owner | EOA | token, feed `!= 0`; `heartbeat > 0` (no upper bound); `1 <= bandBps <= 1000` (10%); the PoolKey must be exactly USDG/token in v4 sort order (hook unrestricted); new assets start INACTIVE; no 18-decimals check on the token | delivered stock, user mixes, balances. **Re-pinning an ACTIVE asset keeps it active**: the owner can point a live asset at any USDG/token pool (any hook) and any feed |
| `setActive(token, active)` | owner | EOA | token must be registered; no deregistration | deactivating makes the next sweep SAFE-SETTLE that leg to the user as USDG (the only path that pays USDG out of a sweep) |

### `ElectionRegistry` `0x05fB5B11B676BC0Fbf893480b4101fB7C8Db0543`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setDefaultMix(legs)` | owner | EOA | 1–6 legs, every asset ACTIVE, no duplicates, bps sum exactly 10000 | any account's own mix (`setMix` / `clearMix` are the account's alone); applies only to accounts without one |

### `ScreeningGate` `0xC3289C38c53055d58009B2fa9499c753b3dBCED3`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setAttestor(attestor)` | owner | EOA | none | — |
| `setEnforced(enforced)` | owner | EOA | none | exits, USDG withdrawals, claims. Enforcing with nobody cleared makes every sweep skip every account (spare stays parked; nothing is lost) |
| `clear(account, validUntil)` | attestor | EOA | any account, any expiry | — |
| `submitClearance(validUntil, sig)` | the account, with an attestor ECDSA signature | — | `validUntil >= now`; nonce per account | a Safe attestor cannot sign these (plain `ECDSA.recover`, no ERC-1271); it uses `clear` instead |
| `revoke(account)` | attestor or owner | EOA | bumps the account's nonce | — |

### `StockRouter` `0x1Fec3654Fea787a63104a6634C9781B837B5e17E`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setCaller(caller, enabled)` | owner | EOA | none | anyone else's funds: a caller swaps only tokens it sends itself, through the registry's pinned pool, inside the oracle band |
| `setSequencerFeed(feed)` | owner | EOA (feed is 0 today: no RHC sequencer feed exists) | none | funds. A feed reporting "down" turns every oracle status non-OK, so every leg DEFERS (buys stop, exits do not) |
| `buy(token, usdgIn, minOut, recipient)` | caller | `SweepExecutor`, `SgovParkAdapter` | asset ACTIVE; oracle OK (staleness vs heartbeat, token paused, sequencer); exact-input fill; `out >= minOut`; `out >= oracle * (1 - bandBps)` | the pool choice (comes from the registry, never the caller) |
| `sell(token, tokensIn, minOut, recipient)` | caller | same | oracle OK; exact-input; `minOut`; band | same |

### `CashPark` `0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setExecutor(executor)` | owner | EOA | none | — **This is the drain path**: an owner can make itself the executor and call `withdrawForSweep` on every account, taking all parked USDG in one transaction (audit D; the audit's PoC `test_R1_ownerPullsFreshCapAndDrains`) |
| `setAdapter(adapter)` | owner | EOA | only while `totalUnits == 0` | open parked positions. A hostile adapter would receive pending USDG on the next keeper `park` |
| `credit(account, amount)` | executor | `SweepExecutor` | pulls the USDG from the executor | — |
| `withdrawForSweep(account)` | executor | `SweepExecutor` | pays the executor the account's pending + redeemable units | — |
| `returnFromSweep(account, amount)` | executor | `SweepExecutor` | pulls the USDG back in | — |
| `park(accounts)` | keeper, not paused | keeper key | no-op while the adapter is not fresh; units split pro-rata | balances leave only into the configured adapter (with the live `UsdgParkAdapter`, value is unchanged) |
| `exit()` | the account itself | everyone | never paused; pending USDG first, then units redeemed or handed over in kind | — |

### `FeeVault` `0xF5B9C500998D122fbBB606f23DBEe91Aa5549add`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `withdraw(token, to, amount)` | owner | EOA | `to != 0` | anything outside the vault; the vault only ever receives the conversion fee (holds 0 today) |

### `SweepExecutor` `0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab`

| Function | Gate | Holder today | Bounds | Cannot touch |
|---|---|---|---|---|
| `setParams(finalityBuffer, threshold, feeBps, slippageBps, epochLength)` | owner | EOA | `feeBps <= 100` (1%), `slippageBps <= 500` (5%), `threshold >= 1e6` ($1), `epochLength >= 1 h`; `finalityBuffer` unbounded, 0 accepted | caps, links, delivered stock, `claimable` |
| `accrue(account, wallet, amount, toBlock)` / `accrueBatch(batch)` | keeper, not paused | keeper key | wallet linked to the account; rule enabled with cap > 0; range starts at max(cursor, `linkedAt`, `activeSince`) and must advance; `toBlock + finalityBuffer <= head`; rolling-7-day cap (7 day-buckets, audit A-L1); the user's Permit2 allowance; max 64 per batch | where the money goes: it lands in the user's own `CashPark` balance |
| `sweep(accounts, limits)` | keeper, not paused | keeper key | once per account per epoch; balance >= threshold; screening; per asset min out = max(keeper limit, oracle − `slippageBps`), then the router band; any failure DEFERS; max 64 accounts | delivered stock (always to the account, or `claimable` for it) |
| `accrueSelf(...)` | this contract only | — | used by `accrueBatch`'s per-entry try/catch | — |
| `claim(token)` | the account itself | everyone | pays `msg.sender` only; never paused | — |

### No admin

| Contract | Notes |
|---|---|
| `RuleRegistry` `0x477504Fdd8929fC75Ac6836C2aa131D765e85f78` | `setRule`, `linkSelf`, `linkWallet` (the wallet's EIP-712 / ERC-1271 signature), `unlink` (account or wallet), `invalidateNonce`: every call acts on the caller's own record |
| `UsdgParkAdapter` `0x1E29fD4F78cDfabdE3Df605e66aE3d78a8980DD8` | `deposit` / `redeem` / `exitInKind`: `CashPark` only (immutable `park`) |
| `SgovParkAdapter` `0x4197a7Eb8e08a35fd55273afA3D0f8Cb3bd98525` | same, plus it routes through `StockRouter` as a caller. Standby: not `CashPark.adapter` |

## What the owner can and cannot do

**Can, today, in one transaction and without notice** (audit D): take every parked USDG
(`CashPark.setExecutor` then `withdrawForSweep`); make itself keeper and accrue fabricated
round-ups up to each user's cap and Permit2 allowance (the cap per window, so up to 2×
within 6 days and 1 second, A-L1; the app's Permit2 allowance has no amount limit), then
take them the same way; re-pin a live asset to a pool and feed it controls; raise the fee, executor slippage and asset band to 1%, 5% and 10%;
enforce screening or set a sequencer feed that stops all buys; withdraw fees; renounce.
The pauser is the same key, so pausing gives no protection against this key.

**Cannot, ever:** move stock already delivered to a user's wallet; touch `claimable`
(`claim` pays the account only); change a user's rule, cap, links or own mix; pull from a
wallet beyond the Permit2 allowance and weekly cap that user set; block `CashPark.exit`
or `SweepExecutor.claim`.

**After the hand-over** ([`GOVERNANCE.md`](GOVERNANCE.md)) the "can" list is unchanged in
kind but every item needs a 2-of-3 owner Safe AND a 48 h public `CallScheduled` notice on
the timelock, during which users can exit and the owner Safe can cancel. Pausing stays
instant (pauser Safe).

## The keeper is bounded

The keeper key (`KEEPER_PK`, on the keeper service only) can: accrue amounts it attests
(the contract cannot check them against the payments) up to each user's cap per window
and Permit2 allowance into that user's own park; run `park`; run `sweep` with
buys bounded by the oracle (`slippageBps` 150 = −1.5%) and each asset's band. It cannot
withdraw, redirect deliveries, change any setting, or block exits. If it is lost or
compromised: the pauser pauses (`SweepExecutor` + `CashPark`), then the owner replaces it
(`setKeeper(old, false)`, `setKeeper(new, true)`) and unpauses.

## After the hand-over

| Contract | Function | Gate | Holder | Bounds |
|---|---|---|---|---|
| `TimelockController` | `schedule` / `scheduleBatch` | PROPOSER | owner Safe (2 of 3) | delay >= `getMinDelay()` (172800 s) |
| | `cancel` | CANCELLER | owner Safe | only Waiting / Ready operations |
| | `execute` / `executeBatch` | EXECUTOR | owner Safe | only once Ready (delay elapsed), exactly the scheduled calls |
| | `updateDelay`, `grantRole`, `revokeRole` | the timelock itself | via a scheduled operation | 48 h like everything else |
| the 7 | every owner function above | owner | the timelock | as above, plus 48 h |
| the 7 | `pause()` | pauser or owner | pauser Safe | instant |
| `ScreeningGate` | `clear`, `revoke` | attestor | pauser Safe by default (`SPARE_ATTESTOR`) | as above |

Known keeper-side risks the audit rates Low and acceptable while they stay as they are:
A-L1 (the rolling cap is 7 day-buckets, so up to 2× `weeklyCap` inside 6 days + 1 second;
keeper-only, and the funds land in the user's own park) and A-L2 (SGOV churn by a
malicious keeper; acceptable only while the SGOV adapter stays on standby, i.e. until a
keeper `minOut` on unpark, a holding period, a user `minOut` on `exit`, a 25–50 bps
band and a try/catch around the adapter's feed read exist). A-M1 (one account's size
setting the netted fill) is mitigated by the keeper alone, and A-L3 is the hook operator
above; both, with their residual bounds, are under "Accepted risks" in
[`SECURITY.md`](../SECURITY.md).
