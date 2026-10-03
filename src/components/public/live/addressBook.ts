/**
 * Every address the public developer pages show, in one place.
 *
 * Spare's own contracts and roles come from the deployment record
 * (`contracts/addresses/4663.json`, also the source of
 * `src/lib/spare-chain/deployment.4663.json`). External contracts and the
 * two reference Chainlink feeds (USDG / USD, ETH / USD) are the canonical
 * Robinhood Chain addresses Spare builds on.
 *
 * Stock tokens and their feeds are NOT listed here: they are whatever
 * AssetRegistry holds, read live (lib/spare-chain/universe.ts) and turned
 * into rows with stockFeedEntries().
 */
import { getAddress, type Address } from 'viem';
import deployment4663 from '../../../../contracts/addresses/4663.json';
import { EXPLORER_URL, SPARE } from '@/lib/spare-chain/addresses';

/** The deployment record, byte for byte, for the "Download 4663.json" link. */
export const DEPLOYMENT_RECORD: unknown = deployment4663;

export const RHC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const DEPLOY_BLOCK = 76_221_269;
export const DEPLOYED_AT_LABEL = '30 Sep 2026, 04:14 UTC';

export interface BookEntry {
  name: string;
  address: Address;
  role: string;
}

type SpareName = keyof typeof SPARE;

const CONTRACT_ROLES: [SpareName, string][] = [
  ['SweepExecutor', 'collects round-ups, runs sweeps, charges the fee'],
  ['CashPark', 'holds parked spare; exit'],
  ['RuleRegistry', 'linked wallets and round-up rules'],
  ['ElectionRegistry', 'stock mixes'],
  ['AssetRegistry', 'stock universe, feeds, pinned pools'],
  ['StockRouter', 'swaps through pinned v4 pools with oracle checks'],
  ['FeeVault', 'collects fees'],
  ['ScreeningGate', 'eligibility gate (off)'],
  ['UsdgParkAdapter', 'live park: USDG, no yield'],
  ['SgovParkAdapter', 'standby park: SGOV'],
];

/** The ten Spare contracts, in the order the docs list them. */
export const SPARE_CONTRACTS: readonly BookEntry[] = CONTRACT_ROLES.map(([name, role]) => ({ name, address: SPARE[name], role }));

const roles = (deployment4663 as { roles: Record<'owner' | 'keeper' | 'pauser' | 'attestor', string> }).roles;

export const OWNER: Address = getAddress(roles.owner);
export const KEEPER: Address = getAddress(roles.keeper);
export const PAUSER: Address = getAddress(roles.pauser);
export const ATTESTOR: Address = getAddress(roles.attestor);

export const ROLES: readonly BookEntry[] = [
  { name: 'Owner', address: OWNER, role: 'admin: fees within the 1% ceiling, pool pins, feeds, stock activation, keeper, CashPark executor' },
  { name: 'Pauser', address: PAUSER, role: 'can pause collections and sweeps (never exits)' },
  { name: 'Attestor', address: ATTESTOR, role: 'signs eligibility clearances for ScreeningGate (enforcement off)' },
  { name: 'Keeper', address: KEEPER, role: "Spare's automated operator: collects round-ups and runs sweeps" },
];

export const USDG: Address = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
export const PERMIT2: Address = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');
export const POOL_MANAGER: Address = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
export const V4_QUOTER_ADDR: Address = getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94');
export const UNIVERSAL_ROUTER_ADDR: Address = getAddress('0x8876789976decbfcbbbe364623c63652db8c0904');
export const WETH_ADDR: Address = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
export const MULTICALL3: Address = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11');
export const STATE_VIEW: Address = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
export const ENTRY_POINT_V07: Address = getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
export const STOCK_TOKEN_BEACON: Address = getAddress('0xe10b6f6b275de231345c20d14ab812db62151b00');

/** External contracts DevTools lists. */
export const EXTERNAL_CONTRACTS: readonly BookEntry[] = [
  { name: 'USDG', address: USDG, role: 'Global Dollar, 6 decimals: what you pay with and what Spare parks' },
  { name: 'Permit2', address: PERMIT2, role: 'the allowance the keeper pulls round-ups through: no amount limit, expires after one year; your weekly cap bounds each pull' },
  { name: 'Uniswap v4 PoolManager', address: POOL_MANAGER, role: 'holds every v4 pool Spare trades through' },
  { name: 'Uniswap V4Quoter', address: V4_QUOTER_ADDR, role: 'same-block quotes that set each sweep limit' },
  { name: 'Uniswap Universal Router', address: UNIVERSAL_ROUTER_ADDR, role: 'Fund Wallet ETH ↔ USDG swaps' },
  { name: 'WETH', address: WETH_ADDR, role: 'wrapped ETH (Fund Wallet USDG → ETH fees)' },
  { name: 'Multicall3', address: MULTICALL3, role: 'batched reads' },
];

/** Infrastructure the Data Layer checks for bytecode. */
export const INFRA_CONTRACTS: readonly BookEntry[] = [
  { name: 'Uniswap v4 PoolManager', address: POOL_MANAGER, role: 'v4 pools' },
  { name: 'Uniswap V4Quoter', address: V4_QUOTER_ADDR, role: 'quotes' },
  { name: 'Uniswap StateView', address: STATE_VIEW, role: 'pool state reads' },
  { name: 'Uniswap Universal Router', address: UNIVERSAL_ROUTER_ADDR, role: 'Fund Wallet swaps' },
  { name: 'Permit2', address: PERMIT2, role: 'allowances' },
  { name: 'Multicall3', address: MULTICALL3, role: 'batched reads' },
  { name: 'EntryPoint v0.7', address: ENTRY_POINT_V07, role: 'account abstraction (S4)' },
];

export interface FeedEntry {
  pair: string;
  /** Stock symbol when this is a stock feed. */
  symbol: string | null;
  proxy: Address;
  hours: 'US equities 24/5' | 'crypto 24/7';
}

/**
 * The reference Chainlink feeds Spare reads that are not a registry asset's
 * own feed (8 decimals, 24-hour heartbeat, 0.5% deviation).
 */
export const REFERENCE_FEEDS: readonly FeedEntry[] = [
  { pair: 'USDG / USD', symbol: null, proxy: getAddress('0x61B7e5650328764B076A108EFF5fa7282a1B9aD2'), hours: 'crypto 24/7' },
  { pair: 'ETH / USD', symbol: null, proxy: getAddress('0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9'), hours: 'crypto 24/7' },
];

/**
 * One feed row per registry asset (from the live AssetRegistry read), then
 * the reference feeds. Stock feeds follow the US-equities 24/5 session, which
 * is also what the keeper's market-hours gate assumes for every registry asset.
 */
export function stockFeedEntries(assets: readonly { symbol: string; feed: Address | null }[]): FeedEntry[] {
  const seen = new Set<string>();
  const rows: FeedEntry[] = [];
  for (const a of assets) {
    if (!a.feed || seen.has(a.feed.toLowerCase())) continue;
    seen.add(a.feed.toLowerCase());
    rows.push({ pair: `${a.symbol} / USD`, symbol: a.symbol, proxy: getAddress(a.feed), hours: 'US equities 24/5' });
  }
  return [...rows, ...REFERENCE_FEEDS.filter((f) => !seen.has(f.proxy.toLowerCase()))];
}

export const FEED_DECIMALS = 8;
export const FEED_HEARTBEAT_SEC = 86_400;

export const explorerAddress = (a: string) => `${EXPLORER_URL}/address/${a}`;
export const explorerToken = (a: string) => `${EXPLORER_URL}/token/${a}`;
