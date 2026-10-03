/**
 * Spare's risk list — ONE source for both places it is published:
 *   · /docs  §risks  (Docs.tsx, "Read this before you link")
 *   · /terms §Risks  (TermsConditions.tsx: the Docs §risks list, verbatim)
 *
 * Owner decisions baked in: the audit wording is "reviewed and fork-tested;
 * no third-party audit has been published", and the single owner key (no
 * multisig, no timelock) is disclosed plainly. The text lives in the pages-a
 * dictionaries (src/i18n/locales/<lang>/pages-a.json, `risks.items.*`), so the
 * two legal texts can never drift apart in any language.
 *
 * Each entry starts with its bold lead phrase, marked `<b>New contracts.</b>`:
 * render it with <Trans t={t} i18nKey={key} components={{ b: <strong /> }} />.
 */
import { tKey } from '@/i18n';
import EN from '@/i18n/locales/en/pages-a.json';

/** The owner / pauser / attestor wallet at launch (a single EOA), from the deployment record. */
export { OWNER as SPARE_OWNER } from '@/components/public/live/addressBook';

/** Translation keys of the risks, in order (pages-a namespace). */
export const SPARE_RISK_KEYS = [
  tKey('pages-a:risks.items.contracts'),
  tKey('pages-a:risks.items.adminKey'),
  tKey('pages-a:risks.items.keeper'),
  tKey('pages-a:risks.items.market'),
  tKey('pages-a:risks.items.liquidity'),
  tKey('pages-a:risks.items.token'),
  tKey('pages-a:risks.items.regulation'),
  tKey('pages-a:risks.items.noAdvice'),
] as const;

const EN_RISKS: Record<string, string> = EN.risks.items;

/** The English risk text, plain (the governing version; e.g. for tests and plain-text exports). */
export const SPARE_RISKS: readonly string[] = SPARE_RISK_KEYS.map((k) => EN_RISKS[k.slice(k.lastIndexOf('.') + 1)].replace(/<\/?b>/g, ''));

/** "New contracts. Spare's…" → { lead: "New contracts.", rest: "Spare's…" }. */
export function splitRiskLead(text: string): { lead: string; rest: string } {
  const i = text.indexOf('. ');
  if (i < 0) return { lead: '', rest: text };
  return { lead: text.slice(0, i + 1), rest: text.slice(i + 2) };
}
