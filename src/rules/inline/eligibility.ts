import { AccessKind, getAccessKind } from "ts-api-utils";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import type * as tstl from "typescript-to-lua";
import { hasSideEffects, SideEffectOptions } from "../../ast/ts-ast";
import { createInlineWarning } from "./diagnostics";
import type {
  ExpressionInlineTarget,
  InlineTarget,
  ReturnValueInlineTarget,
  StatementInlineTarget,
} from "./target";
import { getInlineTarget, isDeclarationNameReference, resolveSymbol } from "./target";

export function isSupportedInlineBindingPattern(name: ts.BindingName): boolean {
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

export function isModuleScopeDeclaration(node: ts.Node): boolean {
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

export function isCallSiteFullyInlined(
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
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

export function canEraseInlineDeclaration(
  declaration: ts.FunctionDeclaration | ts.VariableDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const name = declaration.name;
  if (!name || !ts.isIdentifier(name)) return false;

  const symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return false;
  const resolvedSym = resolveSymbol(symbol, checker);

  let canErase = true;
  function visit(node: ts.Node): void {
    if (!canErase || ts.isTypeNode(node)) return;

    if (ts.isIdentifier(node)) {
      const refSymbol = checker.getSymbolAtLocation(node);
      if (refSymbol && resolveSymbol(refSymbol, checker) === resolvedSym) {
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

export function canInline(
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

export function hasLinearControlFlow(
  stmts: readonly ts.Statement[],
  loopBody = false,
): true | string {
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

export function canInlineStatements(
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

export function needsEagerArgumentTemps(
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

export function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

export function hasCrossModuleFreeVariable(
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

/**
 * If the call crosses module boundaries and the target has free variables from the source module,
 * pushes a diagnostic and returns true (caller should return undefined).
 */
export function rejectIfCrossModuleFreeVar(
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

export function isPureAtVoidSite(
  bodyExpr: ts.Expression,
  callArgs: ts.NodeArray<ts.Expression>,
): boolean {
  const bodyIsPure = !hasSideEffects(bodyExpr);
  const allArgsArePure = callArgs.every((arg) => !hasSideEffects(arg));
  return bodyIsPure && allArgsArePure;
}

export function isExported(node: ts.FunctionDeclaration | ts.VariableStatement): boolean {
  if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0) {
    return true;
  }

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
