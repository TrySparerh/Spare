/**
 * Desktop — the workspace after login. Renders:
 *   - the Spare world wallpaper (bottom layer)
 *   - the live stock tape along the top
 *   - the desktop icon grid (launches apps)
 *   - every open AppWindow
 *   - the taskbar with Start menu, open apps and system tray
 *   - the first-run welcome dialog
 *
 * Ctrl+Alt+Del opens the Task Manager easter egg.
 */
import { useEffect, useState } from 'react';
import { AppIcon } from './AppIcon';
import { AppWindow } from './AppWindow';
import { useWindowManager, type AppDescriptor } from './WindowManager';
import { LiveTickerBanner } from './LiveTickerBanner';
import { SpareWelcome } from './SpareWelcome';
import { Taskbar } from './Taskbar';
import { SpareWorldBackground } from './SpareWorldBackground';
import { useIsMobile } from '@/hooks/use-mobile';
import { FONT_CHROME, SHADOW } from './holo/tokens';

interface DesktopProps {
  /** Show the first-run welcome dialog (visitors without a round-up rule). */
  welcome?: boolean;
}

export function Desktop({ welcome = true }: DesktopProps) {
  const wm = useWindowManager();
  const isMobile = useIsMobile();
  const [showWelcome, setShowWelcome] = useState(welcome);

  // Ctrl+Alt+Del → task manager
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'Delete' || e.key === 'Del')) {
        e.preventDefault();
        wm.openApp('taskmanager');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wm]);

  const desktopIconApps = wm.apps.filter((a) => a.showOnDesktop !== false);

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', background: '#000', overflow: 'hidden' }}>
      <SpareWorldBackground />

      {/* Live stock tape along the top edge */}
      <LiveTickerBanner />

      {/* Desktop icon grid (offset top by the live-ticker bar height) */}
      <div
        data-desktop-icons
        style={{
          position: 'absolute',
          top: 48,
          left: 24,
          display: 'flex',
          flexDirection: 'column',
          flexWrap: 'wrap',
          maxHeight: 'calc(100vh - 120px)',
          gap: 16,
          zIndex: 5,
        }}
      >
        {desktopIconApps.filter((a) => a.id !== 'recycle-bin').map((app) => (
          <DesktopIcon key={app.id} app={app} />
        ))}
        {/* On mobile the bottom-right recycle bin slot is hidden — fold it
            into the icon grid so it remains reachable. */}
        {(() => {
          const rb = wm.apps.find((a) => a.id === 'recycle-bin');
          return rb ? (
            <div data-recycle-bin-inline className="recycle-bin-inline">
              <DesktopIcon app={rb} />
            </div>
          ) : null;
        })()}
      </div>

      {/* Recycle Bin — bottom-right corner (desktop only; hidden on mobile via CSS) */}
      <div data-recycle-bin-corner style={{ position: 'absolute', bottom: 56, right: 24, zIndex: 5 }}>
        {(() => {
          const rb = wm.apps.find((a) => a.id === 'recycle-bin');
          return rb ? <DesktopIcon app={rb} /> : null;
        })()}
      </div>

      {/* All windows */}
      {wm.apps.map((app) => (
        <AppWindow key={app.id} app={app}>
          <app.component />
        </AppWindow>
      ))}

      <Taskbar />

      {showWelcome && (
        <SpareWelcome
          width={isMobile ? 340 : 460}
          onSetUp={() => {
            wm.openApp('link-wallet');
            setShowWelcome(false);
          }}
          onClose={() => setShowWelcome(false)}
        />
      )}
    </div>
  );
}

function DesktopIcon({ app }: { app: AppDescriptor }) {
  const wm = useWindowManager();
  const launch = () => {
    if (app.externalUrl) {
      window.open(app.externalUrl, '_blank', 'noopener,noreferrer');
    } else {
      wm.openApp(app.id);
    }
  };
  return (
    <button
      onDoubleClick={launch}
      onClick={launch}
      className="holo-desktop-icon"
      style={{
        width: 96,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 5,
        background: 'none',
        border: 0,
        cursor: 'pointer',
        padding: 6,
      }}
    >
      <span style={{ display: 'flex', filter: 'drop-shadow(2px 3px 0 rgba(42,27,110,.28))' }}>
        <AppIcon app={app} size={64} letterSize="xl" surface="world" />
      </span>
      <span
        className="holo-desktop-icon__label"
        style={{
          fontFamily: FONT_CHROME,
          fontWeight: 400,
          fontSize: 17,
          letterSpacing: 0.3,
          color: '#fff',
          textShadow: SHADOW.textOutline,
          textAlign: 'center',
          lineHeight: 1.2,
          padding: '1px 4px 2px',
          userSelect: 'none',
        }}
      >
        {app.title}
      </span>
    </button>
  );
}

export default Desktop;
