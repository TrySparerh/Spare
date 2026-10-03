/**
 * Spare MCP — engine tools. Read-only views of the live Spare contracts on
 * Robinhood Chain mainnet (4663). Free: no payment and no MCP key required,
 * because every value is public chain state. None can sign or move funds.
 *
 * The same handlers back the REST mirror at GET /api/spare/<tool>.
 */
import { SPARE_ENGINE_CATEGORY, type ToolDef, type ToolParam } from '../mcp/registry.types.js';
import { previewRoundUp, previewRoundUps } from './roundup.js';
import { readAccount, readActivity, readContracts, readFees, readQuote, readUniverse } from './reads.js';
import { replayRoundUps, MAX_REPLAY_DAYS } from './replay.js';
import { cacheKey, createTtlCache } from './cache.js';
import { pick, REPLAY_WALLET_KEYS } from './args.js';
import { getSpareTokenStatus } from '../services/spareToken.js';

export { SPARE_ENGINE_CATEGORY };

/**
 * Short server-side caches for the scan-heavy reads, shared by MCP, the REST
 * mirror and in-process callers. Identical concurrent calls share one read.
 */
export const SPARE_CACHE_TTL_MS = { universe: 10_000, activity: 10_000, fees: 15_000, replay: 60_000 } as const;
const universeCache = createTtlCache<unknown>(SPARE_CACHE_TTL_MS.universe, 4);
const activityCache = createTtlCache<unknown>(SPARE_CACHE_TTL_MS.activity, 500);
const feesCache = createTtlCache<unknown>(SPARE_CACHE_TTL_MS.fees, 1);
const replayCache = createTtlCache<unknown>(SPARE_CACHE_TTL_MS.replay, 200);

/** Test hook. */
export function clearSpareCaches(): void {
  universeCache.clear();
  activityCache.clear();
  feesCache.clear();
  replayCache.clear();
}

const ADDRESS: ToolParam = {
  name: 'address',
  type: 'string',
  description: 'Spare account address (0x…). A linked spending wallet resolves to the account it feeds. Alias: account.',
  required: true,
};

function tool(
  name: string,
  description: string,
  params: ToolParam[],
  handler: (p: Record<string, unknown>) => Promise<unknown>,
): ToolDef {
  return { name, category: SPARE_ENGINE_CATEGORY, scope: 'read', free: true, description, params, handler };
}

const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v));

/** `amounts` as an array: already an array, a JSON array string, or a comma-separated list. */
function parseAmountList(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to the comma-separated form */
    }
  }
  return s;
}

