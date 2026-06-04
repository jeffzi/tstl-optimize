import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import {
  buildParamMap,
  prepareReturnValueInline,
  stampCallSitePositions,
  transformInlineBodyAndReturn,
} from "./builders";
import type { ImportBinding, LiteralKind } from "./const-literal";
import { substituteParams, substituteParamsInStatements } from "./lua-substitute";
import { type ReturnValueInlineTarget, returnsLuaMultiReturn } from "./target";

interface DestructureShared {
  resultIdent: tstl.Identifier;
  resultSymId: tstl.SymbolId;
  resultDecl: tstl.VariableDeclarationStatement;
  tempDecls: tstl.VariableDeclarationStatement[];
  doEnd: tstl.DoStatement;
}

/**
 * Shared setup for both object and array destructuring inline targets:
 * allocates a result identifier, transforms the body, builds the param map,
 * substitutes params, and wraps the body + result assignment in a do...end.
 * Returns undefined if param-map construction fails.
 */
function buildDestructureShared(
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
  imports?: ReadonlyMap<ts.Symbol, ImportBinding>,
): DestructureShared | undefined {
  const resultSymId = context.nextSymbolId();
  const resultIdent = tstl.createIdentifier(
    `____inline_result_${resultSymId}`,
    undefined,
    resultSymId,
  );
  const resultDecl = tstl.createVariableDeclarationStatement([resultIdent]);

  const prepared = prepareReturnValueInline(
    target,
    callNode,
    checker,
    context,
    substitutions,
    imports,
  );
  if (!prepared) return undefined;
  const { tempDecls, substitutedBody, substitutedReturn } = prepared;

  const assignResult = tstl.createAssignmentStatement(
    [tstl.createIdentifier(resultIdent.text, undefined, resultSymId)],
    [substitutedReturn],
  );
  const doEnd = tstl.createDoStatement([...substitutedBody, assignResult]);

  return { resultIdent, resultSymId, resultDecl, tempDecls, doEnd };
}

export function buildObjectDestructureInline(
  pattern: ts.ObjectBindingPattern,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
  imports?: ReadonlyMap<ts.Symbol, ImportBinding>,
): tstl.Statement[] | undefined {
  const bindings: { bindingName: ts.Identifier; keyNode: ts.Identifier }[] = [];
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return undefined;
    if (!ts.isIdentifier(element.name)) return undefined;
    if (element.initializer) return undefined;

    const keyNode = element.propertyName ?? element.name;
    if (!ts.isIdentifier(keyNode)) return undefined;

    bindings.push({ bindingName: element.name, keyNode });
  }

  const shared = buildDestructureShared(target, callNode, checker, context, substitutions, imports);
  if (!shared) return undefined;
  const { resultIdent, resultSymId, resultDecl, tempDecls, doEnd } = shared;

  const fieldDecls: tstl.VariableDeclarationStatement[] = [];
  for (const { bindingName, keyNode } of bindings) {
    const bindingSymId = context.nextSymbolId();
    const localIdent = tstl.createIdentifier(bindingName.text, undefined, bindingSymId);

    const fieldAccess = tstl.createTableIndexExpression(
      tstl.createIdentifier(resultIdent.text, undefined, resultSymId),
      tstl.createStringLiteral(keyNode.text),
    );

    fieldDecls.push(tstl.createVariableDeclarationStatement([localIdent], [fieldAccess]));
  }

  const result = [resultDecl, ...tempDecls, doEnd, ...fieldDecls];
  stampCallSitePositions(result, callNode);
  return result;
}

export function buildArrayDestructureInline(
  pattern: ts.ArrayBindingPattern,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  substitutions: Map<ts.Symbol, LiteralKind> = new Map(),
  imports?: ReadonlyMap<ts.Symbol, ImportBinding>,
): tstl.Statement[] | undefined {
  const bindingNames: ts.Identifier[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) return undefined;
    if (element.dotDotDotToken) return undefined;
    if (!ts.isIdentifier(element.name)) return undefined;
    if (element.initializer) return undefined;

    bindingNames.push(element.name);
  }

  const isMultiReturn = returnsLuaMultiReturn(target.declaration, callNode, checker);

  const bindingIdents: tstl.Identifier[] = bindingNames.map((bindingName) => {
    const bindingSymId = context.nextSymbolId();
    return tstl.createIdentifier(bindingName.text, undefined, bindingSymId);
  });

  if (isMultiReturn) {
    const { bodyStmts, params, declaration } = target;

    const resultIdents: tstl.Identifier[] = [];
    const resultDecls: tstl.VariableDeclarationStatement[] = [];
    for (let i = 0; i < pattern.elements.length; i++) {
      const symId = context.nextSymbolId();
      const ident = tstl.createIdentifier(`____inline_result_${symId}`, undefined, symId);
      resultIdents.push(ident);
      resultDecls.push(tstl.createVariableDeclarationStatement([ident]));
    }

    // Transform body AND the return statement inside a function scope so TSTL
    // handles $multi correctly ($multi must appear in return-statement context)
    // and all param symbols get registered in context.symbolIdMaps.
    const transformed = transformInlineBodyAndReturn(
      bodyStmts,
      target.returnExpr,
      declaration,
      context,
      checker,
      substitutions,
      imports,
    );
    if (!transformed) return undefined;
    const { luaBody, luaReturn } = transformed;
    const luaReturnExprs = luaReturn.expressions;

    const mapped = buildParamMap(params, callNode.arguments, checker, context);
    if (!mapped) return undefined;
    const { tempDecls, paramMap } = mapped;

    const substitutedBody = substituteParamsInStatements(luaBody, paramMap);
    const substitutedReturns = luaReturnExprs.map((expr) => substituteParams(expr, paramMap));

    const assignResult = tstl.createAssignmentStatement(
      resultIdents.map((id) => tstl.createIdentifier(id.text, undefined, id.symbolId)),
      substitutedReturns,
    );
    const doEnd = tstl.createDoStatement([...substitutedBody, assignResult]);

    const finalDecl = tstl.createVariableDeclarationStatement(
      bindingIdents,
      resultIdents.map((id) => tstl.createIdentifier(id.text, undefined, id.symbolId)),
    );

    const multiResult = [...resultDecls, ...tempDecls, doEnd, finalDecl];
    stampCallSitePositions(multiResult, callNode);
    return multiResult;
  }

  const shared = buildDestructureShared(target, callNode, checker, context, substitutions, imports);
  if (!shared) return undefined;
  const { resultIdent, resultSymId, resultDecl, tempDecls, doEnd } = shared;

  const unpackCall = tstl.createCallExpression(tstl.createIdentifier("unpack"), [
    tstl.createIdentifier(resultIdent.text, undefined, resultSymId),
    tstl.createNumericLiteral(1),
    tstl.createNumericLiteral(pattern.elements.length),
  ]);

  const result = [
    resultDecl,
    ...tempDecls,
    doEnd,
    tstl.createVariableDeclarationStatement(bindingIdents, [unpackCall]),
  ];
  stampCallSitePositions(result, callNode);
  return result;
}
