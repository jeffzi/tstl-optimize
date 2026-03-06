#!/usr/bin/env node

/**
 * Compiles each .ts file in examples/ through tstl-optimize and writes
 * the corresponding .lua file alongside it. With --check, exits non-zero
 * if any .lua file is out of date (for CI).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

const check = argv.includes("--check");
const examplesDir = resolve(import.meta.dirname, "..", "examples");

// Dynamic imports — requires the plugin to be built first
const ts = (await import("typescript")).default;
const tstl = await import("typescript-to-lua");
const { OptimizePlugin } = await import("../dist/index.js");

function compile(source, pluginOptions) {
  const plugin = new OptimizePlugin(pluginOptions);
  const result = tstl.transpileVirtualProject(
    { "main.ts": source },
    {
      noHeader: true,
      luaPlugins: [{ plugin }],
      noImplicitSelf: true,
      luaTarget: tstl.LuaTarget.Lua51,
      luaLibImport: tstl.LuaLibImportKind.None,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      lib: ["lib.esnext.d.ts"],
      types: ["@typescript-to-lua/language-extensions"],
    },
  );
  const errors = result.diagnostics.filter((d) => d.category === 1 && d.code >= 100_000);
  if (errors.length > 0) {
    const msgs = errors
      .map((d) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText))
      .join("\n");
    throw new Error(msgs);
  }
  const file = result.transpiledFiles.find((f) => f.outPath.endsWith("main.lua"));
  if (!file?.lua) throw new Error("No Lua output.");
  const warnings = result.diagnostics.filter((d) => d.source === "tstl-optimize");
  return { lua: file.lua, warnings };
}

const tsFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
let stale = false;

for (const name of tsFiles) {
  const luaName = name.replace(/\.ts$/, ".lua");
  const tsPath = resolve(examplesDir, name);
  const luaPath = resolve(examplesDir, luaName);
  const source = readFileSync(tsPath, "utf8");
  const optsPath = resolve(examplesDir, name.replace(/\.ts$/, ".opts.json"));
  let pluginOptions;
  try {
    pluginOptions = JSON.parse(readFileSync(optsPath, "utf8"));
  } catch {
    // no sidecar opts file — use defaults
  }
  const { lua, warnings } = compile(source, pluginOptions);

  for (const w of warnings) {
    const msg = typeof w.messageText === "string" ? w.messageText : w.messageText.messageText;
    process.stderr.write(`${name}: warning: ${msg}\n`);
  }

  if (check) {
    let existing = "";
    try {
      existing = readFileSync(luaPath, "utf8");
    } catch {
      // file doesn't exist yet
    }
    if (existing !== lua) {
      process.stderr.write(`Out of date: ${luaName}\n`);
      stale = true;
    }
  } else {
    writeFileSync(luaPath, lua);
    process.stdout.write(`${name} -> ${luaName}\n`);
  }
}

if (check && stale) {
  process.stderr.write(
    'Example .lua files are out of date. Run "npm run examples" to regenerate.\n',
  );
  exit(1);
}
