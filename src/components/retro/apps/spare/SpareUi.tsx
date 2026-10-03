/**
 * Shared chrome for the seven Spare apps: the empty states (contracts
 * deploying, no wallet), the write-status line with its Blockscout link, and
 * the small layout atoms every app repeats. Built on the Spare Holo system
 * (components/retro/holo): pastel canvas, dialog cards, deep-indigo screens.
 */
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { WalletPicker } from '@/components/retro/WalletPicker';
import {
  FONT_TEXT,
  HOLO,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloMessageIcon,
  HoloPanel,
  HoloProgress,
  HoloSparkle,
  HoloStar,
  HoloTitle,
  HoloWindowBody,
} from '@/components/retro/holo';
import { SPARE, SPARE_CHAIN_ID, addressUrl, shortAddr, txUrl } from '@/lib/spare-chain/addresses';
import { useSpareAccount, useSpareDeployment, type SpareAccountView, type TxState } from '@/lib/spare-chain/hooks';
import { Trans, tKey, useTranslation } from '@/i18n';
import { HINT, ROW } from './styles';

/* --------------------------------- atoms ---------------------------------- */

/** The app's pastel canvas (HoloWindowBody). */
export function AppCanvas({ children }: { children: ReactNode }) {
  return <HoloWindowBody>{children}</HoloWindowBody>;
}

/** Soft pastel well behind every empty / loading / "nothing to show" line. */
const MUTED_WELL_BG = 'linear-gradient(160deg, #FFFDFB 0%, #FFF5EF 46%, #F7F1FF 100%)';
/** Halftone that drifts in from the bottom-right corner, faded out before it reaches the copy. */
const MUTED_WELL_DOTS: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 0,
  width: '60%',
  height: '100%',
  zIndex: 0,
  pointerEvents: 'none',
  backgroundImage: 'radial-gradient(circle, rgba(107,79,224,.22) 0 1px, transparent 1.6px)',
  backgroundSize: '6px 6px',
  WebkitMaskImage: 'linear-gradient(300deg, #000 0%, transparent 62%)',
  maskImage: 'linear-gradient(300deg, #000 0%, transparent 62%)',
};

/**
 * The state shown for anything not (yet) knowable — "Reading CashPark…",
 * "No legs yet", "nothing to show". A pastel sunken well with a sparkle, so an
 * empty state reads as a calm note on the canvas, never as a dark slab.
 * (Deep-indigo HoloScreen is reserved for real data readouts.)
 */
export function MutedWell({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <HoloPanel
      variant="sunken"
      texture="none"
      padding={center ? '16px 14px' : '10px 12px'}
      style={{
        overflow: 'hidden',
        isolation: 'isolate',
        textAlign: center ? 'center' : undefined,
        background: MUTED_WELL_BG,
      }}
    >
      <div aria-hidden style={MUTED_WELL_DOTS} />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: center ? 'column' : 'row',
          alignItems: center ? 'center' : 'flex-start',
          gap: center ? 8 : 9,
        }}
      >
        <HoloSparkle
          size={center ? 18 : 13}
          color={HOLO.periwinkle}
          glow={false}
          twinkle={center}
          style={{ marginTop: center ? 0 : 3, filter: `drop-shadow(1px 1px 0 ${HOLO.ink}66)` }}
        />
        <div style={{ minWidth: 0, fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.6, color: INK.muted }}>{children}</div>
      </div>
    </HoloPanel>
  );
}

/** Explanatory line on the canvas. `warn` marks a state needing action. */
export function Hint({ children, warn = false, style }: { children: ReactNode; warn?: boolean; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: warn ? 'flex' : 'block',
        alignItems: 'flex-start',
        gap: 7,
        fontFamily: FONT_TEXT,
        fontWeight: warn ? 700 : 400,
        fontSize: 11.5,
        lineHeight: 1.55,
        color: warn ? INK.warn : INK.muted,
        ...style,
      }}
    >
      {warn && (
        <span style={{ marginTop: 1, flexShrink: 0 }}>
          <HoloMessageIcon kind="warn" size={15} />
        </span>
      )}
      {warn ? <span style={{ minWidth: 0 }}>{children}</span> : children}
    </div>
  );
}

const LINK: CSSProperties = {
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  color: INK.link,
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
  overflowWrap: 'anywhere',
};

