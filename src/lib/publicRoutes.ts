/**
 * The public Spare pages that live outside the desktop app, plus Spare's X and
 * Telegram. One list, used by:
 *   · LoginScreen — the link row below the login card
 *   · StartMenu   — the "Web" section, so the pages are one click away from
 *                   inside the desktop too
 *
 * Internal hrefs are SPA routes (leading slash); `external` entries are full
 * URLs. Both surfaces open every link in a new tab so it never interrupts the
 * desktop or the login flow.
 *
 * `label` and `tagline` are i18n keys in the `shell` namespace (this list is
 * built at module scope, before i18n starts): translate them where they
 * render, with t(route.label).
 */
import { tKey } from '@/i18n';

/** Pixel pictogram for the Start menu row (see holo/HoloGlyphs PixelGlyph). */
export type PublicRouteGlyph = 'doc' | 'flag' | 'mail' | 'prompt' | 'spark' | 'window' | 'grid' | 'globe';

export interface PublicRoute {
  /** i18n key (shell) of the link text. */
  label: string;
  href: string;
  /** i18n key (shell) of the short tagline shown in tooltips and the Start menu hover title. */
  tagline?: string;
  /** Start menu pictogram. */
  glyph?: PublicRouteGlyph;
  /**
   * The Spare essentials — shown directly in the Start menu's Web section.
   * Everything else sits behind its "More pages" disclosure.
   */
  core?: boolean;
  /** A full URL off trysparerh.com (X, Telegram) rather than an SPA route. */
  external?: boolean;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  { label: tKey('publicRoutes.docs.label'),       href: '/docs',       tagline: tKey('publicRoutes.docs.tagline'), glyph: 'doc', core: true },
  { label: tKey('publicRoutes.universe.label'),   href: '/universe',   tagline: tKey('publicRoutes.universe.tagline'), glyph: 'grid', core: true },
  { label: tKey('publicRoutes.dispatch.label'),   href: '/dispatch',   tagline: tKey('publicRoutes.dispatch.tagline'), glyph: 'spark', core: true },
  { label: tKey('publicRoutes.datalayer.label'),  href: '/datalayer',  tagline: tKey('publicRoutes.datalayer.tagline'), glyph: 'grid' },
  { label: tKey('publicRoutes.devtools.label'),   href: '/devtools',   tagline: tKey('publicRoutes.devtools.tagline'), glyph: 'prompt' },
  { label: tKey('publicRoutes.mcp.label'),        href: '/mcp',        tagline: tKey('publicRoutes.mcp.tagline'), glyph: 'prompt' },
  { label: tKey('publicRoutes.flywheel.label'),   href: '/flywheel',   tagline: tKey('publicRoutes.flywheel.tagline'), glyph: 'spark' },
  { label: tKey('publicRoutes.buyback.label'),    href: '/buyback',    tagline: tKey('publicRoutes.buyback.tagline'), glyph: 'window' },
  { label: tKey('publicRoutes.roadmap.label'),    href: '/roadmap',    tagline: tKey('publicRoutes.roadmap.tagline'), glyph: 'flag', core: true },
  { label: tKey('publicRoutes.whitepaper.label'), href: '/whitepaper', tagline: tKey('publicRoutes.whitepaper.tagline'), glyph: 'doc' },
  { label: tKey('publicRoutes.x.label'),          href: 'https://x.com/TrySpareRH', tagline: tKey('publicRoutes.x.tagline'), glyph: 'globe', external: true },
  { label: tKey('publicRoutes.telegram.label'),   href: 'https://t.me/sparerh',     tagline: tKey('publicRoutes.telegram.tagline'), glyph: 'mail', external: true },
];
