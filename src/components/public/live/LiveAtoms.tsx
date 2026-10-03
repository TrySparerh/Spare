/**
 * Small Holo building blocks for the public developer pages (/devtools,
 * /datalayer, /dispatch, /mcp): code blocks with copy, Blockscout links,
 * prose, stat grids and bytecode badges. Styles are inline (plus a few
 * classes in LIVE_ATOMS_CSS) so the atoms work inside PublicShell and inside
 * LivePageFrame alike.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FONT_CHROME, FONT_PIXEL, FONT_TEXT, GRADIENT, HOLO, INK, TEXTURE, BEVEL_WELL, HoloBadge, HoloTitle } from '@/components/retro/holo';
import { EXPLORER_URL } from '@/lib/spare-chain/addresses';
import { useTranslation } from '@/i18n';

/* ---------------------------------- text ---------------------------------- */

export function Prose({ children, style, muted = false }: { children: ReactNode; style?: CSSProperties; muted?: boolean }) {
  return (
    <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.65, color: muted ? INK.muted : INK.body, maxWidth: 820, ...style }}>
      {children}
    </p>
  );
}

/** Inline code. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: FONT_TEXT,
        fontSize: '0.92em',
        padding: '0 4px',
        background: 'rgba(201,182,255,.28)',
        boxShadow: `inset 0 0 0 1px ${HOLO.bevelLo}`,
        color: INK.body,
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </code>
  );
}

/** A section heading: pixel kicker + holo headline. */
export function SectionHead({ title, kicker, id }: { title: ReactNode; kicker?: ReactNode; id?: string }) {
  return (
    <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: 4, scrollMarginTop: 16 }}>
      {kicker && (
        <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase', color: INK.soft }}>{kicker}</span>
      )}
      <HoloTitle size="sm" as="h2">
        {title}
      </HoloTitle>
    </div>
  );
}

/** Bulleted list with pixel sparkle bullets. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((it, i) => (
        <li key={i} style={{ display: 'flex', gap: 8, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.6, color: INK.body }}>
          <span aria-hidden style={{ color: INK.soft, flexShrink: 0 }}>
            ✦
          </span>
          <span style={{ minWidth: 0 }}>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- layout --------------------------------- */

/** Responsive grid: as many `min`-wide columns as fit, one column on a phone. */
export function Grid({ min = 200, gap = 12, children, style }: { min?: number; gap?: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap, minWidth: 0, ...style }}>
      {children}
    </div>
  );
}

/** A row of CTA links that wraps on phones. */
export function CtaRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{children}</div>;
}

/** A router Link (or external anchor) wearing the Holo button face. */
export function LinkButton({
  to,
  href,
  variant = 'secondary',
  size = 'md',
  children,
}: {
  to?: string;
  href?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}) {
  const cls = ['holo-btn', variant !== 'secondary' ? `holo-btn--${variant}` : '', size !== 'md' ? `holo-btn--${size}` : ''].filter(Boolean).join(' ');
  const style: CSSProperties = { textDecoration: 'none' };
  if (href) {
    return (
      <a className={cls} href={href} target="_blank" rel="noopener noreferrer" style={style}>
        {children}
      </a>
    );
  }
  return (
    <Link className={cls} to={to ?? '/'} style={style}>
      {children}
    </Link>
  );
}

/* ---------------------------------- links --------------------------------- */

const LINK: CSSProperties = {
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  fontSize: 12,
  color: INK.link,
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
  overflowWrap: 'anywhere',
};

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** An address on Blockscout. `full` prints all 42 characters (wraps on phones). */
export function AddressLink({ address, full = false, kind = 'address' }: { address: string; full?: boolean; kind?: 'address' | 'token' }) {
  return (
    <a href={`${EXPLORER_URL}/${kind}/${address}`} target="_blank" rel="noopener noreferrer" title={address} style={LINK} translate="no">
      {full ? address : short(address)}
    </a>
  );
}

export function TxLinkOut({ hash, label }: { hash: string; label?: string }) {
  return (
    <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noopener noreferrer" title={hash} style={{ ...LINK, textDecorationStyle: 'solid', whiteSpace: 'nowrap' }} translate="no">
      {label ?? `${hash.slice(0, 10)}…`} ↗
    </a>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={LINK}>
      {children}
    </a>
  );
}

