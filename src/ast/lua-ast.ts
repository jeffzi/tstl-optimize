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
  if (tstl.isNumericLiteral(expr)) return true;
  if (tstl.isStringLiteral(expr)) return true;
  if (tstl.isBooleanLiteral(expr)) return true;
  if (tstl.isNilLiteral(expr)) return true;
  if (tstl.isIdentifier(expr)) return true;
  if (tstl.isFunctionExpression(expr)) return true;
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
): readonly tstl.Statement[] {
  return tstl.isIfStatement(elseBlock) ? [elseBlock] : elseBlock.statements;
}
