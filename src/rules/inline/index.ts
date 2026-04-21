import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import {
  isRecord,
  type RuleFactory,
  resolveEffectiveStrict,
  resolveInlineConfig,
} from "../../config";
import {
  handleCallExpression,
  handleExpressionStatement,
  handleFunctionDeclaration,
  handleReturnStatement,
  handleVariableStatement,
  handleVariableStatementDeclaration,
} from "./handlers";

export { mapLuaStatements } from "./lua-substitute";

export const createVisitors: RuleFactory = (checker, config) => {
  const inlineCfg = resolveInlineConfig(config.rules.inline);
  if (!inlineCfg.enabled) return {};
  // Read per-rule strict directly from raw config to distinguish "not set" (undefined)
  // from "explicitly disabled" (false). resolveInlineConfig normalizes both to false.
  const rawInline = config.rules.inline;
  const perRuleStrict = isRecord(rawInline)
    ? typeof rawInline.strict === "boolean"
      ? rawInline.strict
      : undefined
    : undefined;
  const strictMode = resolveEffectiveStrict(config.strict ?? false, perRuleStrict);

  // Returning undefined signals "not handled" to the merge wrapper; the strict
  // tstl.Visitors type doesn't model this protocol, so we cast here.
  type LooseVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
  const visitors: Record<number, LooseVisitor> = {
    [ts.SyntaxKind.CallExpression]: (node, context) => {
      if (!ts.isCallExpression(node)) return undefined;
      return handleCallExpression(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.ExpressionStatement]: (node, context) => {
      if (!ts.isExpressionStatement(node)) return undefined;
      return handleExpressionStatement(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.VariableStatement]: (node, context) => {
      if (!ts.isVariableStatement(node)) return undefined;
      return (
        handleVariableStatement(node, checker, context, strictMode) ??
        handleVariableStatementDeclaration(node, checker)
      );
    },
    [ts.SyntaxKind.ReturnStatement]: (node, context) => {
      if (!ts.isReturnStatement(node)) return undefined;
      return handleReturnStatement(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.FunctionDeclaration]: (node) => {
      if (!ts.isFunctionDeclaration(node)) return undefined;
      return handleFunctionDeclaration(node, checker);
    },
  };
  return visitors as tstl.Visitors;
};
