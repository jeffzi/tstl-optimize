import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import { createLiteral } from "../../ast/lua-literal";
import type { ConstantValue } from "../../config";

export function isTruthy(value: ConstantValue): boolean {
  return value !== false && value !== 0 && value !== "";
}

export type IdentifierResolver = (node: ts.Identifier) => ConstantValue | undefined;

export function unwrapCompileTimeExpression(expr: ts.Expression): ts.Expression {
  let current = expr;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

export function evaluateLiteralExpression(expr: ts.Expression): ConstantValue | undefined {
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isStringLiteral(expr)) return expr.text;
  return undefined;
}

function evaluateEquality(
  operator: ts.SyntaxKind,
  left: ConstantValue,
  right: ConstantValue,
): boolean | undefined {
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
  if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
  if (operator === ts.SyntaxKind.EqualsEqualsToken) {
    // Loose equality allows type coercion (e.g., 1 == true), but we can only fold
    // when types match since ConstantValue lacks runtime type info to coerce correctly.
    if (typeof left !== typeof right) return undefined;
    return left === right;
  }
  if (operator === ts.SyntaxKind.ExclamationEqualsToken) {
    // Loose inequality; same type-matching constraint as loose equality.
    if (typeof left !== typeof right) return undefined;
    return left !== right;
  }
  // Unhandled operator — not an equality comparison
  return undefined;
}

export function evaluateResolvedExpression(
  expr: ts.Expression,
  resolveIdentifier: IdentifierResolver,
): ConstantValue | undefined {
  const unwrapped = unwrapCompileTimeExpression(expr);

  if (ts.isIdentifier(unwrapped)) {
    return resolveIdentifier(unwrapped);
  }

  const literalValue = evaluateLiteralExpression(unwrapped);
  if (literalValue !== undefined) {
    return literalValue;
  }

  if (ts.isPrefixUnaryExpression(unwrapped)) {
    if (unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = evaluateResolvedExpression(unwrapped.operand, resolveIdentifier);
      if (operand === undefined) return undefined;
      return !isTruthy(operand);
    }

    if (unwrapped.operator === ts.SyntaxKind.MinusToken) {
      const operand = evaluateResolvedExpression(unwrapped.operand, resolveIdentifier);
      if (operand === undefined || typeof operand !== "number") {
        return undefined;
      }
      return -operand;
    }

    return undefined;
  }

  if (!ts.isBinaryExpression(unwrapped)) {
    return undefined;
  }

  const operator = unwrapped.operatorToken.kind;

  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = evaluateResolvedExpression(unwrapped.left, resolveIdentifier);
    if (left === undefined) return undefined;
    if (!isTruthy(left)) return left;
    return evaluateResolvedExpression(unwrapped.right, resolveIdentifier);
  }

  if (operator === ts.SyntaxKind.BarBarToken) {
    const left = evaluateResolvedExpression(unwrapped.left, resolveIdentifier);
    if (left === undefined) return undefined;
    if (isTruthy(left)) return left;
    return evaluateResolvedExpression(unwrapped.right, resolveIdentifier);
  }

  const left = evaluateResolvedExpression(unwrapped.left, resolveIdentifier);
  const right = evaluateResolvedExpression(unwrapped.right, resolveIdentifier);
  if (left === undefined || right === undefined) {
    return undefined;
  }

  return evaluateEquality(operator, left, right);
}

export function evaluateCondition(
  expr: ts.Expression,
  constants: ReadonlyMap<string, ConstantValue>,
): ConstantValue | undefined {
  return evaluateResolvedExpression(expr, (node) => constants.get(node.text));
}

// Delegates to the shared literal factory; no wrapNegativeNumber needed here because
// the resolved-constant path never lands a folded negative in a negation-sensitive context.
export function constantToLuaLiteral(value: ConstantValue): tstl.Expression {
  return createLiteral(value);
}
