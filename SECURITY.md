# Security

Spare is live on Robinhood Chain mainnet (chain 4663) and holds users' spare change in
immutable contracts (no proxies, no upgrade path). If you find a way to lose, freeze or
misdirect anyone's USDG or stock, or to make Spare pull more than a user allowed, we want to
hear it first.

## Report a vulnerability

- **Preferred: GitHub private vulnerability reporting.** On this repository's GitHub page,
  open the **Security** tab and choose **Report a vulnerability**. Only the maintainers
  see it.
- **Or Telegram: [t.me/sparerh](https://t.me/sparerh).** Ask an admin for a private chat and
  send the details there, never in the public group.

Please include what is affected (contract and function, or service and route), the impact,
and a proof of concept. A Foundry test on an anvil fork of mainnet is ideal:
`bash scripts/dev-fork.sh` starts one with Spare deployed. Do not test against mainnet with
other people's funds, and do not run load against the public endpoints.

We confirm receipt, reproduce, fix (or pause, see below) and then publish an advisory
crediting you unless you prefer otherwise. Please keep the issue private until a fix or a
mitigation is live; we will agree a disclosure date with you.

## Scope

In scope, highest interest first:

| Area | Where | What we want to know |
|---|---|---|
| Accrual bounds | `SweepExecutor.accrue`, `accrueBatch`, `accrueSelf` | Any pull beyond the user's rule: past the rolling weekly cap or the Permit2 allowance, from a wallet that is not linked, before the link or rule (`activeSince`), inside the finality buffer, or the same block range twice |
| Delivery and claim | `SweepExecutor.sweep`, `_deliver`, `claimable`, `claim(token)` | Stock or USDG delivered to anyone but the account, a leg settled at a worse price than the keeper limit, the oracle band and the pinned PoolKey allow, or a `claim` that pays someone else |
| Park exit | `CashPark.exit` | Anything that blocks or shortchanges an exit: pause, adapter state, a paused issuer token, a reverting feed. Exit is never supposed to be gated |
| Fills and oracles | `StockRouter`, `OracleGuard` | A swap outside the allowlisted PoolKey, a stale / paused / non-positive price treated as OK, a band bypass |
| Keeper | `engine/src/keeper` | Ways to make the keeper sign something outside its bounds (below), leak `KEEPER_PK`, or stall accruals and sweeps. Only the keeper service holds the key: the engine API and workers take `KEEPER_ADDRESS`, and their detailed tRPC `health` needs the `HEALTH_TOKEN` bearer |
| spare-api | `server/` (`/health`, `/mcp`, `/api/mcp/*`, `/api/spare/*`) | Secret or RPC-key leakage, data exposure, resource exhaustion from a single client |
| Site | `https://trysparerh.com` (`src/`) | A transaction or signature request that does something other than what the UI says |

Addresses of all 10 contracts: [`contracts/addresses/4663.json`](contracts/addresses/4663.json)
and [`docs/DEPLOYMENT-4663.md`](docs/DEPLOYMENT-4663.md).

Out of scope: what the owner can do with the owner key (it is documented below and in
[`docs/ROLES.md`](docs/ROLES.md); report it if anyone else can reach those functions), the
accepted risks below, volumetric DoS, social engineering, and bugs in Robinhood Chain, the
stock-token issuer contracts, Chainlink, Uniswap v4, the third-party hooks on the MU and
GME pools, Permit2 or USDG themselves (report those upstream; tell us if Spare mishandles
them).

## Privileged roles

Every privileged function, its holder today and the bounds the contracts enforce:
[`docs/ROLES.md`](docs/ROLES.md). In short:

| Role | Holder today | Can | Cannot |
|---|---|---|---|
| owner (7 `Ownable2Step` contracts) | single EOA `0x56B67D71039365083727b661Dbe9Bdb7f7D15189`, a software key | change assets and parameters within their caps (fee ≤ 1%, slippage ≤ 5%, band ≤ 10%), rotate the keeper, pauser and executor, unpause. In one transaction and without notice it can also: take all parked USDG (`CashPark.setExecutor` to itself, then `withdrawForSweep` on every account); make itself keeper and accrue made-up round-ups from every wallet with Permit2 consent, up to each user's weekly cap per window (2× within 6 days and 1 second, A-L1; the app's Permit2 allowance has no amount limit), then take them the same way; re-pin a live asset to a pool and feed it controls (`AssetRegistry.setAsset` keeps it active) | move delivered stock, touch `claimable`, change a user's rule, cap, links or mix, block `exit` or `claim` |
| pauser | the same EOA | pause new accruals, parks and sweeps instantly. Because the pauser is the owner's own key, pausing does not protect against a compromised owner key | block `exit` or `claim`, unpause |
| attestor | the same EOA | issue / revoke screening clearances (screening is off) | anything else |
| keeper | hot key `0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03`, keeper service only | accrue into each user's own park amounts it attests (the contract cannot check them against the payments), up to each user's weekly cap per window and Permit2 allowance; `park`; `sweep` with buys bounded by the oracle (−1.5%) and each asset's band | withdraw, redirect a delivery, change a setting, block an exit |

