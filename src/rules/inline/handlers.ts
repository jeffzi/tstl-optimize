import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import {
  buildDoEndBlock,
  buildReturnSiteInline,
  buildVarDeclInline,
  createDiscardTemp,
  inlineExpressionBody,
} from "./builders";
import { rejectIfCrossModuleFreeVar } from "./cross-module";
import { buildArrayDestructureInline, buildObjectDestructureInline } from "./destructure-builders";
import { createInlineWarning } from "./diagnostics";
import {
  canEraseInlineDeclaration,
  canInlineStatements,
  isExported,
  isModuleScopeDeclaration,
  isPureAtVoidSite,
} from "./eligibility";
import { getInlineTarget, hasInlineTag } from "./target";

export function handleCallExpression(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Expression | undefined {
  const result = getInlineTarget(node, checker);
  if (!result) return undefined;
  const { target } = result;

  if (target.kind === "statements" || target.kind === "statementsWithReturn") {
    // Suppress when the statement-level handler owns the diagnostic for this call site:
    //   - ExpressionStatement parent → handleExpressionStatement handles it
    //   - VariableDeclaration parent → handleVariableStatement handles it (statementsWithReturn only)
    //   - ReturnStatement parent → handleReturnStatement handles it (statementsWithReturn only)
    // NOTE: handleVariableStatement and handleReturnStatement only handle statementsWithReturn
    // targets, so suppress VariableDeclaration/ReturnStatement parents only for that target kind.
    const parentOwned =
      ts.isExpressionStatement(node.parent) ||
      (target.kind === "statementsWithReturn" &&
        (ts.isVariableDeclaration(node.parent) || ts.isReturnStatement(node.parent)));
    if (!parentOwned) {
      context.diagnostics.push(
        createInlineWarning(
          node,
          "multi-statement body cannot be inlined at expression position" +
            " (only statement-position calls supported)",
          strict,
        ),
      );
    }
    return undefined;
  }

  return inlineExpressionBody(target, node, checker, context, strict);
}

export function handleVariableStatement(
  node: ts.VariableStatement,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Statement[] | undefined {
  const decls = node.declarationList.declarations;
  if (decls.length !== 1) return undefined;

  const decl = decls[0];
  if (!decl.initializer || !ts.isCallExpression(decl.initializer)) return undefined;

  const callNode = decl.initializer;

  const result = getInlineTarget(callNode, checker);
  if (!result) return undefined;

  const { target } = result;

  // Only handle statementsWithReturn targets here.
  // expression-body targets are handled by the existing CallExpression visitor.
  // statements (void-body) targets at var-decl sites fall through to superTransformStatements.
  if (target.kind !== "statementsWithReturn") return undefined;

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  if (
    rejectIfCrossModuleFreeVar(
      callNode,
      target,
      [...target.bodyStmts, target.returnExpr],
      checker,
      context,
      strict,
    )
  ) {
    return undefined;
  }

  if (ts.isIdentifier(decl.name)) {
    return buildVarDeclInline(decl.name, target, callNode, checker, context);
  }

  if (ts.isObjectBindingPattern(decl.name)) {
    return buildObjectDestructureInline(decl.name, target, callNode, checker, context);
  }

  if (ts.isArrayBindingPattern(decl.name)) {
    return buildArrayDestructureInline(decl.name, target, callNode, checker, context);
  }

  return undefined;
}

export function handleReturnStatement(
  node: ts.ReturnStatement,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Statement[] | undefined {
  if (!node.expression || !ts.isCallExpression(node.expression)) return undefined;

  const callNode = node.expression;

  const result = getInlineTarget(callNode, checker);
  if (!result) return undefined;

  const { target } = result;

  if (target.kind !== "statementsWithReturn") return undefined;

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  if (
    rejectIfCrossModuleFreeVar(
      callNode,
      target,
      [...target.bodyStmts, target.returnExpr],
      checker,
      context,
      strict,
    )
  ) {
    return undefined;
  }

  return buildReturnSiteInline(target, callNode, checker, context);
}

export function handleExpressionStatement(
  node: ts.ExpressionStatement,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Statement[] | undefined {
  if (!ts.isCallExpression(node.expression)) return undefined;
  const callNode = node.expression;

  const result = getInlineTarget(callNode, checker);
  if (!result) return undefined;

  const { target } = result;

  if (target.kind === "expression") {
    const inlined = inlineExpressionBody(target, callNode, checker, context, strict);
    if (inlined === undefined) return undefined;
    // If the body and all arguments are pure, the result is unused at void site —
    // drop the statement entirely rather than emitting an invalid bare expression.
    if (isPureAtVoidSite(target.bodyExpr, callNode.arguments)) {
      return [];
    }
    // For side-effectful expressions, discard through a fresh temp so we preserve
    // evaluation without introducing a user-visible `_` binding.
    return [createDiscardTemp(context, inlined)];
  }

  if (target.kind === "statementsWithReturn") {
    context.diagnostics.push(
      createInlineWarning(callNode, "return-value function called at void site", strict),
    );
    return undefined;
  }

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  if (target.bodyStmts.length === 0) return [];

  if (rejectIfCrossModuleFreeVar(callNode, target, target.bodyStmts, checker, context, strict)) {
    return undefined;
  }

  return buildDoEndBlock(target, callNode, checker, context);
}

export function handleFunctionDeclaration(
  node: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
): tstl.Statement[] | undefined {
  if (
    hasInlineTag(node) &&
    isModuleScopeDeclaration(node) &&
    !isExported(node) &&
    canEraseInlineDeclaration(node, checker)
  ) {
    return [];
  }
  return undefined;
}

export function handleVariableStatementDeclaration(
  node: ts.VariableStatement,
  checker: ts.TypeChecker,
): tstl.Statement[] | undefined {
  const decls = node.declarationList.declarations;
  if (
    decls.length === 1 &&
    hasInlineTag(node) &&
    isModuleScopeDeclaration(decls[0]) &&
    !isExported(node) &&
    canEraseInlineDeclaration(decls[0], checker)
  ) {
    return [];
  }
  return undefined;
}
