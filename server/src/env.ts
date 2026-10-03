import dotenv from 'dotenv';
import { z } from 'zod';

// override: true — the .env file is the source of truth for the backend, so a
// shell that pre-exports a variable (e.g. RHC_RPC_URL="") cannot shadow it.
dotenv.config({ override: true });

const boolEnv = z
  .union([z.string(), z.boolean()])
  .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(v.toLowerCase())));

const optStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());
const optUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optAddr = z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional());
const optNum = z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d+(\.\d+)?$/).optional());

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().default(3001),
  /** Unset = production: Express then never renders its own (stack-bearing) error pages. */
  NODE_ENV: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('production')),
  TEST_MODE: boolEnv.default(false),
  /** Where GET / redirects, and an allowed CORS origin. */
  FRONTEND_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).default('https://trysparerh.com')),

  // Chain — Robinhood Chain (chainId 4663).
  /** Robinhood Chain RPC (e.g. a provider URL). Unset = the public RHC RPC. */
  RHC_RPC_URL: optUrl,
  /** RPC for the Spare engine reads; falls back to RHC_RPC_URL, then the public RHC RPC. */
  SPARE_RPC_URL: optUrl,
  /** Address-book override for the Spare contracts (contracts/addresses/<chain>.json shape). */
  SPARE_ADDRESSES_JSON: optStr,

  // $SPARE token — NOT launched. Leave unset until the CA is published; it is
  // the only input that can switch token reads (holder tiers, holders) on.
  SPARE_TOKEN_ADDRESS: optAddr,
  // Holder tier floors in whole $SPARE (only used once the token is live).
  SPARE_TIER_HOLDER_MIN: optNum,
  SPARE_TIER_WHALE_MIN: optNum,
  SPARE_TIER_OG_MIN: optNum,

  // CORS — extra origins beyond trysparerh.com (comma-separated)
  ALLOWED_ORIGINS: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[ENV] Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;

export type Env = typeof env;
