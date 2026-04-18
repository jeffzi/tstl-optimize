import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { hasSideEffects } from "../../ast/ts-ast";
import { rejectIfCrossModuleFreeVar } from "./cross-module";
import { createInlineWarning } from "./diagnostics";
import { canInline, needsEagerArgumentTemps } from "./eligibility";
import { needsParentheses, substituteParams, substituteParamsInStatements } from "./lua-substitute";
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
  /* v8 ignore next */
  return tstl.createVariableDeclarationStatement([discardIdent], expr ? [expr] : undefined);
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
    if (paramSymbolId === undefined) continue;
    const luaArg = context.transformExpression(callArgs[i]);
    const tempId = context.nextSymbolId();
    const tempIdent = tstl.createIdentifier(`____inline_arg_${i}`, undefined, tempId);
    tempDecls.push(tstl.createVariableDeclarationStatement([tempIdent], [luaArg]));
    paramMap.set(paramSymbolId, tstl.createIdentifier(tempIdent.text, undefined, tempId));
  }
  return { tempDecls, paramMap };
}

/** Transform body statements inside a fresh function scope so locals produce `local` in Lua. */
function transformBodyStatements(
  bodyStmts: readonly ts.Statement[],
  declaration: ts.Node,
  context: tstl.TransformationContext,
): tstl.Statement[] {
  context.pushScope(FUNCTION_SCOPE, declaration);
  try {
    return bodyStmts.flatMap((s) => context.transformStatements(s));
  } finally {
    context.popScope();
  }
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
): TransformedInlineFunction | undefined {
  const returnStmt = createInlineReturnStatement(returnExpr);
  context.pushScope(FUNCTION_SCOPE, declaration);
  let luaBody: tstl.Statement[];
  let luaReturnStmts: tstl.Statement[];
  try {
    luaBody = bodyStmts.flatMap((s) => context.transformStatements(s));
    luaReturnStmts = context.transformStatements(returnStmt);
  } finally {
    context.popScope();
  }
  const luaReturn = luaReturnStmts.find(
    (stmt): stmt is tstl.ReturnStatement => stmt.kind === tstl.SyntaxKind.ReturnStatement,
  );
  return luaReturn ? { luaBody, luaReturn } : undefined;
}

function createInlineReturnStatement(returnExpr: ts.Expression): ts.ReturnStatement {
  const parent = returnExpr.parent;
  if (ts.isReturnStatement(parent) && parent.expression === returnExpr) {
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
): PreparedReturnValueInline | undefined {
  const { bodyStmts, params, declaration, returnExpr } = target;

  // Transform body and return expression first so ALL param symbols are registered
  // in context.symbolIdMaps before buildParamMap looks them up. A param that only
  // appears in the return expression (not in body statements) would be missing otherwise.
  const luaBody = transformBodyStatements(bodyStmts, declaration, context);
  const luaReturnExpr = context.transformExpression(returnExpr);

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
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;

  // Transform body first so cross-module param symbols are registered in context.symbolIdMaps.
  const luaBody = transformBodyStatements(bodyStmts, declaration, context);

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
    return effectfulArgs;
  }

  const mapped = buildParamMap(params, callNode.arguments, checker, context);
  if (!mapped) return undefined;
  const { tempDecls, paramMap } = mapped;

  const substituted = substituteParamsInStatements(luaBody, paramMap);

  return [...tempDecls, tstl.createDoStatement(substituted)];
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

  const luaBody = context.transformExpression(target.bodyExpr);

  if (rejectIfCrossModuleFreeVar(callNode, target, [target.bodyExpr], checker, context, strict)) {
    return undefined;
  }

  if (needsEagerArgumentTemps(target, callNode, checker)) {
    const mapped = buildParamMap(target.params, callNode.arguments, checker, context);
    if (!mapped) return undefined;

    const substituted = substituteParams(luaBody, mapped.paramMap);
    return tstl.createCallExpression(
      tstl.createFunctionExpression(
        tstl.createBlock([...mapped.tempDecls, tstl.createReturnStatement([substituted])]),
      ),
      [],
    );
  }

  const paramMap = new Map<tstl.SymbolId, tstl.Expression>();
  for (let i = 0; i < target.params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(target.params[i].name);
    /* v8 ignore next */
    if (!paramSymbol) return undefined;
    const symbolId = context.symbolIdMaps.get(paramSymbol);
    if (symbolId === undefined) continue;
    const luaArg = context.transformExpression(callNode.arguments[i]);
    paramMap.set(symbolId, luaArg);
  }

  const substituted = substituteParams(luaBody, paramMap);
  return needsParentheses(substituted)
    ? tstl.createParenthesizedExpression(substituted)
    : substituted;
}

