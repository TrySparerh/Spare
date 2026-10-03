import { describe, expect, it } from 'vitest';
import { PUBLIC_TABS, isCurrentTab, publicTabsFor } from './publicTabs';
import { SPARE_RISKS, splitRiskLead } from './risks';

describe('public tabs', () => {
  it('is the public tab list, in order', () => {
    expect(PUBLIC_TABS.map((t) => t.to)).toEqual([
      '/docs', '/universe', '/dispatch', '/datalayer', '/devtools', '/mcp', '/roadmap', '/whitepaper',
    ]);
  });
  it('is the same eight tabs on every spec page', () => {
    for (const t of PUBLIC_TABS) expect(publicTabsFor(t.to)).toEqual([...PUBLIC_TABS]);
  });
  it('appends Buyback / Flywheel as a ninth tab only on those pages', () => {
    expect(publicTabsFor('/buyback').map((t) => t.label)).toEqual([...PUBLIC_TABS.map((t) => t.label), 'Buyback']);
    expect(publicTabsFor('/flywheel/').at(-1)).toEqual({ label: 'Flywheel', to: '/flywheel' });
    expect(publicTabsFor('/terms')).toHaveLength(8);
  });
  it('highlights the current page (trailing slash tolerant)', () => {
    expect(isCurrentTab({ label: 'MCP', to: '/mcp' }, '/mcp/')).toBe(true);
    expect(isCurrentTab({ label: 'MCP', to: '/mcp' }, '/docs')).toBe(false);
  });
});

describe('risks (Docs §risks = Terms §Risks)', () => {
  it('carries the owner-decision audit and admin-key wording', () => {
    expect(SPARE_RISKS[0]).toContain('reviewed and fork-tested');
    expect(SPARE_RISKS[0]).toContain('no third-party audit has been published');
    expect(SPARE_RISKS[1]).toContain('no multisig and no timelock');
  });
  it('splits the bold lead phrase', () => {
    expect(splitRiskLead('Keeper. If the keeper stops.')).toEqual({ lead: 'Keeper.', rest: 'If the keeper stops.' });
    expect(splitRiskLead('no lead')).toEqual({ lead: '', rest: 'no lead' });
  });
});
