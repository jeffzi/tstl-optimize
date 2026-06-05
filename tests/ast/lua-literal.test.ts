// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createLiteral, createNegativeLiteral, getLiteralValue } from "../../src/ast/lua-literal";

/**
 * Asserts that an expression is a ParenthesizedExpression and returns it.
 * Fails the test if the type check fails.
 */
function assertParenthesized(expr: tstl.Expression): asserts expr is tstl.ParenthesizedExpression {
  if (!tstl.isParenthesizedExpression(expr)) {
    throw new Error(`Expected ParenthesizedExpression, got ${expr.kind}`);
  }
}

/**
 * Asserts that an expression is a UnaryExpression and returns it.
 * Fails the test if the type check fails.
 */
function assertUnary(expr: tstl.Expression): asserts expr is tstl.UnaryExpression {
  if (!tstl.isUnaryExpression(expr)) {
    throw new Error(`Expected UnaryExpression, got ${expr.kind}`);
  }
}

/**
 * Asserts that an expression is a NumericLiteral and returns it.
 * Fails the test if the type check fails.
 */
function assertNumeric(expr: tstl.Expression): asserts expr is tstl.NumericLiteral {
  if (!tstl.isNumericLiteral(expr)) {
    throw new Error(`Expected NumericLiteral, got ${expr.kind}`);
  }
}

/**
 * Asserts that an expression is a StringLiteral and returns it.
 * Fails the test if the type check fails.
 */
function assertString(expr: tstl.Expression): asserts expr is tstl.StringLiteral {
  if (!tstl.isStringLiteral(expr)) {
    throw new Error(`Expected StringLiteral, got ${expr.kind}`);
  }
}

describe("getLiteralValue", () => {
  it.each([
    {
      name: "number",
      expr: tstl.createNumericLiteral(42),
      expected: 42,
    },
    {
      name: "string",
      expr: tstl.createStringLiteral("hello"),
      expected: "hello",
    },
    {
      name: "boolean true",
      expr: tstl.createBooleanLiteral(true),
      expected: true,
    },
    {
      name: "boolean false",
      expr: tstl.createBooleanLiteral(false),
      expected: false,
    },
    {
      name: "parenthesized number",
      expr: tstl.createParenthesizedExpression(tstl.createNumericLiteral(5)),
      expected: 5,
    },
    {
      name: "unary negation of numeric",
      expr: tstl.createUnaryExpression(
        tstl.createNumericLiteral(3),
        tstl.SyntaxKind.NegationOperator,
      ),
      expected: -3,
    },
  ])("returns $expected for $name", ({ expr, expected }) => {
    expect(getLiteralValue(expr)).toBe(expected);
  });

  it("returns undefined for non-literal (identifier)", () => {
    const expr = tstl.createIdentifier("x");
    expect(getLiteralValue(expr)).toBeUndefined();
  });
});

describe("createNegativeLiteral", () => {
  it("creates ParenthesizedExpression wrapping UnaryExpression with Math.abs", () => {
    const result = createNegativeLiteral(-5);

    assertParenthesized(result);
    assertUnary(result.expression);
    assertNumeric(result.expression.operand);

    expect(result.expression.operator).toBe(tstl.SyntaxKind.NegationOperator);
    expect(result.expression.operand.value).toBe(5);
  });
});

describe("createLiteral", () => {
  it("creates NumericLiteral for number", () => {
    const result = createLiteral(42);
    assertNumeric(result);
    expect(result.value).toBe(42);
  });

  it("creates StringLiteral for string", () => {
    const result = createLiteral("test");
    assertString(result);
    expect(result.value).toBe("test");
  });

  it("creates BooleanLiteral for boolean", () => {
    const result = createLiteral(true);
    const isBooleanLiteral =
      result.kind === tstl.SyntaxKind.TrueKeyword || result.kind === tstl.SyntaxKind.FalseKeyword;
    expect(isBooleanLiteral).toBe(true);
  });

  it("creates plain NumericLiteral for negative number without wrapNegativeNumber", () => {
    const result = createLiteral(-10);
    assertNumeric(result);
    expect(result.value).toBe(-10);
  });

  it("creates ParenthesizedExpression for negative number with wrapNegativeNumber: true", () => {
    const result = createLiteral(-10, { wrapNegativeNumber: true });
    assertParenthesized(result);
    assertUnary(result.expression);
    assertNumeric(result.expression.operand);

    expect(result.expression.operator).toBe(tstl.SyntaxKind.NegationOperator);
    expect(result.expression.operand.value).toBe(10);
  });
});
