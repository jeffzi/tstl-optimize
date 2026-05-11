import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { hasSideEffects } from "../../ast/ts-ast";
import type { LiteralKind } from "./const-literal";
import { classifyCrossModuleInline } from "./cross-module";
import { createInlineWarning } from "./diagnostics";
import { canInline, needsEagerArgumentTemps } from "./eligibility";
import {
  clearExpressionPositions,
  clearNodePositions,
  needsParentheses,
  substituteParams,
  substituteParamsInStatements,
  walkLuaExpression,
  walkLuaNodes,
} from "./lua-substitute";
import { rewriteWithConstSubstitutions } from "./rewrite-body";
import type {
  ExpressionInlineTarget,
  ReturnValueInlineTarget,
  StatementInlineTarget,
} from "./target";
import { FUNCTION_SCOPE, returnsLuaMultiReturn } from "./target";

export interface ParamMapResult {
  tempDecls: tstl.VariableDeclarationStatement[];
  paramMap: Map<tstl.SymbolId, tstl.Expression>;
}

interface PreparedReturnValueInline {
  tempDecls: tstl.VariableDeclarationStatement[];
  substitutedBody: tstl.Statement[];
  substitutedReturn: tstl.Expression;
}

/**
 * Create a discard temp variable with collision-safe name for an unused inline result.
 * If expr is provided, assigns it; otherwise returns a bare decl for further use.
 */
export function createDiscardTemp(
  context: tstl.TransformationContext,
  expr?: tstl.Expression,
): tstl.VariableDeclarationStatement {
  const discardSymId = context.nextSymbolId();
  const discardIdent = tstl.createIdentifier(
    `____inline_result_${discardSymId}`,
    undefined,
    discardSymId,
  );
  // Defensive only: all current callers pass expr; the bare-decl branch is unreachable in tests
  /* v8 ignore next */
  return tstl.createVariableDeclarationStatement([discardIdent], expr ? [expr] : undefined);
}

/**
 * Stamp every position-less node in a statement list with the call expression's
 * source position.  Run this on the final result of each top-level inline builder
 * after substitution so that structural nodes (result decls, do…end, temp decls)
 * and any body nodes cleared by `clearNodePositions` are attributed to the call site.
 * Arg-expression nodes that carry the argument's own position are left untouched
 * because their `line` field is already set.
 */
export function stampCallSitePositions(stmts: tstl.Statement[], callNode: ts.CallExpression): void {
  walkLuaNodes(stmts, (n) => {
    if (n.line === undefined) tstl.setNodeOriginal(n, callNode);
  });
}

function stampCallSiteExpression(expr: tstl.Expression, callNode: ts.CallExpression): void {
  walkLuaExpression(expr, (n) => {
    if (n.line === undefined) tstl.setNodeOriginal(n, callNode);
  });
}

export function buildParamMap(
  params: readonly ts.ParameterDeclaration[],
  callArgs: ts.NodeArray<ts.Expression>,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): ParamMapResult | undefined {
  const tempDecls: tstl.VariableDeclarationStatement[] = [];
  const paramMap = new Map<tstl.SymbolId, tstl.Expression>();
  for (let i = 0; i < params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(params[i].name);
    if (!paramSymbol) return undefined;
    const paramSymbolId = context.symbolIdMaps.get(paramSymbol);
    const callArg = callArgs[i];
    if (callArg === undefined) {
      if (paramSymbolId !== undefined) {
        paramMap.set(paramSymbolId, tstl.createNilLiteral());
      }
      continue;
    }
    if (paramSymbolId === undefined) {
      if (hasSideEffects(callArg)) {
        tempDecls.push(createDiscardTemp(context, context.transformExpression(callArg)));
      }
      continue;
    }

    const tempId = context.nextSymbolId();
    const tempIdent = tstl.createIdentifier(`____inline_arg_${i}`, undefined, tempId);
    const luaArg = context.transformExpression(callArg);

    tempDecls.push(tstl.createVariableDeclarationStatement([tempIdent], [luaArg]));
    paramMap.set(paramSymbolId, tstl.createIdentifier(tempIdent.text, undefined, tempId));
  }
  return { tempDecls, paramMap };
}

function rewriteInlineNode<T extends ts.Node>(
  node: T,
  substitutions: Map<ts.Symbol, LiteralKind>,
  checker: ts.TypeChecker,
): T {
  return rewriteWithConstSubstitutions(node, substitutions, checker);
}

