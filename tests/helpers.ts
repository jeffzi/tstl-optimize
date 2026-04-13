import { spawnSync } from "node:child_process";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { OptimizePlugin } from "../src/index";

export interface CompileOptions {
  pluginOptions?: Record<string, unknown>;
  luaTarget?: tstl.LuaTarget;
  luaLibImport?: tstl.LuaLibImportKind;
  /** Skip the luac syntax-validity check. Use only for intentionally-malformed fixtures. */
  skipLuaCheck?: boolean;
}

/**
 * Runs `luac -p -` on the emitted Lua to catch syntax errors the string-assertion
 * layer would otherwise miss. Requires the `luac` binary to be present.
 */
function checkLuaSyntax(lua: string): void {
  const result = spawnSync("luac", ["-p", "-"], {
    input: lua,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error) {
    throw new Error(
      `luac binary not found or failed to spawn — install Lua and ensure luac is on PATH.\nCause: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr as string).trim();
    throw new Error(`Emitted Lua failed luac -p syntax check:\n${stderr}\n\nEmitted Lua:\n${lua}`);
  }
}

export interface CompileResult {
  lua: string;
  diagnostics: ts.Diagnostic[];
}

function transpile(
  files: Record<string, string>,
  options?: CompileOptions,
): tstl.TranspileVirtualProjectResult {
  const {
    pluginOptions,
    luaTarget = tstl.LuaTarget.Lua51,
    luaLibImport = tstl.LuaLibImportKind.None,
  } = options ?? {};
  const plugin = new OptimizePlugin(pluginOptions);
  return tstl.transpileVirtualProject(files, {
    noHeader: true,
    luaPlugins: [{ plugin }],
    noImplicitSelf: true,
    luaTarget,
    luaLibImport,
    strict: true,
    // ESNext target + lib needed for Iterable<number> to resolve in $range loops,
    // which lets the type checker identify loop variables as `number` (not `any`)
    // so TSTL correctly applies +1 to array index accesses.
    target: ts.ScriptTarget.ESNext,
    lib: ["lib.esnext.d.ts"],
    types: ["@typescript-to-lua/language-extensions"],
  });
}

function extractDiagnosticMessage(messageText: string | ts.DiagnosticMessageChain): string {
  if (typeof messageText === "string") {
    return messageText;
  }
  const parts: string[] = [messageText.messageText];
  if (messageText.next) {
    for (const c of messageText.next) {
      parts.push(extractDiagnosticMessage(c));
    }
  }
  return parts.join("\n");
}

function extractLua(result: tstl.TranspileVirtualProjectResult, options?: CompileOptions): string {
  const errors = result.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error && d.source !== "tstl-optimize",
  );
  if (errors.length > 0) {
    const msgs = errors.map((d) => extractDiagnosticMessage(d.messageText)).join("\n");
    throw new Error(msgs);
  }
  const file = result.transpiledFiles.find((f) => f.outPath.endsWith("main.lua"));
  if (file === undefined || file.lua === undefined) {
    throw new Error("No Lua output.");
  }
  if (!options?.skipLuaCheck) {
    checkLuaSyntax(file.lua);
  }
  return file.lua;
}

export function compile(source: string, options?: CompileOptions): string {
  return extractLua(transpile({ "main.ts": source }, options), options);
}

export function compileMultiFileWithDiagnostics(
  files: Record<string, string>,
  options?: CompileOptions,
): CompileResult {
  const result = transpile(files, options);
  const lua = extractLua(result, options);
  const diagnostics = result.diagnostics.filter((d) => d.source === "tstl-optimize");
  return { lua, diagnostics };
}

export function compileWithDiagnostics(source: string, options?: CompileOptions): CompileResult {
  return compileMultiFileWithDiagnostics({ "main.ts": source }, options);
}

export function normalizeLua(lua: string): string {
  return lua
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
