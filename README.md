# Spare

Round up every payment and auto-invest the change into tokenized stocks on Robinhood Chain.

Link the wallets you spend from, pick a rule (round each USDG payment up to $1, $5 or $10, at 1x–5x, with a weekly cap) and choose a stock mix. Spare collects the round-ups and, once they pass $5, sweeps them into your mix through Uniswap v4, every fill checked against Chainlink and a same-block quote, and delivers the stock to your own wallet. 26 tokenized stocks and ETFs are active, from SPY and NVDA to TSLA, GOOGL and GLD.

Live at **https://trysparerh.com** · [proof page](https://trysparerh.com/proof) · X [@TrySpareRH](https://x.com/TrySpareRH) · Telegram [t.me/sparerh](https://t.me/sparerh)

## What's built

| Layer | What it is | Where |
|---|---|---|
| Contracts | 10 immutable contracts on Robinhood Chain mainnet: rules and wallet links, round-up accrual and netted sweeps, the park, the Uniswap v4 router with Chainlink bands, the asset registry, mixes, screening and fees. All source-verified on Sourcify. | `contracts/`, addresses in `contracts/addresses/4663.json` |
| Keeper | The operator that accrues round-ups and runs sweeps: quote-limited, oracle-checked, whale-isolated, hook-fee guarded. Stateless; every cursor lives on-chain. | `engine/src/keeper/` |
| Monitor | Watches every privileged event, the hooks' fee controls, balances and keeper liveness. | `engine/src/monitor/` |
| API + MCP | `spare-api`: `/health`, REST reads and an MCP server (`spare_*` tools) for people and AI agents. | `server/` |
| App | The Spare desktop and public pages (Vite + React + wagmi/viem), in English and Chinese. | `src/` |

**How it's checked**

- `npm run prove`: the full money path against live mainnet state, on your machine (below).
- Contracts: 375 unit, fuzz and invariant tests; 10 invariants at 1,600 runs × depth 64; 16/16 Halmos symbolic checks; 99.2% mutation score over 629 mutants ([`contracts/mutation/results/SUMMARY.md`](contracts/mutation/results/SUMMARY.md)).
- Keeper and engine: 463 tests against a fake RPC; spare-api: 249; app: 252.
- `VerifyDeployment` re-checks the live deployment against this repo: 334 checks ([`docs/DEPLOYMENT-4663.md`](docs/DEPLOYMENT-4663.md)).
- An AI-assisted audit graded the code, every finding was fixed or documented, and the fixes were re-checked ([`docs/audits/`](docs/audits)).

## Verify it yourself

One command replays the whole money path against the live deployment, on your machine:

```bash
git clone --recursive https://github.com/TrySparerh/Spare.git spare
cd spare
npm run prove
```

It forks Robinhood Chain mainnet at its current block into a local node and drives the deployed contracts at their real addresses with the real keeper code: real USDG, Permit2, Uniswap v4 pools and hooks, Chainlink feeds and stock tokens. It prints PASS or FAIL for each step:

- **onboarding**: link, rule and Permit2 consent for one user per active stock, one on the default mix and two savers;
- **round-ups**: for every payment, the on-chain `RoundUp.sol`, the keeper's copy and an independent reference agree to the base unit;
- **accrual**: nothing accrues inside the 3,000-block finality buffer; past it, each user is credited exactly their round-ups, with the weekly cap applied on-chain;
- **sweep**: every active stock bought through its pinned pool, inside its oracle band and at or above the keeper's limit, at the 25 bps fee, with a table per stock (a stock the keeper holds back is listed with its reason, which the run re-measures);
- **delivery**: tokens reach each account pro rata;
- **exit**: `CashPark.exit` returns everything still parked.

