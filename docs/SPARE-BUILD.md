# SPARE — Build Spec (S1, public path)

The design reference for S1: the Spare contracts deployed on Robinhood Chain mainnet (4663)
on 2026-09-30 and the keeper that drives them. "Public path" means accounts whose balances
and holdings are public on-chain; a private path is S2. This document records the chain
facts the design relies on (verified on mainnet on 2026-09-29), the design laws and
decisions, and the interfaces, parameters and flows as they are in `contracts/src` and
`engine/src/keeper`. Anything that is not built is marked **Planned**.

The contracts' NatSpec refers to this document: "spec law N" is one of the design laws
below, which the site's whitepaper also publishes; "acceptance (N)" is one of the S1
acceptance tests in §6; "build spec §N" is a section here; "review HIGH" and "review fix"
refer to the pre-launch review in §7. The NatSpec is part of the Sourcify-verified source
and is not edited after deployment; the comments that describe launch-time state rather
than today's are listed in [`contracts/README.md`](../contracts/README.md#reading-the-natspec).

| Law | Rule | Enforced in |
|---|---|---|
| 1 | Round-ups come only from wallets the user explicitly links | `RuleRegistry` (a wallet links itself, or signs the link), `SweepExecutor.accrue` |
| 2 | Elections only from the eligible registry, fail-closed | `AssetRegistry`, `ElectionRegistry` |
| 3 | Every buy: allowlisted venue, slippage cap, Chainlink sanity with staleness and pause guards | `StockRouter`, `OracleGuard`, `SweepExecutor` |
| 4 | Idle spare waits in the park; a stale price (NAV) holds new accruals un-parked and never blocks a sweep | `CashPark.park`, `CashPark.withdrawForSweep`, the park adapters (§3.6) |
| 5 | Exit is never gated | `CashPark.exit`, `SweepExecutor.claim` (no pause check) |
| 6 | No APY or projection strings | the site's copy |

---

## 1. Verified chain facts

### Core infrastructure — live on mainnet AND testnet (46630)
| Contract | Address |
|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

### Tokens (mainnet)
| Token | Address | Decimals |
|---|---|---|
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **6** |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 18 |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | 18 |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 18 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 18 |
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | 18 |

These are the launch assets. The registry now holds 36 assets, 26 of them active; the
full list and every pin is in `contracts/config/4663.json`.

Stock tokens are **beacon proxies** (beacon `0xe10b6f6b275de231345c20d14ab812db62151b00`,
impl `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`) implementing **ERC-8056** (Scaled UI
Amount): `uiMultiplier()` (1e18 fixed-point), `newUIMultiplier()`, `effectiveAt()`,
plus `oraclePaused()`, `paused()`, ERC-2612 `permit`. `balanceOf`/`totalSupply` are
raw and never rebase. Issuer is Robinhood Assets (Jersey) Limited; the token itself
enforces its compliance rules on transfer.

