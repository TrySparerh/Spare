/**
 * /devtools — the developer reference for Spare on Robinhood Chain:
 * every address, the ABIs (downloadable, straight from
 * src/lib/spare-chain/abis.ts), viem snippets for reads and writes, events,
 * errors, the keeper, a local mainnet fork, and a pointer to Spare MCP.
 *
 * Live data comes from the chain (bytecode checks, the stock universe, the
 * keeper's balance and latest events). Nothing here needs the Spare API.
 *
 * Text: pages-b namespace (`devtools.*`). Copy owned by addressBook.ts and
 * spareApi.ts (roles, feed hours, tool blurbs) is translated under `book.*` /
 * `mcpTools.*` and shown only while it still matches those files' English.
 * Code samples, signatures and contract names stay as they are.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatEther, type Abi, type AbiEvent } from 'viem';

type AbiError = Extract<Abi[number], { type: 'error' }>;
import { PublicShell, type PublicSidebarSection } from '@/components/public/PublicShell';
import {
  FONT_TEXT,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloStat,
} from '@/components/retro/holo';
import {
  aggregatorV3Abi,
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  feeVaultAbi,
  permit2Abi,
  ruleRegistryAbi,
  screeningGateAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from '@/lib/spare-chain/abis';
import { SPARE } from '@/lib/spare-chain/addresses';
import { SPARE_ERRORS_ABI, describeRevert } from '@/lib/spare-chain/errors';
import { useSpareDeployment, useUniverse } from '@/lib/spare-chain/hooks';
import { ago, feedRowText } from '@/lib/spare-chain/protocol-feed';
import {
  DEPLOYED_AT_LABEL,
  DEPLOYMENT_RECORD,
  DEPLOY_BLOCK,
  EXTERNAL_CONTRACTS,
  KEEPER,
  PERMIT2,
  ROLES,
  RHC_RPC_URL,
  SPARE_CONTRACTS,
  USDG,
  stockFeedEntries,
  type BookEntry,
  type FeedEntry,
} from '@/components/public/live/addressBook';
import { standbyReason, standbyText } from '@/lib/spare-chain/universe';
import { AssetLabel } from '@/components/retro/apps/assetUi';
import {
  AddressLink,
  Bullets,
  CodeBadge,
  CodeBlock,
  CtaRow,
  FlexRows,
  Grid,
  LinkButton,
  Mono,
  type FlexCell,
  Prose,
  SectionHead,
  TxLinkOut,
} from '@/components/public/live/LiveAtoms';
import { usePageMeta } from '@/components/public/live/pageMeta';
import { SPARE_MCP_TOOLS, type SpareToolName } from '@/components/public/live/spareApi';
import { useBytecode, useKeeperPulse } from '@/components/public/live/useLiveChain';
import { Trans, tKey, useLang, useTranslation } from '@/i18n';

/** Sidebar model; labels are translation keys (null: the literal "Spare MCP"), translated at render. */
const SIDEBAR: { label: string; items: { id: string; label: string | null }[] }[] = [
  {
    label: tKey('devtools.nav.start'),
    items: [
      { id: 'overview', label: tKey('devtools.nav.overview') },
      { id: 'addresses', label: tKey('devtools.nav.addresses') },
      { id: 'abis', label: tKey('devtools.nav.abis') },
    ],
  },
  {
    label: tKey('devtools.nav.code'),
    items: [
      { id: 'read', label: tKey('devtools.nav.read') },
      { id: 'write', label: tKey('devtools.nav.write') },
      { id: 'events', label: tKey('devtools.nav.events') },
      { id: 'errors', label: tKey('devtools.nav.errors') },
    ],
  },
  {
    label: tKey('devtools.nav.run'),
    items: [
      { id: 'keeper', label: tKey('devtools.nav.keeper') },
      { id: 'local-fork', label: tKey('devtools.nav.localFork') },
    ],
  },
  { label: tKey('devtools.nav.agents'), items: [{ id: 'mcp', label: null }] },
];
const IDS = SIDEBAR.flatMap((s) => s.items.map((i) => i.id));

/* ----------------------------------- i18n ---------------------------------- */

/** protocol-feed's ago() ("3m ago"); it already returns the live language (pages-b `common.ago.*`). */
function useAgo() {
  return ago;
}

