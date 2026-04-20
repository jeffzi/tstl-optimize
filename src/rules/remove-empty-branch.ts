import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { Walk, walkStatements } from "../ast/lua-walker";
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

function createSafeConditionScope(
  inherited: ReadonlySet<tstl.SymbolId>,
  identifiers?: readonly tstl.Identifier[],
): Set<tstl.SymbolId> {
  const scope = new Set(inherited);
  if (identifiers) {
    for (const identifier of identifiers) {
      if (identifier.symbolId !== undefined) {
        scope.add(identifier.symbolId);
      }
    }
  }
  return scope;
}

function rememberSafeConditionBindings(
  stmt: tstl.Statement,
  safeIdentifiers: Set<tstl.SymbolId>,
): void {
  if (!tstl.isVariableDeclarationStatement(stmt)) {
    return;
  }

  for (const identifier of stmt.left) {
    if (identifier.symbolId !== undefined) {
      safeIdentifiers.add(identifier.symbolId);
    }
  }
}

/**
 * Empty-branch pruning only removes conditions whose truthiness can be read
 * without invoking operators that Lua may dispatch through metamethods.
 */
function isSafeEmptyBranchCondition(
  expr: tstl.Expression,
  safeIdentifiers: ReadonlySet<tstl.SymbolId>,
): boolean {
  if (
    tstl.isBooleanLiteral(expr) ||
    tstl.isNumericLiteral(expr) ||
    tstl.isStringLiteral(expr) ||
    tstl.isNilLiteral(expr)
  ) {
    return true;
  }

  if (tstl.isIdentifier(expr)) {
    return expr.symbolId !== undefined && safeIdentifiers.has(expr.symbolId);
  }

  if (tstl.isParenthesizedExpression(expr)) {
    return isSafeEmptyBranchCondition(expr.expression, safeIdentifiers);
  }

  return (
    tstl.isUnaryExpression(expr) &&
    expr.operator === tstl.SyntaxKind.NotOperator &&
    isSafeEmptyBranchCondition(expr.operand, safeIdentifiers)
  );
}

/**
 * Returns true if all branches of an if/elseif/else chain are empty and have safe removable conditions.
 */
function isRemovableIfChain(
  stmt: tstl.IfStatement,
  safeIdentifiers: ReadonlySet<tstl.SymbolId>,
): boolean {
  let cursor: tstl.IfStatement | tstl.Block | undefined = stmt;
  while (cursor) {
    if (tstl.isIfStatement(cursor)) {
      if (
        cursor.ifBlock.statements.length > 0 ||
        !isSafeEmptyBranchCondition(cursor.condition, safeIdentifiers)
      ) {
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
 * Prunes trailing empty elseif/else branches when their conditions are safe to remove.
 */
function pruneTrailingEmptyBranches(
  stmt: tstl.IfStatement,
  safeIdentifiers: ReadonlySet<tstl.SymbolId>,
): void {
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
      if (
        current.ifBlock.statements.length === 0 &&
        isSafeEmptyBranchCondition(current.condition, safeIdentifiers)
      ) {
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

function negateCondition(expr: tstl.Expression): tstl.Expression {
  const operand =
    tstl.isBinaryExpression(expr) || tstl.isConditionalExpression(expr)
      ? tstl.createParenthesizedExpression(expr)
      : expr;
  return tstl.createUnaryExpression(operand, tstl.SyntaxKind.NotOperator);
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
    stmt.condition = negateCondition(stmt.condition);
    stmt.ifBlock = stmt.elseBlock;
    stmt.elseBlock = undefined;
  }
}

/**
 * Recursively process the elseif/else chain of an if-statement.
 */
function recurseIntoIfChain(
  block: tstl.Block | tstl.IfStatement | undefined,
  safeIdentifiers: ReadonlySet<tstl.SymbolId>,
): void {
  let cursor = block;
  while (cursor) {
    if (tstl.isIfStatement(cursor)) {
      removeEmptyBranches(cursor.ifBlock.statements, safeIdentifiers);
      cursor = cursor.elseBlock;
    } else {
      removeEmptyBranches(cursor.statements, safeIdentifiers);
      break;
    }
  }
}

/**
 * Recursively removes empty branches and promotes else blocks.
 */
function removeEmptyBranches(
  statements: tstl.Statement[],
  inheritedSafeIdentifiers: ReadonlySet<tstl.SymbolId>,
): void {
  const safeIdentifiers = new Set(inheritedSafeIdentifiers);
  let i = 0;
  while (i < statements.length) {
    const stmt = statements[i];
    rememberSafeConditionBindings(stmt, safeIdentifiers);

    if (tstl.isIfStatement(stmt)) {
      // Recurse into if branch and elseif/else chain bottom-up
      removeEmptyBranches(stmt.ifBlock.statements, safeIdentifiers);
      recurseIntoIfChain(stmt.elseBlock, safeIdentifiers);

      // Try to promote else block when if-block is empty
      promoteElseBlock(statements, i);

      // Check if entire if-chain is removable
      if (isRemovableIfChain(stmt, safeIdentifiers)) {
        statements.splice(i, 1);
        continue;
      }

      // Prune trailing empty branches if the main if is non-empty
      pruneTrailingEmptyBranches(stmt, safeIdentifiers);
    } else if (tstl.isDoStatement(stmt)) {
      removeEmptyBranches(stmt.statements, safeIdentifiers);
      if (stmt.statements.length === 0) {
        statements.splice(i, 1);
        continue;
      }
    } else if (isLoopStatement(stmt)) {
      const loopSafeIdentifiers = tstl.isForStatement(stmt)
        ? createSafeConditionScope(safeIdentifiers, [stmt.controlVariable])
        : tstl.isForInStatement(stmt)
          ? createSafeConditionScope(safeIdentifiers, stmt.names)
          : safeIdentifiers;
      removeEmptyBranches(stmt.body.statements, loopSafeIdentifiers);
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
      removeEmptyBranches(file.statements, new Set<tstl.SymbolId>());

      // 2. Find all function expressions and process their bodies
      walkStatements(file.statements, {
        expr: (expr: tstl.Expression) => {
          if (tstl.isFunctionExpression(expr)) {
            removeEmptyBranches(
              expr.body.statements,
              createSafeConditionScope(new Set<tstl.SymbolId>(), expr.params),
            );
          }
          return Walk.keep;
        },
      });

      return file;
    },
  },
});
