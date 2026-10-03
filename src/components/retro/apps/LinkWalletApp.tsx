/**
 * LinkWalletApp — which wallets feed this account's round-ups, on-chain.
 *
 * The connected wallet is the investing ACCOUNT. Everything here is
 * RuleRegistry + Permit2 state read from Robinhood Chain:
 *
 *   * linkSelf()                      link the connected wallet as its own spending wallet
 *   * linkWallet(wallet, deadline, sig) link ANOTHER wallet — two steps: sign on the
 *                                     spending wallet, submit from the account
 *   * unlink(wallet)                  by the account, or by the wallet itself
 *   * consent to pull                 USDG.approve(Permit2, max) + Permit2.approve(USDG,
 *                                     SweepExecutor, max160, now + 1y), signed by
 *                                     each spending wallet itself
 *
 * The on-chain weekly cap (Round-Up Rules) is the real bound on what can be
 * pulled — the Permit2 allowance only says the executor MAY pull.
 *
 * Presentation: Spare Holo. Without a wallet the window shows a clearly
 * labelled example wallet map, the three steps, and a connect prompt.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trans, getT, tKey, useTranslation } from '@/i18n';
import { useAccount, useBlockNumber, usePublicClient, useReadContract, useReadContracts, useSignTypedData, useSwitchChain } from 'wagmi';
import {
  erc20Abi,
  getAddress,
  hashTypedData,
  isAddress,
  isErc6492Signature,
  isErc8010Signature,
  maxUint256,
  parseErc6492Signature,
  parseErc8010Signature,
  recoverTypedDataAddress,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { permit2Abi, ruleRegistryAbi, sweepExecutorAbi } from '@/lib/spare-chain/abis';
import { BLOCKS_PER_SECOND } from '@/lib/spare-chain/activity';
import { EXTERNAL, SPARE, SPARE_CHAIN_ID, addressUrl, sameAddress, shortAddr } from '@/lib/spare-chain/addresses';
import { UNLIMITED_ALLOWANCE, consentView, type ConsentView } from '@/lib/spare-chain/consent';
import { humanizeError } from '@/lib/spare-chain/errors';
import { txStep, useSpareDeployment, useSpareTx } from '@/lib/spare-chain/hooks';
import {
  LINK_DEADLINE_SECONDS,
  PERMIT2_AMOUNT,
  PERMIT2_TTL_SECONDS,
  linkTypedData,
  loadPendingLinks,
  removePendingLink,
  savePendingLinks,
  upsertPendingLink,
  type PendingLink,
} from '@/lib/spare-chain/link';
import { WalletPicker } from '@/components/retro/WalletPicker';
import {
  BEVEL_RAISED,
  FONT_CHROME,
  FONT_DISPLAY,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  TEXTURE,
  GlyphCheck,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloDivider,
  HoloHero,
  HoloInput,
  HoloLabel,
  HoloNotice,
  HoloPanel,
  HoloProgress,
  HoloSparkle,
  HoloStar,
  HoloStat,
  HoloTable,
  HoloText,
  HoloTitle,
  HoloWindowBody,
  pixelPath,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';
import { AddrLink, ChainNote, DeployingNotice, Hint, MutedWell, SpareGate, TxStatus } from './spare/SpareUi';
import { HINT, ROW, STACK } from './spare/styles';

const chainId = SPARE_CHAIN_ID;

/** apps-a strings for the module-level helpers below (follows the live language). */
const tf = getT('apps-a');

const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------- link signature check ---------------------------- */

const ERC1271_MAGIC = '0x1626ba7e';
const erc1271Abi = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

const UNDEPLOYED_SMART_WALLET = () => tf('linkWallet.sig.undeployed');

/**
 * Check a Link signature the way RuleRegistry does (OZ SignatureChecker):
 * a plain 65-byte ECDSA signature by `wallet`, or ERC-1271 isValidSignature on
 * the wallet's DEPLOYED code. No ERC-6492 / ERC-8010 counterfactual magic —
 * the contract has none. Returns the exact bytes to submit, or why not.
 */
async function checkLinkSignature(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  wallet: Address,
  typed: ReturnType<typeof linkTypedData>,
  raw: Hex,
): Promise<{ signature: Hex } | { error: string }> {
  const code = await client.getCode({ address: wallet });
  const deployed = !!code && code !== '0x';
  let signature = raw;
  if (isErc6492Signature(signature) || isErc8010Signature(signature)) {
    // A wrapper only helps a verifier that can deploy/delegate first; the
    // contract cannot. Unwrap for an already-deployed wallet, refuse otherwise.
    if (!deployed) return { error: UNDEPLOYED_SMART_WALLET() };
    signature = isErc6492Signature(signature) ? parseErc6492Signature(signature).signature : parseErc8010Signature(signature).signature;
  }
  if (size(signature) === 65) {
    try {
      const recovered = await recoverTypedDataAddress({ ...typed, signature });
      if (sameAddress(recovered, wallet)) return { signature };
    } catch {
      /* not an ECDSA signature — try ERC-1271 */
    }
  }
  if (!deployed) {
    return { error: size(signature) === 65 ? tf('linkWallet.sig.mismatch') : UNDEPLOYED_SMART_WALLET() };
  }
  try {
    const magic = (await client.readContract({
      address: wallet,
      abi: erc1271Abi,
      functionName: 'isValidSignature',
      args: [hashTypedData(typed), signature],
    } as never)) as Hex;
    if (magic?.toLowerCase() === ERC1271_MAGIC) return { signature };
  } catch {
    /* no ERC-1271 or it reverted */
  }
  return { error: tf('linkWallet.sig.erc1271') };
}

