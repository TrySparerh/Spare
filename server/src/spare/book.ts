/**
 * Spare address book — Robinhood Chain mainnet (4663).
 *
 * Mirrors contracts/addresses/4663.json (the deploy's own output) plus the
 * chain facts verified in docs/SPARE-BUILD.md §1. `book.test.ts` fails if this
 * copy drifts from the deploy file, so a redeploy cannot silently leave the
 * API reading old contracts.
 *
 * Nothing here is a number the API reports: balances, prices, roles and flags
 * are always read live. This table only says WHERE to read.
 *
 * Stock tokens are not in the book: the universe is whatever AssetRegistry
 * holds, read live (assets.ts). symbolOf / resolveAsset name tokens from the
 * last registry read.
 *
 * Override at runtime with SPARE_ADDRESSES_JSON (same shape as the deploy file)
 * — e.g. to point a staging API at a mainnet fork.
 */
import { getAddress, isAddress, type Address } from 'viem';
import { currentAssetDirectory, type AssetDirectory } from './assets.js';

export const SPARE_CHAIN_ID = 4663;
export const SPARE_CHAIN_NAME = 'Robinhood Chain';
export const DEFAULT_SPARE_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export const USDG_DECIMALS = 6;
export const STOCK_DECIMALS = 18;
export const FEED_DECIMALS = 8;
/** $1.00 in USDG base units. */
export const USDG_UNIT = 1_000_000n;

/** ~0.1 s blocks. Measured 2026-09-30: 864,000 blocks spanned 86,870 s. Estimates only. */
export const APPROX_BLOCKS_PER_DAY = 864_000n;
/** eth_getLogs span per call. The public RPC is rate-limited and shared. */
export const LOG_CHUNK_BLOCKS = 50_000n;
/** OracleGuard.STALENESS_GRACE — a feed is stale after heartbeat + this. */
export const STALENESS_GRACE_SECONDS = 3_600;
/** The keeper's QUOTE_TOLERANCE_BPS default (engine/src/keeper/config.ts). */
export const KEEPER_QUOTE_TOLERANCE_BPS = 50;
/** Fund Wallet app fee on the swap output (src/lib/spare-chain/fund-swap.ts FUND_FEE_BPS). */
export const FUND_WALLET_FEE_BPS = 25;

export { MULTICALL3 } from './multicall.js';

export const SPARE_CONTRACT_NAMES = [
  'AssetRegistry',
  'RuleRegistry',
  'ElectionRegistry',
  'ScreeningGate',
  'StockRouter',
  'CashPark',
  'FeeVault',
  'SweepExecutor',
  'UsdgParkAdapter',
  'SgovParkAdapter',
] as const;
export type SpareContractName = (typeof SPARE_CONTRACT_NAMES)[number];

export interface SpareBook {
  chainId: number;
  network: string;
  /** Deploy block — nothing Spare happened before it. */
  startBlock: bigint;
  deployedAt: number;
  contracts: Record<SpareContractName, Address>;
  roles: { owner: Address; keeper: Address; pauser: Address; attestor: Address };
  parkAdapter: { live: SpareContractName; standby: SpareContractName };
  external: { USDG: Address; Permit2: Address; PoolManager: Address };
  screeningEnforced: boolean;
}

/** contracts/addresses/4663.json, verbatim values (its `assets` naming map is not used: the registry is read live). */
export const DEPLOYMENT_4663 = {
  chainId: 4663,
  network: 'robinhood-chain-mainnet',
  deployer: '0x56B67D71039365083727b661Dbe9Bdb7f7D15189',
  startBlock: 76221269,
  deployedAt: 1790741642,
  parkAdapter: { live: 'UsdgParkAdapter', standby: 'SgovParkAdapter' },
  contracts: {
    AssetRegistry: '0x6dA6e49E2c59b622697a208a83bF266D5268c937',
    RuleRegistry: '0x477504Fdd8929fC75Ac6836C2aa131D765e85f78',
    ElectionRegistry: '0x05fB5B11B676BC0Fbf893480b4101fB7C8Db0543',
    ScreeningGate: '0xC3289C38c53055d58009B2fa9499c753b3dBCED3',
    StockRouter: '0x1Fec3654Fea787a63104a6634C9781B837B5e17E',
    CashPark: '0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb',
    FeeVault: '0xF5B9C500998D122fbBB606f23DBEe91Aa5549add',
    SweepExecutor: '0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab',
    UsdgParkAdapter: '0x1E29fD4F78cDfabdE3Df605e66aE3d78a8980DD8',
    SgovParkAdapter: '0x4197a7Eb8e08a35fd55273afA3D0f8Cb3bd98525',
  },
  roles: {
    owner: '0x56B67D71039365083727b661Dbe9Bdb7f7D15189',
    keeper: '0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03',
    pauser: '0x56B67D71039365083727b661Dbe9Bdb7f7D15189',
    attestor: '0x56B67D71039365083727b661Dbe9Bdb7f7D15189',
  },
  external: {
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    Permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  },
  screeningEnforced: false,
} as const;

/**
 * The deploy's activation bar: an asset is turned on only when $5 and $100
 * both fill within 1.2% of Chainlink on a fork (contracts/config/4663.json
 * `_assets_about`). Policy, not a contract value — the contract enforces each
 * asset's bandBps. Used only to explain why a registered asset is on standby.
 */
