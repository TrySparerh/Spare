#!/usr/bin/env node
// Supply-chain pin check (CI job `pins`). No dependencies; Node >= 22.
//
// Fails when anything that decides what code runs in CI, in the engine images,
// in spare-api or in the local infra floats instead of being pinned:
//   - workflow `uses:` must be a full 40-hex commit SHA with a `# vX.Y.Z` comment
//   - every container image (Dockerfile FROM, compose, workflow services) must be
//     pinned by @sha256 digest; the engine images must drop root (USER)
//   - engine and spare-api dependencies (overrides included) must be exact
//     versions; packageManager and .nvmrc exact, and the Dockerfile bun tag must
//     match the engine's packageManager
//   - npm runs no install scripts and has a release cooldown, and package.json
//     warns on an npm too old to honour that cooldown (devEngines); bun has a
//     cooldown too, and every `bun install` in a Dockerfile or workflow passes
//     --ignore-scripts (Bun otherwise runs its default-trusted packages' scripts)
//   - Redis 7.x must be >= 7.4.6 (CVE-2025-49844)
//
// A checkout without .github/workflows (a branch that has not enabled CI yet)
// skips the workflow checks with a notice instead of failing.
//
//   node .github/scripts/check-pins.mjs          # from the repo root
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

const strip = (s) => s.replace(/^["']|["']$/g, "");

/** `uses:` and `image:` lines of a GitHub Actions workflow. */
export function checkWorkflow(text, file) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    const uses = line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(#.*)?$/);
    if (uses) {
      const ref = strip(uses[1]);
      if (ref.startsWith("./")) return;
      if (ref.startsWith("docker://")) {
        if (!DIGEST.test(ref)) out.push(`${at}: ${ref} is not pinned by @sha256 digest`);
        return;
      }
      const [, sha] = ref.split("@");
      if (!sha || !SHA40.test(sha)) out.push(`${at}: ${ref} is not pinned to a full commit SHA`);
      else if (!uses[2] || !/#\s*v?\d+\.\d+\.\d+/.test(uses[2])) {
        out.push(`${at}: ${ref} needs a trailing "# vX.Y.Z" comment naming the pinned release`);
      }
      return;
    }
    const image = line.match(/^\s*(?:-\s+)?image:\s*([^\s#]+)/);
    if (image && !DIGEST.test(strip(image[1]))) {
      out.push(`${at}: image ${strip(image[1])} is not pinned by @sha256 digest`);
    }
  });
  return out;
}

/** FROM lines pinned by digest, and the final USER is not root. */
export function checkDockerfile(text, file, { bunVersion } = {}) {
  const out = [];
  let user = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const from = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
    if (from) {
      const img = from[1];
      if (!DIGEST.test(img)) out.push(`${file}:${i + 1}: FROM ${img} is not pinned by @sha256 digest`);
      const bun = img.match(/^oven\/bun:([^@]+)@/);
      if (bun && bunVersion && !bun[1].startsWith(`${bunVersion}-`) && bun[1] !== bunVersion) {
        out.push(`${file}:${i + 1}: oven/bun:${bun[1]} does not match packageManager bun@${bunVersion}`);
      }
    }
    const u = line.match(/^\s*USER\s+(\S+)/i);
    if (u) user = u[1];
  });
  if (!user) out.push(`${file}: no USER instruction (the image would run as root)`);
  else if (/^(root|0)(:|$)/.test(user)) out.push(`${file}: USER ${user} runs as root`);
  return out;
}

/** docker-compose `image:` pins, plus the Redis CVE-2025-49844 version gate. */
export function checkCompose(text, file) {
  const out = checkWorkflow(text, file).filter((p) => p.includes("image "));
  for (const m of text.matchAll(/^\s*image:\s*["']?redis:(\d+)\.(\d+)\.(\d+)/gm)) {
    const [maj, min, patch] = m.slice(1).map(Number);
    if (maj === 7 && (min < 4 || (min === 4 && patch < 6))) {
      out.push(`${file}: redis ${maj}.${min}.${patch} is below 7.4.6 (CVE-2025-49844)`);
    }
  }
  for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) {
    const tag = m[1].split("@")[0].split(":")[1] ?? "";
    if (!tag || /^latest|(^|-)latest$/.test(tag) || !/\d+\.\d+\.\d+/.test(tag)) {
      out.push(`${file}: image ${m[1].split("@")[0]} needs an exact x.y.z version tag next to its digest`);
    }
  }
  return out;
}

/** Every dependency of a package.json, and every override, is an exact version. */
export function checkExactDeps(pkg, file) {
  const out = [];
  for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[sec] ?? {})) {
      if (!SEMVER.test(spec)) out.push(`${file}: ${sec}.${name} = "${spec}" is not an exact version`);
    }
  }
  // npm / bun overrides: "name": "x.y.z", or a nested object whose "." is the
  // package's own version and whose other keys override its dependencies.
  const overrides = (obj, path) => {
    for (const [name, spec] of Object.entries(obj ?? {})) {
      const at = name === "." ? path : `${path}.${name}`;
      if (spec && typeof spec === "object") overrides(spec, at);
      else if (!SEMVER.test(String(spec))) out.push(`${file}: ${at} = "${spec}" is not an exact version`);
    }
  };
  overrides(pkg.overrides, "overrides");
  return out;
}

/** `packageManager` names the expected tool at an exact version; returns [problems, version]. */
export function checkPackageManager(pkg, file, tool) {
  const m = (pkg.packageManager ?? "").match(/^([a-z]+)@([^+]+)(\+.*)?$/);
  if (!m || m[1] !== tool) return [[`${file}: packageManager must be "${tool}@<x.y.z>"`], null];
  if (!SEMVER.test(m[2])) return [[`${file}: packageManager ${m[1]}@${m[2]} is not an exact version`], null];
  return [[], m[2]];
}

