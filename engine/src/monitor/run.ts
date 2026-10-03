/**
 * Monitor entrypoint: `bun run src/monitor/run.ts` from engine/.
 *
 *   (default)  poll every POLL_MS forever; /health on PORT for the hosting platform.
 *   --once     catch up from START_BLOCK (or head - LOOKBACK_BLOCKS) to head,
 *              run every check once, print a summary and exit. Read-only, so
 *              it is safe against mainnet: e.g.
 *              START_BLOCK=77700000 bun run src/monitor/run.ts --once
 *   --test-alert  send one alert (critical, so every severity floor passes
 *              it) to each configured sink and exit non-zero if a sink did
 *              not take it: proves the routing before an incident does.
 *
 * Keyless: the monitor never loads KEEPER_PK or any other private key.
 */
import { createPublicClient, defineChain, http, type PublicClient, type Transport } from "viem";
import { MULTICALL3 } from "../chain/constants.ts";
import { errorSummary, redact } from "./alerts.ts";
import { loadMonitorBook, loadMonitorConfig } from "./config.ts";
import { ChainMismatchError, Monitor, monitorSecrets } from "./monitor.ts";
import { Dispatcher, telegramSink, webhookSink, type Sink } from "./sinks.ts";

/**
 * Start the monitor on `env` in the mode `argv` names. Run as the entrypoint
 * it starts on the process env and argv over HTTP; the tests pass their own,
 * and a fake-chain transport. Resolves once the loop (and /health) is up; the
 * --once and --test-alert modes exit the process when done.
 */
export async function startMonitor(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv, transport?: Transport) {
  const once = argv.includes("--once");
  const cfg = loadMonitorConfig(env);
  const book = loadMonitorBook(cfg);
  const secrets = monitorSecrets(cfg);

  const chain = defineChain({
    id: cfg.CHAIN_ID,
    name: cfg.CHAIN_ID === 4663 ? "Robinhood Chain" : `chain ${cfg.CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.RPC_URL] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const client = createPublicClient({
    chain,
    transport: transport ?? http(cfg.RPC_URL, { timeout: 20_000, retryCount: 2, batch: { batchSize: 50, wait: 10 } }),
  }) as PublicClient;

  const sinks: Sink[] = [];
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
    sinks.push(telegramSink(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID, { minSeverity: cfg.TELEGRAM_MIN_SEVERITY }));
  }
  if (cfg.ALERT_WEBHOOK_URL) sinks.push(webhookSink(cfg.ALERT_WEBHOOK_URL, { minSeverity: cfg.WEBHOOK_MIN_SEVERITY }));
  const dispatcher = new Dispatcher({
    sinks,
    maxPerMinute: cfg.SINK_MAX_PER_MINUTE,
    secrets,
    explorer: cfg.EXPLORER_URL,
    header: `Spare monitor (chain ${cfg.CHAIN_ID})`,
  });
  const monitor = new Monitor({ cfg, book, client, dispatcher });

  if (argv.includes("--test-alert")) {
    if (!sinks.length) throw new Error("no sink configured: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and/or ALERT_WEBHOOK_URL");
    await dispatcher.dispatch([
      { key: "test", name: "test", severity: "critical", title: "test alert: routing works", lines: ["sent by `bun run src/monitor/run.ts --test-alert`"], push: true },
    ]);
    for (let i = 0; i < 2 && Object.values(dispatcher.pending()).some((n) => n > 0); i++) await dispatcher.flush();
    const failed = sinks.map((s) => s.name).filter((n) => (dispatcher.pending()[n] ?? 0) > 0 || (dispatcher.lost.get(n) ?? 0) > 0);
    if (failed.length) throw new Error(`not delivered to: ${failed.join(", ")} (see the error lines above)`);
    dispatcher.log("info", "test alert delivered", { sinks: sinks.map((s) => s.name) });
    process.exit(0);
    return { monitor, dispatcher, server: undefined };
  }

  dispatcher.log("info", "monitor starting", {
    chainId: cfg.CHAIN_ID,
    mode: once ? "once" : "loop",
    rpc: cfg.RPC_URL === "https://rpc.mainnet.chain.robinhood.com" ? "public RHC RPC" : "custom RPC_URL",
    contracts: [...monitor.contracts, ...monitor.hooks].map((w) => `${w.name} ${w.address}`),
    roles: book.roles,
    sinks: sinks.map((s) => `${s.name} (>= ${s.minSeverity ?? "info"})`),
    keeperHealth: Boolean(cfg.KEEPER_HEALTH_URL),
    stateFile: Boolean(cfg.STATE_FILE),
  });

  // The chain id must match before anything is trusted. RPC trouble at boot is
  // not fatal in loop mode: poll() retries init, and a sustained outage raises
  // rpc.down like any other.
  try {
    await monitor.init();
  } catch (err) {
    const msg = redact(errorSummary(err), secrets);
    if (err instanceof ChainMismatchError || once) throw new Error(msg);
    dispatcher.log("warn", "init failed; poll will retry it", { error: msg });
  }

  if (once) {
    const counts: Record<string, number> = {};
    let rounds = 0;
    for (;;) {
      const r = await monitor.poll();
      rounds++;
      for (const a of r.alerts) counts[`${a.severity} ${a.name}`] = (counts[`${a.severity} ${a.name}`] ?? 0) + 1;
      if (r.error) throw new Error(`poll failed at cursor ${r.cursor}: ${r.error}`);
      // The poll that brings both the cursor and discovery to head also ran liveness.
      if (r.caughtUp && monitor.discoveryComplete) break;
    }
    dispatcher.log("info", "once: done", { polls: rounds, alerts: counts, health: monitor.health() });
    process.exit(0);
    return { monitor, dispatcher, server: undefined };
  }

  const server = cfg.PORT
    ? Bun.serve({
        port: cfg.PORT,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/health" || url.pathname === "/") {
            const h = monitor.health();
            // 200 by default so a deploy healthcheck passes while catching up; ?strict=1 for external probes.
            return Response.json(h, { status: url.searchParams.get("strict") === "1" && !h.ok ? 503 : 200 });
          }
          return new Response("not found", { status: 404 });
        },
      })
    : undefined;
  if (server) dispatcher.log("info", `health on :${cfg.PORT}/health`);

  let stopping = false;
  let busy = false;
  async function loop() {
    if (stopping) return;
    busy = true;
    let behind = false;
    try {
      const r = await monitor.poll();
      // Still catching up (scan or linked-wallet discovery) with a healthy RPC: go again now.
      behind = (!r.caughtUp || !monitor.discoveryComplete) && r.error === null;
    } catch (err) {
      dispatcher.log("error", "poll crashed", { error: redact(errorSummary(err), secrets) });
    } finally {
      busy = false;
    }
    if (!stopping) setTimeout(loop, behind ? 0 : cfg.POLL_MS);
  }
  void loop();

  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    dispatcher.log("info", `${signal}: finishing the poll in flight`);
    const t0 = Date.now();
    while (busy && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200));
    await dispatcher.flush();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => dispatcher.log("warn", "unhandled rejection", { error: redact(errorSummary(err), secrets) }));

  return { monitor, dispatcher, server };
}

if (import.meta.main) await startMonitor();
