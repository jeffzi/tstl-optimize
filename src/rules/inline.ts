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

type InlineTargetResult = { target: InlineTarget } | { reason: string } | undefined;

function getInlineTarget(node: ts.CallExpression, checker: ts.TypeChecker): InlineTargetResult {
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return undefined;

  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = resolved.getDeclarations();
  if (!declarations || declarations.length === 0) return undefined;

  for (const decl of declarations) {
    if (ts.isFunctionDeclaration(decl)) {
      if (!hasInlineTag(decl)) continue;
      const bodyExpr = getBodyExpression(decl);
      if (!bodyExpr)
        return { reason: "body must be a single return statement or arrow expression" };
      return {
        target: {
          bodyExpr,
          params: decl.parameters,
          declaration: decl,
          resolvedSymbol: resolved,
        },
      };
    }

    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const varStmt = decl.parent?.parent;
      const tagNode = varStmt && ts.isVariableStatement(varStmt) ? varStmt : decl;
      if (!hasInlineTag(tagNode)) continue;

      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const bodyExpr = getBodyExpression(init);
        if (!bodyExpr)
          return { reason: "body must be a single return statement or arrow expression" };
        return {
          target: {
            bodyExpr,
            params: init.parameters,
            declaration: decl,
            resolvedSymbol: resolved,
          },
        };
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
): true | string {
  const { bodyExpr, params, declaration, resolvedSymbol } = target;

  for (const param of params) {
    if (param.dotDotDotToken) return "rest parameters are not supported";
    if (param.questionToken) return "optional parameters are not supported";
    if (param.initializer) return "default parameters are not supported";
  }

  if (callNode.arguments.length !== params.length)
    return "argument count does not match parameter count";

  if (!isModuleScopeDeclaration(declaration)) return "function must be declared at module scope";

  // Reject recursion: body references the function itself
  if (countReferences(bodyExpr, resolvedSymbol, checker) > 0)
    return "recursive functions cannot be inlined";

  for (let i = 0; i < params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(params[i].name);
    if (!paramSymbol) return "parameter symbol could not be resolved";
    // Reject if any reference to this param is a write (assignment inside body)
    if (isParamWritten(bodyExpr, paramSymbol, checker)) return "parameter is written inside body";
    // Reject side-effect duplication: param used >1 times with side-effecting arg
    const usageCount = countReferences(bodyExpr, paramSymbol, checker);
    if (usageCount > 1 && hasSideEffects(callNode.arguments[i]))
      return "argument with side effects is used multiple times";
  }

  return true;
}

function substituteParams(
  node: tstl.Expression,
  paramMap: Map<tstl.SymbolId, tstl.Expression>,
): tstl.Expression {
  switch (node.kind) {
    case tstl.SyntaxKind.Identifier: {
      const id = node as tstl.Identifier;
      const mapped = id.symbolId !== undefined ? paramMap.get(id.symbolId) : undefined;
      return mapped ? tstl.cloneNode(mapped) : node;
    }
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      return tstl.createBinaryExpression(
        substituteParams(bin.left, paramMap),
        substituteParams(bin.right, paramMap),
        bin.operator,
      );
    }
    case tstl.SyntaxKind.UnaryExpression: {
      const un = node as tstl.UnaryExpression;
      return tstl.createUnaryExpression(substituteParams(un.operand, paramMap), un.operator);
    }
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      return tstl.createCallExpression(
        substituteParams(call.expression, paramMap),
        call.params.map((p) => substituteParams(p, paramMap)),
      );
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      return tstl.createMethodCallExpression(
        substituteParams(method.prefixExpression, paramMap),
        method.name,
        method.params.map((p) => substituteParams(p, paramMap)),
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      return tstl.createTableIndexExpression(
        substituteParams(tbl.table, paramMap),
        substituteParams(tbl.index, paramMap),
      );
    }
    case tstl.SyntaxKind.ParenthesizedExpression: {
      const paren = node as tstl.ParenthesizedExpression;
      return tstl.createParenthesizedExpression(substituteParams(paren.expression, paramMap));
    }
    case tstl.SyntaxKind.TableExpression: {
      const tblExpr = node as tstl.TableExpression;
      return tstl.createTableExpression(
        tblExpr.fields.map((field) =>
          tstl.createTableFieldExpression(
            substituteParams(field.value, paramMap),
            field.key ? substituteParams(field.key, paramMap) : undefined,
          ),
        ),
      );
    }
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      return tstl.createConditionalExpression(
        substituteParams(cond.condition, paramMap),
        substituteParams(cond.whenTrue, paramMap),
        substituteParams(cond.whenFalse, paramMap),
      );
    }
    // Don't recurse into nested function bodies — they have their own scope
    default:
      return node;
  }
}

