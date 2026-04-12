import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import {
  type ConstantValue,
  type RuleFactory,
  resolveConditionalCompilationConfig,
  resolveConditionalCompilationStrict,
  resolveEffectiveStrict,
} from "../config";

function isTruthy(value: ConstantValue): boolean {
  return value !== false && value !== 0 && value !== "";
}

export function evaluateCondition(
  expr: ts.Expression,
  constants: ReadonlyMap<string, ConstantValue>,
): ConstantValue | undefined {
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    return evaluateCondition(expr.expression, constants);
  }

  if (ts.isIdentifier(expr)) {
    return constants.get(expr.text);
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;

  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isStringLiteral(expr)) return expr.text;

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = evaluateCondition(expr.operand, constants);
    if (operand === undefined) return undefined;
    return !isTruthy(operand);
  }

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const operand = evaluateCondition(expr.operand, constants);
    if (operand === undefined) return undefined;
    if (typeof operand === "number") return -operand;
    return undefined;
  }

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;

    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = evaluateCondition(expr.left, constants);
      if (left === undefined) return undefined;
      if (!isTruthy(left)) return left;
      return evaluateCondition(expr.right, constants);
    }

    if (op === ts.SyntaxKind.BarBarToken) {
      const left = evaluateCondition(expr.left, constants);
      if (left === undefined) return undefined;
      if (isTruthy(left)) return left;
      return evaluateCondition(expr.right, constants);
    }

    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const left = evaluateCondition(expr.left, constants);
      const right = evaluateCondition(expr.right, constants);
      if (left === undefined || right === undefined) return undefined;
      const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      return isEq ? left === right : left !== right;
    }

    if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      const left = evaluateCondition(expr.left, constants);
      const right = evaluateCondition(expr.right, constants);
      if (left === undefined || right === undefined) return undefined;
      if (typeof left !== typeof right) return undefined;
      const isEq = op === ts.SyntaxKind.EqualsEqualsToken;
      return isEq ? left === right : left !== right;
    }
  }

  return undefined;
}

/** Unwrap a Block into its inner statements; pass non-blocks through. */
function unwrapBlock(stmt: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}

function blockRequiresScope(block: ts.Block): boolean {
  return block.statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
    }

    return (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    );
  });
}

function hasFollowingSiblingStatements(statement: ts.Statement): boolean {
  const parent = statement.parent;
  const statements = ts.isSourceFile(parent) || ts.isBlock(parent) ? parent.statements : undefined;
  if (statements === undefined) {
    return true;
  }

  return statements.indexOf(statement) < statements.length - 1;
}

function shouldPreserveFoldedBlock(block: ts.Block, owner: ts.Statement): boolean {
  return blockRequiresScope(block) && hasFollowingSiblingStatements(owner);
}

/**
 * Check if statements contain a direct (unconditional) break, return, or throw.
 * A break/return/throw inside an if statement is conditional and does not count.
 * Only direct statements at the top level count as stopping fallthrough.
 */
function containsBreakOrReturn(statements: readonly ts.Statement[]): boolean {
  for (const s of statements) {
    if (
      ts.isBreakStatement(s) ||
      ts.isContinueStatement(s) ||
      ts.isReturnStatement(s) ||
      ts.isThrowStatement(s)
    ) {
      return true;
    }
    if (ts.isBlock(s)) {
      if (containsBreakOrReturn(s.statements)) return true;
    }
    // Do NOT recurse into if statements — breaks inside them are conditional
  }
  return false;
}

