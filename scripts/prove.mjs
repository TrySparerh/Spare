#!/usr/bin/env node
// npm run prove — replay Spare's whole money path on a local anvil fork of live
// Robinhood Chain mainnet, against the DEPLOYED contracts, driven by the real
// keeper code, and print PASS/FAIL per check (engine/scripts/prove.ts).
//
// This wrapper only gets the machine ready, then hands over:
//   1. Foundry (anvil, forge) and Bun are installed (PATH, ~/.foundry/bin, ~/.bun/bin)
//   2. the contract libraries (git submodules) are checked out
//   3. the two helper contracts prove runs on the fork are built: the RoundUp
//      harness (contracts/test/unit/RoundUp.t.sol) and MockArbSys
//   4. the engine's dependencies are installed (bun install --frozen-lockfile --ignore-scripts)
//
// Needs no wallet, key or account of yours: every key is generated for the run,
// lives only in memory, and is used only on the local fork. Nothing is ever sent
// to mainnet. Settings (all optional) are documented in engine/scripts/prove.ts.
//
//   npm run prove            # from the repository root
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const ENGINE = join(ROOT, "engine");
const WIN = process.platform === "win32";

const say = (msg) => console.log(`[prove] ${msg}`);
function die(msg) {
  console.error(`[prove] ${msg}`);
  process.exit(2);
}

/**
 * The `name` executable on PATH or in `extra`: { file, shell }. On Windows a
 * real .exe wins, including the one behind an npm-global .cmd shim
 * (<dir>/node_modules/<name>/bin/<name>.exe); a bare .cmd shim needs a shell.
 */
function which(name, extra = []) {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  if (!WIN) {
    for (const d of dirs) if (existsSync(join(d, name))) return { file: join(d, name), shell: false };
    return null;
  }
  for (const d of dirs) if (existsSync(join(d, `${name}.exe`))) return { file: join(d, `${name}.exe`), shell: false };
  for (const d of dirs) {
    if (!existsSync(join(d, `${name}.cmd`))) continue;
    const real = join(d, "node_modules", name, "bin", `${name}.exe`);
    return existsSync(real) ? { file: real, shell: false } : { file: `"${join(d, `${name}.cmd`)}"`, shell: true };
  }
  return null;
}

/** Runs a tool to completion; its output is shown only when it fails (or always, with `show`). */
function run(tool, args, cwd, what, show = false) {
  const r = spawnSync(tool.file, args, { cwd, shell: tool.shell, stdio: show ? "inherit" : "pipe", env: process.env, encoding: "utf8" });
  if (r.error) die(`${what} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    if (!show) process.stderr.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    die(`${what} failed (exit ${r.status})`);
  }
}

const home = homedir();
const anvil = which("anvil", [join(home, ".foundry", "bin")]);
const forge = which("forge", [join(home, ".foundry", "bin")]);
if (!anvil || !forge) {
  die(
    "Foundry (anvil and forge) is not installed or not on PATH.\n" +
      "         Install it from https://getfoundry.sh :  curl -L https://foundry.paradigm.xyz | bash && foundryup --install 1.5.1\n" +
      "         (on Windows, run that in Git Bash or WSL).",
  );
}
const bun = which("bun", [join(home, ".bun", "bin")]);
if (!bun) {
  die(
    "Bun is not installed or not on PATH (the keeper runs on Bun; the engine pins 1.3.14).\n" +
      "         Install it from https://bun.sh :  curl -fsSL https://bun.sh/install | bash\n" +
      '         (Windows PowerShell: powershell -c "irm bun.sh/install.ps1 | iex").',
  );
}
// Children (forge, the run itself) find the same tools.
process.env.PATH = [dirname(anvil.file), process.env.PATH ?? ""].join(delimiter);

const libs = ["lib/forge-std/src/Test.sol", "lib/v4-core/src/PoolManager.sol", "lib/v4-periphery/src/PositionManager.sol"];
const missing = libs.filter((p) => !existsSync(join(CONTRACTS, p)));
if (missing.length) {
  die(
    `the contract libraries are not checked out (missing contracts/${missing[0]}).\n` +
      "         Clone with --recursive, or run:  git submodule update --init --recursive",
  );
}

say("building the helper contracts used on the fork (RoundUp harness, MockArbSys); a no-op when up to date");
run(forge, ["build", "test/unit/RoundUp.t.sol", "test/mocks/MockArbSys.sol"], CONTRACTS, "forge build");
for (const a of ["out/RoundUp.t.sol/RoundUpHarness.json", "out/MockArbSys.sol/MockArbSys.json"]) {
  if (!existsSync(join(CONTRACTS, a))) die(`forge build did not produce contracts/${a}`);
}

if (!existsSync(join(ENGINE, "node_modules", "viem", "package.json"))) {
  say("installing the engine's dependencies (bun install --frozen-lockfile --ignore-scripts)");
  run(bun, ["install", "--frozen-lockfile", "--ignore-scripts"], ENGINE, "bun install", true);
}

const child = spawn(bun.file, ["run", "scripts/prove.ts"], {
  cwd: ENGINE,
  shell: bun.shell,
  stdio: "inherit",
  env: { ...process.env, ANVIL_BIN: anvil.file },
});
// Ctrl-C reaches the child too (same console); it stops its anvil and exits.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {});
child.on("error", (err) => die(`could not start bun: ${err.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