/** npm older than this ignores .npmrc's min-release-age, so package.json must warn about it. */
export const MIN_NPM = "11.10.0";

const atLeast = (version, min) => {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

/**
 * devEngines.packageManager: npm, at least MIN_NPM, onFail "warn". An older npm
 * still installs, builds and tests (a fresh clone must work on the npm most
 * people have) but says that it skips the release cooldown. "error" would stop
 * it outright; npm's default when onFail is left out is "error".
 */
export function checkDevEngines(pkg, file) {
  const pm = pkg.devEngines?.packageManager;
  if (!pm || Array.isArray(pm) || pm.name !== "npm") {
    return [`${file}: devEngines.packageManager { name: "npm", version: ">=${MIN_NPM}", onFail: "warn" } is missing`];
  }
  const out = [];
  const floor = String(pm.version ?? "").match(/^(?:>=|\^)?\s*(\d+\.\d+\.\d+)$/);
  if (!floor || !atLeast(floor[1], MIN_NPM)) {
    out.push(`${file}: devEngines npm version "${pm.version}" must be >=${MIN_NPM} (older npm ignores min-release-age)`);
  }
  if (pm.onFail !== "warn") out.push(`${file}: devEngines npm onFail must be "warn", not "${pm.onFail ?? "error (the default)"}"`);
  return out;
}

/** Every `bun install` (or `bun i`) command passes --ignore-scripts. */
export function checkBunInstall(text, file) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let cmd = lines[i];
    // A shell line continued with a trailing backslash is one command.
    while (/\\\s*$/.test(cmd) && i + 1 < lines.length) cmd = cmd.replace(/\\\s*$/, " ") + lines[++i];
    if (/^\s*#/.test(cmd)) continue;
    cmd = cmd.replace(/\s#.*$/, "");
    if (/\bbun\s+(?:install|i)\b/.test(cmd) && !/(?:^|\s)--ignore-scripts(?:\s|$)/.test(cmd)) {
      out.push(`${file}:${start + 1}: bun install without --ignore-scripts (Bun runs its default-trusted packages' install scripts)`);
    }
  }
  return out;
}

export function checkNvmrc(text, file) {
  const v = text.trim().replace(/^v/, "");
  return SEMVER.test(v) ? [] : [`${file}: "${text.trim()}" is not an exact x.y.z Node version`];
}

export function checkNpmrc(text, file) {
  const out = [];
  const kv = Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/[#;].*$/, "").trim())
      .filter(Boolean)
      .map((l) => l.split("=").map((s) => s.trim())),
  );
  if (kv["ignore-scripts"] !== "true") out.push(`${file}: ignore-scripts=true is missing`);
  if (!(Number(kv["min-release-age"]) >= 1)) out.push(`${file}: min-release-age (days, >= 1) is missing`);
  return out;
}

export function checkBunfig(text, file) {
  const m = text.match(/^\s*minimumReleaseAge\s*=\s*(\d+)/m);
  return m && Number(m[1]) >= 86_400 ? [] : [`${file}: [install] minimumReleaseAge (seconds, >= 86400) is missing`];
}

/**
 * Runs every check against the repository at `root` and returns the problems.
 * `onNotice` hears what was skipped: a checkout without workflows.
 */
export function checkRepo(root, { onNotice = () => {} } = {}) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const json = (p) => JSON.parse(read(p));
  const out = [];

  const wfDir = join(root, ".github", "workflows");
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (!workflows.length) onNotice(".github/workflows: no workflows in this checkout; action pins and CI installs not checked");
  for (const f of workflows) {
    const text = read(`.github/workflows/${f}`);
    out.push(...checkWorkflow(text, `.github/workflows/${f}`), ...checkBunInstall(text, `.github/workflows/${f}`));
  }

  const engine = json("engine/package.json");
  out.push(...checkExactDeps(engine, "engine/package.json"));
  const [bunProblems, bunVersion] = checkPackageManager(engine, "engine/package.json", "bun");
  out.push(...bunProblems);
  for (const f of ["engine/Dockerfile", "engine/Dockerfile.keeper"]) {
    const text = read(f);
    out.push(...checkDockerfile(text, f, { bunVersion }), ...checkBunInstall(text, f));
  }
  out.push(...checkBunfig(read("engine/bunfig.toml"), "engine/bunfig.toml"));

  // The site (root) and spare-api (server/) are separate npm projects.
  const site = json("package.json");
  out.push(...checkPackageManager(site, "package.json", "npm")[0], ...checkDevEngines(site, "package.json"));
  out.push(...checkNvmrc(read(".nvmrc"), ".nvmrc"));
  out.push(...checkNpmrc(read(".npmrc"), ".npmrc"));

  const api = json("server/package.json");
  out.push(...checkExactDeps(api, "server/package.json"));
  out.push(...checkPackageManager(api, "server/package.json", "npm")[0], ...checkDevEngines(api, "server/package.json"));
  out.push(...checkNvmrc(read("server/.nvmrc"), "server/.nvmrc"));
  out.push(...checkNpmrc(read("server/.npmrc"), "server/.npmrc"));

  out.push(...checkCompose(read("infra/docker-compose.yml"), "infra/docker-compose.yml"));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const problems = checkRepo(root, { onNotice: (n) => console.log(`pin: notice: ${n}`) });
  for (const p of problems) console.error(`pin: ${p}`);
  if (problems.length) {
    console.error(`\n${problems.length} unpinned or unsafe item(s).`);
    process.exit(1);
  }
  console.log("pins ok: actions by SHA, images by digest, engine and spare-api deps exact, toolchains exact, install scripts off, release cooldowns on");
}