function containsConditionalCaseBreak(
  statements: readonly ts.Statement[],
  topLevel = true,
): boolean {
  for (const statement of statements) {
    if (ts.isBreakStatement(statement)) {
      if (!topLevel) return true;
      continue;
    }

    if (ts.isBlock(statement)) {
      if (containsConditionalCaseBreak(statement.statements, topLevel)) return true;
      continue;
    }

    if (ts.isIfStatement(statement)) {
      if (containsConditionalCaseBreak(unwrapBlock(statement.thenStatement), false)) return true;
      if (
        statement.elseStatement &&
        containsConditionalCaseBreak(unwrapBlock(statement.elseStatement), false)
      ) {
        return true;
      }
      continue;
    }

    if (ts.isLabeledStatement(statement)) {
      if (containsConditionalCaseBreak([statement.statement], false)) return true;
      continue;
    }

    if (ts.isTryStatement(statement)) {
      if (containsConditionalCaseBreak(statement.tryBlock.statements, false)) return true;
      if (
        statement.catchClause &&
        containsConditionalCaseBreak(statement.catchClause.block.statements, false)
      ) {
        return true;
      }
      if (
        statement.finallyBlock &&
        containsConditionalCaseBreak(statement.finallyBlock.statements, false)
      ) {
        return true;
      }
    }
  }

  return false;
}

function constantToLuaLiteral(value: ConstantValue): tstl.Expression {
  if (typeof value === "boolean") return tstl.createBooleanLiteral(value);
  if (typeof value === "number") return tstl.createNumericLiteral(value);
  return tstl.createStringLiteral(value);
}

