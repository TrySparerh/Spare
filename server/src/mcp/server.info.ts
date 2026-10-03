/**
 * Spare MCP server identity. Kept dependency-free so the registry, the
 * JSON-RPC server and the HTTP routes can all import it without cycles.
 */
export const SPARE_MCP_SERVER = {
  name: 'spare-mcp',
  title: 'Spare MCP',
  version: '3.0.0',
  description:
    'Spare MCP — read-only tools for Spare, round-up investing into tokenized stocks on Robinhood Chain: ' +
    'the live Spare contracts (universe, accounts, round-up math, quotes, activity, fees) and the $SPARE token status.',
  websiteUrl: 'https://trysparerh.com',
  /** Newest first. The server answers with the client's version when it supports it. */
  protocolVersions: ['2025-06-18', '2025-03-26', '2024-11-05'] as const,
  instructions: [
    'Spare turns spare change into tokenized stocks on Robinhood Chain (chain 4663).',
    'A user links spending wallets and sets a rule (round to $1/$5/$10, 1-5x, weekly cap); outgoing USDG payments are rounded up,',
    'the spare change parks in the CashPark, and a keeper sweeps it (>= $5, once per daily epoch) into the user\'s mix of',
    'tokenized stocks and ETFs (whatever the on-chain AssetRegistry has active; spare_universe lists them) through allowlisted Uniswap v4 pools with Chainlink-checked, quote-limited',
    'execution and a 25 bps conversion fee. There is no subscription.',
    'Start with spare_universe (what can be bought, prices, oracle status), spare_account <address> (one user\'s rule, park,',
    'cap, mix and holdings), spare_activity <address>, spare_roundup_preview, spare_quote, spare_contracts and spare_fees.',
    'The keeper buys only inside the US-equities 24/5 session (Sunday 20:00 to Friday 20:00 ET) after a fresh Chainlink print,',
    'and a sweep is all-or-nothing per account: trust oracleLabel / marketOpen and spare_quote.outcome, not oracle status alone.',
    'The $SPARE token has NOT launched: there is no contract address, price or supply — never state one.',
    'All tools are read-only; none can move funds.',
  ].join(' '),
} as const;

export type SpareMcpProtocolVersion = (typeof SPARE_MCP_SERVER.protocolVersions)[number];
