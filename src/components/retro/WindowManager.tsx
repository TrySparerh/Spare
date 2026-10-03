/**
 * WindowManager — tracks which "apps" are open on the desktop, their position,
 * minimized state, and z-index focus order. The Desktop renders open windows
 * from this state, and the Taskbar reads it to show running apps.
 *
 * Apps register themselves via the AppRegistry at module load time. The manager
 * exposes openApp(id), focusApp(id), closeApp(id), minimizeApp(id),
 * toggleMinimize(id).
 *
 * Every window is kept on screen: it is fitted to the viewport when it opens and
 * re-fitted whenever the browser or the desktop zoom changes, so nothing ends up
 * under the ticker, under the taskbar or off the bottom-right edge.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getZoom } from '@/lib/uiZoom';
import type { PixelGlyphKind } from './holo/HoloGlyphs';

export interface AppDescriptor {
  id: string;
  title: string;
  iconLetter: string;
  iconTone?: 'cyan' | 'amber' | 'green' | 'red' | 'magenta' | 'mono' | 'blue';
  /** Optional pixel-art image. When set, replaces the LetterIcon everywhere
      (desktop icon, taskbar, window title bar, start menu). Path is relative
      to /public, e.g. "/icons/spare/fund-wallet.png". */
  iconImage?: string;
  /** iconImage is a single-colour white glyph (e.g. the X mark). AppIcon inks it
      indigo on light surfaces and gives it an indigo outline over the world. */
  iconMono?: boolean;
  /** No pixel art? A chrome pictogram tile instead of a letter tile (see HoloGlyphTile). */
  iconGlyph?: PixelGlyphKind;
  defaultSize?: { width: number; height: number };
  defaultPosition?: { left: number; top: number };
  /** Where to anchor the first-open position (desktop only — mobile takes
   *  full-screen). 'center' (default) centers in the viewport. 'bottom'
   *  pushes the window down toward the taskbar so the desktop wallpaper
   *  stays visible above it. */
  defaultAnchor?: 'center' | 'bottom';
  component: () => JSX.Element;
  /** Show in the desktop icon grid. Default true. */
  showOnDesktop?: boolean;
  /** Show in the start menu. Default true. */
  showInStartMenu?: boolean;
  /** Category for start menu grouping. */
  category?: 'Programs' | 'System' | 'Easter Eggs' | 'Markets' | 'Resources' | 'External' | 'Games' | 'Agents';
  /** If set, launch opens this URL in a new tab instead of opening a window. */
  externalUrl?: string;
}

export interface WindowState {
  id: string;
  isOpen: boolean;
  isMinimized: boolean;
  zIndex: number;
  position: { left: number; top: number };
  size: { width: number; height: number };
}

interface WindowManagerCtx {
  apps: AppDescriptor[];
  windows: Record<string, WindowState>;
  openApp: (id: string) => void;
  closeApp: (id: string) => void;
  focusApp: (id: string) => void;
  minimizeApp: (id: string) => void;
  toggleMinimize: (id: string) => void;
  setPosition: (id: string, pos: { left: number; top: number }) => void;
  setSize: (id: string, size: { width: number; height: number }) => void;
  focusedId: string | null;
}

const Ctx = createContext<WindowManagerCtx | null>(null);

// Desktop furniture every window has to clear.
const TICKER = 34; // live ticker band at the top
const TASKBAR = 44; // taskbar at the bottom
const EDGE = 8; // breathing room at the viewport edges
const MIN_W = 360; // same floor AppWindow's resize grip uses
const MIN_H = 240;
// Window z-order lives in (Z_BASE, Z_CEIL]: above the desktop icons (5) and the
// taskbar mascot (15), always below the ticker (99), taskbar (100) and Start
// menu (200). When focus churn reaches the ceiling the open windows
// are renumbered from the base, keeping their order.
const Z_BASE = 20;
const Z_CEIL = 90;

