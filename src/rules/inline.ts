import { AccessKind, getAccessKind } from "ts-api-utils";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { deepCloneExpression } from "../ast/deep-clone";
import { hasSideEffects } from "../ast/ts-ast";
import type { RuleFactory } from "../config";

interface ExpressionInlineTarget {
  kind: "expression";
  bodyExpr: ts.Expression;
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

interface StatementInlineTarget {
  kind: "statements";
  bodyStmts: readonly ts.Statement[];
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

type InlineTarget = ExpressionInlineTarget | StatementInlineTarget;

function hasInlineTag(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === "inline");
}

type ClassifiedBody =
  | { kind: "expression"; expr: ts.Expression }
  | { kind: "statements"; stmts: readonly ts.Statement[] };

function classifyBody(
  func: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): ClassifiedBody | undefined {
  // Arrow with expression body
  if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) {
    return { kind: "expression", expr: func.body };
  }
  const body = ts.isArrowFunction(func) ? (func.body as ts.Block) : func.body;
  if (!body || body.statements.length === 0) return undefined;

  // Single return statement -> expression path (preserves existing behavior)
  if (body.statements.length === 1) {
    const stmt = body.statements[0];
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      return { kind: "expression", expr: stmt.expression };
    }
  }

  // Multi-statement body or single non-return statement -> statements path
  return { kind: "statements", stmts: body.statements };
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
      const classified = classifyBody(decl);
      if (!classified) {
        // Empty body: treat as statement target with zero statements.
        // ExpressionStatement handler erases silently; expression handler rejects.
        return {
          target: {
            kind: "statements",
            bodyStmts: [],
            params: decl.parameters,
            declaration: decl,
            resolvedSymbol: resolved,
          },
        };
      }
      if (classified.kind === "statements") {
        return {
          target: {
            kind: "statements",
            bodyStmts: classified.stmts,
            params: decl.parameters,
            declaration: decl,
            resolvedSymbol: resolved,
          },
        };
      }
      return {
        target: {
          kind: "expression",
          bodyExpr: classified.expr,
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
        const classified = classifyBody(init);
        if (!classified) {
          return {
            target: {
              kind: "statements",
              bodyStmts: [],
              params: init.parameters,
              declaration: decl,
              resolvedSymbol: resolved,
            },
          };
        }
        if (classified.kind === "statements") {
          return {
            target: {
              kind: "statements",
              bodyStmts: classified.stmts,
              params: init.parameters,
              declaration: decl,
              resolvedSymbol: resolved,
            },
          };
        }
        return {
          target: {
            kind: "expression",
            bodyExpr: classified.expr,
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
  target: ExpressionInlineTarget,
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
 * Recursively transform a Lua statement list. `leafFn` is called on each expression
 * node via `mapLuaExpression`; if it returns a value, that replaces the expression.
 * Produces new statement arrays without mutating originals.
 * @internal Exported for testing only.
 */
export function mapLuaStatements(
  statements: readonly tstl.Statement[],
  leafFn: (n: tstl.Expression) => tstl.Expression | undefined,
): tstl.Statement[] {
  const recurse = (n: tstl.Expression) => mapLuaExpression(n, leafFn);
  const recurseStmts = (stmts: readonly tstl.Statement[]) => mapLuaStatements(stmts, leafFn);

  function mapIfStatement(stmt: tstl.IfStatement): tstl.IfStatement {
    let elseBlock: tstl.Block | tstl.IfStatement | undefined;
    if (stmt.elseBlock) {
      if (tstl.isIfStatement(stmt.elseBlock)) {
        elseBlock = mapIfStatement(stmt.elseBlock);
      } else {
        elseBlock = tstl.createBlock(recurseStmts(stmt.elseBlock.statements));
      }
    }
    return tstl.createIfStatement(
      recurse(stmt.condition),
      tstl.createBlock(recurseStmts(stmt.ifBlock.statements)),
      elseBlock,
    );
  }

  return statements.map((stmt): tstl.Statement => {
    switch (stmt.kind) {
      case tstl.SyntaxKind.DoStatement: {
        const doStmt = stmt as tstl.DoStatement;
        return tstl.createDoStatement(recurseStmts(doStmt.statements));
      }
      case tstl.SyntaxKind.VariableDeclarationStatement: {
        const varDecl = stmt as tstl.VariableDeclarationStatement;
        return tstl.createVariableDeclarationStatement(
          varDecl.left.map((id) => recurse(id) as tstl.Identifier),
          varDecl.right?.map(recurse),
        );
      }
      case tstl.SyntaxKind.AssignmentStatement: {
        const assign = stmt as tstl.AssignmentStatement;
        return tstl.createAssignmentStatement(
          assign.left.map((l) => recurse(l) as tstl.AssignmentLeftHandSideExpression),
          assign.right.map(recurse),
        );
      }
      case tstl.SyntaxKind.IfStatement:
        return mapIfStatement(stmt as tstl.IfStatement);
      case tstl.SyntaxKind.WhileStatement: {
        const whileStmt = stmt as tstl.WhileStatement;
        return tstl.createWhileStatement(
          tstl.createBlock(recurseStmts(whileStmt.body.statements)),
          recurse(whileStmt.condition),
        );
      }
      case tstl.SyntaxKind.RepeatStatement: {
        const repeatStmt = stmt as tstl.RepeatStatement;
        return tstl.createRepeatStatement(
          tstl.createBlock(recurseStmts(repeatStmt.body.statements)),
          recurse(repeatStmt.condition),
        );
      }
      case tstl.SyntaxKind.ForStatement: {
        const forStmt = stmt as tstl.ForStatement;
        return tstl.createForStatement(
          tstl.createBlock(recurseStmts(forStmt.body.statements)),
          forStmt.controlVariable,
          recurse(forStmt.controlVariableInitializer),
          recurse(forStmt.limitExpression),
          forStmt.stepExpression ? recurse(forStmt.stepExpression) : undefined,
        );
      }
      case tstl.SyntaxKind.ForInStatement: {
        const forIn = stmt as tstl.ForInStatement;
        return tstl.createForInStatement(
          tstl.createBlock(recurseStmts(forIn.body.statements)),
          forIn.names,
          forIn.expressions.map(recurse),
        );
      }
      case tstl.SyntaxKind.ReturnStatement: {
        const ret = stmt as tstl.ReturnStatement;
        return tstl.createReturnStatement(ret.expressions.map(recurse));
      }
      case tstl.SyntaxKind.ExpressionStatement: {
        const exprStmt = stmt as tstl.ExpressionStatement;
        return tstl.createExpressionStatement(recurse(exprStmt.expression));
      }
      case tstl.SyntaxKind.GotoStatement:
      case tstl.SyntaxKind.LabelStatement:
      case tstl.SyntaxKind.BreakStatement:
        return tstl.cloneNode(stmt);
      default:
        return tstl.cloneNode(stmt);
    }
  });
}

function substituteParamsInStatements(
  statements: readonly tstl.Statement[],
  paramMap: ReadonlyMap<tstl.SymbolId, tstl.Expression>,
): tstl.Statement[] {
  return mapLuaStatements(statements, (n) => {
    if (n.kind !== tstl.SyntaxKind.Identifier) return undefined;
    const id = n as tstl.Identifier;
    const mapped = id.symbolId !== undefined ? paramMap.get(id.symbolId) : undefined;
    return mapped ? deepCloneExpression(mapped) : undefined;
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

function hasLinearControlFlow(stmts: readonly ts.Statement[]): true | string {
  for (const stmt of stmts) {
    if (ts.isReturnStatement(stmt)) return "early return in body";
    if (ts.isBreakStatement(stmt)) return "break in body";
    if (ts.isContinueStatement(stmt)) return "continue in body";
    // Per CONTEXT.md: do NOT recurse into if/while/for blocks
  }
  return true;
}

function canInlineStatements(
  target: StatementInlineTarget,
  callNode: ts.CallExpression,
  _checker: ts.TypeChecker,
): true | string {
  const { bodyStmts, params, declaration } = target;

  for (const param of params) {
    if (param.dotDotDotToken) return "rest parameters are not supported";
    if (param.questionToken) return "optional parameters are not supported";
    if (param.initializer) return "default parameters are not supported";
  }

  if (callNode.arguments.length !== params.length)
    return "argument count does not match parameter count";

  if (!isModuleScopeDeclaration(declaration)) return "function must be declared at module scope";

  const controlFlow = hasLinearControlFlow(bodyStmts);
  if (controlFlow !== true) return controlFlow;

  return true;
}

// TSTL ScopeType.Function = 2 (not part of public API, using numeric value)
const SCOPE_TYPE_FUNCTION = 2;

function buildDoEndBlock(
  target: StatementInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;

  // 1. Transform arguments and create temp identifiers
  const tempDecls: tstl.VariableDeclarationStatement[] = [];
  const paramMap = new Map<tstl.SymbolId, tstl.Expression>();

  for (let i = 0; i < params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(params[i].name);
    if (!paramSymbol) return undefined;
    const paramSymbolId = context.symbolIdMaps.get(paramSymbol);
    if (paramSymbolId === undefined) return undefined;

    const luaArg = context.transformExpression(callNode.arguments[i]);
    const tempId = context.nextSymbolId();
    const tempIdent = tstl.createIdentifier(`____inline_arg_${i}`, undefined, tempId);
    tempDecls.push(tstl.createVariableDeclarationStatement([tempIdent], [luaArg]));
    paramMap.set(paramSymbolId, tstl.createIdentifier(tempIdent.text, undefined, tempId));
  }

  // 2. Transform body statements via TSTL in a function scope so that
  //    local variable declarations produce `local` in Lua (not global assignments).
  context.pushScope(SCOPE_TYPE_FUNCTION, declaration);
  const luaBody = bodyStmts.flatMap((s) => context.transformStatements(s));
  context.popScope();

  const substituted = substituteParamsInStatements(luaBody, paramMap);

  // 3. Wrap in do...end
  const doBlock = tstl.createDoStatement(substituted);

  // 4. Return temp declarations + do...end
  return [...tempDecls, doBlock];
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

  if (target.kind === "statements") {
    // Skip diagnostic if parent is ExpressionStatement -- the statement-level handler
    // already emits the appropriate diagnostic or inlines. This prevents double diagnostics.
    if (!ts.isExpressionStatement(node.parent)) {
      context.diagnostics.push(
        createInlineWarning(
          node,
          "multi-statement body cannot be inlined at expression position" +
            " (only statement-position calls supported)",
        ),
      );
    }
    return undefined;
  }

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

function handleExpressionStatement(
  node: ts.ExpressionStatement,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  if (!ts.isCallExpression(node.expression)) return undefined;
  const callNode = node.expression;

  const result = getInlineTarget(callNode, checker);
  if (!result) return undefined;
  if ("reason" in result) {
    context.diagnostics.push(createInlineWarning(callNode, result.reason));
    return undefined;
  }

  const { target } = result;

  if (target.kind === "expression") {
    // Delegate to existing expression handler and wrap result in ExpressionStatement
    const inlined = handleCallExpression(callNode, checker, context);
    if (inlined === undefined) return undefined;
    return [tstl.createExpressionStatement(inlined)];
  }

  // target.kind === "statements"
  // Empty body: silently erase (no do...end, no output)
  if (target.bodyStmts.length === 0) return [];

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult));
    return undefined;
  }

  // Cross-module check: reject statement bodies with free variables
  const isCrossModule =
    callNode.getSourceFile().fileName !== target.declaration.getSourceFile().fileName;
  if (isCrossModule) {
    context.diagnostics.push(
      createInlineWarning(callNode, "cross-module multi-statement inline is not supported"),
    );
    return undefined;
  }

  return buildDoEndBlock(target, callNode, checker, context);
}

export const createVisitors: RuleFactory = (checker, _config) => {
  // Returns undefined to signal "not handled" to the merge wrapper in index.ts;
  // the strict tstl.Visitors type doesn't model this protocol, so we cast here
  type LooseVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
  const visitors: Record<number, LooseVisitor> = {
    [ts.SyntaxKind.CallExpression]: (node, context) =>
      handleCallExpression(node as ts.CallExpression, checker, context),
    [ts.SyntaxKind.ExpressionStatement]: (node, context) =>
      handleExpressionStatement(node as ts.ExpressionStatement, checker, context),
  };
  return visitors as tstl.Visitors;
};
