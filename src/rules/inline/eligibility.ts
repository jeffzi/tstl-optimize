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
    /* v8 ignore next -- source-map artifact: closing brace has no distinct V8 instruction after a return */
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
    if (param.initializer)
      return {
        reason: "default parameters are not supported",
        code: InlineDiagnosticCode.parameterRestriction,
      };
  }
  const requiredParamCount = params.filter((p) => !p.questionToken).length;
  if (args.length < requiredParamCount || args.length > params.length)
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
    const callArg = callNode.arguments[i];
    if (callArg === undefined) continue;
    if (
      usageCount !== 1 &&
      hasSideEffects(
        callArg,
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
    // becomes a return/break/continue inside a do...end in Lua, which returns from
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
      if (analyzeParamUsage(node, paramSymbol, checker).isWritten)
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

/**
 * Returns true if a side-effectful sub-expression appears before the parameter's
 * first use in left-to-right evaluation order within the body expression, OR if
 * another parameter with a side-effectful argument appears in a different order
 * than the parameter list (parameter reordering with multiple side-effectful args).
 */
function hasSideEffectBeforeParamUse(
  bodyExpr: ts.Expression,
  targetParamIndex: number,
  paramSymbols: readonly ts.Symbol[],
  callArgs: ts.NodeArray<ts.Expression>,
  checker: ts.TypeChecker,
): boolean {
  // Identify which parameters have side-effectful arguments
  const sideEffectArgIndices = new Set<number>();
  for (let i = 0; i < paramSymbols.length; i++) {
    const callArg = callArgs[i];
    if (callArg === undefined) continue;
    if (hasSideEffects(callArg, SideEffectOptions.None)) {
      sideEffectArgIndices.add(i);
    }
  }

  // Walk the body and find:
  // 1. If there's a side-effect before the target param's first use
  // 2. If there's another param with SE arg appearing before target param in eval order
  // TS does not narrow `ts.Expression` from `switch (expr.kind)` into the corresponding node
  // subtype. Each arm casts `expr` to the correct interface — the unavoidable pattern when
  // using the TypeScript compiler API's kind-based dispatch.
  function containsTargetParam(expr: ts.Expression): boolean {
    let found = false;
    function visit(node: ts.Node): void {
      if (found) return;
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node)) {
        return;
      }
      if (ts.isIdentifier(node)) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym === paramSymbols[targetParamIndex]) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(expr);
    return found;
  }

  function findFirstParamWithSEOrSE(expr: ts.Expression): "side-effect" | number | undefined {
    // Returns: "side-effect" if SE found, param-index if param with SE arg found, undefined otherwise
    switch (expr.kind) {
      // --- Always side-effectful (handled specially below for CallExpression) ---
      case ts.SyntaxKind.PostfixUnaryExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.DeleteExpression:
        return "side-effect";

      // --- Transparent wrappers ---
      case ts.SyntaxKind.TypeAssertionExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.NonNullExpression:
      case ts.SyntaxKind.VoidExpression:
      case ts.SyntaxKind.TypeOfExpression:
        return findFirstParamWithSEOrSE(
          (
            expr as
              | ts.AssertionExpression
              | ts.SatisfiesExpression
              | ts.ParenthesizedExpression
              | ts.NonNullExpression
              | ts.VoidExpression
              | ts.TypeOfExpression
          ).expression,
        );

      case ts.SyntaxKind.SpreadElement:
        return "side-effect";

      // --- Identifier: check if it's a parameter ---
      case ts.SyntaxKind.Identifier: {
        const sym = checker.getSymbolAtLocation(expr as ts.Identifier);
        for (let i = 0; i < paramSymbols.length; i++) {
          if (sym === paramSymbols[i]) {
            return sideEffectArgIndices.has(i) ? i : undefined;
          }
        }
        return undefined;
      }

      // --- Literals ---
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.BigIntLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
        return undefined;

      // --- Binary expression: eval left first, then right ---
      case ts.SyntaxKind.BinaryExpression: {
        const bin = expr as ts.BinaryExpression;
        const leftResult = findFirstParamWithSEOrSE(bin.left);
        if (leftResult !== undefined) return leftResult;
        if (
          (bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
          containsTargetParam(bin.right)
        ) {
          return "side-effect";
        }
        return findFirstParamWithSEOrSE(bin.right);
      }

      // --- Prefix unary ---
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const prefix = expr as ts.PrefixUnaryExpression;
        if (
          prefix.operator === ts.SyntaxKind.PlusPlusToken ||
          prefix.operator === ts.SyntaxKind.MinusMinusToken
        ) {
          return "side-effect";
        }
        return findFirstParamWithSEOrSE(prefix.operand);
      }

      // --- Property access ---
      case ts.SyntaxKind.PropertyAccessExpression: {
        const propAccess = expr as ts.PropertyAccessExpression;
        const objResult = findFirstParamWithSEOrSE(propAccess.expression);
        if (objResult !== undefined) return objResult;
        // Property reads can invoke getters (arbitrary side effects), so conservatively treat
        // the read itself as a side effect even when the object expression is pure.
        return "side-effect";
      }

      // --- Element access ---
      case ts.SyntaxKind.ElementAccessExpression: {
        const elemAccess = expr as ts.ElementAccessExpression;
        const objResult = findFirstParamWithSEOrSE(elemAccess.expression);
        if (objResult !== undefined) return objResult;
        const indexResult = findFirstParamWithSEOrSE(elemAccess.argumentExpression);
        if (indexResult !== undefined) return indexResult;
        return "side-effect";
      }

      // --- Call expression ---
      case ts.SyntaxKind.CallExpression: {
        const call = expr as ts.CallExpression;
        const calleeResult = findFirstParamWithSEOrSE(call.expression);
        if (calleeResult !== undefined) return calleeResult;
        for (const arg of call.arguments) {
          const argResult = findFirstParamWithSEOrSE(arg);
          if (argResult !== undefined) return argResult;
        }
        return "side-effect";
      }

      // --- New expression ---
      case ts.SyntaxKind.NewExpression: {
        const newExpr = expr as ts.NewExpression;
        const exprResult = findFirstParamWithSEOrSE(newExpr.expression);
        if (exprResult !== undefined) return exprResult;
        if (newExpr.arguments) {
          for (const arg of newExpr.arguments) {
            const argResult = findFirstParamWithSEOrSE(arg);
            if (argResult !== undefined) return argResult;
          }
        }
        return "side-effect";
      }

      // --- Tagged template ---
      case ts.SyntaxKind.TaggedTemplateExpression: {
        const tte = expr as ts.TaggedTemplateExpression;
        const tagResult = findFirstParamWithSEOrSE(tte.tag);
        if (tagResult !== undefined) return tagResult;
        if (tte.template.kind === ts.SyntaxKind.TemplateExpression) {
          const template = tte.template as ts.TemplateExpression;
          for (const span of template.templateSpans) {
            const spanResult = findFirstParamWithSEOrSE(span.expression);
            if (spanResult !== undefined) return spanResult;
          }
        }
        return "side-effect";
      }

      // --- Template expression ---
      case ts.SyntaxKind.TemplateExpression: {
        const template = expr as ts.TemplateExpression;
        for (const span of template.templateSpans) {
          const spanResult = findFirstParamWithSEOrSE(span.expression);
          if (spanResult !== undefined) return spanResult;
        }
        return undefined;
      }

      // --- Array literal ---
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const arr = expr as ts.ArrayLiteralExpression;
        for (const elem of arr.elements) {
          if (ts.isSyntheticExpression(elem)) continue;
          if (elem.kind === ts.SyntaxKind.SpreadElement) return "side-effect";
          const elemResult = findFirstParamWithSEOrSE(elem);
          if (elemResult !== undefined) return elemResult;
        }
        return undefined;
      }

      // --- Object literal ---
      case ts.SyntaxKind.ObjectLiteralExpression: {
        const obj = expr as ts.ObjectLiteralExpression;
        for (const prop of obj.properties) {
          if (prop.name?.kind === ts.SyntaxKind.ComputedPropertyName) {
            const keyResult = findFirstParamWithSEOrSE(
              (prop.name as ts.ComputedPropertyName).expression,
            );
            if (keyResult !== undefined) return keyResult;
          }

          switch (prop.kind) {
            case ts.SyntaxKind.PropertyAssignment: {
              const propAssign = prop as ts.PropertyAssignment;
              const valueResult = findFirstParamWithSEOrSE(propAssign.initializer);
              if (valueResult !== undefined) return valueResult;
              break;
            }
            case ts.SyntaxKind.SpreadAssignment:
              return "side-effect";
            case ts.SyntaxKind.ShorthandPropertyAssignment:
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.GetAccessor:
            case ts.SyntaxKind.SetAccessor:
              break;
            /* v8 ignore next -- defensive fallthrough for property kinds not present in valid inline bodies */
            default:
              return "side-effect";
          }
        }
        return undefined;
      }

      // --- Conditional expression ---
      case ts.SyntaxKind.ConditionalExpression: {
        const cond = expr as ts.ConditionalExpression;
        const condResult = findFirstParamWithSEOrSE(cond.condition);
        if (condResult !== undefined) return condResult;

        const thenResult = findFirstParamWithSEOrSE(cond.whenTrue);
        const elseResult = findFirstParamWithSEOrSE(cond.whenFalse);

        // If either branch has a param or SE, return side-effect
        // (params behind conditionals need eager temps)
        if (thenResult !== undefined || elseResult !== undefined) {
          return "side-effect";
        }
        return undefined;
      }

      // --- Function definition ---
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
        return undefined;

      // --- Class expression ---
      case ts.SyntaxKind.ClassExpression:
        return "side-effect";

      // --- Default ---
      /* v8 ignore next -- defensive fallthrough for expression kinds not present in valid inline bodies */
      default:
        return "side-effect";
    }
  }

  const firstResult = findFirstParamWithSEOrSE(bodyExpr);

  // Need eager temps if:
  // 1. There's a side-effect before this param's first use
  if (firstResult === "side-effect") {
    return true;
  }

  // 2. Another parameter with a side-effectful arg appears before the target in eval order
  if (typeof firstResult === "number") {
    // firstResult is a param index with SE arg
    // If this other param appears before target in eval but after in param list, or vice versa,
    // we need temps for both
    if (firstResult !== targetParamIndex) {
      return true; // Different param with SE arg appears first
    }
  }

  return false;
}

export function needsEagerArgumentTemps(
  target: ExpressionInlineTarget,
  callNode: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const paramSymbols: ts.Symbol[] = [];
  for (const param of target.params) {
    const paramSymbol = checker.getSymbolAtLocation(param.name);
    /* v8 ignore next -- TypeChecker always resolves symbols for named parameters in valid TS */
    if (!paramSymbol) return false;
    paramSymbols.push(paramSymbol);
  }

  for (let i = 0; i < target.params.length; i++) {
    const paramSymbol = paramSymbols[i];
    const usage = analyzeParamUsage(target.bodyExpr, paramSymbol, checker);
    if (usage.isCaptured) {
      return true;
    }

    const callArg = callNode.arguments[i];
    if (callArg === undefined) continue;
    if (
      usage.count === 1 &&
      hasSideEffects(callArg, SideEffectOptions.None) &&
      hasSideEffectBeforeParamUse(target.bodyExpr, i, paramSymbols, callNode.arguments, checker)
    ) {
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
