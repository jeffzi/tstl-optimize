import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EXTENDED_TRANSPARENT_KINDS,
  hasSideEffects,
  isNilExpression,
  SideEffectOptions,
  STATIC_TRANSPARENT_KINDS,
  unwrapTransparent,
} from "../../src/ast/ts-ast";

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

      const syntheticsProperty = ts.factory.createPropertyDeclaration(
        undefined,
        ts.factory.createIdentifier("field"),
        undefined,
        undefined,
        undefined,
      );
      Reflect.set(expr, "properties", [syntheticsProperty]);

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
    type SupportedBitmask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

    expectTypeOf<SideEffectOptions>().toEqualTypeOf<SupportedBitmask>();
    expect(
      SideEffectOptions.AssumeTaggedTemplatePure | SideEffectOptions.AssumeConstructorPure,
    ).toBe(3);

    // @ts-expect-error unsupported flags are outside the declared bitmask
    const invalid: SideEffectOptions = 16;
    expect(invalid).toBe(16);
  });
});

describe("STATIC_TRANSPARENT_KINDS and EXTENDED_TRANSPARENT_KINDS", () => {
  it("STATIC_TRANSPARENT_KINDS contains exactly 5 kinds", () => {
    expect(STATIC_TRANSPARENT_KINDS.size).toBe(5);
    expect(STATIC_TRANSPARENT_KINDS.has(ts.SyntaxKind.ParenthesizedExpression)).toBe(true);
    expect(STATIC_TRANSPARENT_KINDS.has(ts.SyntaxKind.AsExpression)).toBe(true);
    expect(STATIC_TRANSPARENT_KINDS.has(ts.SyntaxKind.TypeAssertionExpression)).toBe(true);
    expect(STATIC_TRANSPARENT_KINDS.has(ts.SyntaxKind.NonNullExpression)).toBe(true);
    expect(STATIC_TRANSPARENT_KINDS.has(ts.SyntaxKind.SatisfiesExpression)).toBe(true);
  });

  it("EXTENDED_TRANSPARENT_KINDS includes STATIC_TRANSPARENT_KINDS plus 3 additional kinds", () => {
    expect(EXTENDED_TRANSPARENT_KINDS.size).toBe(8);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.ParenthesizedExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.AsExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.TypeAssertionExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.NonNullExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.SatisfiesExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.VoidExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.TypeOfExpression)).toBe(true);
    expect(EXTENDED_TRANSPARENT_KINDS.has(ts.SyntaxKind.SpreadElement)).toBe(true);
  });

  it("EXTENDED_TRANSPARENT_KINDS is frozen", () => {
    expect(Object.isFrozen(EXTENDED_TRANSPARENT_KINDS)).toBe(true);
  });

  it("STATIC_TRANSPARENT_KINDS is frozen", () => {
    expect(Object.isFrozen(STATIC_TRANSPARENT_KINDS)).toBe(true);
  });
});

