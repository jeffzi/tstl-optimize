import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { type RuleFactory, resolveDebugStripConfig } from "../config";

function rootIdentifier(expr: tstl.Expression): tstl.Identifier | undefined {
  if (tstl.isIdentifier(expr)) return expr;
  if (tstl.isTableIndexExpression(expr)) return rootIdentifier(expr.table);
  return undefined;
}

function isStrippedCall(
  expr: tstl.Expression,
  functions: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  if (tstl.isCallExpression(expr)) {
    const callee = expr.expression;
    if (tstl.isIdentifier(callee)) {
      return functions.has(callee.text);
    }
    const root = rootIdentifier(callee);
    if (root) return namespaces.has(root.text);
  }
  if (tstl.isMethodCallExpression(expr)) {
    const root = rootIdentifier(expr.prefixExpression);
    if (root) return namespaces.has(root.text);
  }
  return false;
}

export const createVisitors: RuleFactory = (_checker, config) => {
  const resolved = resolveDebugStripConfig(config.rules["debug-strip"]);
  if (resolved === false) return {};

  const functions: ReadonlySet<string> = new Set(resolved.functions);
  const namespaces: ReadonlySet<string> = new Set(resolved.namespaces);

  return {
    [ts.SyntaxKind.ExpressionStatement]: (
      node: ts.ExpressionStatement,
      context: tstl.TransformationContext,
    ) => {
      const stmts = context.superTransformStatements(node);
      return stmts.filter(
        (stmt) =>
          !tstl.isExpressionStatement(stmt) ||
          !isStrippedCall(stmt.expression, functions, namespaces),
      );
    },
  };
};
