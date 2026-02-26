// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { OptimizePlugin } from "../src/index";

export interface CompileOptions {
  pluginOptions?: Record<string, unknown>;
  luaTarget?: tstl.LuaTarget;
}

export function compile(
  source: string,
  optionsOrPlugin?: Record<string, unknown> | CompileOptions,
): string {
  let pluginOptions: Record<string, unknown> | undefined;
  let luaTarget: tstl.LuaTarget = tstl.LuaTarget.Lua51;

  if (optionsOrPlugin && ("pluginOptions" in optionsOrPlugin || "luaTarget" in optionsOrPlugin)) {
    const opts = optionsOrPlugin as CompileOptions;
    pluginOptions = opts.pluginOptions;
    luaTarget = opts.luaTarget ?? tstl.LuaTarget.Lua51;
  } else {
    pluginOptions = optionsOrPlugin as Record<string, unknown> | undefined;
  }

  const plugin = new OptimizePlugin(pluginOptions);
  const result = tstl.transpileVirtualProject(
    { "main.ts": source },
    {
      noHeader: true,
      luaPlugins: [{ plugin }],
      noImplicitSelf: true,
      luaTarget,
      luaLibImport: tstl.LuaLibImportKind.None,
      strict: true,
    },
  );
  const errors = result.diagnostics.filter(
    (d) => d.category === 1 /* ts.DiagnosticCategory.Error */ && d.code >= 100_000,
  );
  if (errors.length > 0) {
    const msgs = errors
      .map((d) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText))
      .join("\n");
    throw new Error(msgs);
  }
  const file = result.transpiledFiles.find((f) => f.outPath.endsWith("main.lua"));
  if (!file?.lua) {
    throw new Error("No Lua output.");
  }
  return file.lua;
}
