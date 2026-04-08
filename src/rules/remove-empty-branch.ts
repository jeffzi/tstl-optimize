import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isLuaExprPure } from "../ast/lua-ast";
import { walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";

/**
 * Type guard for loop statements (while, repeat, for, for-in).
 */
function isLoopStatement(
  stmt: tstl.Statement,
): stmt is tstl.WhileStatement | tstl.RepeatStatement | tstl.ForStatement | tstl.ForInStatement {
  return (
    tstl.isWhileStatement(stmt) ||
    tstl.isRepeatStatement(stmt) ||
    tstl.isForStatement(stmt) ||
    tstl.isForInStatement(stmt)
  );
}

/**
 * Returns true if all branches of an if/elseif/else chain are empty and have pure conditions.
 */
function isRemovableIfChain(stmt: tstl.IfStatement): boolean {
  let cursor: tstl.IfStatement | tstl.Block | undefined = stmt;
  while (cursor) {
    if (tstl.isIfStatement(cursor)) {
      if (cursor.ifBlock.statements.length > 0 || !isLuaExprPure(cursor.condition)) {
        return false;
      }
      cursor = cursor.elseBlock;
    } else {
      // Plain else block
      return cursor.statements.length === 0;
    }
  }
  return true;
}

/**
 * Prunes trailing empty elseif/else branches when their conditions are pure.
 */
function pruneTrailingEmptyBranches(stmt: tstl.IfStatement): void {
  // Collect the if/elseif chain into an array for easy right-to-left traversal
  const chain: tstl.IfStatement[] = [stmt];
  let cursor = stmt.elseBlock;
  while (cursor && tstl.isIfStatement(cursor)) {
    chain.push(cursor);
    cursor = cursor.elseBlock;
  }

  let tailIsPruneable = true;
  if (cursor && tstl.isBlock(cursor)) {
    if (cursor.statements.length === 0) {
      // Empty plain else, we can safely prune it
      const lastIf = chain[chain.length - 1];
      if (lastIf) {
        lastIf.elseBlock = undefined;
      }
    } else {
      tailIsPruneable = false;
    }
  }

  if (tailIsPruneable) {
    // Work backwards through the elseif chain (skipping the main if at index 0)
    for (let i = chain.length - 1; i > 0; i--) {
      const current = chain[i];
      if (current.ifBlock.statements.length === 0 && isLuaExprPure(current.condition)) {
        const parent = chain[i - 1];
        if (parent) {
          parent.elseBlock = undefined;
        }
      } else {
        // Stop pruning once we hit a non-empty or impure branch
        break;
      }
    }
  }
}

/**
 * Promotes an else block when the if-block is empty.
 */
function promoteElseBlock(statements: tstl.Statement[], i: number): void {
  const stmt = statements[i];
  if (!tstl.isIfStatement(stmt) || stmt.ifBlock.statements.length > 0 || !stmt.elseBlock) {
    return;
  }

  if (tstl.isBlock(stmt.elseBlock)) {
    // Guard: if else block is empty, don't transform
    if (stmt.elseBlock.statements.length === 0) {
      return;
    }
    // Case A/B: plain else with non-empty body
    // Always negate condition and promote else to if-body
    stmt.condition = tstl.createUnaryExpression(stmt.condition, tstl.SyntaxKind.NotOperator);
    stmt.ifBlock = stmt.elseBlock;
    stmt.elseBlock = undefined;
  }
}

/**
 * Recursively process the elseif/else chain of an if-statement.
 */
function recurseIntoIfChain(block: tstl.Block | tstl.IfStatement | undefined): void {
  let cursor = block;
  while (cursor) {
    if (tstl.isIfStatement(cursor)) {
      removeEmptyBranches(cursor.ifBlock.statements);
      cursor = cursor.elseBlock;
    } else {
      removeEmptyBranches(cursor.statements);
      break;
    }
  }
}

/**
 * Recursively removes empty branches and promotes else blocks.
 */
function removeEmptyBranches(statements: tstl.Statement[]): void {
  let i = 0;
  while (i < statements.length) {
    const stmt = statements[i];

    if (tstl.isIfStatement(stmt)) {
      // Recurse into if branch and elseif/else chain bottom-up
      removeEmptyBranches(stmt.ifBlock.statements);
      recurseIntoIfChain(stmt.elseBlock);

      // Try to promote else block when if-block is empty
      promoteElseBlock(statements, i);

      // Check if entire if-chain is removable
      if (isRemovableIfChain(stmt)) {
        statements.splice(i, 1);
        continue;
      }

      // Prune trailing empty branches if the main if is non-empty
      pruneTrailingEmptyBranches(stmt);
    } else if (tstl.isDoStatement(stmt)) {
      removeEmptyBranches(stmt.statements);
      if (stmt.statements.length === 0) {
        statements.splice(i, 1);
        continue;
      }
    } else if (isLoopStatement(stmt)) {
      removeEmptyBranches(stmt.body.statements);
    }

    i++;
  }
}

export const createVisitors: RuleFactory = (): tstl.Visitors => ({
  [ts.SyntaxKind.SourceFile]: {
    transform: (node: ts.SourceFile, context): tstl.File => {
      const nodes = context.superTransformNode(node);
      const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;

      if (!file || !tstl.isFile(file) || !file.statements) return file;

      // 1. Process root statements recursively
      removeEmptyBranches(file.statements);

      // 2. Find all function expressions and process their bodies
      walkStatements(file.statements, {
        expr: (expr) => {
          if (tstl.isFunctionExpression(expr)) {
            removeEmptyBranches(expr.body.statements);
          }
        },
      });

      return file;
    },
  },
});
