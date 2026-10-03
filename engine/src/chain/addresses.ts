/**
 * SPARE deployment address book.
 *
 * The contracts deploy writes contracts/addresses/<chainId>.json. Until that
 * file exists (or while it is partial, malformed, for another chain, or points
 * at addresses with no bytecode) every chain-dependent endpoint answers
 * `{ available: false, reason }`. Nothing is read from, or reported for, a
 * contract that has no code at its address: a read from an empty address can
 * come back as zero, which would pass for a real figure.
 *
 * Accepted shape (flat; PascalCase aliases and a nested `contracts` object are
 * also accepted so a hand-written or forge-script book still loads):
 *   {
 *     "chainId": 4663,
 *     "deployBlock": 76200000,             // first L2 block of the deploy; indexer start
 *     "assetRegistry": "0x…", "ruleRegistry": "0x…", "electionRegistry": "0x…",
 *     "screeningGate": "0x…", "stockRouter": "0x…",  "cashPark": "0x…",
 *     "feeVault": "0x…",      "sweepExecutor": "0x…",
 *     "usdgParkAdapter": "0x…", "sgovParkAdapter": "0x…"   // optional
 *   }
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { env } from "../env.ts";

export const REQUIRED_CONTRACTS = [
  "assetRegistry",
  "ruleRegistry",
  "electionRegistry",
  "screeningGate",
  "stockRouter",
  "cashPark",
  "feeVault",
  "sweepExecutor",
] as const;
export const OPTIONAL_CONTRACTS = ["usdgParkAdapter", "sgovParkAdapter"] as const;

export type RequiredContract = (typeof REQUIRED_CONTRACTS)[number];
export type OptionalContract = (typeof OPTIONAL_CONTRACTS)[number];
export type ContractKey = RequiredContract | OptionalContract;

export type SpareAddresses = Record<RequiredContract, Address> &
  Partial<Record<OptionalContract, Address>> & {
    chainId: number;
    /** First L2 block to index from, if the book records it. */
    deployBlock: bigint | null;
  };

export type AddressBook =
  | { deployed: true; addresses: SpareAddresses; source: string }
  | {
      deployed: false;
      reason: string;
      source: string;
      /** Keys that did resolve, so a partial deploy can say what is missing. */
      present: ContractKey[];
      missing: ContractKey[];
    };

const ZERO = "0x0000000000000000000000000000000000000000";

const ALIASES: Record<ContractKey, string[]> = {
  assetRegistry: ["assetRegistry", "AssetRegistry"],
  ruleRegistry: ["ruleRegistry", "RuleRegistry"],
  electionRegistry: ["electionRegistry", "ElectionRegistry"],
  screeningGate: ["screeningGate", "ScreeningGate"],
  stockRouter: ["stockRouter", "StockRouter"],
  cashPark: ["cashPark", "CashPark"],
  feeVault: ["feeVault", "FeeVault"],
  sweepExecutor: ["sweepExecutor", "SweepExecutor"],
  usdgParkAdapter: ["usdgParkAdapter", "UsdgParkAdapter"],
  sgovParkAdapter: ["sgovParkAdapter", "SgovParkAdapter"],
};

function asAddress(v: unknown): Address | undefined {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) return undefined;
  if (v.toLowerCase() === ZERO) return undefined;
  return getAddress(v);
}

function asBlock(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return BigInt(v);
  return null;
}

