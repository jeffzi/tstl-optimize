import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { hasSideEffects, SideEffectOptions } from "../../src/ast/ts-ast";

/** Parse a TS expression string into an AST node. */
function parseExpr(code: string): ts.Expression {
  const src = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
  const stmt = src.statements[0];
  if (!ts.isExpressionStatement(stmt)) {
    throw new Error(`Expected ExpressionStatement, got ${ts.SyntaxKind[stmt.kind]}`);
  }
  return stmt.expression;
}

function createEmptyFunctionExpression(): ts.FunctionExpression {
  return ts.factory.createFunctionExpression(
    undefined,
    undefined,
    "myFunc",
    undefined,
    [],
    undefined,
    ts.factory.createBlock([]),
  );
}

function createEmptyArrowFunction(): ts.ArrowFunction {
  return ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createBlock([]),
  );
}

describe("hasSideEffects", () => {
  describe("when expression is pure", () => {
    it.each([
      { expr: "42" },
      { expr: '"hello"' },
      { expr: "x" },
    ])("returns false for leaf expression $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    // Wrappers that cannot trigger getters stay transparent.
    it.each([
      { expr: "void 0" },
      { expr: "typeof x" },
      { expr: "(a + b)" },
      { expr: "(<number>x)" },
      { expr: "x as number" },
      { expr: "x!" },
      { expr: "x satisfies number" },
    ])("returns false for transparent wrapper $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it("treats property access as side-effectful to avoid duplicating getters", () => {
      expect(hasSideEffects(parseExpr("obj.x"))).toBe(true);
    });

    it.each([
      { expr: "-x" },
      { expr: "+x" },
      { expr: "~x" },
      { expr: "!x" },
    ])("returns false for prefix unary non-increment $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it.each([
      { name: "pure binary expression", expr: "a + b" },
      { name: "conditional with pure branches", expr: "x ? a : b" },
      { name: "array literal with pure elements", expr: "[1, 2, 3]" },
      { name: "array literal with pure spread element", expr: "[...items]" },
      { name: "object literal with pure properties", expr: "({ a: 1, b: 2 })" },
      { name: "object literal with pure computed key", expr: '({ ["literal"]: 1 })' },
      { name: "object literal with shorthand property", expr: "({ x })" },
      { name: "object literal with method declaration", expr: "({ foo() {} })" },
    ])("returns false for $name", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it.each([
      { expr: "({ get x() { return 1; } })" },
      { expr: "({ set x(v) {} })" },
    ])("returns false for object literal with accessor $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it.each([
      {
        name: "template expression with pure substitutions",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
        expr: "`hello ${x}`",
      },
    ])("returns false for $name", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });
  });

  describe("when expression has side effects", () => {
    it.each([
      { name: "call expression", expr: "foo()" },
      { name: "new expression", expr: "new Foo()" },
      { name: "tagged template", expr: "tag`hello`" },
      { name: "postfix increment", expr: "x++" },
      { name: "prefix decrement", expr: "--x" },
      { name: "delete expression", expr: "delete obj.x" },
      { name: "element access", expr: "arr[0]" },
    ])("returns true for $name", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it.each([
      { expr: "x = 1" },
      { expr: "x += 1" },
    ])("returns true for assignment operator $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it("returns true for await expression", () => {
      expect(hasSideEffects(parseExpr("await p"))).toBe(true);
    });

    it("returns true for yield expression", () => {
      const src = ts.createSourceFile(
        "test.ts",
        "function* g() { yield 1; }",
        ts.ScriptTarget.Latest,
        true,
      );
      const fn = src.statements.find(ts.isFunctionDeclaration);
      const stmt = fn?.body?.statements.find(ts.isExpressionStatement);
      expect(stmt).toBeDefined();
      if (!stmt) throw new Error("Expected statement");
      expect(hasSideEffects(stmt.expression)).toBe(true);
    });

    it.each([
      { expr: "void foo()" },
      { expr: "typeof foo()" },
      { expr: "+foo()" },
    ])("returns true for unary wrapper around call $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it("returns true for object literal with side-effectful computed key", () => {
      expect(hasSideEffects(parseExpr("({ [foo()]: 1 })"))).toBe(true);
    });

    it("returns true for method with side-effectful computed key", () => {
      expect(hasSideEffects(parseExpr("({ [foo()]() {} })"))).toBe(true);
    });

    it("returns true for unsupported synthetic object literal members", () => {
      const parsed = parseExpr("({ a: 1 })");
      const expr = ts.isParenthesizedExpression(parsed) ? parsed.expression : parsed;
      if (!ts.isObjectLiteralExpression(expr)) {
        throw new Error("Expected ObjectLiteralExpression");
      }

      Reflect.set(expr, "properties", [
        ts.factory.createPropertyDeclaration(
          undefined,
          ts.factory.createIdentifier("field"),
          undefined,
          undefined,
          undefined,
        ),
      ]);

      expect(hasSideEffects(expr)).toBe(true);
    });

    // Class expressions are always side-effectful (decorators, static initializers, computed keys)
    it("returns true for class expression", () => {
      expect(hasSideEffects(parseExpr("(class {})"))).toBe(true);
    });

    it("returns true for class expression with static field initializer", () => {
      expect(hasSideEffects(parseExpr("(class { static x = foo(); })"))).toBe(true);
    });
  });

  describe("when detecting effects in nested expressions", () => {
    it("detects call inside property access", () => {
      expect(hasSideEffects(parseExpr("foo().bar"))).toBe(true);
    });

    it.each([
      { part: "expression", expr: "foo()[0]" },
      { part: "index", expr: "arr[foo()]" },
    ])("detects call in element access $part", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it.each([
      { expr: "(foo())" },
      { expr: "foo() as number" },
      { expr: "foo()!" },
      { expr: "foo() satisfies number" },
    ])("detects call through transparent wrapper $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it.each([
      { expr: "foo() ? a : b" },
      { expr: "x ? foo() : b" },
      { expr: "x ? a : foo()" },
    ])("detects call in conditional branch $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it.each([
      { expr: "a + foo()" },
      { expr: "foo() + b" },
    ])("detects call in binary operand $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });

    it.each([
      { name: "array literal", expr: "[foo()]" },
      { name: "object literal property", expr: "({ a: foo() })" },
      {
        name: "template expression substitution",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
        expr: "`${foo()}`",
      },
      { name: "spread element", expr: "[...items(foo())]" },
      { name: "spread assignment in object literal", expr: "({ ...foo() })" },
    ])("detects call inside $name", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(true);
    });
  });

  describe("when SideEffectOptions flags are used", () => {
    describe("when AssumeConstructorPure is set", () => {
      it.each([
        {
          name: "side-effectful by default",
          expr: "new Foo()",
          options: SideEffectOptions.None,
          expected: true,
        },
        {
          name: "pure when AssumeConstructorPure is set",
          expr: "new Foo()",
          options: SideEffectOptions.AssumeConstructorPure,
          expected: false,
        },
        {
          name: "still side-effectful when arguments have side effects",
          expr: "new Foo(bar())",
          options: SideEffectOptions.AssumeConstructorPure,
          expected: true,
        },
      ])("treats new as $name", ({ expr, options, expected }) => {
        expect(hasSideEffects(parseExpr(expr), options)).toBe(expected);
      });
    });

    describe("when AssumeTaggedTemplatePure is set", () => {
      it.each([
        {
          name: "side-effectful by default",
          expr: "tag`hello`",
          options: SideEffectOptions.None,
          expected: true,
        },
        {
          name: "pure when AssumeTaggedTemplatePure is set",
          expr: "tag`hello`",
          options: SideEffectOptions.AssumeTaggedTemplatePure,
          expected: false,
        },
        {
          name: "still side-effectful when substitutions have side effects",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
          expr: "tag`${foo()}`",
          options: SideEffectOptions.AssumeTaggedTemplatePure,
          expected: true,
        },
      ])("treats tagged template as $name", ({ expr, options, expected }) => {
        expect(hasSideEffects(parseExpr(expr), options)).toBe(expected);
      });
    });
  });

  describe("when both AssumeTaggedTemplatePure and AssumeConstructorPure are combined", () => {
    it.each([
      { name: "tagged template", expr: "tag`hello`" },
      { name: "new expression", expr: "new Foo()" },
    ])("treats $name as pure", ({ expr }) => {
      const combined = (SideEffectOptions.AssumeTaggedTemplatePure |
        SideEffectOptions.AssumeConstructorPure) as SideEffectOptions;

      expect(hasSideEffects(parseExpr(expr), combined)).toBe(false);
    });
  });

  describe("when ConsiderIdentityMutating is set", () => {
    it.each([
      {
        name: "function expression",
        createExpr: createEmptyFunctionExpression,
      },
      {
        name: "arrow function",
        createExpr: createEmptyArrowFunction,
      },
    ])("$name follows ConsiderIdentityMutating", ({ createExpr }) => {
      const expr = createExpr();

      expect(hasSideEffects(expr, SideEffectOptions.None)).toBe(false);
      expect(hasSideEffects(expr, SideEffectOptions.ConsiderIdentityMutating)).toBe(true);
    });
  });
});

describe("SideEffectOptions typing", () => {
  it("matches the supported bitmask combinations", () => {
    type SupportedBitmask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

    expectTypeOf<SideEffectOptions>().toEqualTypeOf<SupportedBitmask>();
    expect(
      SideEffectOptions.AssumeTaggedTemplatePure | SideEffectOptions.AssumeConstructorPure,
    ).toBe(3);

    // @ts-expect-error unsupported flags are outside the declared bitmask
    const invalid: SideEffectOptions = 8;
    expect(invalid).toBe(8);
  });
});