If the keeper key is lost or compromised, the pauser pauses and the owner rotates it; the
incident playbooks are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Fixed findings

Every other finding of the 2026-10-02 audit is fixed; the [CHANGELOG](CHANGELOG.md) maps each
one to its change. A re-check of the remediated code found two more in spare-api, both fixed: B-N1
(Medium, an unbounded wallet replay) and B-N2 (`spare_activity` sending up to 121 log reads for
one call). It also closed three leads: the per-IP read budget now counts an IPv6 client by its
/64, the `$SPARE` holder snapshot reports `complete: false` when any read failed, and the
all-time fee ledger counts only blocks 3,000 deep. Before/after figures and the tests are in
[`docs/audits/2026-10-02-recheck-remediation.md`](docs/audits/2026-10-02-recheck-remediation.md).

## Accepted risks

Rated by the 2026-10-02 audit ([report](docs/audits/2026-10-02-ai-audit-grade.md)), or for
A-L3 by the re-check against it, and accepted while the conditions stated here
hold:

- **A-L1, rolling cap granularity (Low).** The weekly cap is a rolling window of 7 day
  buckets, so a keeper can pull up to 2× `weeklyCap` within 6 days and 1 second, never more.
  Only the keeper can trigger it and the USDG lands in the user's own park, where `exit`
  returns it. Pinned by `contracts/test/unit/WeeklyCapBuckets.t.sol`.
- **A-L2, SGOV churn (Low), accepted only while the SGOV park adapter stays on standby.**
  On the SGOV adapter a malicious keeper could park and sweep back each epoch for about 1.9%
  per epoch; on the live USDG adapter the same calls cost nothing
  (`contracts/test/unit/SgovChurn.t.sol`). SGOV is not enabled until a keeper `minOut` on
  unpark, a holding period, a user `minOut` on `exit` and a 25–50 bps band exist, and until
  the adapter's `valueOf` reads the SGOV feed inside a try/catch. Today
  `SgovParkAdapter.valueOf` calls `latestRoundData()` directly, and `SweepExecutor` reads
  `CashPark.valueOf` (and through it the adapter) for every account it sweeps, outside any
  try/catch: one reverting SGOV feed would revert every sweep. The deployed adapter is
  immutable, so all of this needs a new adapter.
