import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { getElseBranchStatements, isLuaRhsPure } from "../ast/lua-ast";
import { walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";

type AccessKind = "read" | "write";

type DeadLocalDeclaration = {
  index: number;
  stmt: tstl.VariableDeclarationStatement;
  rhs: tstl.Expression;
};

function canDropInitializer(
  rhs: tstl.Expression,
  preserveFunctionExpressionDecls: boolean,
): boolean {
  return isLuaRhsPure(rhs) && !(preserveFunctionExpressionDecls && tstl.isFunctionExpression(rhs));
}

function collectReadSymbolsFromExpressions(
  expressions: readonly tstl.Expression[],
  reads: Set<number>,
): void {
  for (const expr of expressions) {
    collectReadSymbolsFromExpression(expr, reads);
  }
}

function getNestedScopeStatements(stmt: tstl.Statement): tstl.Statement[] | undefined {
  if (tstl.isDoStatement(stmt)) {
    return stmt.statements;
  }

  if (
    tstl.isWhileStatement(stmt) ||
    tstl.isRepeatStatement(stmt) ||
    tstl.isForStatement(stmt) ||
    tstl.isForInStatement(stmt)
  ) {
    return stmt.body.statements;
  }

  return undefined;
}

/**
 * Two-pass dead-local elimination on a single function body's statement list.
 *
 * Pass 1 (shallow): collect single-var declarations at this scope only — `shallow: true`
 * stops at FunctionExpression boundaries so nested declarations aren't misattributed.
 *
 * Pass 2 (deep): collect all identifier reads. Deep walk is required so closure captures
 * inside nested functions count as reads of the outer declaration.
 */
function eliminateDeadLocals(
  statements: tstl.Statement[],
  preserveFunctionExpressionDecls = false,
): void {
  const declsBySymbol = new Map<number, DeadLocalDeclaration>();

  for (const [index, stmt] of statements.entries()) {
    if (
      tstl.isVariableDeclarationStatement(stmt) &&
      stmt.left.length === 1 &&
      stmt.right !== undefined &&
      stmt.right.length === 1
    ) {
      const symbolId = stmt.left[0].symbolId;
      if (symbolId !== undefined) {
        declsBySymbol.set(symbolId, { index, stmt, rhs: stmt.right[0] });
      }
    }
  }

  if (declsBySymbol.size > 0) {
    const reads = new Set<number>();
    collectReadSymbols(statements, reads);

    const toRemove = new Set<tstl.Statement>();
    for (const [symbolId, { index, stmt, rhs }] of declsBySymbol) {
      const firstAccess = findFirstAccessKind(statements.slice(index + 1), symbolId);
      if (!canDropInitializer(rhs, preserveFunctionExpressionDecls)) {
        continue;
      }

      if (firstAccess === "write") {
        stmt.right = undefined;
        continue;
      }

      if (!reads.has(symbolId)) {
        toRemove.add(stmt);
      }
      // Impure RHS must execute even when the variable is never read — keep it.
    }

    if (toRemove.size > 0) {
      const kept = statements.filter((s) => !toRemove.has(s));
      statements.length = 0;
      statements.push(...kept);
    }
  }

  recurseIntoNestedScopes(statements);
}

function collectReadSymbols(statements: readonly tstl.Statement[], reads: Set<number>): void {
  for (const stmt of statements) {
    collectReadSymbolsFromStatement(stmt, reads);
  }
}

function collectReadSymbolsFromStatement(stmt: tstl.Statement, reads: Set<number>): void {
  if (tstl.isDoStatement(stmt)) {
    collectReadSymbols(stmt.statements, reads);
    return;
  }

  if (tstl.isVariableDeclarationStatement(stmt)) {
    if (stmt.right) collectReadSymbolsFromExpressions(stmt.right, reads);
    return;
  }

  if (tstl.isAssignmentStatement(stmt)) {
    for (const lhs of stmt.left) {
      if (tstl.isTableIndexExpression(lhs)) {
        collectReadSymbolsFromExpression(lhs.table, reads);
        collectReadSymbolsFromExpression(lhs.index, reads);
      }
    }
    for (const expr of stmt.right) {
      collectReadSymbolsFromExpression(expr, reads);
    }
    return;
  }

  if (tstl.isIfStatement(stmt)) {
    collectReadSymbolsFromExpression(stmt.condition, reads);
    collectReadSymbols(stmt.ifBlock.statements, reads);
    if (stmt.elseBlock) {
      collectReadSymbols(getElseBranchStatements(stmt.elseBlock), reads);
    }
    return;
  }

  if (tstl.isWhileStatement(stmt)) {
    collectReadSymbolsFromExpression(stmt.condition, reads);
    collectReadSymbols(stmt.body.statements, reads);
    return;
  }

  if (tstl.isRepeatStatement(stmt)) {
    collectReadSymbols(stmt.body.statements, reads);
    collectReadSymbolsFromExpression(stmt.condition, reads);
    return;
  }

  if (tstl.isForStatement(stmt)) {
    collectReadSymbolsFromExpression(stmt.controlVariableInitializer, reads);
    collectReadSymbolsFromExpression(stmt.limitExpression, reads);
    if (stmt.stepExpression) {
      collectReadSymbolsFromExpression(stmt.stepExpression, reads);
    }
    collectReadSymbols(stmt.body.statements, reads);
    return;
  }

  if (tstl.isForInStatement(stmt)) {
    collectReadSymbolsFromExpressions(stmt.expressions, reads);
    collectReadSymbols(stmt.body.statements, reads);
    return;
  }

  if (tstl.isReturnStatement(stmt)) {
    collectReadSymbolsFromExpressions(stmt.expressions, reads);
    return;
  }

  if (tstl.isExpressionStatement(stmt)) {
    collectReadSymbolsFromExpression(stmt.expression, reads);
  }
}

function collectReadSymbolsFromExpression(expr: tstl.Expression, reads: Set<number>): void {
  if (tstl.isIdentifier(expr)) {
    if (expr.symbolId !== undefined) reads.add(expr.symbolId);
    return;
  }

  if (tstl.isBinaryExpression(expr)) {
    collectReadSymbolsFromExpression(expr.left, reads);
    collectReadSymbolsFromExpression(expr.right, reads);
    return;
  }

  if (tstl.isUnaryExpression(expr)) {
    collectReadSymbolsFromExpression(expr.operand, reads);
    return;
  }

  if (tstl.isCallExpression(expr)) {
    collectReadSymbolsFromExpression(expr.expression, reads);
    for (const param of expr.params) {
      collectReadSymbolsFromExpression(param, reads);
    }
    return;
  }

  if (tstl.isMethodCallExpression(expr)) {
    collectReadSymbolsFromExpression(expr.prefixExpression, reads);
    for (const param of expr.params) {
      collectReadSymbolsFromExpression(param, reads);
    }
    return;
  }

  if (tstl.isTableIndexExpression(expr)) {
    collectReadSymbolsFromExpression(expr.table, reads);
    collectReadSymbolsFromExpression(expr.index, reads);
    return;
  }

  if (tstl.isTableExpression(expr)) {
    for (const field of expr.fields) {
      if (field.key) {
        collectReadSymbolsFromExpression(field.key, reads);
      }
      collectReadSymbolsFromExpression(field.value, reads);
    }
    return;
  }

  if (tstl.isParenthesizedExpression(expr)) {
    collectReadSymbolsFromExpression(expr.expression, reads);
    return;
  }

  if (tstl.isConditionalExpression(expr)) {
    collectReadSymbolsFromExpression(expr.condition, reads);
    collectReadSymbolsFromExpression(expr.whenTrue, reads);
    collectReadSymbolsFromExpression(expr.whenFalse, reads);
    return;
  }

  if (tstl.isFunctionExpression(expr)) {
    collectReadSymbols(expr.body.statements, reads);
  }
}

function findFirstAccessKind(
  statements: readonly tstl.Statement[],
  symbolId: number,
): AccessKind | undefined {
  for (const stmt of statements) {
    const access = findFirstAccessKindInStatement(stmt, symbolId);
    if (access !== undefined) return access;
  }
  return undefined;
}

function findFirstAccessKindInStatement(
  stmt: tstl.Statement,
  symbolId: number,
): AccessKind | undefined {
  if (tstl.isDoStatement(stmt)) {
    return findFirstAccessKind(stmt.statements, symbolId);
  }

  if (tstl.isVariableDeclarationStatement(stmt)) {
    return stmt.right ? findFirstAccessKindInExpressions(stmt.right, symbolId) : undefined;
  }

  if (tstl.isAssignmentStatement(stmt)) {
    let sawDirectWrite = false;
    for (const lhs of stmt.left) {
      if (tstl.isIdentifier(lhs) && lhs.symbolId === symbolId) {
        sawDirectWrite = true;
        continue;
      }
      if (tstl.isTableIndexExpression(lhs)) {
        const access =
          findFirstAccessKindInExpression(lhs.table, symbolId) ??
          findFirstAccessKindInExpression(lhs.index, symbolId);
        if (access !== undefined) return access;
      }
    }
    const rhsAccess = findFirstAccessKindInExpressions(stmt.right, symbolId);
    if (rhsAccess !== undefined) {
      return rhsAccess;
    }
    return sawDirectWrite ? "write" : undefined;
  }

  if (tstl.isIfStatement(stmt)) {
    return (
      findFirstAccessKindInExpression(stmt.condition, symbolId) ??
      findFirstAccessKind(stmt.ifBlock.statements, symbolId) ??
      (stmt.elseBlock
        ? findFirstAccessKind(getElseBranchStatements(stmt.elseBlock), symbolId)
        : undefined)
    );
  }

  if (tstl.isWhileStatement(stmt)) {
    return (
      findFirstAccessKindInExpression(stmt.condition, symbolId) ??
      findFirstAccessKind(stmt.body.statements, symbolId)
    );
  }

  if (tstl.isRepeatStatement(stmt)) {
    return (
      findFirstAccessKind(stmt.body.statements, symbolId) ??
      findFirstAccessKindInExpression(stmt.condition, symbolId)
    );
  }

  if (tstl.isForStatement(stmt)) {
    return (
      findFirstAccessKindInExpression(stmt.controlVariableInitializer, symbolId) ??
      findFirstAccessKindInExpression(stmt.limitExpression, symbolId) ??
      (stmt.stepExpression
        ? findFirstAccessKindInExpression(stmt.stepExpression, symbolId)
        : undefined) ??
      findFirstAccessKind(stmt.body.statements, symbolId)
    );
  }

  if (tstl.isForInStatement(stmt)) {
    return (
      findFirstAccessKindInExpressions(stmt.expressions, symbolId) ??
      findFirstAccessKind(stmt.body.statements, symbolId)
    );
  }

  if (tstl.isReturnStatement(stmt)) {
    return findFirstAccessKindInExpressions(stmt.expressions, symbolId);
  }

  if (tstl.isExpressionStatement(stmt)) {
    return findFirstAccessKindInExpression(stmt.expression, symbolId);
  }

  return undefined;
}

function findFirstAccessKindInExpressions(
  expressions: readonly tstl.Expression[],
  symbolId: number,
): AccessKind | undefined {
  for (const expr of expressions) {
    const access = findFirstAccessKindInExpression(expr, symbolId);
    if (access !== undefined) return access;
  }
  return undefined;
}

function findFirstAccessKindInExpression(
  expr: tstl.Expression,
  symbolId: number,
): AccessKind | undefined {
  if (tstl.isIdentifier(expr)) {
    return expr.symbolId === symbolId ? "read" : undefined;
  }

  if (tstl.isBinaryExpression(expr)) {
    return (
      findFirstAccessKindInExpression(expr.left, symbolId) ??
      findFirstAccessKindInExpression(expr.right, symbolId)
    );
  }

  if (tstl.isUnaryExpression(expr)) {
    return findFirstAccessKindInExpression(expr.operand, symbolId);
  }

  if (tstl.isCallExpression(expr)) {
    return (
      findFirstAccessKindInExpression(expr.expression, symbolId) ??
      findFirstAccessKindInExpressions(expr.params, symbolId)
    );
  }

  if (tstl.isMethodCallExpression(expr)) {
    return (
      findFirstAccessKindInExpression(expr.prefixExpression, symbolId) ??
      findFirstAccessKindInExpressions(expr.params, symbolId)
    );
  }

  if (tstl.isTableIndexExpression(expr)) {
    return (
      findFirstAccessKindInExpression(expr.table, symbolId) ??
      findFirstAccessKindInExpression(expr.index, symbolId)
    );
  }

  if (tstl.isTableExpression(expr)) {
    for (const field of expr.fields) {
      const access =
        (field.key ? findFirstAccessKindInExpression(field.key, symbolId) : undefined) ??
        findFirstAccessKindInExpression(field.value, symbolId);
      if (access !== undefined) return access;
    }
    return undefined;
  }

  if (tstl.isParenthesizedExpression(expr)) {
    return findFirstAccessKindInExpression(expr.expression, symbolId);
  }

  if (tstl.isConditionalExpression(expr)) {
    return (
      findFirstAccessKindInExpression(expr.condition, symbolId) ??
      findFirstAccessKindInExpression(expr.whenTrue, symbolId) ??
      findFirstAccessKindInExpression(expr.whenFalse, symbolId)
    );
  }

  if (tstl.isFunctionExpression(expr)) {
    return findFirstAccessKind(expr.body.statements, symbolId) !== undefined ? "read" : undefined;
  }

  return undefined;
}

/**
 * Recursively processes nested scopes to eliminate dead locals in each scope.
 *
 * Finds FunctionExpression nodes in stored positions (variable/assignment RHS, call
 * arguments, table field values, IIFE callees) within all reachable statement lists,
 * including compound statement bodies (do, if, while, for, etc.).
 */
function recurseIntoNestedScopes(statements: tstl.Statement[]): void {
  walkStatements(statements, {
    shallow: true,
    expr: (expr, _replace, control) => {
      if (tstl.isFunctionExpression(expr)) {
        eliminateDeadLocals(expr.body.statements);
        control.skip();
      }
    },
  });

  for (const stmt of statements) {
    if (tstl.isIfStatement(stmt)) {
      eliminateDeadLocals(stmt.ifBlock.statements, true);
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          recurseIntoNestedScopes([stmt.elseBlock]);
        } else {
          eliminateDeadLocals(getElseBranchStatements(stmt.elseBlock) as tstl.Statement[], true);
        }
      }
      continue;
    }

    const nestedStatements = getNestedScopeStatements(stmt);
    if (nestedStatements) {
      eliminateDeadLocals(nestedStatements, true);
    }
  }
}

export const createVisitors: RuleFactory = (): tstl.Visitors => ({
  [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context): tstl.File => {
    const nodes = context.superTransformNode(node);
    const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;
    if (!file || !tstl.isFile(file) || !file.statements) return file;
    // Module-level locals are intentionally excluded — only function-scope dead locals are removed.
    recurseIntoNestedScopes(file.statements);
    return file;
  },
});
