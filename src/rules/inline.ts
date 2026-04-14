import { AccessKind, getAccessKind } from "ts-api-utils";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { deepCloneExpression } from "../ast/deep-clone";
import { hasSideEffects, SideEffectOptions } from "../ast/ts-ast";
import { isRecord, type RuleFactory, resolveEffectiveStrict, resolveInlineConfig } from "../config";

const FUNCTION_SCOPE = 2 as Parameters<tstl.TransformationContext["pushScope"]>[0];

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

interface ReturnValueInlineTarget {
  kind: "statementsWithReturn";
  bodyStmts: readonly ts.Statement[];
  returnExpr: ts.Expression;
  params: readonly ts.ParameterDeclaration[];
  declaration: ts.Node;
  resolvedSymbol: ts.Symbol;
}

type InlineTarget = ExpressionInlineTarget | StatementInlineTarget | ReturnValueInlineTarget;

function hasLuaMultiReturnTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  return (
    typeNode !== undefined &&
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "LuaMultiReturn"
  );
}

function declarationHasLuaMultiReturnReturnType(declaration: ts.Node): boolean {
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

function hasInlineTag(node: ts.Node): boolean {
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

  const body = ts.isArrowFunction(func) ? (func.body as ts.Block | undefined) : func.body;
  if (!body || body.statements.length === 0) return undefined;

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

type InlineTargetResult = { target: InlineTarget } | undefined;

function makeTargetResult(
  classified: ClassifiedBody | undefined,
  params: readonly ts.ParameterDeclaration[],
  declaration: ts.Node,
  resolvedSymbol: ts.Symbol,
): { target: InlineTarget } {
  if (!classified) {
    // Empty body: ExpressionStatement handler erases silently; expression handler rejects.
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

function getInlineTarget(node: ts.CallExpression, checker: ts.TypeChecker): InlineTargetResult {
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

function resolveSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isDeclarationNameReference(
  node: ts.Identifier,
  declaration: ts.FunctionDeclaration | ts.VariableDeclaration,
): boolean {
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration.name === node;
  }
  return declaration.name === node;
}

function isSupportedInlineBindingPattern(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return true;

  if (ts.isObjectBindingPattern(name)) {
    return name.elements.every(
      (element) =>
        !element.dotDotDotToken &&
        ts.isIdentifier(element.name) &&
        element.initializer === undefined,
    );
  }

  return name.elements.every(
    (element) =>
      !ts.isOmittedExpression(element) &&
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      element.initializer === undefined,
  );
}

function isCallSiteFullyInlined(callNode: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const result = getInlineTarget(callNode, checker);
  if (!result) return false;

  const { target } = result;
  const hasBlockingFreeVariable = (
    nodes: readonly ts.Node[],
    declaration: ts.Node,
    params: readonly ts.ParameterDeclaration[],
  ): boolean =>
    callNode.getSourceFile().fileName !== declaration.getSourceFile().fileName &&
    hasCrossModuleFreeVariable(nodes, params, declaration, checker);

  if (target.kind === "expression") {
    return (
      canInline(target, callNode, checker) === true &&
      !hasBlockingFreeVariable([target.bodyExpr], target.declaration, target.params)
    );
  }

  if (target.kind === "statements") {
    return (
      ts.isExpressionStatement(callNode.parent) &&
      canInlineStatements(target, callNode, checker) === true &&
      !hasBlockingFreeVariable(target.bodyStmts, target.declaration, target.params)
    );
  }

  if (ts.isReturnStatement(callNode.parent)) {
    return (
      canInlineStatements(target, callNode, checker) === true &&
      !hasBlockingFreeVariable(
        [...target.bodyStmts, target.returnExpr],
        target.declaration,
        target.params,
      )
    );
  }

  if (!ts.isVariableDeclaration(callNode.parent)) {
    return false;
  }

  const variableStatement = callNode.parent.parent?.parent;
  return (
    !!variableStatement &&
    ts.isVariableStatement(variableStatement) &&
    variableStatement.declarationList.declarations.length === 1 &&
    isSupportedInlineBindingPattern(callNode.parent.name) &&
    canInlineStatements(target, callNode, checker) === true &&
    !hasBlockingFreeVariable(
      [...target.bodyStmts, target.returnExpr],
      target.declaration,
      target.params,
    )
  );
}

function canEraseInlineDeclaration(
  declaration: ts.FunctionDeclaration | ts.VariableDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const name = declaration.name;
  if (!name || !ts.isIdentifier(name)) return false;

  const symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return false;
  const resolvedSymbol = resolveSymbol(symbol, checker);

  let canErase = true;
  function visit(node: ts.Node): void {
    if (!canErase || ts.isTypeNode(node)) return;

    if (ts.isIdentifier(node)) {
      const refSymbol = checker.getSymbolAtLocation(node);
      if (refSymbol && resolveSymbol(refSymbol, checker) === resolvedSymbol) {
        if (isDeclarationNameReference(node, declaration)) return;
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          if (isCallSiteFullyInlined(node.parent, checker)) return;
        }
        canErase = false;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(declaration.getSourceFile());
  return canErase;
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

function isParamWritten(body: ts.Node, paramSymbol: ts.Symbol, checker: ts.TypeChecker): boolean {
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

/**
 * Checks the three prerequisites shared by both canInline and canInlineStatements.
 * Returns a rejection reason string, or undefined if all checks pass.
 */
function checkSharedPrereqs(
  params: readonly ts.ParameterDeclaration[],
  args: ts.NodeArray<ts.Expression>,
  declaration: ts.Node,
): string | undefined {
  for (const param of params) {
    if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name))
      return "destructuring parameters are not supported";
    if (param.dotDotDotToken) return "rest parameters are not supported";
    if (param.questionToken) return "optional parameters are not supported";
    if (param.initializer) return "default parameters are not supported";
  }
  if (args.length !== params.length) return "argument count does not match parameter count";
  if (!isModuleScopeDeclaration(declaration)) return "function must be declared at module scope";
  return undefined;
}

function canInline(
  target: ExpressionInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): true | string {
  const { bodyExpr, params, declaration, resolvedSymbol } = target;

  const prereqFailure = checkSharedPrereqs(params, callNode.arguments, declaration);
  if (prereqFailure !== undefined) return prereqFailure;

  if (countReferences(bodyExpr, resolvedSymbol, checker) > 0)
    return "recursive functions cannot be inlined";

  for (let i = 0; i < params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(params[i].name);
    if (!paramSymbol) return "parameter symbol could not be resolved";
    if (isParamWritten(bodyExpr, paramSymbol, checker)) return "parameter is written inside body";
    const usageCount = countReferences(bodyExpr, paramSymbol, checker);
    if (
      usageCount !== 1 &&
      hasSideEffects(
        callNode.arguments[i],
        usageCount > 1 ? SideEffectOptions.ConsiderIdentityMutating : SideEffectOptions.None,
      )
    )
      return usageCount === 0
        ? "argument with side effects is not used"
        : "argument with side effects is used multiple times";
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
    case tstl.SyntaxKind.FunctionExpression: {
      const func = node as tstl.FunctionExpression;
      return tstl.createFunctionExpression(
        tstl.createBlock(mapLuaStatements(func.body.statements, leafFn)),
        func.params,
        func.dots,
        func.flags,
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
    return mapped ? deepCloneExpression(mapped) : undefined;
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
          // LHS identifiers in variable declarations are never parameters (canInline/canInlineStatements
          // rejects writes to params), so recurse preserves their Identifier kind here.
          varDecl.left.map((id) => recurse(id) as tstl.Identifier),
          varDecl.right?.map(recurse),
        );
      }
      case tstl.SyntaxKind.AssignmentStatement: {
        const assign = stmt as tstl.AssignmentStatement;
        return tstl.createAssignmentStatement(
          // Assignment LHS expressions (Identifier | TableIndexExpression) are not params
          // (isParamWritten rejects inline when params appear on LHS), so recurse is safe here.
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

function needsParentheses(node: tstl.Expression): boolean {
  return (
    tstl.isBinaryExpression(node) ||
    tstl.isUnaryExpression(node) ||
    tstl.isConditionalExpression(node)
  );
}

function createInlineWarning(
  node: ts.CallExpression,
  reason: string,
  strict: boolean,
): ts.Diagnostic {
  return {
    file: node.getSourceFile(),
    start: node.getStart(),
    length: node.getWidth(),
    messageText: `@inline ignored: ${reason}`,
    category: strict ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
    code: 90001,
    source: "tstl-optimize",
  };
}

function hasLinearControlFlow(stmts: readonly ts.Statement[], loopBody = false): true | string {
  for (const stmt of stmts) {
    if (ts.isReturnStatement(stmt)) return "early return in body";
    // break/continue inside a loop are scoped to that loop, not to the surrounding
    // do...end inline wrapper in Lua, so only reject them at the top level.
    if (!loopBody) {
      if (ts.isBreakStatement(stmt)) return "break in body";
      if (ts.isContinueStatement(stmt)) return "continue in body";
    }
    // Recurse into nested blocks: a return/break/continue inside an if/while/for
    // becomes a return/break/continue inside a do...end in Lua, which returns from
    // the enclosing function rather than just the inlined block, changing semantics.
    if (ts.isIfStatement(stmt)) {
      const thenResult = hasLinearControlFlow([stmt.thenStatement], loopBody);
      if (thenResult !== true) return thenResult;
      if (stmt.elseStatement) {
        const elseResult = hasLinearControlFlow([stmt.elseStatement], loopBody);
        if (elseResult !== true) return elseResult;
      }
    } else if (ts.isWhileStatement(stmt)) {
      const bodyResult = hasLinearControlFlow([stmt.statement], true);
      if (bodyResult !== true) return bodyResult;
    } else if (ts.isForStatement(stmt)) {
      const bodyResult = hasLinearControlFlow([stmt.statement], true);
      if (bodyResult !== true) return bodyResult;
    } else if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
      const bodyResult = hasLinearControlFlow([stmt.statement], true);
      if (bodyResult !== true) return bodyResult;
    } else if (ts.isBlock(stmt)) {
      const blockResult = hasLinearControlFlow(stmt.statements, loopBody);
      if (blockResult !== true) return blockResult;
    } else if (ts.isDoStatement(stmt)) {
      const bodyResult = hasLinearControlFlow([stmt.statement], true);
      if (bodyResult !== true) return bodyResult;
    } else if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        // break inside switch is scoped to the switch — TSTL compiles switches to if-elseif chains
        const clauseResult = hasLinearControlFlow(clause.statements, true);
        if (clauseResult !== true) return clauseResult;
      }
    } else if (ts.isTryStatement(stmt)) {
      const tryResult = hasLinearControlFlow(stmt.tryBlock.statements, loopBody);
      if (tryResult !== true) return tryResult;
      if (stmt.catchClause) {
        const catchResult = hasLinearControlFlow(stmt.catchClause.block.statements, loopBody);
        if (catchResult !== true) return catchResult;
      }
      if (stmt.finallyBlock) {
        const finallyResult = hasLinearControlFlow(stmt.finallyBlock.statements, loopBody);
        if (finallyResult !== true) return finallyResult;
      }
    } else if (ts.isLabeledStatement(stmt)) {
      // Defensive only: current TSTL rejects labeled statements end-to-end, so
      // treat them as non-inlineable if one reaches this control-flow analysis.
      return "labeled statement in body";
    }
  }
  return true;
}

function canInlineStatements(
  target: StatementInlineTarget | ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): true | string {
  const { bodyStmts, params, declaration, resolvedSymbol } = target;

  const prereqFailure = checkSharedPrereqs(params, callNode.arguments, declaration);
  if (prereqFailure !== undefined) return prereqFailure;

  for (const stmt of bodyStmts) {
    if (countReferences(stmt, resolvedSymbol, checker) > 0)
      return "recursive functions cannot be inlined";
  }

  // For return-value targets, also check the return expression for recursion and param writes
  if (target.kind === "statementsWithReturn") {
    if (countReferences(target.returnExpr, resolvedSymbol, checker) > 0)
      return "recursive functions cannot be inlined";
  }

  for (const param of params) {
    const paramSymbol = checker.getSymbolAtLocation(param.name);
    if (!paramSymbol) return "parameter symbol could not be resolved";
    for (const stmt of bodyStmts) {
      if (isParamWritten(stmt, paramSymbol, checker)) return "parameter is written inside body";
    }
    if (target.kind === "statementsWithReturn") {
      if (isParamWritten(target.returnExpr, paramSymbol, checker))
        return "parameter is written inside body";
    }
  }

  // For statementsWithReturn: pass only pre-return statements to hasLinearControlFlow.
  // The terminal return is NOT in bodyStmts, so no early-return check needed for it.
  const controlFlow = hasLinearControlFlow(bodyStmts);
  if (controlFlow !== true) return controlFlow;

  return true;
}

interface ParamMapResult {
  tempDecls: tstl.VariableDeclarationStatement[];
  paramMap: Map<tstl.SymbolId, tstl.Expression>;
}

function needsEagerArgumentTemps(
  target: ExpressionInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  for (let i = 0; i < target.params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(target.params[i].name);
    if (!paramSymbol) {
      return false;
    }

    if (
      countReferences(target.bodyExpr, paramSymbol, checker) === 1 &&
      hasSideEffects(callNode.arguments[i], SideEffectOptions.None)
    ) {
      return true;
    }
  }

  return false;
}

/** Build temp-var declarations and a symbolId→expression map for each call argument.
 *  Returns undefined if any param symbol or Lua symbolId cannot be resolved. */
function buildParamMap(
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
    if (paramSymbolId === undefined) return undefined;
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
  const luaBody = bodyStmts.flatMap((s) => context.transformStatements(s));
  context.popScope();
  return luaBody;
}

function getInlineReturnStatement(returnExpr: ts.Expression): ts.ReturnStatement {
  const parent = returnExpr.parent;
  if (ts.isReturnStatement(parent) && parent.expression === returnExpr) {
    return parent;
  }

  const syntheticReturn = ts.factory.createReturnStatement(returnExpr);
  ts.setOriginalNode(syntheticReturn, returnExpr);
  return ts.setTextRange(syntheticReturn, returnExpr);
}

function buildDoEndBlock(
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
        effectfulArgs.push(
          tstl.createVariableDeclarationStatement(
            [tstl.createIdentifier("_")],
            [context.transformExpression(arg)],
          ),
        );
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
function inlineExpressionBody(
  target: ExpressionInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Expression | undefined {
  const canInlineResult = canInline(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  const luaBody = context.transformExpression(target.bodyExpr);

  const paramMap = new Map<tstl.SymbolId, tstl.Expression>();
  for (let i = 0; i < target.params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(target.params[i].name);
    if (!paramSymbol) return undefined;
    const symbolId = context.symbolIdMaps.get(paramSymbol);
    if (symbolId === undefined) return undefined;
    const luaArg = context.transformExpression(callNode.arguments[i]);
    paramMap.set(symbolId, luaArg);
  }

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

  const substituted = substituteParams(luaBody, paramMap);

  return needsParentheses(substituted)
    ? tstl.createParenthesizedExpression(substituted)
    : substituted;
}

function handleCallExpression(
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
        ),
      );
    }
    return undefined;
  }

  return inlineExpressionBody(target, node, checker, context, strict);
}

/** Check whether any VariableStatement or FunctionDeclaration in the body declares a binding with the given name. */
function bodyDeclaresLocal(bodyStmts: readonly ts.Statement[], name: string): boolean {
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
  }
  return false;
}

function buildVarDeclInline(
  nameIdent: ts.Identifier,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;

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

  // Transform body and return expression first so ALL param symbols are registered
  // in context.symbolIdMaps before buildParamMap looks them up. A param that only
  // appears in the return expression (not in body statements) would be missing otherwise.
  const luaBody = transformBodyStatements(bodyStmts, declaration, context);
  const luaReturnExpr = context.transformExpression(target.returnExpr);

  const mapped = buildParamMap(params, callNode.arguments, checker, context);
  if (!mapped) return undefined;
  const { tempDecls, paramMap } = mapped;
  const substitutedBody = substituteParamsInStatements(luaBody, paramMap);
  const substitutedReturn = substituteParams(luaReturnExpr, paramMap);

  // Assign the return expression to the result variable inside do...end.
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

interface DestructureShared {
  resultIdent: tstl.Identifier;
  resultSymId: tstl.SymbolId;
  resultDecl: tstl.VariableDeclarationStatement;
  tempDecls: tstl.VariableDeclarationStatement[];
  doEnd: tstl.DoStatement;
}

function returnsLuaMultiReturn(
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
  const { bodyStmts, params, declaration } = target;

  // Generate fresh result identifier: ____inline_result_N
  const resultSymId = context.nextSymbolId();
  const resultIdent = tstl.createIdentifier(
    `____inline_result_${resultSymId}`,
    undefined,
    resultSymId,
  );
  const resultDecl = tstl.createVariableDeclarationStatement([resultIdent]);

  // Transform body and return expression first so ALL param symbols are registered
  // in context.symbolIdMaps before buildParamMap looks them up. A param that only
  // appears in the return expression (not in body statements) would be missing otherwise.
  const luaBody = transformBodyStatements(bodyStmts, declaration, context);
  const luaReturnExpr = context.transformExpression(target.returnExpr);

  const mapped = buildParamMap(params, callNode.arguments, checker, context);
  if (!mapped) return undefined;
  const { tempDecls, paramMap } = mapped;

  const substitutedBody = substituteParamsInStatements(luaBody, paramMap);
  const substitutedReturn = substituteParams(luaReturnExpr, paramMap);

  const assignResult = tstl.createAssignmentStatement(
    [tstl.createIdentifier(resultIdent.text, undefined, resultSymId)],
    [substitutedReturn],
  );
  const doEnd = tstl.createDoStatement([...substitutedBody, assignResult]);

  return { resultIdent, resultSymId, resultDecl, tempDecls, doEnd };
}

function buildObjectDestructureInline(
  pattern: ts.ObjectBindingPattern,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  // Reject rest elements — too complex to support.
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return undefined;
    // Only simple identifier bindings are supported (no nested destructuring).
    if (!ts.isIdentifier(element.name)) return undefined;
    // Default initializers are not supported.
    if (element.initializer) return undefined;
  }

  const shared = buildDestructureShared(target, callNode, checker, context);
  if (!shared) return undefined;
  const { resultIdent, resultSymId, resultDecl, tempDecls, doEnd } = shared;

  // Build field-access declarations for each binding element.
  // `const { a: myA } = foo(x)` — key is `a`, local is `myA`.
  const fieldDecls: tstl.VariableDeclarationStatement[] = [];
  for (const element of pattern.elements) {
    const bindingName = element.name as ts.Identifier;
    // propertyName is defined for renamed bindings (a: myA); otherwise use element.name as key.
    const keyNode = element.propertyName ?? element.name;
    if (!ts.isIdentifier(keyNode)) return undefined;

    // The binding symbol hasn't been transformed yet (handler intercepts before TSTL),
    // so allocate a fresh symbolId for it.
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

function buildArrayDestructureInline(
  pattern: ts.ArrayBindingPattern,
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  // Only handle simple binding elements (no rest, no nested patterns, no omitted elements).
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) return undefined;
    if (element.dotDotDotToken) return undefined;
    if (!ts.isIdentifier(element.name)) return undefined;
    if (element.initializer) return undefined;
  }

  // Detect LuaMultiReturn return type before choosing an expansion strategy.
  const signature = checker.getResolvedSignature(callNode);
  const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  const isMultiReturn =
    returnType?.symbol?.name === "LuaMultiReturn" ||
    returnType?.aliasSymbol?.name === "LuaMultiReturn";

  // Build binding element identifiers (fresh symbolIds since TSTL hasn't processed them yet).
  const bindingIdents: tstl.Identifier[] = pattern.elements
    .filter((e): e is ts.BindingElement => !ts.isOmittedExpression(e))
    .map((element) => {
      const bindingSymId = context.nextSymbolId();
      return tstl.createIdentifier((element.name as ts.Identifier).text, undefined, bindingSymId);
    });

  if (isMultiReturn) {
    // MultiReturn needs N result variables — a single temp loses all values after the first.
    // Bypass buildDestructureShared and handle expansion directly.
    const { bodyStmts, params, declaration } = target;

    // Allocate N result variables matching destructuring width.
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
    const returnStmt = getInlineReturnStatement(target.returnExpr);
    context.pushScope(FUNCTION_SCOPE, declaration);
    const luaBody = bodyStmts.flatMap((s) => context.transformStatements(s));
    const luaReturnStmts = context.transformStatements(returnStmt);
    context.popScope();
    const luaReturn = luaReturnStmts.find(
      (s): s is tstl.ReturnStatement => s.kind === tstl.SyntaxKind.ReturnStatement,
    );
    if (!luaReturn) return undefined;
    const luaReturnExprs = luaReturn.expressions;

    const mapped = buildParamMap(params, callNode.arguments, checker, context);
    if (!mapped) return undefined;
    const { tempDecls, paramMap } = mapped;

    const substitutedBody = substituteParamsInStatements(luaBody, paramMap);
    const substitutedReturns = luaReturnExprs.map((expr) => substituteParams(expr, paramMap));

    // Multi-assignment captures all values: result_a, result_b = expr1, expr2
    const assignResult = tstl.createAssignmentStatement(
      resultIdents.map((id) => tstl.createIdentifier(id.text, undefined, id.symbolId)),
      substitutedReturns,
    );
    const doEnd = tstl.createDoStatement([...substitutedBody, assignResult]);

    // local p, q = result_a, result_b
    const finalDecl = tstl.createVariableDeclarationStatement(
      bindingIdents,
      resultIdents.map((id) => tstl.createIdentifier(id.text, undefined, id.symbolId)),
    );

    return [...resultDecls, ...tempDecls, doEnd, finalDecl];
  }

  // Non-MultiReturn path: use buildDestructureShared + unpack.
  const shared = buildDestructureShared(target, callNode, checker, context);
  if (!shared) return undefined;
  const { resultIdent, resultSymId, resultDecl, tempDecls, doEnd } = shared;

  // Plain array: emit `local a, b = unpack(resultId, 1, N)`.
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

function handleVariableStatement(
  node: ts.VariableStatement,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): tstl.Statement[] | undefined {
  const decls = node.declarationList.declarations;
  // Multi-declaration statements (const a = 1, b = 2) are not handled here.
  if (decls.length !== 1) return undefined;

  const decl = decls[0];
  // Only handle call-expression initializers.
  if (!decl.initializer || !ts.isCallExpression(decl.initializer)) return undefined;

  const callNode = decl.initializer;

  const result = getInlineTarget(callNode, checker);
  if (!result) return undefined;

  const { target } = result;

  // Only handle statementsWithReturn targets here.
  // expression-body targets are handled by the existing CallExpression visitor.
  // statements (void-body) targets at var-decl sites fall through to superTransformStatements.
  if (target.kind !== "statementsWithReturn") return undefined;

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  if (
    rejectIfCrossModuleFreeVar(
      callNode,
      target,
      [...target.bodyStmts, target.returnExpr],
      checker,
      context,
      strict,
    )
  ) {
    return undefined;
  }

  // Plain identifier binding: const r = foo(x)
  if (ts.isIdentifier(decl.name)) {
    return buildVarDeclInline(decl.name, target, callNode, checker, context);
  }

  // Object destructuring: const { a, b } = foo(x)
  if (ts.isObjectBindingPattern(decl.name)) {
    return buildObjectDestructureInline(decl.name, target, callNode, checker, context);
  }

  // Array destructuring: const [a, b] = foo(x)
  if (ts.isArrayBindingPattern(decl.name)) {
    return buildArrayDestructureInline(decl.name, target, callNode, checker, context);
  }

  return undefined;
}

function buildReturnSiteInline(
  target: ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Statement[] | undefined {
  const { bodyStmts, params, declaration } = target;
  const isMultiReturn = returnsLuaMultiReturn(declaration, callNode, checker);
  let luaReturnStmts: tstl.Statement[] | undefined;

  // Transform body and return expression first so ALL param symbols are registered
  // in context.symbolIdMaps before buildParamMap looks them up. A param that only
  // appears in the return expression (not in body statements) would be missing otherwise.
  const luaBody = transformBodyStatements(bodyStmts, declaration, context);
  if (isMultiReturn) {
    const returnStmt = getInlineReturnStatement(target.returnExpr);
    context.pushScope(FUNCTION_SCOPE, declaration);
    luaReturnStmts = context.transformStatements(returnStmt);
    context.popScope();
  }

  const mapped = buildParamMap(params, callNode.arguments, checker, context);
  if (!mapped) return undefined;
  const { tempDecls, paramMap } = mapped;
  const substitutedBody = substituteParamsInStatements(luaBody, paramMap);

  if (isMultiReturn) {
    const luaReturn = luaReturnStmts?.find(
      (stmt): stmt is tstl.ReturnStatement => stmt.kind === tstl.SyntaxKind.ReturnStatement,
    );
    if (!luaReturn) return undefined;

    const substitutedReturns = luaReturn.expressions.map((expr) =>
      substituteParams(expr, paramMap),
    );
    return [...tempDecls, ...substitutedBody, tstl.createReturnStatement(substitutedReturns)];
  }

  const luaReturnExpr = context.transformExpression(target.returnExpr);
  const substitutedReturn = substituteParams(luaReturnExpr, paramMap);

  // Flat emission: arg temps + body statements + return (no do...end wrapper needed).
  return [...tempDecls, ...substitutedBody, tstl.createReturnStatement([substitutedReturn])];
}

function handleReturnStatement(
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

  // Only handle statementsWithReturn targets here.
  if (target.kind !== "statementsWithReturn") return undefined;

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  if (
    rejectIfCrossModuleFreeVar(
      callNode,
      target,
      [...target.bodyStmts, target.returnExpr],
      checker,
      context,
      strict,
    )
  ) {
    return undefined;
  }

  return buildReturnSiteInline(target, callNode, checker, context);
}

/**
 * If the call crosses module boundaries and the target has free variables from the source module,
 * pushes a diagnostic and returns true (caller should return undefined).
 */
function rejectIfCrossModuleFreeVar(
  callNode: ts.CallExpression,
  target: InlineTarget,
  nodes: readonly ts.Node[],
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): boolean {
  const isCrossModule =
    callNode.getSourceFile().fileName !== target.declaration.getSourceFile().fileName;
  if (
    isCrossModule &&
    hasCrossModuleFreeVariable(nodes, target.params, target.declaration, checker)
  ) {
    context.diagnostics.push(
      createInlineWarning(
        callNode,
        "cross-module function references non-parameter identifiers",
        strict,
      ),
    );
    return true;
  }
  return false;
}

/**
 * Check whether any identifier in the given TypeScript nodes references a symbol that is
 * declared inside `sourceDeclaration`'s source file but outside `sourceDeclaration` itself
 * (i.e., a free variable from the source module), and is not one of the given params.
 *
 * Returns true if a cross-module free variable is found.
 */
function hasCrossModuleFreeVariable(
  nodes: readonly ts.Node[],
  params: readonly ts.ParameterDeclaration[],
  sourceDeclaration: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const sourceFile = sourceDeclaration.getSourceFile();
  const paramSymbols = new Set(
    params
      .map((p) => checker.getSymbolAtLocation(p.name))
      .filter((s): s is ts.Symbol => s !== undefined),
  );

  let found = false;

  function walk(node: ts.Node): void {
    if (found) return;
    // Type annotations don't emit to Lua — skip them to avoid false positives
    // from type-only references (e.g., `param: SomeType` where SomeType is a
    // module-level type alias).
    if (ts.isTypeNode(node)) return;
    if (ts.isPropertyAccessExpression(node)) {
      walk(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym && !paramSymbols.has(sym)) {
        const symbolsToCheck = [sym];
        if (sym.flags & ts.SymbolFlags.Alias) {
          symbolsToCheck.push(checker.getAliasedSymbol(sym));
        }
        for (const symbolToCheck of symbolsToCheck) {
          const decls = symbolToCheck.getDeclarations();
          if (!decls) continue;
          for (const decl of decls) {
            if (decl.getSourceFile() === sourceFile && !isDescendant(decl, sourceDeclaration)) {
              found = true;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  for (const node of nodes) {
    walk(node);
    if (found) break;
  }
  return found;
}

/** Returns true if `node` is a descendant of (or equal to) `ancestor`. */
function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** Check if inlined expression result can be discarded at void site (pure expr with pure args). */
function isPureAtVoidSite(bodyExpr: ts.Expression, callArgs: ts.NodeArray<ts.Expression>): boolean {
  const bodyIsPure = !hasSideEffects(bodyExpr);
  const allArgsArePure = callArgs.every((arg) => !hasSideEffects(arg));
  return bodyIsPure && allArgsArePure;
}

function handleExpressionStatement(
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
    // For side-effectful expressions, use local _ = <expr> pattern, which is always
    // valid Lua regardless of the expression type (call, arithmetic, function, etc.)
    return [tstl.createVariableDeclarationStatement([tstl.createIdentifier("_")], [inlined])];
  }

  if (target.kind === "statementsWithReturn") {
    context.diagnostics.push(
      createInlineWarning(callNode, "return-value function called at void site", strict),
    );
    return undefined;
  }

  const canInlineResult = canInlineStatements(target, callNode, checker);
  if (canInlineResult !== true) {
    context.diagnostics.push(createInlineWarning(callNode, canInlineResult, strict));
    return undefined;
  }

  if (target.bodyStmts.length === 0) return [];

  if (rejectIfCrossModuleFreeVar(callNode, target, target.bodyStmts, checker, context, strict)) {
    return undefined;
  }

  return buildDoEndBlock(target, callNode, checker, context);
}

function handleFunctionDeclaration(
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

function handleVariableStatementDeclaration(
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

function isExported(node: ts.FunctionDeclaration | ts.VariableStatement): boolean {
  if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0) {
    return true;
  }

  // Check for `export { name }` or `export { name as alias }` blocks.
  let declName: string | undefined;
  if (ts.isFunctionDeclaration(node)) {
    declName = node.name?.text;
  } else {
    const firstDecl = node.declarationList.declarations[0];
    if (firstDecl && ts.isIdentifier(firstDecl.name)) {
      declName = firstDecl.name.text;
    }
  }
  if (declName === undefined) return false;

  return node.getSourceFile().statements.some(
    (stmt) =>
      ts.isExportDeclaration(stmt) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause) &&
      stmt.exportClause.elements.some(
        // propertyName is the local name in `export { foo as bar }`;
        // falls back to name.text for plain `export { foo }`.
        (s) => (s.propertyName?.text ?? s.name.text) === declName,
      ),
  );
}

export const createVisitors: RuleFactory = (checker, config) => {
  const inlineCfg = resolveInlineConfig(config.rules.inline);
  if (!inlineCfg.enabled) return {};
  // Read per-rule strict directly from raw config to distinguish "not set" (undefined)
  // from "explicitly disabled" (false). resolveInlineConfig normalizes both to false.
  const rawInline = config.rules.inline;
  const perRuleStrict = isRecord(rawInline) ? (rawInline.strict as boolean | undefined) : undefined;
  const strictMode = resolveEffectiveStrict(config.strict ?? false, perRuleStrict);

  // Returning undefined signals "not handled" to the merge wrapper; the strict
  // tstl.Visitors type doesn't model this protocol, so we cast here.
  type LooseVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
  const visitors: Record<number, LooseVisitor> = {
    [ts.SyntaxKind.CallExpression]: (node, context) => {
      if (!ts.isCallExpression(node)) return undefined;
      return handleCallExpression(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.ExpressionStatement]: (node, context) => {
      if (!ts.isExpressionStatement(node)) return undefined;
      return handleExpressionStatement(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.VariableStatement]: (node, context) => {
      if (!ts.isVariableStatement(node)) return undefined;
      return (
        handleVariableStatement(node, checker, context, strictMode) ??
        handleVariableStatementDeclaration(node, checker)
      );
    },
    [ts.SyntaxKind.ReturnStatement]: (node, context) => {
      if (!ts.isReturnStatement(node)) return undefined;
      return handleReturnStatement(node, checker, context, strictMode);
    },
    [ts.SyntaxKind.FunctionDeclaration]: (node) => {
      if (!ts.isFunctionDeclaration(node)) return undefined;
      return handleFunctionDeclaration(node, checker);
    },
  };
  return visitors as tstl.Visitors;
};
