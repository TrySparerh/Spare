/**
 * Chinese typefaces, loaded only while Chinese is the active language.
 *
 * Press Start 2P, Silkscreen, Jersey 10 and Space Mono have no CJK glyphs, so
 * Chinese text falls through each Holo font stack to a CJK face. holo.css
 * redefines the four stacks under html[lang='zh-CN'] / html[lang='zh-TW'] to
 * insert these aliases right after the Latin faces:
 *
 *   'Spare CJK Display'  HoloTitle headlines (after Press Start 2P)
 *                          Noto Sans SC/TC Black (900). zh-CN used to use ZCOOL QingKe
 *                          HuangYou, but at the sizes titles really render (18–24px, less
 *                          on phones) its 入 reads as 几/八 and 库 购 笔 smear, so both
 *                          scripts now share the same clean, heavy face.
 *   'Spare CJK Chrome'   title bars, buttons, menus, desktop labels (after Jersey 10)
 *                          Noto Sans SC/TC Bold at 80%: Jersey 10 runs small (its caps
 *                          are 0.54em), so full-size CJK would tower over the Latin.
 *   'Spare CJK Text'     body copy, values, eyebrows (after Space Mono / Silkscreen)
 *                          Noto Sans SC/TC Regular + Bold, matched to the requested weight.
 *
 * Google's stylesheet is fetched (it is CORS-enabled) and its @font-face rules
 * are re-declared under the alias names. That lets each role pick its own
 * weight and size-adjust without touching the English stacks, and keeps
 * Google's unicode-range slicing: a page downloads only the slices holding
 * the characters it actually shows (a few hundred KB, not a 10 MB font).
 *
 * Two hosts serve the same files: fonts.googleapis.com (gstatic.com) and
 * Google's own China endpoint fonts.googleapis.cn (gstatic.cn), which mainland
 * China can reach and the rest of the world can too. zh-CN asks the .cn host
 * first (its readers are mostly in the mainland, where the .com host is
 * blocked and a request to it just hangs); zh-TW asks .com first. Each host
 * gets FONT_CSS_TIMEOUT_MS before the next one is tried, so a blocked host
 * costs a few seconds, not a stalled request.
 *
 * English visitors never run this. If both hosts fail the stacks fall back
 * quietly to the system Chinese fonts named after the aliases (PingFang,
 * Microsoft YaHei / JhengHei, Noto Sans CJK, Source Han Sans).
 */
import type { Lang } from './languages';

type Zh = Exclude<Lang, 'en'>;

interface AliasRule {
  /** Family name the Holo stacks use. */
  alias: 'Spare CJK Display' | 'Spare CJK Chrome' | 'Spare CJK Text';
  /** Google family + weight the glyphs come from. */
  family: string;
  weight: number;
  /**
   * The @font-face font-weight descriptor. A static face answers '1 1000' (any
   * request matches, no faux bold). A variable face (Google serves Noto as one
   * file for all weights) gets the exact weight: the descriptor clamps the
   * wght axis, so the role draws at that weight whatever the element asks for.
   */
  answers: string;
  sizeAdjust?: string;
}

export interface FontHost {
  /** css2 API endpoint. */
  css: string;
  /** Origin the woff2 slices come from (for the preconnect hint). */
  files: string;
}

export const FONT_HOSTS = {
  google: { css: 'https://fonts.googleapis.com/css2', files: 'https://fonts.gstatic.com' },
  /** Google Fonts' China endpoint: same API and files, reachable from the mainland. */
  googleCn: { css: 'https://fonts.googleapis.cn/css2', files: 'https://fonts.gstatic.cn' },
} as const satisfies Record<string, FontHost>;

/** How long one host gets to answer the stylesheet request before the next is tried. */
export const FONT_CSS_TIMEOUT_MS = 4000;

/** Hosts to try, in order, for a Chinese language. */
export function cjkFontHosts(lang: Zh): FontHost[] {
  return lang === 'zh-CN' ? [FONT_HOSTS.googleCn, FONT_HOSTS.google] : [FONT_HOSTS.google, FONT_HOSTS.googleCn];
}