/** Mono address with a Blockscout link. */
export function AddrLink({ address, full = false }: { address: string; full?: boolean }) {
  return (
    <a href={addressUrl(address)} target="_blank" rel="noopener noreferrer" title={address} style={{ ...LINK, fontSize: 12 }}>
      {full ? address : shortAddr(address)}
    </a>
  );
}

/** `label` arrives translated (e.g. t('shell:spareUi.tx.viewTx')); the default is the short hash. */
export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noopener noreferrer" title={hash} style={{ ...LINK, fontSize: 12, textDecorationStyle: 'solid', whiteSpace: 'nowrap' }}>
      {label ?? `${hash.slice(0, 10)}…`} ↗
    </a>
  );
}

const COPY: CSSProperties = { fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.6, color: INK.body, margin: 0 };

/* --------------------------------- gating --------------------------------- */

/** Shown while the SPARE contracts have no bytecode on 4663, in place of any balance. */
export function DeployingNotice({ checking, error }: { checking: boolean; error: string | null }) {
  const { t } = useTranslation('shell');
  return (
    <HoloCard
      title={t('spareUi.deploying.title')}
      icon={<HoloMessageIcon kind={error && !checking ? 'error' : 'warn'} size={16} />}
      accent={checking ? t('spareUi.deploying.badgeChecking') : error ? t('spareUi.deploying.badgeRpcError') : t('spareUi.deploying.badgeDeploying')}
      accentTone={error && !checking ? 'bad' : 'warn'}
    >
      <p style={COPY}>
        {checking ? (
          t('spareUi.deploying.checking')
        ) : error ? (
          <>
            <strong style={{ color: INK.bad }}>{t('spareUi.deploying.unreachable')}</strong>
            <br />
            {error}
          </>
        ) : (
          <>
            <strong style={{ color: INK.warn }}>{t('spareUi.deploying.headline')}</strong>
            <br />
            <Trans t={t} i18nKey="spareUi.deploying.body" components={{ addr: <AddrLink address={SPARE.SweepExecutor} /> }} />
          </>
        )}
      </p>
      {checking && <HoloProgress indeterminate height={12} ariaLabel={t('spareUi.deploying.checkingAria')} />}
    </HoloCard>
  );
}

/** "No wallet" state with the same wallet picker the tray uses. */
export function ConnectPrompt({ why }: { why: ReactNode }) {
  const { t } = useTranslation('shell');
  const [open, setOpen] = useState(false);
  return (
    <HoloCard title={t('common.wallet')} accent={t('common.notConnected')} accentTone="warn">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <HoloStar size={68} />
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <HoloTitle as="h3" size="sm">{t('spareUi.connect.title')}</HoloTitle>
          <p style={COPY}>{why}</p>
        </div>
      </div>
      <div style={ROW}>
        <HoloButton variant="primary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? t('common.hideWallets') : t('common.connectWallet')}
        </HoloButton>
        <span style={HINT}>{t('common.walletPillHint')}</span>
      </div>
      {open && <WalletPicker variant="holo" onClose={() => setOpen(false)} />}
    </HoloCard>
  );
}

/**
 * Renders children only once the contracts are live (and, with `needsWallet`,
 * a wallet is connected). Everything before that is an empty state.
 */
