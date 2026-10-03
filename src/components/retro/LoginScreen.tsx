/**
 * Login screen — sign in with a wallet, or continue as a guest.
 *
 * A Spare Holo mini-dialog over the login Spline scene: the Spare star and
 * poster headline, one state line, holofoil keys. Press Enter (or click
 * Connect Wallet) to open the inline wallet picker; once a wallet connects the
 * card offers "Enter Spare ▸". Nothing advances on its own: a returning user
 * with a connected wallet still lands here first, so they can open the public
 * pages in the link row before entering the desktop.
 *
 * Under the card: the chain / eligibility line and the public-page link row
 * (PUBLIC_ROUTES, shared with the Start menu's Web section). Internal pages
 * open in a new tab so the boot flow is not disrupted; X and Telegram are
 * external.
 */
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { SpareSplineBg } from './SpareSplineBg';
import { WalletPicker } from './WalletPicker';
import { HoloBadge, HoloButton, HoloCard, HoloProgress, HoloSparkles, HoloStar, HoloTitle } from './holo';
import { PUBLIC_ROUTES } from '@/lib/publicRoutes';
import { MOBILE_FALLBACKS } from '@/lib/mobileScenes';
import { useSceneUrls } from '@/lib/useSceneUrls';
import { useTranslation } from '@/i18n';

// Spare login scene (Spline). Production may override it with
// VITE_SPLINE_LOGIN_SCENE; the fallback is the same Spare scene.
const LOGIN_SCENE =
  (import.meta.env.VITE_SPLINE_LOGIN_SCENE as string | undefined) ||
  'https://prod.spline.design/k9gRAZ0us8rZWaeR/scene.splinecode';

interface LoginScreenProps {
  onAuthenticated: () => void;
  onSkip: () => void;
}

/** Keys that already act on Enter / Space themselves (so the page shortcut stays out of their way). */
const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]';

