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
