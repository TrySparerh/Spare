# Spare MCP — Tool Reference

Server `spare-mcp` ("Spare MCP"), served by the Spare API:

- `POST /mcp` (also `POST /api/mcp`) — MCP JSON-RPC over Streamable HTTP: `initialize`, `tools/list`, `tools/call`, `ping`
- `GET /api/mcp/tools` — the catalog as JSON `{ server, tools: [{ name, description, inputSchema, … }], total, toolset }`: the seven Spare engine tools by default, `?toolset=all` adds `spare_token`
- `GET /api/spare/<tool>` — REST mirror of each engine tool, same JSON

Setup: [`SPARE_MCP_SETUP.md`](./SPARE_MCP_SETUP.md).

All eight tools are free and `scope: "read"`; no key is needed. None can sign a transaction, move
funds or hold keys. There are no other tools.

## Limits

One per-IP budget of **60 read units per minute** covers `POST /mcp`, `POST /api/mcp`
and `GET /api/spare/*` together. Each JSON-RPC message is charged (a batch is charged per message);
most tools cost 1–2 units, `spare_fees` 4, `spare_activity` 6, a wallet replay in
`spare_roundup_preview` 10. Over budget: HTTP `429` with `Retry-After` (JSON-RPC error `-32005` on the
MCP endpoint, `{ error: "rate_limited" }` on REST). A batch holds at most **10** messages; a bigger one is
refused (`-32600`) without running anything. `spare_universe` and `spare_activity` results are reused for
10 s and `spare_fees` for 15 s; every result names the block it was read at.

Every `eth_getLogs` the server sends, whoever asked, also draws from one process-wide cap of 20 per
second (burst 60, `server/src/spare/client.ts`). When it is spent, a read that needs logs fails at once
instead of queueing: HTTP `503 { error: "rpc_busy", message, retryAfterSeconds }` with `Retry-After` on
REST, and an `isError: true` result whose text starts with `rpc_busy:` on the MCP endpoint. Its partial
work is discarded; retry after the given seconds.

---

## Spare engine tools (7) — free, open, live

Read Robinhood Chain mainnet (4663) and the live Spare contracts
(`contracts/addresses/4663.json`). Every result reports the block it was read
at. Money is exact decimal strings: USDG 6 dp, stock tokens 18 dp. The
examples below are real mainnet reads from 2026-09-30 (block ~76.75M).

Each response has flat fields at the top level (the ones the site's live pages read, e.g.
`oracleStatus`, `price`, `parkedUsd`, `expectedOut`), next to the detailed nested objects.

### Market hours (keeper parity)

The keeper buys an equity leg only while OracleGuard says OK **and** the US-equities 24/5 session is
open (Sunday 20:00 to Friday 20:00 ET) **and** the feed has posted since the session opened
(`MARKET_HOURS_GATE=1`, its default). OracleGuard keeps a frozen Friday close at OK for up to ~25 h, so
the tools apply the same gate: a price is labelled `LIVE` only inside it, otherwise `market closed`, and
`spare_quote` answers `wait` instead of `buy`. A sweep is all-or-nothing per account: if any active stock in
the mix is waiting, the whole account waits. (`SPARE_MARKET_HOURS_GATE=0` on the API mirrors a keeper run
with the gate off.)

### The keeper's per-leg rules (`keeperOutcome`)

`spare_quote`, `spare_account` and `spare_universe` apply the keeper's own rules, in its order
(`server/src/spare/keeperRules.ts`, a copy of `engine/src/keeper/plan.ts` + `batches.ts` that a test runs
side by side with the engine so the two cannot drift):

1. **Per asset** (`keeperState`): an inactive asset is `settle` (paid out as USDG). An unreadable registry,
   feed or ERC-8056 multiplier state, an oracle that is not OK, the market-hours gate, or an ERC-8056
   multiplier change the feed has not caught up with (from 15 min before it until the feed posts after it)
   is `wait`: the keeper holds the whole account. Otherwise `ok`.
