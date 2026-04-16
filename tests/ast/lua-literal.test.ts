// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createLiteral, createNegativeLiteral, getLiteralValue } from "../../src/ast/lua-literal";

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

    expect(tstl.isParenthesizedExpression(result)).toBe(true);

    const parens = result as tstl.ParenthesizedExpression;
    expect(tstl.isUnaryExpression(parens.expression)).toBe(true);

    const unary = parens.expression as tstl.UnaryExpression;
    expect(unary.operator).toBe(tstl.SyntaxKind.NegationOperator);
    expect(tstl.isNumericLiteral(unary.operand)).toBe(true);

    expect((unary.operand as tstl.NumericLiteral).value).toBe(5);
  });
});

describe("createLiteral", () => {
  it("creates NumericLiteral for number", () => {
    const result = createLiteral(42);
    expect(tstl.isNumericLiteral(result)).toBe(true);
    expect((result as tstl.NumericLiteral).value).toBe(42);
  });

  it("creates StringLiteral for string", () => {
    const result = createLiteral("test");
    expect(tstl.isStringLiteral(result)).toBe(true);
    expect((result as tstl.StringLiteral).value).toBe("test");
  });

  it("creates BooleanLiteral for boolean", () => {
    const result = createLiteral(true);
    expect(
      result.kind === tstl.SyntaxKind.TrueKeyword || result.kind === tstl.SyntaxKind.FalseKeyword,
    ).toBe(true);
  });

  it("creates plain NumericLiteral for negative number without wrapNegativeNumber", () => {
    const result = createLiteral(-10);
    expect(tstl.isNumericLiteral(result)).toBe(true);
    expect((result as tstl.NumericLiteral).value).toBe(-10);
  });

  it("creates ParenthesizedExpression for negative number with wrapNegativeNumber: true", () => {
    const result = createLiteral(-10, { wrapNegativeNumber: true });
    expect(tstl.isParenthesizedExpression(result)).toBe(true);

    const parens = result as tstl.ParenthesizedExpression;
    expect(tstl.isUnaryExpression(parens.expression)).toBe(true);

    const unary = parens.expression as tstl.UnaryExpression;
    expect(unary.operator).toBe(tstl.SyntaxKind.NegationOperator);
    expect(tstl.isNumericLiteral(unary.operand)).toBe(true);

    expect((unary.operand as tstl.NumericLiteral).value).toBe(10);
  });
});