/** The desktop's usable area, in CSS px of the (possibly zoomed) .retro98 root. */
function viewport(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: 1440, vh: 900 };
  const z = getZoom() || 1;
  return { vw: window.innerWidth / z, vh: window.innerHeight / z };
}

/**
 * Keeps a window fully on screen: never under the ticker or the taskbar, never
 * off the right or bottom edge. It shrinks only when it can't fit at all (its
 * content area scrolls). Mobile ignores this: windows are full-screen via CSS.
 * Returns the same object when nothing moved, so callers can skip re-renders.
 */
function fitToViewport(w: WindowState): WindowState {
  // Phones: AppWindow pins every window full-screen, so keep the desktop geometry intact.
  if (typeof window === 'undefined' || window.innerWidth < 768) return w;
  const { vw, vh } = viewport();
  const availW = Math.max(MIN_W, vw - EDGE * 2);
  const availH = Math.max(MIN_H, vh - TICKER - TASKBAR - EDGE);
  const width = Math.min(w.size.width, availW);
  const height = Math.min(w.size.height, availH);
  const left = Math.max(EDGE, Math.min(w.position.left, vw - width - EDGE));
  const top = Math.max(TICKER, Math.min(w.position.top, vh - TASKBAR - height - EDGE));
  if (left === w.position.left && top === w.position.top && width === w.size.width && height === w.size.height) {
    return w;
  }
  return { ...w, position: { left, top }, size: { width, height } };
}

function defaultPosition(
  idx: number,
  size?: { width: number; height: number },
  anchor: 'center' | 'bottom' = 'center',
): { left: number; top: number } {
  const w = size?.width ?? 720;
  const h = size?.height ?? 480;
  const { vw, vh } = viewport();
  const baseLeft = Math.max(20, vw / 2 - w / 2);
  // Bottom anchor: sit the window just above the taskbar with a small margin
  // so the wallpaper, icons, and ticker stay visible above.
  const BOTTOM_MARGIN = 24;
  const baseTop = anchor === 'bottom'
    ? Math.max(80, vh - h - TASKBAR - BOTTOM_MARGIN)
    : Math.max(TICKER, vh / 2 - h / 2 - 30);
  // A short 6-step staircase. Cascading by raw app index sent late registry
  // entries (About is ~20th) 500+ px down-right, into the bottom-right clamp.
  const step = (idx % 6) * 28;
  return { left: baseLeft + step, top: baseTop + step };
}