export const ACTIVATION_BAR_BPS = 120;

/** OracleGuard.Status by value: 0 OK, 1 STALE, 2 PAUSED, 3 SEQUENCER_DOWN, 4 BAD_ANSWER. */
export const ORACLE_STATUS = ['OK', 'STALE', 'PAUSED', 'SEQUENCER_DOWN', 'BAD_ANSWER'] as const;

/** Human label for an OracleGuard status. */
export const ORACLE_LABELS = ['LIVE', 'market closed', 'corporate action', 'sequencer down', 'bad answer'] as const;

/** Chain tokens that are not Spare deployments (docs/SPARE-BUILD.md §1). */
export const WETH: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

/** Uniswap on 4663 (@uniswap/sdk-core CHAIN_TO_ADDRESSES_MAP[4663]). */
export const VENUE = {
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
} as const satisfies Record<string, Address>;

/**
 * Chainlink reference feeds that are not a registry asset's own feed (8
 * decimals, 86400 s heartbeat, 0.5% deviation). Every stock feed comes from
 * AssetRegistry.get(token).feed.
 */
export const REFERENCE_FEEDS = {
  'USDG / USD': '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2',
  'ETH / USD': '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9',
} as const satisfies Record<string, Address>;

type RawBook = Record<string, unknown>;

function addr(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) {
    throw new Error(`Spare address book: ${what} is not an address`);
  }
  return getAddress(v.toLowerCase());
}

/** Parse a deploy address book (contracts/addresses/<chain>.json shape). */
export function parseBook(json: unknown): SpareBook {
  if (!json || typeof json !== 'object') throw new Error('Spare address book is not an object');
  const top = json as RawBook;
  const c = (top.contracts ?? {}) as RawBook;
  const r = (top.roles ?? {}) as RawBook;
  const e = (top.external ?? {}) as RawBook;
  const pa = (top.parkAdapter ?? {}) as RawBook;

  const contracts = {} as Record<SpareContractName, Address>;
  for (const name of SPARE_CONTRACT_NAMES) contracts[name] = addr(c[name], `contracts.${name}`);

  const live = String(pa.live ?? 'UsdgParkAdapter');
  const standby = String(pa.standby ?? 'SgovParkAdapter');
  const isName = (n: string): n is SpareContractName => (SPARE_CONTRACT_NAMES as readonly string[]).includes(n);

  return {
    chainId: Number(top.chainId),
    network: String(top.network ?? ''),
    startBlock: BigInt(String(top.startBlock ?? 0)),
    deployedAt: Number(top.deployedAt ?? 0),
    contracts,
    roles: {
      owner: addr(r.owner, 'roles.owner'),
      keeper: addr(r.keeper, 'roles.keeper'),
      pauser: addr(r.pauser, 'roles.pauser'),
      attestor: addr(r.attestor, 'roles.attestor'),
    },
    parkAdapter: {
      live: isName(live) ? live : 'UsdgParkAdapter',
      standby: isName(standby) ? standby : 'SgovParkAdapter',
    },
    external: {
      USDG: addr(e.USDG, 'external.USDG'),
      Permit2: addr(e.Permit2, 'external.Permit2'),
      PoolManager: addr(e.PoolManager, 'external.PoolManager'),
    },
    screeningEnforced: Boolean(top.screeningEnforced),
  };
}

let cached: SpareBook | null = null;

/** The active address book: SPARE_ADDRESSES_JSON when set, else the mainnet deploy. */
export function getBook(): SpareBook {
  if (cached) return cached;
  const override = process.env.SPARE_ADDRESSES_JSON?.trim();
  const book = override ? parseBook(JSON.parse(override)) : parseBook(DEPLOYMENT_4663);
  if (book.chainId !== SPARE_CHAIN_ID) {
    throw new Error(`Spare address book is for chain ${book.chainId}; the API serves ${SPARE_CHAIN_ID}`);
  }
  cached = book;
  return book;
}

/**
 * Ticker for a token address: USDG and WETH from the book, stock tokens from
 * the registry read (`dir`, default the last one). Null when unknown.
 */
export function symbolOf(token: string, book: SpareBook = getBook(), dir: AssetDirectory | null = currentAssetDirectory()): string | null {
  const t = token.toLowerCase();
  if (t === book.external.USDG.toLowerCase()) return 'USDG';
  if (t === WETH.toLowerCase()) return 'WETH';
  return dir?.byToken.get(t)?.symbol || null;
}

/**
 * Resolve a ticker ("spy", "$SPY") or a token address to a token address.
 * Tickers resolve through the registry read (`dir`); an address passes through
 * (the reads then check it is registered).
 */
export function resolveAsset(input: string, _book: SpareBook = getBook(), dir: AssetDirectory | null = currentAssetDirectory()): Address | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (isAddress(s, { strict: false })) return getAddress(s.toLowerCase());
  return dir?.bySymbol.get(s.toUpperCase().replace(/^\$/, ''))?.token ?? null;
}

export const explorerAddress = (a: string) => `${EXPLORER_URL}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER_URL}/tx/${h}`;
