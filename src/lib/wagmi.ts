/**
 * wagmi config — Robinhood Chain (4663) ONLY.
 *
 * Desktop: wagmi v2 auto-discovers every EIP-6963 injected provider
 * (MetaMask, Phantom EVM, Rabby, Brave, OKX, Coinbase extension, and
 * Robinhood Wallet if it ever ships an extension) — no cloud config needed.
 * Nothing here disables that discovery (multiInjectedProviderDiscovery
 * defaults to true).
 *
 * Mobile / Robinhood Wallet: the Robinhood Wallet app (iOS/Android) has
 * native Robinhood Chain support and connects to dapps via WalletConnect. The
 * walletConnect() connector below is registered only when VITE_WC_PROJECT_ID
 * is set: an invalid or placeholder id makes Reown answer 403 to every
 * request and silently breaks ALL connections. To enable it:
 *   1. Register a project at https://cloud.reown.com (free)
 *   2. Add trysparerh.com to the allowed origins
 *   3. Set VITE_WC_PROJECT_ID on the site's service in the hosting dashboard
 *
 * There is no Coinbase Smart Wallet connector: its smart-contract wallets are
 * not deployed on Robinhood Chain, so it would connect and then fail every
 * transaction. Coinbase EXTENSION users connect through the injected /
 * EIP-6963 path.
 */
import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { robinhoodChain } from './chain';

// Robinhood Chain RPC. The single source for every on-chain read in the app
// (BiosScreen and all wagmi hooks go through this transport). Unset or empty
// falls back to the public mainnet endpoint.
const RPC_URL: string =
  (import.meta.env.VITE_RHC_RPC_URL as string | undefined) || 'https://rpc.mainnet.chain.robinhood.com';

const WC_PROJECT_ID: string | undefined = import.meta.env.VITE_WC_PROJECT_ID || undefined;

/** True when the WalletConnect (Robinhood Wallet mobile) path is available. */
export const hasWalletConnect = Boolean(WC_PROJECT_ID);

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  transports: {
    [robinhoodChain.id]: http(RPC_URL),
  },
  connectors: [
    // Generic injected — catches MetaMask, Phantom (EVM mode), Rabby,
    // Brave Wallet, OKX, Trust, Coinbase extension — anything that injects
    // window.ethereum. EIP-6963 gives each its own entry automatically.
    injected({
      shimDisconnect: true,
    }),
    // WalletConnect — the Robinhood Wallet (mobile) path. QR modal on
    // desktop, deep link on mobile. Only registered with a real project id.
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            metadata: {
              name: 'Spare',
              // i18n-ignore: WalletConnect session metadata, read by the wallet app once at config time
              description: 'Round up your payments, auto-invest the change on Robinhood Chain',
              url: 'https://trysparerh.com',
              icons: ['https://trysparerh.com/favicon.png'],
            },
            showQrModal: true,
          }),
        ]
      : []),
  ],
  ssr: false,
});

export { robinhoodChain };