/** addressBook.ts role text, keyed by entry name (contracts, roles, external contracts). */
const BOOK_ROLE_KEY: Record<string, string> = {
  SweepExecutor: tKey('book.contracts.sweepExecutor'),
  CashPark: tKey('book.contracts.cashPark'),
  RuleRegistry: tKey('book.contracts.ruleRegistry'),
  ElectionRegistry: tKey('book.contracts.electionRegistry'),
  AssetRegistry: tKey('book.contracts.assetRegistry'),
  StockRouter: tKey('book.contracts.stockRouter'),
  FeeVault: tKey('book.contracts.feeVault'),
  ScreeningGate: tKey('book.contracts.screeningGate'),
  UsdgParkAdapter: tKey('book.contracts.usdgParkAdapter'),
  SgovParkAdapter: tKey('book.contracts.sgovParkAdapter'),
  Owner: tKey('book.roles.owner'),
  Pauser: tKey('book.roles.pauser'),
  Attestor: tKey('book.roles.attestor'),
  Keeper: tKey('book.roles.keeper'),
  USDG: tKey('book.external.usdg'),
  Permit2: tKey('book.external.permit2'),
  'Uniswap v4 PoolManager': tKey('book.external.poolManager'),
  'Uniswap V4Quoter': tKey('book.external.v4Quoter'),
  'Uniswap Universal Router': tKey('book.external.universalRouter'),
  WETH: tKey('book.external.weth'),
  Multicall3: tKey('book.external.multicall3'),
};
/** addressBook.ts role names (the ROLES table). */
const BOOK_ROLE_NAME_KEY: Record<string, string> = {
  Owner: tKey('book.roleNames.owner'),
  Pauser: tKey('book.roleNames.pauser'),
  Attestor: tKey('book.roleNames.attestor'),
  Keeper: tKey('book.roleNames.keeper'),
};
const BOOK_HOURS_KEY: Record<string, string> = { 'US equities 24/5': tKey('book.hours.equities'), 'crypto 24/7': tKey('book.hours.crypto') };
/** spareApi.ts tool blurbs, keyed by tool name. */
const TOOL_BLURB_KEY: Record<SpareToolName, string> = {
  spare_universe: tKey('mcpTools.universe'),
  spare_account: tKey('mcpTools.account'),
  spare_roundup_preview: tKey('mcpTools.roundupPreview'),
  spare_quote: tKey('mcpTools.quote'),
  spare_activity: tKey('mcpTools.activity'),
  spare_contracts: tKey('mcpTools.contracts'),
  spare_fees: tKey('mcpTools.fees'),
};

/** Inline code inside a translated sentence (<mono>…</mono>). */
const MonoTag = ({ children }: { children?: ReactNode }) => <Mono>{children}</Mono>;

/* --------------------------------- helpers --------------------------------- */

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-devtools-section style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 16, minWidth: 0 }}>
      <SectionHead kicker={kicker} title={title} />
      {children}
    </section>
  );
}

/* --------------------------------- snippets -------------------------------- */

const READ_SNIPPET = `import { createPublicClient, http } from 'viem';
// ruleRegistryAbi, cashParkAbi, sweepExecutorAbi, stockRouterAbi, assetRegistryAbi: the JSON files under "ABIs"
const client = createPublicClient({ transport: http('${RHC_RPC_URL}') });
const account = '0x…'; // a Spare account

const rule = await client.readContract({ address: '${SPARE.RuleRegistry}', abi: ruleRegistryAbi, functionName: 'ruleOf', args: [account] });
// { roundTo: 1|5|10, multiplier: 1..5, weeklyCap: bigint (USDG 6dp), enabled }
const parked = await client.readContract({ address: '${SPARE.CashPark}', abi: cashParkAbi, functionName: 'valueOf', args: [account] });
const room = await client.readContract({ address: '${SPARE.SweepExecutor}', abi: sweepExecutorAbi, functionName: 'remainingWeeklyCap', args: [account] });
// The universe is whatever AssetRegistry holds: never hard-code a stock list.
const tokens = await client.readContract({ address: '${SPARE.AssetRegistry}', abi: assetRegistryAbi, functionName: 'tokens' });
const asset = await client.readContract({ address: '${SPARE.AssetRegistry}', abi: assetRegistryAbi, functionName: 'get', args: [tokens[0]] });
// { token, feed, feedDecimals, heartbeat, bandBps, active, poolKey }
const [status, price1e18] = await client.readContract({ address: '${SPARE.StockRouter}', abi: stockRouterAbi, functionName: 'oracleStatus', args: [tokens[0]] });`;

const ROUNDUP_SNIPPET = `// amount in USDG base units (6 dp); roundTo in whole dollars
export function roundUp(amount: bigint, roundTo: 1|5|10, multiplier: 1|2|3|4|5): bigint {
  const unit = BigInt(roundTo) * 1_000_000n;
  const rem = amount % unit;
  return rem === 0n ? 0n : (unit - rem) * BigInt(multiplier);
}`;

const WALLET_SNIPPET = `import { createWalletClient, custom, defineChain } from 'viem';

const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['${RHC_RPC_URL}'] } },
});
const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum) });
const [account] = await wallet.getAddresses();`;

interface WriteCall {
  sig: string;
  /** Translation key of the one-line explanation. */
  what: string;
  code: string;
}

