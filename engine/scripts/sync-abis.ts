#!/usr/bin/env bun
/**
 * sync-abis — regenerate src/chain/abis.ts from the Foundry artifacts.
 *
 *   bun run abis:sync             # reads ../contracts/out, rebuilding if stale
 *   bun run abis:sync --check     # exit 1 if abis.ts differs from the artifacts
 *   CONTRACTS_OUT=/path bun run abis:sync
 *
 * The compiled artifact is the only reliable source of an ABI. Hand-written
 * fragments drift (and calldata built from a drifted one reverts on-chain), so
 * every ABI the engine uses is lifted straight out of contracts/out.
 *
 * Staleness: if any contracts/src/*.sol is newer than its artifact, this runs
 * `forge build` first (Foundry lives in ~/.foundry/bin, which is not on PATH).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface Entry {
  file: string; // artifact directory, e.g. "SweepExecutor.sol"
  contract: string; // artifact basename, e.g. "SweepExecutor"
  exportName: string;
  note: string;
}

export const ENTRIES: Entry[] = [
  { file: "AssetRegistry.sol", contract: "AssetRegistry", exportName: "assetRegistryAbi", note: "eligible universe: tokens(), get(token), isEligible" },
  { file: "RuleRegistry.sol", contract: "RuleRegistry", exportName: "ruleRegistryAbi", note: "ruleOf, walletsOf, accountOf, linkedAt + RuleSet/Linked/Unlinked" },
  { file: "ElectionRegistry.sol", contract: "ElectionRegistry", exportName: "electionRegistryAbi", note: "mixOf, hasOwnMix, defaultMix + MixSet/MixCleared/DefaultMixSet" },
  { file: "ScreeningGate.sol", contract: "ScreeningGate", exportName: "screeningGateAbi", note: "isEligible, clearedUntil, enforced" },
  { file: "StockRouter.sol", contract: "StockRouter", exportName: "stockRouterAbi", note: "oracleStatus, oracleTokensFor/UsdgFor + Bought/Sold" },
  { file: "CashPark.sol", contract: "CashPark", exportName: "cashParkAbi", note: "pending, units, valueOf, adapter, isFresh + Credited/Parked/Exited" },
  { file: "SweepExecutor.sol", contract: "SweepExecutor", exportName: "sweepExecutorAbi", note: "accrue/accrueBatch/sweep + Accrued/AccountSwept/AssetSwept/Delivered/Deferred/SafeSettled" },
  { file: "FeeVault.sol", contract: "FeeVault", exportName: "feeVaultAbi", note: "conversion-fee sink" },
  { file: "UsdgParkAdapter.sol", contract: "UsdgParkAdapter", exportName: "usdgParkAdapterAbi", note: "identity park (launch default)" },
  { file: "SgovParkAdapter.sol", contract: "SgovParkAdapter", exportName: "sgovParkAdapterAbi", note: "SGOV park; NAV from the SGOV feed" },
  { file: "IParkAdapter.sol", contract: "IParkAdapter", exportName: "parkAdapterAbi", note: "generic adapter surface (underlying, valueOf, isFresh)" },
  { file: "IExternal.sol", contract: "IAggregatorV3", exportName: "aggregatorV3Abi", note: "Chainlink feed: decimals, latestRoundData" },
  { file: "IExternal.sol", contract: "IStockToken", exportName: "stockTokenAbi", note: "ERC-8056 stock token: uiMultiplier, paused, oraclePaused" },
  { file: "IAllowanceTransfer.sol", contract: "IAllowanceTransfer", exportName: "permit2Abi", note: "Permit2 allowance(owner, token, spender) / approve" },
  { file: "MockArbSys.sol", contract: "MockArbSys", exportName: "mockArbSysAbi", note: "local-fork stand-in for the ArbSys precompile at 0x64" },
];

const contractsRoot = resolve(import.meta.dir, "../../contracts");
const outDir = process.env.CONTRACTS_OUT ? resolve(process.env.CONTRACTS_OUT) : join(contractsRoot, "out");
export const TARGET = resolve(import.meta.dir, "../src/chain/abis.ts");

function die(message: string): never {
  console.error(`[sync-abis] ${message}`);
  process.exit(1);
}

function forgeBin(): string {
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "forge.exe" : "forge");
  return existsSync(local) ? local : "forge";
}

/** Path of a .sol under `dir` by basename, or null (e.g. a lib interface). */
function findSource(dir: string, file: string): string | null {
  if (!existsSync(dir)) return null;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      const hit = findSource(p, file);
      if (hit) return hit;
    } else if (d.name === file) return p;
  }
  return null;
}

function artifactPath(e: Entry) {
  return join(outDir, e.file, `${e.contract}.json`);
}

/**
 * An artifact is stale if it is missing or older than its OWN source. (Forge
 * does not rewrite artifacts whose source did not change, so comparing against
 * the newest file in src/ would rebuild on every run.)
 */
function isStale(): boolean {
  if (process.env.CONTRACTS_OUT) return false; // explicit artifacts: take as given
  return ENTRIES.some((e) => {
    const p = artifactPath(e);
    if (!existsSync(p)) return true;
    const src = findSource(join(contractsRoot, "src"), e.file) ?? findSource(join(contractsRoot, "test"), e.file);
    return src !== null && statSync(src).mtimeMs > statSync(p).mtimeMs;
  });
}

export function render(): string {
  const blocks: string[] = [];
  for (const e of ENTRIES) {
    const p = artifactPath(e);
    if (!existsSync(p)) die(`missing artifact ${p} — run forge build in contracts/`);
    const artifact = JSON.parse(readFileSync(p, "utf8")) as { abi?: unknown[] };
    if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) die(`${p} has no abi — stale or failed build`);
    blocks.push(
      `/** ${e.contract} — ${e.note}\n *  source: contracts/out/${e.file}/${e.contract}.json */\n` +
        `export const ${e.exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;`,
    );
  }
  const header = `/**
 * =============================================================================
 * AUTO-GENERATED by engine/scripts/sync-abis.ts — DO NOT EDIT BY HAND
 * =============================================================================
 * Lifted verbatim from the Foundry artifacts in contracts/out. To refresh:
 *   export PATH="$HOME/.foundry/bin:$PATH" && (cd contracts && forge build)
 *   cd engine && bun run abis:sync
 * =============================================================================
 */
/* eslint-disable */
`;
  return `${header}\n${blocks.join("\n\n")}\n`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (!existsSync(outDir)) {
    die(`no Foundry artifacts at ${outDir}\n  run: export PATH="$HOME/.foundry/bin:$PATH" && (cd contracts && forge build)`);
  }
  if (!check && isStale()) {
    console.log("[sync-abis] artifacts older than contracts/src — running forge build");
    const r = spawnSync(forgeBin(), ["build"], { cwd: contractsRoot, stdio: "inherit" });
    if (r.status !== 0) die("forge build failed");
  }
  const next = render();
  if (check) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
    if (current !== next) die("src/chain/abis.ts is out of date — run `bun run abis:sync`");
    console.log("[sync-abis] abis.ts is up to date");
  } else {
    writeFileSync(TARGET, next, "utf8");
    console.log(`[sync-abis] wrote ${TARGET}`);
    for (const e of ENTRIES) console.log(`[sync-abis]   ${e.contract} -> ${e.exportName}`);
  }
}
