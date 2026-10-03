/**
 * Languages Spare ships, how a visitor's language is picked, and where the
 * choice is kept. No i18next import here, so tests and early boot code can use
 * it on its own.
 *
 *   en     English. The source of truth and the fallback for every key.
 *   zh-CN  Simplified Chinese (mainland China, Singapore, Malaysia).
 *   zh-TW  Traditional Chinese, written with Taiwan-standard vocabulary
 *          (Taiwan, Hong Kong, Macau).
 */

export const LANGS = ['en', 'zh-CN', 'zh-TW'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'en';

/** localStorage key holding an explicit choice from LanguageToggle. */
export const LANG_STORAGE_KEY = 'spare_lang';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

export function isChinese(lang: Lang): boolean {
  return lang !== 'en';
}

/**
 * Map a BCP 47 tag (navigator.language) to a Spare language.
 *   zh-TW, zh-HK, zh-MO, zh-Hant(-*)  -> zh-TW
 *   any other zh (zh, zh-CN, zh-SG, zh-Hans, zh-MY ...) -> zh-CN
 *   everything else -> en
 */
export function langFromTag(tag: string | null | undefined): Lang {
  const t = (tag ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (t !== 'zh' && !t.startsWith('zh-')) return 'en';
  const parts = t.split('-');
  if (parts.includes('hant') || parts.includes('tw') || parts.includes('hk') || parts.includes('mo')) return 'zh-TW';
  return 'zh-CN';
}

/** The browser's first preferred language, mapped. Used only when nothing is stored. */
export function detectBrowserLang(nav: Pick<Navigator, 'language' | 'languages'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): Lang {
  if (!nav) return DEFAULT_LANG;
  const first = nav.languages?.[0] ?? nav.language;
  return langFromTag(first);
}

/** The stored explicit choice, or null (never stored, storage blocked, junk value). */
export function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* private mode / blocked storage: the choice lasts for this page view only */
  }
}

/** First-render language: the stored choice, else the browser's language. */
export function initialLang(): Lang {
  return readStoredLang() ?? detectBrowserLang();
}

/** Labels for LanguageToggle. Never translated: each language names itself. */
export const LANG_OPTIONS: readonly { code: Lang; short: string; long: string }[] = [
  { code: 'en', short: 'EN', long: 'English' },
  // Distinct short labels, so the key shows which script is active without opening the menu.
  { code: 'zh-CN', short: '简中', long: '简体中文 · Simplified' },
  { code: 'zh-TW', short: '繁中', long: '繁體中文 · Traditional' },
];

/**
 * The language toggle used to run on Google Translate, which kept the choice in
 * a `googtrans` cookie. Nothing reads that cookie any more; expire it so it
 * stops riding along on every request.
 */
export function clearLegacyTranslateCookie(): void {
  if (typeof document === 'undefined' || !/(?:^|;\s*)googtrans=/.test(document.cookie)) return;
  const expired = 'googtrans=;expires=Thu, 01 Jan 1970 00:00:01 GMT;path=/';
  document.cookie = expired;
  const apex = window.location.hostname.split('.').slice(-2).join('.');
  if (apex.includes('.')) document.cookie = `${expired};domain=.${apex}`;
}