It needs Node, Bun and Foundry (`scripts/prove.mjs` says what is missing), no wallet, key or money, and never sends anything to mainnet; a run takes three to five minutes. On the local fork only, it makes a throwaway key the keeper, funds test users from a USDG holder, mocks the ArbSys precompile, and outside US-equities hours turns the keeper's market-hours gate off (and says so). Settings, including `PROVE_RPC_URL` and `PROVE_CUPS` for rate-limited RPCs, are documented in `engine/scripts/prove.ts`.

## Repository

| Path | What it is |
|---|---|
| `src/` | The Spare desktop (Vite + React + TypeScript, wagmi + viem) and the public pages |
| `contracts/` | Foundry contracts: RuleRegistry, SweepExecutor, CashPark, StockRouter, AssetRegistry, ElectionRegistry, ScreeningGate, FeeVault, park adapters. Mainnet address book: `contracts/addresses/4663.json` |
| `engine/` | The keeper (`bun run keeper`, deployed): accrues round-ups and runs quote-limited sweeps; stateless, every cursor lives on-chain. The on-chain monitor (`bun run monitor`, deployed). An HTTP API (Hono + tRPC), a Postgres/TimescaleDB schema and a BullMQ worker scaffold with no workers, none of them deployed. What runs where: [`engine/README.md`](engine/README.md) |
| `server/` | `spare-api`: `/health`, the Spare MCP (`/mcp`, `spare_*` tools) and its REST mirrors (`/api/spare/*`) |
| `docs/` | Design and security review (`SPARE-BUILD.md`), roles, governance, deployment, runbook and invariants (below), the MCP (`SPARE_MCP_SETUP.md`, `MCP_TOOLS.md`) and audits (`audits/`) |
| `scripts/` | `npm run prove` (`prove.mjs`, see above), local mainnet-fork tooling (`dev-fork.sh`), icon processing |

Development happened in a private repository; public history starts at this release ([`CHANGELOG.md`](CHANGELOG.md)).

## Chain

Robinhood Chain mainnet (chain id 4663), ETH for gas, USDG (6 decimals) as the settlement currency, Chainlink price feeds, Uniswap v4.

## Develop

Node `24.21.0` (`.nvmrc`; it ships npm `11.19.0`, the `packageManager` pin), Bun `1.3.14` for `engine/`, Foundry `1.5.1` for `contracts/`. npm older than 11.10 still works but warns with `EBADDEVENGINES` (`devEngines` in `package.json` and `server/package.json`), because it ignores the release cooldown below; use npm 11.10+ to add or bump dependencies.

```bash
npm ci && npm run dev               # desktop + pages on http://localhost:8080
npm --prefix server ci && npm --prefix server run dev   # spare-api
cd engine && bun install --frozen-lockfile --ignore-scripts && bun test  # keeper + engine
bash scripts/dev-fork.sh            # full stack on a local anvil fork of mainnet
```

A plain `bun test` skips the live-fork router suite (`engine/test/routers.fork.test.ts`). To run it, `forge build` in `contracts/` first (it deploys those artifacts), then `SPARE_FORK=1 bun test` with anvil installed; it forks `RHC_RPC_URL` (default: the public endpoint).

Dependency install scripts are off: `ignore-scripts` in `.npmrc` and `server/.npmrc`, and `--ignore-scripts` on every `bun install` (Bun would otherwise run the scripts of its default-trusted packages). npm and Bun refuse package releases younger than 3 days (`min-release-age` in both `.npmrc` files, `minimumReleaseAge` in `engine/bunfig.toml`). The engine and spare-api pin exact versions; the site pins through its lockfile. To add or bump a dependency, commit the lockfile with it, and use an exact version in `engine/` and `server/`. `node .github/scripts/check-pins.mjs` checks all of the above.

## Deploy / build from a clone

The contract libraries (forge-std, Uniswap v4-core and v4-periphery) are pinned git submodules, so clone recursively:

```bash
git clone --recursive https://github.com/TrySparerh/Spare.git spare
cd spare/contracts
git submodule update --init --recursive    # only if you cloned without --recursive
forge build
forge test --no-match-path 'test/fork/*'   # unit, 10 invariants, the audit PoCs that need no fork (the CI's contracts job)
```