### Chainlink feeds (mainnet) — all 8 decimals, 86400s heartbeat, 0.5% deviation
| Feed | Proxy | Hours |
|---|---|---|
| Robinhood SPY / USD | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | us_equities 24/5 |
| Robinhood QQQ / USD | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` | us_equities 24/5 |
| Robinhood NVDA / USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | us_equities 24/5 |
| Robinhood AAPL / USD | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | us_equities 24/5 |
| Robinhood TSLA / USD | `0x4A1166a659A55625345e9515b32adECea5547C38` | us_equities 24/5 |
| Robinhood SGOV / USD | `0xa0DF4ee0fFf975306345875E3548Fcc519577A11` | us_equities 24/5 |
| USDG / USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | crypto 24/7 |
| ETH / USD | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | crypto 24/7 |

- Stock feeds return the **per-token** price, already multiplier-adjusted. Never
  apply `uiMultiplier` to a feed price.
- Feeds update on 0.5% deviation or the 24h heartbeat, so an age of several hours
  is **normal**. Staleness is judged against the heartbeat, not minutes.
- Source of truth: `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`.
- **No L2 sequencer-uptime feed is published for RHC**, although the chain docs
  recommend checking one. `StockRouter.sequencerFeed` is `address(0)`, which skips the
  check; `setSequencerFeed` switches it on once a feed exists.

### Venue — Uniswap (from `@uniswap/sdk-core` CHAIN_TO_ADDRESSES_MAP[4663])
| Contract | Address |
|---|---|
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| v3 Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |

**None of these exist on testnet 46630**, and the stock tokens are not deployed
there either. The real swap path can therefore only be exercised on a
**mainnet fork** (anvil `--fork-url`), which is how S1 is tested.

Measured execution on 2026-09-29, $5 USDG in, best liquid v4 pool with fee ≤ 1%. This
table is the pre-deployment survey, not the current pins: SPY, NVDA and SGOV were later
pinned to hookless pools (NVDA's hooked pool filled ~3% worse through StockRouter, §7),
and every pin in use is in `contracts/config/4663.json`.

| Asset | Chainlink | Fill | vs oracle | Pool |
|---|---|---|---|---|
| SPY | 766.41 | 767.21 | +0.11% | hooked, fee 75 |
| NVDA | 228.18 | 228.28 | +0.05% | hooked, fee 0 |
| QQQ | 740.42 | 740.40 | −0.00% | plain, fee 3000 |
| AAPL | 330.26 | 330.98 | +0.22% | plain, fee 3000 |
| TSLA | 354.38 | 354.76 | +0.10% | plain, fee 3000 |
| SGOV | 101.19 | 101.10 | −0.09% | hooked, fee 0 |

On-chain AMM execution is viable at SPARE's sweep size. The chain docs describe
RFQ (0x / 1inch / LiFi) as the launch venue; RFQ is **not** required for S1.

~993 v4 pools touch these tokens; most are junk (fee tiers of 85–95%). Pools are
therefore **allowlisted by exact PoolKey, hook address included** — never
discovered at runtime. A hooked pool is arbitrary code, so the allowlist is what
makes law 3's "allowlisted venue" hold.

### Universe API
`GET https://api.robinhood.com/rhj/assets` — 195 assets, each with `deployments[]`
(chainId + contractAddress), `currentMultiplier`, `pendingMultiplier`, `status`,
`tradingCapabilities` per session (market / extended / overnight × whole /
fractional). Also `/prices/{symbol}` (raw bid/ask, NOT multiplier-adjusted) and
`/corporate-actions`. Nothing in production reads it: the registry is curated from
`contracts/config/4663.json` with `script/AddAssets.s.sol`. **Planned:** the
`universe-refresher` worker (§5) would compare it with the registry and propose changes.

---

## 2. Constraints that are not engineering problems

1. **Jurisdiction.** Stock tokens are not offered to US persons and are restricted
   in Canada, the UK, Switzerland and others. `ScreeningGate` can require an
   eligibility attestation before an account's spare is swept, but code cannot make
   a product compliant: the eligibility policy and its evidence are the operator's.
   On mainnet the gate is deployed with enforcement OFF, so no eligibility check runs
   on-chain (README, Status).
2. **Privacy (S2).** S2 was planned as an integration of existing privacy contracts: a
   shielded pool, a stealth-address registry, a solvency verifier and a screening gate.
   None of them is deployed on Robinhood Chain, so S2 would be a new ZK build, not an
   integration. `ScreeningGate` is Spare's own minimal implementation of the screening
   role, and it gates buying only. S1 does not depend on S2.
3. **Mainnet custody.** SweepExecutor pulls users' USDG and buys securities with it,
   and CashPark holds what waits in between. S1 was built and fork-tested end to end
   before the mainnet deployment (2026-09-30). An external human audit is strongly
   recommended before real deposits are accepted; none has been done yet.

---

## 3. Design decisions

### 3.1 Trust model for accrual
A contract cannot verify an arbitrary past transfer without storage proofs, so
public-path accrual is **keeper-attested, bounded on-chain and checkable by anyone**. The
interface on `SweepExecutor`:

```solidity
struct Accrual { address account; address wallet; uint256 amount; uint256 toBlock; }

function accrue(address account, address wallet, uint256 amount, uint256 toBlock) external;  // onlyKeeper, whenNotPaused
function accrueBatch(Accrual[] calldata batch) external returns (uint256 accrued);            // onlyKeeper, whenNotPaused
```

`accrueBatch` takes at most `MAX_BATCH` (64) entries and runs each through `accrueSelf`,
which only the contract itself can call, inside a try/catch: an entry that reverts emits
`AccrualSkipped(account, wallet, toBlock, reason)` and the rest of the batch goes ahead.
Each accrual:

- requires `wallet` to be linked to `account` (`RuleRegistry.isLinked`) and the
  account's rule to be enabled with a non-zero `weeklyCap`;
