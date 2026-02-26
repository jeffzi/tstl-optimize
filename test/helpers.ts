// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { OptimizePlugin } from "../src/index";

export function compile(source: string, options?: Record<string, unknown>): string {
  const plugin = new OptimizePlugin(options);
  const result = tstl.transpileVirtualProject(
    { "main.ts": source },
    {
      noHeader: true,
      luaPlugins: [{ plugin }],
      noImplicitSelf: true,
      luaTarget: tstl.LuaTarget.Lua51,
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
