// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { getElseBranchStatements } from "../../ast/lua-ast";
import { walkStatements } from "../../ast/lua-walker";
import { luaPropertyChain } from "../../ast/scope";

/** Lua stdlib globals that are safe to hoist (flat function tables, no metatables). */
export const STDLIB_ROOTS: ReadonlySet<string> = new Set([
  "math",
  "string",
  "table",
  "os",
  "io",
  "coroutine",
  "bit",
  "bit32",
  "jit",
  "debug",
]);

export function statementTouchesChain(
  statement: tstl.Statement,
  chain: string,
  shallow: boolean,
): boolean {
  let found = false;
  walkStatements([statement], {
    shallow,
    expr: (expr, _replace, control) => {
      if (!tstl.isTableIndexExpression(expr)) {
        return;
      }

      if (luaPropertyChain(expr) === chain) {
        found = true;
        control.stop();
      }
    },
  });
  return found;
}

export function statementHasInterveningCallForChain(
  statement: tstl.Statement,
  chain: string,
  shallow: boolean,
): boolean {
  let sawChainAccess = false;
  let hasInterveningCall = false;

  walkStatements([statement], {
    shallow,
    expr: (expr, _replace, control) => {
      if (tstl.isCallExpression(expr) || tstl.isMethodCallExpression(expr)) {
        if (sawChainAccess) {
          hasInterveningCall = true;
          control.stop();
        }
        return;
      }

      if (tstl.isTableIndexExpression(expr) && luaPropertyChain(expr) === chain) {
        sawChainAccess = true;
      }
    },
  });

  return hasInterveningCall;
}

export function statementHasUnsafeCallBeforeFirstChainAccess(
  statement: tstl.Statement,
  chain: string,
  shallow: boolean,
): boolean {
  let sawUnsafeCall = false;
  let foundUnsafePrefix = false;
  let sawFirstChainAccess = false;

  const shouldStopWalking = (): boolean => foundUnsafePrefix || sawFirstChainAccess;

  const visitExpr = (expr: tstl.Expression): void => {
    if (shouldStopWalking()) {
      return;
    }

    if (tstl.isBinaryExpression(expr)) {
      visitExpr(expr.left);
      visitExpr(expr.right);
      return;
    }

    if (tstl.isUnaryExpression(expr)) {
      visitExpr(expr.operand);
      return;
    }

    if (tstl.isCallExpression(expr)) {
      visitExpr(expr.expression);
      visitExpressionList(expr.params);
      visitCall(isNonStdlibCall(expr.expression));
      return;
    }

    if (tstl.isMethodCallExpression(expr)) {
      visitExpr(expr.prefixExpression);
      visitExpressionList(expr.params);
      visitCall(true);
      return;
    }

    if (tstl.isTableIndexExpression(expr)) {
      visitExpr(expr.table);
      visitExpr(expr.index);
      visitChain(expr);
      return;
    }

    if (tstl.isTableExpression(expr)) {
      for (const field of expr.fields) {
        if (field.key) {
          visitExpr(field.key);
        }
        visitExpr(field.value);
      }
      return;
    }

    if (tstl.isParenthesizedExpression(expr)) {
      visitExpr(expr.expression);
      return;
    }

    if (tstl.isConditionalExpression(expr)) {
      visitExpr(expr.condition);
      visitExpr(expr.whenTrue);
      visitExpr(expr.whenFalse);
      return;
    }

    if (tstl.isFunctionExpression(expr) && !shallow) {
      return;
    }
  };

  const visitExpressionList = (expressions: readonly tstl.Expression[]): void => {
    for (const expr of expressions) {
      if (shouldStopWalking()) {
        return;
      }
      visitExpr(expr);
    }
  };

  const visitStatementList = (statements: readonly tstl.Statement[]): void => {
    for (const stmt of statements) {
      if (shouldStopWalking()) {
        return;
      }
      visitStatement(stmt);
    }
  };

  const visitChain = (expr: tstl.TableIndexExpression): void => {
    if (sawFirstChainAccess || luaPropertyChain(expr) !== chain) {
      return;
    }
    if (sawUnsafeCall) {
      foundUnsafePrefix = true;
    }
    sawFirstChainAccess = true;
  };

  const visitCall = (unsafe: boolean): void => {
    if (!unsafe || sawFirstChainAccess) {
      return;
    }
    sawUnsafeCall = true;
  };

  const visitStatement = (stmt: tstl.Statement): void => {
    if (tstl.isDoStatement(stmt)) {
      visitStatementList(stmt.statements);
      return;
    }

    if (tstl.isVariableDeclarationStatement(stmt)) {
      visitExpressionList(stmt.right ?? []);
      return;
    }

    if (tstl.isAssignmentStatement(stmt)) {
      visitExpressionList(stmt.right);
      return;
    }

    if (tstl.isIfStatement(stmt)) {
      visitExpr(stmt.condition);
      visitStatementList(stmt.ifBlock.statements);
      if (stmt.elseBlock) {
        visitStatementList(getElseBranchStatements(stmt.elseBlock));
      }
      return;
    }

    if (tstl.isWhileStatement(stmt)) {
      visitExpr(stmt.condition);
      visitStatementList(stmt.body.statements);
      return;
    }

    if (tstl.isRepeatStatement(stmt)) {
      visitStatementList(stmt.body.statements);
      visitExpr(stmt.condition);
      return;
    }

    if (tstl.isForStatement(stmt)) {
      visitExpressionList([stmt.controlVariableInitializer, stmt.limitExpression]);
      if (stmt.stepExpression) {
        visitExpr(stmt.stepExpression);
      }
      visitStatementList(stmt.body.statements);
      return;
    }

    if (tstl.isForInStatement(stmt)) {
      visitExpressionList(stmt.expressions);
      visitStatementList(stmt.body.statements);
      return;
    }

    if (tstl.isReturnStatement(stmt)) {
      visitExpressionList(stmt.expressions);
      return;
    }

    if (tstl.isExpressionStatement(stmt)) {
      visitExpr(stmt.expression);
    }
  };

  visitStatement(statement);
  return foundUnsafePrefix;
}

