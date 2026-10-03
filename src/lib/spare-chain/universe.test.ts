import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { EXTERNAL, forgetAssets, symbolOf } from './addresses';
import { v4QuoterAbi } from './fund-swap';
import {
  assetColor,
  assetKind,
  cleanName,
  filterAssets,
  quoteMany,
  readAssetCatalog,
  readDayChanges,
  shortfallPct,
  sortAssets,
  standbyReason,
  standbyText,
  symbolList,
  DAY_CHANGE_WINDOW_SEC,
  QUOTES_PER_CALL,
} from './universe';

/**
 * Every tokenized asset on Robinhood Chain (token name() with the Robinhood
 * suffix removed) and what it is, from a 2026-10 scan of the chain's token
 * catalog (the list below is the whole result). assetKind must get all of them
 * right with no list of its own.
 */
const CATALOG: [string, 'stock' | 'etf'][] = [
  ["Applied Optoelectronics", 'stock'],
  ["Apple", 'stock'],
  ["Abcellera Biologics", 'stock'],
  ["Adobe", 'stock'],
  ["Aehr", 'stock'],
  ["Advanced Energy", 'stock'],
  ["Astera Labs, Inc.", 'stock'],
  ["Applied Materials", 'stock'],
  ["Ambarella", 'stock'],
  ["AMC Entertainment", 'stock'],
  ["AMD", 'stock'],
  ["Amkor Technology", 'stock'],
  ["Amazon", 'stock'],
  ["Arista", 'stock'],
  ["Applied Digital", 'stock'],
  ["AppLovin", 'stock'],
  ["Arm Holdings plc", 'stock'],
  ["ASML Holding NV", 'stock'],
  ["AST SpaceMobile", 'stock'],
  ["Aurora Innovation", 'stock'],
  ["AeroVironment", 'stock'],
  ["Broadcom", 'stock'],
  ["Axon", 'stock'],
  ["AXT", 'stock'],
  ["Boeing", 'stock'],
  ["Alibaba", 'stock'],
  ["Blackberry", 'stock'],
  ["Bloom Energy", 'stock'],
  ["Vanguard Total Bond Market ETF", 'etf'],
  ["Webull", 'stock'],
  ["Cerebras Systems", 'stock'],
  ["Carnival Corporation", 'stock'],
  ["Constellation Energy", 'stock'],
  ["Celsius", 'stock'],
  ["Ciena", 'stock'],
  ["Clover Health Investments", 'stock'],
  ["Celestica", 'stock'],
  ["CleanSpark", 'stock'],
  ["Coherent", 'stock'],
  ["Coinbase", 'stock'],
  ["Costco", 'stock'],
  ["Circle Internet Group", 'stock'],
  ["Credo Technology Group", 'stock'],
  ["Salesforce", 'stock'],
  ["CrowdStrike Holdings", 'stock'],
  ["CoreWeave", 'stock'],
  ["Cisco Systems", 'stock'],
  ["Cognizant", 'stock'],
  ["Carvana", 'stock'],
  ["Datadog", 'stock'],
  ["Dell", 'stock'],
  ["Trump Media & Technology Group", 'stock'],
  ["DigitalOcean", 'stock'],
  ["Roundhill Memory ETF", 'etf'],
  ["e.l.f. Beauty", 'stock'],
  ["iShares MSCI Taiwan Capped ETF", 'etf'],
  ["iShares MSCI South Korea fund", 'etf'],
  ["Ford Motor", 'stock'],
  ["Fair Isaac", 'stock'],
  ["Figma", 'stock'],
  ["Fiserv", 'stock'],
  ["Comfort Systems", 'stock'],
  ["Fluence Energy", 'stock'],
  ["Firefly Aerospace Inc.", 'stock'],
  ["Fortinet", 'stock'],
  ["Futu Holdings", 'stock'],
  ["General Electric", 'stock'],
  ["GE Vernova", 'stock'],
  ["SPDR Gold Trust", 'etf'],
  ["Corning", 'stock'],
  ["Galaxy Digital Inc.", 'stock'],
  ["GameStop", 'stock'],
  ["Alphabet Class A", 'stock'],
  ["Huntington Ingalls", 'stock'],
  ["Hims & Hers Health", 'stock'],
  ["HP Enterprise", 'stock'],
  ["Howmet Aerospace", 'stock'],
  ["IBM", 'stock'],
  ["ImmunityBio,", 'stock'],
  ["iShares MSCI India ETF", 'etf'],
  ["Infleqtion", 'stock'],
  ["Innodata", 'stock'],
  ["Intel", 'stock'],
  ["Intuit", 'stock'],
  ["IonQ", 'stock'],
  ["IREN Limited", 'stock'],
  ["Jabil Inc.", 'stock'],
  ["J.P. Morgan Exchange-Traded Fund Trust JPMorgan Nasdaq Equity Premium Income ETF", 'etf'],
  ["Johnson & Johnson", 'stock'],
  ["Joby Aviation", 'stock'],
  ["KLA", 'stock'],
  ["Kohls Corporation", 'stock'],
  ["Kratos Defense & Security Solutions", 'stock'],
  ["L3Harris", 'stock'],
  ["Lumentum", 'stock'],
  ["Eli Lilly", 'stock'],
  ["Lockheed", 'stock'],
  ["Lam Research Corp", 'stock'],
  ["Lululemon", 'stock'],
  ["Intuitive Machines", 'stock'],
  ["MongoDB", 'stock'],
  ["Meta Platforms", 'stock'],
  ["Modine", 'stock'],
  ["Monolithic Power Systems", 'stock'],
  ["Moderna", 'stock'],
  ["Marvell Technology", 'stock'],
  ["Microsoft", 'stock'],
  ["Strategy Inc.", 'stock'],
  ["MACOM", 'stock'],
  ["Micron Technology", 'stock'],
  ["MaxLinear", 'stock'],
  ["Tema Space Innovators ETF", 'etf'],
  ["Navan", 'stock'],
  ["Nebius Group", 'stock'],
  ["Cloudflare, Inc. Class A common stock", 'stock'],
  ["Netflix", 'stock'],
  ["Nano Nuclear Energy", 'stock'],
  ["Nokia", 'stock'],
  ["ServiceNow", 'stock'],
  ["Nu", 'stock'],
  ["NVIDIA", 'stock'],
  ["Navitas Semiconductor", 'stock'],
  ["Oklo", 'stock'],
  ["ON Semiconductor", 'stock'],
  ["Onto Innovation", 'stock'],
  ["Oracle", 'stock'],
  ["Ouster", 'stock'],
  ["Everpure", 'stock'],
  ["Palo Alto Networks", 'stock'],
  ["UiPath", 'stock'],
  ["Penguin Solutions", 'stock'],
  ["Pfizer", 'stock'],
  ["Planet Labs", 'stock'],
  ["Palantir Technologies", 'stock'],
  ["POET Technologies", 'stock'],
  ["Powell Industries", 'stock'],
  ["Permian Resources", 'stock'],
  ["Quanta", 'stock'],
  ["D-Wave Quantum Inc. Common Stock", 'stock'],
  ["Qualcomm", 'stock'],
  ["Quantinuum Inc. Class A", 'stock'],
  ["Invesco QQQ", 'etf'],
  ["Quantum Computing", 'stock'],
  ["Roblox", 'stock'],
  ["Red Cat", 'stock'],
  ["Reddit", 'stock'],
  ["Redwire", 'stock'],
  ["Rigetti Computing", 'stock'],
  ["Rivian Automotive", 'stock'],
  ["Rocket Lab Corporation", 'stock'],
  ["Sunrun", 'stock'],
  ["Robinhood Ventures Fund I", 'etf'],
  ["EchoStar", 'stock'],
  ["Schwab US Dividend Equity ETF", 'etf'],
  ["iShares 0-3 Month Treasury Bond", 'etf'],
  ["Shopify", 'stock'],
  ["iShares 1-3 Year Treasury Bond ETF", 'etf'],
  ["Silicon Motion", 'stock'],
  ["SK hynix Inc. American Depositary Shares", 'stock'],
  ["SELLAS Life Sciences", 'stock'],
  ["iShares Silver Trust", 'etf'],
  ["Super Micro Computer", 'stock'],
  ["VanEck Semiconductor ETF", 'etf'],
  ["NuScale Power", 'stock'],
  ["Snap", 'stock'],
  ["Sandisk Corporation", 'stock'],
  ["Snowflake", 'stock'],
  ["SoFi Technologies", 'stock'],
  ["SoundHound AI", 'stock'],
  ["iShares Semiconductor ETF", 'etf'],
  ["Space Exploration Technologies Corp. Class A Common Stock", 'stock'],
  ["Invesco S&P 500 Momentum ETF", 'etf'],
  ["SPDR S&P 500 ETF Trust", 'etf'],
  ["T1 Energy", 'stock'],
  ["Atlassian Corporation", 'stock'],
  ["Tempus AI", 'stock'],
  ["Teradyne", 'stock'],
  ["Tower Semiconductor", 'stock'],
  ["Tesla", 'stock'],
  ["Taiwan Semiconductor Manufacturing", 'stock'],
  ["Trade Desk", 'stock'],
  ["Take-Two Interactive Software", 'stock'],
  ["United Microelectronics", 'stock'],
  ["UnitedHealth", 'stock'],
  ["UPS", 'stock'],
  ["USA Rare Earth", 'stock'],
  ["United States Oil Fund", 'etf'],
  ["Vicor", 'stock'],
  ["Vertiv", 'stock'],
  ["ViaSat", 'stock'],
  ["Vistra", 'stock'],
  ["Vanguard Morningstar Total Stock Market ETF", 'etf'],
  ["Workday", 'stock'],
  ["Western Digital", 'stock'],
  ["Roundhill Weekly T-Bill ETF", 'etf'],
  ["TeraWulf", 'stock'],
  ["WhiteFiber, Inc.", 'stock'],
  ["State Street Technology Select Sector SPDR ETF", 'etf'],
  ["Xanadu Quantum", 'stock'],
  ["ExxonMobil Holdings Corporation", 'stock'],
  ["Zeta Global", 'stock'],
  ["Zoom", 'stock'],
  ["Zscaler", 'stock'],
];

