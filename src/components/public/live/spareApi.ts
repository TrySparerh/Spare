/**
 * Read-only access to the Spare API (spare-api) for the public pages:
 * `GET /health` and `GET /api/mcp/tools`.
 *
 * The API may not be deployed, may be cold-starting, or the URL may still
 * answer as some other service. Every read therefore degrades to "offline":
 *   - /health only counts when it says `service: "spare-api"`
 *   - the tool catalog only ever yields the known `spare_*` read-only tools;
 *     any other tool name a server returns is ignored and never rendered
 * Nothing here throws into a page; when the API does not answer, the
 * values are null and the pages show "—".
 */
import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/config';

/** The public Spare API host, as documented in the connect guides. */
export const SPARE_API_PUBLIC_URL = 'https://api.trysparerh.com';
/** Spare MCP — Streamable HTTP endpoint for MCP clients. */
export const SPARE_MCP_ENDPOINT = `${SPARE_API_PUBLIC_URL}/mcp`;

export type SpareToolName =
  | 'spare_universe'
  | 'spare_account'
  | 'spare_roundup_preview'
  | 'spare_quote'
  | 'spare_activity'
  | 'spare_contracts'
  | 'spare_fees';

export interface SpareToolDoc {
  name: SpareToolName;
  /** One line: what the tool answers. */
  blurb: string;
  /**
   * Arguments, as a developer reads them: `name: type`, `name?:` when
   * optional. The names are the ones the server's tool schema declares
   * (server/src/spare/tools.ts); a test keeps the two in step.
   */
  args: string;
}

/** The seven read-only Spare MCP tools. */
export const SPARE_MCP_TOOLS: readonly SpareToolDoc[] = [
  { name: 'spare_universe', blurb: 'The stocks Spare can buy, with live Chainlink prices and oracle status.', args: 'includeInactive?: boolean (default true)' },
  { name: 'spare_account', blurb: "An account's rule, linked wallets, mix, parked spare, cap room and sweep status.", args: 'address: address (an account, or a wallet linked to one)' },
  {
    name: 'spare_roundup_preview',
    blurb: "What a rule would have collected from given payments, or a wallet's last N days.",
    args: 'amountUsd?: string, or amounts?: string (JSON array or comma list), or wallet?: address + days?: 1..30; roundTo?: 1 | 5 | 10, multiplier?: 1..5, weeklyCapUsd?: string',
  },
  { name: 'spare_quote', blurb: 'A live Uniswap v4 quote for converting USDG into a stock, vs Chainlink.', args: 'asset: symbol | address, usdgIn?: string (default "5")' },
  {
    name: 'spare_activity',
    blurb: 'Collections, sweeps, deferrals and exits, for one account or everyone.',
    args: 'address?: address, days?: 1..7, limit?: 1..100, kinds?: string (comma list), before?: block',
  },
  { name: 'spare_contracts', blurb: 'Every Spare address, role and pinned pool.', args: '—' },
  { name: 'spare_fees', blurb: 'Fee rates, FeeVault balances and all-time conversion fees.', args: '—' },
];

const KNOWN = new Set<string>(SPARE_MCP_TOOLS.map((t) => t.name));

export interface SpareApiHealth {
  version: string | null;
  block: number | null;
  mcpTools: number | null;
}

export interface SpareApiStatus {
  /** /health answered as the Spare API. */
  online: boolean;
  health: SpareApiHealth | null;
  /** Known Spare tools present in the live catalog (null when the catalog did not answer as Spare). */
  liveTools: ReadonlySet<SpareToolName> | null;
  /** Spare tools the API reports, or null when unknown. */
  toolCount: number | null;
}

const TIMEOUT_MS = 12_000;

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Accepts only a Spare API health document. Anything else is "not the Spare API". */
export function parseSpareHealth(j: unknown): SpareApiHealth | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.service !== 'spare-api') return null;
  const mcp = o.mcp && typeof o.mcp === 'object' ? (o.mcp as Record<string, unknown>) : null;
  return {
    version: typeof o.version === 'string' ? o.version : null,
    block: num(o.block),
    mcpTools: mcp ? num(mcp.tools) : null,
  };
}

/** Names of the known Spare tools in a catalog (array, or `{ tools: [...] }`). Other names are dropped. */
export function parseSpareCatalog(j: unknown): Set<SpareToolName> | null {
  const list = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { tools?: unknown }).tools) ? (j as { tools: unknown[] }).tools : null;
  if (!list) return null;
  const out = new Set<SpareToolName>();
  for (const t of list) {
    const name = t && typeof t === 'object' ? (t as { name?: unknown }).name : null;
    if (typeof name === 'string' && KNOWN.has(name)) out.add(name as SpareToolName);
  }
  return out.size ? out : null;
}

export async function readSpareApi(signal?: AbortSignal): Promise<SpareApiStatus> {
  const [h, c] = await Promise.all([getJson('/health', signal), getJson('/api/mcp/tools?toolset=spare', signal)]);
  const health = parseSpareHealth(h);
  const liveTools = health ? parseSpareCatalog(c) : null;
  return {
    online: !!health,
    health,
    liveTools,
    toolCount: liveTools ? liveTools.size : health?.mcpTools ?? null,
  };
}

/** Spare API status, re-checked every minute. `status` is null while the first check runs. */
export function useSpareApi(): { status: SpareApiStatus | null; checking: boolean } {
  const q = useQuery({
    queryKey: ['spare-public', 'api-status', API_BASE],
    queryFn: ({ signal }) => readSpareApi(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  return { status: q.data ?? null, checking: q.isPending };
}
