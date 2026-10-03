/**
 * WalletTrayPopover — anchored above the system tray. Shows the same Win98
 * wallet picker from the login screen when disconnected, and an account /
 * disconnect panel when connected.
 *
 * Dismissed by clicking outside (or pressing Escape). The tray's wallet pill
 * carries `data-wallet-trigger` so we don't auto-dismiss when toggling.
 */
import { useEffect, useRef } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { CHAIN_ID } from '@/lib/config';
import { useIsMobileNow } from '@/hooks/use-mobile';
import { phoneIconSrc } from '@/lib/phoneIcons';
import { useTranslation } from '@/i18n';
import { WalletPicker } from './WalletPicker';
import { BEVEL_WELL, FONT_CHROME, FONT_TEXT, GRADIENT, HOLO, SHADOW, TEXTURE } from './holo/tokens';
import { GlyphClose } from './holo/HoloGlyphs';

interface Props {
  onClose: () => void;
}

const ICONS: Record<string, string> = {
  metamask: '/icons/metamask-icon.png',
  phantom: '/icons/phantom-icon.png',
  coinbase: '/icons/coinbase-icon.png',
};

function iconForConnector(name?: string, id?: string): string | null {
  const k = `${name ?? ''} ${id ?? ''}`.toLowerCase();
  if (k.includes('metamask')) return ICONS.metamask;
  if (k.includes('phantom')) return ICONS.phantom;
  if (k.includes('coinbase')) return ICONS.coinbase;
  return null;
}

export function WalletTrayPopover({ onClose }: Props) {
  const { t } = useTranslation('shell');
  const { address, isConnected, connector, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const ref = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click + Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      const target = e.target as HTMLElement;
      if (ref.current.contains(target)) return;
      // Don't close if user clicked the tray trigger pill itself (it toggles us)
      if (target.closest('[data-wallet-trigger]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const truncate = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  // Phones only: 128 px wallet icons instead of the 1254 px originals.
  const icon = phoneIconSrc(iconForConnector(connector?.name, connector?.id), useIsMobileNow());

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        right: 8,
        bottom: 48,
        zIndex: 500,
      }}
    >
      {isConnected && address ? (
        <div
          style={{
            background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card}`,
            border: `2px solid ${HOLO.ink}`,
            boxShadow: `inset 0 0 0 1px #FFFFFF, ${SHADOW.card}`,
            padding: 6,
            width: 280,
            maxWidth: 'calc(100vw - 16px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {/* Title bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '3px 3px 3px 8px',
              margin: '-4px -4px 0',
              background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar}`,
              boxShadow: `inset 0 -1px 0 0 ${HOLO.ink}`,
            }}
          >
            <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, color: '#fff', textShadow: SHADOW.titleText }}>
              {t('walletTray.title')}
            </span>
            <button onClick={onClose} aria-label={t('common.close')} className="holo-winbtn holo-winbtn--close">
              <GlyphClose />
            </button>
          </div>

          {/* Account info */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: 10,
              background: HOLO.paper,
              boxShadow: BEVEL_WELL,
            }}
          >
            {icon ? (
              <img
                src={icon}
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
                  boxShadow: `0 0 0 1px ${HOLO.ink}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: HOLO.lilac,
                  fontFamily: 'VT323, monospace',
                  fontSize: 20,
                  flexShrink: 0,
                }}
              >
                W
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 19, color: HOLO.ink }}>
                {connector?.name ?? t('walletTray.connectedFallback')}
              </div>
              <div
                style={{
                  fontFamily: FONT_TEXT,
                  fontSize: 11,
                  color: HOLO.inkSoft,
                  marginTop: 2,
                }}
              >
                {truncate(address)}
              </div>
              <div
                style={{
                  fontFamily: FONT_CHROME,
                  fontWeight: 400,
                  fontSize: 16,
                  color: chain?.id === CHAIN_ID ? HOLO.goodInk : HOLO.badInk,
                  marginTop: 2,
                }}
              >
                ● {chain?.name ?? t('walletTray.chainId', { id: chain?.id ?? '—' })}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(address).catch(() => {});
              }}
              className="holo-btn holo-btn--sm"
              style={btnStyle}
            >
              {t('walletTray.copyAddress')}
            </button>
            <button
              onClick={() => {
                disconnect();
                onClose();
              }}
              className="holo-btn holo-btn--sm holo-btn--danger"
              style={btnStyle}
            >
              {t('common.disconnect')}
            </button>
          </div>
        </div>
      ) : (
        <WalletPicker variant="holo" onClose={onClose} />
      )}
    </div>
  );
}

/** Layout only — the look comes from .holo-btn (holo.css). */
const btnStyle: React.CSSProperties = {
  minWidth: 90,
  height: 28,
};

export default WalletTrayPopover;
