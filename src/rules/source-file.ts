// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

export function getTransformedFile(result: unknown): tstl.File {
  const file = Array.isArray(result) ? result[0] : result;
  if (!file || !tstl.isFile(file)) {
    throw new Error("expected SourceFile transform to produce a Lua file");
  }
  return file;
}
