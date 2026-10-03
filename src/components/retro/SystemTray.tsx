/**
 * SystemTray — right side of the taskbar. Live state pills:
 *   - ETH price, from Chainlink ETH/USD on Robinhood Chain
 *   - $SPARE — "SOON" until the token exists (click-to-copy once it does)
 *   - Wallet address (truncated) or "Connect"
 *   - Clock
 */
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { toast } from 'sonner';
import { SPARE_CA } from '@/lib/config';
import { useEthUsd } from '@/hooks/useEthUsd';
import { useTranslation } from '@/i18n';
import { useClock } from './useClock';
import { WalletTrayPopover } from './WalletTrayPopover';
import { BEVEL_SUNKEN, FONT_TEXT, HOLO } from './holo/tokens';

function TrayPill({
  children,
  onClick,
  accent,
  pillKind,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  accent?: string;
  pillKind?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <div
      data-tray-pill={pillKind}
      onClick={onClick}
      title={title}
      aria-disabled={disabled || undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        padding: '0 8px',
        background: onClick ? 'linear-gradient(180deg, #FFFFFF 0%, #F6F0FF 100%)' : 'rgba(255,255,255,.55)',
        boxShadow: BEVEL_SUNKEN,
        fontFamily: FONT_TEXT,
        fontWeight: 700,
        fontSize: 11.5,
        color: accent ?? HOLO.ink,
        whiteSpace: 'nowrap',
        cursor: onClick ? 'pointer' : 'default',
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {children}
    </div>
  );
}

export function SystemTray() {
  const { t, i18n } = useTranslation('shell');
  const clock = useClock();
  const { address, isConnected } = useAccount();
  const eth = useEthUsd();
  const [walletPopoverOpen, setWalletPopoverOpen] = useState(false);

  const truncate = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  // English keeps the browser's own date format; Chinese formats in its locale.
  const dateLocale = i18n.language === 'en' ? undefined : i18n.language;
  const ethTitle =
    eth.updatedAt != null
      ? [
          t('systemTray.ethSource'),
          t('systemTray.ethUpdated', { time: new Date(eth.updatedAt * 1000).toLocaleString(dateLocale) }),
          ...(eth.stale ? [t('systemTray.ethStale')] : []),
        ].join(' · ')
      : t('systemTray.ethSource');

  return (
    <div data-system-tray style={{ display: 'flex', gap: 2, alignItems: 'center', marginRight: 3 }}>
      {eth.price !== null && (
        <TrayPill pillKind="eth" title={ethTitle}>
          <span style={{ color: HOLO.inkMuted }}>ETH</span>
          <span style={{ color: eth.stale ? HOLO.inkMuted : HOLO.ink }}>
            ${eth.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
        </TrayPill>
      )}
      <SpareCaPill />
      {isConnected && address ? (
        <div data-wallet-trigger>
          <TrayPill pillKind="wallet" onClick={() => setWalletPopoverOpen((v) => !v)} accent={HOLO.goodInk}>
            ● {truncate(address)}
          </TrayPill>
        </div>
      ) : (
        <div data-wallet-trigger>
          <TrayPill pillKind="wallet" onClick={() => setWalletPopoverOpen((v) => !v)} accent={HOLO.badInk}>
            ○ {t('systemTray.connect')}
          </TrayPill>
        </div>
      )}
      <TrayPill pillKind="clock">{clock}</TrayPill>
      {walletPopoverOpen && <WalletTrayPopover onClose={() => setWalletPopoverOpen(false)} />}
    </div>
  );
}

/**
 * SpareCaPill — the $SPARE token in the tray. Until the token exists it is a
 * disabled "SOON" pill; once SPARE_CA is set it copies the address on click.
 */
function SpareCaPill() {
  const { t } = useTranslation('shell');
  const [copied, setCopied] = useState(false);
  if (!SPARE_CA) {
    return (
      <TrayPill pillKind="ca" accent={HOLO.inkSoft} title={t('common.spareSoonTooltip')} disabled>
        <span style={{ color: HOLO.inkSoft }}>$SPARE</span>
        <span style={{ color: HOLO.inkMuted }}>{t('common.soon')}</span>
      </TrayPill>
    );
  }
  const short = `${SPARE_CA.slice(0, 4)}…${SPARE_CA.slice(-4)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SPARE_CA);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = SPARE_CA;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* best-effort */ }
      document.body.removeChild(ta);
    }
    toast.success(t('systemTray.addressCopied'), { description: SPARE_CA });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <TrayPill pillKind="ca" onClick={copy} accent={HOLO.inkSoft} title={`$SPARE · ${SPARE_CA}`}>
      <span style={{ color: HOLO.inkSoft }}>$SPARE</span>
      <span style={{ color: copied ? HOLO.goodInk : HOLO.ink }}>
        {copied ? t('systemTray.copied') : short}
      </span>
    </TrayPill>
  );
}

export default SystemTray;