- covers the block range `(from, toBlock]`, where
  `from = max(lastAccruedBlock[wallet], linkedAt[wallet], activeSince[account])`. The
  cursor is **per wallet**. `toBlock` must be above `from` (`CursorNotAdvancing`) and
  the cursor moves to `toBlock`, so no wallet's range is accrued twice, nothing before
  the link is reached, and nothing from a window in which the rule was off;
- requires `toBlock + finalityBuffer <= head` (`NotFinal`), with `head` the L2 block
  number from the ArbSys precompile (`L2Clock`; on Nitro, Solidity's `block.number` is an
  L1 estimate, and `L2Clock` falls back to it only when the precompile call fails).
  `finalityBuffer` is a storage parameter, not a constant: 3,000 L2 blocks (about
  5 minutes) by default and on mainnet, changed by the owner with `setParams`, which
  sets no lower bound for it;
- for a non-zero `amount` (at most `type(uint160).max`), adds it to the account's bucket
  for the current UTC day (`dayPulled[account][block.timestamp / 1 days]`) and reverts
  with `WeeklyCapExceeded` if that day and the six before it would add up to more than
  `weeklyCap`. That window lets up to 2× the cap through within 6 days and 1 second
  (accepted risk A-L1 in `SECURITY.md`). It then pulls the USDG from the wallet with
  `Permit2.transferFrom`, which reverts if the wallet's allowance to the executor is
  short or expired, and credits it to the account's pending balance (`CashPark.credit`);
- emits `Accrued(account, wallet, amount, fromBlock, toBlock)`, for a zero amount too,
  which only advances the cursor.

What bounds a pull:

- The weekly cap is the account's. A wallet's EIP-712 link signature covers only
  `(account, wallet, nonce, deadline)`, so a wallet linked to another account is charged
  under that account's `roundTo`, `multiplier` and `weeklyCap`, which the account can
  change at any time.
- The Permit2 allowance is the wallet's own. The app asks for one with no amount limit,
  valid for a year, so in practice the cap is the bound.
- The amount is keeper-attested: the contract does not check it against the payments in
  the range, and does not bind it to the range's start block. A compromised keeper can
  therefore pull up to the cap per window, into the account's own park.
- Anyone can recompute `amount` from public chain data over the range (§3.2, §3.3), so
  every accrual can be audited after the fact; `npm run prove` does this on a fork.

Read views: `lastAccruedBlock(wallet)`, `pulledLast7Days(account)`,
`remainingWeeklyCap(account)`.

**Planned (S4):** fully trustless in-flow round-ups through an ERC-4337 hook.

### 3.2 What counts as a payment (S1)
An outgoing **USDG** `Transfer` from a linked wallet, **excluding** transfers to:

- the zero address (a burn or redemption, not spending);
- the account itself, or any wallet linked to the same account;
- any Spare contract in the address book;
- the Uniswap contracts in `engine/src/chain/constants.ts` (`VENUE`: v4 PoolManager,
  PositionManager, StateView and Quoter, v3 Factory, SwapRouter02) and the Universal
  Router (`KEEPER_EXTRA_VENUE` in `engine/src/keeper/venue.ts`): a swap is not a payment;
- a canonical Uniswap v3 pool, recognised by the keeper when the v3 factory's
  `getPool(token0, token1, fee)` returns that address.

Each payment is priced with the rule in force at its block (the account's `RuleSet`
history). When the classification is uncertain, the keeper excludes: a false negative
costs a round-up, a false positive takes money the user did not mean to give. Code:
`engine/src/lib/payments.ts`, `engine/src/keeper/venue.ts`. ETH and other tokens are out
of scope for S1.

### 3.3 Round-up math
`delta = (step − amount mod step) × multiplier` with `step = roundTo × 1e6`, and **0 when
the amount is already on a boundary** (and for a zero amount). Money is integer USDG base
units (6 dp) throughout, so there is no rounding step. `roundTo` ∈ {1, 5, 10} USD and
`multiplier` ∈ {1..5}, enforced by `RuleRegistry.setRule`.
Acceptance (1): $3.75 → $0.25 at 1×, $0.75 at 3×.

The same function exists in four places, all in base units, and they must agree:

