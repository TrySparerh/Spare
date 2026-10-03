import { getAddress, isAddress } from "viem";
import { z } from "zod";

/**
 * Engine configuration. Every value has a working local default. The API and
 * its workers never sign: the keeper is its own service (src/keeper/) and holds
 * the only key, so this process takes the keeper's public address, not its key.
 *
 * `parseEnv` is pure (tests feed it a plain object); `env` is the parsed
 * process environment, evaluated once at import.
 */

/** Chains this engine can serve. 31337 is a LOCAL ANVIL FORK of RHC mainnet. */
export const SUPPORTED_CHAIN_IDS = [4663, 31337] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export const DEFAULT_RPC_URL: Record<SupportedChainId, string> = {
  4663: "https://rpc.mainnet.chain.robinhood.com",
  31337: "http://127.0.0.1:8545",
};

export const DEFAULT_DATABASE_URL = "postgres://spare:spare_dev@localhost:5434/spare";
export const DEFAULT_REDIS_URL = "redis://localhost:6381";
export const DEFAULT_CORS_ORIGINS = [
  "https://trysparerh.com",
  "http://localhost:8080",
] as const;

const origin = (v: string) => {
  try {
    const url = new URL(v);
    return ["http:", "https:"].includes(url.protocol) && url.origin === v;
  } catch {
    return false;
  }
};

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(4100),
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgres:// URL")
    .default(DEFAULT_DATABASE_URL),
  REDIS_URL: z
    .string()
    .url()
    .refine((v) => /^rediss?:\/\//.test(v), "REDIS_URL must be a redis:// or rediss:// URL")
    .default(DEFAULT_REDIS_URL),
  CHAIN_ID: z.coerce
    .number()
    .int()
    .refine(
      (v): v is SupportedChainId => (SUPPORTED_CHAIN_IDS as readonly number[]).includes(v),
      `CHAIN_ID must be one of ${SUPPORTED_CHAIN_IDS.join(", ")} (4663 = Robinhood Chain mainnet, 31337 = local anvil fork)`,
    )
    .default(4663),
  RPC_URL: z.string().url().optional(),
  /** Path to the deployment address book, relative to the engine root (or absolute). */
  ADDRESSES_FILE: z.string().min(1).optional(),
  /** Inline address book (JSON). Wins over ADDRESSES_FILE — for hosts that build engine/ alone. */
  ADDRESSES_JSON: z.string().min(2).optional(),
  /**
   * The keeper's address (public): shown by the detailed health check, which
   * also reads whether it is registered on SweepExecutor and CashPark.
   */
  KEEPER_ADDRESS: z
    .string()
    .refine((v) => isAddress(v, { strict: false }), "KEEPER_ADDRESS must be a 0x address")
    .transform((v) => getAddress(v))
    .optional(),
  /** What the keeper service runs with (its own KEEPER_BROADCAST), for the health report only. */
  KEEPER_BROADCAST: z.enum(["0", "1"]).default("0"),
  /**
   * Bearer token for the detailed `health` procedure (database binding,
   * cursors, deployment and keeper registration). Unset, every caller gets
   * the public snapshot only, as from GET /health.
   */
  HEALTH_TOKEN: z.string().min(32, "HEALTH_TOKEN must be at least 32 characters").optional(),
  /** L2 blocks a range must trail the head by. Must match SweepExecutor.finalityBuffer. */
  FINALITY_BUFFER: z.coerce.number().int().min(0).max(10_000_000).default(3000),
  CORS_ORIGINS: z
    .string()
    .refine(
      (v) => {
        const list = v.split(",").map((o) => o.trim()).filter(Boolean);
        return list.length > 0 && list.every(origin);
      },
      "CORS_ORIGINS must be comma-separated http(s) origins (scheme://host[:port], no path)",
    )
    .default(DEFAULT_CORS_ORIGINS.join(",")),
  START_WORKERS: z.enum(["0", "1"]).default("0"),
  /**
   * Max L2 blocks per eth_getLogs call. Every scan is sender-filtered, so the
   * RPC's binding limit is its 10,000-RESULT cap (a chunk over it is split),
   * not the range; the keeper's 2,000,000 keeps a 30-day preview at ~13
   * calls per wallet instead of ~520.
   */
  LOGS_MAX_RANGE: z.coerce.number().int().min(100).max(10_000_000).default(2_000_000),
  /**
   * Upper bound on eth_getLogs calls ONE rule.preview request may make, over
   * all its wallets — every result-cap split and rate-limit retry counted.
   */
  PREVIEW_MAX_CHUNKS: z.coerce.number().int().min(1).max(2_000).default(250),
  /** Upper bound on transfers one rule.preview may hold (RPC logs + DB rows). */
  PREVIEW_MAX_LOGS: z.coerce.number().int().min(100).max(200_000).default(20_000),
  /** Wall-clock allowance for one rule.preview's log scans. */
  PREVIEW_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  /** rule.preview requests running at once, engine-wide; more are refused ("busy"). */
  PREVIEW_MAX_INFLIGHT: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * rule.preview requests one client (its rate-limit key: an IPv4 address or
   * an IPv6 /64) may run at once, inside the engine-wide limit, so one caller
   * cannot hold every slot with slow previews.
   */
  PREVIEW_MAX_INFLIGHT_PER_CLIENT: z.coerce.number().int().min(1).max(16).default(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  RATE_LIMIT_BURST: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Proxies in front of the engine that APPEND to X-Forwarded-For. The rate
   * limiter keys on the entry the outermost of them wrote (the proxy in front of the service = 1);
   * 0 = directly exposed, ignore the header and use the socket address.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  QUEUE_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,64}$/i).optional(),
});

