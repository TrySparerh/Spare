/**
 * The Hono app, separate from the Bun listener so tests can drive it with
 * `app.request(...)` without opening a port.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { trpcServer } from "@hono/trpc-server";
import { env, isProduction } from "./env.ts";
import { appRouter } from "./routers/index.ts";
import { createContext, type Context, type RequestInfo } from "./trpc.ts";
import { healthSnapshot, SERVICE } from "./routers/health.ts";
import { rateLimit, requestClientKey } from "./middleware/rateLimit.ts";

/**
 * Most procedures one /trpc HTTP request may batch. tRPC's own maxBatchSize:
 * a bigger batch is a 400 before any procedure runs (unbounded, one GET could
 * carry ~50 rule.previews).
 */
export const MAX_BATCH_SIZE = 5;

/**
 * Procedures a /trpc request asks for — what the rate limiter charges, so a
 * batch pays per call. A batch (`?batch=1`) names them comma-separated in the
 * path, as tRPC parses it; an oversized one is charged MAX_BATCH_SIZE.
 */
export function trpcCalls(url: string): number {
  const u = new URL(url);
  if (u.searchParams.get("batch") !== "1") return 1;
  let path = u.pathname.replace(/^.*?\/trpc\/?/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return MAX_BATCH_SIZE;
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(1, path.split(",").length));
}

export function corsOrigins(configured: string[], production: boolean): string[] {
  // Production allows only the configured origins; dev adds the local frontends.
  return production
    ? configured
    : [...new Set([...configured, "http://localhost:8080", "http://127.0.0.1:8080", "http://localhost:5173"])];
}

export function createApp(makeContext: (req?: RequestInfo) => Context = createContext) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: corsOrigins(env.CORS_ORIGIN_LIST, isProduction),
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.use("/trpc/*", rateLimit({ cost: (c) => trpcCalls(c.req.url) }));
  app.use("/health", rateLimit());

  // The hosting platform's healthcheck: cheap, always 200 while the process is up; the body
  // reports each dependency's actual state.
  app.get("/health", async (c) => c.json(await healthSnapshot(makeContext(), false)));

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      maxBatchSize: MAX_BATCH_SIZE,
      createContext: (_opts, c) =>
        makeContext({ clientKey: requestClientKey(c), authorization: c.req.header("authorization") ?? null }) as unknown as Record<string, unknown>,
    }),
  );

  app.get("/", (c) =>
    c.json({
      service: SERVICE,
      chainId: env.CHAIN_ID,
      endpoints: ["/health", "/trpc/*"],
      procedures: [
        "health",
        "link.list",
        "rule.get",
        "rule.preview",
        "mix.get",
        "accrual.state",
        "accrual.ledger",
        "sweep.history",
        "sweep.next",
        "park.state",
        "universe.list",
        "oracle.status",
      ],
    }),
  );
  return app;
}
