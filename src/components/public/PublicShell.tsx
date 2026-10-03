/**
 * PublicShell — the Spare Holo frame every public page renders in
 * (/docs, /whitepaper, /roadmap, /devtools, 404 and the other public pages).
 *
 * The page is one maximised Spare window on the pastel sky, drawn like the
 * desktop apps:
 *
 *   [holo title bar   ✦ {title} — Spare                          [×]]
 *   [toolbar          ← → ↻ ⌂ │ https://trysparerh.com/… │ ROBINHOOD CHAIN · 4663]
 *   [page tabs        Docs · Universe · Dispatch · Data Layer · …]
 *   [body             "On this page" nav │ hero + page + footer]
 *   [status bar       Done · Spare                    ● Robinhood Chain]
 *
 * The whole document scrolls (no nested scrollers), so anchors, find-in-page
 * and iOS all behave. The section nav is sticky: a mini-dialog column on
 * desktop, a chip strip pinned under the tabs on phones (≤767px).
 *
 * Building blocks for page bodies are exported from here too: GlassCard,
 * StatTile, SectionHeader, H3, P, and (at the bottom of the file) DocSection,
 * CodeBlock, DataTable, Bullets, Steps, LinkButton, Addr, Code, PublicFooter
 * and useSectionSpy.
 */
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LanguageToggle } from '@/components/LanguageToggle';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  GRADIENT,
  HOLO,
  HoloBadge,
  HoloCard,
  HoloDivider,
  HoloHero,
  HoloSparkle,
  HoloSparkles,
  HoloStat,
  HoloTitle,
  GlyphClose,
  INK,
  TEXTURE,
  sparkleUrl,
  type HoloTone,
} from '@/components/retro/holo';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { SPARE, SPARE_CHAIN_ID, addressUrl, shortAddr } from '@/lib/spare-chain/addresses';
import { SITE_URL, TELEGRAM_URL, X_URL } from '@/lib/config';
import { isCurrentTab, publicTabLabel, publicTabsFor, useCurrentTabInView } from '@/components/public/publicTabs';
import { tKey, useTranslation } from '@/i18n';


export interface PublicSidebarSection {
  label: string;
  items: { id: string; label: string }[];
}

export interface PublicShellProps {
  /** Small version chip in the hero (e.g. "S1"). */
  version?: string;
  /** Pixel-caps line above the hero title (e.g. "Docs · Spare S1"). */
  kicker?: string;
  title: string;
  subtitle: ReactNode;
  /** Section nav. Omit (or pass []) for a single-column page. */
  sidebar?: PublicSidebarSection[];
  activeId?: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
  /** Browser-tab title. Default `${title} — Spare`. */
  pageTitle?: string;
  /** Sets <meta name="description"> while the page is mounted. */
  metaDescription?: string;
  /** Hero art: an image src, a node, or null. Default: the holographic Spare mark. */
  art?: string | ReactNode | null;
  /** Extra hero aside content (badges, a stat), after the version chip. */
  heroAside?: ReactNode;
  /** Rendered under the hero copy (CTA buttons, chips). */
  heroExtra?: ReactNode;
  heroSize?: 'md' | 'lg' | 'xl';
  /** Sparkle scatter seed, so each page gets its own sky. */
  heroSeed?: number;
  /** Heading of the section nav. Default "On this page" (shell `publicFrame.onThisPage`). */
  navLabel?: string;
}

/* Top tabs come from publicTabs.ts, shared with LivePageFrame
   and HoloPageWindow so every public frame shows the same strip. */

/* ─────────────────────────────── head / meta ─────────────────────────────── */

/** Sets document.title and the meta description while mounted; restores them after. */
export function usePageMeta(title: string, description?: string) {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    let created = false;
    const prevDesc = meta?.getAttribute('content') ?? null;
    if (description) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'description');
        document.head.appendChild(meta);
        created = true;
      }
      meta.setAttribute('content', description);
    }
    return () => {
      document.title = prevTitle;
      if (!description || !meta) return;
      if (created) meta.remove();
      else if (prevDesc !== null) meta.setAttribute('content', prevDesc);
    };
  }, [title, description]);
}

/* ────────────────────────────── section spy ─────────────────────────────── */

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Scroll-spy for a long page whose sections carry these ids.
 * Returns [activeId, select]: select(id) scrolls the section into view and
 * writes #id to the address bar; activeId follows the reader while scrolling.
 * A #hash on load jumps to that section.
 */
export function useSectionSpy(ids: readonly string[]): [string, (id: string) => void] {
  const key = ids.join('|');
  const [active, setActive] = useState<string>(() => {
    const h = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.slice(1)) : '';
    return h && ids.includes(h) ? h : ids[0] ?? '';
  });
  const lockUntil = useRef(0);

  useEffect(() => {
    const list = key ? key.split('|') : [];
    const els = list.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;
    const visible = new Set<string>();
    const pick = () => {
      if (Date.now() < lockUntil.current) return;
      const doc = document.documentElement;
      // The last sections are often too short to reach the reading band.
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
        setActive(list[list.length - 1]);
        return;
      }
      const first = list.find((id) => visible.has(id));
      if (first) setActive(first);
    };
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) visible.add(e.target.id);
            else visible.delete(e.target.id);
          }
          pick();
        },
        { rootMargin: '-12% 0px -62% 0px', threshold: 0 },
      );
      els.forEach((el) => io!.observe(el));
    }
    window.addEventListener('scroll', pick, { passive: true });
    return () => {
      io?.disconnect();
      window.removeEventListener('scroll', pick);
    };
  }, [key]);

  // Deep link: /docs#sweep
  useEffect(() => {
    const h = decodeURIComponent(window.location.hash.slice(1));
    if (!h || !key.split('|').includes(h)) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(h)?.scrollIntoView({ block: 'start' });
      setActive(h);
    });
    return () => cancelAnimationFrame(raf);
  }, [key]);

  const select = useCallback((id: string) => {
    setActive(id);
    lockUntil.current = Date.now() + 900;
    document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    try {
      window.history.replaceState(window.history.state, '', `#${id}`);
    } catch {
      /* sandboxed history — the scroll still happened */
    }
  }, []);

  return [active, select];
}

