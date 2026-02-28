#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

const TSTL_TAG = "v1.33.2";
const TSTL_REPO = "https://github.com/TypeScriptToLua/TypeScriptToLua.git";

const projectRoot = resolve(import.meta.dirname, "..");
const conformanceDir = resolve(projectRoot, ".conformance", "tstl");
const pluginPath = resolve(projectRoot, "dist", "index.js");
const patchFile = resolve(projectRoot, "scripts", "conformance.patch");
const readyMarker = resolve(conformanceDir, ".conformance-ready");

/** Run a command, inheriting stdio. Exits on failure. */
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    const label = [cmd, ...args].join(" ");
    process.stderr.write(`Command failed (exit ${result.status}): ${label}\n`);
    exit(1);
  }
}

// 1. Build the plugin
process.stdout.write("==> Building tstl-optimize plugin...\n");
run("npm", ["run", "build"], { cwd: projectRoot });

// 2. Clone + setup TSTL if needed
const cachedTag = existsSync(readyMarker) ? readFileSync(readyMarker, "utf8").trim() : "";
if (cachedTag !== TSTL_TAG) {
  // Clean up stale or incomplete setup
  if (existsSync(conformanceDir)) {
    process.stdout.write("==> Removing stale TSTL clone...\n");
    rmSync(conformanceDir, { recursive: true, force: true });
  }

  process.stdout.write(`==> Cloning TSTL ${TSTL_TAG}...\n`);
  run("git", ["clone", "--depth", "1", "--branch", TSTL_TAG, TSTL_REPO, conformanceDir]);

  process.stdout.write("==> Installing TSTL dependencies...\n");
  run("npm", ["install"], { cwd: conformanceDir });

  process.stdout.write("==> Building TSTL...\n");
  run("npm", ["run", "build"], { cwd: conformanceDir });

  process.stdout.write("==> Applying conformance patch...\n");
  run("git", ["apply", patchFile], { cwd: conformanceDir });

  // Mark setup as complete so re-runs skip it
  writeFileSync(readyMarker, TSTL_TAG);
} else {
  process.stdout.write(`==> Using cached TSTL clone at ${conformanceDir}\n`);
}

// 3. Run TSTL unit tests with our plugin active
process.stdout.write("==> Running TSTL unit tests with tstl-optimize active...\n");
const jestArgs = [
  "jest",
  "test/unit",
  "--no-coverage",
  "--forceExit",
  "--silent",
  "-u",
  ...argv.slice(2),
];
const result = spawnSync("npx", jestArgs, {
  cwd: conformanceDir,
  stdio: "inherit",
  env: { ...process.env, TSTL_OPTIMIZE_PLUGIN: pluginPath },
});
exit(result.status ?? 1);