| Copy | Used by | Checked by |
|---|---|---|
| `contracts/src/libraries/RoundUp.sol` | the reference; no deployed contract calls it (the executor takes the keeper's amount, §3.1) | `contracts/test/unit/RoundUp.t.sol`, the Halmos specs, `npm run prove` (runs it on the fork for every payment) |
| `engine/src/lib/roundup.ts` | the keeper | `engine/test/roundup.test.ts`, including exact parity with the site's copy |
| `server/src/spare/roundup.ts` | spare-api (`spare_roundup_preview` and the account reads) | `server/src/spare/roundup.test.ts` |
| `src/lib/spare.ts` | the site | `src/lib/spare.test.ts` |

### 3.4 Defer versus safe-settle
For each asset in a sweep (§3.7) there are three outcomes:

- **Swapped**: the netted USDG, less the fee, is swapped through the asset's pinned pool
  and the tokens are delivered (`AssetSwept`; `Delivered` or `DeliveryHeld` per account).
- **Deferred**: each contributing account's USDG goes back to its pending balance in
  `CashPark` (`returnFromSweep`, `Deferred(account, asset, usdg, status)`). This happens
  when:
  - `StockRouter.oracleStatus(asset)` is not `OK`: the feed is older than its heartbeat
    plus 1 h (`STALE`, the weekend case for 24/5 feeds), the token reports `paused()` or
    `oraclePaused()` (`PAUSED`), a configured sequencer feed reports down or restarted
    less than 1 h ago (`SEQUENCER_DOWN`), or the answer is non-positive, future-dated or
    unreadable (`BAD_ANSWER`);
  - the keeper sent no limit for the asset (`SwapDeferred(asset, usdg, "no keeper limit")`);
  - the swap reverted for any reason: fewer tokens than `minOut` (`BelowMinOut`), a fill
    below the oracle band (`OutsideOracleBand`), a partial fill (`PartialFill`), or a pool
    or hook failure. `SwapDeferred` carries the revert data.
- **Safe-settled**: only when the owner has deactivated the asset in `AssetRegistry`.
  Each contributing account receives its USDG as USDG
  (`SafeSettled(account, asset, usdg, "asset suspended")`). Acceptance (6).

`minOut` is the larger of the keeper's limit (`swapIn × minOutPerUsdg / 1e6`) and the
oracle amount for `swapIn` less `slippageBps` (150 on mainnet); `StockRouter.buy` then also
rejects a fill below the oracle amount for what was paid less the asset's `bandBps` (§3.5).
`oracleStatus` is read outside the try/catch, so if it reverts the whole sweep call
reverts (an accepted risk in `SECURITY.md`).

`SweepExecutor` marks an account swept for the epoch before its legs run, so a deferred
leg's epoch is spent: its USDG is retried at the account's next epoch (the next UTC day on
mainnet). A defer never turns a user's stock buy into USDG. The keeper avoids spending
epochs by waiting while an oracle is not OK or the US-equities session is closed, and by
holding an asset whose quote is too far under the oracle (§8).

### 3.5 Oracle sanity band
Feeds lag the market by up to their 0.5% deviation threshold, and pool fees are up to 1%,
so the fill-versus-oracle band is **1.5%** (`bandBps` 150) for every asset on mainnet. It
is set per asset in `AssetRegistry` (at most `MAX_BAND_BPS`, 1000). The keeper's quote
limit and the executor's `slippageBps` floor (§3.4) are separate checks. `OracleGuard`
scales the feed answer to 1e18 and treats it as stale past the asset's heartbeat (86,400 s
for every asset on mainnet) plus `STALENESS_GRACE` (1 h).

### 3.6 Parking
`CashPark` keeps two balances per account: `pending` (accrued USDG held as USDG) and
`units` (parked in the current adapter). Accruals always land in `pending`. The adapter
interface, `IParkAdapter`, is `underlying()`, `deposit(usdg)`, `redeem(units, to)`,
`exitInKind(units, to)`, `valueOf(units)` and `isFresh()`.

- `UsdgParkAdapter`: identity (1 unit = 1 USDG base unit), no yield, always fresh.
  **The live adapter.**
- `SgovParkAdapter`: parks in SGOV, the iShares 0–3 Month Treasury ETF, through
  `StockRouter`, valued at the SGOV Chainlink feed and fresh only while that feed is OK.
  Deployed and authorised as a router caller, but on standby. It is not enabled until the
  preconditions of accepted risk A-L2 in `SECURITY.md` are met, which needs a new adapter.
- syrupUSDG exists on RHC but is **Maple private credit, not treasuries**; it is
  not offered as the treasury option because labelling it "treasury yield" would be false.

