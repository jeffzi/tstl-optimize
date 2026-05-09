import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import {
  buildDoEndBlock,
  buildReturnSiteInline,
  buildVarDeclInline,
  createDiscardTemp,
  inlineExpressionBody,
} from "./builders";
import type { LiteralKind } from "./const-literal";
import { classifyCrossModuleInline } from "./cross-module";
import { buildArrayDestructureInline, buildObjectDestructureInline } from "./destructure-builders";
import { createInlineWarning, InlineDiagnosticCode } from "./diagnostics";
import {
  canEraseInlineDeclaration,
  canInlineStatements,
  isExported,
  isModuleScopeDeclaration,
  isPureAtVoidSite,
} from "./eligibility";
import type { ReturnValueInlineTarget } from "./target";
import { getInlineTarget, hasInlineTag } from "./target";

function validateAndClassifyReturnValueInline(
  callNode: ts.CallExpression,
  target: ReturnValueInlineTarget,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): Map<ts.Symbol, LiteralKind> | undefined {
  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== undefined) {
    context.diagnostics.push(
      createInlineWarning(callNode, canInlineResult.reason, strict, canInlineResult.code),
    );
    return undefined;
  }

  const classification = classifyCrossModuleInline(
    callNode,
    target,
    [...target.bodyStmts, target.returnExpr],
    checker,
    context,
    strict,
  );
  if (classification.reject) {
    return undefined;
  }
  return classification.substitutions;
}

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
          InlineDiagnosticCode.expressionPosition,
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

  if (target.kind !== "statementsWithReturn") return undefined;

  const substitutions = validateAndClassifyReturnValueInline(
    callNode,
    target,
    checker,
    context,
    strict,
  );
  if (substitutions === undefined) return undefined;

  if (ts.isIdentifier(decl.name)) {
    return buildVarDeclInline(decl.name, target, callNode, checker, context, substitutions);
  }

  if (ts.isObjectBindingPattern(decl.name)) {
    return buildObjectDestructureInline(
      decl.name,
      target,
      callNode,
      checker,
      context,
      substitutions,
    );
  }

  if (ts.isArrayBindingPattern(decl.name)) {
    return buildArrayDestructureInline(
      decl.name,
      target,
      callNode,
      checker,
      context,
      substitutions,
    );
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

  const substitutions = validateAndClassifyReturnValueInline(
    callNode,
    target,
    checker,
    context,
    strict,
  );
  if (substitutions === undefined) return undefined;

  return buildReturnSiteInline(target, callNode, checker, context, substitutions);
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
      createInlineWarning(
        callNode,
        "return-value function called at void site",
        strict,
        InlineDiagnosticCode.voidSite,
      ),
    );
    return undefined;
  }

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== undefined) {
    context.diagnostics.push(
      createInlineWarning(callNode, canInlineResult.reason, strict, canInlineResult.code),
    );
    return undefined;
  }

  const classification = classifyCrossModuleInline(
    callNode,
    target,
    target.bodyStmts,
    checker,
    context,
    strict,
  );
  if (classification.reject) {
    return undefined;
  }
  const { substitutions } = classification;

  return buildDoEndBlock(target, callNode, checker, context, substitutions);
}

const INLINE_TAG_RE = /^\s*@inline\s*$/;

/**
 * Removes `@inline` entries from `leadingComments`, plus any orphaned LDoc separator (`"-"`)
 * left behind when the `@inline` tag was the only content. Returns `undefined` when nothing
 * remains so the printer emits no comment at all.
 *
 * TSTL's `Array<string | string[]>` comment type permits two shapes:
 * - A top-level `string` entry — the printer emits it as `--{entry}`.
 * - A top-level `string[]` entry — the printer emits it as a `--[[ … ]]` block comment.
 *
 * Both shapes are filtered:
 * - Top-level `string` matching `INLINE_TAG_RE` → entry dropped.
 * - Top-level `string[]` → inner strings matching `INLINE_TAG_RE` are removed; the nested
 *   array is dropped entirely if it becomes empty or contains only blank/separator strings.
 */
export function filterInlineComments(
  comments: Array<string | string[]> | undefined,
): Array<string | string[]> | undefined {
  if (comments === undefined) return undefined;

  const withoutTag = comments
    .map((c): string | string[] | undefined => {
      if (typeof c === "string") {
        return INLINE_TAG_RE.test(c) ? undefined : c;
      }
      // string[] — filter inner strings, drop the array if nothing meaningful survives
      const inner = c.filter((s) => !INLINE_TAG_RE.test(s) && s !== "");
      return inner.length === 0 ? undefined : inner;
    })
    .filter((c): c is string | string[] => c !== undefined);

  // Drop orphaned LDoc separators ("-") that were only meaningful as the leading
  // line of a JSDoc block whose sole content was the @inline tag.
  if (withoutTag.every((c) => (typeof c === "string" ? c === "-" : c.length === 0))) {
    return undefined;
  }
  return withoutTag.length === 0 ? undefined : withoutTag;
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