/* ---------------------------------- copy ---------------------------------- */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label: labelProp, onScreen = false }: { text: string; label?: string; onScreen?: boolean }) {
  const { t } = useTranslation('pages-b');
  const label = labelProp ?? t('shell:common.copy');
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      className="holo-btn holo-btn--sm"
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? 'ok' : 'fail');
        window.setTimeout(() => setState('idle'), 1600);
      }}
      aria-label={`${label}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`}
      style={onScreen ? { boxShadow: `0 0 0 1px ${HOLO.onScreenSubtle}, var(--holo-raised)` } : undefined}
    >
      {state === 'ok' ? t('shell:common.copied') : state === 'fail' ? t('atoms.copyFailed') : label}
    </button>
  );
}

/** A deep-indigo code well with a pixel label and a copy key. Scrolls sideways inside itself. */
export function CodeBlock({ code, title, lang }: { code: string; title?: string; lang?: string }) {
  const { t } = useTranslation('pages-b');
  return (
    <div style={{ minWidth: 0, boxShadow: `0 0 0 2px ${HOLO.ink}`, background: HOLO.screen }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 4px 4px 10px',
          background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.cardBarInk}`,
          color: '#FFFFFF',
          borderBottom: `1px solid ${HOLO.screenLine}`,
        }}
      >
        <span style={{ fontFamily: FONT_PIXEL, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title ?? lang ?? t('shell:publicFrame.code.label')}
        </span>
        <CopyButton text={code} onScreen />
      </div>
      <pre
        data-holo-scroll
        translate="no"
        style={{
          margin: 0,
          padding: '10px 12px',
          overflowX: 'auto',
          background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen}`,
          boxShadow: BEVEL_WELL,
          color: HOLO.onScreen,
          fontFamily: FONT_TEXT,
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre',
          tabSize: 2,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ------------------------------- flex rows -------------------------------- */

export interface FlexCell<R> {
  key: string;
  /** flex-basis, e.g. '170px'. Cells wrap onto new lines when the row is narrow. */
  basis: string;
  /** flex-grow. Default 1. */
  grow?: number;
  render: (r: R) => ReactNode;
  /** Muted small copy (roles, meanings). */
  muted?: boolean;
  /** Keep the cell at its content width (badges, buttons). */
  fixed?: boolean;
}

/**
 * A list that reads like a table on a wide screen and stacks cleanly on a
 * phone: each row is a wrapping flex line, so long addresses and signatures
 * never force a sideways scroll.
 */
export function FlexRows<R>({ rows, cells, rowKey, ariaLabel }: { rows: readonly R[]; cells: FlexCell<R>[]; rowKey: (r: R) => string; ariaLabel?: string }) {
  return (
    <ul
      aria-label={ariaLabel}
      style={{ listStyle: 'none', margin: 0, padding: '2px 10px', background: HOLO.paper, boxShadow: BEVEL_WELL, minWidth: 0 }}
    >
      {rows.map((r, i) => (
        <li
          key={rowKey(r)}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            gap: '4px 14px',
            padding: '8px 0',
            borderTop: i === 0 ? 'none' : `1px dashed ${HOLO.faceDeep}`,
            minWidth: 0,
          }}
        >
          {cells.map((c) => (
            <div
              key={c.key}
              style={{
                flex: c.fixed ? '0 0 auto' : `${c.grow ?? 1} 1 ${c.basis}`,
                minWidth: 0,
                fontFamily: FONT_TEXT,
                fontSize: c.muted ? 11.5 : 12,
                lineHeight: 1.5,
                color: c.muted ? INK.muted : INK.body,
                overflowWrap: 'anywhere',
              }}
            >
              {c.render(r)}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- status --------------------------------- */

/** Bytecode check result: true / false / null (not read). */
export function CodeBadge({ ok }: { ok: boolean | null | undefined }) {
  const { t } = useTranslation('pages-b');
  if (ok == null) return <HoloBadge label="…" tone="muted" title={t('atoms.code.checking')} />;
  return ok ? (
    <HoloBadge label={t('atoms.code.ok')} tone="good" title={t('atoms.code.okTitle')} />
  ) : (
    <HoloBadge label={t('atoms.code.none')} tone="bad" title={t('atoms.code.noneTitle')} />
  );
}

/** A labelled chrome value (for key/value rows outside HoloList). */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 17, color: INK.soft, lineHeight: 1.1 }}>{children}</span>;
}