2. **Quote vs oracle (audit B-L3)**: a leg is sent only with a limit from a same-block quote, and only if
   the $1 reference quote is at most *pool fee + 60 bps* under the Chainlink price, and the leg's own quote
   at most *min(pool fee + 60 + 30, 120) bps* under it (120 bps when the account is swept in a call of its
   own because a leg moves its pool more than 30 bps). The pool fee is the LP fee (slot0's for a
   dynamic-fee pool) plus the protocol fee. A leg that fails is `hold`: every account holding the stock sits
   the sweep out with its epoch kept and is retried next tick; nothing is spent.
3. **Router band**: a fill further than the asset's `bandBps` from the oracle reverts on chain and the leg
   is `defer`red (the account's epoch is used).

`keeperOutcome` is one of `buy`, `wait`, `hold`, `defer`, `safe_settle`. The limits are the keeper's
defaults (`QUOTE_ORACLE_ALLOWANCE_BPS` 60, `SWEEP_MAX_IMPACT_BPS` 30, `QUOTE_MAX_SHORTFALL_BPS` 120,
`QUOTE_TOLERANCE_BPS` 50 in `engine/src/keeper/config.ts`); every check reports the ones it used
(`allowanceBps`, `maxImpactBps`, `maxShortfallBps`), and a keeper run with overrides decides with its own.
The keeper nets every due account's leg of a stock into one swap; the API judges the leg you asked about
on its own.

### `spare_universe`
Args: `includeInactive` (boolean, default `true`; `false`, `"false"` or `"0"` lists active assets only).
`{ chainId, readAt, registry, counts, assets: [row], sweep, park, defaultMix, sequencerFeed, market, notes }`.
Each row: `symbol, name, kind` (`stock` / `etf`), `token, active, state, inactiveReason, defaultMixBps, feed,
heartbeatSec, bandBps, oracleStatus` (OracleGuard number 0–4), `oracleLabel` (`LIVE` / `market closed` /
`corporate action` / `sequencer down` / `bad answer`), `price, lastAnswer, lastUpdatedAt, marketOpen,
sessionOpenedAt, buyableNow, keeperState, waitReason, multiplierChange, market, pool, oracle { … },
tokenFlags, explorer`.

- `buyableNow`: active and past every per-asset gate of the keeper (rule 1 above). The per-size quote
  check (rule 2) is `spare_quote`'s and `spare_account`'s.
- `keeperState`: `ok`, `wait` or `settle`; `waitReason` says why when it waits.
- `multiplierChange`: `{ uiMultiplier, newUIMultiplier, effectiveAt, pending, leadSeconds }` (ERC-8056),
  `null` when unreadable. `pending: true` means the keeper waits.
- `pool`: `{ poolId, currency0, currency1, fee, feePct, dynamicFee, lpFee, lpFeePct, tickSpacing, hooks,
  hooked }`. `fee` is the PoolKey's fee field as stored (with the currencies, tick spacing and hooks it is
  the PoolKey `poolId` hashes). For a **dynamic-fee** pool it is v4's flag `8388608` (`0x800000`), not a
  rate: `feePct` is then `"dynamic"` and `lpFee` / `lpFeePct` give the LP fee the hook charges now, read
  from `StateView.getSlot0` (`null` if slot0 did not read). For a static pool `lpFee` is `fee`. Fees are
  in pips (1,000,000 = 100%): `500` is `"0.05%"`.

```text
SPY  active              LIVE  $770.44134138  default mix 60%   buyableNow true
NVDA active              LIVE  $230.54857341  default mix 40%   buyableNow true
AAPL active              LIVE  $336.30026516
TSLA active              LIVE  $352.14
QQQ  registered_inactive LIVE  $744.6764973   — "Pool too thin: … +2.65% vs Chainlink"
SGOV registered_inactive LIVE  $101.18862069  — "Only a hooked pool exists; …"
market: us_equities_24_5, gate on, session open since 2026-09-28T00:00:00Z
```

### `spare_account`
Args: `address` (required; aliases `account`, `wallet`). A linked spending wallet resolves to its account
(`resolvedFrom` says so). Example response (shortened; the address is a placeholder):

