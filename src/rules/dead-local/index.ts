import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isLuaRhsPure } from "../../ast/lua-ast";
import { Walk, walkStatements } from "../../ast/lua-walker";
import type { RuleFactory } from "../../config";
import { getTransformedFile } from "../source-file";
import { collectReadSymbols, findFirstAccessKind } from "./access";

/**
 * Metadata about a dead-local candidate.
 * - `index`: Position in the statement array.
 * - `stmt`: The variable declaration statement itself.
 * - `rhs`: The right-hand side initializer expression.
 */
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
 * **Pass 1 (shallow)**: Collect single-variable declarations at this scope only. We stop at
 * FunctionExpression boundaries so nested declarations (which have their own scope) aren't
 * misattributed to this scope.
 *
 * **Pass 2 (deep)**: Collect all identifier reads across the entire statement list. A deep walk
 * is required because closure captures inside nested functions count as reads of the outer
 * scope's declaration — skipping them would incorrectly mark the outer variable as dead.
 */
function eliminateDeadLocals(
  statements: tstl.Statement[],
  preserveFunctionExpressionDecls: boolean = false,
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
      // Skip impure RHS early: the initializer must execute for its side effects
      // even when the variable is never read, so nothing can be dropped or erased.
      if (!canDropInitializer(rhs, preserveFunctionExpressionDecls)) {
        continue;
      }

      const firstAccess = findFirstAccessKind(statements.slice(index + 1), symbolId);
      if (firstAccess === "write") {
        stmt.right = undefined;
        continue;
      }

      if (!reads.has(symbolId)) {
        toRemove.add(stmt);
      }
    }

    if (toRemove.size > 0) {
      const kept = statements.filter((s) => !toRemove.has(s));
      statements.splice(0, statements.length, ...kept);
    }
  }

  recurseIntoNestedScopes(statements);
}

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
          eliminateDeadLocals(stmt.elseBlock.statements, true);
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
    const file = getTransformedFile(nodes);
    // Module-level locals are not eliminated because they may be accessed by code outside the
    // module (e.g., by other modules that import them). We only eliminate dead locals within
    // function bodies, where scope is guaranteed to be contained.
    recurseIntoNestedScopes(file.statements);
    return file;
  },
});
