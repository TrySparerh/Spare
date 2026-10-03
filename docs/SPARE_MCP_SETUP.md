# Spare MCP — Setup

Spare MCP gives any MCP client or agent read-only access
to Spare on Robinhood Chain: the stock universe, an account's rule and parked
spare change, exact round-up math, live Uniswap v4 quotes, activity, contract
roles and fees. It cannot sign, move funds or see anything that is not already
public on-chain.

- **Endpoint:** `https://api.trysparerh.com/mcp` (also served at `/api/mcp`)
- **Transport:** Streamable HTTP, stateless, JSON responses (`POST` JSON-RPC 2.0)
- **Server:** `spare-mcp` ("Spare MCP"), protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`
- **Auth:** none for the Spare engine tools
- **Limits:** 60 read units per minute per client IP, shared with the REST mirror (most calls 1–2 units; `spare_activity` 6, `spare_fees` 4, a wallet replay 10); at most 10 messages per JSON-RPC batch; HTTP 429 + `Retry-After` when over

Nothing to install: the server runs inside the Spare API (`server/`).

## Connect

Spare MCP works with any MCP client. Add it to the client's MCP server
configuration; most clients read a JSON file with an `mcpServers` map, and
the exact file and field names are in the client's own documentation.

A client that connects to remote servers over Streamable HTTP:

```json
{
  "mcpServers": {
    "spare": {
      "type": "http",
      "url": "https://api.trysparerh.com/mcp"
    }
  }
}
```

Some clients name the transport field differently (for example `transport`)
or infer it from the URL; the endpoint is the only value Spare needs.

A client that only starts local (stdio) servers, through the `mcp-remote`
bridge (needs Node):

```json
{
  "mcpServers": {
    "spare": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.trysparerh.com/mcp"]
    }
  }
}
```

No API key, login or header is needed.

## Tools

`tools/list` advertises the seven Spare engine tools. They are free, open and
read live chain state at the block each result reports.

| Tool | Args | What it answers |
|---|---|---|
| `spare_universe` | `includeInactive?` | Which stocks Spare can buy, their pinned v4 pools (a dynamic-fee pool shows `feePct: "dynamic"` and its live `lpFee`), Chainlink prices, oracle status, whether the keeper's market-hours gate is open (LIVE vs market closed) and whether it would buy each one now (`buyableNow`), sweep parameters, default mix |
| `spare_account` | `address` (or `account` / `wallet`) | An account's rule, linked wallets and consent, mix, parked spare vs the $5 threshold, weekly-cap room, next epoch, whether the keeper would sweep it now (`keeperWouldSweepNow`, each leg's `keeperOutcome` + `reason`, and what it is waiting for), claimables, holdings |
| `spare_roundup_preview` | `amountUsd`, `amounts[]` or `wallet` + `days?` (1..30), `roundTo?`, `multiplier?`, `weeklyCapUsd?` | Exact `RoundUp.sol` round-ups for given payments, or a replay of a wallet's real USDG payments with Spare's exclusions |
| `spare_quote` | `asset`, `usdgIn?` (or `usdg`) | A live V4 Quoter read for a sweep-sized buy, vs Chainlink and the oracle band, and what a sweep leg would do now: `keeperOutcome` buy, wait (oracle / market hours / multiplier change), hold (the keeper's quote-vs-oracle check, `keeperChecks`), defer (router band) or safe-settle |
| `spare_activity` | `address?` (or `account` / `wallet`), `days?`, `limit?`, `kinds?`, `before?` | Collections, sweeps, deliveries, deferrals, exits, rule and mix changes — for one account or the global feed |
| `spare_contracts` | — | Every Spare address, its job, live roles and wiring |
| `spare_fees` | — | Fee rates, FeeVault balances, all-time conversion fees |

`spare_token` (`$SPARE` status: not launched, no contract address) is also free and
callable by name; it is listed with `?toolset=all`.

Full reference with example outputs and every argument alias: [`MCP_TOOLS.md`](./MCP_TOOLS.md).

## Try asking

- "What would a $1 rule at 3x collect from payments of $3.75, $12.40 and $5.00?"
- "Is NVDA buyable right now, and what would $20 of USDG get me?"
- "Show my Spare account 0x…" · "What has my account done this week?"
- "What has Spare charged in fees so far?"

## Verify

```bash
curl -s -X POST https://api.trysparerh.com/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# -> result.serverInfo.name == "spare-mcp"

curl -s -X POST https://api.trysparerh.com/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"spare_roundup_preview","arguments":{"amountUsd":"3.75","roundTo":1,"multiplier":3}}}'
# -> structuredContent.delta.usd == "0.75"
```

Then your MCP client should list the `spare` server with seven tools.

## Without MCP

Every engine tool has a REST mirror returning the same JSON:
`GET /api/spare/universe`, `/api/spare/account/:address`,
`/api/spare/activity/:address?days=7`, `/api/spare/quote?asset=SPY&usdgIn=5`,
`/api/spare/roundup-preview?amountUsd=3.75&roundTo=1&multiplier=3`,
`/api/spare/roundup-preview?wallet=0x…&days=7&roundTo=1`,
`/api/spare/contracts`, `/api/spare/fees`, `/api/spare/token`.
