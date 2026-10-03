#!/usr/bin/env node
/**
 * i18n-check — keeps the Spare translations complete and consistent. `npm run i18n:check`
 *
 *   1. Locale files: valid JSON, string leaves only.
 *   2. Keys missing in zh-CN / zh-TW vs en, per namespace (an empty string counts
 *      as missing: the app shows English for it).
 *   3. {{placeholders}} and <tags> that differ between en and a translation.
 *   4. Keys used in code (t('…'), <Trans i18nKey="…">, tKey('…')) that are
 *      missing from en.
 *   5. Hard-coded English left in the JSX of migrated files (heuristic; any file
 *      that imports '@/i18n' or 'react-i18next' counts as migrated).
 *
 * Errors: 1–4. Warnings: stale keys (in a translation but not in en), values
 * identical to English, and 5. Exit code 1 on any error (or any warning with
 * --strict).
 *
 * Flags:
 *   --ns <name>     only report this namespace (repeatable): shell, apps-a, apps-b, pages-a, pages-b
 *   --lang <code>   only check this translation (zh-CN or zh-TW)
 *   --strict        warnings fail too
 *   --unused        also list en keys no code references statically
 *   --no-hardcoded  skip the hard-coded-text scan
 *   --quiet         print counts, not every item
 *
 * Silence a deliberate hard-coded string with `// i18n-ignore` on the same line
 * or the line above (JSX: {/* i18n-ignore *\/}).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const LOCALES = path.join(SRC, 'i18n', 'locales');
const SOURCE_LANG = 'en';
const DEFAULT_NS = 'shell';

/* ───────────────────────────── args ───────────────────────────── */

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const many = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]] : []));
const onlyNs = many('--ns');
const onlyLang = many('--lang');
const STRICT = flag('--strict');
const UNUSED = flag('--unused');
const HARDCODED = !flag('--no-hardcoded');
const QUIET = flag('--quiet');

const errors = [];
const warnings = [];
const info = [];
const wantNs = (ns) => onlyNs.length === 0 || onlyNs.includes(ns);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/* ─────────────────────────── locale files ─────────────────────────── */

const langs = fs.readdirSync(LOCALES).filter((d) => fs.statSync(path.join(LOCALES, d)).isDirectory());
if (!langs.includes(SOURCE_LANG)) {
  console.error(`i18n-check: no ${SOURCE_LANG} locale in ${rel(LOCALES)}`);
  process.exit(1);
}
const targets = langs.filter((l) => l !== SOURCE_LANG && (onlyLang.length === 0 || onlyLang.includes(l)));
const namespaces = fs
  .readdirSync(path.join(LOCALES, SOURCE_LANG))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5));

function flatten(obj, prefix, out, file) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, file);
    else errors.push(`${file}: "${key}" must be a string or an object of strings (got ${Array.isArray(v) ? 'array' : typeof v})`);
  }
  return out;
}

/** dict[lang][ns] = Map<key, value> */
const dict = {};
for (const lang of langs) {
  dict[lang] = {};
  for (const ns of namespaces) {
    const file = path.join(LOCALES, lang, `${ns}.json`);
    if (!fs.existsSync(file)) {
      if (lang !== SOURCE_LANG && targets.includes(lang) && wantNs(ns)) errors.push(`${rel(file)}: missing file (copy {} from another language)`);
      dict[lang][ns] = new Map();
      continue;
    }
    try {
      dict[lang][ns] = flatten(JSON.parse(fs.readFileSync(file, 'utf8')), '', new Map(), rel(file));
    } catch (e) {
      errors.push(`${rel(file)}: invalid JSON — ${e.message}`);
      dict[lang][ns] = new Map();
    }
  }
}

