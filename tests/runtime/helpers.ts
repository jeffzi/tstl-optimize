/**
 * Runtime differential test harness.
 *
 * Compiles a TypeScript source twice — once with the optimizer plugin (optimized)
 * and once without (baseline) — then executes both on every detected Lua runtime
 * and asserts identical stdout. Skips silently when no Lua runtime is present.
 */

import { spawnSync } from "node:child_process";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { expect } from "vitest";
import { OptimizePlugin } from "../../src/index";
import type { CompileOptions } from "../helpers";

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/** A labelled Lua runtime: label is for display, cmd is the executable. */
export interface LuaRuntime {
  label: string;
  cmd: string;
  args?: string[];
}

/**
 * Candidates tried in order when detecting each runtime. The first binary that
 * responds to `-v` wins.
 *
 * Override any entry via environment variables before the fallback list:
 *   LUA_51         — path to a Lua 5.1 binary
 *   LUA_JIT        — path to a LuaJIT binary
 *   LUA_JIT_NOJIT  — path to a LuaJIT binary to run with JIT disabled (-joff);
 *                    no fallback binary names — only active when env var is set
 */
const LUAJIT_VERSION_PATTERN = /\bLuaJIT\b/;

const RUNTIME_CANDIDATES: Array<{
  label: string;
  cmds: () => string[];
  args?: string[];
  versionPattern?: RegExp;
}> = [
  {
    label: "lua5.1",
    cmds: () => [process.env.LUA_51 ?? "", "lua5.1", "lua51"].filter(Boolean),
  },
  {
    label: "luajit",
    cmds: () => [process.env.LUA_JIT ?? "", "luajit", "lua"].filter(Boolean),
    versionPattern: LUAJIT_VERSION_PATTERN,
  },
  {
    label: "luajit-nojit",
    cmds: () => (process.env.LUA_JIT_NOJIT ? [process.env.LUA_JIT_NOJIT] : []),
    args: ["-joff"],
    versionPattern: LUAJIT_VERSION_PATTERN,
  },
];

