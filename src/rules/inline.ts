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

/**
 * Recursively transform a Lua expression tree. `leafFn` is called on each node;
 * if it returns a value, that replaces the node (no further recursion).
 * Otherwise the default recursion rebuilds the node with mapped children.
 * Does not recurse into nested function bodies — they have their own scope.
 */
function mapLuaExpression(
  node: tstl.Expression,
  leafFn: (n: tstl.Expression) => tstl.Expression | undefined,
): tstl.Expression {
  const hit = leafFn(node);
  if (hit !== undefined) return hit;

  const recurse = (n: tstl.Expression) => mapLuaExpression(n, leafFn);

  switch (node.kind) {
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      return tstl.createBinaryExpression(recurse(bin.left), recurse(bin.right), bin.operator);
    }
    case tstl.SyntaxKind.UnaryExpression: {
      const un = node as tstl.UnaryExpression;
      return tstl.createUnaryExpression(recurse(un.operand), un.operator);
    }
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      return tstl.createCallExpression(recurse(call.expression), call.params.map(recurse));
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      return tstl.createMethodCallExpression(
        recurse(method.prefixExpression),
        method.name,
        method.params.map(recurse),
      );
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      return tstl.createTableIndexExpression(recurse(tbl.table), recurse(tbl.index));
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      return tstl.createParenthesizedExpression(
        recurse((node as tstl.ParenthesizedExpression).expression),
      );
    case tstl.SyntaxKind.TableExpression: {
      const tblExpr = node as tstl.TableExpression;
      return tstl.createTableExpression(
        tblExpr.fields.map((field) =>
          tstl.createTableFieldExpression(
            recurse(field.value),
            field.key ? recurse(field.key) : undefined,
          ),
        ),
      );
    }
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      return tstl.createConditionalExpression(
        recurse(cond.condition),
        recurse(cond.whenTrue),
        recurse(cond.whenFalse),
      );
    }
    default:
      return node;
  }
}

function substituteParams(
  node: tstl.Expression,
  paramMap: Map<tstl.SymbolId, tstl.Expression>,
): tstl.Expression {
  return mapLuaExpression(node, (n) => {
    if (n.kind !== tstl.SyntaxKind.Identifier) return undefined;
    const id = n as tstl.Identifier;
    const mapped = id.symbolId !== undefined ? paramMap.get(id.symbolId) : undefined;
    return mapped ? tstl.cloneNode(mapped) : n;
  });
}

/**
 * Test whether a predicate holds for any identifier (with a symbolId) in the
 * expression tree. Short-circuits on first match. Does not recurse into
 * nested function bodies.
 */
function someLuaIdentifier(
  node: tstl.Expression,
  predicate: (symbolId: tstl.SymbolId) => boolean,
): boolean {
  if (node.kind === tstl.SyntaxKind.Identifier) {
    const symbolId = (node as tstl.Identifier).symbolId;
    return symbolId !== undefined && predicate(symbolId);
  }
  return luaExprChildren(node).some((child) => someLuaIdentifier(child, predicate));
}

function collectSymbolIds(node: tstl.Expression, ids: Set<tstl.SymbolId>): void {
  someLuaIdentifier(node, (id) => {
    ids.add(id);
    return false; // keep walking
  });
}

function luaExprChildren(node: tstl.Expression): tstl.Expression[] {
  switch (node.kind) {
    case tstl.SyntaxKind.BinaryExpression: {
      const bin = node as tstl.BinaryExpression;
      return [bin.left, bin.right];
    }
    case tstl.SyntaxKind.UnaryExpression:
      return [(node as tstl.UnaryExpression).operand];
    case tstl.SyntaxKind.CallExpression: {
      const call = node as tstl.CallExpression;
      return [call.expression, ...call.params];
    }
    case tstl.SyntaxKind.MethodCallExpression: {
      const method = node as tstl.MethodCallExpression;
      return [method.prefixExpression, ...method.params];
    }
    case tstl.SyntaxKind.TableIndexExpression: {
      const tbl = node as tstl.TableIndexExpression;
      return [tbl.table, tbl.index];
    }
    case tstl.SyntaxKind.ParenthesizedExpression:
      return [(node as tstl.ParenthesizedExpression).expression];
    case tstl.SyntaxKind.TableExpression:
      return (node as tstl.TableExpression).fields.flatMap((f) =>
        f.key !== undefined ? [f.value, f.key] : [f.value],
      );
    case tstl.SyntaxKind.ConditionalExpression: {
      const cond = node as tstl.ConditionalExpression;
      return [cond.condition, cond.whenTrue, cond.whenFalse];
    }
    default:
      return [];
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
    if (someLuaIdentifier(luaBody, (id) => !paramIds.has(id))) {
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
    if (someLuaIdentifier(substituted, (id) => !callerIds.has(id))) {
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
