import { describe, expect, it } from 'vitest';
import {
  bandGroups,
  blockNo,
  bpsPct,
  classifyController,
  durationParts,
  hookPermissions,
  isVerified,
  isZeroAddress,
  normalizeRepoUrl,
  oracleCounts,
  parseProofHealth,
  parseSourcify,
  repoDirName,
  repoLink,
  runCommands,
  shortCompiler,
  sourcifyApiUrl,
  sourcifyPageUrl,
  summarizeRoles,
  type OwnedRow,
} from './proofLogic';

const OWNER = '0x56B67D71039365083727b661Dbe9Bdb7f7D15189';
const OTHER = '0x0000000000000000000000000000000000000001';

describe('repository links', () => {
  it('hide themselves while the repo URL is unset', () => {
    expect(normalizeRepoUrl('')).toBeNull();
    expect(normalizeRepoUrl(undefined)).toBeNull();
    expect(normalizeRepoUrl('not a url')).toBeNull();
    expect(normalizeRepoUrl('http://github.com/a/b')).toBeNull();
    expect(repoLink('', 'contracts/src/CashPark.sol', [162, 168])).toBeNull();
  });

  it('normalise and point at files, lines and folders', () => {
    expect(normalizeRepoUrl(' https://github.com/acme/spare.git/ ')).toBe('https://github.com/acme/spare');
    expect(repoLink('https://github.com/acme/spare', 'contracts/src/CashPark.sol', [162, 168])).toBe(
      'https://github.com/acme/spare/blob/main/contracts/src/CashPark.sol#L162-L168',
    );
    expect(repoLink('https://github.com/acme/spare', '/SECURITY.md', [12])).toBe('https://github.com/acme/spare/blob/main/SECURITY.md#L12');
    expect(repoLink('https://github.com/acme/spare', 'docs/audits/')).toBe('https://github.com/acme/spare/tree/main/docs/audits');
  });

  it('builds the run commands, with the clone line only when the repo is set', () => {
    expect(runCommands('')).toEqual(['cd spare', 'npm run prove']);
    expect(runCommands('https://github.com/acme/example-app')).toEqual([
      'git clone --recursive https://github.com/acme/example-app.git',
      'cd example-app',
      'npm run prove',
    ]);
    expect(runCommands('https://github.com/acme/x', 'make prove')[2]).toBe('make prove');
    expect(repoDirName('https://github.com/acme/example-app.git')).toBe('example-app');
    expect(repoDirName(null)).toBe('spare');
  });
});

describe('Sourcify', () => {
  it('maps the v2 answer to a verification state', () => {
    const body = {
      match: 'match',
      creationMatch: 'match',
      runtimeMatch: 'match',
      verifiedAt: '2026-10-02T06:42:49Z',
      compilation: { name: 'SweepExecutor', fullyQualifiedName: 'src/SweepExecutor.sol:SweepExecutor', compilerVersion: '0.8.26+commit.8a97fa7a' },
    };
    const v = parseSourcify(200, body);
    expect(v).toEqual({
      kind: 'match',
      verifiedAt: '2026-10-02T06:42:49Z',
      name: 'SweepExecutor',
      qualifiedName: 'src/SweepExecutor.sol:SweepExecutor',
      compilerVersion: '0.8.26+commit.8a97fa7a',
    });
    expect(isVerified(v)).toBe(true);
    expect(parseSourcify(200, { ...body, match: 'exact_match' }).kind).toBe('exact');
  });

  it('never calls an unanswered or unverified address verified', () => {
    expect(parseSourcify(404, { match: null, creationMatch: null, runtimeMatch: null }).kind).toBe('none');
    expect(parseSourcify(200, { match: null }).kind).toBe('none');
    expect(parseSourcify(null, null).kind).toBe('unknown');
    expect(parseSourcify(500, { error: 'x' }).kind).toBe('unknown');
    expect(parseSourcify(429, null).kind).toBe('unknown');
    expect(parseSourcify(200, { match: 'something-else' }).kind).toBe('unknown');
    expect(isVerified(parseSourcify(404, {}))).toBe(false);
    expect(isVerified(null)).toBe(false);
  });

  it('formats compiler versions and links', () => {
    expect(shortCompiler('0.8.26+commit.8a97fa7a')).toBe('0.8.26');
    expect(shortCompiler('v0.8.24+commit.e11b9ed9')).toBe('0.8.24');
    expect(shortCompiler(null)).toBeNull();
    expect(sourcifyPageUrl(4663, OWNER)).toBe(`https://repo.sourcify.dev/4663/${OWNER}`);
    expect(sourcifyApiUrl(4663, OWNER)).toMatch(/^https:\/\/sourcify\.dev\/server\/v2\/contract\/4663\/0x56B6.+\?fields=/);
  });
});

