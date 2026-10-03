/**
 * Pure helpers for /proof (unit-tested in proofLogic.test.ts). Nothing here
 * reads the network: the hooks in useProofData.ts fetch, these functions turn
 * what came back into something the page can state without guessing.
 *
 *   repository links     SPARE_REPO_URL (empty → every repo link hides itself)
 *   Sourcify             parseSourcify: HTTP status + JSON → a verification state
 *   controllers          classifyController: getCode + timelock/Safe probes → kind
 *   hooks                hookPermissions: Uniswap v4 permission bits in an address
 *   API health           parseProofHealth: liveness fields only
 *   formatting           bpsPct, durationParts, blockNo
 */
import type { Address } from 'viem';

/* ───────────────────────────── repository ───────────────────────────── */

/**
 * Spare's public source repository. VITE_SPARE_REPO_URL overrides it at build
 * time; an empty value hides every repo link on /proof (source lines, scripts,
 * the audit report, the clone command).
 */
export const SPARE_REPO_URL: string = ((import.meta.env.VITE_SPARE_REPO_URL as string | undefined) ?? 'https://github.com/TrySparerh/Spare').trim();

/** Branch the source links point at. */
export const SPARE_REPO_BRANCH = 'main';

/** The command that replays the money path on a local mainnet fork ("Run it yourself"). */
export const PROVE_COMMAND = 'npm run prove';

/** Directory name used in the commands when the repo URL is unset (package.json "name"). */
export const DEFAULT_REPO_DIR = 'spare';

/** "https://github.com/a/b.git/" → "https://github.com/a/b"; anything that is not an https URL → null. */
export function normalizeRepoUrl(url: string | null | undefined): string | null {
  const s = (url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!/^https:\/\/[^\s/]+\/\S+$/i.test(s)) return null;
  return s;
}

/**
 * A link to a file (or a directory, path ending in "/") in the repo, with an
 * optional line or line range. null when the repo URL is unset.
 */
export function repoLink(repo: string | null | undefined, path: string, lines?: readonly [number, number?]): string | null {
  const base = normalizeRepoUrl(repo);
  if (!base) return null;
  const clean = path.replace(/^\/+/, '');
  const kind = clean.endsWith('/') || clean === '' ? 'tree' : 'blob';
  const anchor = lines ? (lines[1] && lines[1] !== lines[0] ? `#L${lines[0]}-L${lines[1]}` : `#L${lines[0]}`) : '';
  return `${base}/${kind}/${SPARE_REPO_BRANCH}/${clean.replace(/\/$/, '')}${anchor}`;
}

/** True when SPARE_REPO_URL is a usable https URL (repo links show). */
export function repoIsSet(repo: string | null | undefined = SPARE_REPO_URL): boolean {
  return normalizeRepoUrl(repo) !== null;
}

/** The folder `git clone` creates: the repo's last path segment, or DEFAULT_REPO_DIR. */
export function repoDirName(repo: string | null | undefined): string {
  const base = normalizeRepoUrl(repo);
  const last = base?.split('/').pop();
  return last && /^[\w.-]+$/.test(last) ? last : DEFAULT_REPO_DIR;
}

/** The "Run it yourself" commands. The clone line only exists when the repo URL is set. */
export function runCommands(repo: string | null | undefined, prove: string = PROVE_COMMAND): string[] {
  const base = normalizeRepoUrl(repo);
  return [...(base ? [`git clone --recursive ${base}.git`] : []), `cd ${repoDirName(repo)}`, prove];
}

/* ────────────────────────────── Sourcify ────────────────────────────── */

export type SourcifyKind = 'exact' | 'match' | 'none' | 'unknown';

