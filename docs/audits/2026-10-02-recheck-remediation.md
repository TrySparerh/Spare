# Re-check of the remediated code: remediation notes

The re-check of the remediated pre-release code against the rubric of the 2026-10-02 audit
([report](2026-10-02-ai-audit-grade.md)) found two new findings in spare-api (`server/`) and three
leads. All five are fixed. Every fix has a test, and each test was shown to fail with its fix
reverted. The before/after figures come from the re-check's own proofs of concept, run unchanged
against the fixed code.

| ID | What the re-check found | Status | Fix | Evidence |
|---|---|---|---|---|
| B-N1 (Medium) | A wallet replay (`spare_roundup_preview` with `wallet=`, `GET /api/spare/roundup-preview?wallet=`) had no bound on what one call reads or holds: a busy wallet made a single 10-unit call send 13 `eth_getLogs`, hold 129,987 transfers, send 4,334 `eth_call`s and grow the heap by 202 MiB | Fixed | `server/src/spare/replay.ts`: one call sends at most 40 `eth_getLogs`, holds at most 20,000 transfers and checks at most 600 distinct payees for v3 pools (about 32 `eth_call`s). Past a bound it stops at a whole block and answers `window.complete: false`, `window.stoppedBy` and `window.scannedFromBlock`; a payment is never counted without its pool check | PoC after the fix: 3 `eth_getLogs`, 599 transfers, 21 `eth_call`s, +26 MiB, 144 ms, `complete: false`. `server/src/spare/replay.test.ts` (the PoC as a test, plus the payee cut, the transfer cut and the read budget) |
| B-N2 | `spare_activity` priced a call by its window, not its reads: one 6-unit call could send 121 `eth_getLogs` (76 at the re-checked head) | Fixed | `server/src/spare/logs.ts` / `reads.ts`: at most 24 chunks per call (`window.maxGetLogsCalls`); the rest is paged with `page.nextBefore`. `server/src/spare/client.ts`: one process-wide `eth_getLogs` cap of 20 per second (burst 60); when it is spent a read fails at once with `503 { error: "rpc_busy", message, retryAfterSeconds }` and `Retry-After` (an `rpc_busy:` result over MCP) | PoC after the fix: 24 `eth_getLogs` for the same call. `activity.test.ts` (121 chunks covered by 6 pages, contiguous, newest first, an event found once), `client.test.ts` (the cap fails fast with nothing sent upstream), `errors.routes.test.ts` (REST 503 with `Retry-After`, the MCP text) |
| Lead: client key | The per-IP read budget keyed on the raw address, so one IPv6 client could rotate through its /64 and multiply its budget | Closed | `server/src/spare/budget.ts` `rateLimitKey`, the engine's rule: IPv4 as is, IPv4-mapped IPv6 as its IPv4, any other IPv6 by its /64 | `budget.test.ts`: the engine's test addresses, and a rotation through one /64 runs out one budget |
| Lead: holder snapshot | The `$SPARE` holder snapshot could pass a partial count off as the whole when a log chunk or a balance read failed | Closed | `server/src/services/holderSnapshot.ts`: `complete` is `true` only when no chunk and no balance read failed; the warming placeholder says `false` | `holderSnapshot.test.ts` |
| Lead: fee ledger | The all-time fee ledger scanned to the head, so it could count a sweep that was not yet final | Closed | `server/src/spare/reads.ts`: the ledger counts only blocks at least 3,000 deep (`SweepExecutor.finalityBuffer`), reported as `allTime.confirmations`; `allTime.complete` is measured against head − 3,000 | `reads.test.ts`: no range read goes past head − 3,000; a sweep 1,000 blocks below the head is not counted, and once the head has moved on 5,000 blocks it is counted exactly once |

What changed for clients is in [`docs/MCP_TOOLS.md`](../MCP_TOOLS.md) and
[`server/README.md`](../../server/README.md): a replay or an activity page can now be partial
(`complete: false`, with the reason), activity pages through `nextBefore`, all-time fee totals trail
the head by about 5 minutes, and any log read can answer `rpc_busy`.