export const createVisitors: RuleFactory = (checker, config) => {
  const maybeResolved = resolveConditionalCompilationConfig(
    config.rules["conditional-compilation"],
  );
  if (maybeResolved === false) return {};
  // Rebind after guard so TypeScript narrows the type inside closures below
  const resolved = maybeResolved;

  // Resolve strict: per-rule override wins over global (same precedence as inline).
  const perRuleStrict = resolveConditionalCompilationStrict(
    config.rules["conditional-compilation"],
  );
  const effectiveStrict = resolveEffectiveStrict(config.strict ?? false, perRuleStrict);

  function createPartialFoldingWarning(node: ts.Node): ts.Diagnostic {
    return {
      file: node.getSourceFile(),
      start: node.getStart(),
      length: node.getWidth(),
      messageText:
        "conditional-compilation: condition references compile-time constants " +
        "but could not be fully resolved — the entire branch is preserved at runtime",
      category: effectiveStrict ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
      code: 90002,
      source: "tstl-optimize",
    };
  }

  function declarationIsAmbientCompileTimeConstant(declaration: ts.Declaration): boolean {
    if (!ts.isVariableDeclaration(declaration)) {
      return false;
    }

    const list = declaration.parent;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) {
      return false;
    }

    const hasDeclare =
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ===
      true;

    return hasDeclare;
  }

  function getTopLevelConstInitializer(declaration: ts.Declaration): ts.Expression | undefined {
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
      return undefined;
    }

    const list = declaration.parent;
    const statement = list.parent;
    if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) {
      return undefined;
    }

    return (list.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer : undefined;
  }

  function evaluateLocalConstant(expr: ts.Expression): ConstantValue | undefined {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      return evaluateLocalConstant(expr.expression);
    }

    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (ts.isStringLiteral(expr)) return expr.text;

    if (
      ts.isPrefixUnaryExpression(expr) &&
      expr.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(expr.operand)
    ) {
      return -Number(expr.operand.text);
    }

    return undefined;
  }

  function resolveConfiguredIdentifier(node: ts.Identifier): ConstantValue | undefined {
    const configured = resolved.get(node.text);
    if (configured === undefined) {
      return undefined;
    }

    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) {
      return configured;
    }

    const declarations = symbol.declarations;
    if (declarations === undefined) {
      return configured;
    }

    if (declarations.every(declarationIsAmbientCompileTimeConstant)) {
      return configured;
    }

    const localValues = declarations
      .map((declaration) => {
        const initializer = getTopLevelConstInitializer(declaration);
        return initializer ? evaluateLocalConstant(initializer) : undefined;
      })
      .filter((value): value is ConstantValue => value !== undefined);
    if (localValues.length === declarations.length) {
      return localValues[0];
    }

    return undefined;
  }

  function evaluateScopedCondition(expr: ts.Expression): ConstantValue | undefined {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      return evaluateScopedCondition(expr.expression);
    }

    if (ts.isIdentifier(expr)) {
      return resolveConfiguredIdentifier(expr);
    }

    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;

    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (ts.isStringLiteral(expr)) return expr.text;

    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = evaluateScopedCondition(expr.operand);
      if (operand === undefined) return undefined;
      return !isTruthy(operand);
    }

    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
      const operand = evaluateScopedCondition(expr.operand);
      if (operand === undefined) return undefined;
      if (typeof operand === "number") return -operand;
      return undefined;
    }

    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;

      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const left = evaluateScopedCondition(expr.left);
        if (left === undefined) return undefined;
        if (!isTruthy(left)) return left;
        return evaluateScopedCondition(expr.right);
      }

      if (op === ts.SyntaxKind.BarBarToken) {
        const left = evaluateScopedCondition(expr.left);
        if (left === undefined) return undefined;
        if (isTruthy(left)) return left;
        return evaluateScopedCondition(expr.right);
      }

      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        const left = evaluateScopedCondition(expr.left);
        const right = evaluateScopedCondition(expr.right);
        if (left === undefined || right === undefined) return undefined;
        const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
        return isEq ? left === right : left !== right;
      }

      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
        const left = evaluateScopedCondition(expr.left);
        const right = evaluateScopedCondition(expr.right);
        if (left === undefined || right === undefined) return undefined;
        if (typeof left !== typeof right) return undefined;
        const isEq = op === ts.SyntaxKind.EqualsEqualsToken;
        return isEq ? left === right : left !== right;
      }
    }

    return undefined;
  }

  function referencesScopedConstants(expr: ts.Expression): boolean {
    if (ts.isIdentifier(expr)) {
      return resolveConfiguredIdentifier(expr) !== undefined;
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      return referencesScopedConstants(expr.expression);
    }
    if (ts.isPrefixUnaryExpression(expr)) return referencesScopedConstants(expr.operand);
    if (ts.isBinaryExpression(expr)) {
      return referencesScopedConstants(expr.left) || referencesScopedConstants(expr.right);
    }
    return false;
  }

  function tryFoldExpression(
    node: ts.Expression,
    context: tstl.TransformationContext,
  ): tstl.Expression {
    const value = evaluateScopedCondition(node);
    return value !== undefined
      ? constantToLuaLiteral(value)
      : context.superTransformExpression(node);
  }

  return {
    [ts.SyntaxKind.Identifier]: (node: ts.Identifier, context: tstl.TransformationContext) =>
      tryFoldExpression(node, context),

    [ts.SyntaxKind.BinaryExpression]: (
      node: ts.BinaryExpression,
      context: tstl.TransformationContext,
    ) => tryFoldExpression(node, context),

    [ts.SyntaxKind.PrefixUnaryExpression]: (
      node: ts.PrefixUnaryExpression,
      context: tstl.TransformationContext,
    ) => tryFoldExpression(node, context),

    [ts.SyntaxKind.IfStatement]: (node: ts.IfStatement, context: tstl.TransformationContext) => {
      const value = evaluateScopedCondition(node.expression);
      if (value === undefined) {
        if (referencesScopedConstants(node.expression)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformStatements(node);
      }

      const branch = isTruthy(value) ? node.thenStatement : node.elseStatement;
      if (!branch) {
        return undefined;
      }

      return ts.isBlock(branch) && !shouldPreserveFoldedBlock(branch, node)
        ? branch.statements.flatMap((statement) => context.transformStatements(statement))
        : context.transformStatements(branch);
    },

    [ts.SyntaxKind.ConditionalExpression]: (
      node: ts.ConditionalExpression,
      context: tstl.TransformationContext,
    ) => {
      const value = evaluateScopedCondition(node.condition);
      if (value === undefined) {
        if (referencesScopedConstants(node.condition)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformExpression(node);
      }

      return isTruthy(value)
        ? context.transformExpression(node.whenTrue)
        : context.transformExpression(node.whenFalse);
    },

    [ts.SyntaxKind.SwitchStatement]: (
      node: ts.SwitchStatement,
      context: tstl.TransformationContext,
    ) => {
      const switchValue = evaluateScopedCondition(node.expression);
      if (switchValue === undefined) {
        if (referencesScopedConstants(node.expression)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformStatements(node);
      }

      const { clauses } = node.caseBlock;

      let hasUnresolvedCase = false;
      let hasUnresolvedCaseBeforeMatch = false;
      let matchIndex = -1;

      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i];
        if (ts.isCaseClause(clause)) {
          const caseValue = evaluateScopedCondition(clause.expression);
          if (caseValue === undefined) {
            hasUnresolvedCase = true;
          } else if (matchIndex === -1 && caseValue === switchValue) {
            hasUnresolvedCaseBeforeMatch = hasUnresolvedCase;
            matchIndex = i;
          }
        }
      }

      // If no resolved case matches and there are unresolved cases,
      // we cannot determine the outcome at compile time. Preserve the switch.
      // Likewise, if a resolved match is preceded by an unresolved case,
      // that earlier clause could shadow the later match at runtime.
      if ((matchIndex === -1 && hasUnresolvedCase) || hasUnresolvedCaseBeforeMatch) {
        return context.superTransformStatements(node);
      }

      if (matchIndex === -1) {
        matchIndex = clauses.findIndex((c) => ts.isDefaultClause(c));
      }

      // No match and no default → strip entire switch
      if (matchIndex === -1) return undefined;

      // Collect statements respecting fallthrough semantics.
      // When a top-level statement is a Block, recurse into it and strip its
      // direct breaks — but never descend into loops or nested switches, since
      // their breaks belong to those constructs and must be preserved.
      function stripCaseBreaks(statement: ts.Statement): ts.Statement | undefined {
        if (ts.isBreakStatement(statement)) {
          return undefined;
        }

        if (
          ts.isBlock(statement) &&
          !ts.isIterationStatement(statement, false) &&
          !ts.isSwitchStatement(statement)
        ) {
          return ts.factory.updateBlock(
            statement,
            statement.statements.flatMap((child) => {
              const stripped = stripCaseBreaks(child);
              return stripped ? [stripped] : [];
            }),
          );
        }

        return statement;
      }

      function collectStrippingCaseBreaks(stmts: readonly ts.Statement[]): ts.Statement[] {
        const result: ts.Statement[] = [];
        for (const statement of stmts) {
          if (
            ts.isBlock(statement) &&
            !ts.isIterationStatement(statement, false) &&
            !ts.isSwitchStatement(statement)
          ) {
            const strippedBlock = stripCaseBreaks(statement);
            if (strippedBlock === undefined || !ts.isBlock(strippedBlock)) {
              continue;
            }

            if (shouldPreserveFoldedBlock(strippedBlock, node)) {
              result.push(strippedBlock);
            } else {
              result.push(...strippedBlock.statements);
            }
            continue;
          }

          const stripped = stripCaseBreaks(statement);
          if (stripped !== undefined) {
            result.push(stripped);
          }
        }
        return result;
      }

      const collected: ts.Statement[] = [];
      for (let i = matchIndex; i < clauses.length; i++) {
        const stmts = clauses[i].statements;
        if (containsConditionalCaseBreak(stmts)) {
          return context.superTransformStatements(node);
        }
        collected.push(...collectStrippingCaseBreaks(stmts));
        if (containsBreakOrReturn(stmts)) break;
      }

      return collected.flatMap((s) => context.transformStatements(s));
    },
  };
};
