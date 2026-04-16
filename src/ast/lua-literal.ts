// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import type { ConstantValue } from "../config";

export function getLiteralValue(expr: tstl.Expression): ConstantValue | undefined {
  let current = expr;
  while (tstl.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  if (tstl.isNumericLiteral(current)) {
    return current.value;
  }

  if (tstl.isStringLiteral(current)) {
    return current.value;
  }

  if (current.kind === tstl.SyntaxKind.TrueKeyword) {
    return true;
  }

  if (current.kind === tstl.SyntaxKind.FalseKeyword) {
    return false;
  }

  if (
    tstl.isUnaryExpression(current) &&
    current.operator === tstl.SyntaxKind.NegationOperator &&
    tstl.isNumericLiteral(current.operand)
  ) {
    return -current.operand.value;
  }

  return undefined;
}

export function createNegativeLiteral(value: number): tstl.Expression {
  return tstl.createParenthesizedExpression(
    tstl.createUnaryExpression(
      tstl.createNumericLiteral(Math.abs(value)),
      tstl.SyntaxKind.NegationOperator,
    ),
  );
}

export function createLiteral(
  value: ConstantValue,
  options?: { wrapNegativeNumber?: boolean },
): tstl.Expression {
  if (typeof value === "number") {
    if (options?.wrapNegativeNumber && value < 0) {
      return createNegativeLiteral(value);
    }
    return tstl.createNumericLiteral(value);
  }

  if (typeof value === "string") {
    return tstl.createStringLiteral(value);
  }

  return tstl.createBooleanLiteral(value);
}
