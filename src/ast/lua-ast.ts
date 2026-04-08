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
 * Extends isLuaRhsPure to classify UnaryExpression, BinaryExpression, and
 * ParenthesizedExpression as pure when their sub-expressions are pure. Lua has
 * no operator overloading, so these operators are always side-effect-free.
 */
export function isLuaExprPure(expr: tstl.Expression): boolean {
  if (isLuaRhsPure(expr)) return true;
  if (tstl.isUnaryExpression(expr)) return isLuaExprPure(expr.operand);
  if (tstl.isBinaryExpression(expr)) return isLuaExprPure(expr.left) && isLuaExprPure(expr.right);
  if (tstl.isParenthesizedExpression(expr)) return isLuaExprPure(expr.expression);
  return false;
}