export function SpareGate({ needsWallet = false, why, children }: { needsWallet?: boolean; why?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation('shell');
  const { deployed, checking, error } = useSpareDeployment();
  const { isConnected } = useAccount();
  if (!deployed) return <DeployingNotice checking={checking} error={error} />;
  if (needsWallet && !isConnected) {
    return <ConnectPrompt why={why ?? t('spareUi.connect.defaultWhy')} />;
  }
  return <>{children}</>;
}

/**
 * Resolves which ACCOUNT the connected wallet stands for before an app body
 * renders: itself, or — for a linked spending wallet — the account it feeds.
 * The body is keyed by that account, so switching wallets starts it fresh.
 * `what` names what the app shows, for the spending-wallet banner; callers
 * pass it already translated (it is interpolated into a shell sentence).
 */
export function WithSpareAccount({ what, children }: { what: string; children: (v: SpareAccountView) => ReactNode }) {
  const { t } = useTranslation('shell');
  const v = useSpareAccount();
  if (v.resolving) return <MutedWell>{t('spareUi.account.resolving')}</MutedWell>;
  return (
    <>
      {v.isSpendingWallet && v.me && v.account && <SpendingWalletNotice me={v.me} account={v.account} what={what} />}
      {v.error && <Hint warn>{t('spareUi.account.unknown')}</Hint>}
      <Fragment key={v.account ?? 'none'}>{children(v)}</Fragment>
    </>
  );
}

/** The connected wallet is a spending wallet: everything shown is its account's, read-only. */
export function SpendingWalletNotice({ me, account, what }: { me: string; account: string; what: string }) {
  const { t } = useTranslation('shell');
  return (
    <HoloCard title={t('spareUi.spending.title')} accent={t('spareUi.spending.readOnly')} accentTone="warn" bar="pink" compact>
      <p style={COPY}>
        <Trans
          t={t}
          i18nKey="spareUi.spending.body"
          values={{ what }}
          components={{
            me: <AddrLink address={me} />,
            b: <strong style={{ color: INK.info }} />,
            account: <AddrLink address={account} />,
          }}
        />
      </p>
    </HoloCard>
  );
}

/** One line when the wallet is on another chain — writes will switch it first. */
export function ChainNote() {
  const { t } = useTranslation('shell');
  const { isConnected, chainId } = useAccount();
  if (!isConnected || chainId === SPARE_CHAIN_ID) return null;
  return <Hint warn>{t('spareUi.chainNote', { chain: chainId ?? t('spareUi.unknownChain'), target: SPARE_CHAIN_ID })}</Hint>;
}

/* ------------------------------ write status ------------------------------ */

/** Phase lines (shell i18n keys, translated at render); idle shows nothing. */
const PHASE_TEXT: Record<TxState['phase'], string | null> = {
  idle: null,
  switching: tKey('spareUi.tx.phase.switching'),
  checking: tKey('spareUi.tx.phase.checking'),
  wallet: tKey('spareUi.tx.phase.wallet'),
  pending: tKey('spareUi.tx.phase.pending'),
  confirmed: tKey('spareUi.tx.phase.confirmed'),
  error: tKey('spareUi.tx.phase.error'),
};

/** pending / confirmed / error for one write pipeline, with its Blockscout link. */
export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss?: () => void }) {
  const { t } = useTranslation('shell');
  if (state.phase === 'idle') return null;
  const done = state.phase === 'confirmed';
  const failed = state.phase === 'error';
  const busy = !done && !failed;
  const stepText = state.steps > 1 ? t('spareUi.tx.step', { step: state.step, steps: state.steps }) : '';
  const phaseKey = PHASE_TEXT[state.phase];
  const phaseText = phaseKey ? t(phaseKey) : '';
  const look = done
    ? { bg: 'linear-gradient(135deg, #FBFFFD 0%, #E3FBF1 100%)', stripe: HOLO.goodFill }
    : failed
    ? { bg: 'linear-gradient(135deg, #FFFBFC 0%, #FFE6EE 100%)', stripe: HOLO.badFill }
    : { bg: 'linear-gradient(135deg, #FFFFFF 0%, #F3EEFF 60%, #FDE9F6 100%)', stripe: HOLO.lilac };
  return (
    <div
      role={failed ? 'alert' : 'status'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '9px 10px 9px 14px',
        background: look.bg,
        border: `2px solid ${HOLO.ink}`,
        boxShadow: `inset 4px 0 0 0 ${look.stripe}, inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.18)`,
        color: HOLO.ink,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <HoloBadge
          label={done ? t('spareUi.tx.badgeConfirmed') : failed ? t('spareUi.tx.badgeError') : t('spareUi.tx.badgePending')}
          tone={done ? 'good' : failed ? 'bad' : 'warn'}
          variant="solid"
          dot
          pulse={busy}
        />
        <span style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 12, color: HOLO.ink, flex: 1, minWidth: 200, lineHeight: 1.45 }}>
          {t('spareUi.tx.head', { label: state.label, step: stepText })}
          <span style={{ fontWeight: 400, color: failed ? HOLO.badInk : HOLO.inkMuted }}>
            {failed ? state.error : phaseText}
          </span>
        </span>
        {state.hash && <TxLink hash={state.hash} label={t('spareUi.tx.viewTx')} />}
        {onDismiss && (done || failed) && (
          <HoloButton size="sm" onClick={onDismiss}>{t('common.ok')}</HoloButton>
        )}
      </div>
      {busy && <HoloProgress indeterminate height={10} segments={24} ariaLabel={phaseText} />}
    </div>
  );
}
