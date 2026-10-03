/**
 * HoloPageWindow — the standalone public-page frame (/buyback, /flywheel,
 * /universe): one Spare Holo app window on the brand sky, so a public page
 * reads like an app from the desktop.
 *
 *   [title bar   icon  Spare — Fees.exe            Open Spare ▸  [×]]
 *   [menu bar    the shared public tabs (publicTabs.ts)                 ]
 *   [banner      ● SPARE · FEES · LIVE          ROBINHOOD CHAIN · 4663]
 *   [canvas      page content (HoloWindowBody)                         ]
 *   [footer      shared Spare footer                                   ]
 *
 * The footer is PublicShell's shared PublicFooter. Also
 * exports a Link styled as a Holo button, a CTA row, and usePageMeta.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LanguageToggle } from '@/components/LanguageToggle';
import { PublicFooter, usePageMeta } from '@/components/public/PublicShell';
import { isCurrentTab, publicTabLabel, publicTabsFor, useCurrentTabInView } from '@/components/public/publicTabs';
import { useTranslation } from '@/i18n';
import {
  BEVEL_WINDOW,
  FONT_CHROME,
  FONT_PIXEL,
  GRADIENT,
  GlyphClose,
  HOLO,
  HoloSparkles,
  HoloWindowBody,
  SHADOW,
  TEXTURE,
} from '@/components/retro/holo';

export const X_URL = 'https://x.com/TrySpareRH';
export const TELEGRAM_URL = 'https://t.me/sparerh';

/* ------------------------------- page meta -------------------------------- */

/** Document title + meta description per route — the same hook PublicShell uses. */
export { usePageMeta };

/* ------------------------------ link button -------------------------------- */

export interface HoloLinkButtonProps {
  /** Internal route. */
  to?: string;
  /** External URL (opens in a new tab). */
  href?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  style?: CSSProperties;
}

/** A router Link (or external anchor) wearing the Holo button face. */
export function HoloLinkButton({ to, href, variant = 'secondary', size = 'md', children, style }: HoloLinkButtonProps) {
  const cls = ['holo-btn', variant !== 'secondary' ? `holo-btn--${variant}` : '', size !== 'md' ? `holo-btn--${size}` : '']
    .filter(Boolean)
    .join(' ');
  const s: CSSProperties = { textDecoration: 'none', ...style };
  if (href) {
    return (
      <a className={cls} href={href} target="_blank" rel="noopener noreferrer" style={s}>
        {children}
      </a>
    );
  }
  return (
    <Link className={cls} to={to ?? '/'} style={s}>
      {children}
    </Link>
  );
}

/** A row of CTAs that wraps on phones. */
export function CtaRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{children}</div>;
}

/* --------------------------------- window --------------------------------- */

export interface HoloPageWindowProps {
  /** Title-bar text, e.g. "Spare — Fees.exe". */
  exeTitle: string;
  /** 16px title-bar icon (a /icons/spare/*.png). */
  icon: string;
  /** Pixel-caps banner under the menu, e.g. "SPARE · FEES · LIVE". */
  banner: string;
  /** Which menu entry is this page (its canonical route). Default: the current URL. */
  current?: string;
  /** Blink the banner dot (the page shows live chain data). */
  live?: boolean;
  children: ReactNode;
}