/* --------------------------------- rows ----------------------------------- */

type WalletRow = {
  address: Address;
  linkedAt?: bigint;
  lastAccrued?: bigint;
  consent: ConsentView;
  isMe: boolean;
} & Record<string, unknown>;

/** A block as its number and (when the head is known) a rough age: { '#76,652,462', '≈2h ago' }. */
function blockParts(block: bigint | undefined, head: bigint | undefined): { num: string; ago: string | null } | null {
  if (block == null || block === 0n) return null;
  const num = `#${block.toLocaleString()}`;
  if (!head || head < block) return { num, ago: null };
  const secs = Number((head - block) / BLOCKS_PER_SECOND);
  const ago =
    secs < 90
      ? tf('linkWallet.age.s', { n: secs })
      : secs < 5400
        ? tf('linkWallet.age.m', { n: Math.round(secs / 60) })
        : secs < 172800
          ? tf('linkWallet.age.h', { n: Math.round(secs / 3600) })
          : tf('linkWallet.age.d', { n: Math.round(secs / 86400) });
  return { num, ago };
}

function blockAge(block: bigint | undefined, head: bigint | undefined): string {
  const p = blockParts(block, head);
  if (!p) return tf('linkWallet.never');
  return p.ago ? `${p.num} · ${p.ago}` : p.num;
}

/* ─────────────────────────────── local atoms ─────────────────────────────── */

/** Win98 data tones -> Holo tones. */
const TONE_MAP: Record<string, HoloTone> = { up: 'good', down: 'bad', warn: 'warn', info: 'info', mono: 'ink', muted: 'muted' };
const holoTone = (t: string): HoloTone => TONE_MAP[t] ?? 'info';

/** Crisp pixel icon from '1'/'0' rows. */
function Px({ rows, scale = 2, color = HOLO.ink }: { rows: readonly string[]; scale?: number; color?: string }) {
  const w = rows[0].length;
  const h = rows.length;
  return (
    <svg aria-hidden focusable="false" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" style={{ display: 'block', flexShrink: 0 }}>
      <path d={pixelPath(rows)} fill={color} />
    </svg>
  );
}

const PX_WALLET = ['0111111100', '1000000010', '1111111111', '1000000001', '1000001111', '1000001011', '1000001111', '1111111111'];
const PX_LOCK = ['00111100', '01000010', '01000010', '11111111', '11111111', '11100111', '11100111', '11111111'];
const PX_UNLINK = ['0110000000', '1001000000', '1000100000', '0100010000', '0000000000', '0000100010', '0000010001', '0000001001', '0000000110'];
const PX_ARROW = ['000001000', '000001100', '111111110', '111111111', '111111110', '000001100', '000001000'];

/** The little icon + caption strip. */
function FeatureStrip({ items }: { items: { icon: readonly string[]; text: ReactNode }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: 6, marginTop: 2 }}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: i ? '0 12px' : '0 12px 0 0',
            borderLeft: i ? `1px solid ${HOLO.ink}` : 'none',
          }}
        >
          <Px rows={it.icon} />
          <span style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.25, color: HOLO.ink }}>{it.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Numbered pixel key (deep indigo), or a chrome key with a check once done. */
function NumTile({ n, ok = false, size: box = 24 }: { n: number; ok?: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: box,
        height: box,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: ok
          ? `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.chrome}`
          : `${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%)`,
        boxShadow: ok ? `0 0 0 1px ${HOLO.ink}, ${BEVEL_RAISED}` : `0 0 0 1px ${HOLO.ink}, inset 1px 1px 0 0 #7B63E0`,
        color: HOLO.onScreen,
        fontFamily: FONT_DISPLAY,
        fontSize: box >= 24 ? 11 : 9,
        lineHeight: 1,
        paddingTop: 1,
      }}
    >
      {ok ? <GlyphCheck scale={2} /> : n}
    </span>
  );
}

/** Section heading inside a card: optional step number, Jersey title, pixel rule, optional count. */
function StepHead({ n, children, right }: { n?: number; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {n != null ? <NumTile n={n} size={22} /> : <HoloSparkle size={12} glow={false} color={HOLO.ink} />}
      <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 19, lineHeight: 1.05, color: INK.body }}>{children}</span>
      <div aria-hidden style={{ flex: '1 1 24px', height: 1, backgroundImage: `linear-gradient(90deg, ${HOLO.inkFaint} 50%, transparent 50%)`, backgroundSize: '4px 1px' }} />
      {right != null && <HoloBadge label={right} tone="info" dot={false} />}
    </div>
  );
}