describe("unwrapTransparent", () => {
  it("peels static transparent wrappers by default", () => {
    const expr = parseExpr("(x)"); // ParenthesizedExpression
    const unwrapped = unwrapTransparent(expr);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("peels multiple layers of static transparent wrappers", () => {
    const expr = parseExpr("((x as number)!)"); // nested: parens, as, non-null
    const unwrapped = unwrapTransparent(expr);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("peels extended transparent wrappers when EXTENDED_TRANSPARENT_KINDS is passed", () => {
    const expr = parseExpr("void 0"); // VoidExpression
    const unwrapped = unwrapTransparent(expr, EXTENDED_TRANSPARENT_KINDS);
    expect(ts.isNumericLiteral(unwrapped)).toBe(true);
  });

  it("peels typeof when EXTENDED_TRANSPARENT_KINDS is passed", () => {
    const expr = parseExpr("typeof x"); // TypeOfExpression
    const unwrapped = unwrapTransparent(expr, EXTENDED_TRANSPARENT_KINDS);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });

  it("returns expression unchanged when not a wrapper", () => {
    const expr = parseExpr("42");
    const unwrapped = unwrapTransparent(expr);
    expect(unwrapped).toBe(expr);
  });

  it("stops unwrapping at non-transparent kinds", () => {
    const unwrapped = unwrapTransparent(parseExpr("(foo())")); // CallExpression in parens
    expect(ts.isCallExpression(unwrapped)).toBe(true);
  });

  it("peels void when using extended set", () => {
    const expr = parseExpr("(void foo())");
    const unwrapped = unwrapTransparent(expr, EXTENDED_TRANSPARENT_KINDS);
    expect(ts.isCallExpression(unwrapped)).toBe(true);
  });

  it("stops at void when using static set", () => {
    const expr = parseExpr("(void foo())");
    const unwrapped = unwrapTransparent(expr);
    expect(ts.isVoidExpression(unwrapped)).toBe(true);
  });

  it("peels spread element when using extended set", () => {
    // SpreadElement is the element inside [...items]
    const arr = parseExpr("[...items]") as ts.ArrayLiteralExpression;
    const spreadElem = arr.elements[0];
    if (!ts.isSpreadElement(spreadElem)) {
      throw new Error("Expected SpreadElement");
    }
    const unwrapped = unwrapTransparent(spreadElem, EXTENDED_TRANSPARENT_KINDS);
    expect(ts.isIdentifier(unwrapped)).toBe(true);
  });
});

describe("isNilExpression", () => {
  it("returns true for null literal", () => {
    expect(isNilExpression(parseExpr("null"))).toBe(true);
  });

  it("returns true for undefined identifier", () => {
    expect(isNilExpression(parseExpr("undefined"))).toBe(true);
  });

  it("returns true for void expression", () => {
    expect(isNilExpression(parseExpr("void 0"))).toBe(true);
  });

  it("returns true for wrapped null (null as null)", () => {
    expect(isNilExpression(parseExpr("null as null"))).toBe(true);
  });

  it("returns true for wrapped undefined ((undefined))", () => {
    expect(isNilExpression(parseExpr("(undefined)"))).toBe(true);
  });

  it("returns true for wrapped void expression", () => {
    expect(isNilExpression(parseExpr("(void 0)"))).toBe(true);
  });

  it("returns false for number literal", () => {
    expect(isNilExpression(parseExpr("42"))).toBe(false);
  });

  it("returns false for string literal", () => {
    expect(isNilExpression(parseExpr('"hello"'))).toBe(false);
  });

  it("returns false for identifier that is not undefined", () => {
    expect(isNilExpression(parseExpr("x"))).toBe(false);
  });

  it("returns false for function call", () => {
    expect(isNilExpression(parseExpr("foo()"))).toBe(false);
  });
});

describe("hasSideEffects relaxations with AssumePropertyAccessPure", () => {
  describe("when AssumePropertyAccessPure is NOT set", () => {
    it("returns true for simple property access", () => {
      expect(hasSideEffects(parseExpr("obj.x"))).toBe(true);
    });

    it("returns true for simple array element access", () => {
      expect(hasSideEffects(parseExpr("arr[0]"))).toBe(true);
    });

    it("returns true for array access with pure index and pure object", () => {
      expect(hasSideEffects(parseExpr("arr[0]"), SideEffectOptions.None)).toBe(true);
    });
  });

  describe("when AssumePropertyAccessPure is set", () => {
    it("returns false for property access on pure identifier", () => {
      expect(hasSideEffects(parseExpr("obj.x"), SideEffectOptions.AssumePropertyAccessPure)).toBe(
        false,
      );
    });

    it("returns true for property access on impure object", () => {
      expect(hasSideEffects(parseExpr("foo().x"), SideEffectOptions.AssumePropertyAccessPure)).toBe(
        true,
      );
    });

    it("returns false for array access with pure object and pure index", () => {
      expect(hasSideEffects(parseExpr("arr[0]"), SideEffectOptions.AssumePropertyAccessPure)).toBe(
        false,
      );
    });

    it("returns true for array access with impure index", () => {
      expect(
        hasSideEffects(parseExpr("arr[foo()]"), SideEffectOptions.AssumePropertyAccessPure),
      ).toBe(true);
    });

    it("returns true for array access with impure object", () => {
      expect(
        hasSideEffects(parseExpr("foo()[0]"), SideEffectOptions.AssumePropertyAccessPure),
      ).toBe(true);
    });

    it("returns true for array access with both impure", () => {
      expect(
        hasSideEffects(parseExpr("foo()[bar()]"), SideEffectOptions.AssumePropertyAccessPure),
      ).toBe(true);
    });
  });
});

describe("hasSideEffects spread relaxations", () => {
  it.each([
    { name: "array spread with pure identifier", expr: "[...items]" },
    { name: "object spread with pure identifier", expr: "({ ...obj })" },
  ])("returns false for $name (inner expression is pure)", ({ expr }) => {
    expect(hasSideEffects(parseExpr(expr))).toBe(false);
  });

  it.each([
    { name: "array spread with call", expr: "[...items(foo())]" },
    { name: "object spread with call", expr: "({ ...foo() })" },
  ])("returns true for $name (inner expression has side effects)", ({ expr }) => {
    expect(hasSideEffects(parseExpr(expr))).toBe(true);
  });
});
