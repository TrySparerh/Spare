/**
 * LivePageFrame — the standalone frame for the live public pages
 * (/datalayer, /dispatch, /mcp): one Spare Holo app window floating over the
 * pastel pixel-world Spline scene, so each page reads like an app from the
 * desktop.
 *
 *   [title bar   icon  Spare — MCP.exe                         [×]]
 *   [menu bar    Docs  Universe  Dispatch  Data Layer  DevTools  MCP  …]
 *   [banner      ● SPARE MCP · READ-ONLY        ROBINHOOD CHAIN · 4663]
 *   [canvas      page content (HoloWindowBody)                        ]
 *   [footer      shared Spare footer                                  ]
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LanguageToggle } from '@/components/LanguageToggle';
import { FullBleedWorld } from '@/components/retro/SpareWorldBackground';
import { isCurrentTab, publicTabLabel, publicTabsFor, useCurrentTabInView } from '@/components/public/publicTabs';
import { PUBLIC_FOOTER_LINKS } from '@/components/public/PublicShell';
import { useTranslation } from '@/i18n';
import {
  BEVEL_WINDOW,
  FONT_CHROME,
  FONT_PIXEL,
  FONT_TEXT,
  GRADIENT,
  GlyphClose,
  HOLO,
  HoloSparkle,
  HoloWindowBody,
  SHADOW,
  TEXTURE,
} from '@/components/retro/holo';

export const X_URL = 'https://x.com/TrySpareRH';
export const TELEGRAM_URL = 'https://t.me/sparerh';

/** The shared public-page footer. Text: shell `publicFrame.*` (same as PublicFooter). */
export function LiveFooter() {
  const { t } = useTranslation('shell');
  const link: CSSProperties = {
    fontFamily: FONT_CHROME,
    fontWeight: 400,
    fontSize: 18,
    color: HOLO.link,
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: 3,
  };
  return (
    <footer className="lpf-footer">
      <div style={{ fontFamily: FONT_PIXEL, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', lineHeight: 1.5 }}>
        {t('publicFrame.footer.brand')}
      </div>
      <nav aria-label={t('publicFrame.footer.linksAria')} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
        {PUBLIC_FOOTER_LINKS.map((l) =>
          l.external ? (
            <a key={l.to} href={l.to} target="_blank" rel="noopener noreferrer" style={link}>
              {t(l.label)}
            </a>
          ) : (
            <Link key={l.to} to={l.to} style={link}>
              {t(l.label)}
            </Link>
          ),
        )}
      </nav>
      <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.55, color: HOLO.inkMuted, maxWidth: 820 }}>
        {t('publicFrame.footer.legal')}
      </p>
    </footer>
  );
}

export interface LivePageFrameProps {
  /** Title-bar text, e.g. "Spare — MCP.exe". */
  exeTitle: string;
  /** 16–18px title-bar icon. Default: the Spare mark. */
  icon?: string;
  /** Pixel-caps banner, left side (e.g. "SPARE · DATA LAYER"). */
  banner: ReactNode;
  /** Banner, right side. Default "ROBINHOOD CHAIN · 4663". */
  bannerRight?: ReactNode;
  /** Blink the banner dot (the page shows live chain data). */
  live?: boolean;
  /** Max window width in px. Default 1120. */
  maxWidth?: number;
  children: ReactNode;
}

export function LivePageFrame({ exeTitle, icon = '/icons/spare-logo.png', banner, bannerRight, live = true, maxWidth = 1120, children }: LivePageFrameProps) {
  const { t } = useTranslation('shell');
  const { pathname } = useLocation();
  const tabsRef = useCurrentTabInView<HTMLElement>(pathname);
  return (
    <div className="lpf-root">
      {/* The pastel pixel world (Spline), fixed behind everything. */}
      <FullBleedWorld />
      <div aria-hidden className="lpf-veil" />

      <div className="lpf-window" style={{ maxWidth }}>
        <div className="lpf-titlebar">
          <img src={icon} alt="" width={18} height={18} draggable={false} style={{ imageRendering: 'pixelated', flexShrink: 0 }} />
          <span className="lpf-title">{exeTitle}</span>
          <HoloSparkle size={9} glow={false} />
          <span style={{ flex: 1 }} />
          <LanguageToggle variant="bar" />
          <Link to="/" className="lpf-close" aria-label={t('publicFrame.closeAria')} title={t('publicFrame.backTitle')}>
            <GlyphClose />
          </Link>
        </div>

        <nav className="lpf-menubar" aria-label={t('publicFrame.pagesAria')} ref={tabsRef}>
          {publicTabsFor(pathname).map((p) => (
            <Link key={p.to} to={p.to} className="lpf-menu-item" aria-current={isCurrentTab(p, pathname) ? 'page' : undefined}>
              {publicTabLabel(p)}
            </Link>
          ))}
        </nav>

        <div className="lpf-banner">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span aria-hidden className={`lpf-dot${live ? ' lpf-dot--live' : ''}`} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{banner}</span>
          </span>
          {/* i18n-ignore: chain name stays English */}
          <span className="lpf-banner-right">{bannerRight ?? 'ROBINHOOD CHAIN · 4663'}</span>
        </div>

        <main>
          <HoloWindowBody padding={18} gap={16} style={{ minHeight: 0 }}>
            {children}
          </HoloWindowBody>
        </main>

        <LiveFooter />
      </div>

      <style>{FRAME_CSS}</style>
    </div>
  );
}