const placeholders = (s) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...s.matchAll(/<\/?([\w-]+)\s*\/?>/g)].map((m) => m[0].replace(/\s+/g, '')).sort().join(',');
/** Values that legitimately stay the same in Chinese (brands, tickers, symbols, numbers). */
const SAME_OK = /^[\s\d$%×x.,:;·/+\-–—→←↗▸()[\]#@&!?'"…*_]*$|^(OK|MCP|X|Telegram|Spare|\$SPARE|USDG|ETH|WETH|USDC|SPY|NVDA|AAPL|TSLA|QQQ|SGOV|Permit2|Uniswap( v4)?|Chainlink|Blockscout|MetaMask|Phantom|WalletConnect|MoonPay|Across|Relay|Robinhood Chain|Spare API|RPC|API|ABI|ERC-20|bps|gwei|ET|S[1-4])$/;

for (const ns of namespaces) {
  if (!wantNs(ns)) continue;
  const en = dict[SOURCE_LANG][ns];
  for (const lang of targets) {
    const tr = dict[lang][ns];
    const file = `src/i18n/locales/${lang}/${ns}.json`;
    for (const [key, src] of en) {
      const val = tr.get(key);
      if (val === undefined || val.trim() === '') {
        errors.push(`${file}: missing "${key}"  (en: ${JSON.stringify(src.length > 70 ? src.slice(0, 67) + '…' : src)})`);
        continue;
      }
      if (placeholders(val) !== placeholders(src)) errors.push(`${file}: "${key}" placeholders {{${placeholders(val)}}} ≠ en {{${placeholders(src)}}}`);
      if (tags(val) !== tags(src)) errors.push(`${file}: "${key}" tags [${tags(val)}] ≠ en [${tags(src)}]`);
      if (val === src && !SAME_OK.test(src.trim()) && /[A-Za-z]{3,}/.test(src)) warnings.push(`${file}: "${key}" is identical to English: ${JSON.stringify(src)}`);
    }
    for (const key of tr.keys()) if (!en.has(key)) warnings.push(`${file}: stale "${key}" (not in en)`);
  }
}

/* ─────────────────────────── source scan ─────────────────────────── */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || p === path.join(SRC, 'i18n', 'locales')) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const NS_SOURCES = new Set(['useTranslation', 'getT', 'getFixedT', 'withTranslation']);
const TRANSLATE_ATTRS = new Set(['title', 'aria-label', 'alt', 'placeholder', 'label', 'tooltip', 'description', 'caption', 'hint', 'heading', 'subtitle', 'aria-description', 'aria-placeholder']);
const TRANSLATE_PROPS = new Set(['label', 'title', 'text', 'tooltip', 'description', 'hint', 'caption', 'message', 'placeholder', 'subtitle', 'heading', 'body', 'note', 'cta', 'tagline', 'sub', 'detail', 'summary', 'ariaLabel']);
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp']);
/** Words that are never translated (glossary §1); stripped before deciding a string is English prose. */
const KEEP_WORDS = new Set(
  `Spare SPARE $SPARE USDG ETH WETH USDC SPY NVDA AAPL TSLA QQQ SGOV Robinhood Chain Uniswap v4 Chainlink Permit2 MCP Blockscout MetaMask Phantom WalletConnect Reown MoonPay Across Relay Stargate LayerZero Arbitrum Base Ethereum Spline X Telegram OK ERC RPC API ABI EVM L1 OFT bps gwei ET S1 S2 S3 S4 USD id`.split(/\s+/),
);

const usedKeys = new Map(); // id -> { alts: namespaces the key may live in, key, locs }
const dynamicPrefixes = []; // { ns, prefix, loc }
const hardcoded = [];

function keyNs(raw, fallbackNs) {
  const i = raw.indexOf(':');
  if (i > 0 && namespaces.includes(raw.slice(0, i))) return [raw.slice(0, i), raw.slice(i + 1)];
  return [fallbackNs, raw];
}

function isEnglishProse(text) {
  const words = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/0x[0-9a-fA-F…]+/g, ' ')
    .split(/[^A-Za-z$@\d-]+/)
    .filter(Boolean)
    .filter((w) => !KEEP_WORDS.has(w) && !/\d/.test(w) && !/^[A-Z][a-z]+[A-Z]\w*$/.test(w) && !w.startsWith('@'));
  return words.some((w) => /[A-Za-z]{2,}/.test(w));
}