export function LoginScreen({ onAuthenticated, onSkip }: LoginScreenProps) {
  const scenes = useSceneUrls('login', LOGIN_SCENE);
  const { t } = useTranslation('shell');
  const { isConnected, address } = useAccount();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [proceedRequested, setProceedRequested] = useState(false);

  // Advance ONLY after an explicit action (Enter Spare / Continue as guest).
  useEffect(() => {
    if (!proceedRequested) return;
    const timer = setTimeout(onAuthenticated, 400);
    return () => clearTimeout(timer);
  }, [proceedRequested, onAuthenticated]);

  // Keyboard shortcuts when no control has focus:
  //   Enter / Space · connected → Enter Spare · disconnected → open the picker
  //   Escape        · closes the picker
  // A focused key (the autofocused primary, a wallet row, a link) keeps its
  // own Enter / Space behaviour, so the picker and link row stay keyboard-usable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickerOpen) setPickerOpen(false);
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target as HTMLElement | null;
      if (target && target !== document.body && target.closest?.(INTERACTIVE)) return;
      if (isConnected && !proceedRequested) {
        e.preventDefault();
        setProceedRequested(true);
      } else if (!isConnected && !pickerOpen) {
        e.preventDefault();
        setPickerOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isConnected, pickerOpen, proceedRequested]);

  // Friendly short address (0x88…4D02) for the connected state line.
  const shortAddr = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '';

  const title = proceedRequested
    ? t('login.title.opening')
    : isConnected
      ? t('login.title.connected')
      : t('login.title.signIn');
  const subline = proceedRequested
    ? t('login.sub.loading')
    : isConnected
      ? t('login.sub.connected', { address: shortAddr })
      : pickerOpen
        ? t('login.sub.choose')
        : t('login.sub.prompt');

  const guest = (
    <HoloButton variant="primary" block className="spare-foil spare-foil--guest" onClick={onSkip}>
      {t('login.guest')}
    </HoloButton>
  );

  return (
    <div className="login-screen">
      {/* Spline brand background — bottom layer, full bleed. Phones get the
          portrait phone scene / video loop / poster instead (SpareSplineBg). */}
      <SpareSplineBg
        key={`${scenes.url}|${scenes.mobileUrl}`}
        url={scenes.url}
        marker="data-login-spline"
        mobileUrl={scenes.mobileUrl}
        mobileVideo={MOBILE_FALLBACKS.login.video}
        mobilePoster={MOBILE_FALLBACKS.login.poster}
      />

      <div className="login-stack" data-login-stack>
        <div className="login-card" data-login-card>
          <HoloCard
            title={title}
            icon={<HoloStar size={16} keyline={false} />}
            accent={isConnected && !proceedRequested ? <HoloBadge label={t('common.connected')} tone="good" variant="solid" dot /> : undefined}
            aria-label={t('login.cardAria')}
          >
            <div className="login-hero">
              <HoloSparkles count={7} seed={11} sizes={[7, 15]} avoidCenter={0.42} />
              <HoloStar size={60} animated />
              <div className="login-hero__text">
                <HoloTitle as="h1" size="lg" shimmer>
                  Spare
                </HoloTitle>
                <HoloTitle as="p" size="xs" font="pixel" fill="cream" className="login-hero__tagline">
                  {t('login.tagline')}
                </HoloTitle>
              </div>
            </div>

            <p className="login-sub" aria-live="polite">
              {subline}
            </p>

            {proceedRequested && <HoloProgress indeterminate height={12} ariaLabel={t('login.openingAria')} />}

            {/* DISCONNECTED — Connect Wallet + guest. */}
            {!proceedRequested && !isConnected && !pickerOpen && (
              <div className="login-actions">
                <HoloButton variant="primary" size="lg" block className="spare-foil spare-foil--login" onClick={() => setPickerOpen(true)} autoFocus>
                  {t('login.connectWallet')}
                </HoloButton>
                {guest}
              </div>
            )}

            {/* PICKER OPEN — the wallet list, then guest. */}
            {!proceedRequested && !isConnected && pickerOpen && (
              <div className="login-actions">
                <WalletPicker variant="holo" onClose={() => setPickerOpen(false)} />
                {guest}
              </div>
            )}

            {/* CONNECTED — Enter Spare, or guest. */}
            {!proceedRequested && isConnected && (
              <div className="login-actions">
                <HoloButton variant="primary" size="lg" block className="spare-foil spare-foil--login" onClick={() => setProceedRequested(true)} autoFocus>
                  {t('login.enter')}
                </HoloButton>
                {guest}
              </div>
            )}
          </HoloCard>
        </div>

        {/* keep-all: Chinese wraps at the " · " separators, not mid-phrase (no effect on English). */}
        <p className="login-micro" style={{ wordBreak: 'keep-all' }}>
          {t('login.micro')}
        </p>

        <LoginResourceLinks />
      </div>
    </div>
  );
}

/**
 * LoginResourceLinks — the public-page link row under the login card: Docs,
 * Stock Universe, Live Sweeps, Data Layer, DevTools, MCP, Flywheel, Buyback,
 * Roadmap, Whitepaper, X and Telegram, as small holofoil keys. The list lives
 * in @/lib/publicRoutes (shared with the Start menu). Every link opens in a
 * new tab; the tagline is the tooltip.
 */
function LoginResourceLinks() {
  const { t } = useTranslation('shell');
  return (
    <nav className="login-links" data-login-links aria-label={t('login.linksAria')}>
      {PUBLIC_ROUTES.map((l) => {
        const external = /^https?:\/\//i.test(l.href);
        return (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel={external ? 'noopener noreferrer' : 'noopener'}
            title={l.tagline ? t(l.tagline) : undefined}
            className="holo-btn holo-btn--primary holo-btn--sm spare-foil spare-foil--link"
          >
            {t(l.label)}
            {external && (
              <span className="spare-foil__ext" aria-hidden>
                ↗
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}

export default LoginScreen;
