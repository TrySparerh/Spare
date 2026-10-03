import { render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import i18n, { NAMESPACES, Trans, currentLang, setLanguage, t, getT, tKey, useTranslation } from '@/i18n';
import { LANG_STORAGE_KEY, detectBrowserLang, initialLang, langFromTag, readStoredLang } from './languages';
import { FONT_HOSTS, aliasFaces, cjkFontCssUrl, cjkFontHosts, parseGoogleFaces } from './cjkFonts';
import { SpareWelcome } from '@/components/retro/SpareWelcome';

afterEach(async () => {
  await act(() => setLanguage('en'));
  localStorage.clear();
});

describe('language detection', () => {
  it('maps browser tags to Spare languages', () => {
    expect(langFromTag('en-US')).toBe('en');
    expect(langFromTag('ja')).toBe('en');
    expect(langFromTag('')).toBe('en');
    expect(langFromTag(undefined)).toBe('en');
    expect(langFromTag('zh')).toBe('zh-CN');
    expect(langFromTag('zh-CN')).toBe('zh-CN');
    expect(langFromTag('zh-SG')).toBe('zh-CN');
    expect(langFromTag('zh-Hans-CN')).toBe('zh-CN');
    expect(langFromTag('zh-TW')).toBe('zh-TW');
    expect(langFromTag('zh-HK')).toBe('zh-TW');
    expect(langFromTag('zh-MO')).toBe('zh-TW');
    expect(langFromTag('zh-Hant')).toBe('zh-TW');
    expect(langFromTag('zh_Hant_HK')).toBe('zh-TW');
    expect(langFromTag('zhx')).toBe('en');
  });

  it("uses the browser's first preferred language", () => {
    expect(detectBrowserLang({ language: 'en-US', languages: ['zh-TW', 'en-US'] })).toBe('zh-TW');
    expect(detectBrowserLang({ language: 'zh-CN', languages: [] })).toBe('zh-CN');
    expect(detectBrowserLang(undefined)).toBe('en');
  });

  it('prefers a stored choice and ignores junk', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'zh-TW');
    expect(readStoredLang()).toBe('zh-TW');
    expect(initialLang()).toBe('zh-TW');
    localStorage.setItem(LANG_STORAGE_KEY, 'fr');
    expect(readStoredLang()).toBeNull();
  });
});