/** Big connect call-to-action (same wallet picker the tray uses). */
function ConnectCard({ why }: { why: ReactNode }) {
  const { t } = useTranslation('apps-a');
  const [open, setOpen] = useState(false);
  return (
    <HoloCard title={t('shell:common.wallet')} accent={t('shell:common.notConnected')} accentTone="warn" bar="lilac">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <HoloStar size={64} />
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <HoloTitle as="h2" size="sm">{t('shell:common.connectWallet')}</HoloTitle>
          <HoloText size="sm">{why}</HoloText>
        </div>
      </div>
      <div style={ROW}>
        <HoloButton variant="primary" size="lg" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? t('shell:common.hideWallets') : t('shell:common.connectWallet')}
        </HoloButton>
        <span style={HINT}>{t('shell:common.walletPillHint')}</span>
      </div>
      {open && <WalletPicker variant="holo" onClose={() => setOpen(false)} />}
    </HoloCard>
  );
}

const LINK_STYLE = {
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  fontSize: 12,
  color: INK.link,
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
} as const;

/* ── wallet-table cells: a primary line plus a quiet second line, never an ellipsis mid-fact ── */

const CELL_STACK = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, minWidth: 0, maxWidth: '100%' } as const;
const CELL_LINE = { display: 'block', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

/** Address link, with a "THIS WALLET" chip on its own line for the connected wallet. */
function WalletCell({ address, isMe }: { address: Address; isMe: boolean }) {
  const { t } = useTranslation('apps-a');
  return (
    <span style={CELL_STACK}>
      <a href={addressUrl(address)} target="_blank" rel="noopener noreferrer" title={address} style={{ ...LINK_STYLE, ...CELL_LINE }}>
        {shortAddr(address)}
      </a>
      {isMe && <HoloBadge label={t('linkWallet.thisWalletChip')} tone="holo" dot={false} title={t('linkWallet.thisWalletChipTitle')} />}
    </span>
  );
}

/** Block number on top, "≈2h ago" as a muted second line (or a muted "never"). */
function BlockCell({ block, head }: { block: bigint | undefined; head: bigint | undefined }) {
  const { t } = useTranslation('apps-a');
  const p = blockParts(block, head);
  if (!p) return <span style={{ ...CELL_LINE, color: INK.muted }}>{t('linkWallet.never')}</span>;
  return (
    <span style={CELL_STACK} title={blockAge(block, head)}>
      <span style={{ ...CELL_LINE, fontWeight: 700, color: INK.body }}>{p.num}</span>
      {p.ago && <span style={{ ...CELL_LINE, fontSize: 10.5, lineHeight: 1.2, color: INK.muted }}>{p.ago}</span>}
    </span>
  );
}

/* --------------------------------- app ------------------------------------ */

export function LinkWalletApp() {
  const { t } = useTranslation('apps-a');
  const { isConnected } = useAccount();
  return (
    <HoloWindowBody gap={14}>
      <HoloHero
        art="/icons/spare/link-wallet.png"
        kicker={t('linkWallet.hero.kicker')}
        title={t('shell:appNames.link-wallet')}
        subtitle={t('linkWallet.hero.subtitle')}
        description={t('linkWallet.hero.description')}
        aside={
          <>
            <HoloBadge label={isConnected ? t('shell:common.connected') : t('linkWallet.hero.noWallet')} tone={isConnected ? 'good' : 'warn'} variant="solid" dot />
            <HoloBadge label="RuleRegistry · Permit2" tone="info" dot={false} />
          </>
        }
        seed={27}
        compact={isConnected}
      >
        {!isConnected && (
          <FeatureStrip
            items={[
              { icon: PX_WALLET, text: t('linkWallet.features.onlyLinked') },
              { icon: PX_LOCK, text: t('linkWallet.features.perWallet') },
              { icon: PX_UNLINK, text: t('linkWallet.features.unlinkAnyTime') },
            ]}
          />
        )}
      </HoloHero>
      {isConnected ? (
        <SpareGate needsWallet why={t('linkWallet.connectWhy')}>
          <LinkWalletBody />
        </SpareGate>
      ) : (
        <LinkSignedOut />
      )}
    </HoloWindowBody>
  );
}

/* ───────────────────────────── no wallet: preview ─────────────────────────── */

/** Translation keys, translated at render. */
const EXAMPLE_WALLETS: { name: string; note: string; label: string; tone: HoloTone }[] = [
  { name: tKey('linkWallet.example.walletA'), note: tKey('linkWallet.example.noteA'), label: tKey('linkWallet.status.authorized'), tone: 'good' },
  { name: tKey('linkWallet.example.walletB'), note: tKey('linkWallet.example.noteB'), label: tKey('linkWallet.status.notAuthorized'), tone: 'bad' },
  { name: tKey('linkWallet.example.walletOther'), note: tKey('linkWallet.example.noteOther'), label: tKey('linkWallet.status.notLinked'), tone: 'muted' },
];

/** Translation keys, translated at render. */
const HOW_IT_WORKS: { title: string; body: string }[] = [
  { title: tKey('linkWallet.how.connect.title'), body: tKey('linkWallet.how.connect.body') },
  { title: tKey('linkWallet.how.link.title'), body: tKey('linkWallet.how.link.body') },
  { title: tKey('linkWallet.how.authorize.title'), body: tKey('linkWallet.how.authorize.body') },
];

function LinkSignedOut() {
  const { t } = useTranslation('apps-a');
  const { deployed, checking, error } = useSpareDeployment();
  return (
    <>
      <HoloCard title={t('linkWallet.example.title')} accent={t('shell:common.example')} accentTone="ink">
        <HoloText size="sm" tone="muted">
          {t('linkWallet.example.intro')}
        </HoloText>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {EXAMPLE_WALLETS.map((w) => (
              <HoloPanel key={w.name} variant="sunken" padding="7px 9px" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Px rows={PX_WALLET} color={w.tone === 'muted' ? HOLO.inkMuted : HOLO.ink} />
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, lineHeight: 1.05, color: w.tone === 'muted' ? INK.muted : INK.body }}>{t(w.name)}</div>
                  <div style={{ ...HINT, fontSize: 10.5, lineHeight: 1.35 }}>{t(w.note)}</div>
                </div>
                <HoloBadge label={t(w.label)} tone={w.tone} />
              </HoloPanel>
            ))}
          </div>
          <div aria-hidden style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, margin: '0 auto' }}>
            <HoloBadge label={t('linkWallet.example.roundUp')} variant="solid" />
            <Px rows={PX_ARROW} scale={3} />
          </div>
          <HoloPanel variant="glass" padding={12} style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <HoloStar size={52} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 21, lineHeight: 1.05, color: INK.body }}>{t('linkWallet.example.account')}</div>
              <div style={{ ...HINT, marginTop: 3 }}>{t('linkWallet.example.accountNote')}</div>
            </div>
          </HoloPanel>
        </div>
      </HoloCard>

      <HoloCard title={t('linkWallet.how.title')} bar="lilac">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          {HOW_IT_WORKS.map((s, i) => (
            <HoloPanel key={s.title} variant="flat" padding="10px 11px" gap={6}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <NumTile n={i + 1} />
                <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 19, lineHeight: 1.05, color: INK.body }}>{t(s.title)}</span>
              </div>
              <span style={HINT}>{t(s.body)}</span>
            </HoloPanel>
          ))}
        </div>
      </HoloCard>

      {!deployed && !checking && <DeployingNotice checking={false} error={error} />}
      <ConnectCard why={t('linkWallet.connectWhy')} />
    </>
  );
}