export function bodyDeclaresLocal(bodyStmts: readonly ts.Statement[], name: string): boolean {
  for (const stmt of bodyStmts) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return true;
      }
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return true;
    if (ts.isBlock(stmt) && bodyDeclaresLocal(stmt.statements, name)) return true;
    if (ts.isIfStatement(stmt)) {
      const thenStatements = ts.isBlock(stmt.thenStatement)
        ? stmt.thenStatement.statements
        : [stmt.thenStatement];
      if (bodyDeclaresLocal(thenStatements, name)) return true;
      if (stmt.elseStatement) {
        const elseStatements = ts.isBlock(stmt.elseStatement)
          ? stmt.elseStatement.statements
          : [stmt.elseStatement];
        if (bodyDeclaresLocal(elseStatements, name)) return true;
      }
    }
    if (
      (ts.isWhileStatement(stmt) ||
        ts.isDoStatement(stmt) ||
        ts.isForStatement(stmt) ||
        ts.isForInStatement(stmt) ||
        ts.isForOfStatement(stmt)) &&
      bodyDeclaresLocal(
        ts.isBlock(stmt.statement) ? stmt.statement.statements : [stmt.statement],
        name,
      )
    ) {
      return true;
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        if (bodyDeclaresLocal(clause.statements, name)) return true;
      }
    }
    if (ts.isTryStatement(stmt)) {
      if (bodyDeclaresLocal(stmt.tryBlock.statements, name)) return true;
      if (stmt.catchClause && bodyDeclaresLocal(stmt.catchClause.block.statements, name))
        return true;
      if (stmt.finallyBlock && bodyDeclaresLocal(stmt.finallyBlock.statements, name)) return true;
    }
    /* v8 ignore start */
    if (
      // Defensive only: current TSTL rejects labeled statements end-to-end, but
      // preserve their scope interactions if one reaches this analysis.
      ts.isLabeledStatement(stmt) &&
      bodyDeclaresLocal(
        ts.isBlock(stmt.statement) ? stmt.statement.statements : [stmt.statement],
        name,
      )
    ) {
      return true;
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
): tstl.Statement[] | undefined {
  const { bodyStmts } = target;

  // Allocate a fresh Lua symbolId for the result variable. We cannot use
  // context.symbolIdMaps.get() here because TSTL hasn't transformed this
  // VariableStatement yet — the result symbol has no Lua symbolId assigned.
  const resultSymId = context.nextSymbolId();

  // When the inlined body declares a local with the same name as the call-site
  // binding, the inner local would shadow the result variable inside the do...end
  // block, turning the return assignment into a no-op. Use a collision-safe temp
  // name in that case and re-bind the user's name after the do...end block.
  const needsTempName = bodyDeclaresLocal(bodyStmts, nameIdent.text);
  const resultName = needsTempName ? `____inline_result_${resultSymId}` : nameIdent.text;
  const resultIdent = tstl.createIdentifier(resultName, undefined, resultSymId);
  const resultDecl = tstl.createVariableDeclarationStatement([resultIdent]);

  const prepared = prepareReturnValueInline(target, callNode, checker, context);
  if (!prepared) return undefined;
  const { tempDecls, substitutedBody, substitutedReturn } = prepared;

  const assignResult = tstl.createAssignmentStatement(
    [tstl.createIdentifier(resultIdent.text, undefined, resultSymId)],
    [substitutedReturn],
  );

  const doEnd = tstl.createDoStatement([...substitutedBody, assignResult]);

  if (needsTempName) {
    const bindingSymId = context.nextSymbolId();
    const bindingDecl = tstl.createVariableDeclarationStatement(
      [tstl.createIdentifier(nameIdent.text, undefined, bindingSymId)],
      [tstl.createIdentifier(resultIdent.text, undefined, resultSymId)],
    );
    return [resultDecl, ...tempDecls, doEnd, bindingDecl];
  }
  return [resultDecl, ...tempDecls, doEnd];
}

export function buildReturnSiteInline(
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;
  const isMultiReturn = returnsLuaMultiReturn(declaration, callNode, checker);
  if (isMultiReturn) {
    const transformed = transformInlineBodyAndReturn(
      bodyStmts,
      target.returnExpr,
      declaration,
      context,
    );
    if (!transformed) return undefined;
    const { luaBody, luaReturn } = transformed;

    const mapped = buildParamMap(params, callNode.arguments, checker, context);
    /* v8 ignore next */
    if (!mapped) return undefined;
    const { tempDecls, paramMap } = mapped;
    const substitutedBody = substituteParamsInStatements(luaBody, paramMap);

    const substitutedReturns = luaReturn.expressions.map((expr) =>
      substituteParams(expr, paramMap),
    );
    return [...tempDecls, ...substitutedBody, tstl.createReturnStatement(substitutedReturns)];
  }

  const prepared = prepareReturnValueInline(target, callNode, checker, context);
  if (!prepared) return undefined;
  const { tempDecls, substitutedBody, substitutedReturn } = prepared;

  return [...tempDecls, ...substitutedBody, tstl.createReturnStatement([substitutedReturn])];
}