describe('i18n runtime', () => {
  it('starts in English with every namespace bundled', () => {
    expect(currentLang()).toBe('en');
    for (const ns of NAMESPACES) expect(i18n.hasResourceBundle('en', ns)).toBe(true);
    expect(t('welcome.title')).toBe('Welcome to Spare');
    expect(getT('pages-a')('legal.englishGoverns')).toMatch(/English version governs/);
    expect(tKey('welcome.title')).toBe('welcome.title');
  });

  it('loads Chinese on demand, switches in place, stores the choice and sets <html lang>', async () => {
    expect(i18n.hasResourceBundle('zh-CN', 'shell')).toBe(false);
    await act(() => setLanguage('zh-CN'));
    expect(currentLang()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh-CN');
    expect(t('welcome.title')).toBe('欢迎来到 Spare');
    expect(t('shell:appNames.recycle-bin')).toBe('回收站');

    await act(() => setLanguage('zh-TW'));
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(t('appNames.recycle-bin')).toBe('資源回收筒');
    expect(t('welcome.spareSoonAria', { tooltip: 'x' })).toBe('$SPARE：即將推出。x');
  });

  it('falls back to English for a key a Chinese file does not have', async () => {
    i18n.addResource('en', 'apps-b', 'test.onlyEnglish', 'Only in English');
    await setLanguage('zh-CN');
    expect(getT('apps-b')('test.onlyEnglish')).toBe('Only in English');
  });

  it('re-renders the reference component on a switch', async () => {
    render(createElement(SpareWelcome, { onSetUp: () => {}, onClose: () => {} }));
    expect(screen.getByRole('button', { name: 'Set up round-ups' })).toBeInTheDocument();
    await act(() => setLanguage('zh-CN'));
    expect(screen.getByRole('button', { name: '设置凑整' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '欢迎来到 Spare' })).toBeInTheDocument();
  });
});

describe('Trans (README pattern for bold / links inside a sentence)', () => {
  it('renders named tags as the given elements, with values', async () => {
    i18n.addResource('en', 'apps-a', 'test.rich', 'Spare charges <b>{{fee}}</b> only when change <a>converts</a>. See <terms>Terms</terms>.');
    i18n.addResource('zh-CN', 'apps-a', 'test.rich', '只有零钱<a>转换</a>时，Spare 才收取 <b>{{fee}}</b>。详见<terms>使用条款</terms>。');
    // The README pattern: Trans gets the component's own t, so the component
    // (subscribed through useTranslation) re-renders it on a language switch.
    // A hook bound to one namespace still reads the shared shell terms by prefix.
    function SharedTerm() {
      const { t: tA } = useTranslation('apps-a');
      return createElement('i', null, tA('shell:common.close'));
    }
    function Fee() {
      const { t: tA } = useTranslation('apps-a');
      return createElement(Trans, {
        t: tA,
        i18nKey: 'test.rich',
        values: { fee: '0.25%' },
        components: { b: createElement('strong'), a: createElement('a', { href: '/docs' }), terms: createElement('a', { href: '/terms' }) },
      });
    }
    const ui = createElement('div', null, createElement(Fee), createElement(SharedTerm));
    const { container } = render(ui);
    expect(container.innerHTML).toBe('<div>Spare charges <strong>0.25%</strong> only when change <a href="/docs">converts</a>. See <a href="/terms">Terms</a>.<i>Close</i></div>');
    await act(() => setLanguage('zh-CN'));
    expect(container.innerHTML).toBe('<div>只有零钱<a href="/docs">转换</a>时，Spare 才收取 <strong>0.25%</strong>。详见<a href="/terms">使用条款</a>。<i>关闭</i></div>');
  });
});

describe('CJK font aliases', () => {
  const css = `/* [0] */
@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosanssc/v1/a.0.woff2) format('woff2');
  unicode-range: U+4e00-4e10, U+3000;
}
@font-face {
  font-family: 'ZCOOL QingKe HuangYou';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/zcool/v1/b.woff2) format('woff2');
  unicode-range: U+4e00;
}`;

  it('parses Google faces and re-declares them per role', () => {
    const faces = parseGoogleFaces(css);
    expect(faces).toHaveLength(2);
    expect(faces[0]).toMatchObject({ family: 'Noto Sans SC', weight: 700, range: 'U+4e00-4e10, U+3000' });
    const out = aliasFaces(faces, [
      { alias: 'Spare CJK Chrome', family: 'Noto Sans SC', weight: 700, answers: '1 1000', sizeAdjust: '80%' },
      { alias: 'Spare CJK Display', family: 'ZCOOL QingKe HuangYou', weight: 400, answers: '1 1000' },
    ]);
    expect(out).toContain("font-family:'Spare CJK Chrome';font-style:normal;font-weight:1 1000");
    expect(out).toContain('size-adjust:80%');
    expect(out).toContain("font-family:'Spare CJK Display'");
    expect(out).toContain('unicode-range:U+4e00;');
  });

  it('asks Google for the right families', () => {
    // zh-CN titles use Noto Sans SC Black, like zh-TW: ZCOOL QingKe HuangYou was illegible at title sizes.
    expect(cjkFontCssUrl('zh-CN')).toContain('family=Noto+Sans+SC:wght@400;700;900');
    expect(cjkFontCssUrl('zh-CN')).not.toContain('ZCOOL');
    expect(cjkFontCssUrl('zh-TW')).toContain('family=Noto+Sans+TC:wght@400;700;900');
    expect(cjkFontCssUrl('zh-TW')).not.toContain('Sans+SC');
  });

  it("tries Google's China endpoint first for zh-CN and keeps both hosts as fallbacks", () => {
    expect(cjkFontHosts('zh-CN')).toEqual([FONT_HOSTS.googleCn, FONT_HOSTS.google]);
    expect(cjkFontHosts('zh-TW')).toEqual([FONT_HOSTS.google, FONT_HOSTS.googleCn]);
    expect(cjkFontCssUrl('zh-CN')).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?/);
    expect(cjkFontCssUrl('zh-CN', FONT_HOSTS.googleCn)).toMatch(/^https:\/\/fonts\.googleapis\.cn\/css2\?family=Noto\+Sans\+SC:wght@400;700;900&/);
  });
});

describe('live-state copy (no frozen numbers or ticker lists)', () => {
  const LANGS = ['en', 'zh-CN', 'zh-TW'] as const;

  it('the Data Layer feeds badge counts the feeds the page lists', async () => {
    for (const lang of LANGS) {
      await act(() => setLanguage(lang));
      const badge = getT('pages-b')('dataLayer.feeds.accent', { n: 38 });
      expect(badge, lang).toContain('38');
      expect(badge.replace('38', ''), lang).not.toMatch(/\d/);
    }
  });

  it('the roadmap does not pin the live stock set or call SGOV inactive', async () => {
    for (const lang of LANGS) {
      await act(() => setLanguage(lang));
      const ab = getT('apps-b');
      const live = [ab('roadmap.phases.s1.stocks'), ab('roadmap.phases.hardening.standby'), ab('roadmap.phases.hardening.treasuryPark')];
      for (const line of live) {
        expect(line, lang).not.toMatch(/^roadmap\./); // the key resolved
        expect(line, lang).not.toMatch(/AAPL|TSLA|\d+ (stocks|只|檔)/);
        expect(line, lang).not.toMatch(/Activate SGOV|启用 SGOV|啟用 SGOV/);
      }
      expect(getT('pages-a')('whitepaper.stages.s1Hardening.line'), lang).not.toMatch(/^whitepaper\.|QQQ|SGOV activation|启用 QQQ|啟用 QQQ/);
      // The launch-day changelog entry stays, marked as history, with the later universe entry after it.
      expect(t('roadmapPage.changelog.universe'), lang).toMatch(/Robinhood Chain/);
    }
  });
});