export function WindowManagerProvider({
  apps,
  initiallyOpen = [],
  children,
}: {
  apps: AppDescriptor[];
  initiallyOpen?: string[];
  children: ReactNode;
}) {
  const zCounter = useRef(Z_BASE);

  const [windows, setWindows] = useState<Record<string, WindowState>>(() => {
    const initial: Record<string, WindowState> = {};
    apps.forEach((app, idx) => {
      const open = initiallyOpen.includes(app.id);
      const w: WindowState = {
        id: app.id,
        isOpen: open,
        isMinimized: false,
        zIndex: open ? ++zCounter.current : 0,
        position: app.defaultPosition ?? defaultPosition(idx, app.defaultSize, app.defaultAnchor),
        size: app.defaultSize ?? { width: 720, height: 480 },
      };
      initial[app.id] = open ? fitToViewport(w) : w;
    });
    return initial;
  });

  /**
   * Returns `prev` with `id` on top of the stack and `patch` merged in. When the
   * counter has reached Z_CEIL the open windows are renumbered from Z_BASE
   * first (same order), so no amount of focusing ever lifts a window over the
   * ticker, taskbar or Start menu.
   */
  const raise = useCallback(
    (prev: Record<string, WindowState>, id: string, patch: Partial<WindowState>): Record<string, WindowState> => {
      let next = prev;
      if (zCounter.current >= Z_CEIL) {
        next = { ...prev };
        zCounter.current = Z_BASE;
        Object.values(prev)
          .filter((w) => w.id !== id)
          .sort((a, b) => a.zIndex - b.zIndex)
          .forEach((w) => {
            next[w.id] = { ...w, zIndex: w.isOpen ? ++zCounter.current : 0 };
          });
      }
      return { ...next, [id]: { ...next[id], ...patch, zIndex: ++zCounter.current } };
    },
    [],
  );

  // Re-fit every open window when the viewport or the desktop zoom changes,
  // so no window is left off-screen after the browser shrinks.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refit = () =>
      setWindows((prev) => {
        let changed = false;
        const next: Record<string, WindowState> = {};
        for (const [id, w] of Object.entries(prev)) {
          const f = w.isOpen ? fitToViewport(w) : w;
          if (f !== w) changed = true;
          next[id] = f;
        }
        return changed ? next : prev;
      });
    window.addEventListener('resize', refit);
    window.addEventListener('ui-zoom', refit);
    return () => {
      window.removeEventListener('resize', refit);
      window.removeEventListener('ui-zoom', refit);
    };
  }, []);

  const openApp = useCallback(
    (id: string) => {
      const desc = apps.find((a) => a.id === id);
      if (desc?.externalUrl) {
        window.open(desc.externalUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      setWindows((prev) => {
        if (!prev[id]) return prev;
        const next = raise(prev, id, { isOpen: true, isMinimized: false });
        // Opening fits the window to the viewport it is opening into.
        return { ...next, [id]: fitToViewport(next[id]) };
      });
    },
    [apps, raise],
  );

  const closeApp = useCallback((id: string) => {
    setWindows((prev) => {
      if (!prev[id]) return prev;
      return { ...prev, [id]: { ...prev[id], isOpen: false, isMinimized: false } };
    });
  }, []);

  const focusApp = useCallback(
    (id: string) => {
      setWindows((prev) => {
        if (!prev[id]) return prev;
        // If already top of stack, no-op
        const max = Math.max(...Object.values(prev).map((w) => w.zIndex));
        if (prev[id].zIndex === max && !prev[id].isMinimized) return prev;
        return raise(prev, id, { isMinimized: false });
      });
    },
    [raise],
  );

  const minimizeApp = useCallback((id: string) => {
    setWindows((prev) => {
      if (!prev[id]) return prev;
      return { ...prev, [id]: { ...prev[id], isMinimized: true } };
    });
  }, []);

  const toggleMinimize = useCallback(
    (id: string) => {
      setWindows((prev) => {
        if (!prev[id]) return prev;
        const w = prev[id];
        // If minimized, restore + focus. If visible+focused, minimize. Else focus.
        if (w.isMinimized) {
          return raise(prev, id, { isMinimized: false });
        }
        const max = Math.max(...Object.values(prev).map((win) => win.zIndex));
        if (w.zIndex === max) {
          return { ...prev, [id]: { ...w, isMinimized: true } };
        }
        return raise(prev, id, {});
      });
    },
    [raise],
  );

  const setPosition = useCallback((id: string, pos: { left: number; top: number }) => {
    setWindows((prev) => {
      if (!prev[id]) return prev;
      return { ...prev, [id]: { ...prev[id], position: pos } };
    });
  }, []);

  const setSize = useCallback((id: string, size: { width: number; height: number }) => {
    setWindows((prev) => {
      if (!prev[id]) return prev;
      return { ...prev, [id]: { ...prev[id], size } };
    });
  }, []);

  const focusedId = useMemo(() => {
    const visible = Object.values(windows).filter((w) => w.isOpen && !w.isMinimized);
    if (visible.length === 0) return null;
    return visible.reduce((a, b) => (a.zIndex >= b.zIndex ? a : b)).id;
  }, [windows]);

  const value: WindowManagerCtx = {
    apps,
    windows,
    openApp,
    closeApp,
    focusApp,
    minimizeApp,
    toggleMinimize,
    setPosition,
    setSize,
    focusedId,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWindowManager(): WindowManagerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWindowManager must be used within WindowManagerProvider');
  return ctx;
}
