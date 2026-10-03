// node --test .github/scripts/check-pins.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkBunInstall,
  checkBunfig,
  checkCompose,
  checkDevEngines,
  checkDockerfile,
  checkExactDeps,
  checkNpmrc,
  checkNvmrc,
  checkPackageManager,
  checkRepo,
  checkWorkflow,
} from "./check-pins.mjs";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIG = "sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04";
const NPM_GATE = { packageManager: { name: "npm", version: ">=11.10.0", onFail: "warn" } };

/** A minimal repository that passes every check; `files` adds or replaces paths. */
function fixtureRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-pins-"));
  const npmProject = (deps) => JSON.stringify({ packageManager: "npm@11.19.0", devEngines: NPM_GATE, dependencies: deps });
  const engineImage = `FROM oven/bun:1.3.14-slim@${DIG}\nRUN bun install --frozen-lockfile --production --ignore-scripts\nUSER bun\n`;
  const all = {
    "package.json": npmProject({ react: "^18.3.1" }), // the site's own ranges are not gated
    ".nvmrc": "24.21.0\n",
    ".npmrc": "ignore-scripts=true\nmin-release-age=3\n",
    "server/package.json": npmProject({ express: "4.22.3" }),
    "server/.nvmrc": "24.21.0\n",
    "server/.npmrc": "ignore-scripts=true\nmin-release-age=3\n",
    "engine/package.json": JSON.stringify({ packageManager: "bun@1.3.14", dependencies: { viem: "2.57.1" } }),
    "engine/Dockerfile": engineImage,
    "engine/Dockerfile.keeper": engineImage,
    "engine/bunfig.toml": "[install]\nminimumReleaseAge = 259200\n",
    "infra/docker-compose.yml": `services:\n  redis:\n    image: redis:7.4.11-alpine@${DIG}\n`,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** checkRepo on a fixture, then removes it; returns the problems and the notices. */
function checkFixture(files) {
  const dir = fixtureRepo(files);
  try {
    const notices = [];
    const problems = checkRepo(dir, { onNotice: (n) => notices.push(n) });
    return { problems, notices };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("workflow actions must be SHA-pinned with a version comment", () => {
  assert.deepEqual(checkWorkflow(`      - uses: actions/checkout@${SHA} # v7.0.1`, "w"), []);
  assert.deepEqual(checkWorkflow("      - uses: ./.github/actions/local", "w"), []);
  assert.match(checkWorkflow("      - uses: actions/checkout@v7", "w")[0], /full commit SHA/);
  assert.match(checkWorkflow("      - uses: actions/checkout@main", "w")[0], /full commit SHA/);
  assert.match(checkWorkflow(`      - uses: actions/checkout@${SHA}`, "w")[0], /# vX\.Y\.Z/);
  assert.match(checkWorkflow("        uses: docker://alpine:3", "w")[0], /digest/);
});

test("workflow service images must be digest-pinned", () => {
  assert.match(checkWorkflow("        image: postgres:16", "w")[0], /not pinned by @sha256/);
  assert.deepEqual(checkWorkflow(`        image: postgres:16.4@${DIG}`, "w"), []);
});

test("Dockerfiles: FROM by digest, non-root USER, bun tag matches packageManager", () => {
  const ok = `FROM oven/bun:1.3.14-slim@${DIG}\nUSER bun\nCMD ["bun"]`;
  assert.deepEqual(checkDockerfile(ok, "D", { bunVersion: "1.3.14" }), []);
  assert.match(checkDockerfile("FROM oven/bun:1.3-slim\nUSER bun", "D").join(), /not pinned/);
  assert.match(checkDockerfile(`FROM oven/bun:1.3.14-slim@${DIG}`, "D").join(), /no USER/);
  assert.match(checkDockerfile(`FROM oven/bun:1.3.14-slim@${DIG}\nUSER root`, "D").join(), /runs as root/);
  assert.match(checkDockerfile(`FROM oven/bun:1.3.14-slim@${DIG}\nUSER 0:0`, "D").join(), /runs as root/);
  assert.match(checkDockerfile(ok, "D", { bunVersion: "1.3.15" }).join(), /does not match packageManager/);
});

test("compose: digest, exact tag, and the Redis CVE-2025-49844 gate", () => {
  assert.deepEqual(checkCompose(`    image: redis:7.4.11-alpine@${DIG}`, "c"), []);
  assert.match(checkCompose("    image: redis:7-alpine", "c").join(), /not pinned/);
  assert.match(checkCompose(`    image: redis:7.4.5-alpine@${DIG}`, "c").join(), /below 7\.4\.6/);
  assert.match(checkCompose(`    image: redis:7.2.10-alpine@${DIG}`, "c").join(), /below 7\.4\.6/);
  assert.match(checkCompose(`    image: timescale/timescaledb:latest-pg16@${DIG}`, "c").join(), /exact x\.y\.z/);
});

test("engine dependencies must be exact", () => {
  assert.deepEqual(checkExactDeps({ dependencies: { viem: "2.57.1" } }, "p"), []);
  assert.match(checkExactDeps({ dependencies: { viem: "^2.57.1" } }, "p")[0], /viem/);
  assert.match(checkExactDeps({ devDependencies: { typescript: "~5.9.3" } }, "p")[0], /typescript/);
  assert.match(checkExactDeps({ dependencies: { zod: "latest" } }, "p")[0], /zod/);
});

test("overrides must be exact too, nested ones included", () => {
  assert.deepEqual(checkExactDeps({ overrides: { esbuild: "0.25.12" } }, "p"), []);
  assert.deepEqual(checkExactDeps({ overrides: { foo: { ".": "1.2.3", bar: "4.5.6" } } }, "p"), []);
  assert.match(checkExactDeps({ overrides: { qs: "^6.16.0" } }, "p")[0], /overrides\.qs = "\^6\.16\.0"/);
  assert.match(checkExactDeps({ overrides: { foo: { bar: "~4.5.6" } } }, "p")[0], /overrides\.foo\.bar/);
});

test("devEngines warns on an npm too old for min-release-age, without stopping it", () => {
  assert.deepEqual(checkDevEngines({ devEngines: NPM_GATE }, "p"), []);
  const pm = (over) => ({ devEngines: { packageManager: { ...NPM_GATE.packageManager, ...over } } });
  assert.deepEqual(checkDevEngines(pm({ version: ">=11.19.0" }), "p"), []);
  assert.match(checkDevEngines({}, "p")[0], /devEngines\.packageManager .* is missing/);
  assert.match(checkDevEngines(pm({ name: "pnpm" }), "p")[0], /is missing/);
  assert.match(checkDevEngines(pm({ version: ">=11.9.0" }), "p")[0], /must be >=11\.10\.0/);
  assert.match(checkDevEngines(pm({ version: ">=10.20.0" }), "p")[0], /must be >=11\.10\.0/);
  assert.match(checkDevEngines(pm({ version: "*" }), "p")[0], /must be >=11\.10\.0/);
  assert.match(checkDevEngines(pm({ onFail: "error" }), "p")[0], /onFail must be "warn", not "error"/);
  assert.match(checkDevEngines(pm({ onFail: "ignore" }), "p")[0], /onFail must be "warn"/);
  assert.match(checkDevEngines(pm({ onFail: undefined }), "p")[0], /onFail must be "warn", not "error \(the default\)"/);
});

test("every bun install passes --ignore-scripts", () => {
  assert.deepEqual(checkBunInstall("RUN bun install --frozen-lockfile --production --ignore-scripts", "D"), []);
  assert.deepEqual(checkBunInstall("        run: bun install --frozen-lockfile --ignore-scripts", "w"), []);
  assert.deepEqual(checkBunInstall("RUN bun install --frozen-lockfile \\\n    --ignore-scripts", "D"), []);
  assert.deepEqual(checkBunInstall("# RUN bun install (a comment)\nRUN bun run build", "D"), []);
  assert.match(checkBunInstall("FROM x\nRUN bun install --frozen-lockfile --production", "D")[0], /^D:2: bun install without --ignore-scripts/);
  assert.match(checkBunInstall("        run: bun install --frozen-lockfile", "w")[0], /without --ignore-scripts/);
  assert.match(checkBunInstall("RUN bun i --frozen-lockfile", "D")[0], /without --ignore-scripts/);
  assert.match(checkBunInstall("RUN bun install # --ignore-scripts", "D")[0], /without --ignore-scripts/);
});

test("a checkout without workflows is a notice, not a failure", () => {
  const { problems, notices } = checkFixture({});
  assert.deepEqual(problems, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /no workflows in this checkout/);
});

test("workflows, when present, are checked: action pins and bun installs", () => {
  const ok = checkFixture({
    ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n      - run: bun install --frozen-lockfile --ignore-scripts\n`,
  });
  assert.deepEqual(ok, { problems: [], notices: [] });
  const { problems } = checkFixture({
    ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n      - run: bun install --frozen-lockfile\n",
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /ci\.yml:4: actions\/checkout@v7 is not pinned to a full commit SHA/);
  assert.match(problems[1], /ci\.yml:5: bun install without --ignore-scripts/);
});

test("the engine images must install with --ignore-scripts", () => {
  const { problems } = checkFixture({
    "engine/Dockerfile.keeper": `FROM oven/bun:1.3.14-slim@${DIG}\nRUN bun install --frozen-lockfile --production\nUSER bun\n`,
  });
  assert.deepEqual(problems, ["engine/Dockerfile.keeper:2: bun install without --ignore-scripts (Bun runs its default-trusted packages' install scripts)"]);
});

test("spare-api (server/) is held to the same pins as the engine", () => {
  const { problems } = checkFixture({
    "server/package.json": JSON.stringify({
      packageManager: "npm@11",
      dependencies: { express: "^4.22.3" },
      overrides: { qs: "^6.16.0" },
    }),
    "server/.nvmrc": "24\n",
    "server/.npmrc": "min-release-age=3\n",
  });
  assert.deepEqual(problems, [
    'server/package.json: dependencies.express = "^4.22.3" is not an exact version',
    'server/package.json: overrides.qs = "^6.16.0" is not an exact version',
    'server/package.json: packageManager npm@11 is not an exact version',
    'server/package.json: devEngines.packageManager { name: "npm", version: ">=11.10.0", onFail: "warn" } is missing',
    'server/.nvmrc: "24" is not an exact x.y.z Node version',
    "server/.npmrc: ignore-scripts=true is missing",
  ]);
});

test("the site must flag an npm too old for its cooldown", () => {
  const { problems } = checkFixture({ "package.json": JSON.stringify({ packageManager: "npm@11.19.0" }) });
  assert.deepEqual(problems, ['package.json: devEngines.packageManager { name: "npm", version: ">=11.10.0", onFail: "warn" } is missing']);
});

test("packageManager and .nvmrc are exact", () => {
  assert.deepEqual(checkPackageManager({ packageManager: "bun@1.3.14" }, "p", "bun"), [[], "1.3.14"]);
  assert.equal(checkPackageManager({ packageManager: "npm@11" }, "p", "npm")[0].length, 1);
  assert.equal(checkPackageManager({}, "p", "npm")[0].length, 1);
  assert.equal(checkPackageManager({ packageManager: "pnpm@9.0.0" }, "p", "npm")[0].length, 1);
  assert.deepEqual(checkNvmrc("24.21.0\n", "n"), []);
  assert.equal(checkNvmrc("24\n", "n").length, 1);
  assert.equal(checkNvmrc("lts/*\n", "n").length, 1);
});

test(".npmrc and bunfig.toml keep install scripts off and the cooldown on", () => {
  assert.deepEqual(checkNpmrc("ignore-scripts=true\nmin-release-age=3\n", "r"), []);
  assert.equal(checkNpmrc("min-release-age=3\n", "r").length, 1);
  assert.equal(checkNpmrc("ignore-scripts=true\n", "r").length, 1);
  assert.deepEqual(checkBunfig("[install]\nminimumReleaseAge = 259200\n", "b"), []);
  assert.equal(checkBunfig("[install]\nexact = true\n", "b").length, 1);
  assert.equal(checkBunfig("[install]\nminimumReleaseAge = 60\n", "b").length, 1);
});

test("this repository passes", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // A clone without .github/workflows only gets a notice (asserted above).
  assert.deepEqual(checkRepo(root, { onNotice: () => {} }), []);
});
