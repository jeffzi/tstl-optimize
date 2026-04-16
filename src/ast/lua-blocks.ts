// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/**
 * Yields direct child statement lists of a single compound statement.
 * visitor receives readonly tstl.Statement[] arrays (NOT tstl.Block wrappers).
 * Returning true from visitor stops iteration early.
 * Recursively handles IfStatement else-if chains.
 */
export function forEachNestedStatementList(
  statement: tstl.Statement,
  visitor: (statements: readonly tstl.Statement[]) => boolean | undefined,
): void {
  if (tstl.isDoStatement(statement)) {
    if (visitor(statement.statements)) return;
  } else if (tstl.isIfStatement(statement)) {
    if (visitor(statement.ifBlock.statements)) return;
    if (statement.elseBlock !== undefined) {
      if (tstl.isIfStatement(statement.elseBlock)) {
        forEachNestedStatementList(statement.elseBlock, visitor);
      } else {
        if (visitor(statement.elseBlock.statements)) return;
      }
    }
  } else if (tstl.isWhileStatement(statement)) {
    if (visitor(statement.body.statements)) return;
  } else if (tstl.isRepeatStatement(statement)) {
    if (visitor(statement.body.statements)) return;
  } else if (tstl.isForStatement(statement)) {
    if (visitor(statement.body.statements)) return;
  } else if (tstl.isForInStatement(statement)) {
    if (visitor(statement.body.statements)) return;
  }
}