function rewriteInlineStatements(
  bodyStmts: readonly ts.Statement[],
  substitutions: Map<ts.Symbol, LiteralKind>,
  checker: ts.TypeChecker,
): readonly ts.Statement[] {
  return bodyStmts.map((stmt) => rewriteWithConstSubstitutions(stmt, substitutions, checker));
}

/** Run inline transforms in a fresh function scope so locals produce `local` in Lua. */
function transformInFunctionScope<T>(
  declaration: ts.Node,
  context: tstl.TransformationContext,
  transform: () => T,
): T {
  context.pushScope(FUNCTION_SCOPE, declaration);
  try {
    return transform();
  } finally {
    context.popScope();
  }
}

/** Transform body statements inside a fresh function scope so locals produce `local` in Lua. */
function transformBodyStatements(
  bodyStmts: readonly ts.Statement[],
  declaration: ts.Node,
  context: tstl.TransformationContext,
): tstl.Statement[] {
  const result = transformInFunctionScope(declaration, context, () =>
    bodyStmts.flatMap((s) => context.transformStatements(s)),
  );
  // Erase function-body TS positions so the post-stamp pass can attribute every
  // node to the call site instead.  Arg expressions (built separately in
  // buildParamMap) are not touched here and keep their original arg positions.
  clearNodePositions(result);
  return result;
}

interface TransformedInlineFunction {
  luaBody: tstl.Statement[];
  luaReturn: tstl.ReturnStatement;
}

export function transformInlineBodyAndReturn(
  bodyStmts: readonly ts.Statement[],
  returnExpr: ts.Expression,
  declaration: ts.Node,
  context: tstl.TransformationContext,
  checker: ts.TypeChecker,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
): TransformedInlineFunction | undefined {
  const rewrittenBodyStmts = rewriteInlineStatements(bodyStmts, substitutions, checker);
  const rewrittenReturnExpr = rewriteInlineNode(returnExpr, substitutions, checker);
  const returnStmt = createInlineReturnStatement(rewrittenReturnExpr);
  const { luaBody, luaReturnStmts } = transformInFunctionScope(declaration, context, () => ({
    luaBody: rewrittenBodyStmts.flatMap((s) => context.transformStatements(s)),
    luaReturnStmts: context.transformStatements(returnStmt),
  }));
  // Erase function-body positions so stampCallSitePositions can attribute every
  // body node to the call site.
  clearNodePositions(luaBody);
  clearNodePositions(luaReturnStmts);
  const luaReturn = luaReturnStmts.find(
    (stmt): stmt is tstl.ReturnStatement => stmt.kind === tstl.SyntaxKind.ReturnStatement,
  );
  return luaReturn ? { luaBody, luaReturn } : undefined;
}

function createInlineReturnStatement(returnExpr: ts.Expression): ts.ReturnStatement {
  const parent = returnExpr.parent;
  if (parent && ts.isReturnStatement(parent) && parent.expression === returnExpr) {
    return parent;
  }

  const syntheticReturn = ts.factory.createReturnStatement(returnExpr);
  ts.setOriginalNode(syntheticReturn, returnExpr);
  return ts.setTextRange(syntheticReturn, returnExpr);
}

export function prepareReturnValueInline(
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
): PreparedReturnValueInline | undefined {
  const { bodyStmts, params, declaration, returnExpr } = target;

  const rewrittenBodyStmts = rewriteInlineStatements(bodyStmts, substitutions, checker);
  const rewrittenReturnExpr = rewriteInlineNode(returnExpr, substitutions, checker);

  // Transform body and return expression first so ALL param symbols are registered
  // in context.symbolIdMaps before buildParamMap looks them up. A param that only
  // appears in the return expression (not in body statements) would be missing otherwise.
  const luaBody = transformBodyStatements(rewrittenBodyStmts, declaration, context);
  const luaReturnExpr = context.transformExpression(rewrittenReturnExpr);
  clearExpressionPositions(luaReturnExpr);

  const mapped = buildParamMap(params, callNode.arguments, checker, context);
  if (!mapped) return undefined;
  const { tempDecls, paramMap } = mapped;

  return {
    tempDecls,
    substitutedBody: substituteParamsInStatements(luaBody, paramMap),
    substitutedReturn: substituteParams(luaReturnExpr, paramMap),
  };
}