function ignored(sf, node) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.text.split('\n');
  return /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const migrated = /from ['"](@\/i18n|react-i18next)['"]/.test(text);
  const loc = (n) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  // 1st pass: which names are translate functions, bound to which namespace.
  const tNames = new Map(); // name -> Set(ns)
  const bind = (name, ns) => {
    if (!tNames.has(name)) tNames.set(name, new Set());
    tNames.get(name).add(ns);
  };
  let fileNs = null;
  const nsOfCall = (call) => {
    const callee = call.expression;
    const fn = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (!NS_SOURCES.has(fn)) return null;
    const arg = fn === 'getFixedT' ? call.arguments[1] : call.arguments[0];
    if (!arg) return DEFAULT_NS;
    if (ts.isStringLiteralLike(arg)) return arg.text;
    if (ts.isArrayLiteralExpression(arg) && arg.elements[0] && ts.isStringLiteralLike(arg.elements[0])) return arg.elements[0].text;
    return DEFAULT_NS;
  };
  const visitDecl = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let init = node.initializer;
      while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isCallExpression(init)) {
        const ns = nsOfCall(init);
        if (ns) {
          fileNs ??= ns;
          if (ts.isIdentifier(node.name)) bind(node.name.text, ns);
          else if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
              if (prop === 't' && ts.isIdentifier(el.name)) bind(el.name.text, ns);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(sf);
  fileNs ??= DEFAULT_NS;
  // Plain t / i18n.t imported from '@/i18n' resolve against the default namespace.
  if (/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"]@\/i18n['"]/.test(text) && !tNames.has('t')) bind('t', DEFAULT_NS);

  const record = (raw, nsSet, node) => {
    const [explicit, key] = keyNs(raw, null);
    const alts = explicit ? [explicit] : [...nsSet];
    const id = `${alts.join('|')}:${key}`;
    if (!usedKeys.has(id)) usedKeys.set(id, { alts, key, locs: [] });
    usedKeys.get(id).locs.push(loc(node));
  };
  const recordDynamic = (tpl, nsSet, node) => {
    const head = ts.isTemplateExpression(tpl) ? tpl.head.text : '';
    for (const ns of nsSet) {
      const [kns, prefix] = keyNs(head, ns);
      dynamicPrefixes.push({ ns: kns, prefix: prefix.replace(/\.?[^.]*$/, ''), loc: loc(node) });
    }
  };
  const nsOption = (opts) => {
    if (!opts || !ts.isObjectLiteralExpression(opts)) return null;
    for (const p of opts.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'ns' && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
    }
    return null;
  };

  const visit = (node) => {
    // t('key'), tf('key'), i18n.t('key'), t(['a', 'b']), tKey('key')
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && c.name.text === 't' && ts.isIdentifier(c.expression) && /i18n/.test(c.expression.text) ? 't' : '';
      let nsSet = null;
      if (name === 'tKey') nsSet = new Set([fileNs]);
      else if (name && tNames.has(name)) nsSet = tNames.get(name);
      else if (name === 't' && ts.isPropertyAccessExpression(c)) nsSet = new Set([DEFAULT_NS]);
      if (nsSet && node.arguments.length > 0) {
        const forced = nsOption(node.arguments[1]);
        const set = forced ? new Set([forced]) : nsSet;
        let a = node.arguments[0];
        if (ts.isArrayLiteralExpression(a)) a = a.elements[0];
        if (a && ts.isStringLiteralLike(a)) record(a.text, set, node);
        else if (a && ts.isTemplateExpression(a)) recordDynamic(a, set, node);
      }
    }
    // <Trans i18nKey="key" ns="x" t={t} />
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === 'Trans') {
      let key = null;
      let ns = null;
      let tName = null;
      for (const p of node.attributes.properties) {
        if (!ts.isJsxAttribute(p) || !p.initializer) continue;
        const an = p.name.getText(sf);
        const init = p.initializer;
        const lit = ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression) ? init.expression.text : null;
        if (an === 'i18nKey') key = lit;
        if (an === 'ns') ns = lit;
        if (an === 't' && ts.isJsxExpression(init) && init.expression && ts.isIdentifier(init.expression)) tName = init.expression.text;
      }
      if (key) record(key, ns ? new Set([ns]) : tName && tNames.has(tName) ? tNames.get(tName) : new Set([fileNs]), node);
    }

    if (migrated && HARDCODED) {
      if (ts.isJsxText(node)) {
        const t = node.getText(sf).replace(/\s+/g, ' ').trim();
        const parent = node.parent && (ts.isJsxElement(node.parent) ? node.parent.openingElement.tagName.getText(sf) : '');
        if (t && !CODE_TAGS.has(parent) && isEnglishProse(t) && !ignored(sf, node)) hardcoded.push(`${loc(node)}  ${JSON.stringify(t.slice(0, 90))}`);
      } else if (ts.isJsxAttribute(node) && node.initializer && TRANSLATE_ATTRS.has(node.name.getText(sf))) {
        const init = node.initializer;
        const s = ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression) ? init.expression.text : null;
        if (s && isEnglishProse(s) && !ignored(sf, node)) hardcoded.push(`${loc(node)}  ${node.name.getText(sf)}=${JSON.stringify(s.slice(0, 90))}`);
      } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        const s = node.expression.text;
        if (isEnglishProse(s) && !ignored(sf, node)) hardcoded.push(`${loc(node)}  {${JSON.stringify(s.slice(0, 90))}}`);
      } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && TRANSLATE_PROPS.has(node.name.text) && ts.isStringLiteralLike(node.initializer)) {
        const s = node.initializer.text;
        if (isEnglishProse(s) && !ignored(sf, node)) hardcoded.push(`${loc(node)}  ${node.name.text}: ${JSON.stringify(s.slice(0, 90))}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { file, fileNs, migrated };
}

const scanned = walk(SRC).map(scanFile);

const enHas = (ns, key) => dict[SOURCE_LANG][ns]?.has(key);
const enHasPrefix = (ns, prefix) => !prefix || [...(dict[SOURCE_LANG][ns]?.keys() ?? [])].some((k) => k === prefix || k.startsWith(`${prefix}.`));

for (const { alts, key, locs } of usedKeys.values()) {
  const unknown = alts.filter((a) => !namespaces.includes(a));
  if (unknown.length) {
    for (const l of locs) errors.push(`${l}: unknown namespace "${unknown[0]}" for key "${key}"`);
    continue;
  }
  // A t bound to several namespaces (rare) passes if any of them has the key.
  if (alts.some((a) => enHas(a, key)) || !alts.some(wantNs)) continue;
  for (const l of [...new Set(locs)]) errors.push(`${l}: "${key}" is used in code but missing from src/i18n/locales/en/${alts[0]}.json`);
}
for (const d of dynamicPrefixes) {
  if (wantNs(d.ns) && !enHasPrefix(d.ns, d.prefix)) warnings.push(`${d.loc}: dynamic key prefix "${d.prefix}.*" has no keys in en/${d.ns}.json`);
}
if (dynamicPrefixes.length) info.push(`${dynamicPrefixes.length} dynamic key(s) (template literals) checked by prefix only`);

for (const h of hardcoded) warnings.push(`hard-coded text? ${h}`);

if (UNUSED) {
  const usedSet = new Set([...usedKeys.values()].flatMap((u) => u.alts.map((a) => `${a}:${u.key}`)));
  for (const ns of namespaces) {
    if (!wantNs(ns)) continue;
    for (const key of dict[SOURCE_LANG][ns].keys()) {
      const covered = usedSet.has(`${ns}:${key}`) || dynamicPrefixes.some((d) => d.ns === ns && d.prefix && key.startsWith(`${d.prefix}.`));
      if (!covered) info.push(`unused? ${ns}:${key}`);
    }
  }
}

/* ───────────────────────────── report ───────────────────────────── */

const migratedCount = scanned.filter((s) => s.migrated).length;
const summary = [];
for (const ns of namespaces) {
  if (!wantNs(ns)) continue;
  const n = dict[SOURCE_LANG][ns].size;
  const per = targets.map((l) => {
    const tr = dict[l][ns];
    const done = [...dict[SOURCE_LANG][ns].keys()].filter((k) => (tr.get(k) ?? '').trim() !== '').length;
    return `${l} ${done}/${n}`;
  });
  summary.push(`  ${ns.padEnd(8)} en ${String(n).padStart(4)} keys · ${per.join(' · ')}`);
}

const show = (label, list, max) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length})`);
  for (const line of QUIET ? list.slice(0, 0) : list.slice(0, max)) console.log(`  ${line}`);
  if (!QUIET && list.length > max) console.log(`  … ${list.length - max} more (narrow with --ns)`);
};

console.log(`i18n-check · ${namespaces.length} namespaces · ${migratedCount} migrated source files`);
console.log(summary.join('\n'));
show('ERRORS', errors, 400);
show('WARNINGS', warnings, 300);
show('INFO', info, 200);

const fail = errors.length > 0 || (STRICT && warnings.length > 0);
console.log(`\n${fail ? '✗' : '✓'} ${errors.length} error(s), ${warnings.length} warning(s)${STRICT ? ' [strict]' : ''}`);
process.exit(fail ? 1 : 0);
