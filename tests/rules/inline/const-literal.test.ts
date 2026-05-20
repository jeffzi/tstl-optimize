import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  extractPrimitiveLiteral,
  type LiteralKind,
  resolveConstLiteral,
  synthesizeLiteralExpression,
} from "../../../src/rules/inline/const-literal";
import { makeChecker } from "./helpers";

function findVariableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  function visit(node: ts.Node): ts.VariableDeclaration | undefined {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      return node;
    }
    return ts.forEachChild(node, visit);
  }
  return visit(sourceFile);
}

function getSymbolAtSourceLocation(
  source: string,
  variableName: string,
): { symbol: ts.Symbol; checker: ts.TypeChecker } {
  const { checker, sourceFile } = makeChecker(source);
  const declaration = findVariableDeclaration(sourceFile, variableName);
  if (!declaration) throw new Error(`expected ${variableName} declaration`);
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) throw new Error(`expected ${variableName} symbol`);
  return { symbol, checker };
}

function getSymbolFromSource(source: string, variableName: string): ts.Symbol {
  return getSymbolAtSourceLocation(source, variableName).symbol;
}

function resolveConstFromSource(
  source: string,
  variableName: string,
  withChecker = false,
): LiteralKind | undefined {
  const { symbol, checker } = getSymbolAtSourceLocation(source, variableName);
  return resolveConstLiteral(symbol, withChecker ? checker : undefined);
}

function resolveConstFromSourceWithChecker(
  source: string,
  variableName: string,
): LiteralKind | undefined {
  return resolveConstFromSource(source, variableName, true);
}