```json
{
  "account": "0x7e57000000000000000000000000000000000001",
  "parkedUsd": "0", "pendingUsd": "0", "remainingWeeklyCapUsd": "20", "pulledLast7dUsd": "0",
  "sweptThisEpoch": false, "nextEpochAt": "2026-10-01T00:00:00.000Z",
  "readyToSweep": false, "keeperWouldSweepNow": false,
  "waitingFor": ["parked spare below the $5 sweep threshold"],
  "mixIsDefault": true,
  "keeperSweepsAlone": false,
  "mix": [
    { "symbol": "SPY", "bps": 6000, "pct": "60%", "oracleStatus": 0, "oracleLabel": "LIVE", "marketOpen": true,
      "keeperState": "ok", "keeperOutcome": "buy", "reason": null, "multiplierChange": { "…": "…" }, "quoteCheck": { "…": "…" } },
    { "symbol": "NVDA", "bps": 4000, "pct": "40%", "oracleStatus": 0, "oracleLabel": "LIVE", "marketOpen": true,
      "keeperState": "ok", "keeperOutcome": "buy", "reason": null, "multiplierChange": { "…": "…" }, "quoteCheck": { "…": "…" } }
  ],
  "rule": { "roundTo": 10, "multiplier": 1, "weeklyCapUsd": "20", "enabled": true, "active": true },
  "wallets": [{ "wallet": "0x8d41…47Cf", "selfLinked": true, "permit2": { "allowanceUsd": "unlimited", "expired": false }, "consent": "ok" }],
  "claimable": [], "holdings": [], "holdingsValueUsd": "0",
  "screening": { "enforced": false, "eligible": true, "clearedUntil": null },
  "park": { "…": "…" }, "weeklyCap": { "…": "…" }, "sweep": { "…": "…" }, "status": { "…": "…" }
}
```
`parkedUsd` is everything waiting in CashPark (`CashPark.valueOf`: pending USDG + parked units at NAV);
`pendingUsd` is the not-yet-parked part. `readyToSweep` covers the on-chain conditions (threshold, epoch,
screening, mix); `keeperWouldSweepNow` adds the executor's pause flag and the keeper's rules on every mix
leg: false if any leg would `wait` or `hold`.

Each `mix[]` leg: `symbol, asset, bps, pct, oracleStatus, oracleLabel, marketOpen, keeperState`
(`ok` / `wait` / `settle`), `waitReason` (only when it waits), `keeperOutcome` (`buy` / `wait` / `hold` /
`defer` / `safe_settle`), `reason` (a sentence; `null` when it buys), `multiplierChange` (as in
`spare_universe`) and `quoteCheck` (the B-L3 check of this account's own leg, shaped like
`spare_quote`'s `keeperChecks.quoteVsOracle`; `null` for an inactive asset). The leg's size is the
account's parked value split by the mix with the 25 bps fee off; below the threshold `fullSize` is `null`
and only the $1 pool check applies. `keeperSweepsAlone` is true when a leg moves its pool more than 30 bps:
the account is then swept in a call of its own and every leg is held to the 120 bps cap.
`waitingFor` lists every reason the account is not swept now, including `"<SYMBOL>: <waitReason>"` and
`"<SYMBOL>: held: <why>"`.

### `spare_roundup_preview`
Args, one of three modes, plus `roundTo` (1|5|10, default 1; alias `round_to`), `multiplier` (1..5,
default 1), `weeklyCapUsd` (optional; alias `weekly_cap_usd`):
- `amountUsd` — one payment (`mode: "single"`; aliases `amount`, `amount_usd`);
- `amounts` — array, JSON array string or comma list (`mode: "amounts"`, `excluded: []`);
- `wallet` + `days` (1..30, default 7) — replay that wallet's real outgoing USDG payments (`mode: "wallet"`;
  `address` or `account` also select this mode). The first mode given wins: wallet, then amounts, then amountUsd.

Math identical to `contracts/src/libraries/RoundUp.sol`:
`delta = amount % step == 0 ? 0 : (step − amount % step) × multiplier`.

```json
{ "mode": "single", "payment": { "usd": "3.75" }, "rule": { "roundTo": 1, "multiplier": 3 }, "roundsUpTo": { "usd": "4" },
  "delta1x": { "usd": "0.25" }, "delta": { "usd": "0.75", "label": "$0.75" },
  "turbo": [{ "multiplier": 1, "usd": "0.25" }, "…", { "multiplier": 5, "usd": "1.25" }] }
```
List form (`amounts: ["3.75","12.40","5.00"]`, 3x, cap $2): rows `0.75 / 1.8 / 0 (on boundary)`,
`totalUsd "2.55"`, `cappedTotalUsd "2"`, `droppedByCapUsd "0.55"`.