/* ─────────────────────────────── main shell ─────────────────────────────── */

export function PublicShell({
  kicker,
  title,
  subtitle,
  version,
  sidebar,
  activeId,
  onSelect,
  children,
  pageTitle,
  metaDescription,
  art,
  heroAside,
  heroExtra,
  heroSize = 'lg',
  heroSeed = 11,
  navLabel: navLabelProp,
}: PublicShellProps) {
  const { t } = useTranslation('shell');
  const navLabel = navLabelProp ?? t('publicFrame.onThisPage');
  const navigate = useNavigate();
  const location = useLocation();
  const url = `${SITE_URL}${location.pathname}`;
  const groups = (sidebar ?? []).filter((g) => g.items.length > 0);
  const hasNav = groups.length > 0;

  usePageMeta(pageTitle ?? `${title} — Spare`, metaDescription);

  // New page (not a #section jump) starts at the top.
  useEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
  }, [location.pathname]);

  // Pastel overscroll instead of the app's dark body.
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = HOLO.cream;
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  // Phones: the tab strip scrolls sideways — bring the current page's tab into view.
  const tabsRef = useCurrentTabInView<HTMLElement>(location.pathname);

  // Keep the active nav item visible inside its own scroller (never moves the page).
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) return;
    const el = list.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(activeId)}"]`);
    if (!el) return;
    const lr = list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (list.scrollWidth > list.clientWidth + 1) {
      if (er.left < lr.left + 8 || er.right > lr.right - 8) list.scrollLeft += er.left - lr.left - 12;
    } else if (list.scrollHeight > list.clientHeight + 1) {
      if (er.top < lr.top + 4 || er.bottom > lr.bottom - 4) list.scrollTop += er.top - lr.top - lr.height / 3;
    }
  }, [activeId]);

  const aside =
    version || heroAside ? (
      <>
        {version && <HoloBadge label={version} variant="solid" size="md" />}
        {heroAside}
      </>
    ) : undefined;

  return (
    <div className="ps-root">
      <style>{SHELL_CSS}</style>
      <div className="ps-backdrop" aria-hidden>
        <HoloSparkles count={14} seed={heroSeed + 3} sizes={[6, 18]} />
        <div className="ps-backdrop__horizon" />
      </div>

      <div className="ps-window">
        {/* Title bar */}
        <div className="ps-titlebar">
          <img src="/icons/spare-logo.png" alt="" width={20} height={20} className="ps-titlebar__icon" draggable={false} />
          <span className="ps-titlebar__text">{pageTitle ?? `${title} — Spare`}</span>
          <HoloSparkle size={9} glow={false} />
          <span style={{ flex: 1 }} />
          <LanguageToggle variant="bar" />
          <Link to="/" className="ps-winbtn" aria-label={t('publicFrame.closeAria')} title={t('publicFrame.backTitle')}>
            <GlyphClose />
          </Link>
        </div>

        {/* Toolbar: history keys, address well, network badge */}
        <div className="ps-toolbar">
          <button type="button" className="ps-key" onClick={() => navigate(-1)} aria-label={t('publicFrame.back')} title={t('publicFrame.back')}>
            <ArrowGlyph dir="left" />
          </button>
          <button type="button" className="ps-key ps-key--wide" onClick={() => navigate(1)} aria-label={t('publicFrame.forward')} title={t('publicFrame.forward')}>
            <ArrowGlyph dir="right" />
          </button>
          <button type="button" className="ps-key ps-key--wide" onClick={() => window.location.reload()} aria-label={t('publicFrame.reload')} title={t('publicFrame.reload')}>
            <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>↻</span>
          </button>
          <Link to="/" className="ps-key" aria-label={t('publicFrame.home')} title={t('publicFrame.home')}>
            <img src="/icons/spare-logo.png" alt="" width={16} height={16} draggable={false} />
          </Link>
          <div className="ps-address" title={url}>
            <span className="ps-address__label">{t('publicFrame.address')}</span>
            <span className="ps-address__url" translate="no">
              {url}
            </span>
          </div>
          <span className="ps-netbadge">
            {/* i18n-ignore: chain name stays English */}
            <HoloBadge label="ROBINHOOD CHAIN · 4663" tone="info" />
          </span>
        </div>

        {/* Page tabs */}
        <nav className="ps-tabs" aria-label={t('publicFrame.pagesAria')} ref={tabsRef}>
          {publicTabsFor(location.pathname).map((tab) => {
            const on = isCurrentTab(tab, location.pathname);
            return (
              <Link key={tab.to} to={tab.to} className="ps-tab" aria-current={on ? 'page' : undefined}>
                {publicTabLabel(tab)}
              </Link>
            );
          })}
        </nav>

        {/* Body */}
        <div className={`ps-body${hasNav ? '' : ' ps-body--solo'}`}>
          {hasNav && (
            <nav className="ps-nav" aria-label={navLabel}>
              <div className="ps-nav__bar">
                <HoloSparkle size={10} glow={false} />
                <span>{navLabel}</span>
              </div>
              <div className="ps-nav__list" ref={listRef}>
                {groups.map((g) => (
                  <div className="ps-nav__group" key={g.label} role="group" aria-label={g.label}>
                    <div className="ps-nav__label">{g.label}</div>
                    {g.items.map((item) => {
                      const on = activeId === item.id;
                      return (
                        <a
                          key={item.id}
                          href={`#${item.id}`}
                          data-nav-id={item.id}
                          className="ps-nav__item"
                          aria-current={on ? 'true' : undefined}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                            e.preventDefault();
                            onSelect?.(item.id);
                          }}
                        >
                          {item.label}
                        </a>
                      );
                    })}
                  </div>
                ))}
              </div>
            </nav>
          )}

          <main className="ps-main">
            <HoloHero
              art={art}
              kicker={kicker}
              title={title}
              description={subtitle}
              aside={aside}
              size={heroSize}
              seed={heroSeed}
            >
              {heroExtra && <div className="ps-hero-extra">{heroExtra}</div>}
            </HoloHero>
            {children}
            <PublicFooter />
          </main>
        </div>

        {/* Status bar */}
        <div className="ps-status">
          <span className="ps-status__panel ps-status__panel--grow">{t('publicFrame.done')}</span>
          <span className="ps-status__panel">
            <span aria-hidden className="ps-status__pip" />
            Robinhood Chain
          </span>
        </div>
      </div>
    </div>
  );
}

