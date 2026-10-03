/**
 * The public-page tab strip — ONE list for every public frame (PUBLIC_TABS),
 * used by:
 *   · PublicShell     (/docs, /roadmap, /whitepaper, /devtools, /terms, /privacy, 404)
 *   · LivePageFrame   (/datalayer, /dispatch, /mcp)
 *   · HoloPageWindow  (/universe, /buyback, /flywheel)
 *
 * so moving between any two public pages always shows the same tabs.
 *
 * Pages that are not one of the eight spec tabs but are part of the same
 * public set (Buyback, Flywheel) get themselves appended as a ninth tab while
 * you're on them, so the current page is always highlighted. Anything else
 * (Terms, Privacy, 404) simply highlights nothing.
 *
 * `label` stays the English name (tests and keys use it); render
 * publicTabLabel(tab), which gives it in the live language (shell `publicTabs.*`).
 */
import { useEffect, useRef } from 'react';
import { t, tKey } from '@/i18n';

export interface PublicTab {
  label: string;
  to: string;
}

/** Spec §0.7 — the eight public tabs, in order. */
export const PUBLIC_TABS: readonly PublicTab[] = [
  { label: 'Docs', to: '/docs' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'Universe', to: '/universe' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'Dispatch', to: '/dispatch' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'Data Layer', to: '/datalayer' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'DevTools', to: '/devtools' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'MCP', to: '/mcp' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'Roadmap', to: '/roadmap' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'Whitepaper', to: '/whitepaper' }, // i18n-ignore: English name; shown via publicTabLabel()
];

/** Public pages outside the spec list that show as a ninth tab while open. */
const EXTRA_TABS: readonly PublicTab[] = [
  { label: 'Buyback', to: '/buyback' }, // i18n-ignore: English name; shown via publicTabLabel()
  { label: 'Flywheel', to: '/flywheel' }, // i18n-ignore: English name; shown via publicTabLabel()
];

/** i18n key (shell) of each tab's label, by route. */
const TAB_LABEL_KEYS: Readonly<Record<string, string>> = {
  '/docs': tKey('publicTabs.docs'),
  '/universe': tKey('publicTabs.universe'),
  '/dispatch': tKey('publicTabs.dispatch'),
  '/datalayer': tKey('publicTabs.datalayer'),
  '/devtools': tKey('publicTabs.devtools'),
  '/mcp': tKey('publicTabs.mcp'),
  '/roadmap': tKey('publicTabs.roadmap'),
  '/whitepaper': tKey('publicTabs.whitepaper'),
  '/buyback': tKey('publicTabs.buyback'),
  '/flywheel': tKey('publicTabs.flywheel'),
};

/** The tab's label in the live language. Call it at render. */
export function publicTabLabel(tab: PublicTab): string {
  const key = TAB_LABEL_KEYS[tab.to];
  return key ? t(key) : tab.label;
}

/** `/docs/` → `/docs`; `/` stays `/`. */
export function normalizePublicPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, '');
  return p === '' ? '/' : p.toLowerCase();
}

/**
 * The tabs to render on `pathname`: the eight spec tabs, plus the current
 * page as a ninth tab when it is Buyback or Flywheel.
 */
export function publicTabsFor(pathname: string): PublicTab[] {
  const here = normalizePublicPath(pathname);
  const extra = EXTRA_TABS.find((t) => t.to === here);
  return extra ? [...PUBLIC_TABS, extra] : [...PUBLIC_TABS];
}

/** True when `tab` is the page at `pathname`. */
export function isCurrentTab(tab: PublicTab, pathname: string): boolean {
  return normalizePublicPath(pathname) === tab.to;
}

/**
 * Phones: the tab strip scrolls sideways (nine tabs never fit at 375px) —
 * bring the current page's tab into view. Returns the ref for the <nav>.
 */
export function useCurrentTabInView<T extends HTMLElement = HTMLElement>(pathname: string) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const strip = ref.current;
    const on = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !on || strip.scrollWidth <= strip.clientWidth) return;
    const sr = strip.getBoundingClientRect();
    const or = on.getBoundingClientRect();
    if (or.left < sr.left || or.right > sr.right) strip.scrollLeft += or.left - sr.left - 8;
  }, [pathname]);
  return ref;
}
