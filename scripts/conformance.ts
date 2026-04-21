#!/usr/bin/env tsx

/**
 * Runs the TypeScriptToLua (TSTL) unit test suite with the tstl-optimize plugin enabled.
 * Ensures the plugin maintains conformance with TSTL's expected behavior and output.
 */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

const TSTL_TAG = "v1.34.0";
const TSTL_REPO = "https://github.com/TypeScriptToLua/TypeScriptToLua.git";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const conformanceDir = resolve(projectRoot, ".conformance", "tstl");
const pluginPath = resolve(projectRoot, "dist", "index.js");
const patchFile = resolve(projectRoot, "scripts", "conformance.patch");
const readyMarker = resolve(conformanceDir, ".conformance-ready");

function getPatchHash(): string {
  try {
    const content = readFileSync(patchFile, "utf8");
    return createHash("md5").update(content).digest("hex");
  } catch {
    throw new Error(`conformance.patch not found at ${patchFile}`);
  }
}

/** Run a command, inheriting stdio. Exits on failure. */
function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`;
    const errorMsg = result.error ? `: ${result.error.message}` : "";
    console.error(`Command failed (${detail})${errorMsg}: ${cmd} ${args.join(" ")}`);
    exit(result.status ?? 1);
  }
}

function main(): void {
  console.log("==> Building tstl-optimize plugin...");
  run("npm", ["run", "build"], { cwd: projectRoot });

  const patchHash = getPatchHash();
  const currentMarker = `${TSTL_TAG}:${patchHash}`;
  const cachedMarker = existsSync(readyMarker) ? readFileSync(readyMarker, "utf8").trim() : "";

  if (cachedMarker !== currentMarker) {
    if (existsSync(conformanceDir)) {
      console.log("==> Removing stale TSTL clone...");
      rmSync(conformanceDir, { recursive: true, force: true });
    }

    console.log(`==> Cloning TSTL ${TSTL_TAG}...`);
    mkdirSync(resolve(conformanceDir, ".."), { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", TSTL_TAG, TSTL_REPO, conformanceDir]);

    console.log("==> Installing TSTL dependencies...");
    run("npm", ["install"], { cwd: conformanceDir });

    console.log("==> Building TSTL...");
    run("npm", ["run", "build"], { cwd: conformanceDir });

    console.log("==> Applying conformance patch...");
    run("git", ["apply", patchFile], { cwd: conformanceDir });

    writeFileSync(readyMarker, currentMarker);
  } else {
    console.log(`==> Using cached TSTL clone at ${conformanceDir}`);
  }

  // The conformance patch skips toMatchSnapshot() calls, which makes all existing snapshot files
  // obsolete. Jest exits with code 1 for obsolete snapshots in CI. Remove them preemptively.
  for (const dir of globSync("**/test/**/__snapshots__", { cwd: conformanceDir })) {
    rmSync(resolve(conformanceDir, dir), { recursive: true, force: true });
  }

  console.log("==> Running TSTL unit tests with tstl-optimize active...");
  run("npx", ["jest", "test/unit", "--no-coverage", "--forceExit", "--silent", ...argv.slice(2)], {
    cwd: conformanceDir,
    env: { ...env, TSTL_OPTIMIZE_PLUGIN: pluginPath },
  });
}

main();
