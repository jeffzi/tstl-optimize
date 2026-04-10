import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { OptimizePlugin } from "../src/index";

export interface CompileOptions {
  pluginOptions?: Record<string, unknown>;
  luaTarget?: tstl.LuaTarget;
  luaLibImport?: tstl.LuaLibImportKind;
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

function extractLua(result: tstl.TranspileVirtualProjectResult): string {
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
  return file.lua;
}

export function compile(source: string, options?: CompileOptions): string {
  return extractLua(transpile({ "main.ts": source }, options));
}

export function compileMultiFileWithDiagnostics(
  files: Record<string, string>,
  options?: CompileOptions,
): CompileResult {
  const result = transpile(files, options);
  const lua = extractLua(result);
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
