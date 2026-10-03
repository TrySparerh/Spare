/**
 * WalletPicker — a Spare Holo mini-dialog that lists wallet connectors with
 * pixel icons (login card, tray popover, in-app connect prompts), talking to
 * wagmi's useConnect() directly.
 *
 * Dynamic enumeration: wagmi v2 auto-discovers every EIP-6963 injected
 * provider, so each installed wallet shows up with its own name + icon.
 *   · Robinhood Wallet via WalletConnect pinned FIRST when configured
 *     (QR scan on desktop, deep link on mobile — the app has no extension)
 *   · Robinhood-branded injected providers pinned next (future-proofing)
 *   · MetaMask / Phantom hint rows appear when NOT installed:
 *       mobile → deep-link to the wallet's in-app browser
 *       desktop → open the wallet's install page
 * On connect we request Robinhood Chain (4663) — wagmi's switchChain flow
 * handles wallet_addEthereumChain from the chain definition.
 */
import { useMemo } from 'react';
import { useConnect, type Connector } from 'wagmi';
import { BaseError, UserRejectedRequestError } from 'viem';
import { robinhoodChain } from '@/lib/chain';
import { useIsMobile, useIsMobileNow } from '@/hooks/use-mobile';
import { phoneIconSrc } from '@/lib/phoneIcons';
import { useTranslation } from '@/i18n';
import { BEVEL_RAISED, FONT_CHROME, FONT_TEXT, GRADIENT, HOLO, TEXTURE } from './holo/tokens';
import { GlyphClose } from './holo/HoloGlyphs';

interface WalletPickerProps {
  onClose: () => void;
  /** Spare Holo dialog, the only look (kept as a prop so existing call sites compile). */
  variant?: 'holo';
}

type HintLabel = 'MetaMask' | 'Phantom';

interface PickerRow {
  key: string;
  label: string;
  iconSrc: string | null;
  connector: Connector | null;
  hint: HintLabel | null;
}

const FALLBACK_ICONS: Array<{ match: string; src: string }> = [
  { match: 'metamask', src: '/icons/metamask-icon.png' },
  { match: 'phantom', src: '/icons/phantom-icon.png' },
  { match: 'coinbase', src: '/icons/coinbase-icon.png' },
];

function fallbackIconFor(connector: Connector): string | null {
  const k = `${connector.id ?? ''} ${connector.name ?? ''}`.toLowerCase();
  const hit = FALLBACK_ICONS.find((f) => k.includes(f.match));
  return hit ? hit.src : null;
}

/** True when a connector looks like Robinhood Wallet (name or rdns/id). */
function isRobinhood(connector: Connector): boolean {
  return `${connector.id ?? ''} ${connector.name ?? ''}`.toLowerCase().includes('robinhood');
}

/** Phantom's EVM side only supports a fixed chain allowlist — it refuses
 *  wallet_addEthereumChain for custom chains, so it CANNOT connect to
 *  Robinhood Chain (4663). Detect it so the picker can warn upfront
 *  instead of surfacing Phantom's cryptic "Unsupported network" popup. */
function isPhantom(connector: Connector): boolean {
  return `${connector.id ?? ''} ${connector.name ?? ''}`.toLowerCase().includes('phantom');
}

/** Universal-link deep-links — when the user is on a mobile device and the
 *  wallet is not detected as a wagmi connector, these open the wallet app
 *  with the current dapp URL so the user can connect from their phone. */
function mobileDeepLinkFor(label: HintLabel): string | null {
  if (typeof window === 'undefined') return null;
  const dappUrl = window.location.href;
  const host = window.location.host;
  switch (label) {
    case 'MetaMask':
      // https://metamask.app.link/dapp/<host>/<path>?query
      return `https://metamask.app.link/dapp/${host}${window.location.pathname}${window.location.search}`;
    case 'Phantom':
      return `https://phantom.app/ul/browse/${encodeURIComponent(dappUrl)}?ref=${encodeURIComponent(window.location.origin)}`;
    default:
      return null;
  }
}

/** Desktop install page for users who don't have the wallet extension yet. */
function desktopInstallLinkFor(label: HintLabel): string {
  switch (label) {
    case 'MetaMask':
      return 'https://metamask.io/download/';
    case 'Phantom':
      return 'https://phantom.app/download';
  }
}