/** Pure: validate a parsed JSON address book against the chain we serve. */
export function parseAddressBook(input: unknown, expectedChainId: number, source: string): AddressBook {
  const fail = (reason: string, present: ContractKey[] = [], missing: ContractKey[] = [...REQUIRED_CONTRACTS]): AddressBook => ({
    deployed: false,
    reason,
    source,
    present,
    missing,
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail(`address book ${source} is not a JSON object`);
  }
  const top = input as Record<string, unknown>;
  const nested =
    top.contracts && typeof top.contracts === "object" && !Array.isArray(top.contracts)
      ? (top.contracts as Record<string, unknown>)
      : {};
  const raw = { ...nested, ...top };

  const chainId = typeof raw.chainId === "number" ? raw.chainId : typeof raw.chainId === "string" ? Number(raw.chainId) : NaN;
  if (!Number.isSafeInteger(chainId)) {
    return fail(`address book ${source} has no chainId — refusing to guess which network it describes`);
  }
  if (chainId !== expectedChainId) {
    return fail(`address book ${source} is for chain ${chainId}, but this engine serves chain ${expectedChainId}`);
  }

  const resolved: Partial<Record<ContractKey, Address>> = {};
  const zeroed: string[] = [];
  for (const key of [...REQUIRED_CONTRACTS, ...OPTIONAL_CONTRACTS]) {
    for (const alias of ALIASES[key]) {
      const v = raw[alias];
      if (v === undefined) continue;
      const a = asAddress(v);
      if (a) resolved[key] = a;
      else if (typeof v === "string" && v.toLowerCase() === ZERO) zeroed.push(key);
      break;
    }
  }
  const present = (Object.keys(resolved) as ContractKey[]).sort();
  const missing = REQUIRED_CONTRACTS.filter((k) => !resolved[k]);
  if (missing.length) {
    const why = zeroed.length ? ` (zero address for ${zeroed.join(", ")})` : "";
    return fail(`SPARE not fully deployed on chain ${chainId}: missing ${missing.join(", ")}${why}`, present, missing);
  }
  return {
    deployed: true,
    source,
    addresses: {
      ...(resolved as Record<RequiredContract, Address> & Partial<Record<OptionalContract, Address>>),
      chainId,
      deployBlock: asBlock(raw.deployBlock ?? raw.startBlock ?? raw.deployedAtBlock),
    },
  };
}

/** Resolve ADDRESSES_FILE relative to the engine root (engine/). */
export function resolveAddressesPath(file: string): string {
  return isAbsolute(file) ? file : resolve(import.meta.dir, "../..", file);
}

const fileCache = new Map<string, { mtimeMs: number; book: AddressBook }>();

/** Load from inline JSON (wins) or a file. Never throws. */
export function loadAddressBook(opts: { chainId: number; file: string; json?: string }): AddressBook {
  if (opts.json) {
    try {
      return parseAddressBook(JSON.parse(opts.json), opts.chainId, "ADDRESSES_JSON");
    } catch (err) {
      return {
        deployed: false,
        reason: `ADDRESSES_JSON is not valid JSON: ${(err as Error).message}`,
        source: "ADDRESSES_JSON",
        present: [],
        missing: [...REQUIRED_CONTRACTS],
      };
    }
  }
  const path = resolveAddressesPath(opts.file);
  const notDeployed = (reason: string): AddressBook => ({
    deployed: false,
    reason,
    source: path,
    present: [],
    missing: [...REQUIRED_CONTRACTS],
  });
  try {
    if (!existsSync(path)) {
      return notDeployed(`SPARE is not deployed on chain ${opts.chainId}: no address book at ${path}`);
    }
    const mtimeMs = statSync(path).mtimeMs;
    const key = `${opts.chainId}:${path}`;
    const hit = fileCache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.book;
    const book = parseAddressBook(JSON.parse(readFileSync(path, "utf8")), opts.chainId, path);
    fileCache.set(key, { mtimeMs, book });
    return book;
  } catch (err) {
    return notDeployed(`address book ${path} could not be read: ${(err as Error).message}`);
  }
}

/** The engine's configured address book. */
export function addressBook(): AddressBook {
  return loadAddressBook({ chainId: env.CHAIN_ID, file: env.ADDRESSES_FILE, json: env.ADDRESSES_JSON });
}

// ---------------------------------------------------------------------------
// Bytecode preflight: an address book is a claim; code at the address is the
// evidence. Cached per (client, address) for 5 minutes (a deploy is permanent,
// but a local fork can be restarted underneath us).
// ---------------------------------------------------------------------------
const codeCache = new WeakMap<PublicClient, Map<string, { ok: boolean; at: number }>>();

export async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  let m = codeCache.get(client);
  if (!m) codeCache.set(client, (m = new Map()));
  const hit = m.get(address);
  if (hit && Date.now() - hit.at < 300_000) return hit.ok;
  const code = await client.getCode({ address });
  const ok = Boolean(code && code !== "0x");
  m.set(address, { ok, at: Date.now() });
  return ok;
}

/** Addresses of `keys` if the book has them AND each has bytecode; else why not. */
export async function verifiedContracts<K extends ContractKey>(
  client: PublicClient,
  book: AddressBook,
  keys: readonly K[],
): Promise<{ ok: true; addresses: SpareAddresses } | { ok: false; reason: string }> {
  if (!book.deployed) return { ok: false, reason: book.reason };
  const missing = keys.filter((k) => !book.addresses[k]);
  if (missing.length) {
    return { ok: false, reason: `SPARE ${missing.join(", ")} not in the address book for chain ${book.addresses.chainId}` };
  }
  const checks = await Promise.all(keys.map(async (k) => [k, await hasCode(client, book.addresses[k] as Address)] as const));
  const empty = checks.filter(([, ok]) => !ok).map(([k]) => `${k} (${book.addresses[k]})`);
  if (empty.length) {
    return {
      ok: false,
      reason: `address book ${book.source} names contracts with no bytecode on chain ${book.addresses.chainId}: ${empty.join(", ")}`,
    };
  }
  return { ok: true, addresses: book.addresses };
}
