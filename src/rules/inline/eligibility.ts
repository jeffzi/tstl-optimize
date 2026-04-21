import { AccessKind, getAccessKind } from "ts-api-utils";
import ts from "typescript";
import { hasSideEffects, SideEffectOptions } from "../../ast/ts-ast";
import { hasCrossModuleFreeVariable, isDescendant } from "./cross-module";
import { InlineDiagnosticCode } from "./diagnostics";
import type {
  ExpressionInlineTarget,
  ReturnValueInlineTarget,
  StatementInlineTarget,
} from "./target";
import { getInlineTarget, isDeclarationNameReference, resolveSymbol } from "./target";

export interface InlineRejection {
  reason: string;
  code: number;
}

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
      canInline(target, callNode, checker) === undefined &&
      !hasBlockingFreeVariable([target.bodyExpr], target.declaration, target.params)
    );
  }

  if (target.kind === "statements") {
    return (
      ts.isExpressionStatement(callNode.parent) &&
      canInlineStatements(target, callNode, checker) === undefined &&
      !hasBlockingFreeVariable(target.bodyStmts, target.declaration, target.params)
    );
  }

  if (ts.isReturnStatement(callNode.parent)) {
    return (
      canInlineStatements(target, callNode, checker) === undefined &&
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
    canInlineStatements(target, callNode, checker) === undefined &&
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

function analyzeParamUsage(
  body: ts.Node,
  paramSymbol: ts.Symbol,
  checker: ts.TypeChecker,
): { isCaptured: boolean; isWritten: boolean; count: number } {
  const isCapturedByNestedFunction = (node: ts.Identifier): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isFunctionLike(current)) {
        return ts.isFunctionLike(body)
          ? current === body || isDescendant(current, body)
          : isDescendant(current, body);
      }
      current = current.parent;
    }
    return false;
  };

  let isCaptured = false;
  let isWritten = false;
  let count = 0;
  function visit(n: ts.Node): void {
    if (ts.isIdentifier(n)) {
      const sym = checker.getSymbolAtLocation(n);
      if (sym === paramSymbol) {
        if (isCapturedByNestedFunction(n)) isCaptured = true;
        if (getAccessKind(n) & AccessKind.Write) isWritten = true;
        count++;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(body);
  return { isCaptured, isWritten, count };
}

function checkSharedPrereqs(
  params: readonly ts.ParameterDeclaration[],
  args: ts.NodeArray<ts.Expression>,
  declaration: ts.Node,
): InlineRejection | undefined {
  for (const param of params) {
    if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name))
      return {
        reason: "destructuring parameters are not supported",
        code: InlineDiagnosticCode.parameterRestriction,
      };
    if (param.dotDotDotToken)
      return {
        reason: "rest parameters are not supported",
        code: InlineDiagnosticCode.parameterRestriction,
      };
    if (param.questionToken)
      return {
        reason: "optional parameters are not supported",
        code: InlineDiagnosticCode.parameterRestriction,
      };
    if (param.initializer)
      return {
        reason: "default parameters are not supported",
        code: InlineDiagnosticCode.parameterRestriction,
      };
  }
  if (args.length !== params.length)
    return {
      reason: "argument count does not match parameter count",
      code: InlineDiagnosticCode.parameterRestriction,
    };
  if (!isModuleScopeDeclaration(declaration))
    return {
      reason: "function must be declared at module scope",
      code: InlineDiagnosticCode.moduleScope,
    };
  return undefined;
}

export function canInline(
  target: ExpressionInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): InlineRejection | undefined {
  const { bodyExpr, params, declaration, resolvedSymbol } = target;

  const prereqFailure = checkSharedPrereqs(params, callNode.arguments, declaration);
  if (prereqFailure !== undefined) return prereqFailure;

  if (countReferences(bodyExpr, resolvedSymbol, checker) > 0)
    return {
      reason: "recursive functions cannot be inlined",
      code: InlineDiagnosticCode.recursion,
    };

  for (let i = 0; i < params.length; i++) {
    const paramSymbol = checker.getSymbolAtLocation(params[i].name);
    if (!paramSymbol)
      return {
        reason: "parameter symbol could not be resolved",
        code: InlineDiagnosticCode.parameterRestriction,
      };
    const { isWritten, count: usageCount } = analyzeParamUsage(bodyExpr, paramSymbol, checker);
    if (isWritten)
      return {
        reason: "parameter is written inside body",
        code: InlineDiagnosticCode.parameterRestriction,
      };
    if (
      usageCount !== 1 &&
      hasSideEffects(
        callNode.arguments[i],
        usageCount > 1 ? SideEffectOptions.ConsiderIdentityMutating : SideEffectOptions.None,
      )
    )
      return usageCount === 0
        ? {
            reason: "argument with side effects is not used",
            code: InlineDiagnosticCode.sideEffects,
          }
        : {
            reason: "argument with side effects is used multiple times",
            code: InlineDiagnosticCode.sideEffects,
          };
  }

  return undefined;
}

