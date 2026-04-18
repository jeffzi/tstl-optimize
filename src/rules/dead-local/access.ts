// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
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

/**
 * Finds the first access to `symbolId` among statements that are guaranteed to execute
 * in source order. Returns "write" only when the write is unconditional at this scope —
 * a conditional write (inside if/while/for/repeat) cannot replace the declaration's
 * initializer because the original value is observable when the condition is false.
 *
 * When a conditional statement mentions the symbol at all, we return "read" (pessimistic)
 * to disable the drop-initializer shortcut. Plain do-end blocks are transparent.
 */
export function findFirstAccessKind(
  statements: readonly tstl.Statement[],
  symbolId: number,
): AccessKind | undefined {
  for (const stmt of statements) {
    if (isConditionalStatement(stmt)) {
      if (statementMentionsSymbol(stmt, symbolId)) return "read";
      continue;
    }

    if (tstl.isDoStatement(stmt)) {
      const nested = findFirstAccessKind(stmt.statements, symbolId);
      if (nested !== undefined) return nested;
      continue;
    }

    let result: AccessKind | undefined;
    forEachAccess(stmt, ({ identifier, kind, inFunctionBody }) => {
      if (identifier.symbolId !== symbolId) return undefined;
      result = inFunctionBody ? "read" : kind;
      return true;
    });
    if (result !== undefined) return result;
  }
  return undefined;
}

function isConditionalStatement(stmt: tstl.Statement): boolean {
  return (
    tstl.isIfStatement(stmt) ||
    tstl.isWhileStatement(stmt) ||
    tstl.isRepeatStatement(stmt) ||
    tstl.isForStatement(stmt) ||
    tstl.isForInStatement(stmt)
  );
}

function statementMentionsSymbol(stmt: tstl.Statement, symbolId: number): boolean {
  let found = false;
  forEachAccess(stmt, ({ identifier }) => {
    if (identifier.symbolId === symbolId) {
      found = true;
      return true;
    }
    return undefined;
  });
  return found;
}
