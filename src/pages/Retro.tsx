/**
 * The Spare app — a boot sequence into the Spare Holo desktop, where every
 * Spare tool is an app window.
 *
 * BIOS → Login (wallet connect) → CRT flash → Desktop
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReadContract } from 'wagmi';
import { zeroAddress } from 'viem';
import { BiosScreen } from '@/components/retro/BiosScreen';
import { LoginScreen } from '@/components/retro/LoginScreen';
import { Desktop } from '@/components/retro/Desktop';
import {
  WindowManagerProvider,
  type AppDescriptor,
} from '@/components/retro/WindowManager';
import { useIsMobile } from '@/hooks/use-mobile';
import { tKey, useTranslation } from '@/i18n';
import { initUiZoom } from '@/lib/uiZoom';
import { ruleIsSet } from '@/lib/spare';
import { ruleRegistryAbi } from '@/lib/spare-chain/abis';
import { SPARE, SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import { useSpareAccount } from '@/lib/spare-chain/hooks';
import { FundWalletApp } from '@/components/retro/apps/FundWalletApp';
import { LinkWalletApp } from '@/components/retro/apps/LinkWalletApp';
import { RoundUpRulesApp } from '@/components/retro/apps/RoundUpRulesApp';
import { StockMixApp } from '@/components/retro/apps/StockMixApp';
import { AutoInvestApp } from '@/components/retro/apps/AutoInvestApp';
import { SpareBalanceApp } from '@/components/retro/apps/SpareBalanceApp';
import { SpareActivityApp } from '@/components/retro/apps/SpareActivityApp';
import { ViewingKeyApp } from '@/components/retro/apps/ViewingKeyApp';
import { MySpareApp } from '@/components/retro/apps/MySpareApp';
import { AboutApp } from '@/components/retro/apps/AboutApp';
import { TaskManagerApp } from '@/components/retro/apps/TaskManagerApp';
import { StockDeskApp } from '@/components/retro/apps/StockDeskApp';
import { AfterHoursApp } from '@/components/retro/apps/AfterHoursApp';
import { PortfolioXrayApp } from '@/components/retro/apps/PortfolioXrayApp';
import { RoadmapApp } from '@/components/retro/apps/RoadmapApp';
import { RecycleBinApp } from '@/components/retro/apps/RecycleBinApp';

/** Shortcuts (Docs, X, Telegram) open a URL instead of a window; this is never rendered. */
const LINK_ONLY = () => null as unknown as JSX.Element;

// ─── app registry ─────────────────────────────────────────────────────────

