/**
 * Keeper entrypoint: `bun run keeper`.
 *
 * Two timers (accrue every ACCRUE_EVERY_MS, sweep every SWEEP_EVERY_MS) over
 * one serialised Keeper, plus an optional /health endpoint on HOST:PORT
 * (dual-stack "::" by default, so the IPv6 private network reaches it).
 *
 * Single writer: the first tick waits STARTUP_DELAY_MS (the health endpoint is
 * up immediately, so a deploy healthcheck passes) and SIGTERM / SIGINT stop new
 * ticks and drain the one in flight, so an overlapping old and new deployment
 * do not both accrue the same window.
 */
import { formatEther, type Transport } from "viem";
import { loadBook, loadConfig } from "./config.ts";
import { healthResponse } from "./health.ts";
import { Keeper } from "./keeper.ts";

/**
 * Start the keeper on `env`. Run as the entrypoint it starts on the process
 * env over HTTP; the unit tests pass their own env and a fake-chain transport.
 */
export async function startKeeper(env: Record<string, string | undefined> = process.env, transport?: Transport) {
  const cfg = loadConfig(env);
  const book = loadBook(cfg);
  const keeper = new Keeper(cfg, book, transport);
  const started = Date.now();
  let stopping = false;
  let loopsStarted = false;

  const code = await keeper.client.getCode({ address: book.sweepExecutor });
  if (!code || code === "0x") throw new Error(`no SweepExecutor bytecode at ${book.sweepExecutor} on chain ${cfg.CHAIN_ID}`);
  const chainId = await keeper.client.getChainId();
  if (chainId !== cfg.CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${cfg.CHAIN_ID}`);

  console.log(
    `[keeper] chain ${cfg.CHAIN_ID}; keeper ${keeper.account.address}; executor ${book.sweepExecutor}; broadcast ${
      cfg.KEEPER_BROADCAST === "1" ? "ON" : "off (simulate only)"
    }; eth ${formatEther(await keeper.ethBalance())}`,
  );

  const server = cfg.PORT
    ? Bun.serve({
        hostname: cfg.HOST,
        port: cfg.PORT,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/health" || url.pathname === "/") {
            const h = keeper.health();
            // HTTP 200 by default: the deploy healthcheck must not fail a deploy
            // over low gas. External monitors use ?strict=1 to get a 503. Public
            // callers get { ok } only; the detail needs HEALTH_TOKEN (health.ts).
            return healthResponse(req, {
              ok: h.ok && !stopping,
              token: cfg.HEALTH_TOKEN,
              // Public: no address, gas or reasons — only whether the loop runs and when it last ticked.
              liveness: () => ({
                started: loopsStarted,
                uptimeSec: Math.round((Date.now() - started) / 1000),
                recent: keeper.history.slice(0, 1).map((t) => ({ at: t.at })),
              }),
              detail: () => ({
                ...h,
                reasons: stopping ? [...h.reasons, "shutting down"] : h.reasons,
                started: loopsStarted,
                chainId: cfg.CHAIN_ID,
                keeper: keeper.account.address,
                executor: book.sweepExecutor,
                broadcast: cfg.KEEPER_BROADCAST === "1",
                accounts: keeper.accounts.size,
                uptimeSec: Math.round((Date.now() - started) / 1000),
                recent: keeper.history.slice(0, 20),
              }),
            });
          }
          return new Response("not found", { status: 404 });
        },
      })
    : undefined;
  if (server) console.log(`[keeper] health on ${cfg.HOST.includes(":") ? `[${cfg.HOST}]` : cfg.HOST}:${cfg.PORT}/health`);

  async function accrueLoop() {
    if (stopping) return;
    await keeper.run("accrue");
    if (!stopping) setTimeout(accrueLoop, cfg.ACCRUE_EVERY_MS);
  }
  async function sweepLoop() {
    if (stopping) return;
    await keeper.run("sweep");
    if (!stopping) setTimeout(sweepLoop, cfg.SWEEP_EVERY_MS);
  }

  if (cfg.STARTUP_DELAY_MS > 0) console.log(`[keeper] first tick in ${Math.round(cfg.STARTUP_DELAY_MS / 1000)}s`);
  setTimeout(() => {
    if (stopping) return;
    loopsStarted = true;
    void accrueLoop();
    setTimeout(sweepLoop, 15_000);
  }, cfg.STARTUP_DELAY_MS);

  async function checkGas() {
    try {
      const bal = await keeper.ethBalance();
      if (bal < cfg.LOW_GAS_WEI) console.warn(`[keeper] LOW GAS: ${formatEther(bal)} ETH on ${keeper.account.address}`);
    } catch {}
  }
  setInterval(checkGas, 300_000);

  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`[keeper] ${signal}: no new ticks; draining the one in flight`);
    await keeper.stop(120_000);
    console.log("[keeper] drained; exiting");
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => console.warn("[keeper] unhandled rejection:", (err as Error)?.message ?? err));

  return { keeper, server };
}

if (import.meta.main) await startKeeper();