export interface SourcifyView {
  kind: SourcifyKind;
  /** ISO time Sourcify verified it, when it says. */
  verifiedAt: string | null;
  /** Contract name in the verified source ("SweepExecutor"). */
  name: string | null;
  /** "src/SweepExecutor.sol:SweepExecutor". */
  qualifiedName: string | null;
  /** "0.8.26+commit.8a97fa7a". */
  compilerVersion: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Sourcify v2 `GET /v2/contract/{chainId}/{address}`:
 *   200 + match "exact_match"  → exact
 *   200 + match "match"        → match (bytecode matches, metadata hash differs)
 *   404, or match null         → none (not verified)
 *   anything else / no answer  → unknown
 */
export function parseSourcify(status: number | null, body: unknown): SourcifyView {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const comp = o?.compilation && typeof o.compilation === 'object' ? (o.compilation as Record<string, unknown>) : null;
  const base = {
    verifiedAt: str(o?.verifiedAt),
    name: str(comp?.name),
    qualifiedName: str(comp?.fullyQualifiedName),
    compilerVersion: str(comp?.compilerVersion),
  };
  const match = o?.match;
  if (status === 200 && match === 'exact_match') return { kind: 'exact', ...base };
  if (status === 200 && match === 'match') return { kind: 'match', ...base };
  if (status === 404 || (status === 200 && o && match === null)) return { kind: 'none', ...base };
  return { kind: 'unknown', ...base };
}

/** True for both verification levels. */
export function isVerified(v: Pick<SourcifyView, 'kind'> | null | undefined): boolean {
  return v?.kind === 'exact' || v?.kind === 'match';
}

/** "0.8.26+commit.8a97fa7a" → "0.8.26". */
export function shortCompiler(version: string | null | undefined): string | null {
  const m = /^v?(\d+\.\d+\.\d+)/.exec((version ?? '').trim());
  return m ? m[1] : null;
}

/** Sourcify's page for a verified address. */
export function sourcifyPageUrl(chainId: number, address: string): string {
  return `https://repo.sourcify.dev/${chainId}/${address}`;
}

/** Sourcify's API answer for an address (what the badge reads). */
export function sourcifyApiUrl(chainId: number, address: string): string {
  return `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=compilation.name,compilation.fullyQualifiedName,compilation.compilerVersion`;
}

/* ───────────────────────────── controllers ───────────────────────────── */

export type ControllerKind = 'eoa' | 'timelock' | 'safe' | 'contract' | 'unknown';

export interface ControllerView {
  kind: ControllerKind;
  /** EOA carrying an EIP-7702 delegation (code 0xef0100 ‖ address). Still one key. */
  delegated?: boolean;
  /** TimelockController.getMinDelay(), seconds. */
  minDelaySec?: number;
  /** Safe getThreshold() / getOwners().length. */
  threshold?: number;
  owners?: number;
}

/** EIP-7702 delegation designator: 0xef0100 followed by a 20-byte address. */
export function isDelegationCode(code: string): boolean {
  return /^0xef0100[0-9a-f]{40}$/i.test(code);
}

/**
 * What kind of thing holds a role, from live reads:
 *   code null/undefined (read failed) → unknown
 *   no code ("0x")                    → eoa
 *   7702 delegation code              → eoa (delegated)
 *   answers getMinDelay()             → timelock
 *   answers getThreshold()+getOwners() → safe
 *   any other code                    → contract
 */
export function classifyController(r: {
  code: string | null | undefined;
  minDelay?: bigint | number | null;
  threshold?: bigint | number | null;
  owners?: readonly string[] | null;
}): ControllerView {
  if (r.code == null) return { kind: 'unknown' };
  const code = r.code.trim().toLowerCase();
  if (code === '' || code === '0x') return { kind: 'eoa' };
  if (isDelegationCode(code)) return { kind: 'eoa', delegated: true };
  if (r.minDelay != null) return { kind: 'timelock', minDelaySec: Number(r.minDelay) };
  if (r.threshold != null && r.owners) return { kind: 'safe', threshold: Number(r.threshold), owners: r.owners.length };
  return { kind: 'contract' };
}

/* ───────────────────────────── role reads ───────────────────────────── */

export interface OwnedRow {
  name: string;
  owner: Address | null;
  pendingOwner: Address | null;
  pauser: Address | null;
  paused: boolean | null;
  /** isKeeper(keeper). */
  keeper: boolean | null;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const lc = (a: string | null | undefined) => (a ? a.toLowerCase() : null);

export interface RoleSummary {
  /** The owner every contract reports, or null when they differ / were not read. */
  owner: Address | null;
  /** How many contracts report `owner`. */
  ownerCount: number;
  ownerMixed: boolean;
  pauser: Address | null;
  pauserMixed: boolean;
  /** Contracts with a non-zero pendingOwner (a hand-over in progress). */
  pending: { name: string; address: Address }[];
  /** Contracts reporting paused() = true. */
  paused: string[];
  /** Contracts where isKeeper(keeper) = true. */
  keeperOn: string[];
  /** Rows with every read missing. */
  unread: number;
}

/** The most common non-null value, how often it appears, and whether any read disagreed. */
function consensus(values: (string | null)[]): { value: string | null; count: number; mixed: boolean } {
  const counts = new Map<string, { v: string; n: number }>();
  for (const v of values) {
    if (!v) continue;
    const k = v.toLowerCase();
    const c = counts.get(k);
    if (c) c.n += 1;
    else counts.set(k, { v, n: 1 });
  }
  let best: { v: string; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return { value: best?.v ?? null, count: best?.n ?? 0, mixed: counts.size > 1 };
}

export function summarizeRoles(rows: readonly OwnedRow[]): RoleSummary {
  const o = consensus(rows.map((r) => r.owner));
  const p = consensus(rows.map((r) => r.pauser));
  return {
    owner: o.mixed ? null : (o.value as Address | null),
    ownerCount: o.count,
    ownerMixed: o.mixed,
    pauser: p.mixed ? null : (p.value as Address | null),
    pauserMixed: p.mixed,
    pending: rows
      .filter((r) => r.pendingOwner && lc(r.pendingOwner) !== ZERO)
      .map((r) => ({ name: r.name, address: r.pendingOwner as Address })),
    paused: rows.filter((r) => r.paused === true).map((r) => r.name),
    keeperOn: rows.filter((r) => r.keeper === true).map((r) => r.name),
    unread: rows.filter((r) => r.owner == null && r.pauser == null && r.paused == null && r.keeper == null).length,
  };
}

/* ───────────────────────────── v4 hooks ───────────────────────────── */

/**
 * Uniswap v4 hook permissions live in the lowest 14 bits of the hook's
 * address (v4-core Hooks.sol). Names are the Hooks.Permissions fields.
 */
export const HOOK_FLAGS: readonly (readonly [bit: number, name: string, returnsDelta: boolean])[] = [
  [13, 'beforeInitialize', false],
  [12, 'afterInitialize', false],
  [11, 'beforeAddLiquidity', false],
  [10, 'afterAddLiquidity', false],
  [9, 'beforeRemoveLiquidity', false],
  [8, 'afterRemoveLiquidity', false],
  [7, 'beforeSwap', false],
  [6, 'afterSwap', false],
  [5, 'beforeDonate', false],
  [4, 'afterDonate', false],
  [3, 'beforeSwapReturnDelta', true],
  [2, 'afterSwapReturnDelta', true],
  [1, 'afterAddLiquidityReturnDelta', true],
  [0, 'afterRemoveLiquidityReturnDelta', true],
];

export interface HookPermissions {
  flags: string[];
  /** Any *ReturnDelta flag: the hook can change swap or liquidity amounts. */
  returnsDelta: boolean;
}

export function hookPermissions(address: string): HookPermissions {
  let low = 0;
  try {
    low = Number(BigInt(address) & 0x3fffn);
  } catch {
    return { flags: [], returnsDelta: false };
  }
  const flags: string[] = [];
  let returnsDelta = false;
  for (const [bit, name, delta] of HOOK_FLAGS) {
    if (low & (1 << bit)) {
      flags.push(name);
      if (delta) returnsDelta = true;
    }
  }
  return { flags, returnsDelta };
}

export function isZeroAddress(a: string | null | undefined): boolean {
  return !a || /^0x0{40}$/i.test(a);
}

/* ───────────────────────────── API health ───────────────────────────── */

/** Liveness fields of spare-api `/health`. Keeper and wallet details are deliberately not read. */
export interface ProofHealth {
  ok: boolean;
  version: string | null;
  block: number | null;
  rpcOk: boolean | null;
  contractsDeployed: boolean | null;
  paused: boolean | null;
  /** US-equities 24/5 session open, as the API's market gate sees it. */
  sessionOpen: boolean | null;
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Only a document that says `service: "spare-api"` counts; anything else is "not the Spare API". */
export function parseProofHealth(j: unknown): ProofHealth | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (o.service !== 'spare-api') return null;
  const market = o.market && typeof o.market === 'object' ? (o.market as Record<string, unknown>) : null;
  const block = typeof o.block === 'number' && Number.isFinite(o.block) ? o.block : typeof o.block === 'string' && /^\d+$/.test(o.block) ? Number(o.block) : null;
  return {
    ok: o.ok === true || o.status === 'ok',
    version: str(o.version),
    block,
    rpcOk: bool(o.rpcOk),
    contractsDeployed: bool(o.contractsDeployed),
    paused: bool(o.paused),
    sessionOpen: market ? bool(market.sessionOpen) : null,
  };
}

/* ───────────────────────────── universe ───────────────────────────── */

export interface BandGroup {
  bandBps: number;
  symbols: string[];
}

/** Active assets grouped by oracle band, widest group first (unread bands are skipped). */
export function bandGroups(assets: readonly { symbol: string; active: boolean; bandBps?: number | null }[]): BandGroup[] {
  const m = new Map<number, string[]>();
  for (const a of assets) {
    if (!a.active || a.bandBps == null || !Number.isFinite(a.bandBps)) continue;
    const list = m.get(a.bandBps) ?? [];
    list.push(a.symbol);
    m.set(a.bandBps, list);
  }
  return [...m.entries()].map(([bandBps, symbols]) => ({ bandBps, symbols })).sort((a, b) => b.symbols.length - a.symbols.length || a.bandBps - b.bandBps);
}

/** OracleGuard status counts: 0 = OK, anything else = not OK, null = not read. */
export function oracleCounts(statuses: readonly (number | null | undefined)[]): { ok: number; notOk: number; unread: number } {
  let ok = 0;
  let notOk = 0;
  let unread = 0;
  for (const s of statuses) {
    if (s == null) unread += 1;
    else if (s === 0) ok += 1;
    else notOk += 1;
  }
  return { ok, notOk, unread };
}

/* ───────────────────────────── formatting ───────────────────────────── */

/** 25 → "0.25%", 150 → "1.50%", 1000 → "10.00%". */
export function bpsPct(bps: number | bigint | null | undefined): string {
  if (bps == null) return '—';
  const n = Number(bps);
  if (!Number.isFinite(n)) return '—';
  return `${(n / 100).toFixed(2)}%`;
}

/** Block numbers with en-US grouping: 76221269 → "76,221,269". */
export function blockNo(n: number | bigint | null | undefined): string {
  if (n == null) return '—';
  return (typeof n === 'bigint' ? n : BigInt(Math.trunc(n))).toLocaleString('en-US');
}

export type DurationParts = { unit: 'h'; h: number } | { unit: 'hm'; h: number; m: number } | { unit: 's'; s: number };

/** Seconds → whole hours ("48 h", "24 h") when exact, else hours + minutes, else seconds. */
export function durationParts(sec: number | bigint): DurationParts {
  const s = Math.max(0, Math.trunc(Number(sec)));
  if (s >= 3600 && s % 3600 === 0) return { unit: 'h', h: s / 3600 };
  if (s >= 60 && s % 60 === 0) return { unit: 'hm', h: Math.floor(s / 3600), m: (s % 3600) / 60 };
  return { unit: 's', s };
}