export function buildDoEndBlock(
  target: StatementInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;

  const rewrittenBodyStmts = rewriteInlineStatements(bodyStmts, substitutions, checker);

  // Transform body first so cross-module param symbols are registered in context.symbolIdMaps.
  const luaBody = transformBodyStatements(rewrittenBodyStmts, declaration, context);

  // If a lower-priority rule (e.g. conditional-compilation) stripped the body
  // to nothing, the params were never referenced and may lack Lua SymbolIds.
  // Short-circuit: emit only the side-effectful arg evaluations. This keeps
  // `canEraseInlineDeclaration` consistent with the Lua-phase outcome — the
  // call site is fully inlined and the declaration can be erased.
  if (luaBody.length === 0) {
    const effectfulArgs: tstl.Statement[] = [];
    for (const arg of callNode.arguments) {
      if (hasSideEffects(arg)) {
        effectfulArgs.push(createDiscardTemp(context, context.transformExpression(arg)));
      }
    }
    stampCallSitePositions(effectfulArgs, callNode);
    return effectfulArgs;
  }

  const mapped = buildParamMap(params, callNode.arguments, checker, context);
  if (!mapped) return undefined;
  const { tempDecls, paramMap } = mapped;

  const substituted = substituteParamsInStatements(luaBody, paramMap);

  const result = [...tempDecls, tstl.createDoStatement(substituted)];
  stampCallSitePositions(result, callNode);
  return result;
}

/**
 * Perform expression-body inlining for an expression-kind target.
 * Returns the substituted Lua expression, or undefined if inlining fails.
 * Emits diagnostics on failure when a reason is available.
 */
export function inlineExpressionBody(
  target: ExpressionInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Expression | undefined {
  const canInlineResult = canInline(target, callNode, checker);
  if (canInlineResult !== undefined) {
    context.diagnostics.push(
      createInlineWarning(callNode, canInlineResult.reason, strict, canInlineResult.code),
    );
    return undefined;
  }

  const classification = classifyCrossModuleInline(
    callNode,
    target,
    [target.bodyExpr],
    checker,
    context,
    strict,
  );
  if (classification.reject) {
    return undefined;
  }
  const { substitutions } = classification;

  const rewrittenExpr = rewriteInlineNode(target.bodyExpr, substitutions, checker);
  const luaBody = context.transformExpression(rewrittenExpr);
  clearExpressionPositions(luaBody);

  if (needsEagerArgumentTemps(target, callNode, checker)) {
    const mapped = buildParamMap(target.params, callNode.arguments, checker, context);
    if (!mapped) return undefined;

    const substituted = substituteParams(luaBody, mapped.paramMap);
    const callExpr = tstl.createCallExpression(
      tstl.createFunctionExpression(
        tstl.createBlock([...mapped.tempDecls, tstl.createReturnStatement([substituted])]),
      ),
      [],
    );
    stampCallSiteExpression(callExpr, callNode);
    return callExpr;
  }

  const paramMap = new Map<tstl.SymbolId, tstl.Expression>();
  for (let i = 0; i < target.params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(target.params[i].name);
    // Defensive only: canInline verified all param symbols resolve before we reach here
    /* v8 ignore next */
    if (!paramSymbol) return undefined;
    const symbolId = context.symbolIdMaps.get(paramSymbol);
    if (symbolId === undefined) continue;
    const callArg = callNode.arguments[i];
    if (callArg === undefined) {
      paramMap.set(symbolId, tstl.createNilLiteral());
      continue;
    }
    paramMap.set(symbolId, context.transformExpression(callArg));
  }

  const substituted = substituteParams(luaBody, paramMap);
  const result = needsParentheses(substituted)
    ? tstl.createParenthesizedExpression(substituted)
    : substituted;
  stampCallSiteExpression(result, callNode);
  return result;
}

function getStatementBody(stmt: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}

export function bodyDeclaresLocal(bodyStmts: readonly ts.Statement[], name: string): boolean {
  for (const stmt of bodyStmts) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return true;
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return true;
    if (ts.isBlock(stmt) && bodyDeclaresLocal(stmt.statements, name)) return true;
    if (ts.isIfStatement(stmt)) {
      if (bodyDeclaresLocal(getStatementBody(stmt.thenStatement), name)) return true;
      if (stmt.elseStatement && bodyDeclaresLocal(getStatementBody(stmt.elseStatement), name)) {
        return true;
      }
      continue;
    }
    if (
      ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt) ||
      ts.isForStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt)
    ) {
      if (bodyDeclaresLocal(getStatementBody(stmt.statement), name)) return true;
      continue;
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        if (bodyDeclaresLocal(clause.statements, name)) return true;
      }
      continue;
    }
    if (ts.isTryStatement(stmt)) {
      if (bodyDeclaresLocal(stmt.tryBlock.statements, name)) return true;
      if (stmt.catchClause && bodyDeclaresLocal(stmt.catchClause.block.statements, name))
        return true;
      if (stmt.finallyBlock && bodyDeclaresLocal(stmt.finallyBlock.statements, name)) return true;
      continue;
    }
    /* v8 ignore start */
    if (ts.isLabeledStatement(stmt)) {
      // Defensive only: current TSTL rejects labeled statements end-to-end, but
      // preserve their scope interactions if one reaches this analysis.
      if (bodyDeclaresLocal(getStatementBody(stmt.statement), name)) return true;
    }
    /* v8 ignore stop */
  }
  return false;
}