export const SPARE_ENGINE_TOOLS: ToolDef[] = [
  tool(
    'spare_universe',
    "The stocks and ETFs Spare can buy, read live from the AssetRegistry (never a fixed list — new registrations appear on the next read): each tokenized asset (active, or registered on standby with a reason measured now through its pinned pool), its kind (stock / etf), pinned Uniswap v4 pool, Chainlink price and oracle status, whether the keeper's market-hours gate is open (LIVE only inside the US-equities 24/5 session with a feed update since the open; otherwise 'market closed'), pause flags and UI multiplier, plus the sweep threshold, the conversion fee, the epoch and the default mix.",
    [{ name: 'includeInactive', type: 'boolean', description: 'Include registered-but-inactive assets. Default true.', required: false, default: true }],
    async (p) => {
      const includeInactive = !(p.includeInactive === false || p.includeInactive === 'false' || p.includeInactive === '0');
      return universeCache.get(String(includeInactive), () => readUniverse({ includeInactive }));
    },
  ),
  tool(
    'spare_account',
    "An account's rule (round to $1/$5/$10, 1-5x, weekly cap), linked spending wallets with Permit2 consent, its mix, pending + parked spare change against the $5 sweep threshold, rolling weekly cap (pulled in the last 7 days, room left), whether it was swept this epoch, claimable deliveries, screening status, and its tokenized-stock holdings valued at the Chainlink price. keeperWouldSweepNow and each mix leg's keeperOutcome (buy / wait / hold / defer / safe_settle) with a reason mirror the keeper: market hours, ERC-8056 multiplier changes, and its quote-vs-oracle check on this account's own legs.",
    [ADDRESS],
    async (p) => readAccount(pick(p, 'address', 'account', 'wallet')),
  ),
  tool(
    'spare_roundup_preview',
    `Exact round-ups under a rule, with the same integer math as RoundUp.sol: delta = (step - amount mod step) x multiplier, and 0 when a payment is already on the boundary. Three modes: one amountUsd; a list of amounts (optionally clamped to weeklyCapUsd); or a wallet + days (1..${MAX_REPLAY_DAYS}) to replay that wallet's real outgoing USDG payments from Robinhood Chain under the rule, applying Spare's exclusions (transfers to its own linked wallets or account, to Spare contracts, to swap venues, burns) and the weekly cap over rolling 7 UTC days. Example: $3.75 at round-to $1 gives $0.25 at 1x, $0.75 at 3x.`,
    [
      { name: 'amountUsd', type: 'string', description: 'One payment in USD, up to 6 decimals, e.g. "3.75".', required: false },
      { name: 'amounts', type: 'string', description: 'Several payments: a JSON array or comma-separated list of USD amounts. Use instead of amountUsd.', required: false },
      { name: 'wallet', type: 'string', description: 'Replay this wallet\'s outgoing USDG payments instead of listed amounts (0x address).', required: false },
      { name: 'days', type: 'integer', description: `Wallet mode lookback in days, 1..${MAX_REPLAY_DAYS}. Default 7.`, required: false, default: 7 },
      { name: 'roundTo', type: 'integer', description: 'Round-to boundary in whole dollars: 1, 5 or 10. Default 1.', required: false, default: 1 },
      { name: 'multiplier', type: 'integer', description: 'Turbo multiplier 1..5. Default 1.', required: false, default: 1 },
      { name: 'weeklyCapUsd', type: 'string', description: 'Optional weekly cap in USD to clamp a list of amounts or a wallet replay.', required: false },
    ],
    async (p) => {
      const roundTo = num(pick(p, 'roundTo', 'round_to'), 1);
      const multiplier = num(p.multiplier, 1);
      const weeklyCapUsd = pick(p, 'weeklyCapUsd', 'weekly_cap_usd');
      const wallet = pick(p, ...REPLAY_WALLET_KEYS);
      if (wallet !== undefined) {
        const key = cacheKey([wallet, p.days, roundTo, multiplier, weeklyCapUsd]);
        return replayCache.get(key, () => replayRoundUps({ wallet, days: p.days, roundTo, multiplier, weeklyCapUsd }));
      }
      const amounts = p.amounts;
      if (amounts !== undefined && amounts !== null && amounts !== '') {
        return { mode: 'amounts' as const, ...previewRoundUps(parseAmountList(amounts), roundTo, multiplier, weeklyCapUsd), excluded: [] };
      }
      return { mode: 'single' as const, ...previewRoundUp(pick(p, 'amountUsd', 'amount', 'amount_usd'), roundTo, multiplier) };
    },
  ),
  tool(
    'spare_quote',
    "A live Uniswap v4 Quoter read for converting USDG into a stock through the exact pool the AssetRegistry pins: fee off the top (25 bps), tokens out, fill price vs Chainlink, whether it clears the router's oracle band, the keeper's quote-limited minimum, and what a sweep leg would do right now: buy, wait (oracle not OK, outside the keeper's US-equities 24/5 market-hours gate, or an ERC-8056 multiplier change not yet in the feed), defer (no quote, the keeper's quote-vs-oracle check, or outside the band; keeperOutcome says 'hold' when the keeper holds it) or safe-settle (inactive). Per leg only: a sweep is all-or-nothing per account. Read-only; not an order.",
    [
      { name: 'asset', type: 'string', description: 'A registered ticker (e.g. "SPY"; spare_universe lists them all) or a registry token address.', required: true },
      { name: 'usdgIn', type: 'string', description: 'USDG amount in dollars, before the fee. Default "5" (the sweep threshold). Alias: usdg.', required: false, default: '5' },
    ],
    async (p) => readQuote(pick(p, 'asset', 'symbol'), pick(p, 'usdgIn', 'usdg', 'usdg_in', 'amount')),
  ),
  tool(
    'spare_activity',
    "Spare activity, newest first: round-up collections, credits into the CashPark, sweeps and batch buys, stock deliveries, deferred and safe-settled legs, claims, exits, rule changes, wallet links and mix changes — decoded from SweepExecutor, CashPark, RuleRegistry and ElectionRegistry events over the last N days (max 7), scanned newest-first in chunks of at most 50,000 blocks, at most 24 chunks (~1.4 days) per call. When page.nextBefore is set, pass it as `before` for the next page: the page was full, or the scan stopped before the window start (window.complete false). Give an account for its feed, or omit it for the global feed (which omits account addresses).",
    [
      { name: 'address', type: 'string', description: 'Account (or a linked wallet). Omit for the global feed. Alias: account.', required: false },
      { name: 'days', type: 'integer', description: 'Lookback in days, 1..7. Default 7.', required: false, default: 7 },
      { name: 'limit', type: 'integer', description: 'Max events, 1..100. Default 50.', required: false, default: 50 },
      { name: 'kinds', type: 'string', description: 'Only these kinds, comma-separated (e.g. "accrued,swept,delivered").', required: false },
      { name: 'before', type: 'integer', description: 'Exclusive upper block bound for paging (page.nextBefore).', required: false },
    ],
    async (p) => {
      const q = { address: pick(p, 'address', 'account', 'wallet'), days: p.days, limit: p.limit, kinds: p.kinds, before: p.before };
      return activityCache.get(cacheKey([q.address, q.days, q.limit, q.kinds, q.before]), () => readActivity(q));
    },
  ),
  tool(
    'spare_contracts',
    'Every Spare contract on Robinhood Chain mainnet with its job and a bytecode check, the live roles (owner, pending owner, pauser, keeper, paused) and wiring (CashPark executor and adapter, router caller, screening attestor), any mismatch with the deploy file, plus USDG, Permit2, the Uniswap v4 venue, stock tokens and Chainlink feeds.',
    [],
    async () => readContracts(),
  ),
  tool(
    'spare_fees',
    'Fee rates (conversion fee, its on-chain maximum, the Fund Wallet swap fee), FeeVault balances (USDG, WETH, ETH), and all-time conversion fees and converted volume from AssetSwept events since deploy, with FeeVault withdrawals. Spare has no subscription.',
    [],
    async () => feesCache.get('fees', () => readFees()),
  ),
];

/**
 * $SPARE status. Free and callable by name, listed with ?toolset=all; not
 * one of the seven engine tools the default toolset advertises. The REST
 * mirror is /api/spare/token (routes/spareToken.ts).
 */
export const SPARE_TOKEN_TOOL: ToolDef = {
  name: 'spare_token',
  category: 'Spare Token',
  scope: 'read',
  free: true,
  description:
    'Status of the $SPARE token. It has NOT launched: there is no contract address, price, supply or holder data yet. Only trust a CA announced on trysparerh.com, x.com/TrySpareRH or t.me/sparerh.',
  params: [],
  handler: async () => getSpareTokenStatus(),
};

/** REST slug -> tool (universe, account, roundup-preview, quote, activity, contracts, fees, token). */
export const SPARE_TOOL_BY_SLUG: ReadonlyMap<string, ToolDef> = new Map(
  [...SPARE_ENGINE_TOOLS, SPARE_TOKEN_TOOL].flatMap((t) => {
    const bare = t.name.replace(/^spare_/, '');
    return [
      [bare, t],
      [bare.replace(/_/g, '-'), t],
      [t.name, t],
    ] as Array<[string, ToolDef]>;
  }),
);