function probeBinary(cmd: string): string | undefined {
  const r = spawnSync(cmd, ["-v"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) return undefined;
  const out = String(r.stdout ?? "") + String(r.stderr ?? "");
  return out.trim().length > 0 ? out : undefined;
}

let _cached: LuaRuntime[] | undefined;

/** Resets the memoized runtime cache. Intended for use in tests only. */
export function _resetRuntimeCache(): void {
  _cached = undefined;
}

function getArgKey(args: string[] | undefined): string {
  return (args ?? []).join("\0");
}

/** Returns all Lua runtimes that are reachable on the current machine. */
export function detectRuntimes(): LuaRuntime[] {
  if (_cached !== undefined) return _cached;

  const seen = new Set<string>();
  const found: LuaRuntime[] = [];

  for (const { label, cmds, args, versionPattern } of RUNTIME_CANDIDATES) {
    for (const cmd of cmds()) {
      if (!cmd) continue;
      const dedupKey = `${cmd}\0${getArgKey(args)}`;
      if (seen.has(dedupKey)) continue;
      const versionOutput = probeBinary(cmd);
      if (!versionOutput) continue;
      if (versionPattern && !versionPattern.test(versionOutput)) continue;
      seen.add(dedupKey);
      found.push({ label, cmd, ...(args ? { args } : {}) });
      break; // first hit wins for this label
    }
  }

  _cached = found;
  return found;
}

// ---------------------------------------------------------------------------
// Runtime assertions
// ---------------------------------------------------------------------------

/**
 * Asserts that the detected runtimes satisfy the `LUA_EXPECT` environment variable.
 *
 * - If `LUA_EXPECT` is set (comma-separated labels), every listed label must be present.
 * - If `LUA_EXPECT` is unset, at least one runtime must be present.
 */
export function assertExpectedRuntimes(runtimes: LuaRuntime[]): void {
  const raw = process.env.LUA_EXPECT;

  if (raw) {
    const expected = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const presentLabels = new Set(runtimes.map((r) => r.label));
    const missing = expected.filter((label) => !presentLabels.has(label));
    if (missing.length > 0) {
      throw new Error(`Missing Lua runtimes: ${missing.join(", ")}`);
    }
    return;
  }

  if (runtimes.length === 0) {
    throw new Error("No Lua runtimes detected.");
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function makeTranspileOptions(options?: CompileOptions): tstl.CompilerOptions {
  const { luaTarget = tstl.LuaTarget.Lua51, luaLibImport = tstl.LuaLibImportKind.None } =
    options ?? {};
  return {
    noHeader: true,
    noImplicitSelf: true,
    luaTarget,
    luaLibImport,
    strict: true,
    // ESNext + lib needed for $range / Iterable<number> resolution.
    target: ts.ScriptTarget.ESNext,
    lib: ["lib.esnext.d.ts"],
    types: ["@typescript-to-lua/language-extensions"],
  };
}

function extractMainLua(result: tstl.TranspileVirtualProjectResult, context: string): string {
  const errors = result.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error && d.source !== "tstl-optimize",
  );
  if (errors.length > 0) {
    const msgs = errors
      .map((d) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText))
      .join("\n");
    throw new Error(`Compilation errors (${context}):\n${msgs}`);
  }
  const file = result.transpiledFiles.find((f) => f.outPath.endsWith("main.lua"));
  if (!file?.lua) throw new Error(`No Lua output (${context}).`);
  return file.lua;
}

/** Compile TypeScript source **with** the optimizer plugin. */
export function compileOptimized(source: string, options?: CompileOptions): string {
  const plugin = new OptimizePlugin(options?.pluginOptions);
  const result = tstl.transpileVirtualProject(
    { "main.ts": source },
    { ...makeTranspileOptions(options), luaPlugins: [{ plugin }] },
  );
  return extractMainLua(result, "optimized");
}

/** Compile TypeScript source **without** the optimizer plugin (reference output). */
export function compileBaseline(source: string, options?: CompileOptions): string {
  const result = tstl.transpileVirtualProject({ "main.ts": source }, makeTranspileOptions(options));
  return extractMainLua(result, "baseline");
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  exitCode: number;
  stderr: string;
}

function runLua(lua: string, runtime: LuaRuntime): RunResult {
  const r = spawnSync(runtime.cmd, [...(runtime.args ?? []), "-"], {
    input: lua,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    stdout: String(r.stdout ?? ""),
    exitCode: r.status ?? (r.error ? -1 : 0),
    stderr: String(r.stderr ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Public assertion
// ---------------------------------------------------------------------------

export interface RuntimeEqualOptions extends CompileOptions {
  /**
   * Restrict which runtime labels to test.
   * Default: all detected runtimes.
   */
  runtimes?: string[];
}

/**
 * Asserts that `source` produces identical stdout on every available Lua runtime
 * when compiled with and without the optimizer plugin.
 *
 * Silently no-ops when no Lua runtime is installed, so the assertion is safe to
 * call unconditionally in `test:unit`. Use `test:runtime` (which requires at
 * least one runtime) to enforce runtime coverage in CI.
 */
export function runtimeEqual(source: string, options?: RuntimeEqualOptions): void {
  let runtimes = detectRuntimes();
  if (options?.runtimes) {
    runtimes = runtimes.filter((r) => options.runtimes?.includes(r.label));
  }
  if (runtimes.length === 0) return;

  const baseline = compileBaseline(source, options);
  const optimized = compileOptimized(source, options);

  for (const runtime of runtimes) {
    const baseRun = runLua(baseline, runtime);
    const optRun = runLua(optimized, runtime);

    if (baseRun.exitCode !== 0) {
      throw new Error(
        `Baseline Lua crashed on ${runtime.label} (exit ${baseRun.exitCode}):\n${baseRun.stderr}\n\nLua:\n${baseline}`,
      );
    }
    if (optRun.exitCode !== 0) {
      throw new Error(
        `Optimized Lua crashed on ${runtime.label} (exit ${optRun.exitCode}):\n${optRun.stderr}\n\nOptimized Lua:\n${optimized}`,
      );
    }

    expect(optRun.stdout, `stdout mismatch on ${runtime.label}`).toBe(baseRun.stdout);
  }
}
