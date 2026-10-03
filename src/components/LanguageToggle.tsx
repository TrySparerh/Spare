/**
 * LanguageToggle — EN / 简体中文 / 繁體中文 switcher, in the Spare Holo skin.
 *
 * Three placements:
 *   · variant="tray"     — a small chrome key in the desktop taskbar, next to
 *                          the zoom control. Its menu opens upward above it.
 *   · variant="bar"      — a key in a public page's title bar (PublicShell,
 *                          LivePageFrame, HoloPageWindow). Its menu drops down.
 *   · variant="floating" — the pill mounted once in App.tsx for the BIOS and
 *                          login: bottom-centre, just above where the taskbar
 *                          would be (bottom-right collided with the BIOS
 *                          "PRESS ENTER" CTA). It hides itself while the desktop
 *                          taskbar or a title-bar key is mounted, so it never
 *                          floats over a window or a page's reading column.
 *
 * Picking a language switches Spare's own translations in place (src/i18n —
 * no reload, no third-party widget) and remembers the choice in localStorage
 * (`spare_lang`). Chinese strings and fonts download only once Chinese is
 * picked.
 *
 * Why all three:
 *   · EN     — default
 *   · zh-CN  — Simplified (mainland CN, SG, MY — ~95% of Mandarin crypto)
 *   · zh-TW  — Traditional (HK, TW — the high-net-worth + institutional pool)
 *
 * The labels are deliberately NOT translated: each language names itself, and
 * the tooltip / menu heading carry all three, so a visitor stuck in a language
 * they can't read can still find the way back.
 *
 * Styles: .lang-toggle* in components/retro/holo/holo.css (global, because the
 * floating pill renders outside the .retro98 shell).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { GlyphArrowDown, GlyphCheck, GlyphGlobe } from '@/components/retro/holo/HoloGlyphs';
import { LANG_OPTIONS, setLanguage, useLang } from '@/i18n';

export interface LanguageToggleProps {
  /** 'floating' (default) — the bottom-centre pill; 'tray' — the taskbar key; 'bar' — a page title-bar key. */
  variant?: 'floating' | 'tray' | 'bar';
}

export function LanguageToggle({ variant = 'floating' }: LanguageToggleProps) {
  const current = useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  // Click-outside dismisses the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentOpt = LANG_OPTIONS.find((l) => l.code === current) ?? LANG_OPTIONS[0];

  return (
    <div
      ref={ref}
      // translate="no": a browser translator must leave the language names alone
      className={`notranslate lang-toggle lang-toggle--${variant}`}
      translate="no"
    >
      {/* The menu opens UPWARD so the taskbar never clips it ('bar' drops it down). */}
      {/* i18n-ignore: the heading and tooltip stay trilingual on purpose (see header comment). */}
      {open && (
        // i18n-ignore
        <div id={menuId} role="menu" aria-label="Language / 语言 / 語言" className="lang-toggle__menu">
          <div className="lang-toggle__bar">
            <GlyphGlobe scale={2} color="#FFFFFF" />
            {/* i18n-ignore */}
            <span>Language / 语言 / 語言</span>
          </div>
          {LANG_OPTIONS.map((opt) => {
            const isActive = opt.code === current;
            return (
              <button
                key={opt.code}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                lang={opt.code}
                onClick={() => {
                  setOpen(false);
                  if (!isActive) void setLanguage(opt.code);
                }}
                className={`lang-toggle__item${isActive ? ' is-active' : ''}`}
              >
                <span className="lang-toggle__check" aria-hidden>
                  {isActive && <GlyphCheck color="currentColor" />}
                </span>
                <span>{opt.long}</span>
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // i18n-ignore
        title="Change language / 切换语言 / 切換語言"
        aria-label={`Language: ${currentOpt.long}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="lang-toggle__key"
      >
        <GlyphGlobe scale={2} color="currentColor" />
        <span className="lang-toggle__label">{currentOpt.short}</span>
        <GlyphArrowDown color="currentColor" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
    </div>
  );
}

export default LanguageToggle;
