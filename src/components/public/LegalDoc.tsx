/**
 * LegalDoc — the body of /privacy and /terms inside PublicShell: one Holo
 * dialog card per numbered section (the shell's useSectionSpy keeps the
 * sidebar in step), and a closing row with the published contact channels
 * (X + Telegram — Spare publishes no other contact) and the sibling page.
 *
 * i18n: section titles and bodies come translated from the pages (pages-a
 * namespace). In Chinese the page opens with the English-governs notice.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FONT_TEXT, HOLO, HoloCard, HoloNotice, INK } from '@/components/retro/holo';
import { useLang, useTranslation } from '@/i18n';
import type { PublicSidebarSection } from '@/components/public/PublicShell';
import { CtaRow, HoloLinkButton, TELEGRAM_URL, X_URL } from '@/components/public/HoloPageWindow';

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

export const LEGAL_P: CSSProperties = { margin: 0, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.65, color: INK.body };

/** Paragraph in a legal section. */
export function LP({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ ...LEGAL_P, ...style }}>{children}</p>;
}

/** Bulleted list in a legal section (pixel-square bullets). */
export function LList({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
      {items.map((it, i) => (
        <li key={i} style={{ ...LEGAL_P, display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <span aria-hidden style={{ width: 6, height: 6, marginTop: 8, flexShrink: 0, background: HOLO.inkSoft, boxShadow: `1px 1px 0 0 ${HOLO.lilac}` }} />
          <span style={{ minWidth: 0 }}>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** External link styled for legal copy. (children optional so it can be a <Trans> component.) */
export function LLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: INK.link, fontWeight: 700, textDecorationStyle: 'dotted', textUnderlineOffset: 3, overflowWrap: 'anywhere' }}>
      {children}
    </a>
  );
}

/** Sidebar model for PublicShell. */
export function legalSidebar(label: string, sections: LegalSection[]): PublicSidebarSection[] {
  return [{ label, items: sections.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.title}` })) }];
}

/** Section ids, for PublicShell's useSectionSpy (each section's element id is its id: /terms#risks). */
export function legalIds(sections: LegalSection[]): string[] {
  return sections.map((s) => s.id);
}

/** The numbered sections + the closing contact row. */
export function LegalDoc({ sections, other }: { sections: LegalSection[]; other: { to: string; label: string } }) {
  const { t } = useTranslation('pages-a');
  const lang = useLang();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT_TEXT }}>
      {lang !== 'en' && <HoloNotice tone="info">{t('legal.englishGoverns')}</HoloNotice>}
      {sections.map((s, i) => (
        <section key={s.id} id={s.id} style={{ scrollMarginTop: 72 }}>
          <HoloCard title={`${i + 1}. ${s.title}`} bar={i % 3 === 0 ? 'holo' : i % 3 === 1 ? 'lilac' : 'pink'}>
            {s.body}
          </HoloCard>
        </section>
      ))}
      <CtaRow>
        <HoloLinkButton href={X_URL} size="sm">
          X @TrySpareRH
        </HoloLinkButton>
        <HoloLinkButton href={TELEGRAM_URL} size="sm">
          Telegram
        </HoloLinkButton>
        <Link to={other.to} style={{ fontFamily: FONT_TEXT, fontSize: 12, fontWeight: 700, color: INK.link, textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>
          {other.label} →
        </Link>
      </CtaRow>
    </div>
  );
}
