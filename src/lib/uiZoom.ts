/**
 * Global UI zoom — the "Ctrl +/-" of the Spare desktop.
 *
 * Scales the entire retro desktop via CSS `zoom` on the .retro98 root so
 * everything (windows, data, chrome) gets bigger/smaller uniformly — the
 * fix for cramped data on large monitors. Persisted to localStorage.
 *
 * Keyboard: Ctrl/Cmd + '='/'+' zoom in · Ctrl/Cmd + '-' zoom out ·
 *           Ctrl/Cmd + '0' reset. A visible +/- control lives in the tray.
 */
const KEY = 'spare_ui_zoom';

function readSaved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage blocked (private mode) — default zoom
  }
}
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.8;
export const ZOOM_STEP = 0.1;

function clamp(z: number): number {
  const r = Math.round(z * 10) / 10;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r));
}

export function getZoom(): number {
  if (typeof window === 'undefined') return 1;
  const raw = parseFloat(readSaved() ?? '1');
  return Number.isFinite(raw) ? clamp(raw) : 1;
}

function rootEl(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>('.retro98');
}

export function applyZoom(z: number): void {
  const el = rootEl();
  if (el) {
    // `zoom` reflows layout (unlike transform:scale) and scales fixed
    // children's coordinate space — exactly the "make it all bigger" behavior.
    (el.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(z);
  }
}

export function setZoom(z: number): number {
  const c = clamp(z);
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(KEY, String(c)); } catch { /* storage blocked — zoom still applies this session */ }
  }
  applyZoom(c);
  window.dispatchEvent(new CustomEvent('ui-zoom', { detail: c }));
  return c;
}

export function nudgeZoom(delta: number): number {
  return setZoom(getZoom() + delta);
}

export function resetZoom(): number {
  return setZoom(1);
}

/**
 * Installs the Ctrl/Cmd +/-/0 keyboard shortcuts and applies the saved zoom.
 * Returns a cleanup fn. Call once from the desktop shell.
 */
export function initUiZoom(): () => void {
  applyZoom(getZoom());
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); nudgeZoom(ZOOM_STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); nudgeZoom(-ZOOM_STEP); }
    else if (e.key === '0') { e.preventDefault(); resetZoom(); }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