// `title` here is an i18n key (shell:appNames.<id>); Retro translates it before
// handing the registry to the window manager, so every window, taskbar key,
// desktop icon and Start menu row shows the name in the active language.
const APPS: AppDescriptor[] = [
  {
    id: 'fund-wallet',
    title: tKey('appNames.fund-wallet'),
    iconLetter: 'F',
    iconTone: 'magenta',
    iconImage: '/icons/spare/fund-wallet.png',
    // Fits a 1280x720 screen: bottom edge 660 clears the 44 px taskbar at 676 (content scrolls).
    defaultSize: { width: 800, height: 600 },
    defaultPosition: { left: 90, top: 60 },
    component: FundWalletApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'spare-balance',
    title: tKey('appNames.spare-balance'),
    iconLetter: 'S',
    iconTone: 'magenta',
    iconImage: '/icons/spare/spare-balance.png',
    defaultSize: { width: 760, height: 620 },
    defaultPosition: { left: 120, top: 80 },
    component: SpareBalanceApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'link-wallet',
    title: tKey('appNames.link-wallet'),
    iconLetter: 'L',
    iconTone: 'blue',
    iconImage: '/icons/spare/link-wallet.png',
    defaultSize: { width: 780, height: 600 },
    defaultPosition: { left: 150, top: 100 },
    component: LinkWalletApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'roundup-rules',
    title: tKey('appNames.roundup-rules'),
    iconLetter: 'R',
    iconTone: 'magenta',
    iconImage: '/icons/spare/roundup-rules.png',
    defaultSize: { width: 760, height: 660 },
    defaultPosition: { left: 180, top: 90 },
    component: RoundUpRulesApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'stock-mix',
    title: tKey('appNames.stock-mix'),
    iconLetter: 'M',
    iconTone: 'cyan',
    iconImage: '/icons/spare/stock-mix.png',
    defaultSize: { width: 760, height: 620 },
    defaultPosition: { left: 210, top: 110 },
    component: StockMixApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'auto-invest',
    title: tKey('appNames.auto-invest'),
    iconLetter: 'A',
    iconTone: 'blue',
    iconImage: '/icons/spare/auto-invest.png',
    defaultSize: { width: 780, height: 640 },
    defaultPosition: { left: 240, top: 120 },
    component: AutoInvestApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'spare-activity',
    title: tKey('appNames.spare-activity'),
    iconLetter: 'H',
    iconTone: 'mono',
    iconImage: '/icons/spare/spare-activity.png',
    defaultSize: { width: 860, height: 620 },
    defaultPosition: { left: 270, top: 130 },
    component: SpareActivityApp,
    category: 'Programs',
    showOnDesktop: true,
  },
  {
    id: 'viewing-key',
    title: tKey('appNames.viewing-key'),
    iconLetter: 'K',
    iconTone: 'magenta',
    iconImage: '/icons/spare/viewing-key.png',
    defaultSize: { width: 780, height: 640 },
    defaultPosition: { left: 300, top: 140 },
    component: ViewingKeyApp,
    category: 'Programs',
    showOnDesktop: true,
  },

  // ─── Markets — the stock universe, read live from Robinhood Chain ─────────
  {
    id: 'stock-desk',
    title: tKey('appNames.stock-desk'),
    iconLetter: 'S',
    iconTone: 'green',
    iconImage: '/icons/spare/stock-desk.png',
    defaultSize: { width: 860, height: 620 },
    defaultPosition: { left: 340, top: 120 },
    component: StockDeskApp,
    category: 'Markets',
    showOnDesktop: true,
  },
  {
    id: 'after-hours',
    title: tKey('appNames.after-hours'),
    iconLetter: '☾',
    iconTone: 'blue',
    iconImage: '/icons/spare/after-hours.png',
    defaultSize: { width: 760, height: 640 },
    defaultPosition: { left: 320, top: 100 },
    component: AfterHoursApp,
    category: 'Markets',
    showOnDesktop: true,
  },
  {
    id: 'portfolio-xray',
    title: tKey('appNames.portfolio-xray'),
    iconLetter: 'X',
    iconTone: 'magenta',
    iconImage: '/icons/spare/portfolio-xray.png',
    defaultSize: { width: 820, height: 660 },
    defaultPosition: { left: 300, top: 100 },
    component: PortfolioXrayApp,
    category: 'Markets',
    showOnDesktop: true,
  },

  // ─── Resources — docs, roadmap, community ────────────────────────────────
  {
    id: 'docs',
    title: tKey('appNames.docs'),
    iconLetter: 'D',
    iconTone: 'blue',
    iconImage: '/icons/spare/docs.png',
    component: LINK_ONLY,
    externalUrl: '/docs',
    category: 'Resources',
    // The Start menu's Web section already lists Docs; keep one entry there.
    showInStartMenu: false,
  },
  {
    id: 'roadmap',
    title: tKey('appNames.roadmap'),
    iconLetter: 'R',
    iconTone: 'amber',
    iconImage: '/icons/spare/roadmap.png',
    defaultSize: { width: 720, height: 600 },
    component: RoadmapApp,
    category: 'Resources',
    // The Start menu's Web section already lists Roadmap; keep one entry there.
    showInStartMenu: false,
  },
  {
    id: 'telegram',
    title: tKey('appNames.telegram'),
    iconLetter: 'T',
    iconTone: 'blue',
    iconImage: '/icons/telegram.png',
    component: LINK_ONLY,
    externalUrl: 'https://t.me/sparerh',
    category: 'Resources',
  },
  {
    id: 'x',
    title: tKey('appNames.x'),
    iconLetter: 'X',
    iconTone: 'mono',
    iconImage: '/icons/x.png',
    // White-only glyph: inked indigo on light surfaces (Start menu), outlined on the world.
    iconMono: true,
    component: LINK_ONLY,
    externalUrl: 'https://x.com/TrySpareRH',
    category: 'Resources',
  },

  // ─── System ──────────────────────────────────────────────────────────────
  {
    id: 'recycle-bin',
    title: tKey('appNames.recycle-bin'),
    iconLetter: 'R',
    iconTone: 'mono',
    iconImage: '/icons/recycle-bin.png',
    defaultSize: { width: 520, height: 420 },
    component: RecycleBinApp,
    category: 'System',
    showOnDesktop: true,
  },
  {
    id: 'my-spare',
    title: tKey('appNames.my-spare'),
    iconLetter: 'S',
    iconTone: 'magenta',
    iconImage: '/icons/spare-logo.png',
    defaultSize: { width: 640, height: 520 },
    component: MySpareApp,
    category: 'System',
  },
  {
    id: 'about',
    title: tKey('appNames.about'),
    iconLetter: 'i',
    iconTone: 'cyan',
    iconGlyph: 'spark',
    defaultSize: { width: 560, height: 420 },
    component: AboutApp,
    category: 'System',
    showOnDesktop: false,
  },
  {
    id: 'taskmanager',
    title: tKey('appNames.taskmanager'),
    iconLetter: 'X',
    iconTone: 'red',
    iconGlyph: 'grid',
    defaultSize: { width: 560, height: 480 },
    component: TaskManagerApp,
    category: 'Easter Eggs',
    showOnDesktop: false,
  },
];