describe('controllers', () => {
  it('calls an address without code a single key', () => {
    expect(classifyController({ code: '0x' })).toEqual({ kind: 'eoa' });
    expect(classifyController({ code: '' })).toEqual({ kind: 'eoa' });
    expect(classifyController({ code: `0xef0100${'ab'.repeat(20)}` })).toEqual({ kind: 'eoa', delegated: true });
  });

  it('recognises a timelock, a Safe and anything else', () => {
    expect(classifyController({ code: '0x6080', minDelay: 172_800n })).toEqual({ kind: 'timelock', minDelaySec: 172_800 });
    expect(classifyController({ code: '0x6080', threshold: 2n, owners: [OWNER, OTHER, OTHER] })).toEqual({ kind: 'safe', threshold: 2, owners: 3 });
    expect(classifyController({ code: '0x6080' })).toEqual({ kind: 'contract' });
    // A timelock answer wins over stray Safe-looking reads.
    expect(classifyController({ code: '0x6080', minDelay: 0, threshold: 1n, owners: [OWNER] }).kind).toBe('timelock');
  });

  it('says unknown when the code read failed', () => {
    expect(classifyController({ code: null })).toEqual({ kind: 'unknown' });
    expect(classifyController({ code: undefined, minDelay: 5n })).toEqual({ kind: 'unknown' });
  });
});

describe('role summary', () => {
  const row = (name: string, over: Partial<OwnedRow> = {}): OwnedRow => ({
    name,
    owner: OWNER,
    pendingOwner: '0x0000000000000000000000000000000000000000',
    pauser: OWNER,
    paused: false,
    keeper: false,
    ...over,
  });

  it('finds the common owner, keepers, pauses and pending hand-overs', () => {
    const s = summarizeRoles([row('CashPark', { keeper: true }), row('SweepExecutor', { keeper: true }), row('FeeVault')]);
    expect(s.owner).toBe(OWNER);
    expect(s.ownerCount).toBe(3);
    expect(s.ownerMixed).toBe(false);
    expect(s.pauser).toBe(OWNER);
    expect(s.keeperOn).toEqual(['CashPark', 'SweepExecutor']);
    expect(s.paused).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(s.unread).toBe(0);
  });

  it('flags disagreement, pauses, hand-overs and unread rows', () => {
    const s = summarizeRoles([
      row('A', { owner: OTHER, paused: true, pendingOwner: OTHER }),
      row('B'),
      row('C', { owner: null, pauser: null, paused: null, keeper: null, pendingOwner: null }),
    ]);
    expect(s.owner).toBeNull();
    expect(s.ownerMixed).toBe(true);
    expect(s.paused).toEqual(['A']);
    expect(s.pending).toEqual([{ name: 'A', address: OTHER }]);
    expect(s.unread).toBe(1);
  });

  it('compares owners case-insensitively', () => {
    const s = summarizeRoles([row('A'), row('B', { owner: OWNER.toLowerCase() as `0x${string}` })]);
    expect(s.ownerMixed).toBe(false);
    expect(s.ownerCount).toBe(2);
  });
});

