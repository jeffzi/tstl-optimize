import { AccessKind, getAccessKind } from "ts-api-utils";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { hasSideEffects } from "../ast/ts-ast";
import type { RuleFactory } from "../config";

interface InlineTarget {
  bodyExpr: ts.Expression;
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

function hasInlineTag(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === "inline");
}

function getBodyExpression(
  func: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): ts.Expression | undefined {
  if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) {
    return func.body;
  }
  const body = ts.isArrowFunction(func) ? (func.body as ts.Block) : func.body;
  if (!body || body.statements.length !== 1) return undefined;
  const stmt = body.statements[0];
  if (!ts.isReturnStatement(stmt) || !stmt.expression) return undefined;
  return stmt.expression;
}

function getInlineTarget(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): InlineTarget | undefined {
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return undefined;

  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = resolved.getDeclarations();
  if (!declarations || declarations.length === 0) return undefined;

  for (const decl of declarations) {
    if (ts.isFunctionDeclaration(decl)) {
      if (!hasInlineTag(decl)) continue;
      const bodyExpr = getBodyExpression(decl);
      if (!bodyExpr) continue;
      return { bodyExpr, params: decl.parameters, declaration: decl, resolvedSymbol: resolved };
    }

    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const varStmt = decl.parent?.parent;
      const tagNode = varStmt && ts.isVariableStatement(varStmt) ? varStmt : decl;
      if (!hasInlineTag(tagNode)) continue;

      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const bodyExpr = getBodyExpression(init);
        if (!bodyExpr) continue;
        return { bodyExpr, params: init.parameters, declaration: decl, resolvedSymbol: resolved };
      }
    }
  }

  return undefined;
}

function isModuleScopeDeclaration(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) {
    return ts.isSourceFile(node.parent);
  }
  if (ts.isVariableDeclaration(node)) {
    const varStatement = node.parent?.parent;
    return (
      !!varStatement && ts.isVariableStatement(varStatement) && ts.isSourceFile(varStatement.parent)
    );
  }
  return false;
}

function countReferences(node: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): number {
  let count = 0;
  function visit(n: ts.Node): void {
    if (ts.isIdentifier(n)) {
      const sym = checker.getSymbolAtLocation(n);
      if (sym === symbol) count++;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return count;
}

function isParamWritten(
  body: ts.Expression,
  paramSymbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  let written = false;
  function visit(n: ts.Node): void {
    if (written) return;
    if (ts.isIdentifier(n)) {
      const sym = checker.getSymbolAtLocation(n);
      if (sym === paramSymbol && getAccessKind(n) & AccessKind.Write) {
        written = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(body);
  return written;
}

function canInline(
  target: InlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const { bodyExpr, params, declaration, resolvedSymbol } = target;

  if (callNode.arguments.length !== params.length) return false;

  for (const param of params) {
    if (param.dotDotDotToken || param.questionToken || param.initializer) return false;
  }

  if (!isModuleScopeDeclaration(declaration)) return false;

  // Reject recursion: body references the function itself
  if (countReferences(bodyExpr, resolvedSymbol, checker) > 0) return false;

  for (let i = 0; i < params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(params[i].name);
    if (!paramSymbol) return false;
    // Reject if any reference to this param is a write (assignment inside body)
    if (isParamWritten(bodyExpr, paramSymbol, checker)) return false;
    // Reject side-effect duplication: param used >1 times with side-effecting arg
    const usageCount = countReferences(bodyExpr, paramSymbol, checker);
    if (usageCount > 1 && hasSideEffects(callNode.arguments[i])) return false;
  }

  return true;
}

function substituteParams(
  node: tstl.Expression,
  paramMap: Map<tstl.SymbolId, tstl.Expression>,
): tstl.Expression {
  if (tstl.isIdentifier(node)) {
    const mapped = node.symbolId !== undefined ? paramMap.get(node.symbolId) : undefined;
    if (mapped) {
      return tstl.cloneNode(mapped);
    }
    return node;
  }

  if (tstl.isBinaryExpression(node)) {
    return tstl.createBinaryExpression(
      substituteParams(node.left, paramMap),
      substituteParams(node.right, paramMap),
      node.operator,
    );
  }

  if (tstl.isUnaryExpression(node)) {
    return tstl.createUnaryExpression(substituteParams(node.operand, paramMap), node.operator);
  }

  if (tstl.isCallExpression(node)) {
    return tstl.createCallExpression(
      substituteParams(node.expression, paramMap),
      node.params.map((p) => substituteParams(p, paramMap)),
    );
  }

  if (tstl.isMethodCallExpression(node)) {
    return tstl.createMethodCallExpression(
      substituteParams(node.prefixExpression, paramMap),
      node.name,
      node.params.map((p) => substituteParams(p, paramMap)),
    );
  }

  if (tstl.isTableIndexExpression(node)) {
    return tstl.createTableIndexExpression(
      substituteParams(node.table, paramMap),
      substituteParams(node.index, paramMap),
    );
  }

  if (tstl.isParenthesizedExpression(node)) {
    return tstl.createParenthesizedExpression(substituteParams(node.expression, paramMap));
  }

  if (tstl.isTableExpression(node)) {
    return tstl.createTableExpression(
      node.fields.map((field) =>
        tstl.createTableFieldExpression(
          substituteParams(field.value, paramMap),
          field.key ? substituteParams(field.key, paramMap) : undefined,
        ),
      ),
    );
  }

  if (tstl.isConditionalExpression(node)) {
    return tstl.createConditionalExpression(
      substituteParams(node.condition, paramMap),
      substituteParams(node.whenTrue, paramMap),
      substituteParams(node.whenFalse, paramMap),
    );
  }

  // Don't recurse into nested function bodies — they have their own scope
  if (tstl.isFunctionExpression(node)) return node;

  return node;
}

function needsParentheses(node: tstl.Expression): boolean {
  return (
    tstl.isBinaryExpression(node) ||
    tstl.isUnaryExpression(node) ||
    tstl.isConditionalExpression(node)
  );
}

function handleCallExpression(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Expression | undefined {
  const target = getInlineTarget(node, checker);
  if (!target) return undefined;
  if (!canInline(target, node, checker)) return undefined;

  const luaBody = context.transformExpression(target.bodyExpr);

  const paramMap = new Map<tstl.SymbolId, tstl.Expression>();
  for (let i = 0; i < target.params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(target.params[i].name);
    if (!paramSymbol) return undefined;
    const symbolId = context.symbolIdMaps.get(paramSymbol);
    if (symbolId === undefined) return undefined;
    const luaArg = context.transformExpression(node.arguments[i]);
    paramMap.set(symbolId, luaArg);
  }

  const substituted = substituteParams(luaBody, paramMap);

  if (needsParentheses(substituted)) {
    return tstl.createParenthesizedExpression(substituted);
  }

  return substituted;
}

export const createVisitors: RuleFactory = (checker, _config) => {
  // Returns undefined to signal "not handled" to the merge wrapper in index.ts;
  // the strict tstl.Visitors type doesn't model this protocol, so we cast here
  type LooseVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
  const visitors: Record<number, LooseVisitor> = {
    [ts.SyntaxKind.CallExpression]: (node, context) =>
      handleCallExpression(node as ts.CallExpression, checker, context),
  };
  return visitors as tstl.Visitors;
};