const WRITES: WriteCall[] = [
  {
    sig: 'RuleRegistry.linkSelf()',
    what: tKey('devtools.write.what.linkSelf'),
    code: `await wallet.writeContract({
  account, address: '${SPARE.RuleRegistry}', abi: ruleRegistryAbi, functionName: 'linkSelf',
});`,
  },
  {
    sig: 'RuleRegistry.linkWallet(wallet, deadline, signature)',
    what: tKey('devtools.write.what.linkWallet'),
    code: `const nonce = await client.readContract({ address: '${SPARE.RuleRegistry}', abi: ruleRegistryAbi, functionName: 'nonces', args: [spender] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const signature = await spenderWallet.signTypedData({
  account: spender,
  domain: { name: 'SPARE RuleRegistry', version: '1', chainId: 4663, verifyingContract: '${SPARE.RuleRegistry}' },
  types: { Link: [{ name: 'account', type: 'address' }, { name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Link',
  message: { account, wallet: spender, nonce, deadline },
});
await wallet.writeContract({
  account, address: '${SPARE.RuleRegistry}', abi: ruleRegistryAbi, functionName: 'linkWallet', args: [spender, deadline, signature],
});`,
  },
  {
    sig: 'RuleRegistry.setRule(roundTo, multiplier, weeklyCap, enabled)',
    what: tKey('devtools.write.what.setRule'),
    code: `await wallet.writeContract({
  account, address: '${SPARE.RuleRegistry}', abi: ruleRegistryAbi, functionName: 'setRule', args: [1, 3, 25_000_000n, true], // $1, 3×, $25 a week
});`,
  },
  {
    sig: 'RuleRegistry.unlink(wallet)',
    what: tKey('devtools.write.what.unlink'),
    code: `await wallet.writeContract({
  account, address: '${SPARE.RuleRegistry}', abi: ruleRegistryAbi, functionName: 'unlink', args: [spender],
});`,
  },
  {
    sig: 'ElectionRegistry.setMix([{ asset, bps }])',
    what: tKey('devtools.write.what.setMix'),
    code: `// tokenA, tokenB: two ACTIVE AssetRegistry tokens (registry get(token).active)
await wallet.writeContract({
  account, address: '${SPARE.ElectionRegistry}', abi: electionRegistryAbi, functionName: 'setMix',
  args: [[{ asset: tokenA, bps: 6000 }, { asset: tokenB, bps: 4000 }]], // 60% / 40%, up to MAX_LEGS legs
});`,
  },
  {
    sig: 'ElectionRegistry.clearMix()',
    what: tKey('devtools.write.what.clearMix'),
    code: `await wallet.writeContract({
  account, address: '${SPARE.ElectionRegistry}', abi: electionRegistryAbi, functionName: 'clearMix',
});`,
  },
  {
    sig: 'CashPark.exit()',
    what: tKey('devtools.write.what.exit'),
    code: `await wallet.writeContract({
  account, address: '${SPARE.CashPark}', abi: cashParkAbi, functionName: 'exit',
});`,
  },
  {
    sig: 'SweepExecutor.claim(token)',
    what: tKey('devtools.write.what.claim'),
    code: `await wallet.writeContract({
  account, address: '${SPARE.SweepExecutor}', abi: sweepExecutorAbi, functionName: 'claim', args: [token], // any token with claimable(account, token) > 0
});`,
  },
  {
    sig: 'Permit2.approve(USDG, SweepExecutor, amount, expiration)',
    what: tKey('devtools.write.what.permit2'),
    code: `// erc20Abi, maxUint256 and maxUint160 come from 'viem'
await spenderWallet.writeContract({ account: spender, address: '${USDG}', abi: erc20Abi, functionName: 'approve', args: ['${PERMIT2}', maxUint256] });
const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 3600; // one year
await spenderWallet.writeContract({
  account: spender, address: '${PERMIT2}', abi: permit2Abi, functionName: 'approve', args: ['${USDG}', '${SPARE.SweepExecutor}', maxUint160, expiration],
});`,
  },
];

const LOCAL_FORK = `scripts/dev-fork.sh            # anvil fork of RHC mainnet as chain 31337, deploys Spare, funds two test users
scripts/dev-fork.sh --smoke    # ...then runs collect -> sweep end to end
bun run engine/scripts/keeper-e2e.ts   # link -> rule -> consent -> payments -> collect -> quote-limited sweep -> exit
scripts/dev-fork.sh --stop`;

/* ---------------------------------- ABIs ----------------------------------- */

const ABIS: { name: string; abi: Abi; address?: string; note?: string }[] = [
  { name: 'AssetRegistry', abi: assetRegistryAbi as unknown as Abi, address: SPARE.AssetRegistry },
  { name: 'RuleRegistry', abi: ruleRegistryAbi as unknown as Abi, address: SPARE.RuleRegistry },
  { name: 'ElectionRegistry', abi: electionRegistryAbi as unknown as Abi, address: SPARE.ElectionRegistry },
  { name: 'ScreeningGate', abi: screeningGateAbi as unknown as Abi, address: SPARE.ScreeningGate },
  { name: 'StockRouter', abi: stockRouterAbi as unknown as Abi, address: SPARE.StockRouter },
  { name: 'CashPark', abi: cashParkAbi as unknown as Abi, address: SPARE.CashPark },
  { name: 'FeeVault', abi: feeVaultAbi as unknown as Abi, address: SPARE.FeeVault },
  { name: 'SweepExecutor', abi: sweepExecutorAbi as unknown as Abi, address: SPARE.SweepExecutor },
  { name: 'Permit2', abi: permit2Abi as unknown as Abi, note: tKey('devtools.abis.notes.permit2') },
  { name: 'AggregatorV3', abi: aggregatorV3Abi as unknown as Abi, note: tKey('devtools.abis.notes.aggregator') },
];

const count = (abi: Abi, type: string) => abi.filter((i) => i.type === type).length;

/* --------------------------------- events ---------------------------------- */