describe('assetKind', () => {
  it('classifies every tokenized asset on Robinhood Chain from its name alone', () => {
    const wrong = CATALOG.filter(([name, kind]) => assetKind(name) !== kind);
    expect(wrong).toEqual([]);
    expect(CATALOG.length).toBeGreaterThan(200);
  });

  it('treats an unreadable name as a stock', () => {
    expect(assetKind(null)).toBe('stock');
    expect(assetKind('')).toBe('stock');
  });
});

describe('cleanName', () => {
  it('drops the Robinhood token suffix and keeps the issuer name', () => {
    expect(cleanName('Apple • Robinhood Token')).toBe('Apple');
    expect(cleanName('SPDR S&P 500 ETF Trust • Robinhood Token')).toBe('SPDR S&P 500 ETF Trust');
    expect(cleanName('Plain Name')).toBe('Plain Name');
    expect(cleanName(' • Robinhood Token')).toBeNull();
    expect(cleanName(undefined)).toBeNull();
  });
});

describe('assetColor', () => {
  it('is deterministic per ticker (case-insensitive) and a pastel', () => {
    expect(assetColor('ABC')).toBe(assetColor('abc'));
    expect(assetColor('ABC')).toBe(assetColor(' ABC '));
    expect(assetColor('ABC')).toMatch(/^hsl\(\d{1,3} (86|94)% (72|77|82)%\)$/);
  });

  it('keeps tickers that differ by a letter apart', () => {
    const hue = (s: string) => Number(/^hsl\((\d+)/.exec(assetColor(s))![1]);
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    expect(gap(hue('AAA'), hue('AAB'))).toBeGreaterThan(5);
  });

  it('spreads many tickers over many colours', () => {
    const tickers = CATALOG.map((_, i) => `T${i}X`);
    const colours = new Set(tickers.map(assetColor));
    expect(colours.size).toBeGreaterThan(tickers.length * 0.8);
  });
});

describe('standby reasons', () => {
  it('only explain an inactive asset', () => {
    expect(standbyReason({ active: true, bandBps: 150 }, 5)).toBeNull();
    expect(standbyText(null)).toBeNull();
  });

  it('fall back to the pool reason until measured, then say what the pool does', () => {
    expect(standbyReason({ active: false, bandBps: 150 })).toEqual({ code: 'pool' });
    expect(standbyReason({ active: false, bandBps: 150 }, null)).toEqual({ code: 'noQuote' });
    expect(standbyReason({ active: false, bandBps: 150 }, 2.62)).toMatchObject({ code: 'fillOutside', bandPct: 1.5 });
    expect(standbyReason({ active: false, bandBps: 150 }, 1.27)).toMatchObject({ code: 'fillThin' });
    expect(standbyReason({ active: false, bandBps: 150 }, 0.1)).toMatchObject({ code: 'fillOk' });
    expect(standbyText(standbyReason({ active: false, bandBps: 150 }, 2.62))).toContain('2.62%');
    expect(standbyText(standbyReason({ active: false, bandBps: 150 }, 2.62))).toContain('1.5%');
    expect(standbyText(standbyReason({ active: false, bandBps: 150 }))).toMatch(/standby/i);
  });
});

describe('shortfallPct', () => {
  it('is the percent fewer tokens than the oracle price buys', () => {
    // $100 at a $200 oracle = 0.5 tokens; 0.49 tokens out is a 2% shortfall.
    expect(shortfallPct(100_000_000n, 49n * 10n ** 16n, 200n * 10n ** 18n)).toBeCloseTo(2, 6);
    expect(shortfallPct(100_000_000n, 51n * 10n ** 16n, 200n * 10n ** 18n)).toBeCloseTo(-2, 6);
    expect(shortfallPct(100_000_000n, null, 200n * 10n ** 18n)).toBeNull();
    expect(shortfallPct(100_000_000n, 1n, 0n)).toBeNull();
  });
});

describe('filter / sort', () => {
  const list = [
    { token: '0xa1', symbol: 'ZED', name: 'Zed Corp', kind: 'stock' as const, active: true, price: 10 },
    { token: '0xb2', symbol: 'ABC', name: 'Alpha ETF Trust', kind: 'etf' as const, active: true, price: 300 },
    { token: '0xc3', symbol: 'MID', name: 'Middle Inc', kind: 'stock' as const, active: false, price: 50 },
    { token: '0xd4', symbol: 'NOP', name: null, kind: 'stock' as const, active: true, price: null },
  ];
  it('searches ticker, name and address; narrows by kind and state', () => {
    expect(filterAssets(list, { search: 'zed', kind: 'all', state: 'all' }).map((a) => a.symbol)).toEqual(['ZED']);
    expect(filterAssets(list, { search: '$abc', kind: 'all', state: 'all' }).map((a) => a.symbol)).toEqual(['ABC']);
    expect(filterAssets(list, { search: 'inc', kind: 'all', state: 'all' }).map((a) => a.symbol)).toEqual(['MID']);
    expect(filterAssets(list, { search: '0xc', kind: 'all', state: 'all' }).map((a) => a.symbol)).toEqual(['MID']);
    expect(filterAssets(list, { search: '', kind: 'etf', state: 'all' }).map((a) => a.symbol)).toEqual(['ABC']);
    expect(filterAssets(list, { search: '', kind: 'all', state: 'standby' }).map((a) => a.symbol)).toEqual(['MID']);
  });
  it('keeps active first, sorts by the key, and puts missing values last', () => {
    expect(sortAssets(list, 'symbol').map((a) => a.symbol)).toEqual(['ABC', 'NOP', 'ZED', 'MID']);
    expect(sortAssets(list, 'price', { price: (a) => a.price }).map((a) => a.symbol)).toEqual(['ABC', 'ZED', 'NOP', 'MID']);
    expect(sortAssets(list, 'gap', { gap: (a) => (a.symbol === 'ZED' ? -3 : a.symbol === 'ABC' ? 1 : null) }).map((a) => a.symbol)).toEqual([
      'ZED',
      'ABC',
      'NOP',
      'MID',
    ]);
  });
  it('abbreviates long ticker lists', () => {
    expect(symbolList(['A', 'B'], 3)).toBe('A B');
    expect(symbolList(['A', 'B', 'C', 'D', 'E'], 2)).toBe('A B +3');
    expect(symbolList(['A', 'B', 'C'], 1, ', ')).toBe('A, +2');
  });
});

/* ------------------------------ chain readers ------------------------------ */

const aggregate3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const key = (c1: Address = TOKEN) => ({
  currency0: EXTERNAL.USDG,
  currency1: c1,
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000' as Address,
});

describe('quoteMany', () => {
  it('batches every quote through Multicall3 in chunks and maps results back in order', async () => {
    const calls: number[] = [];
    const client = {
      call: async ({ data }: { data: Hex }) => {
        const { args } = decodeFunctionData({ abi: aggregate3Abi, data });
        const batch = args[0] as readonly { callData: Hex }[];
        calls.push(batch.length);
        const results = batch.map((c, i) => {
          const q = decodeFunctionData({ abi: v4QuoterAbi, data: c.callData });
          const amount = (q.args[0] as { exactAmount: bigint }).exactAmount;
          // Every third quote fails, like a pool that reverts.
          return i % 3 === 2
            ? { success: false, returnData: '0x' as Hex }
            : { success: true, returnData: encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [amount * 2n, 100_000n] }) };
        });
        return { data: encodeFunctionResult({ abi: aggregate3Abi, functionName: 'aggregate3', result: results }) };
      },
    };
    const n = QUOTES_PER_CALL + 5;
    const reqs = Array.from({ length: n }, (_, i) => ({ poolKey: key(), usdgIn: BigInt(i + 1) }));
    // A pool that doesn't hold USDG is never sent.
    reqs.push({ poolKey: { ...key(), currency0: TOKEN, currency1: '0x00000000000000000000000000000000000000bb' }, usdgIn: 1n });
    const out = await quoteMany(client as never, reqs);
    expect(calls).toEqual([QUOTES_PER_CALL, 5]);
    expect(out).toHaveLength(n + 1);
    expect(out[0]).toBe(2n);
    expect(out[1]).toBe(4n);
    expect(out[2]).toBeNull();
    expect(out[n]).toBeNull();
  });

  it('loses only a failed chunk', async () => {
    const client = { call: async () => Promise.reject(new Error('rate limited')) };
    expect(await quoteMany(client as never, [{ poolKey: key(), usdgIn: 1n }])).toEqual([null]);
  });
});