Wallet form: `{ mode, wallet, account, linkedWallets, rule, window { days, fromBlock, toBlock, scannedFromBlock,
complete, stoppedBy, getLogsCalls }, payments, rows: [{ amount, roundUp, collectedUnderCap?, onBoundary, txHash,
block, time, timeEstimated }], rowsTruncated, totalUsd, weeklyCapUsd, cappedTotalUsd, droppedByCapUsd,
excluded: [{ txHash, block, to, amount, reason }], excludedCount, formula, source, notes }`.
Exclusions are the keeper's (`engine/src/lib/payments.ts`): `to-zero-address`, `to-account`,
`to-linked-wallet`, `to-spare-contract`, `to-venue` (Uniswap routers / PoolManager / canonical v3 pools).
The weekly cap is applied over rolling 7 UTC days (`SweepExecutor.dayPulled`). Logs are read by sender in
2,000,000-block chunks, newest first. One call is bounded three ways: at most **40 log reads**, **20,000**
outgoing transfers held and **600** distinct payees checked for v3 pools. Past a bound the replay stops at a
whole block: `window.complete` is `false`, `window.stoppedBy` names the bound (`"log-reads"`, `"transfers"` or
`"recipients"`), every payment from `window.scannedFromBlock` to the head is in the result, and the third
`notes` entry says which payments are left out (the first two say that this is a replay, not what Spare
collected, and how the cap and the times are computed). It is a replay under the rule you pass, not what
Spare collected.

### `spare_quote`
Args: `asset` (required: a registered ticker or registry token address; alias `symbol`), `usdgIn` (USDG
in dollars before the fee, up to 6 dp, more than 0 and at most 1,000,000; default `"5"`; aliases `usdg`,
`usdg_in`, `amount`). Quotes the exact netted-sweep path: fee off the top, V4 Quoter
(`0x8dc178ef…8f94`) on the registry's PoolKey.

```json
{ "asset": { "symbol": "SPY", "active": true },
  "usdgIn": "5", "feeUsd": "0.0125", "expectedOut": "0.006470800909309853",
  "oraclePrice": "770.44134138", "fillPrice": "770.77012102", "edgeVsOracleBps": -4.26,
  "minOutAtKeeperTolerance": "0.006438446904763303",
  "oracleStatus": 0, "oracleLabel": "LIVE", "marketOpen": true,
  "outcome": "buy", "wouldBuy": true, "wouldDefer": false, "wouldWait": false, "reason": null,
  "keeperOutcome": "buy", "wouldHold": false,
  "keeperChecks": { "multiplierChange": { "…": "…" }, "quoteVsOracle": { "…": "…" } },
  "input": { "…": "…" }, "pool": { "…": "…" }, "quote": { "…": "…" }, "oracle": { "…": "…" }, "market": { "…": "…" },
  "sweep": { "…": "…" }, "notes": ["…"] }
```
`outcome`, in the keeper's order: `safe_settle` (asset inactive), `wait` (rule 1: oracle not OK, outside
the market-hours gate, or a pending ERC-8056 multiplier change; the keeper holds the account), `defer` (the
keeper holds the leg, or the fill is outside the oracle band), else `buy`. `outcome` keeps these four values
for older readers; **`keeperOutcome`** tells the two kinds of `defer` apart: `hold` (no quote, or the B-L3
check of rule 2: nothing is spent, the account keeps its epoch) vs `defer` (sent, and the router's band
rejects the fill on chain). `wouldHold` is `keeperOutcome === "hold"`; `wouldBuy` / `wouldDefer` /
`wouldWait` follow `outcome`. `reason` is a sentence (`null` when it buys); `sweep` repeats `{ outcome,
reason, keeperOutcome, wouldDefer, wouldWait, wouldHold }`.

`keeperChecks.multiplierChange` is the token's ERC-8056 state (`{ uiMultiplier, newUIMultiplier,
effectiveAt, pending, leadSeconds }`, `null` when unreadable). `keeperChecks.quoteVsOracle` is the B-L3
check for a leg of this size on its own (`null` for an inactive asset):

```json
{ "ok": true, "why": null, "poolFeeBps": 6.25, "allowanceBps": 60, "maxImpactBps": 30, "maxShortfallBps": 120,
  "reference": { "swapInUsd": "1", "tokensOut": "0.0012…", "shortfallBps": 24.6, "maxBps": 66.25, "ok": true },
  "fullSize": { "swapInUsd": "4.9875", "tokensOut": "0.0064…", "impactBps": 0, "alone": false,
                "shortfallBps": 24.6, "maxBps": 96.25, "ok": true } }
