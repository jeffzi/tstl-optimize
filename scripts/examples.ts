#!/usr/bin/env tsx

/**
 * Compiles each TypeScript file in the 'examples' directory using the tstl-optimize plugin.
 * Generates corresponding Lua files to demonstrate and verify optimization results.
 * Use the --check flag in CI to ensure examples stay in sync with the plugin logic.
 *
 * Known intentional warnings (not regressions):
 *   - conditional-compilation.ts:94 — condition references compile-time constants but could not
 *     be fully resolved; the fixture deliberately tests a mixed-constant branch.
 *   - inline.ts:28 — @inline ignored: argument with side effects is used multiple times;
 *     the fixture exercises the side-effects guard in the inline eligibility check.
 *   - inline.ts:123 — @inline ignored: destructuring parameters are not supported;
 *     the fixture documents the destructuring limitation.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

type PluginConstructor = new (options?: Record<string, unknown>) => tstl.Plugin;

function assertIsPluginConstructor(val: unknown): asserts val is PluginConstructor {
  if (typeof val !== "function") {
    throw new Error("Plugin module does not export OptimizePlugin as a constructor");
  }
}

function getDiagnosticMessage(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, "\n");
}

function compile(
  Plugin: PluginConstructor,
  fileName: string,
  source: string,
  pluginOptions?: Record<string, unknown>,
  noResolvePaths?: string[],
): { lua: string; luaSourceMap: string; warnings: ts.Diagnostic[] } {
  const luaName = fileName.replace(/\.ts$/, ".lua");
  const result = tstl.transpileVirtualProject(
    {
      "globals.d.ts":
        "/** @noSelfInFile */\ndeclare function print(...args: unknown[]): void;\ndeclare const console: { log(...args: unknown[]): void };",
      [fileName]: source,
    },
    {
      noHeader: true,
      sourceMap: true,
      luaPlugins: [{ plugin: new Plugin(pluginOptions) }],
      noImplicitSelf: true,
      luaTarget: tstl.LuaTarget.Lua51,
      luaLibImport: tstl.LuaLibImportKind.None,
      strict: true,
      noUnusedLocals: true,
      target: ts.ScriptTarget.ESNext,
      lib: ["lib.esnext.d.ts"],
      types: ["@typescript-to-lua/language-extensions"],
      ...(noResolvePaths ? { noResolvePaths } : {}),
    },
  );

  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map(getDiagnosticMessage).join("\n"));
  }

  const file = result.transpiledFiles.find((f) => f.outPath === luaName);
  if (!file?.lua) {
    throw new Error(`TSTL compilation failed: no ${luaName} generated`);
  }
  if (!file.luaSourceMap) {
    throw new Error(`TSTL compilation failed: no sourcemap generated for ${luaName}`);
  }

  return {
    lua: file.lua,
    luaSourceMap: file.luaSourceMap,
    warnings: result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning),
  };
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function readOptionalUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Patterns that indicate pipeline bugs committed into .lua output files.
// /\bdo\s+end\b/ matches both same-line ("do end") and multiline ("do\n    end")
// because \s matches \n in JS — so empty do-blocks in any formatting are caught.
const FORBIDDEN_LUA_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "empty do-end block", pattern: /\bdo\s+end\b/g },
  { label: "unfolded if-true branch", pattern: /\bif\s+true\s+then\b/g },
  { label: "unfolded if-false branch", pattern: /\bif\s+false\s+then\b/g },
];

/**
 * Scans committed Lua content for structural patterns that indicate an
 * optimization rule left broken output. Reports each violation to stderr
 * as "file:line: forbidden pattern: <label>" and returns true if any found.
 */
function lintCommittedLua(luaName: string, content: string): boolean {
  let failed = false;
  for (const { label, pattern } of FORBIDDEN_LUA_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const lineNo = content.slice(0, match.index).split("\n").length;
      console.error(`${luaName}:${lineNo}: forbidden pattern: ${label}`);
      failed = true;
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const check = argv.includes("--check");
  const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const examplesDir = resolve(projectRoot, "examples");

  const pluginPath = resolve(projectRoot, "dist", "index.js");
  const pluginModule = (await import(pluginPath)) as unknown;

  if (!isRecord(pluginModule)) {
    throw new Error(`Plugin module at ${pluginPath} is invalid.`);
  }

  const OptimizePlugin = pluginModule.OptimizePlugin;
  assertIsPluginConstructor(OptimizePlugin);

  const tsFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  let stale = false;
  let lintFailed = false;

  for (const name of tsFiles) {
    const luaName = name.replace(/\.ts$/, ".lua");
    const tsPath = resolve(examplesDir, name);
    const source = readFileSync(tsPath, "utf8");

    const optsPath = resolve(examplesDir, name.replace(/\.ts$/, ".opts.json"));
    let pluginOptions: Record<string, unknown> | undefined;
    let noResolvePaths: string[] | undefined;
    const optsJson = readOptionalUtf8(optsPath);
    if (optsJson !== undefined) {
      try {
        const raw: unknown = JSON.parse(optsJson);
        if (isRecord(raw)) {
          if (Array.isArray(raw.noResolvePaths)) {
            noResolvePaths = raw.noResolvePaths as string[];
            const { noResolvePaths: _, ...rest } = raw;
            pluginOptions = Object.keys(rest).length > 0 ? rest : undefined;
          } else {
            pluginOptions = raw;
          }
        }
      } catch {
        // sidecar opts file is optional
      }
    }

    const { lua, luaSourceMap, warnings } = compile(
      OptimizePlugin,
      name,
      source,
      pluginOptions,
      noResolvePaths,
    );

    for (const w of warnings) {
      const line =
        w.file && w.start !== undefined
          ? ts.getLineAndCharacterOfPosition(w.file, w.start).line + 1
          : undefined;
      const loc = line !== undefined ? `${name}:${line}` : name;
      console.warn(`${loc}: warning: ${getDiagnosticMessage(w)}`);
    }

    const luaPath = resolve(examplesDir, luaName);
    const mapName = `${luaName}.map`;
    const mapPath = resolve(examplesDir, mapName);
    if (check) {
      const existing = readOptionalUtf8(luaPath) ?? "";
      if (existing !== lua) {
        console.error(`Out of date: ${luaName}`);
        stale = true;
      }
      if (existing && lintCommittedLua(luaName, existing)) {
        lintFailed = true;
      }
    } else {
      writeFileSync(luaPath, lua);
      writeFileSync(mapPath, luaSourceMap);
      console.log(`${name} -> ${luaName}, ${mapName}`);
    }
  }

  const tsBasenames = new Set(tsFiles.map((f) => f.replace(/\.ts$/, "")));
  const luaFiles = readdirSync(examplesDir).filter(
    (f) => f.endsWith(".lua") && !f.endsWith(".lua.map"),
  );
  const orphans = luaFiles.filter((f) => !tsBasenames.has(f.replace(/\.lua$/, "")));

  for (const orphan of orphans) {
    console.error(`Orphaned output (no matching .ts source): ${orphan}`);
  }

  if (check && stale) {
    console.error('Example .lua files are out of date. Run "npm run examples" to regenerate.');
  }
  if (check && (stale || lintFailed || orphans.length > 0)) {
    exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
});
