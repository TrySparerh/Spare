/**
 * Frontend configuration — Spare on Robinhood Chain mainnet (4663).
 */

export const CHAIN_ID = 4663;
export const CHAIN_NAME = 'Robinhood Chain';

export const SITE_URL = 'https://trysparerh.com';

// API_BASE is the ROOT URL of the Spare API (spare-api: /health, /api/mcp/tools,
// /mcp and the /api/spare/* tool mirrors), with no trailing /api. Callers
// prefix their routes with /api/... (or /health). If VITE_API_URL is set to a
// .../api URL by mistake, the trailing /api is stripped so the scheme holds.
export const PUBLIC_API_URL = 'https://api.trysparerh.com';
export const API_BASE = (
  import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : PUBLIC_API_URL)
).replace(/\/api\/?$/, '');

/** Spare MCP — Streamable HTTP endpoint for MCP clients. */
export const SPARE_MCP_URL = `${API_BASE}/mcp`;

// Block explorer — Blockscout for Robinhood Chain. Paths: /tx/{hash}, /address/{addr}, /token/{addr}.
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export const X_URL = 'https://x.com/TrySpareRH';
export const TELEGRAM_URL = 'https://t.me/sparerh';

/** $SPARE token address. Empty until the token exists — every CA surface renders "SOON". */
export const SPARE_CA = (import.meta.env.VITE_SPARE_CA ?? '') as string;
