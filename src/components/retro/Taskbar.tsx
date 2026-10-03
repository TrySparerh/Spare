/**
 * Taskbar — bottom bar of the desktop. Start menu button on the left,
 * a button per open window in the middle, system tray on the right.
 * Click any window button to toggle minimize/restore.
 *
 * Spare Holo skin: lilac-cream bar with an indigo top edge, chrome Start key
 * carrying the Spare mark, pastel window keys (focused = pressed + tinted),
 * then zoom, the language key and the tray.
 *
 * The Spare mascot (the iridescent Spare mark) stands ON the bar's top edge,
 * just left of the zoom control, under every window (z 15 < windows 21+), so it
 * never sits on a window's status bar or content. Phones hide it (mobile CSS)
 * to give the one window key its room.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { AppIcon } from './AppIcon';
import { useWindowManager } from './WindowManager';
import { StartMenu } from './StartMenu';
import { SystemTray } from './SystemTray';
import { ZoomControl } from './ZoomControl';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from '@/i18n';
import { BEVEL_PRESSED, BEVEL_RAISED, FONT_CHROME, FONT_PIXEL, GRADIENT, HOLO, TEXTURE } from './holo/tokens';
import { HoloStar } from './holo/HoloSparkles';

export function Taskbar() {
  const { t } = useTranslation('shell');
  const wm = useWindowManager();
  const isMobile = useIsMobile();
  const [startOpen, setStartOpen] = useState(false);
  // The mascot stands just left of the right-hand cluster (zoom, language,
  // tray). That cluster's width changes with its content (ETH price, wallet,
  // $SPARE pill, zoom), so measure from a zero-width anchor at its left edge
  // rather than hard-code; mobile CSS hides the mascot.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [mascotRight, setMascotRight] = useState(360);
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const left = el.getBoundingClientRect().left;
      setMascotRight(Math.max(0, Math.round(window.innerWidth - left + 2)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    // The anchor moves whenever anything to its right (zoom, tray) changes width.
    ro.observe(el);
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) ro.observe(n);
    window.addEventListener('resize', measure);
    window.addEventListener('ui-zoom', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('ui-zoom', measure);
    };
  }, []);

  const allOpenWindows = wm.apps
    .map((app) => ({ app, state: wm.windows[app.id] }))
    .filter((w) => w.state?.isOpen)
    .sort((a, b) => a.state.zIndex - b.state.zIndex);
  // Mobile only ever has one window visible (full-screen) — surface just
  // the most-recently-focused one. Desktop + tablet cap at 4 buttons so
  // the bar doesn't get crowded once you stack a lot of windows; the cap
  // keeps the 4 highest-zIndex (most recently focused/opened) windows
  // visible, older ones still live in the WindowManager and the Start menu.
  const openWindows = isMobile ? allOpenWindows.slice(-1) : allOpenWindows.slice(-4);

  return (
    <>
      {startOpen && (
        <StartMenu
          onClose={() => setStartOpen(false)}
          onLaunch={(id) => {
            wm.openApp(id);
            setStartOpen(false);
          }}
        />
      )}
      {/* Spare mascot — a sibling of the taskbar (not a child) so the bar's
          overflow can't clip it. It stands on the bar's top edge and sits
          under every AppWindow (z 15 < 21+), so windows cover it instead of
          it covering their status bars. Decorative: pointer-events none.
          (data-taskbar-robot is the hook the mobile CSS uses to hide it.) */}
      <img
        data-taskbar-robot
        src="/icons/spare-logo.png"
        alt=""
        aria-hidden
        style={{
          position: 'fixed',
          bottom: 38,
          right: mascotRight,
          width: 64,
          height: 64,
          objectFit: 'contain',
          objectPosition: 'center bottom',
          pointerEvents: 'none',
          zIndex: 15,
          filter: 'drop-shadow(2px 2px 0 rgba(42,27,110,.35)) drop-shadow(0 0 6px rgba(255,255,255,.7))',
        }}
        draggable={false}
      />
      <div
        data-taskbar
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          height: 40,
          background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.taskbar}`,
          boxShadow: `inset 0 1px 0 0 ${HOLO.ink}, inset 0 2px 0 0 #FFFFFF, 0 -6px 18px rgba(74,58,168,.18)`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 3px',
          gap: 4,
          zIndex: 100,
          userSelect: 'none',
          overflow: 'visible',
        }}
      >
        {/* Start button — StartMenu's outside-click guard matches it by
            data-start-button (the label is translated), so a click here
            toggles instead of closing and reopening. */}
        <button
          data-start-button
          onClick={() => setStartOpen((v) => !v)}
          aria-expanded={startOpen}
          aria-haspopup="menu"
          className="holo-taskbtn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: isMobile ? 30 : 32,
            padding: isMobile ? (startOpen ? '2px 5px 0 7px' : '0 6px') : startOpen ? '2px 10px 0 8px' : '0 10px 0 6px',
            background: startOpen ? 'linear-gradient(180deg, #E6DCFF 0%, #F6E6FF 100%)' : GRADIENT.chrome,
            boxShadow: `0 0 0 1px ${HOLO.ink}, ${startOpen ? BEVEL_PRESSED : BEVEL_RAISED}`,
            border: 0,
            marginLeft: 2,
            cursor: 'pointer',
            fontFamily: FONT_CHROME,
            fontWeight: 400,
            fontSize: isMobile ? 18 : 22,
            letterSpacing: 0.3,
            color: HOLO.ink,
            flexShrink: 0,
          }}
        >
          <span data-taskbar-start-icon style={{ display: 'inline-flex' }}>
            <HoloStar size={22} />
          </span>
          <span>{t('taskbar.start')}</span>
        </button>

        <div style={{ width: 2, height: 28, background: HOLO.bevelLo, boxShadow: '1px 0 0 0 #fff', margin: isMobile ? '0 1px' : '0 4px', flexShrink: 0 }} />

        {/* Open window buttons (the mascot stands above the bar, so they get the full width) */}
        <div data-taskbar-windows style={{ display: 'flex', gap: 3, flex: 1, minWidth: isMobile ? undefined : 0, overflow: 'hidden' }}>
          {openWindows.map(({ app, state }) => {
            const isFocused = wm.focusedId === app.id && !state.isMinimized;
            return (
              <button
                key={app.id}
                onClick={() => wm.toggleMinimize(app.id)}
                className="taskbar-window-btn holo-taskbtn"
                aria-pressed={isFocused}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 32,
                  flex: '0 1 200px',
                  minWidth: 96,
                  maxWidth: 200,
                  padding: isFocused ? '2px 8px 0 10px' : '0 8px',
                  background: isFocused
                    ? `${TEXTURE.dither} 0 0 / 4px 4px, linear-gradient(180deg, #E6DCFF 0%, #FBE8F6 100%)`
                    : GRADIENT.face,
                  boxShadow: isFocused ? BEVEL_PRESSED : BEVEL_RAISED,
                  border: 0,
                  cursor: 'pointer',
                  fontFamily: FONT_CHROME,
                  fontSize: 17,
                  color: HOLO.ink,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  fontWeight: 400,
                }}
              >
                <AppIcon app={app} size={18} letterSize="sm" />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.title}</span>
              </button>
            );
          })}
        </div>

        {/* Zero-width anchor at the left edge of the zoom / language / tray
            cluster: the mascot measures its position from here. */}
        <span ref={anchorRef} aria-hidden style={{ width: 0, height: 0, flexShrink: 0 }} />
        <ZoomControl />
        <LanguageToggle variant="tray" />
        <SystemTray />
      </div>
    </>
  );
}

export default Taskbar;
