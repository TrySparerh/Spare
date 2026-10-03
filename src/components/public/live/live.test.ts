import { describe, expect, it } from 'vitest';
import { edgePct, fmtEdge, fmtFeedPrice, fmtPoolFee } from './format';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SPARE_MCP_ENDPOINT, SPARE_MCP_TOOLS, parseSpareCatalog, parseSpareHealth } from './spareApi';
import { EXTERNAL_CONTRACTS, KEEPER, OWNER, REFERENCE_FEEDS, SPARE_CONTRACTS, stockFeedEntries } from './addressBook';

describe('format', () => {
  it('prices a fill against Chainlink', () => {
    // $100 for 0.5 tokens = $200/token vs a $199.42 oracle → +0.29%
    expect(edgePct(100_000_000n, 5n * 10n ** 17n, 19_942n * 10n ** 16n)).toBeCloseTo(0.29, 2);
    // exactly at the oracle
    expect(edgePct(5_000_000n, 10n ** 18n, 5n * 10n ** 18n)).toBe(0);
    expect(edgePct(5_000_000n, 0n, 10n ** 18n)).toBeNull();
    expect(fmtEdge(0.2912)).toBe('+0.29%');
    expect(fmtEdge(-0.05)).toBe('-0.05%');
    expect(fmtEdge(null)).toBe('—');
  });

  it('formats pool fees and feed answers', () => {
    expect(fmtPoolFee(3000)).toBe('0.30%');
    expect(fmtPoolFee(100)).toBe('0.01%');
    expect(fmtPoolFee(10_000)).toBe('1.00%');
    expect(fmtPoolFee(0)).toBe('0.00%');
    expect(fmtPoolFee(0x800000)).toBe('dynamic');
    expect(fmtFeedPrice(66_512_345_678n)).toBe('$665.12');
    expect(fmtFeedPrice(100_010_000n)).toBe('$1.0001');
    expect(fmtFeedPrice(null)).toBe('—');
  });
});

describe('Spare API parsing', () => {
  it('only accepts a spare-api health document', () => {
    expect(parseSpareHealth({ status: 'ok', timestamp: 'x' })).toBeNull();
    expect(parseSpareHealth(null)).toBeNull();
    expect(parseSpareHealth({ ok: true, service: 'spare-api', version: '1.0.0', block: 5, mcp: { tools: 7 } })).toEqual({
      version: '1.0.0',
      block: 5,
      mcpTools: 7,
    });
  });

  it('keeps only the known spare_* tools from any catalog shape', () => {
    const foreign = { tools: [{ name: 'other_status' }, { name: 'other_funding' }] };
    expect(parseSpareCatalog(foreign)).toBeNull();
    const mixed = { tools: [{ name: 'spare_universe' }, { name: 'spare_fees' }, { name: 'other_thing' }] };
    expect([...(parseSpareCatalog(mixed) ?? [])].sort()).toEqual(['spare_fees', 'spare_universe']);
    expect([...(parseSpareCatalog([{ name: 'spare_quote', inputSchema: {} }]) ?? [])]).toEqual(['spare_quote']);
    expect(parseSpareCatalog('nope')).toBeNull();
  });

  it('documents seven read-only tools at the public endpoint', () => {
    expect(SPARE_MCP_TOOLS.map((t) => t.name)).toEqual([
      'spare_universe',
      'spare_account',
      'spare_roundup_preview',
      'spare_quote',
      'spare_activity',
      'spare_contracts',
      'spare_fees',
    ]);
    expect(SPARE_MCP_ENDPOINT).toBe('https://api.trysparerh.com/mcp');
  });

  it("documents each tool's arguments by the names the server declares, optional ones marked", () => {
    // The server's tool definitions are the source of truth for argument names.
    const src = readFileSync(resolve(process.cwd(), 'server/src/spare/tools.ts'), 'utf8');
    const declared = (tool: string) => {
      const start = src.indexOf(`'${tool}',`);
      expect(start, tool).toBeGreaterThan(-1);
      const params = src.slice(start, src.indexOf('async (', start));
      const out = new Map<string, boolean>();
      if (params.includes('[ADDRESS]')) out.set('address', true);
      for (const param of params.split("{ name: '").slice(1)) {
        out.set(param.slice(0, param.indexOf("'")), /required: (true|false)/.exec(param)?.[1] === 'true');
      }
      return out;
    };
    const documented = (args: string) => new Map([...args.matchAll(/\b(\w+)(\?)?:/g)].map((m) => [m[1], m[2] !== '?'] as const));
    for (const tool of SPARE_MCP_TOOLS) {
      expect(documented(tool.args), tool.name).toEqual(declared(tool.name));
    }
  });
});

describe('address book', () => {
  it('lists every deployed contract, role, external and reference feed', () => {
    expect(SPARE_CONTRACTS).toHaveLength(10);
    expect(SPARE_CONTRACTS[0]).toMatchObject({ name: 'SweepExecutor', address: '0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab' });
    expect(OWNER).toBe('0x56B67D71039365083727b661Dbe9Bdb7f7D15189');
    expect(KEEPER).toBe('0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03');
    expect(EXTERNAL_CONTRACTS.map((e) => e.name)).toContain('Uniswap V4Quoter');
    // Only the non-stock reference feeds are fixed; stock feeds come from the registry.
    expect(REFERENCE_FEEDS.map((f) => f.pair)).toEqual(['USDG / USD', 'ETH / USD']);
  });

  it('builds one feed row per registry asset, then the reference feeds', () => {
    const feedA = '0x319724394D3A0e3669269846abE664Cd621f9f6A';
    const rows = stockFeedEntries([
      { symbol: 'AAA', feed: feedA },
      { symbol: 'AAA2', feed: feedA.toLowerCase() as `0x${string}` }, // same proxy twice: one row
      { symbol: 'BBB', feed: null }, // unread entry: skipped
    ]);
    expect(rows.map((r) => r.pair)).toEqual(['AAA / USD', 'USDG / USD', 'ETH / USD']);
    expect(rows[0]).toMatchObject({ symbol: 'AAA', proxy: feedA, hours: 'US equities 24/5' });
  });
});
