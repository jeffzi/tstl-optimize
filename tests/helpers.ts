import { spawnSync } from "node:child_process";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { expect } from "vitest";
import { OptimizePlugin } from "../src/index";

// ESNext target + lib needed for Iterable<number> to resolve in $range loops,
// which lets the type checker identify loop variables as `number` (not `any`)
// so TSTL correctly applies +1 to array index accesses.
export const BASE_TSTL_OPTIONS = {
  noHeader: true,
  noImplicitSelf: true,
  luaTarget: tstl.LuaTarget.Lua51,
  luaLibImport: tstl.LuaLibImportKind.None,
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.esnext.d.ts"],
  types: ["@typescript-to-lua/language-extensions"],
} as const satisfies tstl.CompilerOptions;

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
  });
  if (result.error) {
    throw new Error(
      `luac binary not found or failed to spawn — install Lua and ensure luac is on PATH.\nCause: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Emitted Lua failed luac -p syntax check:\n${stderr}\n\nEmitted Lua:\n${lua}`);
  }
}

interface CompileResult {
  lua: string;
  diagnostics: ts.Diagnostic[];
}

function transpile(
  files: Record<string, string>,
  options?: CompileOptions,
  tstlExtra?: Partial<tstl.CompilerOptions>,
): tstl.TranspileVirtualProjectResult {
  const {
    pluginOptions,
    luaTarget = tstl.LuaTarget.Lua51,
    luaLibImport = tstl.LuaLibImportKind.None,
  } = options ?? {};
  const plugin = new OptimizePlugin(pluginOptions);
  return tstl.transpileVirtualProject(files, {
    ...BASE_TSTL_OPTIONS,
    luaPlugins: [{ plugin }],
    luaTarget,
    luaLibImport,
    strict: true,
    ...tstlExtra,
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

export function extractTranspiledLua(
  result: tstl.TranspileVirtualProjectResult,
  { suffix = "main.lua", context }: { suffix?: string; context?: string } = {},
): string {
  const errors = result.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error && d.source !== "tstl-optimize",
  );
  if (errors.length > 0) {
    const msgs = errors.map((d) => extractDiagnosticMessage(d.messageText)).join("\n");
    const label = context ? `Compilation errors (${context}):\n` : "";
    throw new Error(`${label}${msgs}`);
  }
  const file = result.transpiledFiles.find((f) => f.outPath.endsWith(suffix));
  if (file === undefined || file.lua === undefined) {
    const label = context ? ` (${context})` : "";
    throw new Error(`No Lua output for ${suffix}${label}.`);
  }
  return file.lua;
}

function extractLua(result: tstl.TranspileVirtualProjectResult, options?: CompileOptions): string {
  const lua = extractTranspiledLua(result);
  if (!options?.skipLuaCheck) {
    checkLuaSyntax(lua);
  }
  return lua;
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

/**
 * Mapping from Lua line numbers (1-based) to TypeScript line numbers (1-based),
 * extracted from the `__TS__SourceMapTraceBack(...)` call emitted by TSTL.
 */
export type TracebackTable = Record<number, number>;

interface SourceMapCompileResult {
  lua: string;
  /** Raw JSON of the external `.lua.map` sourcemap. */
  externalMap: string;
  /**
   * Parsed `{ [luaLine: number]: tsLine }` from the inline
   * `__TS__SourceMapTraceBack(...)` call.
   *
   * An empty object is valid and expected for source files with no statements.
   * A missing call (i.e. the option didn't apply) causes this function to throw.
   */
  traceback: TracebackTable;
}

function extractSourceMapResult(
  result: tstl.TranspileVirtualProjectResult,
  luaFileSuffix: string,
  options?: CompileOptions,
): SourceMapCompileResult {
  const errors = result.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error && d.source !== "tstl-optimize",
  );
  if (errors.length > 0) {
    const msgs = errors.map((d) => extractDiagnosticMessage(d.messageText)).join("\n");
    throw new Error(msgs);
  }

  const file = result.transpiledFiles.find((f) => f.outPath.endsWith(luaFileSuffix));
  if (file === undefined || file.lua === undefined) {
    throw new Error(`compileWithSourceMap: no Lua output for ${luaFileSuffix}`);
  }
  if (file.luaSourceMap === undefined) {
    throw new Error(
      "compileWithSourceMap: no luaSourceMap in output — check that sourceMap:true was passed",
    );
  }

  const lua = file.lua;
  const externalMap = file.luaSourceMap;

  if (!options?.skipLuaCheck) {
    checkLuaSyntax(lua);
  }

  const tracebackMatch = lua.match(/__TS__SourceMapTraceBack\([^,]+,\s*(\{[^}]*\})\)/);
  if (tracebackMatch === null) {
    throw new Error(
      "compileWithSourceMap: no __TS__SourceMapTraceBack(...) call found in Lua output — " +
        "check that sourceMapTraceback:true was applied",
    );
  }

  // TSTL emits: {["4"] = 1, ["5"] = 2}
  // Convert to valid JSON:  {"4": 1, "5": 2}
  const tableJson = tracebackMatch[1]
    .replace(/\["(\d+)"\]/g, '"$1"') // ["4"] → "4"
    .replace(/\s*=\s*/g, ": ") // = → :
    .replace(/,\s*\}/, "}"); // trailing comma guard
  const raw: unknown = JSON.parse(tableJson);

  const tracebackTable: TracebackTable = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const num = Number(v);
      if (Number.isInteger(num)) {
        tracebackTable[Number(k)] = num;
      }
    }
  }

  return { lua, externalMap, traceback: tracebackTable };
}

/**
 * Compile a single TypeScript source string to Lua with `sourceMap: true` and
 * `sourceMapTraceback: true`.
 *
 * Throws loudly when the external map or the traceback call is absent in the output,
 * because silent absence is the failure mode this helper is built to prevent.
 */
export function compileWithSourceMap(
  source: string,
  options?: CompileOptions,
): SourceMapCompileResult {
  const result = transpile({ "main.ts": source }, options, {
    sourceMap: true,
    sourceMapTraceback: true,
  });
  return extractSourceMapResult(result, "main.lua", options);
}

// A reusable empty source file stub for tests that need a ts.SourceFile context
// but never inspect its content (e.g. visitor tests that assert on Lua output, not AST).
export const EMPTY_SOURCE_FILE = ts.createSourceFile("empty.ts", "", ts.ScriptTarget.Latest, true);

export function expectLuaSnippets(
  lua: string,
  { contains, excludes = [] }: { contains: readonly string[]; excludes?: readonly string[] },
): void {
  for (const snippet of contains) {
    expect(lua, `expected Lua to contain snippet: ${snippet}`).toContain(snippet);
  }

  for (const snippet of excludes) {
    expect(lua, `expected Lua to exclude snippet: ${snippet}`).not.toContain(snippet);
  }
}

export function normalizeLua(lua: string): string {
  return lua
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
