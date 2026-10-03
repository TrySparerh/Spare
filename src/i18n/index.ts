/**
 * Spare i18n — i18next + react-i18next. Read ./README.md before adding strings.
 *
 * In a component:
 *     import { useTranslation } from '@/i18n';
 *     const { t } = useTranslation('apps-a');
 *     t('fundWallet.title')                      // "Fund Wallet" / "钱包充值" / "錢包儲值"
 *     t('fundWallet.min', { amount: '$5.00' })   // "Minimum {{amount}}"
 *
 * Outside React (error decoders, constants, helpers):
 *     import { getT, t, tKey } from '@/i18n';
 *     const tf = getT('apps-a');      // fixed namespace, follows the live language
 *     tf('errors.rejected');
 *     t('shell:common.close');         // any namespace via "ns:" prefix
 *     const LABEL = tKey('bios.rows.chain');   // a key kept for later, checked by i18n:check
 *
 * Files:
 *     locales/en/<ns>.json      English: the source of truth and the fallback. Bundled.
 *     locales/zh-CN/<ns>.json   Simplified Chinese. One lazy chunk, fetched only when chosen.
 *     locales/zh-TW/<ns>.json   Traditional Chinese (Taiwan vocabulary). Same.
 */
import i18n, { type BackendModule, type ResourceKey } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { ensureCjkFonts } from './cjkFonts';
import {
  DEFAULT_LANG,
  LANGS,
  clearLegacyTranslateCookie,
  initialLang,
  isLang,
  storeLang,
  type Lang,
} from './languages';

export { useTranslation, Trans } from 'react-i18next';
export {
  LANGS,
  LANG_OPTIONS,
  LANG_STORAGE_KEY,
  DEFAULT_LANG,
  detectBrowserLang,
  initialLang,
  isChinese,
  isLang,
  langFromTag,
  type Lang,
} from './languages';

/** One JSON file per language each; README.md says which strings go where. */
export const NAMESPACES = ['shell', 'apps-a', 'apps-b', 'pages-a', 'pages-b', 'proof'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/* ───────────────────────────── resources ───────────────────────────── */

const fileNs = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.json'.length);

// English is bundled with the app: it renders the first frame and backs up
// every missing Chinese key.
const EN_FILES = import.meta.glob<ResourceKey>('./locales/en/*.json', { eager: true, import: 'default' });
const EN: Record<string, ResourceKey> = Object.fromEntries(Object.entries(EN_FILES).map(([p, json]) => [fileNs(p), json]));

// Chinese: one lazy chunk per language (see ./load). Nothing here is fetched
// until that language is chosen.
const LOADERS: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Record<string, ResourceKey> }>> = {
  'zh-CN': () => import('./load/zh-CN'),
  'zh-TW': () => import('./load/zh-TW'),
};

const lazyBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    const load = isLang(language) && language !== 'en' ? LOADERS[language] : undefined;
    if (!load) {
      callback(null, EN[namespace] ?? {});
      return;
    }
    load().then(
      (m) => {
        const hit = Object.entries(m.default).find(([p]) => fileNs(p) === namespace);
        callback(null, hit ? hit[1] : {});
      },
      (err) => callback(err, null),
    );
  },
};

/* ─────────────────────────────── setup ─────────────────────────────── */

function applyDocumentLang(lang: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = isLang(lang) ? lang : DEFAULT_LANG;
}

let initPromise: Promise<void> | null = null;

/**
 * Start i18n. main.tsx awaits this before the first render, so a returning
 * Chinese visitor never sees an English flash. For English it settles at once
 * (the strings are bundled); for Chinese it waits for that language's chunk.
 */
export function initI18n(lang: Lang = initialLang()): Promise<void> {
  if (initPromise) return initPromise;
  clearLegacyTranslateCookie();
  applyDocumentLang(lang);
  void ensureCjkFonts(lang);
  i18n.on('languageChanged', (lng) => {
    applyDocumentLang(lng);
    if (isLang(lng)) void ensureCjkFonts(lng);
  });
  initPromise = i18n
    .use(lazyBackend)
    .use(initReactI18next)
    .init({
      lng: lang,
      fallbackLng: DEFAULT_LANG,
      supportedLngs: [...LANGS],
      load: 'currentOnly',
      ns: [...NAMESPACES],
      defaultNS: 'shell',
      resources: { en: EN },
      partialBundledLanguages: true,
      // English needs no loading, so init settles straight away and the first
      // frame renders without waiting a tick.
      initAsync: false,
      // An empty string in a Chinese file means "not translated yet": show English.
      returnEmptyString: false,
      returnNull: false,
      // React escapes on render; escaping here would double-escape "&" and "<".
      interpolation: { escapeValue: false },
      react: { useSuspense: false, bindI18n: 'languageChanged loaded' },
    })
    .then(
      () => undefined,
      () => undefined, // a failed Chinese chunk still leaves English working
    );
  return initPromise;
}

/** Switch language in place (no reload) and remember the choice. */
export async function setLanguage(lang: Lang): Promise<void> {
  storeLang(lang);
  void ensureCjkFonts(lang);
  await i18n.changeLanguage(lang);
}

/**
 * The chosen language. (i18n.language, not resolvedLanguage: the latter reads
 * "en" while a Chinese file is still empty, which would mislabel the toggle.)
 */
export function currentLang(): Lang {
  return isLang(i18n.language) ? i18n.language : DEFAULT_LANG;
}

/** The chosen language, re-rendering on every switch. */
export function useLang(): Lang {
  const { i18n: inst } = useTranslation();
  return isLang(inst.language) ? inst.language : DEFAULT_LANG;
}

/* ─────────────────────── non-React translation ─────────────────────── */

/**
 * Plain t for modules outside React. Reads the live language at call time, so
 * call it when the text is needed (in a render, an error handler) and never at
 * module top level, where it would run once, before i18n starts, in English.
 * Use "ns:key" for anything outside the default "shell" namespace.
 */
export const t: typeof i18n.t = ((...args: Parameters<typeof i18n.t>) => i18n.t(...args)) as typeof i18n.t;

/** A t bound to one namespace that follows the live language. Safe to create at module scope. */
export function getT(ns: Namespace) {
  return i18n.getFixedT(null, ns);
}

/**
 * Marks a string literal as a translation key without translating it, for
 * constants built at module scope (row labels, tab lists, app registries).
 * Translate at render: t(LABELS[id]). i18n:check verifies every tKey('...')
 * exists in the file's namespace, which it can't do for a bare string.
 */
export function tKey<K extends string>(key: K): K {
  return key;
}

/* ──────────────────────────── formatting ──────────────────────────── */

/**
 * Dates and times in the active language: "Oct 1, 2026" / "2026年10月1日".
 * Money and token amounts are NOT localised — keep "$1,234.56" and "0.25 ETH"
 * exactly as the English UI formats them (README.md "Numbers").
 */
export function formatDate(d: Date | number, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat(currentLang(), opts).format(d);
}

export function formatDateTime(d: Date | number, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }): string {
  return new Intl.DateTimeFormat(currentLang(), opts).format(d);
}

export { i18n };
export default i18n;