export function HoloPageWindow({ exeTitle, icon, banner, current, live = true, children }: HoloPageWindowProps) {
  const { t } = useTranslation('shell');
  const { pathname } = useLocation();
  const here = current ?? pathname;
  const tabsRef = useCurrentTabInView<HTMLElement>(here);
  // A new page starts at the top (a #section jump keeps its place).
  useEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
  }, []);
  // Pastel overscroll instead of the app's dark body.
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = HOLO.cream;
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  return (
    <div className="spw-root">
      <div aria-hidden className="spw-sky">
        <HoloSparkles count={14} seed={23} sizes={[6, 18]} />
      </div>

      <div className="spw-window">
        {/* title bar */}
        <div className="spw-titlebar">
          <img src={icon} alt="" width={18} height={18} draggable={false} style={{ imageRendering: 'pixelated', flexShrink: 0 }} />
          <span className="spw-title">{exeTitle}</span>
          <Link to="/" className="spw-open">
            {t('publicFrame.openSpare')}
          </Link>
          <LanguageToggle variant="bar" />
          <Link to="/" className="spw-close" aria-label={t('publicFrame.closeAria')} title={t('publicFrame.backTitle')}>
            <GlyphClose />
          </Link>
        </div>

        {/* menu bar */}
        <nav className="spw-menubar" aria-label={t('publicFrame.pagesAria')} ref={tabsRef}>
          {publicTabsFor(here).map((m) => (
            <Link key={m.to} to={m.to} className="spw-menu-item" aria-current={isCurrentTab(m, here) ? 'page' : undefined}>
              {publicTabLabel(m)}
            </Link>
          ))}
        </nav>

        {/* banner */}
        <div className="spw-banner">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span aria-hidden className={`spw-dot${live ? ' spw-dot--live' : ''}`} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{banner}</span>
          </span>
          {/* i18n-ignore: chain name stays English */}
          <span className="spw-chain">ROBINHOOD CHAIN · 4663</span>
        </div>

        <main>
          <HoloWindowBody padding={18} gap={16} style={{ minHeight: 0 }}>
            {children}
          </HoloWindowBody>
        </main>

        <div className="spw-footer">
          <PublicFooter />
        </div>
      </div>

      <style>{`
        .spw-root {
          position: relative;
          min-height: 100dvh;
          padding: 18px 16px 28px;
          background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky};
          background-attachment: fixed;
          color: ${HOLO.ink};
          isolation: isolate;
          overflow-x: hidden;
        }
        .spw-sky { position: fixed; inset: 0; z-index: -1; pointer-events: none; }
        .spw-window {
          position: relative;
          max-width: 1120px;
          margin: 0 auto;
          background: ${HOLO.frame};
          box-shadow: ${BEVEL_WINDOW}, ${SHADOW.window};
          padding: 3px;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .spw-titlebar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 4px 4px 8px;
          background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar};
          color: #FFFFFF;
          min-width: 0;
        }
        .spw-title {
          flex: 1;
          min-width: 0;
          font-family: ${FONT_CHROME};
          font-weight: 400;
          font-size: 21px;
          line-height: 1;
          letter-spacing: .02em;
          text-shadow: ${SHADOW.titleText};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .spw-open {
          display: inline-flex;
          align-items: center;
          height: 22px;
          padding: 0 10px;
          background: var(--holo-chrome);
          box-shadow: 0 0 0 1px ${HOLO.ink}, var(--holo-raised);
          color: ${HOLO.ink};
          font-family: ${FONT_CHROME};
          font-weight: 400;
          font-size: 17px;
          text-decoration: none;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .spw-open:active { box-shadow: 0 0 0 1px ${HOLO.ink}, var(--holo-pressed); }
        .spw-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 20px;
          background: linear-gradient(180deg, #FFF1F7 0%, #FFC9E0 100%);
          box-shadow: var(--holo-raised);
          color: ${HOLO.ink};
          flex-shrink: 0;
        }
        .spw-close:active { box-shadow: var(--holo-pressed); }
        .spw-menubar {
          display: flex;
          gap: 2px;
          padding: 3px 4px;
          background: ${GRADIENT.menuBar};
          border-bottom: 1px solid ${HOLO.bevelLo};
          overflow-x: auto;
          scrollbar-width: none;
        }
        .spw-menubar::-webkit-scrollbar { display: none; }
        .spw-menu-item {
          padding: 3px 10px;
          font-family: ${FONT_CHROME};
          font-weight: 400;
          font-size: 19px;
          line-height: 1.1;
          color: ${HOLO.ink};
          text-decoration: none;
          white-space: nowrap;
        }
        .spw-menu-item:hover { background: rgba(201, 182, 255, .35); box-shadow: inset 0 0 0 1px rgba(42, 27, 110, .3); }
        .spw-menu-item:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: -3px; }
        .spw-menu-item[aria-current='page'] { background: ${HOLO.ink}; color: ${HOLO.onScreen}; }
        .spw-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 6px 12px;
          background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen};
          color: ${HOLO.onScreen};
          font-family: ${FONT_PIXEL};
          font-size: 11px;
          letter-spacing: .14em;
          text-transform: uppercase;
          min-width: 0;
        }
        .spw-chain { color: ${HOLO.onScreenMuted}; white-space: nowrap; flex-shrink: 0; }
        .spw-footer {
          padding: 6px 16px 16px;
          background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.menuBar};
          border-top: 2px solid ${HOLO.ink};
        }
        .spw-dot { width: 8px; height: 8px; flex-shrink: 0; background: ${HOLO.lilac}; box-shadow: 0 0 0 1px rgba(255,255,255,.4); }
        .spw-dot--live { background: ${HOLO.goodFill}; animation: win98-pulse 1.1s steps(2, end) infinite; }
        @media (max-width: 767px) {
          .spw-root { padding: 8px 8px 20px; }
          .spw-title { font-size: 18px; }
          .spw-open { display: none; }
          .spw-menu-item { font-size: 18px; padding: 4px 8px; }
          .spw-chain { display: none; }
          .spw-footer { padding: 4px 12px 12px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .spw-dot--live { animation: none; }
        }
      `}</style>
    </div>
  );
}

export default HoloPageWindow;
