import ts from "typescript";
import type * as tstl from "typescript-to-lua";

// ScopeType.Function = 2 (not re-exported from the public TSTL API)
type PushScopeKind = Parameters<tstl.TransformationContext["pushScope"]>[0];
export const FUNCTION_SCOPE: PushScopeKind = 2;

export interface ExpressionInlineTarget {
  kind: "expression";
  bodyExpr: ts.Expression;
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

export interface StatementInlineTarget {
  kind: "statements";
  bodyStmts: readonly ts.Statement[];
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

export interface ReturnValueInlineTarget {
  kind: "statementsWithReturn";
  bodyStmts: readonly ts.Statement[];
  returnExpr: ts.Expression;
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

export type InlineTarget = ExpressionInlineTarget | StatementInlineTarget | ReturnValueInlineTarget;

function hasLuaMultiReturnTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  return (
    typeNode !== undefined &&
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "LuaMultiReturn"
  );
}

export function declarationHasLuaMultiReturnReturnType(declaration: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration)
  ) {
    return hasLuaMultiReturnTypeNode(declaration.type);
  }

  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return hasLuaMultiReturnTypeNode(declaration.initializer.type);
  }

  return false;
}

export function hasInlineTag(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === "inline");
}

type ClassifiedBody =
  | { kind: "expression"; expr: ts.Expression }
  | { kind: "statements"; stmts: readonly ts.Statement[] }
  | { kind: "statementsWithReturn"; stmts: readonly ts.Statement[]; returnExpr: ts.Expression };

function classifyBody(
  func: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): ClassifiedBody | undefined {
  if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) {
    return { kind: "expression", expr: func.body };
  }

  const body = func.body;
  if (!body || !ts.isBlock(body)) return undefined;
  if (body.statements.length === 0) return undefined;

  const { statements } = body;
  if (statements.length === 1) {
    const stmt = statements[0];
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      return { kind: "expression", expr: stmt.expression };
    }
  }

  const lastStmt = statements[statements.length - 1];
  if (ts.isReturnStatement(lastStmt) && lastStmt.expression) {
    return {
      kind: "statementsWithReturn",
      stmts: statements.slice(0, -1),
      returnExpr: lastStmt.expression,
    };
  }

  return { kind: "statements", stmts: statements };
}

export type InlineTargetResult = { target: InlineTarget } | undefined;

function makeTargetResult(
  classified: ClassifiedBody | undefined,
  params: readonly ts.ParameterDeclaration[],
  declaration: ts.Node,
  resolvedSymbol: ts.Symbol,
): { target: InlineTarget } {
  if (!classified) {
    return { target: { kind: "statements", bodyStmts: [], params, declaration, resolvedSymbol } };
  }
  if (classified.kind === "statements") {
    return {
      target: {
        kind: "statements",
        bodyStmts: classified.stmts,
        params,
        declaration,
        resolvedSymbol,
      },
    };
  }
  if (classified.kind === "statementsWithReturn") {
    return {
      target: {
        kind: "statementsWithReturn",
        bodyStmts: classified.stmts,
        returnExpr: classified.returnExpr,
        params,
        declaration,
        resolvedSymbol,
      },
    };
  }
  if (declarationHasLuaMultiReturnReturnType(declaration)) {
    return {
      target: {
        kind: "statementsWithReturn",
        bodyStmts: [],
        returnExpr: classified.expr,
        params,
        declaration,
        resolvedSymbol,
      },
    };
  }
  return {
    target: { kind: "expression", bodyExpr: classified.expr, params, declaration, resolvedSymbol },
  };
}

export function getInlineTarget(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): InlineTargetResult {
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return undefined;

  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = resolved.getDeclarations();
  if (!declarations || declarations.length === 0) return undefined;

  for (const decl of declarations) {
    if (ts.isFunctionDeclaration(decl)) {
      if (!hasInlineTag(decl)) continue;
      return makeTargetResult(classifyBody(decl), decl.parameters, decl, resolved);
    }

    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const varStmt = decl.parent?.parent;
      const tagNode = varStmt && ts.isVariableStatement(varStmt) ? varStmt : decl;
      if (!hasInlineTag(tagNode)) continue;

      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        return makeTargetResult(classifyBody(init), init.parameters, decl, resolved);
      }
    }
  }

  return undefined;
}

export function resolveSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export function returnsLuaMultiReturn(
  declaration: ts.Node,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (declarationHasLuaMultiReturnReturnType(declaration)) {
    return true;
  }

  const signature = checker.getResolvedSignature(callNode);
  const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  return (
    returnType?.symbol?.name === "LuaMultiReturn" ||
    returnType?.aliasSymbol?.name === "LuaMultiReturn"
  );
}
