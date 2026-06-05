// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { forEachAccess } from "../../ast/lua-references";

/**
 * Distinguishes whether an identifier is being read from or written to.
 * - "read": The identifier's current value is used.
 * - "write": The identifier is assigned a new value.
 */
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
    });
  }
}

/**
 * Finds the first access to a symbol among statements that execute in source order.
 *
 * **Return value**: Returns "write" if the first unconditional access is a write; "read" if the
 * first unconditional access is a read; or undefined if the symbol is never accessed.
 *
 * **Conditional writes**: A write inside if/while/for/repeat is treated as no access ("read"
 * returned instead). This is because the original value is observable when the condition is
 * false, so the initializer cannot be safely dropped.
 *
 * **Conditional reads**: When a conditional statement reads the symbol at all (even inside a
 * branch), we conservatively return "read" to prevent the drop-initializer optimization.
 *
 * **do-end blocks**: Transparent — we descend into them since they don't affect observability.
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
    forEachAccess(
      stmt,
      ({
        identifier,
        kind,
        inFunctionBody,
      }: {
        identifier: tstl.Identifier;
        kind: AccessKind;
        inFunctionBody: boolean;
      }) => {
        if (identifier.symbolId !== symbolId) return;
        result = inFunctionBody ? "read" : kind;
        return true;
      },
    );
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
  forEachAccess(stmt, ({ identifier }: { identifier: tstl.Identifier }) => {
    if (identifier.symbolId === symbolId) {
      found = true;
      return true;
    }
    return undefined;
  });
  return found;
}
