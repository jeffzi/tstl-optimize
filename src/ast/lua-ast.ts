// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/**
 * Lua-side purity predicate for RHS safety gate.
 *
 * Returns true only if the expression cannot have side effects.
 * CallExpression, MethodCallExpression, and BinaryExpression are impure.
 * Note: the hasSideEffects function in src/ast/ts-ast.ts takes ts.Expression and cannot
 * be used here — this function runs post-transpile on tstl.Expression nodes only.
 */
export function isLuaRhsPure(expr: tstl.Expression): boolean {
  if (
    tstl.isNumericLiteral(expr) ||
    tstl.isStringLiteral(expr) ||
    tstl.isBooleanLiteral(expr) ||
    tstl.isNilLiteral(expr) ||
    tstl.isIdentifier(expr) ||
    tstl.isFunctionExpression(expr)
  ) {
    return true;
  }
  if (tstl.isTableExpression(expr)) {
    return expr.fields.every(
      (f) => isLuaRhsPure(f.value) && (f.key === undefined || isLuaRhsPure(f.key)),
    );
  }
  // CallExpression, MethodCallExpression, BinaryExpression, etc. — impure
  return false;
}

/**
 * Extended purity predicate that covers compound expressions.
 *
 * Extends isLuaRhsPure to cover syntactic wrappers and TSTL conditional expressions.
 * Lua unary and binary operators may dispatch metamethods, so they are not treated
 * as pure here.
 */
export function isLuaExprPure(expr: tstl.Expression): boolean {
  if (isLuaRhsPure(expr)) return true;
  if (tstl.isParenthesizedExpression(expr)) return isLuaExprPure(expr.expression);
  if (tstl.isConditionalExpression(expr)) {
    return (
      isLuaExprPure(expr.condition) && isLuaExprPure(expr.whenTrue) && isLuaExprPure(expr.whenFalse)
    );
  }
  return false;
}

/**
 * Extract statements from an else branch (either a Block or IfStatement).
 * If elseBlock is an IfStatement, returns it wrapped in an array.
 * If elseBlock is a Block, returns its statements array.
 */
export function getElseBranchStatements(
  elseBlock: tstl.Block | tstl.IfStatement,
): tstl.Statement[] {
  return tstl.isIfStatement(elseBlock) ? [elseBlock] : elseBlock.statements;
}

/**
 * Returns a mutable statement list for an if-statement's else branch.
 *
 * Bare `elseif` nodes are wrapped in a real Block so callers can prepend
 * declarations before the nested if statement and have those edits persist.
 */
export function getMutableElseBranchStatements(stmt: tstl.IfStatement): tstl.Statement[] {
  const { elseBlock } = stmt;
  if (!elseBlock) {
    throw new Error("getMutableElseBranchStatements requires an elseBlock");
  }
  if (tstl.isIfStatement(elseBlock)) {
    stmt.elseBlock = tstl.createBlock([elseBlock]);
    return stmt.elseBlock.statements;
  }
  return elseBlock.statements;
}