```
`why` is the keeper's own log reason when it holds the leg, e.g. `"pool 174.8 bps under the oracle at $1
(max 169.9: pool fee + 60)"` (MU's 1% pool, 2026-10-02) or `"quote 118.4 bps under the oracle (max 96.3)"`. `reference` is `null`
without a $1 quote or an OK oracle price; `fullSize` is `null` when the leg was not quoted. `impactBps`
is the leg's price impact against the $1 quote; `alone` is true when it is over `maxImpactBps` (the leg is
then held to `maxShortfallBps` only).

`pool` has the `spare_universe` pool fields (`fee`, `feePct`, `dynamicFee`, `lpFee`, `lpFeePct`, …) plus
`zeroForOne`. `edgeVsOracleBps` is positive when the pool gives more tokens than the Chainlink price.

### `spare_activity`
Args: `address` (optional; aliases `account`, `wallet` — omit for the global feed, which strips
account/wallet addresses), `days` (1..7, default 7), `limit` (1..100, default 50), `kinds` (array or comma
list), `before` (block, for paging: pass `page.nextBefore`).
Decodes SweepExecutor, CashPark, RuleRegistry and ElectionRegistry events; scans newest-first in
chunks of at most 50,000 blocks, never before the deploy block, and stops once `limit` is reached or
after **24 chunks** (`window.maxGetLogsCalls`), whichever comes first. A scan the chunk cap stopped with
room left on the page returns `window.complete: false`, `page.truncated: true` and `page.nextBefore`
(= `window.scannedFromBlock`): pass it as `before` to read the next page. Pages cover the window once,
with no gap or overlap; a client that ignores `nextBefore` sees about 1.4 days of a quiet account per call.
`window` also carries `scannedFromBlock`, `getLogsCalls`, `maxBlocksPerCall` and `scanMs`.
Kinds: `accrued`, `accrual_skipped`, `swept`, `asset_swept`, `swap_deferred`, `delivered`,
`delivery_held`, `deferred`, `safe_settled`, `claimed`, `credited`, `withdrawn_for_sweep`, `returned`,
`exited`, `exit_units_kept`, `rule_set`, `linked`, `unlinked`, `mix_set`, `mix_cleared`.

`{ scope, window, totals, count, page, items: [item] }`, items newest first. Each item: `kind, block, time`
(ISO), `timeEstimated, txHash, summary, explorer`, the flat fields that apply (`asset, usdg, tokens, fee,
epoch, status, reason`), and the decoded `args`.

```json
{ "scope": "global", "window": { "days": 1, "fromBlock": "76221269", "clampedToDeployBlock": true, "getLogsCalls": 11, "complete": true },
  "items": [
    { "kind": "rule_set", "block": "76652489", "time": "2026-09-30T16:17:50.000Z", "timeEstimated": false, "summary": "Rule set: round to $10, 1x, weekly cap $20, enabled" },
    { "kind": "linked", "block": "76652462", "time": "2026-09-30T16:17:48.000Z", "timeEstimated": false, "summary": "Wallet linked" } ],
  "page": { "limit": 50, "truncated": false, "nextBefore": null } }
```

### `spare_contracts`
No args. `{ chainId, network, startBlock, deployedAt, contracts: { AssetRegistry: "0x6dA6…c937", …,
SgovParkAdapter }, contractDetails: [{ name, address, deployed, role, explorer }], allDeployed,
roles: { owner, keeper, pauser, attestor }, rolesLive: { <contract>: { owner, pendingOwner, pauser, paused,
bookKeeperEnabled } }, wiring, mismatches, screeningEnforced, parkAdapter: { live, standby, current },
external: { USDG, Permit2, PoolManager, WETH }, venue, assets: { SYMBOL: token }, chainlinkFeeds, explorer }`.
At launch: 10/10 deployed, `mismatches: []`, `screeningEnforced: false`, park adapter `UsdgParkAdapter`.