/** [event name, translation key of its meaning] per contract. */
const EVENT_GROUPS: { contract: string; abi: Abi; events: [string, string][] }[] = [
  {
    contract: 'SweepExecutor',
    abi: sweepExecutorAbi as unknown as Abi,
    events: [
      ['Accrued', tKey('devtools.events.meaning.accrued')],
      ['AccrualSkipped', tKey('devtools.events.meaning.accrualSkipped')],
      ['AccountSwept', tKey('devtools.events.meaning.accountSwept')],
      ['AssetSwept', tKey('devtools.events.meaning.assetSwept')],
      ['Delivered', tKey('devtools.events.meaning.delivered')],
      ['DeliveryHeld', tKey('devtools.events.meaning.deliveryHeld')],
      ['Deferred', tKey('devtools.events.meaning.deferred')],
      ['SafeSettled', tKey('devtools.events.meaning.safeSettled')],
      ['SwapDeferred', tKey('devtools.events.meaning.swapDeferred')],
      ['Claimed', tKey('devtools.events.meaning.claimed')],
      ['ParamsSet', tKey('devtools.events.meaning.paramsSet')],
    ],
  },
  {
    contract: 'CashPark',
    abi: cashParkAbi as unknown as Abi,
    events: [
      ['Credited', tKey('devtools.events.meaning.credited')],
      ['Parked', tKey('devtools.events.meaning.parked')],
      ['WithdrawnForSweep', tKey('devtools.events.meaning.withdrawnForSweep')],
      ['Returned', tKey('devtools.events.meaning.returned')],
      ['Exited', tKey('devtools.events.meaning.exited')],
      ['ExitUnitsKept', tKey('devtools.events.meaning.exitUnitsKept')],
    ],
  },
  {
    contract: 'RuleRegistry',
    abi: ruleRegistryAbi as unknown as Abi,
    events: [
      ['RuleSet', tKey('devtools.events.meaning.ruleSet')],
      ['Linked', tKey('devtools.events.meaning.linked')],
      ['Unlinked', tKey('devtools.events.meaning.unlinked')],
      ['NonceInvalidated', tKey('devtools.events.meaning.nonceInvalidated')],
    ],
  },
  {
    contract: 'ElectionRegistry',
    abi: electionRegistryAbi as unknown as Abi,
    events: [
      ['MixSet', tKey('devtools.events.meaning.mixSet')],
      ['MixCleared', tKey('devtools.events.meaning.mixCleared')],
      ['DefaultMixSet', tKey('devtools.events.meaning.defaultMixSet')],
    ],
  },
  {
    contract: 'AssetRegistry',
    abi: assetRegistryAbi as unknown as Abi,
    events: [
      ['AssetSet', tKey('devtools.events.meaning.assetSet')],
      ['AssetActive', tKey('devtools.events.meaning.assetActive')],
    ],
  },
  {
    contract: 'StockRouter',
    abi: stockRouterAbi as unknown as Abi,
    events: [
      ['Bought', tKey('devtools.events.meaning.bought')],
      ['Sold', tKey('devtools.events.meaning.sold')],
    ],
  },
  { contract: 'FeeVault', abi: feeVaultAbi as unknown as Abi, events: [['Withdrawn', tKey('devtools.events.meaning.withdrawn')]] },
  {
    contract: 'ScreeningGate',
    abi: screeningGateAbi as unknown as Abi,
    events: [
      ['Cleared', tKey('devtools.events.meaning.cleared')],
      ['Revoked', tKey('devtools.events.meaning.revoked')],
      ['EnforcedSet', tKey('devtools.events.meaning.enforcedSet')],
    ],
  },
];

