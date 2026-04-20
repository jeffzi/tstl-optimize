// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { getElseBranchStatements } from "../../ast/lua-ast";
import { Walk, walkStatements } from "../../ast/lua-walker";
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
    expr: (expr: tstl.Expression) => {
      if (!tstl.isTableIndexExpression(expr)) {
        return Walk.keep;
      }

      if (luaPropertyChain(expr) === chain) {
        found = true;
        return Walk.stop;
      }
      return Walk.keep;
    },
  });
  return found;
}

export function statementHasUnsafeCallBeforeFirstChainAccess(
  statement: tstl.Statement,
  chain: string,
  shallow: boolean,
): boolean {
  let sawUnsafeCall = false;
  let foundUnsafePrefix = false;
  let sawFirstChainAccess = false;

  walkChainWithUnsafeCalls(statement, chain, shallow, {
    onChain: () => {
      if (sawUnsafeCall) {
        foundUnsafePrefix = true;
      }
      sawFirstChainAccess = true;
    },
    onCall: (unsafe: boolean) => {
      if (!unsafe || sawFirstChainAccess) {
        return;
      }
      sawUnsafeCall = true;
    },
    shouldStop: () => foundUnsafePrefix || sawFirstChainAccess,
  });

  return foundUnsafePrefix;
}

interface ChainWithUnsafeCallsVisitors {
  onChain: () => void;
  onCall: (unsafe: boolean) => void;
  shouldStop: () => boolean;
}

function walkChainWithUnsafeCalls(
  statement: tstl.Statement,
  chain: string,
  shallow: boolean,
  visitors: ChainWithUnsafeCallsVisitors,
): void {
  const visitExpr = (expr: tstl.Expression): void => {
    if (visitors.shouldStop()) {
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
      visitors.onCall(isNonStdlibCall(expr.expression));
      return;
    }

    if (tstl.isMethodCallExpression(expr)) {
      visitExpr(expr.prefixExpression);
      visitExpressionList(expr.params);
      visitors.onCall(true);
      return;
    }

    if (tstl.isTableIndexExpression(expr)) {
      visitExpr(expr.table);
      visitExpr(expr.index);
      if (luaPropertyChain(expr) === chain) {
        visitors.onChain();
      }
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
      if (visitors.shouldStop()) {
        return;
      }
      visitExpr(expr);
    }
  };

  const visitStatementList = (statements: readonly tstl.Statement[]): void => {
    for (const stmt of statements) {
      if (visitors.shouldStop()) {
        return;
      }
      visitStatement(stmt);
    }
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
    expr: (expr: tstl.Expression) => {
      if (tstl.isCallExpression(expr) || tstl.isMethodCallExpression(expr)) {
        found = true;
        return Walk.stop;
      }
      return Walk.keep;
    },
  });
  return found;
}

/**
 * Visit a statement in logical (pre-order) traversal: callee/prefix and args before marking
 * a call as unsafe. Returns flags indicating whether unsafe calls occur after the first chain
 * access, and whether further accesses occur after any such call.
 *
 * - `afterFirst`: true if a non-stdlib call is marked after at least one chain access has been
 *   visited earlier. MethodCallExpression is always unsafe. FunctionExpression bodies are always
 *   skipped.
 * - `betweenAccesses`: true if, after `afterFirst` arms, another chain access is visited.
 */
export function statementHasUnsafeCallAfterFirstChainAccess(
  statement: tstl.Statement,
  chain: string,
): { afterFirst: boolean; betweenAccesses: boolean } {
  let sawFirstChainAccess = false;
  let sawCallAfterFirst = false;
  let sawAccessAfterCall = false;

  walkChainWithUnsafeCalls(statement, chain, false, {
    onChain: () => {
      if (!sawFirstChainAccess) {
        sawFirstChainAccess = true;
      } else if (sawCallAfterFirst) {
        sawAccessAfterCall = true;
      }
    },
    onCall: (unsafe: boolean) => {
      if (unsafe && sawFirstChainAccess) {
        sawCallAfterFirst = true;
      }
    },
    shouldStop: () => false,
  });

  return { afterFirst: sawCallAfterFirst, betweenAccesses: sawAccessAfterCall };
}

/**
 * Check if a statement is an assignment where the LHS includes the given chain or a prefix of it.
 * For example, for chain "a.b.c", returns true if LHS is "a.b.c", "a.b", or "a".
 *
 * Recursively descends through wrapper statements (DoStatement, IfStatement, WhileStatement,
 * RepeatStatement, ForStatement, ForInStatement) to find nested assignments. Always skips
 * FunctionExpression bodies since closures execute later and cannot mutate the chain inline.
 */
