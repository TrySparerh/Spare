/**
 * AppWindow — the Win98 window chrome that wraps each Spare "app", in the
 * Spare Holo skin: pastel bevelled frame, holo title bar with a white pixel
 * title, pastel min / max / close keys, cream menu bar.
 * Minimizable, closable. Z-index managed by WindowManager.
 *
 * Mobile: full-viewport takeover so touch targets fit.
 * Desktop / tablet: each app paints inside the size declared by its
 *   AppDescriptor.defaultSize, positioned by the WindowManager. Lets the
 *   teal desktop wallpaper breathe around smaller apps instead of every
 *   window stretching edge-to-edge (which left half the chrome empty).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppIcon } from './AppIcon';
import { useWindowManager, type AppDescriptor } from './WindowManager';
import { useIsMobile } from '@/hooks/use-mobile';
import { tKey, useTranslation } from '@/i18n';
import {
  BEVEL_SUNKEN,
  BEVEL_WINDOW,
  FONT_CHROME,
  GRADIENT,
  HOLO,
  INK_ON_SCREEN,
  SHADOW,
  TEXTURE,
} from './holo/tokens';
import { GlyphClose, GlyphMax, GlyphMin, GlyphRestore } from './holo/HoloGlyphs';
import { HoloSparkle } from './holo/HoloSparkles';

interface AppWindowProps {
  app: AppDescriptor;
  children: ReactNode;
}

// Smallest a window can be dragged down to — keeps the chrome usable.
const MIN_W = 360;
const MIN_H = 240;
// Reserve space so a maximized window clears the ticker (top) + taskbar (bottom).
const TOP_INSET = 34;
const BOTTOM_INSET = 46;

/**
 * The decorative Win98 menu bar. `accel` is the access-key letter: underlined
 * as the label's first letter when the label starts with it (English), or
 * shown after the label the way Chinese Windows does ("文件(F)").
 */
const MENU = [
  { key: tKey('appWindow.menu.file'), accel: 'F' },
  { key: tKey('appWindow.menu.edit'), accel: 'E' },
  { key: tKey('appWindow.menu.view'), accel: 'V' },
  { key: tKey('appWindow.menu.tools'), accel: 'T' },
  { key: tKey('appWindow.menu.help'), accel: 'H' },
] as const;

