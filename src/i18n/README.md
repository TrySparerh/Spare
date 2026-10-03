# Spare i18n

Spare ships English, 简体中文 (zh-CN) and 繁體中文 (zh-TW), using
[i18next](https://www.i18next.com/) and [react-i18next](https://react.i18next.com/). English is
the source of truth and the fallback for every key: a Chinese value that is missing or empty
shows the English one.

- Chinese terms: [GLOSSARY.md](./GLOSSARY.md) lists the term to use for each concept, plus tone,
  punctuation and Taiwan-vocabulary rules.
- A small, complete example: [`src/components/retro/SpareWelcome.tsx`](../components/retro/SpareWelcome.tsx)
  (and `LanguageToggle.tsx`).
- Checker: `npm run i18n:check` (see [Checking](#checking)).

## Usage

```tsx
import { useTranslation, Trans } from '@/i18n';

export function FundWalletHeader({ min }: { min: string }) {
  const { t } = useTranslation('apps-a');
  return (
    <>
      <HoloTitle>{t('fundWallet.title')}</HoloTitle>          {/* "Fund Wallet" / "钱包充值" */}
      <p>{t('fundWallet.minimum', { amount: min })}</p>      {/* "Minimum {{amount}}" */}
      <button title={t('shell:common.close')}>×</button>     {/* a shared term from shell */}
    </>
  );
}
```

```ts
// Outside React (error decoders, helpers): translate when the text is needed.
import { getT, t, tKey } from '@/i18n';
const tf = getT('apps-a');                 // fixed namespace, follows the live language
export const humanize = (e: unknown) => tf('errors.rejected');
const LABELS = { chain: tKey('bios.rows.chain') } as const;   // keys at module scope…
// …translated at render: t(LABELS.chain)
```

| Export from `@/i18n` | What it is |
|---|---|
| `useTranslation(ns)` / `Trans` | re-exported from react-i18next |
| `t(key, opts?)` | plain t for non-React code; default namespace `shell`, other namespaces via `'apps-a:key'` |
| `getT(ns)` | a t fixed to one namespace that follows the live language; safe to create at module scope |
| `tKey('key')` | identity function that marks a key for `i18n:check`; use it for keys stored in constants |
| `useLang()` / `currentLang()` | the chosen language (`'en' \| 'zh-CN' \| 'zh-TW'`); `useLang` re-renders on a switch |
| `setLanguage(lang)` | switch in place (no reload) and remember it (LanguageToggle does this) |
| `formatDate(d, opts?)` / `formatDateTime(d, opts?)` | dates in the active language |
| `LANGS`, `LANG_OPTIONS`, `NAMESPACES`, `i18n` | constants and the i18next instance |

## Files

```
src/i18n/
  index.ts            i18next setup, the exports above, NAMESPACES
  languages.ts        language codes, detection, localStorage (spare_lang)
  cjkFonts.ts         Chinese web fonts, loaded only while Chinese is active
  load/zh-CN.ts       one lazy chunk per Chinese language (globs locales/zh-*/)
  load/zh-TW.ts
  locales/
    en/<ns>.json      English, bundled with the app
    zh-CN/<ns>.json   Simplified Chinese
    zh-TW/<ns>.json   Traditional Chinese (Taiwan vocabulary)
```

## Namespaces

A namespace is one JSON file per language. Strings are grouped by area of the site, so the keys a
screen uses sit together and each file stays small enough to review in one pass (English is about
2,900 keys in all). Splitting does not change what loads: English bundles every namespace, and
each Chinese language is one lazy chunk holding all of them.

| Namespace | What it holds |
|---|---|
| `shell` | Everything the desktop and the public pages share: BIOS, login, wallet picker, taskbar, Start menu, tray, ticker, window chrome, the public page frame, tabs and footer, 404, the roadmap page, error messages, stock names (`assets.*`). Also the shared terms every namespace may read: `shell:common.*` and `shell:appNames.*`. Default namespace. |
| `apps-a` | The desktop apps that set an account up: Fund Wallet, Link Wallet, Round-Up Rules, Stock Mix, plus collection / consent status and the swap transaction messages they show. |
| `apps-b` | The other desktop apps: Auto-Invest, Spare Balance, Activity, Viewing Key, My Spare, About, Task Manager, Recycle Bin, Roadmap, Stock Desk, After Hours, Portfolio X-Ray; oracle and transaction status labels. |
| `pages-a` | The reading pages: Docs, Whitepaper, Privacy, Terms, the shared risk list (`risks.items.*`) and the English-governs notice for legal pages. |
| `pages-b` | The live data pages: DevTools, Data Layer, Dispatch, Universe, Buyback, Flywheel, MCP, and the live address book and feed they share. |
| `proof` | The /proof page. |

Put a new string in the namespace of the screen that shows it. A term several areas need belongs
in `shell:common.*`. To add a namespace, add its three JSON files and its name to `NAMESPACES` in
`index.ts`.

Not translated: `lib/spare-chain/abis.ts`, contract/function/event names, addresses, and
everything in `contracts/`, `engine/`, `server/`.

## Adding or changing a string

1. Add the English to `locales/en/<ns>.json` under a key (see [Key naming](#key-naming)).
2. Add the `zh-CN` and `zh-TW` values for the same key in the same change, using the glossary terms.
3. Use the key in code: `t('…')`, `<Trans i18nKey="…">`, or `tKey('…')` for a key kept in a constant.
4. Run `npm run i18n:check -- --strict`, then `npx tsc -p tsconfig.app.json --noEmit` and
   `npx vitest run`.
5. Look at the screen in both Chinese variants at 1280 and 375 wide (pick 简体中文 / 繁體中文 in
   the language key, or set `localStorage.spare_lang = 'zh-TW'` and reload). Chinese glyphs are
   taller than Latin ones, so check fixed heights and `nowrap` labels.

Changing English copy means changing both translations too; a stale translation does not show up
as an error.

## Key naming

- Nest by feature, then section, then element, all camelCase: `fundWallet.swap.minReceived`,
  `linkWallet.steps.authorize.title`, `bios.rows.chain`, `docs.fees.p2`.
- The first segment is the component or page (`fundWallet`, `bios`, `docs`). One component
  can hold several; keep each component's keys under its own prefix.
- Keys describe the role, never the English wording (`swap.minReceived`, not
  `swap.minimumReceivedAtSlippage`). Wording changes; keys stay.
- Reuse a key only when the meaning is identical. Two buttons that both say "Save" but save
  different things may share `common.save`; "Cancel" in a dialog and "Cancel" an order should not.
- Keep variants explicit: `status.paused`, `status.pausedByOperator`.
- Don't use `_one` / `_other` / `_zero` suffixes or any other `_`-suffix scheme (see Plurals).

## Where strings go

- **Inside components:** call `t` during render. React re-renders on a language switch.
- **Constants at module scope** (row lists, tab lists, app registries, option arrays): store
  **keys**, not text. Wrap them in `tKey()` so the checker validates them, and translate where
  they render:
  ```ts
  const ROWS = [{ id: 'chain', label: tKey('bios.rows.chain') }];
  // render: t(row.label)
  ```
  Never call `t()` at module top level: it runs once, before i18n starts, in English.
- **Non-React modules** (`errors.ts`, `fund-swap.ts`…): `const tf = getT('apps-a')` at module
  scope is fine; call `tf('…')` inside the function that builds the message.
- **Strings passed to other components** (`<Win98Dialog title=…>`, `buttons=[{ label }]`):
  translate before passing them.
- **`document.title` / effects:** depend on the language so they rerun:
  ```ts
  const lang = useLang();
  useEffect(() => { document.title = t('docs.metaTitle'); }, [lang, t]);
  ```

## Interpolation

`{{name}}` placeholders, filled from the options object. Every placeholder in English must exist in
both translations (the checker enforces it). Move them freely within the Chinese sentence.

```json
"en":    "Applies to {{count}} linked wallets."
"zh-CN": "适用于 {{count}} 个已绑定的钱包。"
```

Pass values already formatted (`formatUsd(x)`, `shortAddr(a)`); don't format inside the JSON.
Interpolated values are not HTML-escaped (React escapes on render), so never build HTML strings.

## Bold, links and code inside a sentence: `<Trans>`

Word order changes in Chinese, so never split a sentence into `t('a') + <b>…</b> + t('b')`.
Keep one key with named tags, and map the tags to elements:

```json
"en":    "Spare charges <b>{{fee}}</b> only when change converts. See the <terms>Terms</terms>.",
"zh-CN": "只有零钱转换时，Spare 才收取 <b>{{fee}}</b>。详见<terms>使用条款</terms>。"
```

```tsx
const { t } = useTranslation('pages-a');
<Trans
  t={t}                                   // always pass your component's t
  i18nKey="docs.fees.body"
  values={{ fee: '0.25%' }}
  components={{ b: <strong />, terms: <Link to="/terms" />, code: <code className="ps-icode" /> }}
/>
```

- Always pass `t={t}` from the component's `useTranslation`. That's what re-renders the
  `Trans` when the language changes.
- Tag names: lowercase letters only (`<b>`, `<em>`, `<a>`, `<terms>`, `<docs>`, `<code>`).
  **Never** name a tag after an HTML void element (`link`, `br`, `img`, `input`, `hr`, `meta`,
  `area`, `base`, `col`, `embed`, `source`, `track`, `wbr`): the parser closes it immediately and
  the link text falls outside the link.
- The same tags must appear in all three languages (the checker compares them).
- Components with their own props (an `<Addr address=… />`, a ticker chip) go in the
  `components` map too: `"Swept into <tok/>"` with `components={{ tok: <TickerChip sym="SPY" /> }}`.

## Numbers, money, dates

- Money and token amounts are **not** localised: keep `$1,234.56`, `0.0003 ETH`, `0.25%`, `2×`
  exactly as the English code formats them (the existing `formatUsd` / `formatToken` helpers).
  Pass the formatted string in as a value.
- Block numbers and counts keep `toLocaleString('en-US')` grouping.
- Dates/times shown to people: `formatDate(d)` / `formatDateTime(d)` from `@/i18n`
  (`Oct 1, 2026` / `2026年10月1日`). US market hours keep "ET".
- Compact durations (`1h 24m`, `3d`): give each unit form its own key with placeholders, e.g.
  `"agoHM": "{{h}}h {{m}}m ago"` → `"{{h}} 小时 {{m}} 分前"`.

## Plurals

Chinese has no plural forms. Don't use i18next's `_one` / `_other` suffixes. Where the English
code picks `wallet` / `wallets` itself, make two plain keys and give both the same Chinese:

```json
"en":    { "walletOne": "{{count}} linked wallet", "walletMany": "{{count}} linked wallets" }
"zh-CN": { "walletOne": "{{count}} 个已绑定的钱包", "walletMany": "{{count}} 个已绑定的钱包" }
```

```ts
t(n === 1 ? 'linkWallet.walletOne' : 'linkWallet.walletMany', { count: n })
```

## Long text and legal pages

- One key per paragraph or list item: `terms.risks.p1`, `terms.risks.p2`, `privacy.device.body`.
  Don't put a whole section in one key, and don't use arrays (`returnObjects`).
- Inline markup inside a paragraph uses `<Trans>` (above).
- Shared copy (risks shown in both Docs and Terms) lives once in pages-a and is read by both.
- **English governs.** When the language isn't English, `LegalDoc` shows
  `pages-a:legal.englishGoverns` at the top of /terms and /privacy:
  > 本页中文译文仅供参考。如中文译文与英文版本有任何不一致，以英文版本为准。
- Legal and risk text uses 您 (glossary §2) and says the same thing as the English: no
  softening, no added promises.

## What not to translate

Glossary §1: the brand `Spare`, `$SPARE`, tokens, tickers, `Robinhood Chain`, product names,
contract/function/event names, addresses, hashes, numbers, URLs and code. Leave these in the
JSON value as-is, inside the Chinese sentence. Keep `translate="no"` on addresses, code and
hashes (it stops a browser's own translator from mangling them).

Not visible text: CSS classes, `data-*` attributes, ids, analytics names, localStorage keys,
`console` output, thrown `Error` messages that are never displayed, test ids.

## Fonts and layout

The pixel fonts have no Chinese glyphs. While Chinese is active, `src/i18n/cjkFonts.ts` loads
Chinese faces from Google Fonts and `holo.css` adds them after the Latin face in each stack, so
Latin and digits keep the pixel look. Components need nothing extra:

| Role (token) | Latin | zh-CN | zh-TW |
|---|---|---|---|
| Display (`FONT_DISPLAY`, HoloTitle) | Press Start 2P | Noto Sans SC Black | Noto Sans TC Black |
| Chrome (`FONT_CHROME`, title bars, buttons) | Jersey 10 | Noto Sans SC Bold at 80% | Noto Sans TC Bold at 80% |
| Pixel (`FONT_PIXEL`, eyebrows, chips) | Silkscreen | Noto Sans SC | Noto Sans TC |
| Text (`FONT_TEXT`, body) | Space Mono | Noto Sans SC | Noto Sans TC |

- Use the font tokens (`FONT_*` or `var(--holo-font-*)`); a hard-coded `fontFamily: 'Space Mono'`
  skips the Chinese fallback.
- `HoloTitle` handles Chinese itself (it lifts CJK runs to the Latin centre line). Pass it plain
  strings. A `size="xs"` title that holds Chinese drops the outline and renders as solid ink in
  the Text face at 13px, because outlined CJK strokes fuse into blobs at that size.
- Chinese runs ~30–50% narrower than the English for the same meaning, but each glyph is taller.
  Check fixed heights (chips, 26px title bars) and `white-space: nowrap` labels at 375 wide.
- Don't letter-space Chinese manually and don't uppercase it (no effect, but it bloats styles).

## Language switching

- First visit: `navigator.languages[0]`: zh-TW / zh-HK / zh-MO / zh-Hant → zh-TW; any other zh →
  zh-CN; everything else → English. An explicit pick is stored in `localStorage.spare_lang`
  (`en` | `zh-CN` | `zh-TW`) and wins from then on.
- `main.tsx` awaits `initI18n()` before the first render: instant for English, and a returning
  Chinese visitor waits only for their language's chunk, so there's no English flash.
- `<html lang>` follows the language (`en`, `zh-CN`, `zh-TW`); CSS keys the Chinese font stacks off it.
- English visitors download no Chinese strings and no Chinese fonts. Each Chinese language is one
  lazy chunk (`load/zh-*.ts`) holding every namespace, fetched on switch.
- `lib/domTranslateGuard.ts` keeps a browser's own page translator (Chrome / Edge / Immersive
  Translate, for visitors in other languages) from crashing React.

## Checking

```
npm run i18n:check                      # everything
npm run i18n:check -- --strict          # warnings fail too (CI runs this)
npm run i18n:check -- --ns apps-a       # one namespace
npm run i18n:check -- --unused          # en keys nothing references
```

It reports keys missing in zh-CN / zh-TW, placeholder or tag mismatches, keys used in code but
missing from English, stale keys, values left identical to English, and hard-coded English left
in files that use i18n. A deliberate English string (a code sample, a proper noun the heuristic
doesn't know) gets `// i18n-ignore` on the same line or the line above (`{/* i18n-ignore */}` in
JSX). Dynamic keys (`` t(`appNames.${id}`) ``) are checked by prefix only, so prefer literal keys.

## Tests

`src/test/setup.ts` starts i18n in English, so component tests keep asserting English text. To test
Chinese: `await act(() => setLanguage('zh-CN'))` (see `src/i18n/i18n.test.ts`).