function hasFreeVariables(node: tstl.Expression, paramIds: ReadonlySet<tstl.SymbolId>): boolean {
  switch (node.kind) {
    case tstl.SyntaxKind.Identifier: {
      const symbolId = (node as tstl.Identifier).symbolId;
      return symbolId !== undefined && !paramIds.has(symbolId);
    }
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      return hasFreeVariables(bin.left, paramIds) || hasFreeVariables(bin.right, paramIds);
    }
    case tstl.SyntaxKind.UnaryExpression:
      return hasFreeVariables((node as tstl.UnaryExpression).operand, paramIds);
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      return (
        hasFreeVariables(call.expression, paramIds) ||
        call.params.some((p) => hasFreeVariables(p, paramIds))
      );
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      return (
        hasFreeVariables(method.prefixExpression, paramIds) ||
        method.params.some((p) => hasFreeVariables(p, paramIds))
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      return hasFreeVariables(tbl.table, paramIds) || hasFreeVariables(tbl.index, paramIds);
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      return hasFreeVariables((node as tstl.ParenthesizedExpression).expression, paramIds);
    case tstl.SyntaxKind.TableExpression:
      return (node as tstl.TableExpression).fields.some(
        (f) =>
          hasFreeVariables(f.value, paramIds) ||
          (f.key !== undefined && hasFreeVariables(f.key, paramIds)),
      );
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      return (
        hasFreeVariables(cond.condition, paramIds) ||
        hasFreeVariables(cond.whenTrue, paramIds) ||
        hasFreeVariables(cond.whenFalse, paramIds)
      );
    }
    default:
      return false;
  }
}

function collectSymbolIds(node: tstl.Expression, ids: Set<tstl.SymbolId>): void {
  switch (node.kind) {
    case tstl.SyntaxKind.Identifier: {
      const id = node as tstl.Identifier;
      if (id.symbolId !== undefined) ids.add(id.symbolId);
      break;
    }
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      collectSymbolIds(bin.left, ids);
      collectSymbolIds(bin.right, ids);
      break;
    }
    case tstl.SyntaxKind.UnaryExpression:
      collectSymbolIds((node as tstl.UnaryExpression).operand, ids);
      break;
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      collectSymbolIds(call.expression, ids);
      for (const p of call.params) collectSymbolIds(p, ids);
      break;
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      collectSymbolIds(method.prefixExpression, ids);
      for (const p of method.params) collectSymbolIds(p, ids);
      break;
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      collectSymbolIds(tbl.table, ids);
      collectSymbolIds(tbl.index, ids);
      break;
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      collectSymbolIds((node as tstl.ParenthesizedExpression).expression, ids);
      break;
    case tstl.SyntaxKind.TableExpression:
      for (const f of (node as tstl.TableExpression).fields) {
        collectSymbolIds(f.value, ids);
        if (f.key) collectSymbolIds(f.key, ids);
      }
      break;
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      collectSymbolIds(cond.condition, ids);
      collectSymbolIds(cond.whenTrue, ids);
      collectSymbolIds(cond.whenFalse, ids);
      break;
    }
  }
}

function needsParentheses(node: tstl.Expression): boolean {
  return (
    tstl.isBinaryExpression(node) ||
    tstl.isUnaryExpression(node) ||
    tstl.isConditionalExpression(node)
  );
}

function createInlineWarning(node: ts.CallExpression, reason: string): ts.Diagnostic {
  return {
    file: node.getSourceFile(),
    start: node.getStart(),
    length: node.getWidth(),
    messageText: `@inline ignored: ${reason}`,
    category: ts.DiagnosticCategory.Warning,
    code: 90001,
    source: "tstl-optimize",
  };
}

function handleCallExpression(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Expression | undefined {
  const result = getInlineTarget(node, checker);
  if (!result) return undefined;
  if ("reason" in result) {
    context.diagnostics.push(createInlineWarning(node, result.reason));
    return undefined;
  }
  const { target } = result;
  const canInlineResult = canInline(target, node, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(node, canInlineResult));
    return undefined;
  }

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

  const isCrossModule =
    node.getSourceFile().fileName !== target.declaration.getSourceFile().fileName;

  if (isCrossModule) {
    const paramIds = new Set(paramMap.keys());
    if (hasFreeVariables(luaBody, paramIds)) {
      context.diagnostics.push(
        createInlineWarning(node, "cross-module function references non-parameter identifiers"),
      );
      return undefined;
    }
  }

  const substituted = substituteParams(luaBody, paramMap);

  // Defense-in-depth: after substitution, only caller-provided identifiers should remain
  if (isCrossModule) {
    const callerIds = new Set<tstl.SymbolId>();
    for (const arg of paramMap.values()) {
      collectSymbolIds(arg, callerIds);
    }
    if (hasFreeVariables(substituted, callerIds)) {
      return undefined;
    }
  }

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
