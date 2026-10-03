import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { env, type SupportedChainId } from "../env.ts";
import { MULTICALL3 } from "./constants.ts";

/** Robinhood Chain mainnet — Arbitrum Nitro L2, ETH gas, ~0.1s blocks. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/**
 * A local anvil FORK of RHC mainnet, re-identified as 31337
 * (`anvil --fork-url <rhc> --chain-id 31337`). The distinct id keeps a local
 * deployment's address book (31337.json) from ever being mistaken for
 * mainnet's (4663.json). Multicall3 exists because the fork inherits it.
 */
export const spareLocal = defineChain({
  id: 31337,
  name: "SPARE Local (anvil fork of RHC)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export const CHAINS: Record<SupportedChainId, Chain> = {
  4663: robinhoodChain,
  31337: spareLocal,
};

export function chainFor(id: SupportedChainId): Chain {
  return CHAINS[id];
}

export function activeChain(): Chain {
  return CHAINS[env.CHAIN_ID];
}

/**
 * Build a public client. JSON-RPC batching folds concurrent reads into one HTTP
 * request — the public RPC is rate-limited, and one request per figure would
 * burn the budget on a single accrual.state call.
 */
export function makePublicClient(chainId: SupportedChainId, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: CHAINS[chainId],
    transport: http(rpcUrl, {
      timeout: 10_000,
      retryCount: 2,
      batch: { batchSize: 50, wait: 5 },
    }),
  }) as PublicClient;
}

let client: PublicClient | undefined;

/** Shared client. Construction never dials the RPC. */
export function getPublicClient(): PublicClient {
  client ??= makePublicClient(env.CHAIN_ID, env.RPC_URL);
  return client;
}

// ---------------------------------------------------------------------------
// Chain-id check: the node must report the id we expect, or no read is trusted.
// ---------------------------------------------------------------------------
export interface ChainState {
  expected: number;
  observed: number | null;
  checked: boolean;
  /** false on a confirmed mismatch or when never reached. */
  healthy: boolean;
}

const state = new WeakMap<PublicClient, { observed: number; at: number }>();

/** Observed chain id for a client, cached for 60s. Throws if the RPC is down. */
export async function observedChainId(c: PublicClient): Promise<number> {
  const hit = state.get(c);
  if (hit && Date.now() - hit.at < 60_000) return hit.observed;
  const observed = await c.getChainId();
  state.set(c, { observed, at: Date.now() });
  return observed;
}

export async function chainState(c: PublicClient, expected: number): Promise<ChainState> {
  try {
    const observed = await observedChainId(c);
    return { expected, observed, checked: true, healthy: observed === expected };
  } catch {
    return { expected, observed: null, checked: false, healthy: false };
  }
}