export function hasLinearControlFlow(
  stmts: readonly ts.Statement[],
  loopBody = false,
): InlineRejection | undefined {
  for (const stmt of stmts) {
    if (ts.isReturnStatement(stmt))
      return { reason: "early return in body", code: InlineDiagnosticCode.controlFlow };
    // break/continue inside a loop are scoped to that loop, not to the surrounding
    // do...end inline wrapper in Lua, so only reject them at the top level.
    if (!loopBody) {
      if (ts.isBreakStatement(stmt))
        return { reason: "break in body", code: InlineDiagnosticCode.controlFlow };
      if (ts.isContinueStatement(stmt))
        return { reason: "continue in body", code: InlineDiagnosticCode.controlFlow };
    }
    // Recurse into nested blocks: a return/break/continue inside an if/while/for
    // becomes a return/break/continue inside a do...end in Lua, which return s from
    // the enclosing function rather than just the inlined block, changing semantics.
    if (ts.isIfStatement(stmt)) {
      const thenResult = hasLinearControlFlow([stmt.thenStatement], loopBody);
      if (thenResult !== undefined) return thenResult;
      if (stmt.elseStatement) {
        const elseResult = hasLinearControlFlow([stmt.elseStatement], loopBody);
        if (elseResult !== undefined) return elseResult;
      }
    } else if (
      ts.isWhileStatement(stmt) ||
      ts.isForStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt)
    ) {
      const bodyResult = hasLinearControlFlow([stmt.statement], true);
      if (bodyResult !== undefined) return bodyResult;
    } else if (ts.isBlock(stmt)) {
      const blockResult = hasLinearControlFlow(stmt.statements, loopBody);
      if (blockResult !== undefined) return blockResult;
    } else if (ts.isDoStatement(stmt)) {
      const bodyResult = hasLinearControlFlow([stmt.statement], true);
      if (bodyResult !== undefined) return bodyResult;
    } else if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        // break inside switch is scoped to the switch — TSTL compiles switches to if-elseif chains
        const clauseResult = hasLinearControlFlow(clause.statements, true);
        if (clauseResult !== undefined) return clauseResult;
      }
    } else if (ts.isTryStatement(stmt)) {
      const tryResult = hasLinearControlFlow(stmt.tryBlock.statements, loopBody);
      if (tryResult !== undefined) return tryResult;
      if (stmt.catchClause) {
        const catchResult = hasLinearControlFlow(stmt.catchClause.block.statements, loopBody);
        if (catchResult !== undefined) return catchResult;
      }
      if (stmt.finallyBlock) {
        const finallyResult = hasLinearControlFlow(stmt.finallyBlock.statements, loopBody);
        if (finallyResult !== undefined) return finallyResult;
      }
    } else if (ts.isLabeledStatement(stmt)) {
      // Defensive only: current TSTL rejects labeled statements end-to-end, so
      // treat them as non-inlineable if one reaches this control-flow analysis.
      return { reason: "labeled statement in body", code: InlineDiagnosticCode.controlFlow };
    }
  }
  return undefined;
}

export function canInlineStatements(
  target: StatementInlineTarget | ReturnValueInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): InlineRejection | undefined {
  const { bodyStmts, params, declaration, resolvedSymbol } = target;
  // Include the return expression in checks so recursion and param-write detection
  // cover the full body. hasLinearControlFlow only receives bodyStmts — the terminal
  // return is not in that list and never constitutes an early return.
  const allNodes: ReadonlyArray<ts.Node> =
    target.kind === "statementsWithReturn" ? [...bodyStmts, target.returnExpr] : bodyStmts;

  const prereqFailure = checkSharedPrereqs(params, callNode.arguments, declaration);
  if (prereqFailure !== undefined) return prereqFailure;

  for (const node of allNodes) {
    if (countReferences(node, resolvedSymbol, checker) > 0)
      return {
        reason: "recursive functions cannot be inlined",
        code: InlineDiagnosticCode.recursion,
      };
  }

  for (const param of params) {
    const paramSymbol = checker.getSymbolAtLocation(param.name);
    if (!paramSymbol)
      return {
        reason: "parameter symbol could not be resolved",
        code: InlineDiagnosticCode.parameterRestriction,
      };
    for (const node of allNodes) {
      if (isParamWritten(node, paramSymbol, checker))
        return {
          reason: "parameter is written inside body",
          code: InlineDiagnosticCode.parameterRestriction,
        };
    }
  }

  const controlFlow = hasLinearControlFlow(bodyStmts);
  if (controlFlow !== undefined) return controlFlow;

  return undefined;
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

    const usage = analyzeParamUsage(target.bodyExpr, paramSymbol, checker);
    if (usage.isCaptured) {
      return true;
    }

    if (usage.count === 1 && hasSideEffects(callNode.arguments[i], SideEffectOptions.None)) {
      return true;
    }
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
  if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
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
