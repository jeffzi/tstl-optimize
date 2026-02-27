#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// --- .env loading (only sets vars not already defined) ---

function loadEnv(filepath) {
  let content;
  try {
    content = readFileSync(filepath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnv(resolve(".env"));

// --- Interpreter probes ---

const env = process.env;

const PROBES = {
  "lua5.1": { cmd: env.LUA_51 || "lua5.1", args: [] },
  luajit: { cmd: env.LUA_JIT || "luajit", args: [] },
  "luajit-nojit": { cmd: env.LUA_JIT || "luajit", args: ["-joff"] },
};

const ALL_LABELS = ["lua5.1", "luajit", "luajit-nojit"];

// --- CLI args: filter to requested labels, or run all ---

const requested = process.argv.slice(2);
const labels = requested.length > 0 ? requested : ALL_LABELS;

// --- Main loop ---

const seen = new Set();
let ran = 0;

for (const label of labels) {
  const probe = PROBES[label];
  if (!probe) continue;

  const { cmd, args } = probe;

  // Detect binary and get version
  const vResult = spawnSync(cmd, [...args, "-v"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (vResult.error) {
    process.stderr.write(`Warning: ${label} not found (${cmd})\n`);
    continue;
  }

  let version = ((vResult.stdout || "") + (vResult.stderr || "")).split("\n")[0].trim();
  if (args.includes("-joff")) {
    version += " JIT=Off";
  }

  // Select benchmark directory based on interpreter type
  const luaRoot = version.includes("LuaJIT") ? "benchmark/lua-jit" : "benchmark/lua";
  const benchDir = join(luaRoot, "benchmark");

  // Deduplicate by version + benchmark directory
  const dedupKey = `${version}|${benchDir}`;
  if (seen.has(dedupKey)) continue;
  seen.add(dedupKey);

  // Discover benchmark files
  let files;
  try {
    files = readdirSync(benchDir, { recursive: true })
      .filter((f) => f.endsWith(".lua"))
      .sort();
  } catch {
    process.stderr.write(`Warning: no benchmark files found in ${benchDir}\n`);
    continue;
  }

  if (files.length === 0) {
    process.stderr.write(`Warning: no benchmark files found in ${benchDir}\n`);
    continue;
  }

  process.stdout.write(`=== ${label} (${version}) ===\n`);

  // Normalize LUA_PATH for Windows compatibility
  const luaPath = `${luaRoot.replaceAll("\\", "/")}/?.lua;;`;

  for (const f of files) {
    spawnSync(cmd, [...args, join(benchDir, f)], {
      stdio: "inherit",
      env: { ...env, LUA_PATH: luaPath },
    });
  }

  process.stdout.write("\n");
  ran++;
}

if (ran === 0) {
  process.stderr.write(`Error: no interpreters found for labels: ${labels.join(" ")}\n`);
  process.stderr.write("Set paths in .env (see .env.example) or install interpreters on PATH.\n");
  process.exit(1);
}
