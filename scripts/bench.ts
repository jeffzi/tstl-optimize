#!/usr/bin/env tsx

/**
 * Benchmarks compiled Lua code against various Lua interpreters (Lua 5.1, LuaJIT).
 * Compares performance and ensures consistency across different environments.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

/** Minimal .env loader to avoid external dependencies. */
function loadEnv(filepath: string): void {
  try {
    const content = readFileSync(filepath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const firstEq = trimmed.indexOf("=");
      if (firstEq === -1) continue;

      const key = trimmed.slice(0, firstEq).trim();
      let value = trimmed.slice(firstEq + 1).trim();

      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value.startsWith('"') ? '"' : "'";
        let pos = 1;
        while (pos < value.length && value[pos] !== quote) {
          if (value[pos] === "\\" && pos + 1 < value.length) pos++;
          pos++;
        }
        const inner = pos < value.length ? value.slice(1, pos) : value.slice(1);
        value = inner.replaceAll(`\\${quote}`, quote);
      } else {
        value = value.split("#")[0]?.trim() ?? "";
      }

      if (key && !(key in env)) {
        env[key] = value;
      }
    }
  } catch {
    // Skip if .env is missing or unreadable.
  }
}

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

interface Probe {
  cmd: string;
  args: string[];
}

const PROBES: Record<string, Probe> = {
  "lua5.1": { cmd: env.LUA_51 ?? "lua5.1", args: [] },
  luajit: { cmd: env.LUA_JIT ?? "luajit", args: [] },
  "luajit-nojit": { cmd: env.LUA_JIT ?? "luajit", args: ["-joff"] },
};

function getVersion(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, [...args, "-v"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) return "";

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (!output.trim()) return "";

  const [firstLine = ""] = output.split("\n");
  let version = firstLine.trim();
  if (args.includes("-joff")) {
    version += " JIT=Off";
  }
  return version;
}

function runBenchmarks(
  cmd: string,
  args: string[],
  benchDir: string,
  luaRoot: string,
  filePatterns: string[],
): { attempted: number; succeeded: number } {
  let files: string[];
  try {
    files = readdirSync(benchDir, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".lua"))
      .sort();
  } catch {
    return { attempted: 0, succeeded: 0 };
  }

  if (filePatterns.length > 0) {
    files = files.filter((f) =>
      filePatterns.some((p) => {
        const pattern = p.endsWith(".ts")
          ? p.replace(/\.ts$/, ".lua")
          : p.endsWith(".lua")
            ? p
            : `${p}.lua`;
        // Both separators: readdirSync with recursive uses `/` on Unix, `\` on Windows.
        return f === pattern || f.endsWith(`/${pattern}`) || f.endsWith(`\\${pattern}`);
      }),
    );
  }

  if (files.length === 0) return { attempted: 0, succeeded: 0 };

  const luaPath = `${luaRoot.replace(/\\/g, "/")}/?.lua;;`;
  let succeeded = 0;
  for (const f of files) {
    const result = spawnSync(cmd, [...args, join(benchDir, f)], {
      stdio: "inherit",
      env: { ...env, LUA_PATH: luaPath },
    });
    if (result.status === 0) {
      succeeded++;
    } else {
      const msg = result.error ? `: ${result.error.message}` : "";
      console.warn(`Warning: benchmark ${f} failed${msg}`);
    }
  }
  return { attempted: files.length, succeeded };
}

function main(): void {
  const args = argv.slice(2);
  const labels: string[] = [];
  const filePatterns: string[] = [];

  for (const arg of args) {
    if (arg in PROBES) {
      labels.push(arg);
    } else {
      filePatterns.push(arg);
    }
  }

  if (labels.length === 0) {
    labels.push(...Object.keys(PROBES));
  }

  const seen = new Set<string>();
  let ranAny = false;
  let foundAnyInterpreter = false;

  for (const label of labels) {
    const probe = PROBES[label];
    if (!probe) continue;

    const { cmd, args: probeArgs } = probe;
    const version = getVersion(cmd, probeArgs);

    if (!version) {
      console.warn(`Warning: ${label} not found (${cmd})`);
      continue;
    }

    foundAnyInterpreter = true;
    const isLuaJit = version.includes("LuaJIT");
    const luaRoot = isLuaJit
      ? resolve(projectRoot, "benchmark/lua-jit")
      : resolve(projectRoot, "benchmark/lua");
    const benchDir = join(luaRoot, "benchmark");

    const dedupKey = `${version}|${benchDir}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    console.log(`=== ${label} (${version}) ===`);
    const { attempted, succeeded } = runBenchmarks(cmd, probeArgs, benchDir, luaRoot, filePatterns);

    if (attempted === 0) {
      console.warn(`Warning: no matching benchmark files found in ${benchDir}`);
    } else {
      ranAny = true;
      if (succeeded < attempted) {
        console.warn(`Warning: ${attempted - succeeded} of ${attempted} benchmarks failed.`);
      }
    }
    console.log();
  }

  if (!foundAnyInterpreter) {
    console.error(`Error: no interpreters found for labels: ${labels.join(", ")}`);
    console.error("Set paths in .env (see .env.example) or install interpreters on PATH.");
    exit(1);
  }

  if (!ranAny) {
    console.error("Error: no benchmark files were run for any interpreter.");
    exit(1);
  }
}

main();