Law 4 in the contracts: `park(accounts)` (keeper only) moves the listed accounts'
`pending` into the adapter in one deposit and splits the units pro rata, and does nothing
while the adapter is not fresh. `withdrawForSweep` hands over all pending USDG and redeems
the account's units at market through the adapter; units that cannot be redeemed right
now stay parked, so a stale NAV never blocks the sweep of pending USDG. `exit()` pays
pending USDG first, then redeems units, falls back to handing over the underlying in kind,
and if that fails too keeps the units booked to the account (`ExitUnitsKept`). The owner
can change the adapter only while no units are parked (`setAdapter`, `AdapterInUse`).

As deployed, the keeper does not call `park`. On the USDG adapter parking would change
nothing, so accrued USDG stays in `CashPark.pending` until it is swept or exited.
**Planned:** batched `park` calls (the `park-scheduler` worker, §5) once a yield adapter
is live.

### 3.7 Sweep
```solidity
struct Limit { address asset; uint256 minOutPerUsdg; }  // min asset tokens (18 dp) per 1 USDG (1e6)

function sweep(address[] calldata accounts, Limit[] calldata limits) external returns (uint256 sweptCount);
// onlyKeeper, whenNotPaused; at most MAX_BATCH (64) accounts
```

- **Keeper-only.** Per asset, the keeper passes a minimum fill taken from a same-block
  V4Quoter quote of the exact netted swap (§8). The first draft let anyone call `sweep`;
  that allowed an atomic sandwich, so it was made keeper-only before deployment (§7).
- **Per account**, the executor skips the account (its epoch is not spent) when it was
  already swept this epoch, `CashPark.valueOf(account)` is under `threshold`,
  `ScreeningGate.isEligible(account)` is false, or its mix is empty. Otherwise it takes
  the account's USDG with `withdrawForSweep`; if what came out is under `threshold`
  (units that could not be redeemed stayed parked), it puts it back and skips the account.
  Else it records `sweptEpoch[account]`, emits `AccountSwept`, and splits the USDG across
  the account's mix by bps (each leg floored, the last leg takes the remainder).
- **Threshold**: one global `threshold`, 5_000_000 (5 USDG) by default and on mainnet,
  owner-set through `setParams` (at least 1_000_000).
- **Netted**: each asset's USDG is summed across all accounts in the call and swapped
  once; the output is split pro rata to what each account contributed (each share
  floored, the dust to the last contributor). Cheaper and lower-slippage than
  per-account swaps, at the cost of accepted risk A-M1 (`SECURITY.md`).
- **Once per epoch**: `epoch = block.timestamp / epochLength + 1` (`currentEpoch()`), with
  `epochLength` 86,400 s on mainnet (owner-set, at least 1 h). An account is swept at most
  once per epoch.
- **Fee**: `feeBps` (25 = 0.25% on mainnet; at most `MAX_FEE_BPS`, 100) of each converted
  asset's netted USDG goes to `FeeVault` before the swap. Deferred and safe-settled legs
  pay no fee. The pool's own swap fee comes on top. No subscription.
- **Delivery**: tokens go to the account address itself. If the token refuses the
  transfer (for example a blocklisted recipient), the amount is booked in
  `claimable[account][token]` (`DeliveryHeld`) so it cannot revert anyone else's sweep,
  and the account collects it with `claim(token)`, which pays `msg.sender` only and
  ignores pause. There is no separate delivery address.

### 3.8 Elections
`ElectionRegistry.setMix(Leg[]{asset, bps})`: 1 to 6 legs (`MAX_LEGS`), every leg's bps
non-zero and the total exactly 10000, no duplicates, every asset active in `AssetRegistry`.
Fail-closed: an invalid mix reverts; there is no partial acceptance. `clearMix()` drops
back to the default mix, which the owner sets with `setDefaultMix` under the same
validation; `mixOf(account)` returns the account's own mix or the default. The default on
mainnet is 60/40 SPY/NVDA (acceptance (2)). An asset deactivated after it was elected is
not dropped from the mix: the executor safe-settles that leg (§3.4).

### 3.9 Units
- USDG amounts: `uint256`, 6 decimals.
- Stock amounts: `uint256`, 18 decimals, raw (never multiplier-scaled on-chain).
- Prices: 8 decimals from Chainlink, normalised internally to 1e18.
- bps: 10000 = 100%.

---

## 4. Contracts (Foundry, `contracts/`)

