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
  if (ts.isParenthesizedExpression(expr)) {
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
      return op === ts.SyntaxKind.EqualsEqualsEqualsToken ? left === right : left !== right;
    }
  }

  return undefined;
}

/** Unwrap a Block into its inner statements; pass non-blocks through. */
function unwrapBlock(stmt: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}

function containsBreakOrReturn(statements: readonly ts.Statement[]): boolean {
  for (const s of statements) {
    if (ts.isBreakStatement(s) || ts.isReturnStatement(s)) return true;
    if (ts.isIfStatement(s)) {
      const thenStmts = ts.isBlock(s.thenStatement)
        ? s.thenStatement.statements
        : [s.thenStatement];
      if (containsBreakOrReturn(thenStmts)) return true;
      if (s.elseStatement) {
        const elseStmts = ts.isBlock(s.elseStatement)
          ? s.elseStatement.statements
          : [s.elseStatement];
        if (containsBreakOrReturn(elseStmts)) return true;
      }
    }
    if (ts.isBlock(s)) {
      if (containsBreakOrReturn(s.statements)) return true;
    }
  }
  return false;
}

function referencesKnownConstants(
  expr: ts.Expression,
  constants: ReadonlyMap<string, ConstantValue>,
): boolean {
  if (ts.isIdentifier(expr)) return constants.has(expr.text);
  if (ts.isParenthesizedExpression(expr))
    return referencesKnownConstants(expr.expression, constants);
  if (ts.isPrefixUnaryExpression(expr)) return referencesKnownConstants(expr.operand, constants);
  if (ts.isBinaryExpression(expr))
    return (
      referencesKnownConstants(expr.left, constants) ||
      referencesKnownConstants(expr.right, constants)
    );
  return false;
}

function constantToLuaLiteral(value: ConstantValue): tstl.Expression {
  if (typeof value === "boolean") return tstl.createBooleanLiteral(value);
  if (typeof value === "number") return tstl.createNumericLiteral(value);
  return tstl.createStringLiteral(value);
}

export const createVisitors: RuleFactory = (_checker, config) => {
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

  function tryFoldExpression(
    node: ts.Expression,
    context: tstl.TransformationContext,
  ): tstl.Expression {
    const value = evaluateCondition(node, resolved);
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
      const value = evaluateCondition(node.expression, resolved);
      if (value === undefined) {
        if (referencesKnownConstants(node.expression, resolved)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformStatements(node);
      }

      const branch = isTruthy(value) ? node.thenStatement : node.elseStatement;
      return branch
        ? unwrapBlock(branch).flatMap((s) => context.transformStatements(s))
        : undefined;
    },

    [ts.SyntaxKind.ConditionalExpression]: (
      node: ts.ConditionalExpression,
      context: tstl.TransformationContext,
    ) => {
      const value = evaluateCondition(node.condition, resolved);
      if (value === undefined) {
        if (referencesKnownConstants(node.condition, resolved)) {
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
      const switchValue = evaluateCondition(node.expression, resolved);
      if (switchValue === undefined) {
        if (referencesKnownConstants(node.expression, resolved)) {
          context.diagnostics.push(createPartialFoldingWarning(node));
        }
        return context.superTransformStatements(node);
      }

      const { clauses } = node.caseBlock;

      // Find the first matching CaseClause, or fall back to DefaultClause
      let matchIndex = -1;
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i];
        if (ts.isCaseClause(clause)) {
          const caseValue = evaluateCondition(clause.expression, resolved);
          if (caseValue === switchValue) {
            matchIndex = i;
            break;
          }
        }
      }
      if (matchIndex === -1) {
        matchIndex = clauses.findIndex((c) => ts.isDefaultClause(c));
      }

      // No match and no default → strip entire switch
      if (matchIndex === -1) return undefined;

      // Collect statements respecting fallthrough semantics
      const collected: ts.Statement[] = [];
      for (let i = matchIndex; i < clauses.length; i++) {
        const stmts = clauses[i].statements;
        for (const s of stmts) {
          if (!ts.isBreakStatement(s)) collected.push(s);
        }
        if (containsBreakOrReturn(stmts)) break;
      }

      return collected.flatMap((s) => context.transformStatements(s));
    },
  };
};