export function AppWindow({ app, children }: AppWindowProps) {
  const { t } = useTranslation('shell');
  const wm = useWindowManager();
  const state = wm.windows[app.id];
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement | null>(null);
  const titleBarRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ active: boolean; ox: number; oy: number }>({ active: false, ox: 0, oy: 0 });
  const resize = useRef<{ active: boolean; sx: number; sy: number; sw: number; sh: number }>({ active: false, sx: 0, sy: 0, sw: 0, sh: 0 });
  // Maximize toggle — stashes pre-max geometry so restore returns exactly.
  const [maxed, setMaxed] = useState(false);
  const preMax = useRef<{ size: { width: number; height: number }; position: { left: number; top: number } } | null>(null);
  const isFocused = wm.focusedId === app.id;

  const toggleMaximize = () => {
    if (isMobile || !state) return;
    if (maxed) {
      if (preMax.current) {
        wm.setSize(app.id, preMax.current.size);
        wm.setPosition(app.id, preMax.current.position);
      }
      setMaxed(false);
    } else {
      preMax.current = { size: state.size, position: state.position };
      wm.setSize(app.id, {
        width: window.innerWidth - 8,
        height: window.innerHeight - TOP_INSET - BOTTOM_INSET,
      });
      wm.setPosition(app.id, { left: 4, top: TOP_INSET });
      setMaxed(true);
    }
  };

  // Drag-to-move via the title bar. Disabled on mobile (touch-awkward and
  // the window is full-screen anyway). On desktop/tablet, lets users
  // arrange multiple windows side-by-side like a real Win98 desktop.
  useEffect(() => {
    if (isMobile) return;
    const onDown = (e: MouseEvent) => {
      const tb = titleBarRef.current;
      const win = ref.current;
      if (!tb || !win) return;
      if (!tb.contains(e.target as Node)) return;
      const t = e.target as HTMLElement;
      if (t.closest('.win-close') || t.closest('.win-minimize') || t.closest('.win-maximize')) return;
      const r = win.getBoundingClientRect();
      drag.current.active = true;
      drag.current.ox = e.clientX - r.left;
      drag.current.oy = e.clientY - r.top;
      wm.focusApp(app.id);
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (drag.current.active) {
        const nx = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - drag.current.ox));
        const ny = Math.max(0, Math.min(window.innerHeight - 80, e.clientY - drag.current.oy));
        wm.setPosition(app.id, { left: nx, top: ny });
      } else if (resize.current.active) {
        const nw = Math.max(MIN_W, Math.min(window.innerWidth, resize.current.sw + (e.clientX - resize.current.sx)));
        const nh = Math.max(MIN_H, Math.min(window.innerHeight, resize.current.sh + (e.clientY - resize.current.sy)));
        wm.setSize(app.id, { width: nw, height: nh });
      }
    };
    const onUp = () => { drag.current.active = false; resize.current.active = false; };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [app.id, wm, isMobile]);

  if (!state || !state.isOpen) return null;

  // Mobile: pin to the visible viewport area between the ticker and taskbar.
  // Desktop / tablet: respect each app's declared defaultSize (state.size)
  // and the WindowManager-assigned position, so the window appears as a
  // properly-sized Win98 floating window.
  const windowStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        left: 0,
        top: 32,
        width: '100vw',
        height: 'calc(100vh - 76px)',
      }
    : {
        position: 'absolute',
        left: state.position.left,
        top: state.position.top,
        width: state.size.width,
        height: state.size.height,
      };

  return (
    <div
      ref={ref}
      data-app-window
      onMouseDown={() => wm.focusApp(app.id)}
      style={{
        ...windowStyle,
        background: GRADIENT.face,
        boxShadow: isMobile ? BEVEL_WINDOW : `${BEVEL_WINDOW}, ${isFocused ? SHADOW.window : SHADOW.pop}`,
        zIndex: state.zIndex,
        display: state.isMinimized ? 'none' : 'flex',
        flexDirection: 'column',
        // Opacity-only fade: a transform here would fight the window's position.
        animation: 'r98_winOpenFull 0.18s ease-out',
      }}
    >
      {/* Title bar — holo gradient (focused) with a white pixel title */}
      <div
        ref={titleBarRef}
        data-app-window-titlebar
        style={{
          height: 26,
          margin: '3px 3px 0 3px',
          background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${isFocused ? GRADIENT.titleBar : GRADIENT.titleBarIdle}`,
          boxShadow: `inset 0 -1px 0 0 ${HOLO.ink}`,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 3px 1px 5px',
          cursor: isMobile ? 'default' : 'move',
          userSelect: 'none',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <AppIcon app={app} size={18} letterSize="sm" />
        <span
          className="win-title-text"
          style={{
            fontFamily: FONT_CHROME,
            fontWeight: 400,
            fontSize: 20,
            letterSpacing: 0.4,
            color: isFocused ? '#FFFFFF' : '#F4F0FF',
            textShadow: isFocused ? SHADOW.titleText : '1px 1px 0 rgba(42,27,110,.45)',
            marginLeft: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {app.title}
        </span>
        {isFocused && (
          <span aria-hidden style={{ display: 'inline-flex', marginLeft: 2, flexShrink: 0 }}>
            <HoloSparkle size={9} glow={false} />
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="win-minimize holo-winbtn"
          onClick={(e) => {
            e.stopPropagation();
            wm.minimizeApp(app.id);
          }}
          aria-label={t('appWindow.minimize')}
          title={t('appWindow.minimize')}
        >
          <GlyphMin style={{ marginTop: 6 }} />
        </button>
        {!isMobile && (
          <button
            className="win-maximize holo-winbtn"
            onClick={(e) => { e.stopPropagation(); toggleMaximize(); }}
            style={{ marginLeft: 2 }}
            aria-label={maxed ? t('appWindow.restore') : t('appWindow.maximize')}
            title={maxed ? t('appWindow.restore') : t('appWindow.maximize')}
          >
            {maxed ? <GlyphRestore /> : <GlyphMax />}
          </button>
        )}
        <button
          className="win-close holo-winbtn holo-winbtn--close"
          onClick={(e) => {
            e.stopPropagation();
            wm.closeApp(app.id);
          }}
          style={{ marginLeft: 2 }}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <GlyphClose />
        </button>
      </div>

      {/* Menu bar — cream, indigo pixel sans */}
      <div
        data-app-window-menubar
        style={{
          height: 24,
          margin: '0 3px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 8px',
          background: GRADIENT.menuBar,
          boxShadow: `inset 0 -1px 0 0 ${HOLO.bevelLo}`,
          fontFamily: FONT_CHROME,
          fontWeight: 400,
          fontSize: 18,
          color: HOLO.ink,
          flexShrink: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {MENU.map(({ key, accel }) => {
          const m = t(key);
          const lead = m.charAt(0).toUpperCase() === accel;
          return (
            <span key={key} style={{ cursor: 'default' }}>
              {lead ? (
                <>
                  <span style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>{m.charAt(0)}</span>
                  {m.slice(1)}
                </>
              ) : (
                <>
                  {m}(<span style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>{accel}</span>)
                </>
              )}
            </span>
          );
        })}
      </div>

      {/* Content area (sunken). Default ground is a deep-indigo screen so a
          window that paints nothing stays readable; Spare apps paint the
          pastel HoloWindowBody over it. */}
      <div
        style={{
          flex: 1,
          margin: 3,
          marginTop: 3,
          background: HOLO.screen,
          ...INK_ON_SCREEN,
          color: HOLO.onScreen,
          boxShadow: `0 0 0 1px ${HOLO.bevelLo}`,
          overflow: 'auto',
          minHeight: 0,
        }}
      >
        {children}
      </div>

      {/* Status bar */}
      <div
        style={{
          height: 22,
          margin: '0 3px 3px',
          background: GRADIENT.menuBar,
          display: 'flex',
          alignItems: 'center',
          padding: 2,
          gap: 3,
          flexShrink: 0,
        }}
      >
        <div style={statusPanel}>{app.title}</div>
        <div style={{ flex: 1 }} />
        <div style={{ ...statusPanel, minWidth: 80, paddingRight: isMobile || maxed ? 8 : 18 }}>
          <span aria-hidden style={{ width: 7, height: 7, background: HOLO.goodFill, boxShadow: `0 0 0 1px ${HOLO.ink}`, flexShrink: 0 }} />
          {t('appWindow.online')}
        </div>
      </div>

      {/* Resize grip — bottom-right corner (desktop only, hidden when maxed) */}
      {!isMobile && !maxed && (
        <div
          data-app-window-resize
          onMouseDown={(e) => {
            e.stopPropagation();
            wm.focusApp(app.id);
            resize.current = {
              active: true,
              sx: e.clientX,
              sy: e.clientY,
              sw: state.size.width,
              sh: state.size.height,
            };
          }}
          title={t('appWindow.resize')}
          style={{
            position: 'absolute',
            right: 3,
            bottom: 3,
            width: 16,
            height: 16,
            cursor: 'nwse-resize',
            // Win98 diagonal grip lines, lilac + white
            backgroundImage:
              'linear-gradient(135deg, transparent 0 40%, #A897EC 40% 48%, #FFFFFF 48% 54%, transparent 54% 64%, #A897EC 64% 72%, #FFFFFF 72% 78%, transparent 78% 86%, #A897EC 86% 94%, transparent 94%)',
            zIndex: 2,
          }}
        />
      )}
    </div>
  );
}

const statusPanel: React.CSSProperties = {
  minWidth: 150,
  height: '100%',
  boxShadow: BEVEL_SUNKEN,
  background: 'rgba(255,255,255,.5)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 8px',
  fontFamily: FONT_CHROME,
  fontWeight: 400,
  fontSize: 17,
  color: HOLO.ink,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export default AppWindow;