export function statementAssignsToChain(stmt: tstl.Statement, chain: string): boolean {
  const chainParts = chain.split(".");
  const prefixes = new Set<string>();
  for (let i = 1; i <= chainParts.length; i++) {
    prefixes.add(chainParts.slice(0, i).join("."));
  }

  const checkAssignmentLhs = (lhsExpr: tstl.Expression): boolean => {
    if (tstl.isIdentifier(lhsExpr)) {
      const chainRoot = chainParts[0];
      if (lhsExpr.text === chainRoot) {
        return true;
      }
      return false;
    }
    if (!tstl.isTableIndexExpression(lhsExpr)) {
      return false;
    }
    const lhsChain = luaPropertyChain(lhsExpr);
    return lhsChain !== undefined && prefixes.has(lhsChain);
  };

  const walkStatementList = (statements: readonly tstl.Statement[]): boolean => {
    for (const s of statements) {
      if (walkStatement(s)) {
        return true;
      }
    }
    return false;
  };

  const walkStatement = (s: tstl.Statement): boolean => {
    if (tstl.isAssignmentStatement(s)) {
      for (const lhs of s.left) {
        if (checkAssignmentLhs(lhs)) {
          return true;
        }
      }
      return false;
    }

    if (tstl.isDoStatement(s)) {
      return walkStatementList(s.statements);
    }

    if (tstl.isIfStatement(s)) {
      if (walkStatementList(s.ifBlock.statements)) {
        return true;
      }
      if (s.elseBlock) {
        if (walkStatementList(getElseBranchStatements(s.elseBlock))) {
          return true;
        }
      }
      return false;
    }

    if (tstl.isWhileStatement(s)) {
      return walkStatementList(s.body.statements);
    }

    if (tstl.isRepeatStatement(s)) {
      return walkStatementList(s.body.statements);
    }

    if (tstl.isForStatement(s)) {
      return walkStatementList(s.body.statements);
    }

    if (tstl.isForInStatement(s)) {
      return walkStatementList(s.body.statements);
    }

    // Other statement types: VariableDeclarationStatement, ReturnStatement, etc.
    // These don't directly contain the kinds of assignments we're checking for.
    return false;
  };

  return walkStatement(stmt);
}

/**
 * Check if statements contain a call to a non-stdlib function.
 * Calls to stdlib functions (math.ceil, etc.) are known to be safe and don't mutate globals.
 */
function hasNonStdlibCall(statements: tstl.Statement[]): boolean {
  let found = false;
  walkStatements(statements, {
    shallow: true,
    expr: (expr: tstl.Expression) => {
      if (tstl.isCallExpression(expr)) {
        if (isNonStdlibCall(expr.expression)) {
          found = true;
          return Walk.stop;
        }
      } else if (tstl.isMethodCallExpression(expr)) {
        // Method calls like obj:method() — always unsafe (could mutate obj)
        found = true;
        return Walk.stop;
      }
      return Walk.keep;
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

  // First pass: record access indices only
  for (const [index, statement] of statements.entries()) {
    if (!statementTouchesChain(statement, chain, shallow)) {
      continue;
    }

    if (firstAccessIndex === undefined) {
      firstAccessIndex = index;
    }
    lastAccessIndex = index;
  }

  // No accesses found
  if (firstAccessIndex === undefined || lastAccessIndex === undefined) {
    return false;
  }

  // Second pass: check safety at each access statement
  for (const [index, statement] of statements.entries()) {
    if (!statementTouchesChain(statement, chain, shallow)) {
      continue;
    }

    // Check for unsafe call before first chain access in this statement
    if (statementHasUnsafeCallBeforeFirstChainAccess(statement, chain, shallow)) {
      return true;
    }

    // Check for unsafe call after first chain access in this statement
    const afterFirstFlags = statementHasUnsafeCallAfterFirstChainAccess(statement, chain);
    if (afterFirstFlags.betweenAccesses) {
      // Call after first access, then another access in same statement — unsafe
      return true;
    }
    if (afterFirstFlags.afterFirst && index < lastAccessIndex) {
      // Call after first access in this statement, and there's a later statement with access
      return true;
    }
  }

  // Check for non-stdlib calls before the first access — hoisting via unshift() would place
  // the hoisted local above any pre-access call, capturing a potentially stale snapshot if
  // the call mutates the root. Calls to stdlib functions are known to be safe. Runs regardless
  // of whether reads are single- or multi-statement, since a pre-access call can still mutate
  // a chain read later in the first-access statement.
  if (hasNonStdlibCall(statements.slice(0, firstAccessIndex))) {
    return true;
  }

  // Check for chain mutations before the first read — if the chain is assigned before any
  // read, hoisting would snapshot the pre-mutation value and produce incorrect results.
  for (let index = 0; index < firstAccessIndex; index += 1) {
    if (statementAssignsToChain(statements[index], chain)) {
      return true;
    }
  }

  // Only perform multi-statement intervening checks if there are multiple access statements
  if (firstAccessIndex >= lastAccessIndex) {
    return false;
  }

  // Check if the first-access statement itself writes the chain. If so, any later read is stale.
  if (statementAssignsToChain(statements[firstAccessIndex], chain)) {
    return true;
  }

  // Check for intervening calls and mutations between first and last access.
  // Calls: start at firstAccessIndex + 1 (first-access statement's calls already vetted).
  // Assignments: start at firstAccessIndex + 1 (already checked above).
  for (let index = firstAccessIndex + 1; index < lastAccessIndex; index += 1) {
    if (hasCallExpression([statements[index]])) {
      return true;
    }
    if (statementAssignsToChain(statements[index], chain)) {
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
