# Spare API

Backend for **Spare** — round-up investing on Robinhood Chain mainnet (chain 4663).
Deployed as `spare-api` at https://api.trysparerh.com; serves https://trysparerh.com.

Spare in one paragraph: a user links spending wallets and sets a rule (round to
$1 / $5 / $10, 1–5x "turbo", weekly cap). Every outgoing USDG payment is rounded
up; the spare change parks in the CashPark; a keeper sweeps it (at $5 or more,
once per daily epoch) into the user's mix of tokenized stocks — whatever the
on-chain AssetRegistry has active (`/api/spare/universe` lists them) — through
allowlisted Uniswap v4 pools, with Chainlink-checked, quote-limited execution.
The only charge is a 25 bps conversion fee to the FeeVault; there is no
subscription.
The **$SPARE token has not launched** — this API never reports a CA, price,
supply or holders for it.

This service provides:

- **Spare engine reads** (`/api/spare/*`) — live, read-only views of the Spare
  contracts: universe, accounts, round-up math, v4 quotes, activity, roles, fees.
- **Spare MCP** (`/mcp`, also `/api/mcp`) — a Model Context Protocol server
  (Streamable HTTP) exposing the engine reads as eight free `spare_*` tools.
- **$SPARE token status** (`/api/spare/token/*`) — not launched.
- `GET /health` — service, RPC, oracle and keeper status.

Nothing else is mounted: any other path is a JSON `404 { error: "not_found" }`.

The keeper and indexer are **not** here — they live in `engine/` (Bun). This API
only reads chain state; it holds no keys (the keeper address it reports comes
from the committed address book) and cannot move funds.

## Run

```bash
cd server
npm ci
npm run dev          # tsx watch, PORT (default 3001)
npm run typecheck
npm run test:run     # vitest; the live mainnet smoke test self-skips offline
```

Node 24 (`.nvmrc`) with npm 11.10 or newer. An older npm still installs and
runs scripts, but `devEngines` makes it warn (`EBADDEVENGINES`), because older
npm ignores the `min-release-age` setting in `.npmrc`; use npm 11.10+ to add or
bump dependencies. Node 24.20+ ships a new enough npm.
Dependencies are pinned to exact versions, matching `package-lock.json`.

Configuration is documented in `env.example`. Nothing is required — every
chain read (engine reads, MCP tools, `/health`, the $SPARE holder snapshot)
goes through one client on `SPARE_RPC_URL`, else `RHC_RPC_URL`, else the public
RHC RPC. `NODE_ENV` defaults to `production`.
Only the variable names in `env.example` are read; names from before the
rebrand are ignored.

## Spare engine — `/api/spare`

All read-only, free, live at the block reported in `readAt`. Money is exact
decimal strings (USDG 6 dp, stock tokens 18 dp).

| Endpoint | What it returns |
|---|---|
| `GET /api/spare/universe` | Registry assets (active flag, pinned v4 pool + poolId (a dynamic-fee pool: `feePct: "dynamic"` + its live `lpFee` from slot0), Chainlink price, oracle status, the keeper's market-hours gate, ERC-8056 multiplier change and `buyableNow`, pause flags, UI multiplier), sweep params, park adapter, default mix |
| `GET /api/spare/account/:address` | Linked wallets (Permit2 consent, cursor), rule, pending/parked value vs the $5 threshold, rolling weekly cap (pulled 7d, remaining), swept this epoch, mix, claimables, stock holdings at oracle value. `keeperWouldSweepNow` and each mix leg's `keeperOutcome` + `reason` mirror the keeper (`src/spare/keeperRules.ts`): market hours, multiplier changes, and the quote-vs-oracle check (B-L3) on the account's own legs. A linked spending wallet resolves to its account. |
| `GET /api/spare/activity/:address?days=1..7` | Decoded SweepExecutor / CashPark / RuleRegistry / ElectionRegistry events, scanned newest-first in chunks of at most 50,000 blocks, never before the deploy block, at most 24 chunks per call: when `page.nextBefore` is set, pass it as `before=` for the next page |
| `GET /api/spare/quote?asset=SPY&usdgIn=5` | V4 Quoter read through the pinned pool after the 25 bps fee, vs the oracle band, with the keeper's quote-limited minimum and what a sweep leg would do now (buy / wait / defer / safe-settle, market-hours gate and multiplier changes included; `keeperOutcome` tells a keeper `hold` (B-L3) from an on-chain defer, with `keeperChecks`) |
| `GET /api/spare/roundup-preview?amountUsd=3.75&roundTo=1&multiplier=3` | Exact `RoundUp.sol` math; `amounts=…` for a list, or `wallet=0x…&days=1..30` to replay a wallet's real USDG payments with Spare's exclusions (at most 40 log reads, 20,000 transfers and 600 distinct payees per call; past a bound `window.complete` is false and `window.stoppedBy` names it) |
| `GET /api/spare/contracts` | Address book, bytecode check, live roles and wiring, mismatches vs the deploy file |
| `GET /api/spare/fees` | FeeVault USDG / WETH / ETH balances and fee parameters, and all-time fees from AssetSwept since deploy (scanned to head - 3,000 blocks, SweepExecutor's finality buffer) |
| `GET /api/spare/token` | `$SPARE` status: not launched, no CA, official channels |

Bad input returns `400 { error: "invalid_params", message }`; RPC trouble
returns `502 { error: "chain_read_failed", message }` (batched reads go through
Multicall3 `aggregate3`, `src/spare/multicall.ts`: a revert fails only its own
field, an RPC failure fails the whole read); over the per-IP read budget
(60 units/min shared with the MCP endpoint, see `src/spare/budget.ts`) returns `429`
with `Retry-After`. A wallet replay costs 10 units whichever of `wallet`,
`address` or `account` carries the address. A client is its IP, an IPv6
address by its /64. Every `eth_getLogs` the server sends, whoever asked,
draws from one process-wide cap of 20 per second (burst 60,
`src/spare/client.ts`); when it is spent the read fails at once with
`503 { error: "rpc_busy", message, retryAfterSeconds }` and `Retry-After`
(`rpc_busy` in an MCP tool result). Every `message` is one line run
through `src/redact.ts`: never the RPC URL (which can hold a provider key), an
upstream reply or a stack. Anything unexpected is `500 { error: "internal_error" }`.
Addresses come from
`src/spare/book.ts`, which a test pins to `contracts/addresses/4663.json`.

## Spare MCP — `/mcp` (also `/api/mcp`)

See [`docs/SPARE_MCP_SETUP.md`](../docs/SPARE_MCP_SETUP.md) and
[`docs/MCP_TOOLS.md`](../docs/MCP_TOOLS.md).

- `POST /mcp` — JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`, `ping`
- `GET /api/mcp/tools` — catalog JSON (the seven Spare engine tools; `?toolset=all` adds `spare_token`)

`POST /mcp` and `POST /api/mcp` draw on the same per-IP read budget as
`/api/spare/*` (charged per JSON-RPC message; at most 10 per batch). Every tool
is free and read-only; there is no key. Tool names are `spare_*` only (a bare
name such as `universe` gets the prefix); any other name is `unknown_tool`.

## $SPARE token — `/api/spare/token`

`GET /api/spare/token` (status), `/stats` (buyback ledger totals), `/ledger`,
`/pending` and `/holders/distribution`. They answer with zeros, empty
lists and `launched: false` until `SPARE_TOKEN_ADDRESS` is set.