/* ───────────────────────────── connected: body ───────────────────────────── */

function LinkWalletBody() {
  const { t } = useTranslation('apps-a');
  const { address, chainId: walletChainId } = useAccount();
  const me = address as Address;
  const client = usePublicClient({ chainId });
  const { data: head } = useBlockNumber({ chainId, query: { refetchInterval: 60_000 } });
  const consentTx = useSpareTx();
  const linkTx = useSpareTx();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();

  const [confirmUnlink, setConfirmUnlink] = useState<Address | null>(null);
  const [accountDraft, setAccountDraft] = useState('');
  const [signState, setSignState] = useState<{ phase: 'idle' | 'working' | 'done' | 'error'; msg?: string }>({ phase: 'idle' });
  const [pending, setPending] = useState<PendingLink[]>(() => loadPendingLinks());

  // A different wallet connected: forget per-wallet UI state.
  useEffect(() => {
    setConfirmUnlink(null);
    setSignState({ phase: 'idle' });
    consentTx.reset();
    linkTx.reset();
    setPending(loadPendingLinks());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  /* ── account-level reads ── */
  const base = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'walletsOf', args: [me], chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'accountOf', args: [me], chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'MAX_WALLETS', chainId },
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'ruleOf', args: [me], chainId },
    ],
    query: { enabled: !!me, refetchInterval: 30_000 },
  });
  const wallets = useMemo(() => (base.data?.[0] ?? []) as readonly Address[], [base.data]);
  const feedsAccount = base.data?.[1] as Address | undefined;
  const maxWallets = base.data ? Number(base.data[2]) : 8;
  const meIsLinked = !!feedsAccount && feedsAccount !== zeroAddress;
  const meFeedsSelf = meIsLinked && sameAddress(feedsAccount, me);
  // Weekly caps the allowances are judged against: this account's (for its
  // wallets) and, when the connected wallet feeds another account, that one's.
  const myCap = base.data ? BigInt(base.data[3].weeklyCap) : undefined;
  const feedsOther = meIsLinked && !meFeedsSelf;
  const feedsRule = useReadContract({
    address: SPARE.RuleRegistry,
    abi: ruleRegistryAbi,
    functionName: 'ruleOf',
    args: [feedsAccount ?? zeroAddress],
    chainId,
    query: { enabled: feedsOther, refetchInterval: 30_000 },
  });
  const feedsCap = feedsRule.data ? BigInt((feedsRule.data as { weeklyCap: bigint | number }).weeklyCap) : undefined;

  /* ── per-wallet reads: the account's wallets plus the connected wallet ── */
  const set = useMemo(() => {
    const out: Address[] = [me];
    for (const w of wallets) if (!out.some((x) => sameAddress(x, w))) out.push(w);
    return out;
  }, [me, wallets]);

  const per = useReadContracts({
    allowFailure: true,
    contracts: set.flatMap((w) => [
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'linkedAt', args: [w], chainId } as const,
      { address: SPARE.SweepExecutor, abi: sweepExecutorAbi, functionName: 'lastAccruedBlock', args: [w], chainId } as const,
      { address: EXTERNAL.USDG, abi: erc20Abi, functionName: 'allowance', args: [w, EXTERNAL.Permit2], chainId } as const,
      { address: EXTERNAL.Permit2, abi: permit2Abi, functionName: 'allowance', args: [w, EXTERNAL.USDG, SPARE.SweepExecutor], chainId } as const,
    ]),
    query: { enabled: set.length > 0, refetchInterval: 30_000 },
  });

  const infoFor = (w: Address, weeklyCap: bigint | undefined) => {
    const i = set.findIndex((x) => sameAddress(x, w));
    if (i < 0 || !per.data) return { consent: consentView(undefined, { now: nowSec() }) };
    const linkedAt = per.data[i * 4]?.result as bigint | undefined;
    const lastAccrued = per.data[i * 4 + 1]?.result as bigint | undefined;
    const erc20 = per.data[i * 4 + 2]?.result as bigint | undefined;
    const p2 = per.data[i * 4 + 3]?.result as readonly [bigint, number, number] | undefined;
    const consent = consentView(erc20 != null && p2 ? { erc20, p2Amount: p2[0], p2Expiration: Number(p2[1]) } : undefined, { now: nowSec(), weeklyCap });
    return { linkedAt, lastAccrued, consent, erc20 };
  };

  // The connected wallet's pulls count against the cap of the account it feeds.
  const mine = infoFor(me, feedsOther ? feedsCap : myCap);

  /* ── pending link handoffs ── */
  const toSubmit = pending.filter((p) => sameAddress(p.account, me));
  const awaiting = pending.filter((p) => sameAddress(p.wallet, me));
  const handoffChecks = useReadContracts({
    allowFailure: true,
    contracts: toSubmit.flatMap((p) => [
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'nonces', args: [p.wallet], chainId } as const,
      { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'accountOf', args: [p.wallet], chainId } as const,
    ]),
    query: { enabled: toSubmit.length > 0 },
  });

  const writePending = (next: PendingLink[]) => {
    setPending(next);
    savePendingLinks(next);
  };

  /* ── actions ── */
  const authorize = () => {
    const steps = [];
    if (!(mine.erc20 != null && mine.erc20 >= UNLIMITED_ALLOWANCE)) {
      steps.push(txStep(t('linkWallet.tx.approveUsdg'), {
        address: EXTERNAL.USDG, abi: erc20Abi, functionName: 'approve', args: [EXTERNAL.Permit2, maxUint256],
      }));
    }
    steps.push(txStep(t('linkWallet.tx.allowExecutor'), {
      address: EXTERNAL.Permit2, abi: permit2Abi, functionName: 'approve',
      args: [EXTERNAL.USDG, SPARE.SweepExecutor, PERMIT2_AMOUNT, nowSec() + PERMIT2_TTL_SECONDS],
    }));
    consentTx.run(steps);
  };

  const revoke = () =>
    consentTx.run([txStep(t('linkWallet.tx.revoke'), {
      // amount 0 + expiration 0 (= "now" in Permit2) kills the allowance.
      address: EXTERNAL.Permit2, abi: permit2Abi, functionName: 'approve', args: [EXTERNAL.USDG, SPARE.SweepExecutor, 0n, 0],
    })]);

  const linkSelf = () =>
    linkTx.run([txStep(t('linkWallet.tx.linkSelf'), { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'linkSelf' })]);

  const unlink = (w: Address) => {
    setConfirmUnlink(null);
    linkTx.run([txStep(t('linkWallet.tx.unlink', { addr: shortAddr(w) }), { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'unlink', args: [w] })]);
  };

  const submitLink = (p: PendingLink) =>
    linkTx.run(
      [txStep(t('linkWallet.tx.link', { addr: shortAddr(p.wallet) }), {
        address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'linkWallet', args: [p.wallet, p.deadline, p.signature],
      })],
      () => writePending(removePendingLink(loadPendingLinks(), p.account, p.wallet)),
    );

  const invalidate = () =>
    linkTx.run(
      [txStep(t('linkWallet.tx.invalidate'), { address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'invalidateNonce' })],
      () => writePending(loadPendingLinks().filter((p) => !sameAddress(p.wallet, me))),
    );

  const draftTrim = accountDraft.trim();
  const draftValid = isAddress(draftTrim, { strict: false });
  const draftIsMe = draftValid && sameAddress(draftTrim, me);

  const signLink = async () => {
    if (!client || !draftValid || draftIsMe) return;
    const account = getAddress(draftTrim);
    setSignState({ phase: 'working', msg: t('linkWallet.sign.readingNonce') });
    try {
      if (walletChainId !== chainId) {
        setSignState({ phase: 'working', msg: t('linkWallet.sign.switching') });
        await switchChainAsync({ chainId });
      }
      // Fresh reads, not the cached multicall: the signature binds the nonce.
      // (Casts: viem's read-parameter type misresolves under this repo's non-strict TS config.)
      const [nonce, current] = (await Promise.all([
        client.readContract({ address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'nonces', args: [me] } as never),
        client.readContract({ address: SPARE.RuleRegistry, abi: ruleRegistryAbi, functionName: 'accountOf', args: [me] } as never),
      ])) as [bigint, Address];
      if (current !== zeroAddress) {
        setSignState({ phase: 'error', msg: t('linkWallet.sign.alreadyLinked', { addr: shortAddr(current) }) });
        return;
      }
      const deadline = BigInt(nowSec() + LINK_DEADLINE_SECONDS);
      const typed = linkTypedData(account, me, nonce, deadline);
      setSignState({ phase: 'working', msg: t('linkWallet.sign.signInWallet') });
      const raw = await signTypedDataAsync({ ...typed, account: me });
      // Verify exactly as RuleRegistry will (ECDSA, else ERC-1271 on deployed
      // code) — NOT viem's verifyTypedData, which also accepts ERC-6492
      // signatures from undeployed smart wallets that the contract rejects.
      setSignState({ phase: 'working', msg: t('linkWallet.sign.verifying') });
      const checked = await checkLinkSignature(client, me, typed, raw);
      if ('error' in checked) {
        setSignState({ phase: 'error', msg: checked.error });
        return;
      }
      const signature = checked.signature;
      writePending(upsertPendingLink(loadPendingLinks(), { account, wallet: me, nonce, deadline, signature, createdAt: Date.now() }, nowSec()));
      setAccountDraft('');
      setSignState({ phase: 'done', msg: t('linkWallet.sign.done', { addr: shortAddr(account) }) });
    } catch (e) {
      setSignState({ phase: 'error', msg: humanizeError(e) });
    }
  };

  /* ── table ── */
  const rows: WalletRow[] = wallets.map((w) => {
    const info = infoFor(w, myCap);
    return { address: w, linkedAt: info.linkedAt, lastAccrued: info.lastAccrued, consent: info.consent, isMe: sameAddress(w, me) };
  });

  // Column floors sum to 662px (< the 680px minWidth): the address never truncates,
  // the two-line block cells sit comfortably, and only the fr slack flexes.
  const cols: HoloColumn<WalletRow>[] = [
    { key: 'address', label: t('shell:common.wallet'), width: 'minmax(136px, 1fr)', wrap: true, render: (r) => <WalletCell address={r.address} isMe={r.isMe} /> },
    { key: 'linkedAt', label: t('linkWallet.cols.linkedAt'), width: 'minmax(112px, 1fr)', wrap: true, render: (r) => <BlockCell block={r.linkedAt} head={head} /> },
    // The executor's cursor moves on every accrual — including a $0 one that
    // pulled nothing — so it says how far payments were SCANNED, not collected.
    { key: 'lastAccrued', label: t('linkWallet.cols.scanned'), width: 'minmax(132px, 1fr)', wrap: true, render: (r) => <BlockCell block={r.lastAccrued} head={head} /> },
    {
      // consent.label / consent.detail come from lib/spare-chain/consent.ts, already in the live language.
      key: 'consent', label: t('linkWallet.cols.consent'), width: 150,
      render: (r) => <span title={r.consent.detail}><HoloBadge label={r.consent.label} tone={holoTone(r.consent.tone)} /></span>,
    },
    {
      key: 'actions', label: t('linkWallet.cols.actions'), width: 'minmax(132px, 1fr)', wrap: true,
      render: (r) =>
        confirmUnlink && sameAddress(confirmUnlink, r.address) ? (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            <HoloButton size="sm" variant="danger" disabled={linkTx.busy} onClick={() => unlink(r.address)}>{t('linkWallet.confirmUnlink')}</HoloButton>
            <HoloButton size="sm" onClick={() => setConfirmUnlink(null)}>{t('shell:common.cancel')}</HoloButton>
          </span>
        ) : (
          <HoloButton size="sm" disabled={linkTx.busy} onClick={() => setConfirmUnlink(r.address)}>{t('linkWallet.unlink')}</HoloButton>
        ),
    },
  ];

  const loading = base.isLoading;
  const role = loading
    ? t('linkWallet.role.reading')
    : meFeedsSelf
      ? t('linkWallet.role.accountSpender')
      : meIsLinked
        ? t('linkWallet.role.spendingWallet')
        : t('linkWallet.role.account');
  const slots = Math.min(Math.max(maxWallets, 1), 24);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ChainNote />
      {base.error && <Hint warn>{t('linkWallet.registryError', { error: humanizeError(base.error) })}</Hint>}

      {/* ─── The connected wallet: its role and its own consent ─── */}
      <HoloCard title={t('linkWallet.connected.title')} icon={<Px rows={PX_WALLET} />} accent={role} accentTone="info">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, alignItems: 'end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <HoloLabel>{t('linkWallet.connected.thisWallet')}</HoloLabel>
            <HoloPanel variant="sunken" padding="8px 10px">
              <AddrLink address={me} full />
            </HoloPanel>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <HoloStat size="lg" label={t('linkWallet.connected.feeding')} value={`${wallets.length}/${maxWallets}`} tone={wallets.length ? 'holo' : 'ink'} />
            <HoloProgress
              value={(wallets.length / Math.max(maxWallets, 1)) * 100}
              segments={slots}
              height={12}
              ariaLabel={t('linkWallet.connected.slotsAria', { n: wallets.length, max: maxWallets })}
            />
          </div>
        </div>
        {meIsLinked && !meFeedsSelf && (
          <Hint>
            <Trans
              t={t}
              i18nKey="linkWallet.connected.spender"
              components={{ b: <strong style={{ color: INK.info }} />, addr: <AddrLink address={feedsAccount!} /> }}
            />
          </Hint>
        )}
        <div style={ROW}>
          {!meIsLinked && !loading && (
            <HoloButton variant="primary" disabled={linkTx.busy || wallets.length >= maxWallets} onClick={linkSelf}>{t('linkWallet.connected.linkSelf')}</HoloButton>
          )}
          {meIsLinked && (
            confirmUnlink && sameAddress(confirmUnlink, me) ? (
              <>
                <HoloButton variant="danger" disabled={linkTx.busy} onClick={() => unlink(me)}>{t('linkWallet.connected.confirmUnlinkSelf')}</HoloButton>
                <HoloButton onClick={() => setConfirmUnlink(null)}>{t('shell:common.cancel')}</HoloButton>
              </>
            ) : (
              <HoloButton disabled={linkTx.busy} onClick={() => setConfirmUnlink(me)}>{t('linkWallet.connected.unlinkSelf')}</HoloButton>
            )
          )}
          <span style={{ ...HINT, flex: '1 1 200px' }}>
            {meIsLinked
              ? t('linkWallet.connected.linkedHint', { linked: blockAge(mine.linkedAt, head), scanned: blockAge(mine.lastAccrued, head) })
              : t('linkWallet.connected.linkSelfHint')}
          </span>
        </div>
        <TxStatus state={linkTx.state} onDismiss={linkTx.reset} />

        <HoloDivider variant="etched" />
        <StepHead>{t('linkWallet.connected.consentHead')}</StepHead>
        <div style={ROW}>
          <HoloBadge label={mine.consent.label} tone={holoTone(mine.consent.tone)} size="md" />
          <span style={{ ...HINT, flex: 1, minWidth: 200 }}>{mine.consent.detail}</span>
        </div>
        <div style={ROW}>
          <HoloButton
            variant={meIsLinked ? 'primary' : 'secondary'}
            disabled={consentTx.busy || mine.consent.state === 'reading'}
            onClick={authorize}
          >
            {mine.consent.pullable ? t('linkWallet.connected.reauthorize') : t('linkWallet.connected.authorize')}
          </HoloButton>
          {/* Gated on the Permit2 leg alone: with USDG→Permit2 revoked elsewhere the
              allowance is dormant, not dead — any new approval to Permit2 revives it. */}
          <HoloButton disabled={consentTx.busy || !mine.consent.p2Live} onClick={revoke}>{t('linkWallet.connected.revoke')}</HoloButton>
        </div>
        <span style={HINT}>
          {t('linkWallet.connected.consentHint')}
        </span>
        <TxStatus state={consentTx.state} onDismiss={consentTx.reset} />
      </HoloCard>

      {/* ─── Wallets feeding this account ─── */}
      <HoloCard title={t('linkWallet.connected.feeding')} accent={t('linkWallet.list.count', { n: wallets.length, max: maxWallets })} accentTone="info">
        {loading ? (
          <MutedWell>{t('linkWallet.list.reading')}</MutedWell>
        ) : wallets.length === 0 ? (
          <MutedWell>
            {t('linkWallet.list.empty')}
          </MutedWell>
        ) : (
          <HoloTable columns={cols} rows={rows} rowKey={(r) => r.address} minWidth={680} ariaLabel={t('linkWallet.connected.feeding')} />
        )}
        {wallets.length > 0 && <Hint>{t('linkWallet.list.consentNote')}</Hint>}
      </HoloCard>

      {/* ─── Link another wallet: sign there, submit here ─── */}
      <HoloCard title={t('linkWallet.another.title')} accent={t('linkWallet.another.steps')} accentTone="info">
        {toSubmit.length > 0 && (
          <div style={STACK}>
            <StepHead n={2} right={t('linkWallet.another.signedCount', { count: toSubmit.length })}>{t('linkWallet.another.step2')}</StepHead>
            {toSubmit.map((p, i) => {
              const nonceNow = handoffChecks.data?.[i * 2]?.result as bigint | undefined;
              const linkedTo = handoffChecks.data?.[i * 2 + 1]?.result as Address | undefined;
              const expired = p.deadline <= BigInt(nowSec());
              const stale = nonceNow != null && nonceNow !== p.nonce;
              const taken = !!linkedTo && linkedTo !== zeroAddress;
              const problem = taken
                ? sameAddress(linkedTo, me) ? t('linkWallet.another.linkedHere') : t('linkWallet.another.linkedTo', { addr: shortAddr(linkedTo) })
                : expired ? t('linkWallet.another.expired')
                : stale ? t('linkWallet.another.stale')
                : null;
              const minsLeft = Math.max(0, Math.round((Number(p.deadline) - nowSec()) / 60));
              return (
                <HoloPanel key={`${p.wallet}`} variant="sunken" padding="8px 10px" style={ROW}>
                  <AddrLink address={p.wallet} />
                  <span style={problem ? { ...HINT, color: INK.warn, fontWeight: 700 } : HINT}>{problem ?? t('linkWallet.another.signedExpires', { min: minsLeft })}</span>
                  <div style={{ flex: 1 }} />
                  <HoloButton variant="primary" disabled={!!problem || linkTx.busy} onClick={() => submitLink(p)}>{t('linkWallet.another.submit')}</HoloButton>
                  <HoloButton size="sm" onClick={() => writePending(removePendingLink(loadPendingLinks(), p.account, p.wallet))}>{t('linkWallet.another.discard')}</HoloButton>
                </HoloPanel>
              );
            })}
          </div>
        )}

        <StepHead n={1}>{t('linkWallet.another.step1')}</StepHead>
        {meIsLinked ? (
          <Hint>
            {meFeedsSelf ? t('linkWallet.another.alreadySelf') : t('linkWallet.another.alreadyOther', { addr: shortAddr(feedsAccount) })}
          </Hint>
        ) : (
          <>
            <Hint>
              {t('linkWallet.another.howTo')}
            </Hint>
            <div style={ROW}>
              <HoloLabel as="label" htmlFor="lw-account" font="chrome" style={{ fontSize: 18, color: INK.body }}>{t('linkWallet.another.account')}</HoloLabel>
              <HoloInput
                id="lw-account"
                value={accountDraft}
                onChange={(e) => { setAccountDraft(e.target.value); if (signState.phase !== 'working') setSignState({ phase: 'idle' }); }}
                placeholder={t('linkWallet.another.placeholder')}
                spellCheck={false}
                autoComplete="off"
                invalid={!!draftTrim && !draftValid}
                fieldStyle={{ flex: '1 1 260px' }}
              />
              <HoloButton variant="primary" disabled={!draftValid || draftIsMe || signState.phase === 'working'} onClick={signLink}>{t('linkWallet.another.sign')}</HoloButton>
            </div>
            {draftTrim && !draftValid && <Hint warn>{t('linkWallet.another.invalidAddress')}</Hint>}
            {draftIsMe && <Hint warn>{t('linkWallet.another.isMe')}</Hint>}
          </>
        )}
        {signState.phase === 'working' && (
          <>
            <Hint>{signState.msg}</Hint>
            <HoloProgress indeterminate height={10} ariaLabel={signState.msg ?? t('linkWallet.sign.working')} />
          </>
        )}
        {signState.phase === 'error' && <Hint warn>{signState.msg}</Hint>}
        {signState.phase === 'done' && <HoloNotice tone="success" compact>{signState.msg}</HoloNotice>}

        {awaiting.length > 0 && (
          <div style={STACK}>
            <StepHead right={`${awaiting.length}`}>{t('linkWallet.another.awaitingHead')}</StepHead>
            {awaiting.map((p) => (
              <HoloPanel key={`${p.account}`} variant="sunken" padding="8px 10px" style={ROW}>
                <span style={HINT}>{t('linkWallet.another.forAccount')}</span>
                <AddrLink address={p.account} />
                <span style={HINT}>
                  {p.deadline <= BigInt(nowSec())
                    ? t('linkWallet.another.expiredShort')
                    : t('linkWallet.another.expiresIn', { min: Math.max(0, Math.round((Number(p.deadline) - nowSec()) / 60)) })}
                </span>
                <div style={{ flex: 1 }} />
                <HoloButton size="sm" onClick={() => writePending(removePendingLink(loadPendingLinks(), p.account, p.wallet))}>{t('linkWallet.another.discard')}</HoloButton>
              </HoloPanel>
            ))}
            <div style={ROW}>
              <HoloButton size="sm" disabled={linkTx.busy} onClick={invalidate}>{t('linkWallet.another.invalidate')}</HoloButton>
              <span style={{ ...HINT, flex: '1 1 220px' }}>{t('linkWallet.another.invalidateHint')}</span>
            </div>
          </div>
        )}
      </HoloCard>

      <HoloCard title={t('linkWallet.meaning.title')} accent={t('shell:common.onChain')} accentTone="muted" bar="lilac">
        <HoloText size="sm">
          <Trans
            t={t}
            i18nKey="linkWallet.meaning.payments"
            components={{ info: <strong style={{ color: INK.info }} />, warn: <strong style={{ color: INK.warn }} /> }}
          />
        </HoloText>
        <HoloText size="sm">
          <Trans t={t} i18nKey="linkWallet.meaning.unlink" components={{ info: <strong style={{ color: INK.info }} /> }} />
        </HoloText>
      </HoloCard>
    </div>
  );
}

export default LinkWalletApp;