export const CJK_FONT_PLAN: Record<Zh, { families: string[]; rules: AliasRule[] }> = {
  'zh-CN': {
    families: ['Noto+Sans+SC:wght@400;700;900'],
    rules: [
      // Noto comes as ONE variable file for every weight; an exact descriptor
      // pins the wght axis, so a title set at weight 400 still draws Black and
      // Chrome text set at 400 still draws Bold.
      { alias: 'Spare CJK Display', family: 'Noto Sans SC', weight: 900, answers: '900', sizeAdjust: '106%' },
      { alias: 'Spare CJK Chrome', family: 'Noto Sans SC', weight: 700, answers: '700', sizeAdjust: '80%' },
      { alias: 'Spare CJK Text', family: 'Noto Sans SC', weight: 400, answers: '400' },
      { alias: 'Spare CJK Text', family: 'Noto Sans SC', weight: 700, answers: '700' },
    ],
  },
  'zh-TW': {
    families: ['Noto+Sans+TC:wght@400;700;900'],
    rules: [
      { alias: 'Spare CJK Display', family: 'Noto Sans TC', weight: 900, answers: '900', sizeAdjust: '106%' },
      { alias: 'Spare CJK Chrome', family: 'Noto Sans TC', weight: 700, answers: '700', sizeAdjust: '80%' },
      { alias: 'Spare CJK Text', family: 'Noto Sans TC', weight: 400, answers: '400' },
      { alias: 'Spare CJK Text', family: 'Noto Sans TC', weight: 700, answers: '700' },
    ],
  },
};

export function cjkFontCssUrl(lang: Zh, host: FontHost = FONT_HOSTS.google): string {
  return `${host.css}?${CJK_FONT_PLAN[lang].families.map((f) => `family=${f}`).join('&')}&display=swap`;
}

interface GoogleFace {
  family: string;
  weight: number;
  src: string;
  range: string | null;
}

/** Pull the @font-face blocks out of a Google Fonts css2 response. */
export function parseGoogleFaces(css: string): GoogleFace[] {
  const faces: GoogleFace[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const family = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(body)?.[1]?.trim();
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1] ?? 400);
    const src = /src:\s*([^;]+);/.exec(body)?.[1]?.trim();
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? null;
    if (/font-style:\s*italic/.test(body) || !family || !src) continue;
    faces.push({ family, weight, src, range });
  }
  return faces;
}

/** Re-declare Google's faces under the Spare CJK alias names. */
export function aliasFaces(faces: GoogleFace[], rules: AliasRule[]): string {
  const out: string[] = [];
  for (const r of rules) {
    for (const f of faces) {
      if (f.family !== r.family || f.weight !== r.weight) continue;
      out.push(
        `@font-face{font-family:'${r.alias}';font-style:normal;font-weight:${r.answers};font-display:swap;` +
          `src:${f.src};${f.range ? `unicode-range:${f.range};` : ''}${r.sizeAdjust ? `size-adjust:${r.sizeAdjust};` : ''}}`,
      );
    }
  }
  return out.join('\n');
}

const STYLE_ID = (lang: Zh) => `spare-cjk-fonts-${lang}`;
const requested = new Set<Zh>();

/**
 * Make the Chinese faces for `lang` available. Safe to call repeatedly; does
 * nothing for English, outside a browser, or once the faces are in.
 * Resolves when the stylesheet is in place (or failed) — not when every glyph
 * has downloaded; the browser swaps fonts in as slices arrive.
 */
export async function ensureCjkFonts(lang: Lang): Promise<void> {
  if (lang === 'en' || typeof document === 'undefined' || typeof fetch === 'undefined') return;
  if (import.meta.env.MODE === 'test') return; // unit tests never reach Google
  if (requested.has(lang) || document.getElementById(STYLE_ID(lang))) return;
  requested.add(lang);

  const hosts = cjkFontHosts(lang);
  preconnect(hosts[0].files);

  for (const host of hosts) {
    try {
      const css = aliasFaces(parseGoogleFaces(await fetchCss(cjkFontCssUrl(lang, host))), CJK_FONT_PLAN[lang].rules);
      if (!css) throw new Error('no faces');
      const style = document.createElement('style');
      style.id = STYLE_ID(lang);
      style.textContent = css;
      document.head.appendChild(style);
      return;
    } catch {
      // Blocked, slow or down: try the next host.
    }
  }
  // Every host failed: the stacks fall back to system Chinese fonts.
  // Allow a later language switch to try again.
  requested.delete(lang);
}

function preconnect(origin: string): void {
  if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const pre = document.createElement('link');
  pre.rel = 'preconnect';
  pre.href = origin;
  pre.crossOrigin = 'anonymous';
  pre.setAttribute('data-spare-cjk-preconnect', '');
  document.head.appendChild(pre);
}

/**
 * Fetch a stylesheet, giving up if the host has not answered within
 * FONT_CSS_TIMEOUT_MS (a blocked host never does). Once headers arrive the
 * body is allowed to finish, so a slow connection is not cut off mid-download.
 */
async function fetchCss(url: string): Promise<string> {
  const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FONT_CSS_TIMEOUT_MS) : null;
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctrl?.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`fonts ${res.status}`);
  return res.text();
}