const FRAME_CSS = `
  .lpf-root {
    position: relative;
    min-height: 100dvh;
    /* the language key lives in the title bar, so no bottom room is reserved for it */
    padding: 22px 16px 48px;
    background: ${GRADIENT.sky};
    color: ${HOLO.ink};
    isolation: isolate;
    overflow-x: hidden;
  }
  .lpf-root > [data-desktop-bg] { z-index: -2; }
  .lpf-veil {
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: ${TEXTURE.dither} 0 0 / 4px 4px;
  }
  .lpf-window {
    position: relative;
    margin: 0 auto;
    background: ${HOLO.frame};
    box-shadow: ${BEVEL_WINDOW}, ${SHADOW.window};
    padding: 3px;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .lpf-titlebar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 8px;
    background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar};
    color: #FFFFFF;
    min-width: 0;
  }
  .lpf-title {
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
  .lpf-close {
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
  .lpf-close:hover { background: linear-gradient(180deg, #FFE3EF 0%, #FFA9CD 100%); }
  .lpf-close:active { box-shadow: var(--holo-pressed); }
  .lpf-close:focus-visible { outline: 1px dotted #FFFFFF; outline-offset: 1px; }
  .lpf-menubar {
    display: flex;
    gap: 2px;
    padding: 3px 4px;
    background: ${GRADIENT.menuBar};
    border-bottom: 1px solid ${HOLO.bevelLo};
    overflow-x: auto;
    scrollbar-width: none;
  }
  .lpf-menubar::-webkit-scrollbar { display: none; }
  .lpf-menu-item {
    padding: 3px 10px;
    font-family: ${FONT_CHROME};
    font-weight: 400;
    font-size: 19px;
    line-height: 1.1;
    color: ${HOLO.ink};
    text-decoration: none;
    white-space: nowrap;
  }
  .lpf-menu-item:hover { background: rgba(201, 182, 255, .35); box-shadow: inset 0 0 0 1px rgba(42, 27, 110, .3); }
  .lpf-menu-item:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: -3px; }
  .lpf-menu-item[aria-current='page'] { background: ${HOLO.ink}; color: ${HOLO.onScreen}; }
  .lpf-banner {
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
  .lpf-banner-right { color: ${HOLO.onScreenMuted}; white-space: nowrap; flex-shrink: 0; display: inline-flex; align-items: center; gap: 10px; }
  .lpf-dot { width: 8px; height: 8px; flex-shrink: 0; background: ${HOLO.lilac}; box-shadow: 0 0 0 1px rgba(255,255,255,.4); }
  .lpf-dot--live { background: ${HOLO.goodFill}; animation: lpf-pulse 1.1s steps(2, end) infinite; }
  @keyframes lpf-pulse { 50% { opacity: .35; } }
  .lpf-footer {
    background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.menuBar};
    border-top: 2px solid ${HOLO.ink};
    padding: 12px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: ${HOLO.ink};
  }
  @media (max-width: 767px) {
    .lpf-root { padding: 8px 8px 24px; }
    .lpf-title { font-size: 18px; }
    .lpf-menu-item { font-size: 18px; padding: 4px 8px; }
    .lpf-banner { padding: 6px 10px; letter-spacing: .1em; }
    .lpf-banner-right { display: none; }
    .lpf-footer { padding: 10px 12px 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .lpf-dot--live { animation: none; }
  }
`;

export default LivePageFrame;