export function buildVarDeclInline(
  nameIdent: ts.Identifier,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
): tstl.Statement[] | undefined {
  const { bodyStmts } = target;

  // Allocate a fresh Lua symbolId for the result variable. We cannot use
  // context.symbolIdMaps.get() here because TSTL hasn't transformed this
  // VariableStatement yet — the result symbol has no Lua symbolId assigned.
  const resultSymId = context.nextSymbolId();

  // When the inlined body declares a local with the same name as the call-site
  // binding, use a collision-safe temp name inside the do...end block and rebind
  // the original name after to avoid the inner local shadowing the result variable.
  const needsTempName = bodyDeclaresLocal(bodyStmts, nameIdent.text);
  const resultName = needsTempName ? `____inline_result_${resultSymId}` : nameIdent.text;
  const resultIdent = tstl.createIdentifier(resultName, undefined, resultSymId);
  const resultDecl = tstl.createVariableDeclarationStatement([resultIdent]);

  const prepared = prepareReturnValueInline(target, callNode, checker, context, substitutions);
  if (!prepared) return undefined;
  const { tempDecls, substitutedBody, substitutedReturn } = prepared;

  const assignResult = tstl.createAssignmentStatement([resultIdent], [substitutedReturn]);

  const doEnd = tstl.createDoStatement([...substitutedBody, assignResult]);

  let result: tstl.Statement[];
  if (needsTempName) {
    // Register the call-site variable in symbolIdMaps before dead-local analysis.
    // Without this, dead-local sees the binding as unread and removes it.
    const nameSymbol = checker.getSymbolAtLocation(nameIdent);
    /* v8 ignore next */
    if (!nameSymbol) return undefined;
    const bindingSymId = context.nextSymbolId();
    context.symbolIdMaps.set(nameSymbol, bindingSymId);
    const bindingDecl = tstl.createVariableDeclarationStatement(
      [tstl.createIdentifier(nameIdent.text, undefined, bindingSymId)],
      [tstl.createIdentifier(resultIdent.text, undefined, resultSymId)],
    );
    result = [resultDecl, ...tempDecls, doEnd, bindingDecl];
  } else {
    result = [resultDecl, ...tempDecls, doEnd];
  }
  stampCallSitePositions(result, callNode);
  return result;
}

export function buildReturnSiteInline(
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;
  const isMultiReturn = returnsLuaMultiReturn(declaration, callNode, checker);
  if (isMultiReturn) {
    const transformed = transformInlineBodyAndReturn(
      bodyStmts,
      target.returnExpr,
      declaration,
      context,
      checker,
      substitutions,
    );
    if (!transformed) return undefined;
    const { luaBody, luaReturn } = transformed;

    const mapped = buildParamMap(params, callNode.arguments, checker, context);
    // Defensive only: buildParamMap only fails when a param symbol can't be resolved,
    // which canInlineStatements would have rejected first
    /* v8 ignore next */
    if (!mapped) return undefined;
    const { tempDecls, paramMap } = mapped;
    const substitutedBody = substituteParamsInStatements(luaBody, paramMap);

    const substitutedReturns = luaReturn.expressions.map((expr) =>
      substituteParams(expr, paramMap),
    );
    const multiResult = [
      ...tempDecls,
      ...substitutedBody,
      tstl.createReturnStatement(substitutedReturns),
    ];
    stampCallSitePositions(multiResult, callNode);
    return multiResult;
  }

  const prepared = prepareReturnValueInline(target, callNode, checker, context, substitutions);
  if (!prepared) return undefined;
  const { tempDecls, substitutedBody, substitutedReturn } = prepared;

  const result = [
    ...tempDecls,
    ...substitutedBody,
    tstl.createReturnStatement([substitutedReturn]),
  ];
  stampCallSitePositions(result, callNode);
  return result;
}
