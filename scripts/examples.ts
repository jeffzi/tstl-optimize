#!/usr/bin/env tsx

/**
 * Compiles each TypeScript file in the 'examples' directory using the tstl-optimize plugin.
 * Generates corresponding Lua files to demonstrate and verify optimization results.
 * Use the --check flag in CI to ensure examples stay in sync with the plugin logic.
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
  source: string,
  pluginOptions?: Record<string, unknown>,
): { lua: string; warnings: ts.Diagnostic[] } {
  const result = tstl.transpileVirtualProject(
    {
      "globals.d.ts":
        "/** @noSelfInFile */\ndeclare function print(...args: unknown[]): void;\ndeclare const console: { log(...args: unknown[]): void };",
      "main.ts": source,
    },
    {
      noHeader: true,
      luaPlugins: [{ plugin: new Plugin(pluginOptions) }],
      noImplicitSelf: true,
      luaTarget: tstl.LuaTarget.Lua51,
      luaLibImport: tstl.LuaLibImportKind.None,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      lib: ["lib.esnext.d.ts"],
      types: ["@typescript-to-lua/language-extensions"],
    },
  );

  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map(getDiagnosticMessage).join("\n"));
  }

  const file = result.transpiledFiles.find((f) => f.outPath.endsWith("main.lua"));
  if (!file?.lua) {
    throw new Error("TSTL compilation failed: no main.lua generated");
  }

  return {
    lua: file.lua,
    warnings: result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning),
  };
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
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

  for (const name of tsFiles) {
    const luaName = name.replace(/\.ts$/, ".lua");
    const tsPath = resolve(examplesDir, name);
    const source = readFileSync(tsPath, "utf8");

    const optsPath = resolve(examplesDir, name.replace(/\.ts$/, ".opts.json"));
    let pluginOptions: Record<string, unknown> | undefined;
    try {
      const raw: unknown = JSON.parse(readFileSync(optsPath, "utf8"));
      if (isRecord(raw)) pluginOptions = raw;
    } catch {
      // sidecar opts file is optional
    }

    const { lua, warnings } = compile(OptimizePlugin, source, pluginOptions);

    for (const w of warnings) {
      const line =
        w.file && w.start !== undefined
          ? ts.getLineAndCharacterOfPosition(w.file, w.start).line + 1
          : undefined;
      const loc = line !== undefined ? `${name}:${line}` : name;
      console.warn(`${loc}: warning: ${getDiagnosticMessage(w)}`);
    }

    const luaPath = resolve(examplesDir, luaName);
    if (check) {
      let existing = "";
      try {
        existing = readFileSync(luaPath, "utf8");
      } catch {
        // no existing file
      }
      if (existing !== lua) {
        console.error(`Out of date: ${luaName}`);
        stale = true;
      }
    } else {
      writeFileSync(luaPath, lua);
      console.log(`${name} -> ${luaName}`);
    }
  }

  if (check && stale) {
    console.error('Example .lua files are out of date. Run "npm run examples" to regenerate.');
    exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
});
