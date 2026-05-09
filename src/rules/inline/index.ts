import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import {
  isRecord,
  type RuleFactory,
  resolveEffectiveStrict,
  resolveInlineConfig,
} from "../../config";
import {
  filterInlineComments,
  handleCallExpression,
  handleExpressionStatement,
  handleFunctionDeclaration,
  handleReturnStatement,
  handleVariableStatement,
  handleVariableStatementDeclaration,
} from "./handlers";
import { hasInlineTag } from "./target";

export { mapLuaStatements } from "./lua-substitute";

/**
 * Strip `@inline` from a statement array's leadingComments in-place.
 *
 * Called after `context.superTransformStatements` to prevent the printer from
 * emitting `-- @inline` lines that shift sourcemap entries for declarations
 * that are kept (not erased) because they can't be fully eliminated.
 */
function stripInlineComments(stmts: tstl.Statement[]): void {
  for (const stmt of stmts) {
    stmt.leadingComments = filterInlineComments(stmt.leadingComments);
  }
}

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
      const callSiteResult = handleVariableStatement(node, checker, context, strictMode);
      if (callSiteResult !== undefined) return callSiteResult;
      const declResult = handleVariableStatementDeclaration(node, checker);
      if (declResult !== undefined) return declResult; // erased (return [])
      // Non-erased @inline declaration: transform with TSTL default, then strip
      // the @inline comment so the printer never emits lines that shift sourcemap entries.
      if (hasInlineTag(node)) {
        const stmts = context.superTransformStatements(node);
        stripInlineComments(stmts);
        return stmts;
      }
      return undefined;
    },
    [ts.SyntaxKind.ReturnStatement]: (node, context) => {
      if (!ts.isReturnStatement(node)) return undefined;
      return handleReturnStatement(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.FunctionDeclaration]: (node, context) => {
      if (!ts.isFunctionDeclaration(node)) return undefined;
      const result = handleFunctionDeclaration(node, checker);
      if (result !== undefined) return result; // erased (return [])
      // Non-erased @inline declaration: transform with TSTL default, then strip the comment.
      if (hasInlineTag(node)) {
        const stmts = context.superTransformStatements(node);
        stripInlineComments(stmts);
        return stmts;
      }
      return undefined;
    },
  };
  return visitors as tstl.Visitors;
};
