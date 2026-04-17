// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import type * as tstl from "typescript-to-lua";
import { forEachAccess } from "../../ast/lua-references";

type AccessKind = "read" | "write";

export function collectReadSymbols(
  statements: readonly tstl.Statement[],
  reads: Set<number>,
): void {
  for (const stmt of statements) {
    forEachAccess(stmt, ({ identifier, kind }) => {
      if (kind === "read" && identifier.symbolId !== undefined) {
        reads.add(identifier.symbolId);
      }
      return undefined;
    });
  }
}

export function findFirstAccessKind(
  statements: readonly tstl.Statement[],
  symbolId: number,
): AccessKind | undefined {
  let result: AccessKind | undefined;
  for (const stmt of statements) {
    forEachAccess(stmt, ({ identifier, kind, inFunctionBody }) => {
      if (identifier.symbolId !== symbolId) return undefined;
      result = inFunctionBody ? "read" : kind;
      return true;
    });
    if (result !== undefined) return result;
  }
  return undefined;
}