solc 0.8.26, evm cancun, via-IR, optimizer 200.
Libraries: forge-std, v4-core and v4-periphery as pinned git submodules in `contracts/lib`; permit2 and OpenZeppelin come from their nested submodules (remappings in `contracts/foundry.toml`).

| Contract | Role |
|---|---|
| `AssetRegistry` | Eligible universe: token → {feed, feedDecimals, heartbeat, bandBps, active, poolKey}. Owner-curated, fail-closed. A new asset starts inactive; `setActive` is a separate step. The pool must pair USDG with the token. |
| `RuleRegistry` | Per account: the rule {roundTo, multiplier, weeklyCap (0 = off), enabled} and `activeSince`; up to 8 linked wallets (`linkSelf`, or `linkWallet` with the wallet's EIP-712 signature, EOA or ERC-1271), each with `linkedAt` and a nonce. `unlink` by the account or the wallet. No owner. |
| `ElectionRegistry` | Per-account mix and the owner's default mix, validated against `AssetRegistry`. |
| `ScreeningGate` | Attestor clearances with an expiry, set directly or submitted with the attestor's signature; `enforced` (false on mainnet) decides whether `isEligible` checks them. Gates buying only. |
| `OracleGuard` (lib) | Staleness, token `paused` / `oraclePaused`, optional sequencer feed, answer sanity. Returns a status. |
| `StockRouter` | Swaps USDG → asset (and back, for park adapters) through the allowlisted v4 PoolKey via the PoolManager unlock callback, exact input only; enforces `minOut` and the oracle band. Only allowlisted callers (`isCaller`: SweepExecutor, SgovParkAdapter). |
| `CashPark` | Per-account `pending` USDG and `units` in an `IParkAdapter`; credit, withdraw and return for the executor only, `park` for the keeper, `exit` for the account. |
| `SweepExecutor` | `accrue` / `accrueBatch` (§3.1), `sweep` (§3.7), `claim`, and the parameters `finalityBuffer`, `threshold`, `feeBps`, `slippageBps`, `epochLength` (`setParams`). |
| `FeeVault` | Holds conversion fees; the owner withdraws. |
| `UsdgParkAdapter`, `SgovParkAdapter` | The park adapters (§3.6); they answer to `CashPark` only. |
| `RoundUp`, `L2Clock` (libs) | The round-up reference (§3.3) and the L2 block number from ArbSys. |

Access: OpenZeppelin-style `Ownable2Step` owner on 7 contracts (planned as a multisig; on
mainnet it is still a single EOA, see `GOVERNANCE.md`),
a separate `keeper` role for accrue, park and sweep, and a `pauser` that can halt
new accruals, parks and sweeps (the owner can pause too; only the owner unpauses).
**Nothing can halt a user's exit**: parked value is
always redeemable to USDG by its owner (law 5, "exit never gated"). Every privileged
function and its holder today: [`ROLES.md`](ROLES.md).

## 5. Engine (Bun, `engine/`)

What runs in production from `engine/`: the keeper (§8, `src/keeper`) and the read-only
on-chain monitor (`src/monitor`). Next to them, spare-api (`server/`) serves `/health`,
the MCP and its REST mirrors, and the site reads the chain directly. The table of what is
deployed is in [`engine/README.md`](../engine/README.md).

Not deployed, and kept as the base for the next release: an HTTP API on Bun + Hono +
tRPC v11 + viem, with routers `link`, `rule` (with `preview`), `mix`, `accrual`, `sweep`,
`park`, `oracle`, `universe` and `health`; a Drizzle schema for Postgres/TimescaleDB
(`src/db/schema.ts`); and a BullMQ (Redis) worker scaffold. **Planned** workers:
`chain-indexer`, `roundup-observer`, `accrual-ledger`, `park-scheduler`, `sweeper`,
`nav-watcher` and `universe-refresher`. None is implemented (`src/workers/registry.ts` is
empty); the keeper does the accrual and sweep work statelessly from chain reads. Nothing in
the engine's runtime writes the event and payment tables: only the opt-in fork test
(`test/routers.fork.test.ts`) fills them, and unit tests run the cursor code against an
in-memory PGlite.

## 6. Acceptance tests in scope for S1

1. $3.75 payment → $0.25 accrual at 1×, $0.75 at 3×.
2. Accrued ≥ $5 → sweep buys 60/40 SPY/NVDA at reference, delivered.
3. Idle spare shows parked value with published NAV (SGOV adapter, which is on standby
   in production).
6. Suspended asset in mix → USDG with notice.
7. The weekly cap is never exceeded within the contract's window (today and the six UTC
   days before it; A-L1).

