#!/usr/bin/env tsx

/**
 * Runs the TypeScriptToLua (TSTL) test suites (unit, transpile, translation) with the
 * tstl-optimize plugin enabled. Ensures the plugin maintains conformance with TSTL's
 * expected behavior and output across all Lua targets.
 */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

const TSTL_TAG = "v1.37.0";
const TSTL_REPO = "https://github.com/TypeScriptToLua/TypeScriptToLua.git";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const conformanceDir = resolve(projectRoot, ".conformance", "tstl");
const pluginPath = resolve(projectRoot, "dist", "index.js");
const patchFile = resolve(projectRoot, "scripts", "conformance.patch");
const readyMarker = resolve(conformanceDir, ".conformance-ready");

function getPatchHash(): string {
  if (!existsSync(patchFile)) {
    throw new Error(`conformance.patch not found at ${patchFile}`);
  }
  const content = readFileSync(patchFile, "utf8");
  return createHash("md5").update(content).digest("hex");
}

/**
 * The plugin manipulates the Lua AST through its own installed typescript-to-lua,
 * while the cloned TSTL_TAG checkout produces the AST under test. A version skew
 * between the two makes conformance results unrepresentative, so fail fast.
 */
function getInstalledTstlVersion(): string {
  const pkgPath = resolve(projectRoot, "node_modules", "typescript-to-lua", "package.json");
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = isRecord(pkg) ? pkg.version : undefined;
  if (typeof version !== "string") {
    throw new Error(`Cannot read typescript-to-lua version from ${pkgPath}`);
  }
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Run a command, inheriting stdio. Exits on failure. */
function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status === 0) return;
  const detail = [result.error?.message, result.signal, `exit ${result.status}`]
    .filter(Boolean)
    .join(", ");
  console.error(`Command failed (${detail}): ${cmd} ${args.join(" ")}`);
  exit(1);
}

/** Clone, install, build, and patch the pinned TSTL checkout, then record the ready marker. */
function prepareClone(currentMarker: string): void {
  if (existsSync(conformanceDir)) {
    console.log("==> Removing stale TSTL clone...");
    rmSync(conformanceDir, { recursive: true, force: true });
  }

  console.log(`==> Cloning TSTL ${TSTL_TAG}...`);
  mkdirSync(resolve(conformanceDir, ".."), { recursive: true });
  run("git", ["clone", "--depth", "1", "--branch", TSTL_TAG, TSTL_REPO, conformanceDir]);

  console.log("==> Installing TSTL dependencies...");
  run("npm", ["ci"], { cwd: conformanceDir });

  console.log("==> Building TSTL...");
  run("npm", ["run", "build"], { cwd: conformanceDir });

  console.log("==> Applying conformance patch...");
  run("git", ["apply", patchFile], { cwd: conformanceDir });

  writeFileSync(readyMarker, currentMarker);
}

function main(): void {
  const installedVersion = getInstalledTstlVersion();
  if (`v${installedVersion}` !== TSTL_TAG) {
    console.error(
      `typescript-to-lua version mismatch: the plugin is built against ${installedVersion} ` +
        `but conformance tests ${TSTL_TAG}. Align the devDependency and TSTL_TAG.`,
    );
    exit(1);
  }

  console.log("==> Building tstl-optimize plugin...");
  run("npm", ["run", "build"], { cwd: projectRoot });

  const currentMarker = `${TSTL_TAG}:${getPatchHash()}`;
  const cachedMarker = existsSync(readyMarker) ? readFileSync(readyMarker, "utf8").trim() : "";

  if (cachedMarker === currentMarker) {
    console.log(`==> Using cached TSTL clone at ${conformanceDir}`);
  } else {
    prepareClone(currentMarker);
  }

  // Snapshot baselines record stock TSTL output (or a previous plugin version's output when the
  // CI cache persists the clone across runs), so comparing against them is meaningless with the
  // plugin active. Delete them every run; --ci=false lets jest rewrite them instead of failing.
  for (const dir of globSync("test/**/__snapshots__", { cwd: conformanceDir })) {
    rmSync(resolve(conformanceDir, dir), { recursive: true, force: true });
  }

  console.log("==> Running TSTL test suites with tstl-optimize active...");
  const suites = ["test/unit", "test/transpile", "test/translation"];
  run("npx", ["jest", ...suites, "--no-coverage", "--ci=false", "--silent", ...argv.slice(2)], {
    cwd: conformanceDir,
    env: {
      ...env,
      TSTL_OPTIMIZE_PLUGIN: pluginPath,
      NODE_OPTIONS: [env.NODE_OPTIONS, "--max-old-space-size=4096"].filter(Boolean).join(" "),
    },
  });
}

main();
