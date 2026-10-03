/**
 * The Spare API as an Express app (index.ts binds it to a port). It serves
 * exactly the Spare product:
 *
 *   GET  /health                       service + chain health
 *   GET  /api/spare/*                  Spare engine reads (REST mirror of the MCP tools)
 *   GET  /api/spare/token/*            $SPARE status (not launched)
 *   POST /mcp, /api/mcp                Spare MCP (JSON-RPC); GET /api/mcp/tools for the catalog
 *
 * Anything else is a JSON 404. Every error a client sees is JSON with a fixed
 * code: never a stack, an upstream reply or a URL (see redact.ts).
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import mcpRouter, { rpcRouter as mcpRpcRouter } from './routes/mcp.js';
import spareTokenRouter from './routes/spareToken.js';
import spareRouter from './routes/spare.js';
import holdersRouter from './routes/holders.js';
import { env } from './env.js';
import { safeErrorMessage } from './redact.js';
import { SPARE_MCP_SERVER, toolList } from './mcp/server.js';
import { readHealth, type SpareHealth } from './spare/reads.js';
import { getSpareTokenStatus } from './services/spareToken.js';

export const API_VERSION = '3.0.0';

const DEFAULT_ALLOWED_ORIGINS = ['https://trysparerh.com', 'https://www.trysparerh.com'];
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',
  'http://localhost:8080',
  'http://localhost:5847',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5847',
];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** trysparerh.com, FRONTEND_URL, ALLOWED_ORIGINS, plus local dev origins under TEST_MODE. */
export function allowedOrigins(): string[] {
  const envOrigins = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const frontend = originOf(env.FRONTEND_URL);
  return [
    ...new Set([...DEFAULT_ALLOWED_ORIGINS, ...(frontend ? [frontend] : []), ...envOrigins, ...(env.TEST_MODE ? LOCAL_ORIGINS : [])]),
  ];
}

// Chain-side health is read at most every 30 s and never holds /health for
// more than ~2.5 s: a slow or down RPC shows as rpcOk=false, never a 5xx.
let healthCache: { at: number; value: SpareHealth } | null = null;
let healthInflight: Promise<SpareHealth> | null = null;
async function chainHealth(): Promise<SpareHealth | null> {
  if (healthCache && Date.now() - healthCache.at < 30_000) return healthCache.value;
  healthInflight ??= readHealth()
    .then((value) => {
      healthCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      healthInflight = null;
    });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2_500).unref());
  return (await Promise.race([healthInflight, timeout])) ?? healthCache?.value ?? null;
}

/** Fixed codes for the client errors Express and its body parser raise. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

/**
 * Last error handler. A 4xx raised by Express or the body parser keeps its
 * status with a fixed code; anything else is 500 `internal_error`. The detail
 * goes to the log (redacted), never to the client.
 */
export function jsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  const e = (err && typeof err === 'object' ? err : {}) as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = Number(e.status ?? e.statusCode);
  const clientError = Number.isInteger(status) && status >= 400 && status < 500;
  if (!clientError) console.error(`[API] ${req.method} ${req.path}:`, safeErrorMessage(err, 'unhandled error'));
  // Mid-response: let Express drop the connection (nothing more can be sent).
  if (res.headersSent) return next(err);
  if (clientError) {
    return res.status(status).json({ error: e.type === 'entity.parse.failed' ? 'invalid_json' : (CLIENT_ERROR_CODES[status] ?? 'bad_request') });
  }
  return res.status(500).json({ error: 'internal_error' });
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the stack
  app.set('trust proxy', 1); // the proxy in front of us terminates TLS; per-IP limits need the client IP
  // Express decides on its own error pages from this; keep it on the API's default (production).
  app.set('env', env.NODE_ENV);

  const origins = allowedOrigins();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || origins.includes(origin)) return callback(null, true);
        console.warn(`[CORS] Blocked origin: ${origin}`);
        return callback(Object.assign(new Error('Not allowed by CORS'), { status: 403 }));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));

  // Anyone hitting the backend root gets bounced to the actual app.
  app.get('/', (_req, res) => res.redirect(302, env.FRONTEND_URL));

  app.get('/health', async (_req, res) => {
    const chain = await chainHealth().catch(() => null);
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      ok: true,
      service: 'spare-api',
      version: API_VERSION,
      chainId: 4663,
      // A JSON number (block heights are far below 2^53); null when the RPC did not answer.
      block: chain?.block ? Number(chain.block) : null,
      rpcOk: chain?.rpcOk ?? false,
      contractsDeployed: chain?.contractsDeployed ?? null,
      paused: chain?.paused ?? null,
      // label is LIVE only when OracleGuard says OK and the keeper's market-hours gate is open.
      oracles: chain?.oracles ?? [],
      market: chain?.market ?? null,
      mcp: { name: SPARE_MCP_SERVER.name, title: SPARE_MCP_SERVER.title, tools: toolList('spare').length, endpoint: '/mcp' },
      // The keeper's public address comes from the committed address book; the API holds no key.
      keeper: chain?.keeper ?? null,
      token: (({ symbol, launched, address }) => ({ symbol, launched, address }))(getSpareTokenStatus()),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Spare engine (live contracts on Robinhood Chain) ──────────────────────
  app.use('/api/spare/token/holders', holdersRouter);
  app.use('/api/spare/token', spareTokenRouter);
  app.use('/api/spare', spareRouter);

  // ── Spare MCP (JSON-RPC at /mcp and /api/mcp, tool catalog at /api/mcp/tools) ──
  // POST /mcp and POST /api/mcp charge the same per-IP read budget as
  // /api/spare/* (spare/budget.ts), per JSON-RPC message.
  app.use('/mcp', mcpRpcRouter);
  app.use('/api/mcp', mcpRouter);

  // Malformed JSON on the MCP endpoint gets a JSON-RPC parse error, not an HTML page.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' && (req.path.startsWith('/api/mcp') || req.path.startsWith('/mcp'))) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    next(err);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(jsonErrorHandler);
  return app;
}