export function WalletPicker({ onClose }: WalletPickerProps) {
  const { t, i18n } = useTranslation('shell');
  const { connectors, connect, isPending, error, variables } = useConnect();
  const isMobile = useIsMobile();
  // Phones only: 128 px wallet icons instead of the 1254 px originals.
  const isPhone = useIsMobileNow();

  // Build rows dynamically from the discovered connectors:
  //   1. Robinhood Wallet via WalletConnect — pinned FIRST when configured
  //      (it's the flagship wallet of this chain and has no extension:
  //      desktop shows a QR to scan with the phone app, mobile deep-links)
  //   2. every EIP-6963 injected provider (own name + icon), Robinhood-
  //      branded ones first
  //   3. hint rows for MetaMask/Phantom when not installed
  // (Coinbase SDK connector was removed — Smart Wallet has no contracts on
  //  Robinhood Chain. Coinbase extension users arrive via EIP-6963.)
  const rows = useMemo<PickerRow[]>(() => {
    // EIP-6963-discovered providers report type 'injected' AND carry an icon
    // (the generic window.ethereum fallback connector has id 'injected' and
    // no icon — skip it, discovered entries cover every real wallet).
    const discovered = connectors.filter(
      (c) => c.type === 'injected' && c.id !== 'injected',
    );
    const wc = connectors.find((c) => c.id === 'walletConnect') ?? null;

    // Pin Robinhood-branded injected providers first when detected.
    discovered.sort((a, b) => Number(isRobinhood(b)) - Number(isRobinhood(a)));

    const out: PickerRow[] = [];

    // Robinhood Wallet (mobile app) — WalletConnect QR / deep link.
    if (wc) {
      out.push({
        key: wc.uid,
        label: isMobile ? 'Robinhood Wallet' : t('walletPicker.robinhoodScan'),
        iconSrc: null, // letter tile — no bundled Robinhood art
        connector: wc,
        hint: null,
      });
    }

    // Wallets that can't reach Robinhood Chain sink to the bottom.
    discovered.sort((a, b) => Number(isPhantom(a)) - Number(isPhantom(b)));

    out.push(...discovered.map((c) => ({
      key: c.uid,
      label: isRobinhood(c) ? 'Robinhood Wallet' : (isPhantom(c) ? t('walletPicker.noRobinhoodChain', { name: c.name }) : c.name),
      iconSrc: (c.icon as string | undefined) ?? fallbackIconFor(c),
      connector: c,
      hint: null as HintLabel | null,
    })));

    // Hint rows — keep MetaMask/Phantom reachable on every device even when
    // the extension isn't installed (mobile deep-link / desktop install).
    const has = (needle: string) =>
      out.some((r) => `${r.connector?.id ?? ''} ${r.label}`.toLowerCase().includes(needle));
    if (!has('metamask')) {
      out.push({ key: 'hint-metamask', label: 'MetaMask', iconSrc: '/icons/metamask-icon.png', connector: null, hint: 'MetaMask' });
    }

    return out;
  }, [connectors, isMobile, t]);

  const pendingId = variables?.connector && 'id' in variables.connector ? (variables.connector as Connector).id : null;

  return (
    <div
      style={{
        background: GRADIENT.card,
        border: `2px solid ${HOLO.ink}`,
        boxShadow: 'inset 0 0 0 1px #FFFFFF, 4px 4px 0 0 rgba(42,27,110,.22)',
        padding: 6,
        width: 320,
        maxWidth: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '3px 3px 3px 8px',
          background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar}`,
          margin: '-4px -4px 2px',
        }}
      >
        <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, color: '#fff', textShadow: '1px 1px 0 #2A1B6E' }}>
          {t('walletPicker.title')}
        </span>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="holo-winbtn holo-winbtn--close">
          <GlyphClose />
        </button>
      </div>

      {rows.map(({ key, label, iconSrc, connector: c, hint }) => {
        const isThisPending = !!c && isPending && pendingId === c.id;
        const fallbackUrl = hint
          ? (isMobile ? mobileDeepLinkFor(hint) : desktopInstallLinkFor(hint))
          : null;
        const fallbackLabel = hint ? (isMobile ? t('walletPicker.openApp') : t('walletPicker.install')) : null;
        const handleClick = () => {
          if (c) {
            // Always request Robinhood Chain (4663) at connect time. wagmi
            // passes the chainId to the wallet's connect flow — the wallet
            // will either auto-select or prompt to add+switch the chain in
            // the SAME popup as the connect approval. One UX gesture, not two.
            connect({ connector: c, chainId: robinhoodChain.id });
          } else if (fallbackUrl) {
            window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
          }
        };
        return (
          <button
            type="button"
            key={key}
            onClick={handleClick}
            disabled={isPending && !!c}
            className="holo-taskbtn"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 10px',
              background: GRADIENT.face,
              boxShadow: BEVEL_RAISED,
              border: 0,
              cursor: isPending && c ? 'wait' : 'pointer',
              fontFamily: FONT_CHROME,
              fontWeight: 400,
              fontSize: 19,
              color: HOLO.ink,
              textAlign: 'left',
              minWidth: 0,
              opacity: isPending && c && !isThisPending ? 0.5 : 1,
            }}
          >
            {iconSrc ? (
              <img
                src={phoneIconSrc(iconSrc, isPhone)}
                alt=""
                width={32}
                height={32}
                style={{ imageRendering: 'pixelated', objectFit: 'contain', flexShrink: 0 }}
              />
            ) : (
              <div
                style={{
                  width: 32,
                  height: 32,
                  background: HOLO.screen,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: HOLO.lilac,
                  fontFamily: FONT_CHROME,
                  fontSize: 20,
                  flexShrink: 0,
                  boxShadow: `0 0 0 1px ${HOLO.ink}`,
                }}
              >
                {label.charAt(0).toUpperCase()}
              </div>
            )}
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
            <span
              style={{
                fontSize: 11,
                color: isThisPending ? HOLO.ink : HOLO.inkMuted,
                fontFamily: FONT_TEXT,
                flexShrink: 0,
              }}
            >
              {isThisPending ? t('walletPicker.connecting') : c ? '→' : fallbackLabel}
            </span>
          </button>
        );
      })}

      {error && (
        <div
          style={{
            padding: '6px 10px',
            background: '#FFF1F5',
            color: HOLO.badInk,
            fontFamily: FONT_TEXT,
            fontSize: 11,
            boxShadow: `inset 0 0 0 1px ${HOLO.badFill}`,
          }}
        >
          {connectErrorText(error, i18n.language === 'en' ? null : t('walletPicker.rejected'))}
        </div>
      )}
    </div>
  );
}

/**
 * The wallet's own error line. A rejected request reads in the chosen language
 * (English keeps the wallet library's own sentence, as before); anything else is
 * the library's message.
 */
function connectErrorText(error: Error, rejected: string | null): string {
  const isRejected =
    (error as { code?: number }).code === 4001 ||
    (error instanceof BaseError && !!error.walk((e) => e instanceof UserRejectedRequestError || (e as { code?: number }).code === 4001));
  if (rejected && isRejected) return rejected;
  return error.message.split('\n')[0];
}

export default WalletPicker;
