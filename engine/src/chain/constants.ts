/**
 * Robinhood Chain mainnet (4663) facts, as verified on-chain on 2026-09-29 and
 * recorded in docs/SPARE-BUILD.md §1. These are NOT deployment addresses of
 * SPARE itself (those come from the address book) — they are the chain's own
 * infrastructure, identical on a local anvil fork of mainnet (31337).
 *
 * The tables only say where to read: prices and token state are always read
 * live.
 */
import type { Address } from "viem";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const ARBSYS: Address = "0x0000000000000000000000000000000000000064";
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** USDG — 6 decimals. The settlement currency every SPARE pool pairs against. */
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DECIMALS = 6;
export const STOCK_DECIMALS = 18;
export const FEED_DECIMALS = 8;

/** ERC-20 Transfer(address,address,uint256) topic0. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/**
 * DISPLAY / DEV ONLY — the launch universe's token addresses, for the
 * pre-deployment oracle view, scripts/deploy-local.ts and the fork tests.
 * Nothing functional reads these: the keeper, the routers and the API take the
 * universe from AssetRegistry.tokens() (chain/reads.ts readRegistry), so an
 * asset registered on-chain is swept and shown without touching this file.
 */
export const TOKENS = {
  USDG,
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  QQQ: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  SGOV: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
} as const satisfies Record<string, Address>;

export type Hours = "us_equities_24_5" | "crypto_24_7";

/**
 * Chainlink feed proxies — all 8 decimals, 86400s heartbeat, 0.5% deviation.
 * DISPLAY ONLY for the stock rows (the registry's own feeds win once SPARE is
 * deployed: routers/oracle.ts); USDG / USD and ETH / USD are the reference feeds.
 * Market hours are not read from here: the keeper gates every registry asset
 * on the equity session unless listed in its MARKET_GATE_EXEMPT config.
 */
export const FEEDS: ReadonlyArray<{ label: string; feed: Address; token: Address | null; hours: Hours }> = [
  { label: "SPY / USD", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", token: TOKENS.SPY, hours: "us_equities_24_5" },
  { label: "QQQ / USD", feed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", token: TOKENS.QQQ, hours: "us_equities_24_5" },
  { label: "NVDA / USD", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", token: TOKENS.NVDA, hours: "us_equities_24_5" },
  { label: "AAPL / USD", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", token: TOKENS.AAPL, hours: "us_equities_24_5" },
  { label: "TSLA / USD", feed: "0x4A1166a659A55625345e9515b32adECea5547C38", token: TOKENS.TSLA, hours: "us_equities_24_5" },
  { label: "SGOV / USD", feed: "0xa0DF4ee0fFf975306345875E3548Fcc519577A11", token: TOKENS.SGOV, hours: "us_equities_24_5" },
  { label: "USDG / USD", feed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", token: null, hours: "crypto_24_7" },
  { label: "ETH / USD", feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", token: null, hours: "crypto_24_7" },
];

export const FEED_HEARTBEAT_SECONDS = 86_400;
/** OracleGuard.STALENESS_GRACE (contracts/src/libraries/OracleGuard.sol). */
export const STALENESS_GRACE_SECONDS = 3_600;

/**
 * Uniswap contracts on 4663 (@uniswap/sdk-core CHAIN_TO_ADDRESSES_MAP[4663]).
 * A USDG transfer INTO any of these is a swap or a liquidity action, not a
 * payment (§3.2). v3 pools are separate contracts and are NOT covered by this
 * list — see lib/payments.ts.
 */
export const VENUE = {
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
} as const satisfies Record<string, Address>;

/** ~0.1s blocks. Measured 2026-09-30: 864,000 blocks spanned 86,870s. Estimates only. */
export const APPROX_BLOCKS_PER_DAY = 864_000;