The audit regressions that need no fork (`test/unit/WeeklyCapBuckets.t.sol`, `NettedWhale.t.sol`, `SgovChurn.t.sol`) run in that suite. The nine suites in `test/audit/` (the sweep and SGOV sandwich PoCs, the hook-control, accrual-bounds, integration and stock-token probes among them) replay mainnet state, so they skip unless `AUDIT_FORK_BLOCK` and `RHC_RPC_URL` are set: neither CI nor a plain `forge test` runs them. Run them by hand on a recent block, as `contracts/README.md` describes.

Fork tests replay real pools, feeds and stock tokens on a local fork at pinned blocks and never broadcast. They read `RHC_RPC_URL` from `contracts/.env` (copy `contracts/.env.example`; it is gitignored). The public endpoint only serves recent state, so use an archive RPC or a warm Foundry cache:

```bash
set -a; . ./.env; set +a
forge test --match-path 'test/fork/*'
```

Check the live deployment against the address book and the config it was built from, from the repo root. `VerifyDeployment` is read-only (it opens no broadcast, so even `--broadcast` sends nothing): it checks code, immutables, roles, keeper, params, pauser, screening, every registry entry and its exact PoolKey and pool, the default mix, the park adapters and ownership, and ends in `VerifyDeployment: PASS` or reverts. The wrapper passes the config in (`fs_permissions` only grants `contracts/addresses`):

```bash
bash scripts/spare-forge.sh VerifyDeployment --rpc-url https://rpc.mainnet.chain.robinhood.com
```

Deploying or changing anything on mainnet needs the owner key and is never done from CI: addresses, explorer links and the build are in [`docs/DEPLOYMENT-4663.md`](docs/DEPLOYMENT-4663.md), the owner's procedures in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

CI in `.github/workflows` runs, on every push and pull request, that build and the non-fork tests, the Halmos specs, the engine, spare-api and site suites (the site's with lint), Slither, Semgrep, a full-history gitleaks scan and the pin check. To run the same checks locally: the commands above, `node --test .github/scripts/check-pins.test.mjs && node .github/scripts/check-pins.mjs`, and for secrets `gitleaks git --config .github/gitleaks.toml --redact .`. Dependency update PRs are configured in `.github/dependabot.yml` (3-day cooldown).

## Fonts

The site loads its open fonts (Press Start 2P, Silkscreen, Jersey 10, Space Mono, Inter, Syne, Geist Mono, Handjet and VT323) from Google Fonts. The brand display font is licensed separately and is not redistributed in this repository: `src/index.css` uses a locally installed copy if there is one, and otherwise the font stacks fall back to the open fonts, so `npm run build` works from a clone.

## Security

- **Immutable contracts**: no proxies and no upgrade path; all 10 are source-verified on Sourcify.
- **Exit is never paused**: `CashPark.exit()` returns everything parked at any time, and delivered stock sits in your own wallet.
- **Bounded fills**: every buy is checked on-chain against the asset's Chainlink band and the executor's slippage backstop; the keeper adds same-block quote limits, whale isolation and pool-versus-oracle holds.
- **Roles**: every privileged function, who holds it and its limits are in [`docs/ROLES.md`](docs/ROLES.md). The owner is a single key today; the hand-over to a 2-of-3 Safe behind a 48-hour timelock is prepared and rehearsed in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).
- **Reporting and accepted risks**: [`SECURITY.md`](SECURITY.md).

More: [`docs/DEPLOYMENT-4663.md`](docs/DEPLOYMENT-4663.md) (deployment, explorer links, verification) · [`docs/INVARIANTS.md`](docs/INVARIANTS.md) · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) · [`docs/audits/`](docs/audits) · [`CHANGELOG.md`](CHANGELOG.md)

Tokenized stocks are not offered to US persons and are restricted in other jurisdictions.