describe('v4 hook permissions', () => {
  it('decodes the permission bits in the hook address', () => {
    // MU and GME hooks pinned in contracts/config/4663.json: beforeInitialize + beforeSwap only.
    expect(hookPermissions('0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080')).toEqual({ flags: ['beforeInitialize', 'beforeSwap'], returnsDelta: false });
    expect(hookPermissions('0x08E52564Bad99E05a694b4809F397edcA417A080')).toEqual({ flags: ['beforeInitialize', 'beforeSwap'], returnsDelta: false });
  });

  it('spots return-delta permissions and handles junk', () => {
    const p = hookPermissions('0x00000000000000000000000000000000000000C8'); // beforeSwap + afterSwap + beforeSwapReturnDelta
    expect(p.flags).toEqual(['beforeSwap', 'afterSwap', 'beforeSwapReturnDelta']);
    expect(p.returnsDelta).toBe(true);
    expect(hookPermissions('nope')).toEqual({ flags: [], returnsDelta: false });
    expect(isZeroAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    expect(isZeroAddress(null)).toBe(true);
    expect(isZeroAddress(OWNER)).toBe(false);
  });
});

describe('API health', () => {
  it('reads liveness fields from a spare-api document only', () => {
    const doc = {
      status: 'ok',
      ok: true,
      service: 'spare-api',
      version: '3.0.0',
      block: 78500197,
      rpcOk: true,
      contractsDeployed: true,
      paused: false,
      market: { sessionOpen: true },
      keeper: { address: OWNER, lastAccruedAt: '2026-10-02T10:23:51.000Z' },
    };
    const h = parseProofHealth(doc);
    expect(h).toEqual({ ok: true, version: '3.0.0', block: 78500197, rpcOk: true, contractsDeployed: true, paused: false, sessionOpen: true });
    // Keeper details are never carried through.
    expect(JSON.stringify(h)).not.toMatch(/lastAccruedAt|0x56B6/);
  });

  it('rejects anything that is not the Spare API', () => {
    expect(parseProofHealth({ status: 'ok' })).toBeNull();
    expect(parseProofHealth(null)).toBeNull();
    expect(parseProofHealth('ok')).toBeNull();
    expect(parseProofHealth({ service: 'spare-api', ok: false, block: 'x' })).toEqual({
      ok: false,
      version: null,
      block: null,
      rpcOk: null,
      contractsDeployed: null,
      paused: null,
      sessionOpen: null,
    });
    expect(parseProofHealth({ service: 'spare-api', status: 'ok', block: '12' })?.block).toBe(12);
  });
});

describe('universe helpers', () => {
  it('groups active assets by oracle band', () => {
    const g = bandGroups([
      { symbol: 'SPY', active: true, bandBps: 150 },
      { symbol: 'NVDA', active: true, bandBps: 150 },
      { symbol: 'SGOV', active: true, bandBps: 100 },
      { symbol: 'INTC', active: false, bandBps: 300 },
      { symbol: 'X', active: true, bandBps: null },
    ]);
    expect(g).toEqual([
      { bandBps: 150, symbols: ['SPY', 'NVDA'] },
      { bandBps: 100, symbols: ['SGOV'] },
    ]);
    expect(bandGroups([])).toEqual([]);
  });

  it('counts oracle statuses', () => {
    expect(oracleCounts([0, 0, 1, null, 4, undefined])).toEqual({ ok: 2, notOk: 2, unread: 2 });
  });
});

describe('formatting', () => {
  it('prints bps as percent', () => {
    expect(bpsPct(25)).toBe('0.25%');
    expect(bpsPct(150n)).toBe('1.50%');
    expect(bpsPct(1000)).toBe('10.00%');
    expect(bpsPct(null)).toBe('—');
  });

  it('prints block numbers with en-US grouping', () => {
    expect(blockNo(76221269)).toBe('76,221,269');
    expect(blockNo(78500197n)).toBe('78,500,197');
    expect(blockNo(null)).toBe('—');
  });

  it('splits durations', () => {
    expect(durationParts(172_800)).toEqual({ unit: 'h', h: 48 });
    expect(durationParts(86_400n)).toEqual({ unit: 'h', h: 24 });
    expect(durationParts(5_400)).toEqual({ unit: 'hm', h: 1, m: 30 });
    expect(durationParts(45)).toEqual({ unit: 's', s: 45 });
    expect(durationParts(0)).toEqual({ unit: 's', s: 0 });
  });
});