- **A-M1, one account's size sets the netted fill (Medium in the audit; Low as mitigated,
  keeper-enforced).** `SweepExecutor.sweep` nets each asset across every account in the
  call and marks each account swept for the epoch before its legs run, so a large leg sets
  the price of every leg batched with it, and a leg past the band defers them all for the
  epoch (`contracts/test/unit/NettedWhale.t.sol`). The contract is immutable; the keeper,
  the only caller of `sweep`, routes around it. An account whose own leg would move its
  pool more than `SWEEP_MAX_IMPACT_BPS` (30) against a $1 quote is swept alone, in the last
  call of the tick; everyone else is packed so no call's netted swap of an asset passes
  30 bps. After an isolated call, every asset it bought is held for the accounts still due
  until that pool's $1 quote is back within `SWEEP_RECOVERY_BPS` (10) of its value before
  the call (rebased by any oracle move since), or until `SWEEP_RECOVERY_MAX_MS` (4 h) has
  passed. Residual: the isolation is keeper policy, not a contract rule, and the hold lives
  in the keeper's memory. After a keeper restart, or once a hold lapses, a later account
  can fill up to the pool fee + `QUOTE_ORACLE_ALLOWANCE_BPS` (60) + 30 bps under the oracle
  (the audit's case was about 113 bps), never past `QUOTE_MAX_SHORTFALL_BPS` (120) and the
  router's 150 bps band. Pinned by `NettedWhale.t.sol`
  (`test_AM1_whaleFirstLeavesItsImpactInThePoolForTheNextBatch` shows the impact a whale
  swept first leaves behind), `engine/test/keeper-batches.test.ts` ("NettedWhale regression
  (A-M1)", "recoveryHeld") and `engine/test/keeper/sweep.test.ts` ("whale isolation
  (A-M1)", "after an isolated call (A-M1 residual)"). Also residual: the keeper reads each
  account's mix (`ElectionRegistry.mixOf`) when it plans a tick, and the executor reads it
  again when the sweep lands. An account that changes its mix in between changes the netted
  amounts the keeper quoted: the legs batched with it then fill up to the 50 bps quote
  tolerance (`QUOTE_TOLERANCE_BPS`) worse, or that asset's leg defers for the epoch.
- **A-L3, a third party sets the fee on two live pools (Low, liveness only).** MU and GME
  swap through dynamic-fee pools whose Uniswap v4 hooks belong to Fables (FablesRWA
  `0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080` for MU, FablesRamp
  `0x08E52564Bad99E05a694b4809F397edcA417A080` for GME; both Sourcify-verified, not
  proxies). Both answer to one OpenZeppelin `AccessManager`,
  `0xA362D98B33A7bb5B5E2180a05f995A70FB404f30`, in which Spare holds no role. Read on-chain at
  block 78668723 (every role the manager maps to a function on the two hooks, with its
  members): its admin (one account, `0x359856655934338d798F9ccE1f181486301D36a5`, which also
  holds the roles that grant the fee pokers and the pauser) can reconfigure either pool's fee
  schedule; three fee pokers can push a fee for up to 72 h; a pauser
  (`0x5cda43da9631fb84d390d91e750f549b7ada721c`) can pause either hook or pool and clear a
  poke; and a calendar operator (`0xb9e8db60e88f8949ce0b91d451b269d0108c03d9`, also a poker)
  can change the MU hook's session hours, day overrides, DST mode and early closes, which
  drive MU's scheduled fee. Every role acts with no execution delay except the calendar
  operator's (1 h). A paused hook makes those legs revert and defer. A poked or scheduled fee stays under the pool's `maxFee`, today 5% for MU
  and 2% for GME (read on-chain at block 78513071); the admin can raise a pool's cap, but
  never above the hooks' `ABSOLUTE_MAX_FEE` of 5%. The hooks have only
  beforeInitialize and beforeSwap permissions, with no return-delta flags, so they set the
  fee or revert and never touch a swap's amounts. Every buy still has to clear the
  keeper's same-block quote less `QUOTE_TOLERANCE_BPS` (50) and the router's 150 bps band
  against Chainlink, so a fee raised between the keeper's quote and its sweep costs a buy at
  most that tolerance; past it the leg defers. The keeper reads the hook, not the pool:
  `currentFee` for its swap direction, the hook's code hash, its authority and the pool's
  `maxFee`, against pins in `engine/src/keeper/hooks.ts` (`HOOK_PINS`), and holds the asset
  when any of them is off its pin, unreadable, or the fee is above the pinned ceiling
  (0.40% for MU, 0.05% for GME). The same pins are in `contracts/config/4663.json`
  (`hookCodehash`, `hookAuthority`, `hookMaxFeePips`), and `AddAssets.s.sol` refuses and
  `VerifyDeployment` fails when a live hook differs from them, has a `*_RETURNS_DELTA`
  permission, or its ceiling is not inside the asset's band. The monitor
  (`engine/src/monitor`) alerts on every fee-setting event the two hooks emit for the pinned
  pools (critical when it makes the keeper hold the asset), on every role, delay, target
  and scheduled-operation change in their AccessManager (a new role member, or a change that
  reaches the pinned hooks, is critical), and re-checks each hook's authority and fee cap
  against the pin. So the operator can stop MU
  and GME buys, and delay the accounts holding them, but not take funds. If that happens the
  owner deactivates or re-pins the asset (48 h through the timelock after the hand-over;
  the keeper holds in the meantime).
- **Single-EOA owner, until the hand-over in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) is
  done.** Today one software key is owner, pauser and attestor, with no timelock. In one
  transaction and without notice it could take all parked USDG (`CashPark.setExecutor`,
  then `withdrawForSweep`); make itself keeper and pull made-up round-ups from every wallet
  with Permit2 consent, up to each user's weekly cap per window, then take those too; or
  re-pin a live asset to a pool and price feed it controls, so that sweeps buy through
  them. Pausing does not help against it, because the pauser is the same key. The hand-over
  moves ownership to a 2-of-3 Safe behind a 48 h timelock and the pauser to a separate Safe;
  until then, treat parked balances, and every linked wallet's USDG up to its weekly cap, as
  trusting that key.
- **Accrual amounts are keeper-attested and not bound to their start block (Low).**
  `accrue(account, wallet, amount, toBlock)` checks the link, the rule, that the range
  advances past the cursor, the finality buffer, the weekly cap and the Permit2 allowance,
  but it cannot check that `amount` is the round-ups of the payments in that range, and it
  works out the range's start itself. So a compromised keeper can pull up to each user's
  cap per window into that user's own park (`exit` returns it), and two keeper instances
  running at once could each pull for the same blocks (one with a later `toBlock`), within
  the cap. The guards are in the keeper only: one writer per deployment (the first tick waits
  `STARTUP_DELAY_MS`, 180 s, longer than a full scan tick; `SIGTERM` drains the tick in
  flight), no tick while a keeper transaction is pending, and each entry's window start
  re-read just before sending (`engine/src/keeper/keeper.ts`, "Single-writer hygiene").
  Anyone can recompute every accrual from the wallet's own USDG transfers (the Activity app
  and `npm run prove` do). A new deployment would add the expected start block to each
  accrual and revert on a mismatch.