const primitiveLiteralCases: ReadonlyArray<{
  expected: LiteralKind;
  literalFactory: () => ts.Expression;
}> = [
  {
    literalFactory: () => ts.factory.createNumericLiteral("42"),
    expected: { kind: "number", value: 42 },
  },
  {
    literalFactory: () => ts.factory.createStringLiteral("hello"),
    expected: { kind: "string", value: "hello" },
  },
  { literalFactory: () => ts.factory.createTrue(), expected: { kind: "boolean", value: true } },
];

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
    it.each(primitiveLiteralCases)("unwraps $expected.kind literal as <type>", ({
      literalFactory,
      expected,
    }) => {
      const typeKind =
        expected.kind === "number"
          ? ts.SyntaxKind.NumberKeyword
          : expected.kind === "string"
            ? ts.SyntaxKind.StringKeyword
            : ts.SyntaxKind.BooleanKeyword;
      const node = ts.factory.createAsExpression(
        literalFactory(),
        ts.factory.createKeywordTypeNode(typeKind),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual(expected);
    });
  });

  describe("type assertion expressions", () => {
    it.each(primitiveLiteralCases)("unwraps <type> $expected.kind literal", ({
      literalFactory,
      expected,
    }) => {
      const typeKind =
        expected.kind === "number"
          ? ts.SyntaxKind.NumberKeyword
          : expected.kind === "string"
            ? ts.SyntaxKind.StringKeyword
            : ts.SyntaxKind.BooleanKeyword;
      const node = ts.factory.createTypeAssertion(
        ts.factory.createKeywordTypeNode(typeKind),
        literalFactory(),
      );
      expect(extractPrimitiveLiteral(node)).toStrictEqual(expected);
    });
  });

  describe("satisfies expressions", () => {
    function createTypeNodeForKind(kind: LiteralKind["kind"]): ts.KeywordTypeNode {
      const syntaxKind =
        kind === "number"
          ? ts.SyntaxKind.NumberKeyword
          : kind === "string"
            ? ts.SyntaxKind.StringKeyword
            : ts.SyntaxKind.BooleanKeyword;
      return ts.factory.createKeywordTypeNode(syntaxKind);
    }

    it.each(
      primitiveLiteralCases,
    )("unwraps $expected.kind satisfies and returns { kind: $expected.kind, value: $expected.value }", ({
      literalFactory,
      expected,
    }) => {
      const literal = literalFactory();
      const typeNode = createTypeNodeForKind(expected.kind);
      const node = ts.factory.createSatisfiesExpression(literal, typeNode);
      expect(extractPrimitiveLiteral(node)).toStrictEqual(expected);
    });
  });

  describe("non-null assertion expressions", () => {
    it.each(
      primitiveLiteralCases,
    )("unwraps $expected.kind! and returns { kind: $expected.kind, value: $expected.value }", ({
      literalFactory,
      expected,
    }) => {
      const literal = literalFactory();
      const node = ts.factory.createNonNullExpression(literal);
      expect(extractPrimitiveLiteral(node)).toStrictEqual(expected);
    });
  });

  describe("non-literal expressions", () => {
    it.each([
      { name: "identifier", node: ts.factory.createIdentifier("X") },
      {
        name: "binary expression (1 + 2)",
        node: ts.factory.createBinaryExpression(
          ts.factory.createNumericLiteral("1"),
          ts.SyntaxKind.PlusToken,
          ts.factory.createNumericLiteral("2"),
        ),
      },
      {
        name: "object literal",
        node: ts.factory.createObjectLiteralExpression([
          ts.factory.createPropertyAssignment("a", ts.factory.createNumericLiteral("1")),
        ]),
      },
      {
        name: "array literal",
        node: ts.factory.createArrayLiteralExpression([ts.factory.createNumericLiteral("1")]),
      },
      {
        name: "call expression",
        node: ts.factory.createCallExpression(ts.factory.createIdentifier("fn"), undefined, []),
      },
      {
        name: "unary not on literal",
        node: ts.factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          ts.factory.createTrue(),
        ),
      },
    ])("returns undefined for $name", ({ node }) => {
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
  describe("without checker", () => {
    it.each<{ source: string; expected: LiteralKind }>([
      { source: "const X = 42;", expected: { kind: "number", value: 42 } },
      { source: "const X = 'hello';", expected: { kind: "string", value: "hello" } },
      { source: "const X = true;", expected: { kind: "boolean", value: true } },
    ])("resolves primitive const literals in $source", ({ source, expected }) => {
      expect(resolveConstLiteral(getSymbolFromSource(source, "X"))).toStrictEqual(expected);
    });

    it.each(["let X = 42;", "declare const X: number;"])("returns undefined for %s", (source) => {
      expect(resolveConstLiteral(getSymbolFromSource(source, "X"))).toBeUndefined();
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

  describe("with checker", () => {
    describe("arithmetic binary ops", () => {
      it.each<{ source: string; expected: LiteralKind }>([
        { source: "const X = 2 ** 8;", expected: { kind: "number", value: 256 } },
        { source: "const X = 10 + 5;", expected: { kind: "number", value: 15 } },
        { source: "const X = 20 - 3;", expected: { kind: "number", value: 17 } },
        { source: "const X = 4 * 5;", expected: { kind: "number", value: 20 } },
        { source: "const X = 20 / 4;", expected: { kind: "number", value: 5 } },
        { source: "const X = 17 % 5;", expected: { kind: "number", value: 2 } },
      ])("evaluates $source to { kind: number, value: $expected.value }", ({
        source,
        expected,
      }) => {
        expect(resolveConstFromSourceWithChecker(source, "X")).toStrictEqual(expected);
      });
    });

    describe("modulo folding safety", () => {
      it.each([
        "const X = -17 % 5;",
        "const X = 17 % -5;",
        "const X = 0.3 % 0.2;",
      ])("returns undefined for %s", (source) => {
        expect(resolveConstFromSourceWithChecker(source, "X")).toBeUndefined();
      });
    });

    describe("bitwise binary ops", () => {
      it.each([
        { source: "const X = 8 << 2;" },
        { source: "const X = 32 >> 2;" },
        { source: "const X = -1 >>> 0;" },
        { source: "const X = 5 | 3;" },
        { source: "const X = 5 & 3;" },
        { source: "const X = 5 ^ 3;" },
      ])("does not evaluate $source", ({ source }) => {
        expect(resolveConstFromSourceWithChecker(source, "X")).toBeUndefined();
      });
    });

    describe("unary bitwise NOT", () => {
      it("does not evaluate const X = ~0;", () => {
        expect(resolveConstFromSourceWithChecker("const X = ~0;", "X")).toBeUndefined();
      });
    });

    describe("unary numeric expressions", () => {
      it.each([
        { source: "const BASE = 1;\nconst X = -BASE;", expected: -1 },
        { source: "const BASE = 1;\nconst X = +BASE;", expected: 1 },
      ])("evaluates $source", ({ source, expected }) => {
        expect(resolveConstFromSourceWithChecker(source, "X")).toStrictEqual({
          kind: "number",
          value: expected,
        });
      });
    });

    describe("string concatenation", () => {
      it('evaluates const X = "hello" + " world"; to { kind: string, value: "hello world" }', () => {
        expect(
          resolveConstFromSourceWithChecker('const X = "hello" + " world";', "X"),
        ).toStrictEqual({
          kind: "string",
          value: "hello world",
        });
      });
    });

    describe("identifier chain", () => {
      it("resolves const BITS = 24; const X = 2 ** BITS; to { kind: number, value: 16777216 }", () => {
        expect(
          resolveConstFromSourceWithChecker("const BITS = 24;\nconst X = 2 ** BITS;", "X"),
        ).toStrictEqual({
          kind: "number",
          value: 16777216,
        });
      });

      it("returns undefined when a const references a later same-file declaration", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = Y;\nconst Y = 1;", "X"),
        ).toBeUndefined();
      });
    });

    describe("deep chain", () => {
      it("resolves const A = 2; const B = A + 1; const X = B * 3; to { kind: number, value: 9 }", () => {
        expect(
          resolveConstFromSourceWithChecker(
            "const A = 2;\nconst B = A + 1;\nconst X = B * 3;",
            "X",
          ),
        ).toStrictEqual({
          kind: "number",
          value: 9,
        });
      });
    });

    describe("repeated identifier references", () => {
      it("resolves the same const when it appears in sibling branches", () => {
        expect(
          resolveConstFromSourceWithChecker("const A = 1;\nconst X = A + A;", "X"),
        ).toStrictEqual({
          kind: "number",
          value: 2,
        });
      });
    });

    describe("non-finite results return undefined", () => {
      it("returns undefined for const X = 1 / 0;", () => {
        expect(resolveConstFromSourceWithChecker("const X = 1 / 0;", "X")).toBeUndefined();
      });
    });

    describe("non-evaluable expression returns undefined", () => {
      it("returns undefined for const X = Math.random();", () => {
        expect(resolveConstFromSourceWithChecker("const X = Math.random();", "X")).toBeUndefined();
      });
    });

    describe("backward compat: without checker returns undefined for binary", () => {
      it("returns undefined for const X = 2 ** 8; when called without checker", () => {
        expect(resolveConstFromSource("const X = 2 ** 8;", "X")).toBeUndefined();
      });
    });

    describe("transparent wrappers in identifier chains", () => {
      it("resolves const X = 2; const Y = (X); to { kind: number, value: 2 }", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = 2;\nconst Y = (X);", "Y"),
        ).toStrictEqual({
          kind: "number",
          value: 2,
        });
      });

      it("resolves const X = 2; const Y = (X) + 3; to { kind: number, value: 5 }", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = 2;\nconst Y = (X) + 3;", "Y"),
        ).toStrictEqual({
          kind: "number",
          value: 5,
        });
      });

      it("resolves const X = 2; const Y = X satisfies number; to { kind: number, value: 2 }", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = 2;\nconst Y = X satisfies number;", "Y"),
        ).toStrictEqual({
          kind: "number",
          value: 2,
        });
      });

      it("resolves const X = 2; const Y = X!; to { kind: number, value: 2 }", () => {
        expect(resolveConstFromSourceWithChecker("const X = 2;\nconst Y = X!;", "Y")).toStrictEqual(
          {
            kind: "number",
            value: 2,
          },
        );
      });
    });

    describe("as-expressions and type assertions with identifiers", () => {
      it("resolves const X = 2; const Y = X as const; to { kind: number, value: 2 }", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = 2;\nconst Y = X as const;", "Y"),
        ).toStrictEqual({
          kind: "number",
          value: 2,
        });
      });

      it("resolves const X = 2; const Y = <const>X; to { kind: number, value: 2 }", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = 2;\nconst Y = <const>X;", "Y"),
        ).toStrictEqual({
          kind: "number",
          value: 2,
        });
      });
    });

    describe("mixed type binary expressions", () => {
      it("returns undefined for const X = 2 + 'hello'; when operands are incompatible", () => {
        expect(resolveConstFromSourceWithChecker("const X = 2 + 'hello';", "X")).toBeUndefined();
      });

      it("returns undefined for const X = 'hello' + 2; when operands are incompatible", () => {
        expect(resolveConstFromSourceWithChecker("const X = 'hello' + 2;", "X")).toBeUndefined();
      });
    });

    describe("circular const references", () => {
      it("returns undefined for circular const reference", () => {
        expect(
          resolveConstFromSourceWithChecker("const X: any = Y;\nconst Y: any = X;", "X"),
        ).toBeUndefined();
      });
    });

    describe("non-evaluable identifier references", () => {
      it("returns undefined when identifier has no const initializer", () => {
        expect(resolveConstFromSourceWithChecker("let X = 42;\nconst Y = X;", "Y")).toBeUndefined();
      });
    });

    describe("unsupported binary operators", () => {
      it("returns undefined for const X = true && false; (non-numeric operands)", () => {
        expect(resolveConstFromSourceWithChecker("const X = true && false;", "X")).toBeUndefined();
      });

      it("returns undefined for const X = 2 < 3; (numeric comparison not evaluable)", () => {
        expect(resolveConstFromSourceWithChecker("const X = 2 < 3;", "X")).toBeUndefined();
      });
    });

    describe("string operations with non-plus operators", () => {
      it('returns undefined for const X = "hello" - " world"; (non-plus string operator)', () => {
        expect(
          resolveConstFromSourceWithChecker('const X = "hello" - " world";', "X"),
        ).toBeUndefined();
      });
    });

    describe("evaluates template literals", () => {
      it.each<{ source: string; variable: string; withChecker: boolean; expected: LiteralKind }>([
        {
          source: "const X = `max " + "$" + "{16777216 - 1}`;",
          variable: "X",
          withChecker: true,
          expected: { kind: "string", value: "max 16777215" },
        },
        {
          source: "const X = `flag: " + "$" + "{true}`;",
          variable: "X",
          withChecker: false,
          expected: { kind: "string", value: "flag: true" },
        },
        {
          source: "const X = `hello " + "$" + '{"world"}`;',
          variable: "X",
          withChecker: false,
          expected: { kind: "string", value: "hello world" },
        },
        {
          source: "const N = 42;\nconst X = `count: " + "$" + "{N}`;",
          variable: "X",
          withChecker: true,
          expected: { kind: "string", value: "count: 42" },
        },
        {
          source: "const X = `" + "$" + "{1} + " + "$" + "{2} = " + "$" + "{3}`;",
          variable: "X",
          withChecker: true,
          expected: { kind: "string", value: "1 + 2 = 3" },
        },
        {
          source: "const A = 5;\nconst B = 10;\nconst X = `sum: " + "$" + "{A + B}`;",
          variable: "X",
          withChecker: true,
          expected: { kind: "string", value: "sum: 15" },
        },
        {
          source: "const X = `" + "$" + "{99999999999999}`;",
          variable: "X",
          withChecker: true,
          expected: { kind: "string", value: "99999999999999" },
        },
      ])("$variable → $expected.value", ({ source, variable, withChecker, expected }) => {
        expect(
          withChecker
            ? resolveConstFromSourceWithChecker(source, variable)
            : resolveConstFromSource(source, variable),
        ).toStrictEqual(expected);
      });

      it("returns undefined when a span expression is unresolvable", () => {
        expect(
          resolveConstFromSourceWithChecker(
            "const X = `value: " + "$" + "{someExternalRef}`;",
            "X",
          ),
        ).toBeUndefined();
      });

      it("returns undefined when a numeric span may not match Lua tostring formatting", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = `" + "$" + "{1e20}`;", "X"),
        ).toBeUndefined();
      });

      it("returns undefined when a numeric span is at or above 1e14 threshold (unsafe for Lua tostring)", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = `" + "$" + "{100000000000000}`;", "X"),
        ).toBeUndefined();
      });

      it("returns undefined when a numeric span is a negative number at or below -1e14 threshold", () => {
        expect(
          resolveConstFromSourceWithChecker("const X = `" + "$" + "{-100000000000000}`;", "X"),
        ).toBeUndefined();
      });
    });
  });
});
