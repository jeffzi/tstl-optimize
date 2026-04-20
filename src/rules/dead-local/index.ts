import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { getElseBranchStatements, isLuaRhsPure } from "../../ast/lua-ast";
import { Walk, walkStatements } from "../../ast/lua-walker";
import type { RuleFactory } from "../../config";
import { collectReadSymbols, findFirstAccessKind } from "./access";

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
    expr: (expr: tstl.Expression) => {
      if (tstl.isFunctionExpression(expr)) {
        eliminateDeadLocals(expr.body.statements);
        return Walk.skip;
      }
      return Walk.keep;
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