export type RawEnv = Record<string, string | undefined>;

export type Env = Omit<z.infer<typeof EnvSchema>, "CHAIN_ID" | "RPC_URL" | "ADDRESSES_FILE"> & {
  CHAIN_ID: SupportedChainId;
  RPC_URL: string;
  ADDRESSES_FILE: string;
  CORS_ORIGIN_LIST: string[];
  /** Which security-relevant values were supplied rather than defaulted. */
  explicit: { DATABASE_URL: boolean; REDIS_URL: boolean; RPC_URL: boolean };
  /** A KEEPER_PK was present in the environment. It is never read here; its presence is reported. */
  strayKeeperKey: boolean;
};

/** Blank strings are "unset" — the hosting platform's variables and .env files both produce them. */
function clean(raw: RawEnv): RawEnv {
  const out: RawEnv = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const t = v.trim();
    if (t !== "") out[k] = t;
  }
  return out;
}

export function parseEnv(input: RawEnv): Env {
  const raw = clean(input);
  const keys = Object.keys(EnvSchema.shape) as (keyof typeof EnvSchema.shape)[];
  const picked: RawEnv = {};
  for (const k of keys) picked[k] = raw[k];
  const parsed = EnvSchema.parse(picked);
  const chainId = parsed.CHAIN_ID as SupportedChainId;
  return {
    ...parsed,
    CHAIN_ID: chainId,
    RPC_URL: parsed.RPC_URL ?? DEFAULT_RPC_URL[chainId],
    ADDRESSES_FILE: parsed.ADDRESSES_FILE ?? `../contracts/addresses/${chainId}.json`,
    CORS_ORIGIN_LIST: parsed.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    explicit: {
      DATABASE_URL: Boolean(raw.DATABASE_URL),
      REDIS_URL: Boolean(raw.REDIS_URL),
      RPC_URL: Boolean(raw.RPC_URL),
    },
    strayKeeperKey: Boolean(raw.KEEPER_PK),
  };
}

/**
 * A keeper key set on a service that never signs is a key sitting where it is
 * not needed: say so at boot, whatever NODE_ENV. The value is never read.
 */
export function keyWarnings(e: Env): string[] {
  return e.strayKeeperKey
    ? ["[env] KEEPER_PK is set but this service never signs: remove it from this service and set KEEPER_ADDRESS instead."]
    : [];
}

/** True if the Redis URL carries a password (redis://:pass@host …). */
export function redisHasPassword(url: string): boolean {
  try {
    return Boolean(new URL(url).password);
  } catch {
    return false;
  }
}

/**
 * Production guardrails: refuse to boot on dev credentials, refuse a
 * local-fork chain id, refuse a loopback RPC. Returns warnings for softer
 * problems. A no-op outside production.
 */
export function assertProductionConfig(e: Env): string[] {
  if (e.NODE_ENV !== "production") return [];
  if (!e.explicit.DATABASE_URL || e.DATABASE_URL === DEFAULT_DATABASE_URL) {
    throw new Error(
      "[env] DATABASE_URL must be set explicitly in production — refusing to start on the local dev credentials.",
    );
  }
  if (!e.explicit.REDIS_URL) {
    throw new Error("[env] REDIS_URL must be set explicitly in production — refusing the localhost default.");
  }
  if (e.CHAIN_ID === 31337) {
    throw new Error("[env] CHAIN_ID=31337 is a local anvil fork — not a production chain.");
  }
  const warnings: string[] = [];
  if (!redisHasPassword(e.REDIS_URL)) {
    warnings.push("[env] REDIS_URL has no password in production. Redis must run with AUTH and must not be publicly bound.");
  }
  if (!e.explicit.RPC_URL) {
    warnings.push(
      "[env] RPC_URL not set — using the rate-limited public RHC RPC. Point it at a dedicated endpoint for production traffic.",
    );
  }
  return warnings;
}

export const env: Env = parseEnv(process.env);
export const isProduction = env.NODE_ENV === "production";

for (const w of [...keyWarnings(env), ...assertProductionConfig(env)]) console.error(w);
