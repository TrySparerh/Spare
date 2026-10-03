/**
 * StartMenu — Win98-style start menu in the Spare Holo skin. Categorized
 * program launches + Disconnect Wallet shutdown.
 *
 * Sections: Programs · Markets · Resources · Web (the public Spare pages from
 * PUBLIC_ROUTES: essentials first, the rest behind "More pages") · System
 * (incl. the Task Manager easter egg). Every row carries a pixel icon or a
 * chrome pictogram tile — no letter tiles. The menu is capped to sit below the
 * live ticker and scrolls inside itself.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { AppIcon } from './AppIcon';
import { useWindowManager } from './WindowManager';
import { PUBLIC_ROUTES, type PublicRoute } from '@/lib/publicRoutes';
import { useTranslation } from '@/i18n';
import { BEVEL_WINDOW, FONT_DISPLAY, FONT_PIXEL, GRADIENT, HOLO, SHADOW, TEXTURE } from './holo/tokens';
import { HoloSparkle, HoloStar } from './holo/HoloSparkles';
import { GlyphArrowDown, HoloGlyphTile } from './holo/HoloGlyphs';

interface StartMenuProps {
  onClose: () => void;
  onLaunch: (id: string) => void;
}

export function StartMenu({ onClose, onLaunch }: StartMenuProps) {
  const { t } = useTranslation('shell');
  const wm = useWindowManager();
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const ref = useRef<HTMLDivElement | null>(null);

  // Click outside closes
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Don't close if clicking the Start button itself (taskbar handles toggle).
        // Matched by data attribute, not text, so it works in every language.
        const target = e.target as HTMLElement;
        if (target.closest('[data-start-button]')) return;
        onClose();
      }
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

  const programs  = wm.apps.filter((a) => a.showInStartMenu !== false && a.category === 'Programs');
  const markets   = wm.apps.filter((a) => a.showInStartMenu !== false && a.category === 'Markets');
  const resources = wm.apps.filter((a) => a.showInStartMenu !== false && a.category === 'Resources');
  // The Task Manager easter egg lives with the other system tools.
  const system    = wm.apps.filter((a) => a.category === 'System' || a.category === 'Easter Eggs');

  return (
    <div
      ref={ref}
      data-start-menu
      style={{
        position: 'fixed',
        left: 3,
        bottom: 42,
        width: 256,
        background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card}`,
        boxShadow: `${BEVEL_WINDOW}, ${SHADOW.pop}`,
        zIndex: 200,
        display: 'flex',
        padding: 3,
        // Never taller than the space between the live ticker (~34px) and the
        // taskbar: scroll inside the menu instead of covering the ticker.
        maxHeight: 'calc(100vh - 80px)',
        overflowY: 'auto',
      }}
    >
      {/* Vertical "SPARE" sidebar — brand sky with the mark */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          width: 34,
          flexShrink: 0,
          background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(0deg, #3B2A9E 0%, #7A55E0 38%, #E58FD6 72%, #FFD9C2 100%)`,
          boxShadow: `inset -1px 0 0 0 ${HOLO.ink}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 0',
          overflow: 'hidden',
        }}
      >
        <HoloStar size={24} keyline />
        <div
          style={{
            color: '#fff',
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            textAlign: 'center',
            fontFamily: FONT_DISPLAY,
            fontSize: 11,
            letterSpacing: 2,
            textShadow: `1px 1px 0 ${HOLO.ink}, -1px 0 0 ${HOLO.ink}, 0 -1px 0 ${HOLO.ink}, 1px 0 0 ${HOLO.ink}`,
            whiteSpace: 'nowrap',
          }}
        >
          SPARE
        </div>
        <HoloSparkle size={9} glow={false} />
      </div>

      <div style={{ flex: 1, padding: 4, minWidth: 0 }}>
        <Section title={t('startMenu.sections.programs')} items={programs} onLaunch={onLaunch} />
        {markets.length > 0 && (
          <>
            <Divider />
            <Section title={t('startMenu.sections.markets')} items={markets} onLaunch={onLaunch} />
          </>
        )}
        {resources.length > 0 && (
          <>
            <Divider />
            <Section title={t('startMenu.sections.resources')} items={resources} onLaunch={onLaunch} />
          </>
        )}
        {/* Web — the public Spare pages (same list as the login screen). */}
        <Divider />
        <WebSection onClose={onClose} />
        {system.length > 0 && (
          <>
            <Divider />
            <Section title={t('startMenu.sections.system')} items={system} onLaunch={onLaunch} />
          </>
        )}
        <Divider />
        <button
          onClick={() => {
            if (isConnected) disconnect();
            onClose();
          }}
          className="holo-menu-item"
          style={menuItemStyle('amber')}
        >
          <HoloGlyphTile kind="power" />
          <span>{isConnected ? t('startMenu.disconnectWallet') : t('startMenu.shutDown')}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Web — the public Spare pages (Docs, Stock Universe, Live Sweeps, …). They
 * aren't apps in the window manager; they're SPA routes that open in a new tab
 * so the desktop session isn't disrupted. X and Telegram are left out here:
 * the Resources section already launches them.
 *
 * Renders as anchor tags (not buttons) so middle-click + cmd-click work
 * the way browsers expect.
 */
function WebSection({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell');
  const [more, setMore] = useState(false);
  const moreId = useId();
  const pages = PUBLIC_ROUTES.filter((r) => !r.external);
  const core = pages.filter((r) => r.core);
  const rest = pages.filter((r) => !r.core);
  return (
    <div>
      <div style={sectionHeadStyle}>{t('startMenu.sections.web')}</div>
      {core.map((r) => (
        <WebLink key={r.href} route={r} onClose={onClose} />
      ))}
      {rest.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            aria-expanded={more}
            aria-controls={moreId}
            className="holo-menu-item"
            style={menuItemStyle()}
          >
            <HoloGlyphTile kind="grid" />
            <span style={{ flex: 1 }}>{more ? t('startMenu.fewerPages') : t('startMenu.morePages')}</span>
            <GlyphArrowDown color="currentColor" style={{ transform: more ? 'rotate(180deg)' : undefined, marginRight: 2 }} />
          </button>
          <div id={moreId} hidden={!more}>
            {rest.map((r) => (
              <WebLink key={r.href} route={r} onClose={onClose} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function WebLink({ route: r, onClose }: { route: PublicRoute; onClose: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <a
      href={r.href}
      target="_blank"
      rel="noopener noreferrer"
      title={r.tagline ? t(r.tagline) : undefined}
      onClick={onClose}
      className="holo-menu-item"
      style={{ ...menuItemStyle(), textDecoration: 'none' }}
    >
      <HoloGlyphTile kind={r.glyph ?? 'globe'} />
      <span>{t(r.label)}</span>
    </a>
  );
}

function Section({ title, items, onLaunch }: { title: string; items: ReturnType<typeof useWindowManager>['apps']; onLaunch: (id: string) => void }) {
  return (
    <div>
      <div style={sectionHeadStyle}>{title}</div>
      {items.map((app) => (
        <button key={app.id} onClick={() => onLaunch(app.id)} className="holo-menu-item" style={menuItemStyle()}>
          <AppIcon app={app} size={20} letterSize="sm" />
          <span>{app.title}</span>
        </button>
      ))}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 2,
        background: HOLO.bevelLo,
        boxShadow: '0 1px 0 0 #fff',
        margin: '5px 4px',
      }}
    />
  );
}

const sectionHeadStyle: React.CSSProperties = {
  fontFamily: FONT_PIXEL,
  fontSize: 9.5,
  color: HOLO.inkMuted,
  textTransform: 'uppercase',
  padding: '5px 6px 2px',
  letterSpacing: 1.2,
};

/** Layout only — colours, font and hover live on .holo-menu-item (holo.css). */
function menuItemStyle(_accent?: 'amber'): React.CSSProperties {
  return {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  };
}

export default StartMenu;