// ─── boot sequence ────────────────────────────────────────────────────────

type Phase = 'bios' | 'login' | 'flash' | 'desktop';

/**
 * Whether the connected wallet already has a Spare account with a rule set.
 * A linked spending wallet counts through the account it feeds. `false` for a
 * guest, while the reads are in flight, and when Robinhood Chain can't be
 * reached, so the first-run path is the safe default.
 */
function useHasRule(): boolean {
  const { account } = useSpareAccount();
  const q = useReadContract({
    address: SPARE.RuleRegistry,
    abi: ruleRegistryAbi,
    functionName: 'ruleOf',
    args: [account ?? zeroAddress],
    chainId: SPARE_CHAIN_ID,
    query: { enabled: !!account },
  });
  const r = q.data as { roundTo: number | bigint; multiplier: number | bigint; weeklyCap: bigint; enabled: boolean } | undefined;
  if (!account || !r) return false;
  return ruleIsSet({
    roundTo: Number(r.roundTo),
    multiplier: Number(r.multiplier),
    weeklyCap: BigInt(r.weeklyCap),
    enabled: r.enabled,
  });
}

export default function Retro() {
  const { t, i18n } = useTranslation('shell');
  const [phase, setPhase] = useState<Phase>('bios');
  const flashedRef = useRef(false);
  const isMobile = useIsMobile();
  const hasRule = useHasRule();
  // First window on the desktop: a wallet with a rule set lands on its balance;
  // everyone else starts at Link Wallet (step one of setting up round-ups).
  // Phones open nothing (the welcome dialog offers it); matchMedia is read
  // directly so a not-yet-resolved useIsMobile() can never open a full-screen
  // window on a phone. The window manager reads this once, when the desktop
  // mounts after login — the rule read has resolved by then.
  const phone = isMobile || (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches);
  const bootApp = hasRule ? 'spare-balance' : 'link-wallet';
  // App names in the active language; a switch rebuilds the list in place
  // (the window manager keeps its open windows, positions and focus).
  const lang = i18n.language;
  const apps = useMemo(() => APPS.map((a) => ({ ...a, title: t(a.title) })), [t, lang]);
  const initiallyOpen = phone ? [] : [bootApp];

  // Apply the saved UI zoom and wire Ctrl +/− / Ctrl 0 for the whole desktop.
  useEffect(() => initUiZoom(), []);

  // Browser-tab title in the active language (English: index.html's own title).
  useEffect(() => {
    document.title = t('meta.appTitle');
  }, [t, lang]);

  const goToLogin = () => setPhase('login');
  const goToDesktop = () => {
    if (flashedRef.current) return;
    flashedRef.current = true;
    setPhase('flash');
    setTimeout(() => setPhase('desktop'), 520);
  };

  return (
    <div className="retro98">
      {phase === 'bios' && <BiosScreen onContinue={goToLogin} />}
      {phase === 'login' && <LoginScreen onAuthenticated={goToDesktop} onSkip={goToDesktop} />}
      {(phase === 'flash' || phase === 'desktop') && (
        <WindowManagerProvider apps={apps} initiallyOpen={initiallyOpen}>
          <Desktop welcome={!hasRule} />
        </WindowManagerProvider>
      )}
      <div className={`crt-flash ${phase === 'flash' ? 'flashing' : ''}`} />
      <div className="crt-jitter" />
      <div className="crt-scanlines" />
      <div className="crt-roll" />
    </div>
  );
}