- **Price protections that only the keeper enforces (Low unless the keeper is compromised or misconfigured).**
  On-chain, `OracleGuard` accepts a feed answer up to its heartbeat plus 1 h old (86,400 s
  + 3,600 s = 25 h for every asset), so a Friday close still reads OK on Saturday; no
  sequencer-uptime feed is set (RHC publishes none); it does not read the stock token's
  pending multiplier change (`effectiveAt` / `newUIMultiplier`); and every asset has the
  same 150 bps band, as the executor has 150 bps slippage. The checks that stop buys outside
  the US-equities session, around a pending split, against a pool quote too far under the
  oracle, and that isolate a whale are in the keeper (`engine/src/keeper/plan.ts`,
  `keeper.ts`), and `MARKET_HOURS_GATE=0` (a test override) turns the session check off. A
  compromised or misconfigured keeper could therefore buy against a price up to 25 h old,
  down to 1.5% under it (the pool's fee included), plus Spare's 0.25%. A new deployment
  would read the multiplier
  schedule on-chain, size each band to its pool fee and shorten the off-hours staleness.
- **One reverting oracle read reverts a whole sweep call (Low, liveness).**
  `SweepExecutor` calls `StockRouter.oracleStatus(asset)` for each asset outside any
  try/catch, and `OracleGuard` can revert (a token whose `paused()` returns a non-boolean
  word, or an absurd feed answer that overflows its scaling). A sweep call that includes such
  an asset reverts as a whole. The keeper reads `oracleStatus` for every asset before it
  plans and holds any asset whose read fails, together with the accounts whose mix includes
  it; funds stay parked and `exit` is unaffected. A new deployment would treat a revert there
  as a deferral.

## How the code is checked

- Contracts are immutable; a fix to them means a new deployment and a migration, so the
  first response to an on-chain issue is to pause accruals and sweeps (exits stay open).
- CI in `.github/workflows` runs, on every push and pull request, the
  Foundry suite (unit, the audit PoCs that need no fork, 10 invariants at 102,400 calls each,
  see [`docs/INVARIANTS.md`](docs/INVARIANTS.md); the nine fork-backed suites in
  `contracts/test/audit` skip without `AUDIT_FORK_BLOCK` and run only by hand) and the
  Halmos specs, the engine, keeper, spare-api and site tests, Slither (fails on High),
  Semgrep (fails on ERROR) and a
  full-history gitleaks scan (`.github/gitleaks.toml`). The same commands run locally;
  the [README](README.md#deploy--build-from-a-clone) lists them.
- Every GitHub Action is pinned to a commit SHA, every container image to a digest, and the
  engine's (the keeper's included) and spare-api's dependencies to exact versions.
  Dependency install scripts do not run (`ignore-scripts` for npm, `--ignore-scripts` on
  every `bun install`), a new package release must be 3 days old before npm or Bun installs
  it. npm older than 11.10 ignores that cooldown; `devEngines` makes it print an
  `EBADDEVENGINES` warning (it still runs, so a fresh clone can build and test), and
  dependencies are only added or bumped with npm 11.10 or newer.
  `node .github/scripts/check-pins.mjs` fails if any of that regresses (the `pins` job of
  the CI runs it), and `.github/dependabot.yml` proposes updates under the same
  3-day cooldown.
- No third-party human audit has been published yet. The AI-assisted audit above is a pre-audit
  signal, not a substitute for one.
