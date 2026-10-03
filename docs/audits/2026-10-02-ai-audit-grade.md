# Audit Grade — Spare (AI-assisted audit, 2026-10-02)

> Markdown rendering of an AI-assisted audit report, delivered as a PDF on 2026-10-02,
> before the public release. It describes the pre-release repository, whose history is
> not public. Findings, severities, numbers and scores are the report's, unchanged, and
> the layout was converted (the PDF's tables are Markdown tables here). In this public
> copy a few details are replaced by neutral wording in [brackets]: the private
> repository's name and commit, remarks about the auditor's own working environment, the
> names of the previous codebase's products that the legacy routes under B belonged to,
> and the name of the AI service those routes called. What was changed in response is in
> [`CHANGELOG.md`](../../CHANGELOG.md); the spare-api routes it names under B were
> removed from the service in that work.

**Grade: 5.2 / 10** · Rubric v2 · Mode full · 2026-10-02 · [pre-release repository]

**Scope:** `contracts/` (10 live contracts), `engine/` (API and the keeper hot key), `server/`
(spare-api, MCP, AI and data routes), deploy, CI, dependencies.

**Out of scope:** the frontend (`src/`, pages, Spline, i18n) and [the identity of the people behind the project].

**Live deployment (chain 4663):** not checked. The RPC and Blockscout returned 403 from
[the auditor's environment].

## Summary

The contracts are solid:

- No Critical or High. No outside attacker can steal funds.
- Exit always open. It is never gated by pause (P1 passes), even with SGOV or a stock
  token paused.
- Immutable. No proxies.
- Swaps: pools are pinned by exact PoolKey, swaps are exact-input fills, and every buy is
  checked by a keeper quote plus an oracle floor.
- `uiMultiplier` handled correctly: never double-applied, and decimals scale correctly.
- Tests: 266 Foundry tests pass, and contract line coverage is 92.2%.
- Invariants: all 10 on CashPark and SweepExecutor held at 102,400 calls in this run.
- Prior review: the team's own review (SPARE-BUILD §7) already fixed the sandwich,
  epoch-burn and exit-trap bugs.

What holds the grade down:

1. Legacy [previous-codebase] AI and chain-intel routes are still mounted on spare-api. They
   leak the RPC key in errors, let anyone burn [AI service] credit, and grow memory and disk
   without bound.
2. The engine can be griefed. A public preview route can burn the RPC quota or crash it.
3. The owner is one EOA with no timelock. It can take every parked USDG in one
   transaction. That is charged under D, the governance score, not counted as a finding.
4. The keeper (944 lines holding the hot key) has no unit tests.
5. Deploy and verify scripts don't compile from a clone. `contracts/.gitignore` has
   `lib/`, which also drops `script/lib/SpareConfig.sol` and `SpareBase.sol`.
6. No CI, no LICENSE, no SECURITY.md, no monitoring.

Nothing on the path to 9.5 needs a contract redeploy.

## Findings

### A — Contracts

| # | Sev | Finding | Where |
|---|---|---|---|
| A-M1 | Med | One large account blocks or worsens everyone else's leg in a sweep. Legs are summed into one all-or-nothing swap per asset, and `sweptEpoch` is set before any leg runs. The keeper quotes the summed swap, so its limit already includes the whale's price impact. Mallory sets a 100% NVDA mix with a $5k balance. Every co-batched user's NVDA leg then either defers each epoch (Alice: 0 NVDA over 7 epochs, so under the default mix her balance drifts into SPY) or fills about 113 bps worse. Mallory loses nothing. PoC `auditR2/NettedWhale.t.sol` (2/2 pass). | `SweepExecutor.sol:285-290, 316, 359-390`; `engine/src/keeper/keeper.ts:882-1027`; `plan.ts:56` |
| A-L1 | Low | The "rolling 7-day" cap is really 7 day-buckets. That allows 2× `weeklyCap` within 6 days and 1 second. Only the keeper can trigger it, and the funds land in the user's own park. PoC passes. | `SweepExecutor.sol:237-240, 454-459` |
| A-L2 | Low | SGOV churn by a malicious keeper (adapter on standby). The keeper can run `park` then `sweep` with no limit. All units are redeemed and the leg defers back to USDG, costing about 1.9% per epoch inside every bound. PoC: $1,000 → $826 over 10 epochs. Fix this before enabling SGOV. | `CashPark.sol:98-158`; `SgovParkAdapter.sol:58-68`; `SweepExecutor.sol:353-375` |

### B — Off-chain (engine and server)

| # | Sev | Finding | Where |
|---|---|---|---|
| B-M1 | Med | Raw errors reach clients, including the RPC URL and its Alchemy key. `shortError` returns the full viem message, which contains `URL: …/v2/<key>`, and so does MCP `tools/call`. Flooding the routes in B-M4 forces an RPC error. `NODE_ENV` defaults to development, so stack traces also leak, and the AI fallback echoes upstream errors. PoC prints the key from 3 endpoints. It becomes a real key leak if production uses a keyed URL, which `env.example` suggests. | `server/src/services/chainIntel.ts:126-128` (used ~12×); `mcp/dispatch.ts:36-40`; `index.ts:64`; `env.ts:21`; `spareAi.ts:411, 504` |
| B-M2 | Med | [AI service] spend can be drained. `/api/chain/*/explain` and `/trade-desk` skip `aiAllowed` and only have a per-IP limit. `/api/ai/*` has no limit and is open while `TEST_MODE=true`. After launch, holder tier trusts any wallet address passed in, with no signature. PoC: 30 swarm requests made 150 model calls. | `routes/chainIntel.ts:32-54, 138, 156`; `routes/ai.ts:31-39` |
| B-M3 | Med | Public `rule.preview` amplifies RPC calls and can crash the engine. There is no tRPC `maxBatchSize` (about 50 previews per GET), and getLogs halving isn't counted toward `maxChunks`. One request made 12,200 getLogs calls; one 2-day preview held 864k logs (+403 MB). | `engine/src/routers/rule.ts:99-172`; `chain/logs.ts:371-376, 420-425`; `app.ts:32-45` |
| B-M4 | Med | Unauthenticated chain lenses: 129 RPC calls per request, cache bypass through the lookback parameters, one memory file written per address, and Maps that are never pruned. PoC: 5 requests made 1,240 calls; 300 requests created 301 files. | `routes/chainIntel.ts:81-116`; `services/chainIntel.ts:320-376, 649, 794`; `chainMemory.ts:163-169` |
| B-M5 | Med | Unbounded `memo` cache in `/api/ai/dashboard/:symbol` and `/klines`. Each unique symbol triggers 7 paid upstream fetches and is held forever, so the server eventually runs out of memory. PoC: 2,000 symbols caused 14,000 fetches and +32.6 MiB. | `services/marketData.ts:42-49`; `routes/ai.ts:75-86, 185-204` |
| B-L1 | Low | Rug Radar trusts the symbol. A scam token with `symbol()="NVDA"` is rated OFFICIAL with score 100. Low only because nothing in the product calls this route yet. | `services/rugRadar.ts:257-265`; `portfolio.ts:74, 128` |
| B-L2 | Low | One linked wallet can stall the keeper. It spams 1-unit transfers to thousands of addresses, and `scanWallet` has no per-wallet budget or deadline, so accruals and sweeps are delayed. Shown by a code trace. | `keeper.ts:519-552, 699-707`; `venue.ts:55-90` |
| B-L3 | Low | The keeper uses the spot-pool quote as the sweep limit with no check against the oracle, so the only pool-independent bound is about −1.5%. | `keeper.ts:882-913`; `plan.ts:56-59` |
| B-L4 | Low | The engine rate limiter trusts the left-most `X-Forwarded-For`, so it can be bypassed by rotating the header (PoC). | `engine/src/middleware/rateLimit.ts:31-44` |
| B-L5 | Low | Replay budget: `wallet=` costs 1 unit instead of 10 (`??` vs `pick()`). PoC: 50/50 requests allowed, 765 RPC calls. | `server/src/spare/budget.ts:35`; `tools.ts:104` |
| B-L6 | Low | The Alchemy webhook is broken: `express.json()` runs first, so a correctly signed delivery returns 500. It also fails open outside production, and `/alchemy/recent` is public. | `index.ts:69`; `routes/alchemyWebhook.ts:57-70, 103` |
| B-L7 | Low | On-chain token names go straight into LLM prompts (prompt injection into verdict text; no tools are attached). | `rugRadar.ts:345`; `tradeDesk.ts:294, 562-605`; `portfolio.ts:192-236` |
| B-L8 | Low | `/api/chain/memory/*` reveals which wallets were looked up, and when. | `routes/chainIntel.ts:118` |

### Leads (no deduction)

- **Off-hours staleness:** heartbeat plus grace is 25 h, so a Friday-close price is still "OK"
  on Saturday. Market-hours gating is off-chain only.
- **Splits:** `OracleGuard` ignores `effectiveAt` / `newUIMultiplier`. Defer while
  `now ≥ effectiveAt` and the feed's `updatedAt < effectiveAt`.
- **SGOV adapter (standby):**
  - `SgovParkAdapter.valueOf` has no try/catch, so one reverting feed blocks every sweep.
  - `exit()` has no user minOut and no in-kind option.
  - The SGOV band of 150 bps is too wide for a T-bill ETF.
- **Setter checks:** `setAsset` doesn't check that the token has 18 decimals. `setParams`
  accepts `finalityBuffer = 0`, and the heartbeat has no upper bound.
- **Accrual amount isn't tied to its start block.** Add `expectedFrom` to `Accrual`.
- **Keeper key on the API:** `KEEPER_PK` may sit on the internet-facing API just to show the
  address; use `KEEPER_ADDRESS`. The keeper `/health` is public.
- **Docker images:**
  - `oven/bun:1.3-slim` isn't pinned by digest and runs as root.
  - Compose uses `redis:7-alpine`, which fails the CVE-2025-49844 version gate, and
    `timescaledb:latest`. Both are local only (127.0.0.1).
- **Stale doc:** `SPARE-BUILD.md:180` says sweep is permissionless; it is keeper-only.
- `qs` 6.15.2 is reachable through express (Moderate). The `form-data` / `ws` Highs aren't
  reachable.

## Governance (D deductions, not findings)

These are owner-only powers, so under the judging gates they are scored in D, not as
findings. They are still the biggest real-world risk.

- **The owner can take all parked USDG instantly.** The owner is one EOA, which is also
  the pauser and attestor. There is no timelock, so it can call
  `CashPark.setExecutor(self)` and then `withdrawForSweep` on every account. PoC
  `test_R1_ownerPullsFreshCapAndDrains` passes.
- **Other owner powers:**
  - `setKeeper(self)`, then accrue fabricated round-ups up to each wallet's cap;
  - `setAsset` to point a live asset at its own pool and feed;
  - raise fee, slippage and band to their maximums (1%, 5%, 10%).
- **What the owner can't touch:** `claimable`, delivered stock, user caps, links.
- **The keeper is bounded.** It can push buys to about oracle −1.5% and accrue up to each
  cap into the user's own park. It can't withdraw, redirect deliveries or block exits.
- **Disclosure:** the README discloses the single owner wallet, but there is no
  SECURITY.md entry and no roles table.

## Tests run (isolated copy)

| Suite | Result |
|---|---|
| Foundry (non-fork) | 266 pass, 0 fail, 9 skipped (opt-in fork probes). 6 PoC tests added by the audit, all passing. |
| Invariants | 10 invariants held at 1,600 runs × depth 64 = 102,400 calls each. The repo's own config runs only 8,192. |
| Coverage | Contracts are at 92.2% of `src/`: SweepExecutor, StockRouter and the registries 100%; SgovParkAdapter 0% (fork tests only); FeeVault 20%. The keeper (`keeper.ts`, `venue.ts`, `config.ts`, `run.ts`) has 0% unit coverage. Combined in-scope core code is about 36%. |
| Engine (`bun test`) | 149 of 153 pass. The 4 failures are [specific to the auditor's environment]: an anvil fork with the RPC blocked, and an `i18next` import from the frontend. `tsc` is clean. |
| Server (`vitest`) | 103 pass, 4 skipped. `tsc` is clean. |
| `forge build` from a clean clone | Fails: `script/lib/*.sol` isn't in git. |

## Score breakdown

| Cat | Score | Weight | Weighted | Main deductions |
|---|---|---|---|---|
| A On-chain | 8.2 | 35% | 2.87 | 1 Medium, 2 Low |
| B Off-chain | 1.6 | 15% | 0.24 | 5 Medium, 8 Low |
| C Testing | 5.3 | 15% | 0.80 | Build fails from a clone (0.3 of 1.5); core coverage about 36% with the keeper (0); no mutation testing, no symbolic checks, no CI |
| D Privileged ops & deploy | 2.5 | 10% | 0.25 | Single EOA, no timelock; privileged functions not listed; setters not fully bounded; deploy and verify scripts don't compile; no post-deploy check run; no monitoring |
| E Deps | 6.0 | 5% | 0.30 | Engine viem `^`; no ignore-scripts or release cooldown; Redis image gate |
| F Hygiene & CI | 4.0 | 10% | 0.40 | No CI, static analysis or gitleaks; no LICENSE or SECURITY.md; no `.nvmrc` / `packageManager` |
| G Docs | 4.0 | 10% | 0.40 | No deploy-from-clone path; no invariants doc; no explorer links or build hash; no CHANGELOG or audit tag |
| **Total** | | | **5.25 → 5.2** | |

**Caps (none bind today):**

- 6.0: build fails from a clone.
- 7.0: live deployment not checked.
- 8.9: open Medium.

**[Project] policy:**

- P1 (exit never gated): pass.
- P5 (no APY language): pass.
- P7: no hits; the `$SPARE` hits are its own brand.
- 48 h timelock for fund-holding contracts: fail.

**Independent check:** a separate reviewer recomputed 5.5.

- Accepted from it: moving the owner drain from a finding to D; merging the stack-trace
  leak into B-M1; dropping Rug Radar and keeper stall to Low.
- Held, stricter: keeper coverage counts as core code (0 points); setter bounds at 0
  (`finalityBuffer = 0` is accepted).
- Rerun: it reran all 6 PoCs and one invariant suite at 102,400 calls, and they pass.

## Path to 9.5

Ranked by grade points per hour. Grades are cumulative.

| # | Fix | Size | Grade after |
|---|---|---|---|
| 1 | Unmount the legacy [previous-codebase] routes: `/api/ai/*` and `/api/chain/*` (nothing in the product calls them), or put them behind auth plus a global daily spend cap. Clears B-M2, M4, M5, L1, L7, L8. | S | 5.9 |
| 2 | Redact errors: `(e.shortMessage ?? e.message).split('\n')[0]` in `shortError` and MCP `dispatch.ts`; a final JSON error handler; `NODE_ENV=production` by default. Rotate the Alchemy key if it was ever in a URL. Clears B-M1. | S | 6.0 (capped) |
| 3 | Commit `script/lib/`: change `contracts/.gitignore` from `lib/` to `/lib/`, commit SpareConfig.sol and SpareBase.sol, and add a deploy section to the README. Lifts the 6.0 cap. | S | 6.5 |
| 4 | Engine: tRPC `maxBatchSize: 5`; count every getLogs call against `maxChunks` with a total-logs cap; use the right-most `X-Forwarded-For`; a per-wallet scan budget and deadline in the keeper; skip any asset whose quote is more than 30 bps worse than the oracle. Clears B-M3, L2, L3, L4. | M | 6.8 |
| 5 | Webhook and replay budget: mount the webhook router before `express.json()` and always require the key; compute the replay budget with `pick()`. Clears B-L5, L6. | S | 6.9 |
| 6 | LICENSE and SECURITY.md: a disclosure contact, a table of privileged functions with their holders, and accepted risks (A-L1, A-L2 while SGOV stays on standby). | S | 7.0 (capped) |
| 7 | Pins: exact `viem` in the engine; `.nvmrc` and `packageManager`; redis:7.4.6+ by digest; `ignore-scripts` plus `minimumReleaseAge`. | S | 7.0 (capped) |
| 8 | CI: `forge test`, `bun test` and `vitest` on every push; Slither and Semgrep; gitleaks; SHA-pinned actions; `permissions: contents: read`. | M | 7.0 (capped) |
| 9 | Owner → Safe plus timelock (no redeploy, the contracts are Ownable2Step): a 2-of-3 Safe with hardware signers owns a ≥48 h `TimelockController`. `transferOwnership(timelock)` on all 7 contracts, then accept through the Safe batch that `AcceptOwnership.s.sol` already prints. Keep the pauser as a separate fast Safe. | M | 7.0 (capped) |
| 10 | Whale isolation (A-M1): the keeper puts any account whose leg pushes impact past about 30 bps into its own batch, or caps netted USDG per asset. Turn the `NettedWhale` PoC into a regression test. | M | 7.0 (capped) |
| 11 | Live verification: run `VerifyDeployment.s.sol` against 4663 (it compiles after #3) and commit the output; Blockscout-verify all 10 contracts; add explorer links and the build hash to the README. Lifts the 7.0 cap. | M | 8.9 |
| 12 | Keeper unit tests: `keeper.ts`, `venue.ts`, `config.ts` and `run.ts` against a fake RPC (accrue windows, exclusions, caps, the netted quote, the in-flight nonce), bringing core coverage to ≥95%. | L | 9.1 |
| 13 | Monitoring: self-hosted OpenZeppelin Monitor on `OwnershipTransferStarted`, `ExecutorSet`, `AssetSet`, `ParamsSet`, `KeeperSet`, `Paused` and the timelock `CallScheduled`, plus a keeper ETH balance alert; a RUNBOOK. | M | 9.2 |
| 14 | Docs: INVARIANTS.md linking each invariant to its test; set `[invariant] runs = 1600` in `foundry.toml`; a CHANGELOG; commit this report; an audit tag. | S | 9.6 |

**Later, up to 9.9:**

- mutation testing at ≥80% on SweepExecutor, CashPark and StockRouter;
- Halmos on RoundUp and OracleGuard;
- unit tests for SgovParkAdapter and FeeVault;
- setter bounds on the next redeploy (minimum `finalityBuffer`, maximum heartbeat, an
  18-decimals check);
- before ever enabling SGOV: a keeper minOut on unpark, a holding period, a user minOut
  on `exit`, and the band at 25–50 bps.

**Effort:** items 1–8 are about one day of off-chain and config work. Item 9 needs the owner
key and a Safe. Item 11 needs an RPC that works [the auditor's environment could not reach chain
4663].

*AI audit grade: a strong pre-audit signal, not a substitute for a human audit before large
TVL.*
