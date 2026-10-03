/**
 * Read-only viem client for Robinhood Chain mainnet, used by the Spare engine
 * reads. RPC: SPARE_RPC_URL, else the server's chain RPC (RHC_RPC_URL), else
 * the public RHC endpoint. The URL may
 * embed a provider key, so it is never logged or returned.
 */
import { createPublicClient, defineChain, http, type EIP1193RequestFn, type PublicClient, type Transport } from 'viem';
import { DEFAULT_SPARE_RPC_URL, MULTICALL3, SPARE_CHAIN_ID, SPARE_CHAIN_NAME, EXPLORER_URL } from './book.js';
import { createTokenBucket, type TokenBucket } from './budget.js';

export const spareChain = defineChain({
  id: SPARE_CHAIN_ID,
  name: SPARE_CHAIN_NAME,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_SPARE_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER_URL } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export function spareRpcUrl(): string {
  const pick = (v: string | undefined) => (v && /^https?:\/\//.test(v.trim()) ? v.trim() : undefined);
  return pick(process.env.SPARE_RPC_URL) ?? pick(process.env.RHC_RPC_URL) ?? DEFAULT_SPARE_RPC_URL;
}

/**
 * Process-wide cap on the eth_getLogs this server sends upstream, whoever
 * asked. The per-IP read budget (budget.ts) bounds one client; this bounds
 * all of them together, so many clients at once cannot push the shared RPC
 * past its rate limit. Over the cap a read fails at once with RpcBusyError
 * (HTTP 503 `rpc_busy` + Retry-After) instead of queueing behind the others.
 */
export const GETLOGS_PER_SECOND = 20;
/** Burst: one whole wallet replay (40 log reads) with room to spare. */
export const GETLOGS_BURST = 60;

export class RpcBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`RPC busy: log reads are at the server-wide cap, retry in ${retryAfterSeconds}s`);
    this.name = 'RpcBusyError';
  }
}

/** The RpcBusyError behind `err` (itself or a `cause`), else null. */
export function rpcBusyOf(err: unknown): RpcBusyError | null {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof RpcBusyError) return e;
  }
  return null;
}

/** The one gate every eth_getLogs of the shared client draws from. */
export const getLogsGate: TokenBucket = createTokenBucket(GETLOGS_BURST, (GETLOGS_BURST / GETLOGS_PER_SECOND) * 1000);

/**
 * `transport` with every eth_getLogs taking a token from `gate` first. An
 * empty gate throws RpcBusyError and nothing is sent; other methods pass
 * straight through.
 */
export function gateGetLogs(transport: Transport, gate: TokenBucket = getLogsGate): Transport {
  return ((opts: Parameters<Transport>[0]) => {
    const inner = transport(opts);
    const request = (async (args, options) => {
      if (args.method === 'eth_getLogs') {
        const wait = gate.take('eth_getLogs', 1);
        if (wait > 0) throw new RpcBusyError(wait);
      }
      return inner.request(args, options);
    }) as EIP1193RequestFn;
    return { ...inner, request };
  }) as Transport;
}

let client: PublicClient | null = null;

export function getSpareClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: spareChain,
      transport: gateGetLogs(http(spareRpcUrl(), { timeout: 20_000, retryCount: 2, batch: { batchSize: 50, wait: 5 } })),
    }) as PublicClient;
  }
  return client;
}

/** Test hook: inject a client (or reset to the default). */
export function setSpareClient(c: PublicClient | null): void {
  client = c;
}