function ArrowGlyph({ dir }: { dir: 'left' | 'right' }) {
  // 7x7 pixel arrow
  const rows = ['0001000', '0011000', '0111111', '1111111', '0111111', '0011000', '0001000'];
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < 7; x++) if (row[x] === '1') d += `M${x} ${y}h1v1h-1z`;
  });
  return (
    <svg aria-hidden width={12} height={12} viewBox="0 0 7 7" shapeRendering="crispEdges" style={{ transform: dir === 'right' ? 'scaleX(-1)' : undefined }}>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/* ─────────────────────────────── shared footer ─────────────────────────────── */

/** Footer links: label keys in shell. Shared with LivePageFrame's footer. */
export const PUBLIC_FOOTER_LINKS: readonly { label: string; to: string; external?: boolean }[] = [
  { label: tKey('publicRoutes.docs.label'), to: '/docs' },
  { label: tKey('publicRoutes.universe.label'), to: '/universe' },
  { label: tKey('publicRoutes.roadmap.label'), to: '/roadmap' },
  { label: tKey('proof:meta.title'), to: '/proof' },
  { label: tKey('publicFrame.footer.terms'), to: '/terms' },
  { label: tKey('publicFrame.footer.privacy'), to: '/privacy' },
  { label: tKey('publicRoutes.x.label'), to: X_URL, external: true },
  { label: tKey('publicRoutes.telegram.label'), to: TELEGRAM_URL, external: true },
];

/** Spec §0.6 — the footer every public page carries. Standalone pages can render it too. */
export function PublicFooter({ style }: { style?: CSSProperties }) {
  const { t } = useTranslation('shell');
  return (
    <footer className="ps-footer" style={style}>
      <style>{FOOTER_CSS}</style>
      <HoloDivider variant="checker" />
      <div className="ps-footer__brand">
        <img src="/icons/spare-logo.png" alt="" width={22} height={22} draggable={false} />
        <span>{t('publicFrame.footer.brand')}</span>
      </div>
      <nav className="ps-footer__links" aria-label={t('publicFrame.footer.linksAria')}>
        {PUBLIC_FOOTER_LINKS.map((l) =>
          l.external ? (
            <a key={l.to} href={l.to} target="_blank" rel="noopener noreferrer">
              {t(l.label)}
            </a>
          ) : (
            <Link key={l.to} to={l.to}>
              {t(l.label)}
            </Link>
          ),
        )}
      </nav>
      <p className="ps-footer__legal">{t('publicFrame.footer.legal')}</p>
    </footer>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Block helpers. The first six keep their original names and signatures.
 * ────────────────────────────────────────────────────────────────────────── */

interface GlassCardProps {
  children: ReactNode;
  hover?: boolean;
  onClick?: () => void;
  padding?: number | string;
  className?: string;
  /** Mini title-bar text. Omit for a bare bar. */
  title?: ReactNode;
  icon?: string | ReactNode;
  /** Badge (string) or node on the right of the bar. */
  accent?: ReactNode;
  accentTone?: HoloTone;
  bar?: 'holo' | 'lilac' | 'pink' | 'ink';
  /** 'screen' = deep-indigo body for dense data. */
  tone?: 'light' | 'screen';
  footer?: ReactNode;
  id?: string;
  style?: CSSProperties;
}

/** A poster mini-dialog card (HoloCard). Clickable when `onClick` is set. */
export function GlassCard({
  children,
  hover = false,
  onClick,
  padding,
  className,
  title,
  icon,
  accent,
  accentTone,
  bar,
  tone,
  footer,
  id,
  style,
}: GlassCardProps) {
  const card = (
    <HoloCard
      title={title}
      icon={icon}
      accent={accent}
      accentTone={accentTone}
      bar={bar}
      tone={tone}
      footer={footer}
      bodyStyle={padding != null ? { padding } : undefined}
      style={onClick ? undefined : style}
    >
      {children}
    </HoloCard>
  );
  if (!onClick) {
    return id || className ? (
      <div id={id} className={className} style={{ minWidth: 0 }}>
        {card}
      </div>
    ) : (
      card
    );
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <div
      id={id}
      role="button"
      tabIndex={0}
      className={`ps-clickcard${hover ? ' ps-clickcard--hover' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      onKeyDown={onKey}
      style={style}
    >
      {card}
    </div>
  );
}

/** A stat tile: pixel label + holographic numeral (long values drop to poster mono). */
export function StatTile({
  label,
  value,
  sub,
  tone = 'holo',
  loading = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: HoloTone;
  loading?: boolean;
}) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  const big = text !== null && text.length <= 7;
  return (
    <div className="ps-stat" aria-busy={loading || undefined}>
      <HoloStat label={label} value={loading ? '…' : value} sub={sub} tone={tone} size={big ? 'lg' : 'md'} />
    </div>
  );
}

/** Section heading: pixel poster title over a checker strip. */
export function SectionHeader({ label, kicker, id }: { label: string; kicker?: ReactNode; id?: string }) {
  return (
    <div className="ps-sechead" id={id}>
      {kicker && <div className="ps-sechead__kicker">{kicker}</div>}
      <HoloTitle as="h2" size="sm" style={{ alignSelf: 'flex-start' }}>
        {label}
      </HoloTitle>
      <HoloDivider variant="checker" />
    </div>
  );
}

export function H3({ children, style, id }: { children: ReactNode; style?: CSSProperties; id?: string }) {
  return (
    <h3 id={id} className="ps-h3" style={style}>
      {children}
    </h3>
  );
}

export function P({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p className="ps-p" style={style}>
      {children}
    </p>
  );
}

/* ──────────────────────────── page-body helpers ──────────────────────────── */

/** An anchored page section (id for the nav + #deep links), with its heading. */
export function DocSection({
  id,
  label,
  kicker,
  children,
}: {
  id: string;
  label: string;
  kicker?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="ps-section">
      <SectionHeader label={label} kicker={kicker} />
      {children}
    </section>
  );
}

/** Auto-fit grid (wraps to one column at 375px). */
export function Grid({ min = 200, gap = 12, children, style }: { min?: number; gap?: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap, minWidth: 0, ...style }}>
      {children}
    </div>
  );
}

/** Inline code. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="ps-icode" translate="no">
      {children}
    </code>
  );
}

/** A deep-indigo code screen with a copy key. */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  const { t } = useTranslation('shell');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the text is still selectable */
    }
  };
  return (
    <div className="ps-code" translate="no">
      <div className="ps-code__bar">
        <span className="ps-code__lang">{title ?? lang ?? t('publicFrame.code.label')}</span>
        <button type="button" className="ps-code__copy" onClick={copy} aria-label={t('publicFrame.code.copyAria')}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <pre className="ps-code__pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * A real <table> in a pastel well. On phones it scrolls sideways inside
 * itself, or with `stack` each row becomes a labelled card (string headers).
 */
export function DataTable({
  head,
  rows,
  minWidth,
  align,
  caption,
  rowKey,
  stack = false,
}: {
  head: ReactNode[];
  rows: ReactNode[][];
  minWidth?: number;
  align?: ('left' | 'right' | 'center')[];
  caption?: ReactNode;
  rowKey?: (row: ReactNode[], i: number) => string | number;
  /** ≤767px: one labelled card per row instead of a sideways scroll. */
  stack?: boolean;
}) {
  const label = (i: number) => (typeof head[i] === 'string' ? (head[i] as string) : undefined);
  return (
    <div className={`ps-table${stack ? ' ps-table--stack' : ''}`} data-holo-scroll>
      <table style={{ minWidth }}>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" style={{ textAlign: align?.[i] ?? 'left' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={rowKey ? rowKey(r, ri) : ri}>
              {r.map((c, ci) => (
                <td key={ci} style={{ textAlign: align?.[ci] ?? 'left' }} data-label={stack ? label(ci) : undefined}>
                  {stack ? <div className="ps-td">{c}</div> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Bulleted list with pixel sparkle markers. */
export function Bullets({ items, style }: { items: ReactNode[]; style?: CSSProperties }) {
  return (
    <ul className="ps-bullets" style={style}>
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Numbered steps with pixel keys. */
export function Steps({ items, style }: { items: ReactNode[]; style?: CSSProperties }) {
  return (
    <ol className="ps-steps" style={style}>
      {items.map((it, i) => (
        <li key={i}>
          <span className="ps-steps__n" aria-hidden>
            {i + 1}
          </span>
          <div className="ps-steps__body">{it}</div>
        </li>
      ))}
    </ol>
  );
}

/** A Holo button that navigates: internal route (`to`) or external link (`href`, new tab). */
export function LinkButton({
  to,
  href,
  children,
  variant = 'secondary',
  size = 'md',
}: {
  to?: string;
  href?: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  const cls = ['holo-btn', 'ps-linkbtn', variant !== 'secondary' ? `holo-btn--${variant}` : '', size !== 'md' ? `holo-btn--${size}` : '']
    .filter(Boolean)
    .join(' ');
  if (href) {
    return (
      <a className={cls} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link className={cls} to={to ?? '/'}>
      {children}
    </Link>
  );
}

/** Address with a Blockscout link (new tab). */
export function Addr({ address, full = false, label }: { address: string; full?: boolean; label?: ReactNode }) {
  return (
    <a className="ps-addr" href={addressUrl(address)} target="_blank" rel="noopener noreferrer" translate="no" title={address}>
      {label ?? (full ? address : shortAddr(address))}
    </a>
  );
}

/** Collapsible questions (native <details>, so every answer is in the page for readers and crawlers). */
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="ps-faq">
      {items.map((it) => (
        <details key={it.q} className="ps-faq__item">
          <summary>
            <span className="ps-faq__mark" aria-hidden />
            <span>{it.q}</span>
          </summary>
          <div className="ps-faq__a">{it.a}</div>
        </details>
      ))}
    </div>
  );
}

/* ─────────────────── live contract table (Docs, Whitepaper, …) ─────────────────── */

type SpareContractName = keyof typeof SPARE;

/**
 * The ten S1 contracts and what each one does. `role` is an
 * i18n key: the same role lines as the live pages' address book (pages-b `book.contracts.*`).
 */
export const SPARE_CONTRACT_ROLES: { name: SpareContractName; role: string }[] = [
  { name: 'SweepExecutor', role: tKey('pages-b:book.contracts.sweepExecutor') },
  { name: 'CashPark', role: tKey('pages-b:book.contracts.cashPark') },
  { name: 'RuleRegistry', role: tKey('pages-b:book.contracts.ruleRegistry') },
  { name: 'ElectionRegistry', role: tKey('pages-b:book.contracts.electionRegistry') },
  { name: 'AssetRegistry', role: tKey('pages-b:book.contracts.assetRegistry') },
  { name: 'StockRouter', role: tKey('pages-b:book.contracts.stockRouter') },
  { name: 'FeeVault', role: tKey('pages-b:book.contracts.feeVault') },
  { name: 'ScreeningGate', role: tKey('pages-b:book.contracts.screeningGate') },
  { name: 'UsdgParkAdapter', role: tKey('pages-b:book.contracts.usdgParkAdapter') },
  { name: 'SgovParkAdapter', role: tKey('pages-b:book.contracts.sgovParkAdapter') },
];

/** Live bytecode check for every Spare contract: name -> true (code) / false (none) / null (unread). */
export function useSpareBytecode() {
  const client = usePublicClient({ chainId: SPARE_CHAIN_ID });
  return useQuery({
    queryKey: ['spare', 'bytecode', 'all'],
    enabled: !!client,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async () => {
      const names = Object.keys(SPARE) as SpareContractName[];
      const entries = await Promise.all(
        names.map(async (n) => {
          try {
            const code = await client!.getCode({ address: SPARE[n] });
            return [n, !!code && code !== '0x'] as const;
          } catch {
            return [n, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<SpareContractName, boolean | null>;
    },
  });
}

/** Contract | Address (Blockscout) | Role | live bytecode badge. */
export function SpareContractsTable() {
  const { t } = useTranslation('shell');
  const code = useSpareBytecode();
  const badge = (n: SpareContractName) => {
    if (code.isLoading) return <HoloBadge label={t('publicFrame.contracts.checking')} tone="muted" pulse />;
    const v = code.data?.[n];
    if (v === true) return <HoloBadge label={t('publicFrame.contracts.deployed')} tone="good" />;
    if (v === false) return <HoloBadge label={t('publicFrame.contracts.noCode')} tone="bad" />;
    return <HoloBadge label={t('publicFrame.contracts.unread')} tone="muted" title={t('publicFrame.contracts.unreadTitle')} />;
  };
  return (
    <DataTable
      head={[t('publicFrame.contracts.head.contract'), t('publicFrame.contracts.head.address'), t('publicFrame.contracts.head.role'), t('publicFrame.contracts.head.bytecode')]}
      minWidth={620}
      stack
      rowKey={(_, i) => SPARE_CONTRACT_ROLES[i].name}
      rows={SPARE_CONTRACT_ROLES.map((c) => [
        <strong key="n">{c.name}</strong>,
        <Addr key="a" address={SPARE[c.name]} />,
        t(c.role),
        <span key="b">{badge(c.name)}</span>,
      ])}
      caption={t('publicFrame.contracts.caption')}
    />
  );
}

/** A row of CTA buttons. */
export function Ctas({ children }: { children: ReactNode }) {
  return <div className="ps-ctas">{children}</div>;
}

/* ─────────────────────────────────── CSS ─────────────────────────────────── */

const SPARKLE = sparkleUrl();

const SHELL_CSS = `
/* The document is the only scroller on public pages. retro98.css gives html AND
   body overflow-y:auto on phones, which turns body into a (non-scrolling) scroll
   container and silently kills position:sticky. Undo it while a shell is mounted. */
html:has(.ps-root):has(.ps-root) { overflow-y: visible !important; height: auto !important; }
body:has(.ps-root):has(.ps-root) { overflow-y: visible !important; overflow-x: clip !important; height: auto !important; }
.ps-root {
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  padding: 18px 18px 48px;
  color: ${HOLO.ink};
  font-family: var(--holo-font-text);
  -webkit-text-size-adjust: 100%;
}
.ps-backdrop {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky};
  overflow: hidden;
}
.ps-backdrop__horizon {
  position: absolute; left: 0; right: 0; bottom: 0; height: 38%;
  background-image:
    radial-gradient(circle, rgba(255,255,255,.85) 0 1.2px, transparent 1.7px),
    radial-gradient(circle, rgba(107,79,224,.22) 0 1px, transparent 1.5px);
  background-size: 6px 6px, 6px 6px;
  background-position: 0 0, 3px 3px;
  -webkit-mask-image: linear-gradient(0deg, #000 0%, rgba(0,0,0,.5) 40%, transparent 100%);
  mask-image: linear-gradient(0deg, #000 0%, rgba(0,0,0,.5) 40%, transparent 100%);
}
.ps-window {
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  background: ${GRADIENT.face};
  border: 2px solid ${HOLO.ink};
  box-shadow: inset 0 0 0 1px #FFFFFF, 6px 6px 0 0 rgba(42,27,110,.20), 0 18px 44px rgba(74,58,168,.28);
}

/* title bar */
.ps-titlebar {
  display: flex; align-items: center; gap: 6px;
  height: 30px; margin: 2px 2px 0; padding: 0 4px 1px 6px;
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar};
  box-shadow: inset 0 -1px 0 0 ${HOLO.ink};
  user-select: none;
}
.ps-titlebar__icon { image-rendering: auto; filter: drop-shadow(1px 1px 0 rgba(42,27,110,.6)); flex-shrink: 0; }
.ps-titlebar__text {
  font-family: var(--holo-font-chrome); font-weight: 400; font-synthesis: none;
  font-size: 21px; letter-spacing: .03em; line-height: 1;
  color: #FFFFFF; text-shadow: 1px 1px 0 ${HOLO.ink};
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.ps-winbtn {
  flex-shrink: 0; width: 24px; height: 21px;
  display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #FFF1F7 0%, #FFC9E0 100%);
  box-shadow: var(--holo-raised); color: ${HOLO.ink};
}
.ps-winbtn:hover { background: linear-gradient(180deg, #FFE3EF 0%, #FFA9CD 100%); }
.ps-winbtn:active { box-shadow: var(--holo-pressed); padding: 2px 0 0 2px; }
.ps-winbtn:focus-visible { outline: 1px dotted #FFFFFF; outline-offset: 1px; }

/* toolbar */
.ps-toolbar {
  display: flex; align-items: center; gap: 5px;
  margin: 0 2px; padding: 5px 6px;
  background: ${GRADIENT.menuBar};
  box-shadow: inset 0 -1px 0 0 ${HOLO.bevelLo};
  min-width: 0;
}
.ps-key {
  flex-shrink: 0; width: 30px; height: 26px; padding: 0; border: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--holo-face); box-shadow: var(--holo-raised);
  color: ${HOLO.ink}; font-family: var(--holo-font-text); font-weight: 700;
  cursor: pointer; text-decoration: none;
}
.ps-key:hover { filter: brightness(1.04) saturate(1.2); }
.ps-key:active { box-shadow: var(--holo-pressed); padding-top: 2px; padding-left: 2px; }
.ps-key:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: -5px; }
.ps-address {
  flex: 1 1 auto; min-width: 0; height: 26px;
  display: flex; align-items: center; gap: 8px; padding: 0 8px;
  background: ${HOLO.paper}; box-shadow: var(--holo-well);
}
.ps-address__label { font-family: var(--holo-font-chrome); font-size: 17px; color: ${HOLO.inkSoft}; flex-shrink: 0; }
.ps-address__url { font-family: var(--holo-font-text); font-size: 12px; color: ${HOLO.ink}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ps-netbadge { flex-shrink: 0; display: inline-flex; }

/* page tabs */
.ps-tabs {
  display: flex; gap: 4px; align-items: flex-end;
  margin: 0 2px; padding: 7px 8px 0;
  background: linear-gradient(180deg, #FBF7FF 0%, #EFE6FF 100%);
  border-bottom: 2px solid ${HOLO.ink};
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none;
}
.ps-tabs::-webkit-scrollbar { display: none; }
.ps-tab {
  position: relative; flex-shrink: 0;
  display: inline-flex; align-items: center;
  height: 28px; padding: 0 12px; margin-bottom: -2px;
  font-family: var(--holo-font-chrome); font-weight: 400; font-synthesis: none;
  font-size: 18px; line-height: 1; letter-spacing: .03em; white-space: nowrap;
  color: ${HOLO.ink}; text-decoration: none;
  background: var(--holo-face);
  border: 2px solid ${HOLO.ink}; border-bottom: 0;
  box-shadow: inset 1px 1px 0 #FFFFFF, inset -1px 0 0 ${HOLO.bevelLo};
}
.ps-tab:hover { filter: brightness(1.04) saturate(1.2); background: linear-gradient(180deg, #FFFFFF 0%, #FFE9F5 100%); }
.ps-tab:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: -5px; }
.ps-tab[aria-current='page'] {
  height: 31px; padding-right: 20px;
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%);
  color: ${HOLO.onScreen}; text-shadow: 1px 1px 0 #140E3E;
  box-shadow: inset 1px 1px 0 #7B63E0;
}
.ps-tab[aria-current='page']::after {
  content: ''; position: absolute; top: 4px; right: 5px; width: 8px; height: 8px;
  background: ${SPARKLE} center / contain no-repeat;
}

/* body */
.ps-body {
  position: relative;
  display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; align-items: start;
  margin: 0 2px; padding: 16px 16px 20px;
  background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.canvas};
}
.ps-body--solo { grid-template-columns: minmax(0, 1fr); }
.ps-body--solo .ps-main { max-width: 980px; width: 100%; margin: 0 auto; }

/* section nav */
.ps-nav {
  position: sticky; top: 12px; z-index: 5;
  display: flex; flex-direction: column;
  max-height: calc(100vh - 24px);
  border: 2px solid ${HOLO.ink};
  background: ${GRADIENT.card};
  box-shadow: inset 0 0 0 1px #FFFFFF, 4px 4px 0 0 rgba(42,27,110,.22);
  min-width: 0;
}
.ps-nav__bar {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  margin: 1px 1px 0; padding: 3px 8px;
  border-bottom: 2px solid ${HOLO.ink};
  background: ${TEXTURE.dither} right center / 4px 4px, ${GRADIENT.cardBar};
  font-family: var(--holo-font-chrome); font-weight: 400; font-size: 17px; line-height: 1.1; color: ${HOLO.ink};
}
.ps-nav__list {
  display: flex; flex-direction: column; gap: 10px;
  padding: 8px; overflow-y: auto; min-height: 0;
  scrollbar-color: ${HOLO.lilac} ${HOLO.face};
}
.ps-nav__group { display: flex; flex-direction: column; gap: 1px; }
.ps-nav__label {
  font-family: var(--holo-font-pixel); font-weight: 700; font-size: 10px; letter-spacing: .12em;
  text-transform: uppercase; color: ${HOLO.inkSoft};
  padding: 2px 4px 4px; margin-bottom: 2px;
  border-bottom: 1px dashed ${HOLO.lilac};
}
.ps-nav__item {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 6px;
  font-family: var(--holo-font-chrome); font-weight: 400; font-synthesis: none;
  font-size: 18px; line-height: 1.05; color: ${HOLO.ink}; text-decoration: none;
}
.ps-nav__item::before {
  content: ''; flex-shrink: 0; width: 6px; height: 6px;
  background: ${HOLO.lilac}; box-shadow: 0 0 0 1px ${HOLO.ink};
}
.ps-nav__item:hover { background: rgba(201,182,255,.32); }
.ps-nav__item:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: -2px; }
.ps-nav__item[aria-current='true'] {
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(90deg, #2A1B6E 0%, #4B36B8 65%, #8E6BE8 100%);
  color: #FFFFFF; text-shadow: 1px 1px 0 #140E3E;
}
.ps-nav__item[aria-current='true']::before {
  width: 9px; height: 9px; box-shadow: none;
  background: ${SPARKLE} center / contain no-repeat;
}

/* main column */
.ps-main { min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.ps-hero-extra { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ps-section { display: flex; flex-direction: column; gap: 12px; scroll-margin-top: 14px; min-width: 0; }
.ps-sechead { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; min-width: 0; }
.ps-sechead__kicker {
  font-family: var(--holo-font-pixel); font-weight: 700; font-size: 10.5px; letter-spacing: .14em;
  text-transform: uppercase; color: ${HOLO.inkSoft};
}
.ps-h3 {
  margin: 0; font-family: var(--holo-font-chrome); font-weight: 400; font-synthesis: none;
  font-size: 23px; line-height: 1.05; letter-spacing: .02em; color: ${INK.body};
}
.ps-p { margin: 0; font-family: var(--holo-font-text); font-size: 13px; line-height: 1.7; color: ${INK.body}; max-width: 78ch; }
.ps-p strong, .ps-bullets strong, .ps-steps strong { font-weight: 700; color: ${INK.body}; }
.ps-main a:not(.holo-btn):not(.ps-addr):not(.ps-nav__item) { color: ${INK.link}; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.ps-main a:not(.holo-btn):not(.ps-addr):not(.ps-nav__item):hover { text-decoration-style: solid; }
.ps-stat {
  min-width: 0; padding: 10px 12px 12px;
  border: 2px solid ${HOLO.ink};
  background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card};
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.2);
  overflow: hidden;
}
.ps-clickcard { cursor: pointer; min-width: 0; }
.ps-clickcard:focus-visible { outline: 2px dotted ${HOLO.ink}; outline-offset: 3px; }
.ps-clickcard--hover:hover .holo-card { transform: translate(-1px, -1px); box-shadow: inset 0 0 0 1px #FFFFFF, 6px 6px 0 0 rgba(42,27,110,.26); }
.ps-icode {
  font-family: var(--holo-font-text); font-size: .92em; padding: 1px 5px;
  background: rgba(255,255,255,.75); box-shadow: inset 0 0 0 1px ${HOLO.bevelLo};
  color: ${INK.body}; overflow-wrap: anywhere;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.holo-card--screen .ps-icode { background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 1px ${HOLO.screenLine}; }
.ps-code { min-width: 0; border: 2px solid ${HOLO.ink}; box-shadow: 3px 3px 0 0 rgba(42,27,110,.2); }
.ps-code__bar {
  display: flex; align-items: center; gap: 8px; padding: 3px 4px 3px 10px;
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.cardBarInk};
  border-bottom: 1px solid ${HOLO.screenLine};
}
.ps-code__lang { flex: 1; font-family: var(--holo-font-pixel); font-weight: 700; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: ${HOLO.onScreenMuted}; }
.ps-code__copy {
  height: 22px; padding: 0 9px; border: 0; cursor: pointer;
  background: var(--holo-chrome); box-shadow: 0 0 0 1px #140E3E, var(--holo-raised);
  font-family: var(--holo-font-chrome); font-weight: 400; font-size: 16px; line-height: 1; color: ${HOLO.ink};
}
.ps-code__copy:active { box-shadow: 0 0 0 1px #140E3E, var(--holo-pressed); }
.ps-code__pre {
  margin: 0; padding: 12px 14px; overflow-x: auto;
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen};
  color: ${HOLO.onScreen}; font-family: var(--holo-font-text); font-size: 12px; line-height: 1.65;
  tab-size: 2; white-space: pre;
  scrollbar-color: ${HOLO.screenLine} ${HOLO.screenDeep};
}
.ps-table { min-width: 0; overflow-x: auto; background: ${HOLO.paper}; box-shadow: var(--holo-well); padding: 2px; }
.ps-table table { width: 100%; border-collapse: collapse; }
.ps-table caption { caption-side: bottom; text-align: left; padding: 6px 8px 4px; font-family: var(--holo-font-text); font-size: 11px; color: ${HOLO.inkMuted}; }
.ps-table th {
  padding: 6px 8px; white-space: nowrap; vertical-align: bottom;
  background: linear-gradient(180deg, #F4EEFF 0%, #E2D8FF 100%);
  box-shadow: inset -1px 0 0 ${HOLO.lilac}, inset 0 -2px 0 ${HOLO.ink};
  font-family: var(--holo-font-pixel); font-weight: 700; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: ${HOLO.ink};
}
.ps-table td {
  padding: 7px 8px; vertical-align: top;
  font-family: var(--holo-font-text); font-size: 12px; line-height: 1.5; color: ${HOLO.ink};
  border-bottom: 1px dashed #E2D8FF;
}
.ps-table tbody tr:nth-child(odd) td { background: #FFF6F0; }
.ps-table tbody tr:last-child td { border-bottom: 0; }
.ps-bullets { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; max-width: 80ch; }
.ps-bullets li {
  position: relative; padding-left: 20px;
  font-family: var(--holo-font-text); font-size: 13px; line-height: 1.65; color: ${INK.body};
}
.ps-bullets li::before {
  content: ''; position: absolute; left: 1px; top: .42em; width: 11px; height: 11px;
  background: ${sparkleUrl(HOLO.ink, HOLO.pink)} center / contain no-repeat;
}
.holo-card--screen .ps-bullets li::before { background-image: ${SPARKLE}; }
.ps-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; max-width: 82ch; }
.ps-steps li { display: flex; gap: 12px; align-items: flex-start; }
.ps-steps__n {
  flex-shrink: 0; width: 28px; height: 28px; margin-top: 1px;
  display: inline-flex; align-items: center; justify-content: center;
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%);
  box-shadow: inset 1px 1px 0 #7B63E0, 0 0 0 1px ${HOLO.ink}, 2px 2px 0 rgba(42,27,110,.25);
  color: ${HOLO.onScreen}; font-family: var(--holo-font-display); font-size: 11px; line-height: 1;
}
.ps-steps__body { min-width: 0; flex: 1; font-family: var(--holo-font-text); font-size: 13px; line-height: 1.7; color: ${INK.body}; padding-top: 3px; }
.ps-linkbtn { text-decoration: none; }
.ps-addr {
  font-family: var(--holo-font-text); font-size: 12px; color: ${INK.link};
  text-decoration: underline dotted; text-underline-offset: 3px; overflow-wrap: anywhere;
}
.ps-addr:hover { text-decoration-style: solid; }
.ps-table .ps-addr { white-space: nowrap; overflow-wrap: normal; }
.ps-ctas { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

/* faq */
.ps-faq { display: flex; flex-direction: column; gap: 8px; }
.ps-faq__item {
  border: 2px solid ${HOLO.ink};
  background: ${GRADIENT.card};
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.18);
}
.ps-faq__item summary {
  display: flex; align-items: center; gap: 9px; padding: 8px 10px; cursor: pointer; list-style: none;
  font-family: var(--holo-font-chrome); font-weight: 400; font-synthesis: none; font-size: 20px; line-height: 1.1; color: ${HOLO.ink};
}
.ps-faq__item summary::-webkit-details-marker { display: none; }
.ps-faq__item summary:hover { background: rgba(201,182,255,.25); }
.ps-faq__item summary:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: -4px; }
.ps-faq__mark {
  flex-shrink: 0; width: 16px; height: 16px;
  background: var(--holo-face); box-shadow: var(--holo-raised);
  position: relative;
}
.ps-faq__mark::before, .ps-faq__mark::after {
  content: ''; position: absolute; left: 4px; top: 7px; width: 8px; height: 2px; background: ${HOLO.ink};
}
.ps-faq__mark::after { transform: rotate(90deg); }
.ps-faq__item[open] .ps-faq__mark::after { display: none; }
.ps-faq__item[open] summary { border-bottom: 1px dashed ${HOLO.lilac}; }
.ps-faq__a { padding: 9px 12px 12px 35px; font-family: var(--holo-font-text); font-size: 13px; line-height: 1.7; color: ${HOLO.ink}; }

/* status bar */
.ps-status { display: flex; gap: 3px; height: 24px; margin: 0 2px 2px; padding: 2px; background: ${GRADIENT.menuBar}; }
.ps-status__panel {
  display: flex; align-items: center; gap: 6px; padding: 0 8px; min-width: 0;
  box-shadow: inset 1px 1px 0 0 ${HOLO.bevelLo}, inset -1px -1px 0 0 #FFFFFF;
  background: rgba(255,255,255,.5);
  font-family: var(--holo-font-chrome); font-weight: 400; font-size: 17px; color: ${HOLO.ink}; white-space: nowrap;
}
.ps-status__panel--grow { flex: 1; }
.ps-status__pip { width: 7px; height: 7px; background: ${HOLO.goodFill}; box-shadow: 0 0 0 1px ${HOLO.ink}; flex-shrink: 0; }

@media (max-width: 1023px) {
  .ps-body { grid-template-columns: 200px minmax(0, 1fr); gap: 14px; }
  .ps-netbadge { display: none; }
}

@media (max-width: 767px) {
  .ps-root { padding: 0 0 24px; }
  .ps-window { border: 0; box-shadow: none; }
  .ps-titlebar { margin: 0; }
  .ps-titlebar__text { font-size: 19px; }
  .ps-toolbar { margin: 0; padding: 4px; gap: 4px; }
  .ps-key { width: 34px; height: 30px; }
  .ps-key--wide { display: none; }
  .ps-address { height: 30px; }
  .ps-address__label { display: none; }
  .ps-tabs { margin: 0; padding: 6px 6px 0; }
  .ps-tab { font-size: 17px; padding: 0 10px; }
  .ps-body, .ps-body--solo { display: block; margin: 0; padding: 0 10px 14px; }
  .ps-nav {
    position: sticky; top: 0; z-index: 30;
    max-height: none; margin: 0 -10px 12px;
    border-width: 0 0 2px; box-shadow: 0 3px 0 rgba(42,27,110,.14);
    background: ${GRADIENT.menuBar};
  }
  .ps-nav__bar { display: none; }
  .ps-nav__list {
    flex-direction: row; gap: 6px; padding: 7px 10px;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  }
  .ps-nav__list::-webkit-scrollbar { display: none; }
  .ps-nav__group { flex-direction: row; gap: 6px; flex-shrink: 0; }
  .ps-nav__label { display: none; }
  .ps-nav__item {
    flex-shrink: 0; white-space: nowrap; font-size: 17px; padding: 6px 9px;
    background: #FFFFFF; box-shadow: inset 0 0 0 1px ${HOLO.ink}, 2px 2px 0 rgba(42,27,110,.16);
  }
  .ps-nav__item::before { display: none; }
  .ps-nav__item[aria-current='true'] { padding-left: 8px; }
  .ps-nav__item[aria-current='true']::before { display: block; }
  .ps-main { gap: 14px; }
  .ps-body--solo .ps-main { padding-top: 12px; }
  .ps-section { scroll-margin-top: 58px; }
  .ps-p, .ps-bullets li, .ps-steps__body { font-size: 12.5px; }
  .ps-h3 { font-size: 21px; }
  .ps-code__pre { font-size: 11.5px; padding: 10px; }
  .ps-table--stack table { min-width: 0 !important; }
  .ps-table--stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .ps-table--stack tbody tr { display: block; padding: 6px 0; border-bottom: 2px dashed #E2D8FF; }
  .ps-table--stack tbody tr:last-child { border-bottom: 0; }
  .ps-table--stack tbody tr:nth-child(odd) { background: #FFF6F0; }
  .ps-table--stack tbody td {
    display: grid; grid-template-columns: minmax(84px, 34%) minmax(0, 1fr); gap: 10px;
    padding: 4px 10px; border: 0; background: transparent !important; text-align: left !important;
  }
  .ps-table--stack tbody td::before {
    content: attr(data-label); padding-top: 3px;
    font-family: var(--holo-font-pixel); font-weight: 700; font-size: 9.5px; letter-spacing: .08em;
    text-transform: uppercase; color: ${HOLO.inkSoft};
  }
  .ps-table--stack .ps-td { min-width: 0; overflow-wrap: anywhere; }
  .ps-faq__item summary { font-size: 19px; }
  .ps-faq__a { padding-left: 12px; font-size: 12.5px; }
  .ps-status { margin: 0; }
}
`;

const FOOTER_CSS = `
.ps-footer { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; padding-top: 2px; color: ${HOLO.ink}; }
.ps-footer__brand {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-family: var(--holo-font-chrome); font-weight: 400; font-size: 19px; line-height: 1.15; color: ${HOLO.ink};
}
.ps-footer__links { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.ps-footer__links a {
  font-family: var(--holo-font-text); font-size: 12.5px; font-weight: 700;
  color: ${HOLO.link}; text-decoration: underline dotted; text-underline-offset: 3px;
}
.ps-footer__links a:hover { text-decoration-style: solid; }
.ps-footer__legal { margin: 0; max-width: 90ch; font-family: var(--holo-font-text); font-size: 11px; line-height: 1.6; color: ${HOLO.inkMuted}; }
`;
