# Spare engine

Bun + TypeScript + viem. This package holds the two services that run Spare's off-chain side
in production, the keeper and the monitor, and an HTTP API with a database schema and a worker
scaffold that are not deployed. The design they implement is
[`docs/SPARE-BUILD.md`](../docs/SPARE-BUILD.md) (§5 and §8).

## What runs in production

| Part | Entry point | Deployed | What it does |
|---|---|---|---|
| Keeper | `bun run keeper` (`src/keeper/run.ts`) | **Yes.** Its own service, built from `Dockerfile.keeper` | Accrues round-ups (`accrueBatch`) and sends quote-limited sweeps (`sweep`). Holds the only hot key (`KEEPER_PK`). Every cursor is on-chain, so it keeps no database. |
| Monitor | `bun run monitor` (`src/monitor/run.ts`) | **Yes.** Its own service, same image, start command `bun run src/monitor/run.ts` | Reads owner, keeper, pause, registry and hook events and on-chain state, and alerts ([`docs/RUNBOOK.md`](../docs/RUNBOOK.md) §1). Holds no key. |
| HTTP API | `bun run dev`, `bun run start` (`src/index.ts`) | **No** | Read-only Hono + tRPC procedures (`link`, `rule` with `preview`, `mix`, `accrual`, `sweep`, `park`, `oracle`, `universe`, `health`). Nothing calls it in production: the site reads the chain directly and through spare-api (`server/`). `Dockerfile` builds it, but no service runs it. |
| Workers | `bun run workers` (`src/workers/index.ts`) | **No** | A BullMQ (Redis) scaffold for seven planned workers. None is implemented: `src/workers/registry.ts` is empty, and the process exits at start. |
| Database | `bun run db:migrate` (`src/db/migrate.ts`, `drizzle/`) | **No** | Drizzle schema for Postgres, with TimescaleDB hypertables when the extension is there (`src/db/schema.ts`). Nothing at runtime writes the event and payment tables; only tests do. |

The HTTP API, the workers and the database are kept as the base for the next release. They
are not part of the running system, and nothing in production depends on them.

The other production services are outside this package: spare-api (`server/`: `/health`, the
Spare MCP and its REST mirrors) and the site (`src/`).

## Layout

| Path | Used by |
|---|---|
| `src/keeper/` | keeper (its config is `src/keeper/config.ts`) |
| `src/monitor/` | monitor (its config is `src/monitor/config.ts`; it reuses the keeper's address-book parser, hook pins, Multicall3 helper and consent and session checks) |
| `src/chain/abis.ts`, `constants.ts`, `logs.ts` | keeper, monitor and API |
| `src/lib/roundup.ts`, `payments.ts` | keeper and API |
| the rest of `src/chain/`, `src/lib/`; `src/routers/`, `src/middleware/`, `app.ts`, `index.ts`, `trpc.ts`, `env.ts` | API |
| `src/db/`, `drizzle/` | API and workers |
| `src/workers/`, `src/redis.ts` | workers (the API's `sweep.next` also reads the queue schedule) |
| `scripts/prove.ts` | `npm run prove` at the repository root |
| `scripts/keeper-e2e.ts`, `deploy-local.ts`, `sync-abis.ts` | local fork runs and the ABI sync from `contracts/out` |

`src/env.ts` is the API's configuration and requires its database settings at import, so
neither the keeper nor the monitor imports it.

## Run

```bash
bun install --frozen-lockfile --ignore-scripts
bunx tsc --noEmit
bun test                  # keeper, monitor and API suites
```

A plain `bun test` skips the live-fork router suite (`test/routers.fork.test.ts`): it needs
`SPARE_FORK=1`, anvil and the contracts built with `forge build`.

- **Keeper:** `bun run keeper` with `KEEPER_PK`, `ADDRESSES_JSON` (or `ADDRESSES_FILE`),
  `RPC_URL`, `CHAIN_ID` and `KEEPER_BROADCAST=1`; without `KEEPER_BROADCAST=1` it only
  simulates. Every setting and its default is in `src/keeper/config.ts`; the ones that
  matter in production are listed in `docs/SPARE-BUILD.md` §8.
- **Monitor:** `bun run monitor`, or `bun run src/monitor/run.ts --once` for a single
  read-only pass. Settings: `src/monitor/config.ts` and `docs/RUNBOOK.md` §1.3.
- **HTTP API (development):** `docker compose -f ../infra/docker-compose.yml up -d` for
  Postgres/TimescaleDB and Redis, then `bun run db:migrate` and `bun run dev`. Settings are
  in `.env.example`. The API never signs: it takes the keeper's address as
  `KEEPER_ADDRESS`, ignores a `KEEPER_PK` and warns at boot if one is set, and shows its
  detailed tRPC `health` only to an `Authorization: Bearer <HEALTH_TOKEN>` caller.