### `spare_fees`
No args. `{ feeBps: 25, fundFeeBps: 25, maxFeeBps: 100, feeVault: { address, usdg, weth, eth, explorer },
conversionFeesAllTimeUsd, convertedAllTimeUsd, allTimeComplete, withdrawn: [{ token, symbol, amount, to,
txHash, block, time }], balances, fees, allTime, owner }`. All-time figures are Σ `AssetSwept.fee` /
`usdgIn` since deploy, incremental, counting only blocks at least 3,000 deep (SweepExecutor's finality
buffer, reported as `allTime.confirmations`), so the all-time totals trail the head by about 5 minutes;
`allTime.complete` / `allTimeComplete` say whether the scan has reached head − 3,000. The ledger lives in
memory and is rebuilt after a restart.
At launch: FeeVault `0` USDG / `0` WETH, all-time fees `0`.

### `spare_token` (free, listed with `?toolset=all`)
No args. `{ "symbol": "$SPARE", "launched": false, "status": "coming_soon", "address": null, … }` —
the token has not launched; there is no CA, price, supply or holder data. Not one of the seven engine
tools the default toolset lists; callable by name with no key. REST: `GET /api/spare/token`.
The REST holder distribution (`GET /api/spare/token/holders/distribution`) carries `distribution.complete`: `false` while
the snapshot is warming or when any log chunk or balance read failed, in which case the counts are
partial.

---

## Tool names

Every tool name is `spare_*`. A bare name gets the prefix (`universe` → `spare_universe`). Any other
name is `unknown_tool`.

## Response shapes

`tools/call` → `{ content: [{ type: "text", text }], structuredContent, isError }`.
Tool input errors come back as `isError: true` results whose text starts with `invalid_params` (bad
input, e.g. `roundTo: 2`, a non-address, `days: 9`) or `tool_error` (the handler failed; message only, no
stack). An unknown tool is JSON-RPC error `-32602`, an oversized batch `-32600`, over budget `-32005`
(HTTP 429 with `Retry-After`).

The REST mirror `GET /api/spare/<tool>` answers `400 { error: "invalid_params", message }` for bad input,
`502 { error: "chain_read_failed", message }` when the RPC fails, `503 { error: "rpc_busy", message,
retryAfterSeconds }` (with `Retry-After`) when the server-wide log-read cap is spent, and
`429 { error: "rate_limited" }` over budget. On the MCP endpoint `rpc_busy` is an `isError: true` result
whose text starts with `rpc_busy:`. A `message` is one redacted line (never the RPC URL, the upstream reply or a stack).

Batched reads go through Multicall3 `aggregate3` (`server/src/spare/multicall.ts`): a contract call that
reverts is reported for that field alone (e.g. `null`, `"no quote"`), but an RPC failure (timeout, 429,
node error) fails the whole read with the `502` / `tool_error` above. A `200` is never a snapshot whose
fields fell back to defaults because the node did not answer.

## Source

| Layer | File |
|---|---|
| Registry (single source of truth) | [`server/src/mcp/registry.ts`](../server/src/mcp/registry.ts) |
| Spare engine tools | [`server/src/spare/tools.ts`](../server/src/spare/tools.ts), reads in [`reads.ts`](../server/src/spare/reads.ts), wallet replay in [`replay.ts`](../server/src/spare/replay.ts), market hours in [`marketHours.ts`](../server/src/spare/marketHours.ts) |
| Read budget + caches | [`server/src/spare/budget.ts`](../server/src/spare/budget.ts), [`cache.ts`](../server/src/spare/cache.ts) |
| JSON-RPC server | [`server/src/mcp/server.ts`](../server/src/mcp/server.ts) |
| Dispatch, name resolution | [`server/src/mcp/dispatch.ts`](../server/src/mcp/dispatch.ts), [`normalize.ts`](../server/src/mcp/normalize.ts) |
| HTTP routes | [`server/src/routes/mcp.ts`](../server/src/routes/mcp.ts), [`server/src/routes/spare.ts`](../server/src/routes/spare.ts) |

Tests: `server/src/mcp/*.test.ts`, `server/src/spare/*.test.ts`, `server/src/routes/budget.routes.test.ts`
(the live mainnet smoke test skips itself offline).
