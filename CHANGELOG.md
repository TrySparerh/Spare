# Changelog

All notable changes to Spare. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Development happened in a private
repository; public history starts at 1.0.0. The contracts are immutable: a contract change
means a new deployment, and it is called out as one.

## [1.0.0] - 2026-10-03

First public release: the source of the S1 contracts live on Robinhood Chain mainnet
(chain 4663) since 2026-09-30, and of the keeper, spare-api and site that operate them.

### Contracts

- The 10 immutable S1 contracts, created in blocks 76221503–76221683 on 2026-09-30:
  `AssetRegistry`, `RuleRegistry`, `ElectionRegistry`, `ScreeningGate`, `StockRouter`,
  `CashPark` with the USDG (live) and SGOV (standby) park adapters, `SweepExecutor` and
  `FeeVault`, with the `RoundUp` and `OracleGuard` libraries. Address book:
  `contracts/addresses/4663.json`. The deployment record, explorer links and the bytecode
  check are in `docs/DEPLOYMENT-4663.md`; all 10 are verified on Sourcify.
- Asset registry: 36 assets registered, 26 active and 10 on standby. On 2026-10-02 the owner
  re-pinned MU to a dynamic-fee pool with a third-party hook (accepted risk A-L3) and moved
  INTC to standby, with `AddAssets.s.sol`.
- Keeper role: moved to a fresh key on 2026-10-02 at 23:31 UTC (blocks 78626507 and
  78626535); the original keeper was revoked at 23:35 UTC (blocks 78628466 and 78628492).
  `VerifyDeployment` against this release's config and address book passed 334 checks with
  0 failures (`contracts/deployments/4663-verify-2026-10-03.txt`); the live roles are in
  `contracts/deployments/4663-roles-2026-10-03.txt`.
- Use so far: up to block 78666930 (2026-10-03), one account had linked a wallet and set a
  rule, four accruals had run, all for 0 USDG, and no sweep had run.
- Owner tooling: `Deploy.s.sol`, `AddAssets.s.sol`, `AcceptOwnership.s.sol`, the read-only
  `VerifyDeployment` (its records are in `contracts/deployments/`) and the governance kit in
  `script/governance/` for moving the owner role to a 2-of-3 Safe behind a 48 h timelock. The
  hand-over is rehearsed on a mainnet fork (`docs/GOVERNANCE.md`) and not yet executed.

### Keeper, engine and API

- The stateless keeper (`bun run keeper`): accrues round-ups and runs quote-limited sweeps;
  every cursor lives on-chain. Every sweep quote is checked against the oracle, an account
  whose leg would move the netted price is swept alone, the assets an isolated sweep bought
  are held until their pools recover, and a hooked pool is used only while its hook matches
  the pins in `engine/src/keeper/hooks.ts`.
- The on-chain monitor (`bun run monitor`) for owner, keeper, pause and hook events. The
  engine API (Hono + tRPC) is a development and test service, not deployed, and its worker
  scaffold has no worker implemented yet.
- spare-api (`server/`): `/health`, the read-only Spare MCP (`/mcp`, `spare_*` tools) and its
  REST mirrors (`/api/spare/*`), with a per-IP read budget and a server-wide `eth_getLogs` cap.

### Site

- The Spare desktop and public pages (`src/`) in English, Simplified and Traditional Chinese,
  including `/proof`: the contracts with live Sourcify verification, who controls them, the
  on-chain limits, live status, the audit and how to run `npm run prove`.

### Verification and tests

- `npm run prove` replays the money path on a local anvil fork of live mainnet against the
  deployed contracts with the real keeper code, and prints PASS or FAIL per check.
- Foundry unit tests with the audit PoCs that need no fork, 10 invariants at 102,400 calls
  each, and nine fork-backed audit suites (`contracts/test/audit`) that run by hand on a
  recent block,
  Halmos specs for `RoundUp` and `OracleGuard` (`contracts/halmos/RESULTS.md`), Gambit
  mutation results (`contracts/mutation/`), and the engine, spare-api and site test suites.
- CI and security workflows in `.github/workflows`. Dependencies are pinned, install scripts
  are off and new releases wait 3 days (`node .github/scripts/check-pins.mjs` checks this).

### Security

An AI-assisted audit graded the pre-release code on 2026-10-02
([report](docs/audits/2026-10-02-ai-audit-grade.md)). Every finding listed here was fixed
before this release; none needed a contract redeploy.

- spare-api serves only Spare's routes. The legacy AI and chain-data routes the audit found
  were removed with their services (B-M2, B-M4, B-M5, B-L1, B-L6, B-L7, B-L8).
- Errors reach clients as one redacted line, behind a final JSON error handler, and
  `NODE_ENV` defaults to production (B-M1). The wallet-replay budget is charged correctly
  (B-L5).
- Engine and keeper: bounded tRPC batches and log scans, the right-most `X-Forwarded-For` for
  rate limits, a per-wallet scan budget and deadline in the keeper, an oracle check on every
  sweep quote, and isolation of an account whose leg would move the netted price (B-M3,
  B-L2, B-L3, B-L4, A-M1).
- The audit's leads: the engine API takes `KEEPER_ADDRESS`, never the keeper's key, and its
  detailed health needs a `HEALTH_TOKEN`; `Deploy.s.sol`, `AddAssets.s.sol` and
  `VerifyDeployment` require an 18-decimal token, a heartbeat of at most 26 h and, for a
  hooked pool, a hook without `*_RETURNS_DELTA` permissions that matches its pins; the engine
  images are pinned by digest and run as an unprivileged user; the local Redis image is
  7.4.11, past CVE-2025-49844.
- A re-check of the remediated code found two more issues in spare-api, both fixed: an
  unbounded wallet replay (B-N1) and `spare_activity` reads that were not bounded per call
  (B-N2) ([notes](docs/audits/2026-10-02-recheck-remediation.md)).
- `drizzle-orm` 0.45.2, the release that fixes GHSA-gpj5-g38j-94v9.
- The accepted risks, and the conditions they hold under, are in `SECURITY.md`: A-L1, A-L2
  (while the SGOV adapter stays on standby), the residual of A-M1, A-L3, the single-EOA
  owner, keeper-attested accrual amounts that are not bound to their start block, price
  protections that only the keeper enforces, and a reverting oracle read that reverts a
  whole sweep call. No third-party human audit has been done.
