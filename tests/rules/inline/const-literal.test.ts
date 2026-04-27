import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  extractPrimitiveLiteral,
  type LiteralKind,
  resolveConstLiteral,
  synthesizeLiteralExpression,
} from "../../../src/rules/inline/const-literal";
import { makeChecker } from "./helpers";

function findVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  function visit(node: ts.Node): ts.VariableDeclaration | undefined {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      return node;
    }
    return ts.forEachChild(node, visit);
  }
  return visit(sourceFile);
}

describe("extractPrimitiveLiteral", () => {
  describe("numeric literals", () => {
    it.each([
      { name: "decimal", source: "42", expected: { kind: "number", value: 42 } },
      { name: "hex", source: "0xff", expected: { kind: "number", value: 255 } },
      { name: "octal", source: "0o10", expected: { kind: "number", value: 8 } },
      { name: "binary", source: "0b1010", expected: { kind: "number", value: 10 } },
      { name: "float", source: "3.14", expected: { kind: "number", value: 3.14 } },
    ])("$name → { kind: number, value: $expected.value }", ({ source, expected }) => {
      const node = ts.factory.createNumericLiteral(source);
      expect(extractPrimitiveLiteral(node)).toStrictEqual(expected);
    });
  });

  describe("string literals", () => {
    it.each([
      { name: "string literal", expected: { kind: "string", value: "hello" } },
      { name: "single-quoted", expected: { kind: "string", value: "world" } },
      { name: "empty string", expected: { kind: "string", value: "" } },
    ])("$name → { kind: string, value: $expected.value }", ({ expected }) => {
      const node = ts.factory.createStringLiteral(expected.value);
      expect(extractPrimitiveLiteral(node)).toStrictEqual(expected);
    });
  });

  describe("no-substitution template literal", () => {
    it("extracts `` `hi` ``", () => {
      const node = ts.factory.createNoSubstitutionTemplateLiteral("hi");
      expect(extractPrimitiveLiteral(node)).toStrictEqual({
        kind: "string",
        value: "hi",
      });
    });
  });

  describe("boolean literals", () => {
    it.each([
      { value: true, node: ts.factory.createTrue() },
      { value: false, node: ts.factory.createFalse() },
    ])("extracts $value", ({ value, node }) => {
      expect(extractPrimitiveLiteral(node)).toStrictEqual({ kind: "boolean", value });
    });
  });

  describe("unary expressions", () => {
    it.each<{ name: string; operator: ts.PrefixUnaryOperator; operand: string; value: number }>([
      { name: "minus on 42", operator: ts.SyntaxKind.MinusToken, operand: "42", value: -42 },
      { name: "plus on 5", operator: ts.SyntaxKind.PlusToken, operand: "5", value: 5 },
      { name: "minus on 1", operator: ts.SyntaxKind.MinusToken, operand: "1", value: -1 },
    ])("$name → $value", ({ operator, operand, value }) => {
      const node = ts.factory.createPrefixUnaryExpression(
        operator,
        ts.factory.createNumericLiteral(operand),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual({ kind: "number", value });
    });
  });

  describe("parenthesized expressions", () => {
    it("unwraps (42)", () => {
      const node = ts.factory.createParenthesizedExpression(ts.factory.createNumericLiteral("42"));
      expect(extractPrimitiveLiteral(node)).toStrictEqual({
        kind: "number",
        value: 42,
      });
    });

    it("unwraps nested ((42))", () => {
      const node = ts.factory.createParenthesizedExpression(
        ts.factory.createParenthesizedExpression(ts.factory.createNumericLiteral("42")),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual({
        kind: "number",
        value: 42,
      });
    });
  });

  describe("as-expressions (TypeScript casting)", () => {
    it("unwraps 42 as const", () => {
      const node = ts.factory.createAsExpression(
        ts.factory.createNumericLiteral("42"),
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual({
        kind: "number",
        value: 42,
      });
    });

    it("unwraps 'hello' as string", () => {
      const node = ts.factory.createAsExpression(
        ts.factory.createStringLiteral("hello"),
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual({
        kind: "string",
        value: "hello",
      });
    });
  });

  describe("type assertion expressions", () => {
    it("unwraps <const>42", () => {
      const node = ts.factory.createTypeAssertion(
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        ts.factory.createNumericLiteral("42"),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual({
        kind: "number",
        value: 42,
      });
    });
  });

  describe("non-literal expressions", () => {
    it("returns undefined for identifier", () => {
      const node = ts.factory.createIdentifier("X");
      expect(extractPrimitiveLiteral(node)).toBeUndefined();
    });

    it("returns undefined for binary expression (1 + 2)", () => {
      const node = ts.factory.createBinaryExpression(
        ts.factory.createNumericLiteral("1"),
        ts.SyntaxKind.PlusToken,
        ts.factory.createNumericLiteral("2"),
      );
      expect(extractPrimitiveLiteral(node)).toBeUndefined();
    });

    it("returns undefined for object literal", () => {
      const node = ts.factory.createObjectLiteralExpression([
        ts.factory.createPropertyAssignment("a", ts.factory.createNumericLiteral("1")),
      ]);
      expect(extractPrimitiveLiteral(node)).toBeUndefined();
    });

    it("returns undefined for array literal", () => {
      const node = ts.factory.createArrayLiteralExpression([ts.factory.createNumericLiteral("1")]);
      expect(extractPrimitiveLiteral(node)).toBeUndefined();
    });

    it("returns undefined for call expression", () => {
      const node = ts.factory.createCallExpression(
        ts.factory.createIdentifier("fn"),
        undefined,
        [],
      );
      expect(extractPrimitiveLiteral(node)).toBeUndefined();
    });

    it("returns undefined for unary not on literal", () => {
      const node = ts.factory.createPrefixUnaryExpression(
        ts.SyntaxKind.ExclamationToken,
        ts.factory.createTrue(),
      );
      expect(extractPrimitiveLiteral(node)).toBeUndefined();
    });
  });
});

describe("synthesizeLiteralExpression", () => {
  describe("round-trip: synthesize then extract", () => {
    it.each<LiteralKind>([
      { kind: "number", value: 42 },
      { kind: "number", value: -5 },
      { kind: "number", value: 0 },
      { kind: "string", value: "hello" },
      { kind: "string", value: "" },
      { kind: "boolean", value: true },
      { kind: "boolean", value: false },
    ])("$kind: $value round-trips through synthesize and extract", (literal) => {
      const node = synthesizeLiteralExpression(literal);
      expect(extractPrimitiveLiteral(node)).toStrictEqual(literal);
    });
  });
});

describe("resolveConstLiteral", () => {
  it.each<{ source: string; expected: LiteralKind }>([
    { source: "const X = 42;", expected: { kind: "number", value: 42 } },
    { source: "const X = 'hello';", expected: { kind: "string", value: "hello" } },
    { source: "const X = true;", expected: { kind: "boolean", value: true } },
  ])("resolves primitive const literals in $source", ({ source, expected }) => {
    const { checker, sourceFile } = makeChecker(source);
    const declaration = findVariable(sourceFile, "X");
    if (!declaration) throw new Error("expected X declaration");
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) throw new Error("expected X symbol");

    expect(resolveConstLiteral(symbol)).toStrictEqual(expected);
  });

  it.each(["let X = 42;", "declare const X: number;"])("returns undefined for %s", (source) => {
    const { checker, sourceFile } = makeChecker(source);
    const declaration = findVariable(sourceFile, "X");
    if (!declaration) throw new Error("expected X declaration");
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) throw new Error("expected X symbol");

    expect(resolveConstLiteral(symbol)).toBeUndefined();
  });

  it("returns undefined for symbols without variable declarations", () => {
    const { checker, sourceFile } = makeChecker("function f(x: number) { return x; }");
    const parameter = sourceFile.forEachChild(function visit(node):
      | ts.ParameterDeclaration
      | undefined {
      if (ts.isParameter(node)) return node;
      return ts.forEachChild(node, visit);
    });
    if (!parameter) throw new Error("expected parameter");
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!symbol) throw new Error("expected parameter symbol");

    expect(resolveConstLiteral(symbol)).toBeUndefined();
  });
});
