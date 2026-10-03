/**
 * Robinhood Chain — canonical viem chain definition for the frontend.
 *
 * Ethereum L2 (Arbitrum Orbit stack), mainnet live 2026-07-01. Native gas
 * token is ETH (18 decimals). viem/wagmi have no built-in entry for this
 * chain, so we define it ourselves and import it everywhere a chain object
 * is needed (wagmi config, connect-time chain switching, balance reads).
 */
import { defineChain } from 'viem';

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
      apiUrl: 'https://robinhoodchain.blockscout.com/api',
    },
  },
  contracts: {
    // Canonical Multicall3 — verified deployed on Robinhood Chain. Lets
    // wagmi/viem batch contract reads (balances etc.) into one RPC call.
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export default robinhoodChain;