function eventSignature(abi: Abi, name: string): string {
  const ev = abi.find((i) => i.type === 'event' && i.name === name) as AbiEvent | undefined;
  if (!ev) return `${name}(…)`;
  return `${name}(${ev.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name ?? ''}`.trim()).join(', ')})`;
}

/* --------------------------------- errors ---------------------------------- */

const SAMPLE_A = '0x1111111111111111111111111111111111111111';
const SAMPLE_B = '0x2222222222222222222222222222222222222222';

/**
 * Example arguments for each error's sentence. Asset errors use live registry
 * tokens (an active one, a standby one) so the sentence names a real ticker;
 * before the registry answers they fall back to a placeholder address.
 */
function sampleArgs(active: string = SAMPLE_B, standby: string = active): Record<string, readonly unknown[]> {
  return {
    BadRoundTo: [3],
    BadMultiplier: [7],
    AlreadyLinked: [SAMPLE_A, SAMPLE_B],
    NotLinked: [SAMPLE_A],
    BadLegCount: [7],
    BadTotal: [9_000],
    ZeroLeg: [active],
    DuplicateAsset: [active],
    IneligibleAsset: [standby],
    UnknownAsset: [SAMPLE_A],
    AssetInactive: [standby],
    OracleNotOk: [1],
    WeeklyCapExceeded: [30_000_000n, 25_000_000n],
    SafeERC20FailedOperation: [USDG],
  };
}

const ERROR_SOURCES: [string, Abi][] = ABIS.map((a) => [a.name, a.abi]);

interface ErrorRow {
  name: string;
  sig: string;
  meaning: string;
  from: string;
}

function buildErrorRows(samples: Record<string, readonly unknown[]>): { mapped: ErrorRow[]; other: string[] } {
  const mapped: ErrorRow[] = [];
  const other: string[] = [];
  for (const item of SPARE_ERRORS_ABI) {
    if (item.type !== 'error') continue;
    const err = item as AbiError;
    const sig = `${err.name}(${err.inputs.map((i) => `${i.type} ${i.name ?? ''}`.trim()).join(', ')})`;
    let meaning = '';
    try {
      meaning = describeRevert(err.name, samples[err.name] ?? []);
    } catch {
      meaning = '';
    }
    if (!meaning || meaning.startsWith(`${err.name}(`)) {
      other.push(err.name);
      continue;
    }
    const from = ERROR_SOURCES.filter(([, abi]) => abi.some((i) => i.type === 'error' && i.name === err.name))
      .map(([n]) => n)
      .join(', ');
    mapped.push({ name: err.name, sig, meaning, from });
  }
  return { mapped, other };
}

/* ---------------------------------- page ----------------------------------- */

export default function DevTools() {
  const { t } = useTranslation('pages-b');
  const lang = useLang();
  const agoT = useAgo();
  usePageMeta(t('devtools.meta.title'), t('devtools.meta.description'));
  /** Text owned by addressBook.ts / spareApi.ts: our translation only while our English copy still matches it. */
  const book = (key: string | undefined, english: string) => (key && t(key, { lng: 'en' }) === english ? t(key) : english);
  const sidebar: PublicSidebarSection[] = SIDEBAR.map((s) => ({
    label: t(s.label),
    items: s.items.map((i) => ({ id: i.id, label: i.label ? t(i.label) : 'Spare MCP' })),
  }));

  const [active, setActive] = useState<string>(() => {
    const h = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
    return IDS.includes(h) ? h : 'overview';
  });
  const clickLock = useRef(0);

  // Deep links (/devtools#local-fork): scroll there once the sections exist.
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (!IDS.includes(h)) return;
    const timer = window.setTimeout(() => document.getElementById(h)?.scrollIntoView({ block: 'start' }), 60);
    return () => window.clearTimeout(timer);
  }, []);

  // Scroll spy: the first section overlapping the top 40% of the viewport is active.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        if (Date.now() < clickLock.current) return;
        const first = IDS.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '0px 0px -60% 0px', threshold: 0 },
    );
    for (const id of IDS) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  const select = (id: string) => {
    setActive(id);
    clickLock.current = Date.now() + 900;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      window.history.replaceState(null, '', `#${id}`);
    } catch {
      /* ignore */
    }
  };

  const { deployed } = useSpareDeployment();
  const { assets, isLoading: universeLoading } = useUniverse({ enabled: deployed });
  const liveStocks = assets.length ? assets.filter((a) => a.active).length : null;
  // The registry's own tokens, active first: the stock-token and feed tables, and the error samples.
  const stockRows = useMemo(
    () => [...assets].sort((a, b) => Number(b.active) - Number(a.active) || a.symbol.localeCompare(b.symbol)),
    [assets],
  );
  const feedRows = useMemo(() => stockFeedEntries(stockRows.map((a) => ({ symbol: a.symbol, feed: a.feed ?? null }))), [stockRows]);
  const sampleActive = stockRows.find((a) => a.active)?.token;
  const sampleStandby = stockRows.find((a) => !a.active)?.token;

  const allAddresses = useMemo(() => SPARE_CONTRACTS.map((c) => c.address), []);
  const { code } = useBytecode(allAddresses);
  const { pulse, loading: pulseLoading } = useKeeperPulse(true);
  // describeRevert() speaks the active language: rebuild on a switch (and once the registry names its tokens).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const errorRows = useMemo(() => buildErrorRows(sampleArgs(sampleActive, sampleStandby)), [lang, sampleActive, sampleStandby]);

  const nameCell = (basis = '170px'): FlexCell<BookEntry> => ({ key: 'name', basis, grow: 0, render: (r) => <strong translate="no">{r.name}</strong> });
  const addrCell: FlexCell<BookEntry> = { key: 'address', basis: '330px', grow: 2, render: (r) => <AddressLink address={r.address} full /> };
  const roleCell: FlexCell<BookEntry> = { key: 'role', basis: '220px', grow: 2, muted: true, render: (r) => book(BOOK_ROLE_KEY[r.name], r.role) };
  const contractCells: FlexCell<BookEntry>[] = [
    nameCell(),
    addrCell,
    roleCell,
    { key: 'code', basis: 'auto', fixed: true, render: (r) => <CodeBadge ok={code ? code[r.address.toLowerCase()] : null} /> },
  ];
  const plainCells: FlexCell<BookEntry>[] = [nameCell('190px'), addrCell, roleCell];
  const roleNameCell: FlexCell<BookEntry> = {
    key: 'name',
    basis: '190px',
    grow: 0,
    render: (r) => <strong>{book(BOOK_ROLE_NAME_KEY[r.name], r.name)}</strong>,
  };
  const roleCells: FlexCell<BookEntry>[] = [roleNameCell, addrCell, roleCell];

  type StockRow = (typeof stockRows)[number];
  const stockCells: FlexCell<StockRow>[] = [
    { key: 'symbol', basis: '96px', grow: 0, render: (r) => <AssetLabel symbol={r.symbol} kind={r.kind} size={12.5} /> },
    { key: 'address', basis: '330px', grow: 2, render: (r) => <AddressLink address={r.token} full kind="token" /> },
    {
      key: 'status',
      basis: '200px',
      grow: 1,
      render: (r) =>
        r.active ? (
          <HoloBadge label={t('common.active')} tone="good" />
        ) : (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <HoloBadge label={t('common.inactive')} tone="warn" />
            {/* standbyText speaks the live language (shell assets.standby.*) */}
            <span style={{ color: INK.muted }}>{standbyText(standbyReason(r))}</span>
          </span>
        ),
    },
    {
      key: 'feed',
      basis: 'auto',
      fixed: true,
      render: (r) =>
        r.feed ? (
          <span style={{ color: INK.muted }}>
            <Trans t={t} i18nKey="devtools.addresses.feedCell" components={{ addr: <AddressLink address={r.feed} /> }} />
          </span>
        ) : (
          '—'
        ),
    },
  ];

  type FeedRow = FeedEntry;
  const feedCells: FlexCell<FeedRow>[] = [
    { key: 'pair', basis: '110px', grow: 0, render: (r) => <strong translate="no">{r.pair}</strong> },
    { key: 'proxy', basis: '330px', grow: 2, render: (r) => <AddressLink address={r.proxy} full /> },
    { key: 'hours', basis: '130px', grow: 1, muted: true, render: (r) => book(BOOK_HOURS_KEY[r.hours], r.hours) },
  ];

  type AbiRow = (typeof ABIS)[number];
  const abiCells: FlexCell<AbiRow>[] = [
    {
      key: 'name',
      basis: '220px',
      grow: 1,
      render: (r) => (
        <span>
          <strong translate="no">{r.name}</strong>
          {r.note && <span style={{ color: INK.muted }}> · {t(r.note)}</span>}
        </span>
      ),
    },
    {
      key: 'counts',
      basis: '230px',
      grow: 1,
      muted: true,
      render: (r) => t('devtools.abis.counts', { functions: count(r.abi, 'function'), events: count(r.abi, 'event'), errors: count(r.abi, 'error') }),
    },
    {
      key: 'action',
      basis: 'auto',
      fixed: true,
      render: (r) => (
        <HoloButton size="sm" onClick={() => downloadJson(r.abi, `${r.name}.json`)} aria-label={t('devtools.abis.downloadAria', { name: r.name })}>
          {/* i18n-ignore — a file name */}
          {r.name}.json
        </HoloButton>
      ),
    },
  ];

  type EventRow = { name: string; sig: string; meaning: string };
  const eventCells: FlexCell<EventRow>[] = [
    { key: 'sig', basis: '320px', grow: 1, render: (r) => <span translate="no" style={{ fontWeight: 700 }}>{r.sig}</span> },
    { key: 'meaning', basis: '260px', grow: 1, muted: true, render: (r) => r.meaning },
  ];

  const errorCells: FlexCell<ErrorRow>[] = [
    { key: 'sig', basis: '260px', grow: 1, render: (r) => <span translate="no" style={{ fontWeight: 700 }}>{r.sig}</span> },
    { key: 'meaning', basis: '300px', grow: 2, render: (r) => r.meaning },
    { key: 'from', basis: '110px', grow: 0, muted: true, render: (r) => r.from },
  ];

  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <PublicShell
      version="S1"
      kicker={t('devtools.hero.kicker')}
      title={t('devtools.hero.title')}
      subtitle={t('devtools.hero.subtitle')}
      sidebar={sidebar}
      activeId={active}
      onSelect={select}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, minWidth: 0 }}>
        {/* ── overview ─────────────────────────────────────────────── */}
        <Section id="overview" kicker={t('devtools.nav.start')} title={t('devtools.nav.overview')}>
          <Prose>{t('devtools.overview.body')}</Prose>
          <Grid min={150} gap={12}>
            <HoloCard compact flat closeBox={false}>
              <HoloStat label={t('devtools.overview.contracts')} value="10" size="lg" sub={t('devtools.overview.contractsSub')} />
            </HoloCard>
            <HoloCard compact flat closeBox={false}>
              <HoloStat
                label={t('devtools.overview.deployed')}
                value={DEPLOY_BLOCK.toLocaleString('en-US')}
                size="md"
                sub={t('devtools.overview.deployedSub', { at: book(tKey('book.deployedAt'), DEPLOYED_AT_LABEL) })}
              />
            </HoloCard>
            <HoloCard compact flat closeBox={false}>
              <HoloStat label={t('devtools.overview.chain')} value="4663" size="lg" sub={t('devtools.overview.chainSub')} />
            </HoloCard>
            <HoloCard compact flat closeBox={false}>
              <HoloStat
                label={t('devtools.overview.liveStocks')}
                value={liveStocks == null ? '—' : String(liveStocks)}
                size="lg"
                sub={t('devtools.overview.liveStocksSub')}
                tone={liveStocks ? 'holo' : 'ink'}
              />
            </HoloCard>
          </Grid>
        </Section>

        {/* ── addresses ────────────────────────────────────────────── */}
        <Section id="addresses" kicker={t('devtools.nav.start')} title={t('devtools.nav.addresses')}>
          <Prose>{t('devtools.addresses.body')}</Prose>
          <HoloCard title={t('devtools.addresses.spareContracts')} accent="10" accentTone="info">
            <FlexRows cells={contractCells} rows={SPARE_CONTRACTS} rowKey={(r) => r.name} ariaLabel={t('devtools.addresses.spareContracts')} />
          </HoloCard>
          <HoloCard title={t('devtools.addresses.roles')}>
            <FlexRows cells={roleCells} rows={ROLES} rowKey={(r) => r.name} ariaLabel={t('devtools.addresses.roles')} />
            <HoloNotice tone="warn" compact title={t('devtools.addresses.ownerKeyTitle')}>
              {t('devtools.addresses.ownerKeyBody')}
            </HoloNotice>
          </HoloCard>
          <HoloCard title={t('devtools.addresses.external')}>
            <FlexRows cells={plainCells} rows={EXTERNAL_CONTRACTS} rowKey={(r) => r.name} ariaLabel={t('devtools.addresses.external')} />
          </HoloCard>
          <HoloCard title={t('devtools.addresses.stockTokens')}>
            {stockRows.length === 0 ? (
              <Prose muted>{universeLoading && deployed ? '…' : '—'}</Prose>
            ) : (
              <FlexRows cells={stockCells} rows={stockRows} rowKey={(r) => r.token} ariaLabel={t('devtools.addresses.stockTokens')} />
            )}
          </HoloCard>
          <HoloCard title={t('devtools.addresses.feeds')} accent={t('devtools.addresses.feedsAccent')} accentTone="info">
            <FlexRows cells={feedCells} rows={feedRows} rowKey={(r) => r.proxy} ariaLabel={t('devtools.addresses.feeds')} />
          </HoloCard>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <HoloButton variant="primary" onClick={() => downloadJson(DEPLOYMENT_RECORD, '4663.json')}>
              {t('devtools.addresses.download')}
            </HoloButton>
            <Prose muted style={{ fontSize: 11.5 }}>
              <Trans t={t} i18nKey="devtools.addresses.recordNote" components={{ mono: <MonoTag /> }} />
            </Prose>
          </div>
        </Section>

        {/* ── abis ─────────────────────────────────────────────────── */}
        <Section id="abis" kicker={t('devtools.nav.start')} title={t('devtools.nav.abis')}>
          <Prose>
            <Trans t={t} i18nKey="devtools.abis.body" components={{ mono: <MonoTag /> }} />
          </Prose>
          <HoloCard title={t('devtools.abis.download')}>
            <FlexRows cells={abiCells} rows={ABIS} rowKey={(r) => r.name} ariaLabel={t('devtools.nav.abis')} />
            <div>
              <HoloButton
                size="sm"
                onClick={() =>
                  downloadJson(
                    { chainId: 4663, contracts: Object.fromEntries(ABIS.map((a) => [a.name, { address: a.address ?? null, abi: a.abi }])) },
                    'spare-abis-4663.json',
                  )
                }
              >
                {t('devtools.abis.downloadAll')}
              </HoloButton>
            </div>
          </HoloCard>
        </Section>

        {/* ── read ─────────────────────────────────────────────────── */}
        <Section id="read" kicker={t('devtools.nav.code')} title={t('devtools.nav.read')}>
          <Prose>{t('devtools.read.body')}</Prose>
          <CodeBlock code={READ_SNIPPET} title={t('devtools.read.snippetTitle')} />
          <Prose>{t('devtools.read.mathIntro')}</Prose>
          <CodeBlock code={ROUNDUP_SNIPPET} title={t('devtools.read.mathTitle')} />
        </Section>

        {/* ── write ────────────────────────────────────────────────── */}
        <Section id="write" kicker={t('devtools.nav.code')} title={t('devtools.nav.write')}>
          <Prose>
            <Trans t={t} i18nKey="devtools.write.body" components={{ mono: <MonoTag /> }} />
          </Prose>
          <CodeBlock code={WALLET_SNIPPET} title={t('devtools.write.walletTitle')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {WRITES.map((w) => (
              <HoloCard key={w.sig} title={w.sig} compact flat bar="lilac">
                <Prose>{t(w.what)}</Prose>
                <CodeBlock code={w.code} lang="ts" />
              </HoloCard>
            ))}
          </div>
          <HoloNotice tone="info" compact>
            <Trans t={t} i18nKey="devtools.write.keeperOnly" components={{ mono: <MonoTag /> }} />
          </HoloNotice>
        </Section>

        {/* ── events ───────────────────────────────────────────────── */}
        <Section id="events" kicker={t('devtools.nav.code')} title={t('devtools.nav.events')}>
          <Prose>{t('devtools.events.body', { block: DEPLOY_BLOCK.toLocaleString('en-US') })}</Prose>
          {EVENT_GROUPS.map((g) => (
            <HoloCard key={g.contract} title={g.contract} compact>
              <FlexRows
                cells={eventCells}
                rows={g.events.map(([name, meaning]) => ({ name, sig: eventSignature(g.abi, name), meaning: t(meaning) }))}
                rowKey={(r) => r.name}
                ariaLabel={t('devtools.events.aria', { contract: g.contract })}
              />
            </HoloCard>
          ))}
        </Section>

        {/* ── errors ───────────────────────────────────────────────── */}
        <Section id="errors" kicker={t('devtools.nav.code')} title={t('devtools.nav.errors')}>
          <Prose>{t('devtools.errors.body')}</Prose>
          <HoloCard title={t('devtools.errors.title')} accent={String(errorRows.mapped.length)} accentTone="info">
            <FlexRows cells={errorCells} rows={errorRows.mapped} rowKey={(r) => r.name} ariaLabel={t('devtools.errors.title')} />
          </HoloCard>
          {errorRows.other.length > 0 && (
            <Prose muted style={{ fontSize: 11.5 }}>
              {t('devtools.errors.other', { list: errorRows.other.join(', ') })}
            </Prose>
          )}
        </Section>

        {/* ── keeper ───────────────────────────────────────────────── */}
        <Section id="keeper" kicker={t('devtools.nav.run')} title={t('devtools.nav.keeper')}>
          <Prose>
            <Trans t={t} i18nKey="devtools.keeper.body" components={{ mono: <MonoTag /> }} />
          </Prose>
          <HoloCard title={t('devtools.keeper.cardTitle')} accent={t('devtools.keeper.accent')} accentTone="info">
            <HoloList>
              <HoloListRow
                label={t('devtools.keeper.keeper')}
                value={<AddressLink address={KEEPER} />}
                hint="SweepExecutor.isKeeper" // i18n-ignore — function name
              />
              <HoloListRow
                label={t('devtools.keeper.gas')}
                value={pulse?.balanceWei != null ? `${Number(formatEther(pulse.balanceWei)).toFixed(4)} ETH` : pulseLoading ? '…' : '—'}
                hint={t('devtools.keeper.gasHint')}
              />
              <HoloListRow
                label={t('devtools.keeper.lastRoundUp')}
                value={
                  pulse?.lastAccrued ? (
                    <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {agoT(pulse.lastAccrued.at, nowSec)} <TxLinkOut hash={pulse.lastAccrued.event.txHash} label={t('common.tx')} />
                    </span>
                  ) : pulseLoading ? (
                    '…'
                  ) : pulse ? (
                    t('common.noneYet')
                  ) : (
                    '—'
                  )
                }
                hint={pulse?.lastAccrued ? feedRowText(pulse.lastAccrued.event) : t('devtools.keeper.lastRoundUpHint')}
              />
              <HoloListRow
                label={t('devtools.keeper.lastBuy')}
                value={
                  pulse?.lastAssetSwept ? (
                    <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {agoT(pulse.lastAssetSwept.at, nowSec)} <TxLinkOut hash={pulse.lastAssetSwept.event.txHash} label={t('common.tx')} />
                    </span>
                  ) : pulseLoading ? (
                    '…'
                  ) : pulse ? (
                    t('common.noneYet')
                  ) : (
                    '—'
                  )
                }
                hint={pulse?.lastAssetSwept ? feedRowText(pulse.lastAssetSwept.event) : t('devtools.keeper.lastBuyHint')}
              />
              <HoloListRow
                label={t('devtools.keeper.watched')}
                value={pulse?.linkedWallets != null ? String(pulse.linkedWallets) : pulseLoading ? '…' : '—'}
                hint={t('devtools.keeper.watchedHint')}
              />
            </HoloList>
            {pulse?.partial && (
              <Prose muted style={{ fontSize: 11.5 }}>
                {t('devtools.keeper.partial')}
              </Prose>
            )}
          </HoloCard>
          <CtaRow>
            <LinkButton to="/dispatch">{t('devtools.keeper.log')}</LinkButton>
          </CtaRow>
        </Section>

        {/* ── local fork ───────────────────────────────────────────── */}
        <Section id="local-fork" kicker={t('devtools.nav.run')} title={t('devtools.nav.localFork')}>
          <Prose>{t('devtools.fork.body')}</Prose>
          <CodeBlock code={LOCAL_FORK} title={t('devtools.fork.codeTitle')} />
          <Bullets items={[t('devtools.fork.foundry'), t('devtools.fork.state'), t('devtools.fork.private')]} />
        </Section>

        {/* ── mcp ──────────────────────────────────────────────────── */}
        <Section id="mcp" kicker={t('devtools.nav.agents')} title="Spare MCP">
          <HoloCard title={t('devtools.mcp.cardTitle')} bar="pink">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SPARE_MCP_TOOLS.map((tool) => (
                <li key={tool.name} style={{ fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.5, color: INK.body }}>
                  <Mono>{tool.name}</Mono> <span style={{ color: INK.muted }}>{book(TOOL_BLURB_KEY[tool.name], tool.blurb)}</span>
                </li>
              ))}
            </ul>
            <Prose muted style={{ fontSize: 11.5 }}>
              {t('devtools.mcp.body')}
            </Prose>
            <CtaRow>
              <LinkButton to="/mcp" variant="primary">
                {t('devtools.mcp.guide')}
              </LinkButton>
            </CtaRow>
          </HoloCard>
        </Section>
      </div>
    </PublicShell>
  );
}