/**
 * Check if a call expression is to a non-stdlib function.
 * Returns false if the callee is provably a stdlib root (e.g., math.ceil).
 */
export function isNonStdlibCall(expr: tstl.Expression): boolean {
  if (tstl.isTableIndexExpression(expr) && tstl.isIdentifier(expr.table)) {
    return !STDLIB_ROOTS.has(expr.table.text);
  }
  if (tstl.isIdentifier(expr)) {
    return !STDLIB_ROOTS.has(expr.text);
  }
  // Any other callee form (not directly identifiable) — conservative: assume unsafe
  return true;
}

/**
 * Check if any call expression exists in the loop body (not inside nested function bodies).
 */
export function hasCallExpression(statements: tstl.Statement[]): boolean {
  let found = false;
  walkStatements(statements, {
    shallow: true,
    expr: (expr, _replace, control) => {
      if (tstl.isCallExpression(expr) || tstl.isMethodCallExpression(expr)) {
        found = true;
        control.stop();
      }
    },
  });
  return found;
}

/**
 * Check if statements contain a call to a non-stdlib function.
 * Calls to stdlib functions (math.ceil, etc.) are known to be safe and don't mutate globals.
 */
function hasNonStdlibCall(statements: tstl.Statement[]): boolean {
  let found = false;
  walkStatements(statements, {
    shallow: true,
    expr: (expr, _replace, control) => {
      if (tstl.isCallExpression(expr)) {
        if (isNonStdlibCall(expr.expression)) {
          found = true;
          control.stop();
        }
      } else if (tstl.isMethodCallExpression(expr)) {
        // Method calls like obj:method() — always unsafe (could mutate obj)
        found = true;
        control.stop();
      }
    },
  });
  return found;
}

export function hasTopLevelChainAccess(statements: tstl.Statement[], chain: string): boolean {
  return statements.some((statement) => statementTouchesChain(statement, chain, true));
}

export function hasInterveningCallForChain(
  statements: tstl.Statement[],
  chain: string,
  shallow: boolean,
): boolean {
  const root = chain.split(".")[0];
  if (STDLIB_ROOTS.has(root)) {
    return false;
  }

  let firstAccessIndex: number | undefined;
  let lastAccessIndex: number | undefined;
  for (const [index, statement] of statements.entries()) {
    if (!statementTouchesChain(statement, chain, shallow)) {
      continue;
    }

    if (statementHasUnsafeCallBeforeFirstChainAccess(statement, chain, shallow)) {
      return true;
    }

    if (statementHasInterveningCallForChain(statement, chain, shallow)) {
      return true;
    }

    if (firstAccessIndex === undefined) {
      firstAccessIndex = index;
    }
    lastAccessIndex = index;
  }

  if (
    firstAccessIndex === undefined ||
    lastAccessIndex === undefined ||
    firstAccessIndex >= lastAccessIndex
  ) {
    return false;
  }

  // Check for non-stdlib calls before the first access — hoisting via unshift() would place
  // the hoisted local above any pre-access call, capturing a potentially stale snapshot if
  // the call mutates the root. Calls to stdlib functions are known to be safe.
  if (hasNonStdlibCall(statements.slice(0, firstAccessIndex))) {
    return true;
  }

  for (let index = firstAccessIndex + 1; index < lastAccessIndex; index += 1) {
    if (hasCallExpression([statements[index]])) {
      return true;
    }
  }

  return false;
}

/**
 * Detect control-flow exits that escape the current scope. Nested loops only propagate
 * return/goto because break is scoped to the inner loop.
 */
function hasScopeExit(statements: tstl.Statement[], includeBreak: boolean): boolean {
  for (const stmt of statements) {
    if (tstl.isReturnStatement(stmt) || tstl.isGotoStatement(stmt)) return true;
    if (includeBreak && tstl.isBreakStatement(stmt)) return true;

    if (tstl.isIfStatement(stmt)) {
      if (hasScopeExit(stmt.ifBlock.statements, includeBreak)) return true;
      if (
        stmt.elseBlock &&
        hasScopeExit(getElseBranchStatements(stmt.elseBlock) as tstl.Statement[], includeBreak)
      ) {
        return true;
      }
      continue;
    }

    if (tstl.isDoStatement(stmt)) {
      if (hasScopeExit(stmt.statements, includeBreak)) return true;
      continue;
    }

    if (
      (tstl.isWhileStatement(stmt) ||
        tstl.isRepeatStatement(stmt) ||
        tstl.isForStatement(stmt) ||
        tstl.isForInStatement(stmt)) &&
      hasScopeExit(stmt.body.statements, false)
    ) {
      return true;
    }
  }

  return false;
}

/** Check for top-level return/break that would prevent write-back from executing. */
export function hasEarlyExit(statements: tstl.Statement[]): boolean {
  return hasScopeExit(statements, true);
}
