import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { buildParamMap, prepareReturnValueInline, transformInlineBodyAndReturn } from "./builders";
import { substituteParams, substituteParamsInStatements } from "./lua-substitute";
import type { ReturnValueInlineTarget } from "./target";

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
): DestructureShared | undefined {
  const resultSymId = context.nextSymbolId();
  const resultIdent = tstl.createIdentifier(
    `____inline_result_${resultSymId}`,
    undefined,
    resultSymId,
  );
  const resultDecl = tstl.createVariableDeclarationStatement([resultIdent]);

  const prepared = prepareReturnValueInline(target, callNode, checker, context);
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
): tstl.Statement[] | undefined {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return undefined;
    if (!ts.isIdentifier(element.name)) return undefined;
    if (element.initializer) return undefined;
  }

  const shared = buildDestructureShared(target, callNode, checker, context);
  if (!shared) return undefined;
  const { resultIdent, resultSymId, resultDecl, tempDecls, doEnd } = shared;

  const fieldDecls: tstl.VariableDeclarationStatement[] = [];
  for (const element of pattern.elements) {
    const bindingName = element.name as ts.Identifier;
    const keyNode = element.propertyName ?? element.name;
    if (!ts.isIdentifier(keyNode)) return undefined;

    const bindingSymId = context.nextSymbolId();
    const localIdent = tstl.createIdentifier(bindingName.text, undefined, bindingSymId);

    const fieldAccess = tstl.createTableIndexExpression(
      tstl.createIdentifier(resultIdent.text, undefined, resultSymId),
      tstl.createStringLiteral(keyNode.text),
    );

    fieldDecls.push(tstl.createVariableDeclarationStatement([localIdent], [fieldAccess]));
  }

  return [resultDecl, ...tempDecls, doEnd, ...fieldDecls];
}

export function buildArrayDestructureInline(
  pattern: ts.ArrayBindingPattern,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) return undefined;
    if (element.dotDotDotToken) return undefined;
    if (!ts.isIdentifier(element.name)) return undefined;
    if (element.initializer) return undefined;
  }

  const signature = checker.getResolvedSignature(callNode);
  /* v8 ignore next */
  const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  const isMultiReturn =
    returnType?.symbol?.name === "LuaMultiReturn" ||
    returnType?.aliasSymbol?.name === "LuaMultiReturn";

  const bindingIdents: tstl.Identifier[] = pattern.elements
    .filter((e): e is ts.BindingElement => !ts.isOmittedExpression(e))
    .map((element) => {
      const bindingSymId = context.nextSymbolId();
      return tstl.createIdentifier((element.name as ts.Identifier).text, undefined, bindingSymId);
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

    return [...resultDecls, ...tempDecls, doEnd, finalDecl];
  }

  const shared = buildDestructureShared(target, callNode, checker, context);
  if (!shared) return undefined;
  const { resultIdent, resultSymId, resultDecl, tempDecls, doEnd } = shared;

  const unpackCall = tstl.createCallExpression(tstl.createIdentifier("unpack"), [
    tstl.createIdentifier(resultIdent.text, undefined, resultSymId),
    tstl.createNumericLiteral(1),
    tstl.createNumericLiteral(pattern.elements.length),
  ]);

  return [
    resultDecl,
    ...tempDecls,
    doEnd,
    tstl.createVariableDeclarationStatement(bindingIdents, [unpackCall]),
  ];
}