Plus: double-sweep impossible within an epoch; stale feed defers (does not
safe-settle); unlink stops accrual immediately; exit always open.

Each has a fork test in `contracts/test/fork/SpareFork.t.sol`
(`test_acceptance1_roundUpMath` to `test_acceptance7_weeklyCapNeverExceeded`); (1), (2),
(6) and (7) also have unit-level versions in `contracts/test/unit`.

**Planned**, not in S1: (4) private account (S2) and (5) sponsor match (S3).

## 7. Security review fixes (2026-09-30)

The project's own pre-launch review, in three separate passes, reproduced these on a mainnet fork; all are fixed in `contracts/src` and covered by regression tests. The NatSpec's "review HIGH" is the first row.

| Finding | Fix |
|---|---|
| HIGH — permissionless `sweep` could be sandwiched atomically (oracle band was the only bound, ~92 bps extractable) | `sweep(accounts, limits)` is keeper-only. The keeper passes, per asset, min tokens per 1 USDG from a same-block V4Quoter quote of the exact netted swap, less 50 bps. The router's oracle band stays as a backstop. |
| MEDIUM — any swap revert safe-settled to USDG and consumed the epoch (forceable via pool push, batch inclusion, or a third-party hook pause) | Every swap revert and every non-OK oracle status DEFERS (USDG back to the park). USDG payout happens only when the owner deactivates the asset. |
| MEDIUM — executor slippage tighter than the band | Default `slippageBps` = 150 = band; the keeper quote is the primary bound. |
| MEDIUM — `CashPark.exit` all-or-nothing (SGOV pause trapped pending USDG) | Pending USDG is paid first; units try redeem → in-kind → stay booked (`ExitUnitsKept`). |
| MEDIUM — calendar-week cap (2× cap across a Thursday boundary) | A window of 7 UTC-day buckets (`dayPulled`, `pulledLast7Days`); the remaining 2× within 6 days and 1 second is accepted risk A-L1. |
| MEDIUM — disabled-rule window accrued after re-enable | `RuleRegistry.activeSince`; accrual starts at max(cursor, linkedAt, activeSince). A zero cap counts as disabled. |
| MEDIUM — `ScreeningGate.revoke` left signed clearances replayable | Revoke bumps the nonce. |
| LOW — link signatures survived unlink | `_link` and `unlink` bump the wallet nonce; `invalidateNonce()` added. |
| LOW — `claim(token, to)` let a blocklisted account redirect | `claim(token)` pays `msg.sender` only. |
| LOW — one bad entry reverted `accrueBatch` | Per-entry try/catch via `accrueSelf`, `AccrualSkipped` event. |
| LOW — sequencer feed `startedAt == 0` / future | Treated as down. |

Venue changes found while testing: the hooked NVDA pool (hook `0xA0D185c9…`) quoted like a normal pool but filled ~3% worse through StockRouter on a fork, so NVDA is pinned to the **hookless fee-100 pool** (−0.05% vs Chainlink at $100). SGOV had only a hooked pool, so it launched **registered but inactive**. (Since then `AddAssets.s.sol` has grown the universe to 36 assets, 26 active, SGOV among them on a hookless pool; the pins in use are in `contracts/config/4663.json`.)

Accepted / documented: owner is an EOA at launch (the hand-over to a 2-of-3 Safe behind a 48 h timelock is `GOVERNANCE.md`, rehearsed on a fork and not yet carried out); adapter migration requires a flat park (`setAdapter` blocks while units exist); rotating the executor resets per-wallet cursors (redeploy the executor only with the keeper paused and cursors re-seeded).

## 8. Keeper (`engine/src/keeper`)

Stateless: every cursor is on-chain. `bun run keeper` (deployed from `engine/Dockerfile.keeper`). It sends two kinds of transaction, `accrueBatch` and `sweep` (each accrual entry is first simulated alone with `accrue`); it never calls `CashPark.park` (§3.6).

