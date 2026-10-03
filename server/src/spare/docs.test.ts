/**
 * docs/MCP_TOOLS.md against the tools: every argument a tool declares, and
 * every alias its handler accepts (checked by calling the handler), is named
 * in that tool's section; the keeper limits the doc quotes are the mirror's
 * (keeperRules.ts); the keeper fields the reads return are documented. A
 * checkout without docs/ (the API deployed on its own) skips this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./reads.js', () => {
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      seen.calls.push([name, ...args]);
      return { name };
    };
  return {
    readUniverse: rec('universe'),
    readAccount: rec('account'),
    readQuote: rec('quote'),
    readActivity: rec('activity'),
    readContracts: rec('contracts'),
    readFees: rec('fees'),
  };
});
vi.mock('./replay.js', () => ({
  MAX_REPLAY_DAYS: 30,
  replayRoundUps: async (q: unknown) => {
    seen.calls.push(['replay', q]);
    return { mode: 'wallet' };
  },
}));

import { SPARE_ENGINE_TOOLS, clearSpareCaches } from './tools.js';
import { KEEPER_QUOTE_TOLERANCE_BPS } from './book.js';
import { KEEPER_QUOTE_MAX_SHORTFALL_BPS, KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS, KEEPER_SWEEP_MAX_IMPACT_BPS } from './keeperRules.js';

const DOC = fileURLToPath(new URL('../../../docs/MCP_TOOLS.md', import.meta.url));
const HAVE_DOC = existsSync(DOC);
const doc = HAVE_DOC ? readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n') : '';

/** The text of `### \`<tool>\`` up to the next heading or rule. */
function section(tool: string): string {
  const start = doc.indexOf(`### \`${tool}\``);
  expect(start, `docs/MCP_TOOLS.md has a ### \`${tool}\` section`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + 4);
  const end = rest.search(/\n(### |---)/);
  return end < 0 ? rest : rest.slice(0, end);
}
const tool = (name: string) => SPARE_ENGINE_TOOLS.find((t) => t.name === name)!;
const ADDR = '0x7e57000000000000000000000000000000000001';

/** Aliases each handler accepts, by the argument they stand for. */
const ALIASES: Record<string, Record<string, string[]>> = {
  spare_account: { address: ['account', 'wallet'] },
  spare_quote: { asset: ['symbol'], usdgIn: ['usdg', 'usdg_in', 'amount'] },
  spare_activity: { address: ['account', 'wallet'] },
  spare_roundup_preview: { amountUsd: ['amount', 'amount_usd'], roundTo: ['round_to'], weeklyCapUsd: ['weekly_cap_usd'], wallet: ['address', 'account'] },
};

beforeEach(() => {
  clearSpareCaches();
  seen.calls = [];
});

describe.skipIf(!HAVE_DOC)('docs/MCP_TOOLS.md matches the tools', () => {
  it('every declared argument is named in its tool section', () => {
    for (const t of SPARE_ENGINE_TOOLS) {
      const s = section(t.name);
      for (const p of t.params) expect(s, `${t.name}: \`${p.name}\``).toContain(`\`${p.name}\``);
    }
  });

  it('every alias the handlers accept reaches the read, and is documented', async () => {
    // Behaviour first: each alias is really accepted.
    // (Caches cleared per call: identical reads are otherwise shared.)
    for (const k of ['address', 'account', 'wallet']) {
      clearSpareCaches();
      await tool('spare_account').handler({ [k]: ADDR });
      await tool('spare_activity').handler({ [k]: ADDR });
    }
    for (const k of ['asset', 'symbol']) await tool('spare_quote').handler({ [k]: 'SPY' });
    for (const k of ['usdgIn', 'usdg', 'usdg_in', 'amount']) await tool('spare_quote').handler({ asset: 'SPY', [k]: '7' });
    expect(seen.calls.filter((c) => c[0] === 'account').map((c) => c[1])).toEqual([ADDR, ADDR, ADDR]);
    expect(seen.calls.filter((c) => c[0] === 'activity').map((c) => (c[1] as { address: unknown }).address)).toEqual([ADDR, ADDR, ADDR]);
    expect(seen.calls.filter((c) => c[0] === 'quote').map((c) => [c[1], c[2]])).toEqual([
      ['SPY', undefined],
      ['SPY', undefined],
      ['SPY', '7'],
      ['SPY', '7'],
      ['SPY', '7'],
      ['SPY', '7'],
    ]);
    const rp = tool('spare_roundup_preview');
    for (const k of ['amount', 'amount_usd']) {
      expect(await rp.handler({ [k]: '3.75', round_to: 5 })).toMatchObject({ mode: 'single', payment: { usd: '3.75' }, rule: { roundTo: 5 } });
    }
    expect(await rp.handler({ amounts: '3.75,12.40', weekly_cap_usd: '0.5' })).toMatchObject({ mode: 'amounts', cappedTotalUsd: '0.5' });
    for (const k of ['wallet', 'address', 'account']) {
      clearSpareCaches();
      await rp.handler({ [k]: ADDR });
    }
    expect(seen.calls.filter((c) => c[0] === 'replay').map((c) => (c[1] as { wallet: unknown }).wallet)).toEqual([ADDR, ADDR, ADDR]);

    // Then the doc names every one in that tool's section.
    for (const [name, byArg] of Object.entries(ALIASES)) {
      const s = section(name);
      for (const alias of Object.values(byArg).flat()) expect(s, `${name}: alias \`${alias}\``).toContain(`\`${alias}\``);
    }
  });

  it("the keeper limits the doc quotes are the mirror's", () => {
    const num = (name: string) => Number(new RegExp(String.raw`\`${name}\` (\d+)`).exec(doc)?.[1]);
    expect(num('QUOTE_ORACLE_ALLOWANCE_BPS')).toBe(KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS);
    expect(num('SWEEP_MAX_IMPACT_BPS')).toBe(KEEPER_SWEEP_MAX_IMPACT_BPS);
    expect(num('QUOTE_MAX_SHORTFALL_BPS')).toBe(KEEPER_QUOTE_MAX_SHORTFALL_BPS);
    expect(num('QUOTE_TOLERANCE_BPS')).toBe(KEEPER_QUOTE_TOLERANCE_BPS);
    expect(doc).toContain(`pool fee + ${KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS} bps`);
    expect(doc).toContain(
      `min(pool fee + ${KEEPER_QUOTE_ORACLE_ALLOWANCE_BPS} + ${KEEPER_SWEEP_MAX_IMPACT_BPS}, ${KEEPER_QUOTE_MAX_SHORTFALL_BPS}) bps`,
    );
  });

  it('the keeper fields the reads return are documented where they appear', () => {
    const quote = section('spare_quote');
    for (const f of ['keeperOutcome', 'wouldHold', 'keeperChecks', 'quoteVsOracle', 'multiplierChange', 'reference', 'fullSize', 'allowanceBps', 'lpFee', 'dynamicFee']) {
      expect(quote, `spare_quote: ${f}`).toContain(f);
    }
    const account = section('spare_account');
    for (const f of ['keeperWouldSweepNow', 'keeperSweepsAlone', 'keeperOutcome', 'reason', 'quoteCheck', 'waitReason', 'waitingFor']) {
      expect(account, `spare_account: ${f}`).toContain(f);
    }
    const universe = section('spare_universe');
    for (const f of ['buyableNow', 'keeperState', 'waitReason', 'multiplierChange', 'feePct', '"dynamic"', 'lpFee', '8388608']) {
      expect(universe, `spare_universe: ${f}`).toContain(f);
    }
  });
});
