import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import { isExplicitAmbientTopLevelDeclaration } from "../ast/ts-ambient";
import { type RuleFactory, resolveDebugStripConfig } from "../config";

function rootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return rootIdentifier(expr.expression);
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    return rootIdentifier(expr.expression);
  }
  return undefined;
}

function isAmbientTopLevelDeclaration(
  node: ts.VariableStatement | ts.FunctionDeclaration | ts.ModuleDeclaration,
): boolean {
  return node.getSourceFile().isDeclarationFile || isExplicitAmbientTopLevelDeclaration(node);
}

function isStripSafeGlobalDeclaration(declaration: ts.Declaration): boolean {
  if (ts.isVariableDeclaration(declaration)) {
    const statement = declaration.parent.parent;
    return ts.isVariableStatement(statement) && isAmbientTopLevelDeclaration(statement);
  }

  if (ts.isFunctionDeclaration(declaration) || ts.isModuleDeclaration(declaration)) {
    return isAmbientTopLevelDeclaration(declaration);
  }

  return false;
}

function isConfiguredGlobalIdentifier(
  identifier: ts.Identifier,
  configuredNames: ReadonlySet<string>,
  checker: ts.TypeChecker,
): boolean {
  if (!configuredNames.has(identifier.text)) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(identifier);
  // The name is already known to be configured for stripping. If symbol lookup fails
  // (e.g., an ambient or otherwise unresolved global), it is the very global the user asked
  // to strip, so treat it as a match and strip the call.
  if (symbol === undefined) {
    return true;
  }

  // Symbol resolved: only strip when every declaration is a strip-safe global. A local or
  // imported binding that shadows the configured name resolves here and is spared.
  return symbol.declarations?.every(isStripSafeGlobalDeclaration) ?? false;
}

function isStrippedCall(
  expr: ts.Expression,
  functions: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isCallExpression(expr)) {
    return false;
  }

  const callee = expr.expression;
  if (ts.isIdentifier(callee)) {
    return isConfiguredGlobalIdentifier(callee, functions, checker);
  }

  const root = rootIdentifier(callee);
  return root !== undefined && isConfiguredGlobalIdentifier(root, namespaces, checker);
}

export const createVisitors: RuleFactory = (checker, config) => {
  const resolved = resolveDebugStripConfig(config.rules["debug-strip"]);
  if (resolved === false || !resolved.enabled) return {};

  const functions: ReadonlySet<string> = new Set(resolved.functions);
  const namespaces: ReadonlySet<string> = new Set(resolved.namespaces);

  return {
    [ts.SyntaxKind.ExpressionStatement]: (
      node: ts.ExpressionStatement,
      context: tstl.TransformationContext,
    ) => {
      return isStrippedCall(node.expression, functions, namespaces, checker)
        ? []
        : context.superTransformStatements(node);
    },
  };
};