- **accrue** (every 60 s, `ACCRUE_EVERY_MS`): discover accounts from `Linked` events → per wallet, window = (max(lastAccruedBlock, linkedAt, activeSince), head − `finalityBuffer` (read from the executor) − `FINALITY_MARGIN` (20)] → outgoing USDG transfers minus exclusions (§3.2) → round-up with the rule in force at each payment (§3.3) → clamp to the remaining weekly cap, the Permit2 allowance, the USDG allowance to Permit2 and the balance → simulate each entry alone → `accrueBatch` calls of up to 64 entries each. A window that holds round-ups the keeper cannot pull yet (no consent, balance or cap room) waits and is never advanced past them; a window with no round-ups is closed with a 0-amount accrual once it is `IDLE_ADVANCE_BLOCKS` (500,000) wide.
- **sweep** (every 10 min, `SWEEP_EVERY_MS`): accounts over the threshold, not swept this epoch, screening-eligible, whose whole mix is oracle-OK → net per asset exactly as the executor does → V4Quoter quote → `sweep(accounts, limits)`. An asset whose pool quotes $1 more than its fee + `QUOTE_ORACLE_ALLOWANCE_BPS` under the oracle is held this tick, with every account holding it (all-or-nothing: their epochs are kept); when a tick's budget (`SWEEP_MAX_ASSETS`, `SWEEP_MAX_LEGS`, 64 accounts) cannot take everyone, those pools are screened first so held accounts never take the slots of sweepable ones.
- Env: `KEEPER_PK`, `ADDRESSES_JSON`, `RPC_URL`, `CHAIN_ID=4663`, `KEEPER_BROADCAST=1`, `PORT` (serves `/health`). Optional, with defaults: `HOST` (`::`, dual-stack, so an IPv6 private network reaches `/health`), `SWEEP_MAX_IMPACT_BPS` (30), `QUOTE_ORACLE_ALLOWANCE_BPS` (60: a pool's $1 quote may sit at most its fee + 60 bps under the oracle; the equity feeds post only on a 50 bps move or every 24 h, so a pool that tracks the market drifts up to ~50 bps from a feed that has not posted yet), `QUOTE_MAX_SHORTFALL_BPS` (120; caps every full-size quote; an isolated account is swept alone while its own quote stays within this of the oracle), `SWEEP_MAX_CALLS` (4), `SCAN_WALLET_MAX_CALLS` (64), `SCAN_WALLET_MAX_LOGS` (5000), `SCAN_WALLET_DEADLINE_MS` (45000), `SCAN_TICK_DEADLINE_MS` (120000), `STARTUP_DELAY_MS` (180000: the first tick waits longer than a full scan tick, so an overlapping deployment does not accrue the same window), `SWEEP_RECOVERY_BPS` (10) and `SWEEP_RECOVERY_MAX_MS` (4 h: after an isolated call, the assets it bought wait until their pool's $1 quote is back within 10 bps of its value before the call, A-M1), `HOOK_PINS` (the hooked pools' code hash, authority, fee cap and fee ceiling; built in for MU and GME in `src/keeper/hooks.ts`, equal to `contracts/config/4663.json`, which a test checks), `MARKET_HOURS_GATE` (`1`; `0` is a test override that lets equity legs trade outside the 24/5 session), `HEALTH_TOKEN` (32+ chars; without `Authorization: Bearer <HEALTH_TOKEN>`, `/health` answers only `{ ok }`). Every setting is in `src/keeper/config.ts`.
- Gas: every `accrueBatch` and `sweep` goes out at 1.5x its `eth_estimateGas` (an `accrueBatch` never under a per-entry floor), never the bare estimate. The executor try/catches each accrual and each swap, so a limit that is barely short does not revert: the tx succeeds with the entry skipped (`AccrualSkipped`, empty reason) or the swap deferred (`SwapDeferred`, empty reason, epoch spent), and `eth_estimateGas` can land exactly there (on a mainnet fork, a new wallet's first pull alone in a batch estimated 271,957 gas, inside a 4,008-gas window below the 275,965 it needs: the tx succeeded and skipped it). An empty-reason skip or deferral, or a tx that reverts having used its whole limit, is logged `OUT OF GAS` and raises the multiple to 2x, then 3x (`/health` `gasMultiplier`); the skipped wallets are retried next tick without backoff.
- Fork E2E: `scripts/dev-fork.sh` then `bun run engine/scripts/keeper-e2e.ts` (link → rule → consent → real payments → accrue → quote-limited sweep → exit). `npm run prove` at the repository root replays the same path against the DEPLOYED contracts on a fresh fork of mainnet (`engine/scripts/prove.ts`).
- Tests: `bun test`; the live-fork router suite (`test/routers.fork.test.ts`) runs only with `SPARE_FORK=1`, anvil and `contracts/out` built (`forge build`).