describe('readAssetCatalog', () => {
  it('reads the registry and names its tokens, with no list of its own', async () => {
    forgetAssets();
    const tokens = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2'] as Address[];
    const asset = (t: Address, active: boolean, hooks: Address) => ({
      token: t,
      feed: '0x00000000000000000000000000000000000000f1',
      feedDecimals: 8,
      heartbeat: 86_400,
      bandBps: 150,
      active,
      poolKey: { ...key(t), hooks },
    });
    const client = {
      readContract: async () => tokens,
      multicall: async () => [
        { status: 'success', result: asset(tokens[0], true, '0x0000000000000000000000000000000000000000') },
        { status: 'success', result: 'AAA' },
        { status: 'success', result: 'Alpha Holdings • Robinhood Token' },
        { status: 'success', result: asset(tokens[1], false, '0x00000000000000000000000000000000000000c0') },
        { status: 'success', result: 'BBB' },
        { status: 'success', result: 'Beta Bond ETF • Robinhood Token' },
      ],
    };
    const cat = await readAssetCatalog(client as never);
    expect(cat.map((a) => [a.symbol, a.name, a.kind, a.active, a.hooked, a.index])).toEqual([
      ['AAA', 'Alpha Holdings', 'stock', true, false, 0],
      ['BBB', 'Beta Bond ETF', 'etf', false, true, 1],
    ]);
    expect(symbolOf(tokens[1])).toBe('BBB');
    forgetAssets();
  });
});

describe('readDayChanges', () => {
  it('compares the latest print with the newest one at least ~20h older', async () => {
    const FEED = '0x00000000000000000000000000000000000000f1' as Address;
    const latestAt = 1_000_000;
    const rid = 100n;
    // Rounds every 4h, price +1 per round back from 200.
    const round = (back: bigint) => [rid - back, (200n - back) * 10n ** 8n, 0n, BigInt(latestAt - Number(back) * 4 * 3600), rid - back] as const;
    const client = {
      multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly bigint[] }[] }) =>
        contracts.map((c) => ({ status: 'success', result: c.functionName === 'latestRoundData' ? round(0n) : round(rid - (c.args![0] as bigint)) })),
    };
    const m = await readDayChanges(client as never, [FEED]);
    const c = m.get(FEED.toLowerCase())!;
    // 20h window at 4h rounds -> 5 rounds back (price 195 -> 200).
    expect(c.spanSec).toBe(5 * 4 * 3600);
    expect(c.spanSec).toBeGreaterThanOrEqual(DAY_CHANGE_WINDOW_SEC);
    expect(c.pct).toBeCloseTo((200 / 195 - 1) * 100, 6);
  });
});

