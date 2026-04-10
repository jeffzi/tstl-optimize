import ts from "typescript";
import { describe, expect, it } from "vitest";
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

describe("hasSideEffects", () => {
  describe("when expression is pure", () => {
    it.each([
      { expr: "42" },
      { expr: '"hello"' },
      { expr: "x" },
    ])("returns false for leaf expression $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    // PropertyAccessExpression is a transparent wrapper — same code path as void/typeof/as/!/satisfies/(...)
    it.each([
      { expr: "void 0" },
      { expr: "typeof x" },
      { expr: "(a + b)" },
      { expr: "x as number" },
      { expr: "x!" },
      { expr: "x satisfies number" },
      { expr: "obj.x" },
    ])("returns false for transparent wrapper $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it.each([
      { expr: "-x" },
      { expr: "+x" },
      { expr: "~x" },
      { expr: "!x" },
    ])("returns false for prefix unary non-increment $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it("returns false for pure binary expression", () => {
      expect(hasSideEffects(parseExpr("a + b"))).toBe(false);
    });

    it("returns false for conditional with pure branches", () => {
      expect(hasSideEffects(parseExpr("x ? a : b"))).toBe(false);
    });

    it("returns false for element access with pure index", () => {
      expect(hasSideEffects(parseExpr("arr[0]"))).toBe(false);
    });

    it("returns false for array literal with pure elements", () => {
      expect(hasSideEffects(parseExpr("[1, 2, 3]"))).toBe(false);
    });

    it("returns false for object literal with pure properties", () => {
      expect(hasSideEffects(parseExpr("({ a: 1, b: 2 })"))).toBe(false);
    });

    it("returns false for object literal with pure computed key", () => {
      expect(hasSideEffects(parseExpr('({ ["literal"]: 1 })'))).toBe(false);
    });

    it("returns false for object literal with shorthand property", () => {
      expect(hasSideEffects(parseExpr("({ x })"))).toBe(false);
    });

    it("returns false for object literal with method declaration", () => {
      expect(hasSideEffects(parseExpr("({ foo() {} })"))).toBe(false);
    });

    it.each([
      { expr: "({ get x() { return 1; } })" },
      { expr: "({ set x(v) {} })" },
    ])("returns false for object literal with accessor $expr", ({ expr }) => {
      expect(hasSideEffects(parseExpr(expr))).toBe(false);
    });

    it("returns false for template expression with pure substitutions", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
      expect(hasSideEffects(parseExpr("`hello ${x}`"))).toBe(false);
    });
  });

  describe("when expression has side effects", () => {
    it("returns true for call expression", () => {
      expect(hasSideEffects(parseExpr("foo()"))).toBe(true);
    });

    it("returns true for new expression", () => {
      expect(hasSideEffects(parseExpr("new Foo()"))).toBe(true);
    });

    it("returns true for tagged template", () => {
      expect(hasSideEffects(parseExpr("tag`hello`"))).toBe(true);
    });

    it("returns true for postfix increment", () => {
      expect(hasSideEffects(parseExpr("x++"))).toBe(true);
    });

    it("returns true for prefix decrement", () => {
      expect(hasSideEffects(parseExpr("--x"))).toBe(true);
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

    it("returns true for delete expression", () => {
      expect(hasSideEffects(parseExpr("delete obj.x"))).toBe(true);
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

    it("detects call inside array literal", () => {
      expect(hasSideEffects(parseExpr("[foo()]"))).toBe(true);
    });

    it("detects call inside object literal property", () => {
      expect(hasSideEffects(parseExpr("({ a: foo() })"))).toBe(true);
    });

    it("detects call inside template expression substitution", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
      expect(hasSideEffects(parseExpr("`${foo()}`"))).toBe(true);
    });

    it("detects call inside spread assignment in object literal", () => {
      expect(hasSideEffects(parseExpr("({ ...foo() })"))).toBe(true);
    });
  });

  describe("when SideEffectOptions flags are used", () => {
    describe("when AssumeConstructorPure is set", () => {
      it("treats new as side-effectful by default", () => {
        expect(hasSideEffects(parseExpr("new Foo()"))).toBe(true);
      });

      it("treats new as pure when AssumeConstructorPure is set", () => {
        expect(
          hasSideEffects(parseExpr("new Foo()"), SideEffectOptions.AssumeConstructorPure),
        ).toBe(false);
      });

      it("still detects side effects in arguments when AssumeConstructorPure is set", () => {
        expect(
          hasSideEffects(parseExpr("new Foo(bar())"), SideEffectOptions.AssumeConstructorPure),
        ).toBe(true);
      });
    });

    describe("when AssumeTaggedTemplatePure is set", () => {
      it("treats tagged template as side-effectful by default", () => {
        expect(hasSideEffects(parseExpr("tag`hello`"))).toBe(true);
      });

      it("treats tagged template as pure when AssumeTaggedTemplatePure is set", () => {
        expect(
          hasSideEffects(parseExpr("tag`hello`"), SideEffectOptions.AssumeTaggedTemplatePure),
        ).toBe(false);
      });

      it("still detects side effects in substitutions when AssumeTaggedTemplatePure is set", () => {
        expect(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
          hasSideEffects(parseExpr("tag`${foo()}`"), SideEffectOptions.AssumeTaggedTemplatePure),
        ).toBe(true);
      });
    });
  });

  describe("when both AssumeTaggedTemplatePure and AssumeConstructorPure are combined", () => {
    it("treats both tagged templates and new expressions as pure", () => {
      const combined: SideEffectOptions =
        SideEffectOptions.AssumeTaggedTemplatePure | SideEffectOptions.AssumeConstructorPure;

      expect(hasSideEffects(parseExpr("tag`hello`"), combined)).toBe(false);
    });
  });

  describe("when ConsiderIdentityMutating is set", () => {
    it("function expression has no side effects without ConsiderIdentityMutating", () => {
      // Direct node creation for function expression
      const fnExpr = ts.factory.createFunctionExpression(
        undefined,
        undefined,
        "myFunc",
        undefined,
        [],
        undefined,
        ts.factory.createBlock([]),
      );
      expect(hasSideEffects(fnExpr, SideEffectOptions.None)).toBe(false);
    });

    it("function expression has side effects with ConsiderIdentityMutating", () => {
      const fnExpr = ts.factory.createFunctionExpression(
        undefined,
        undefined,
        "myFunc",
        undefined,
        [],
        undefined,
        ts.factory.createBlock([]),
      );
      expect(hasSideEffects(fnExpr, SideEffectOptions.ConsiderIdentityMutating)).toBe(true);
    });

    it("arrow function has no side effects without ConsiderIdentityMutating", () => {
      const arrowFn = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock([]),
      );
      expect(hasSideEffects(arrowFn, SideEffectOptions.None)).toBe(false);
    });

    it("arrow function has side effects with ConsiderIdentityMutating", () => {
      const arrowFn = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock([]),
      );
      expect(hasSideEffects(arrowFn, SideEffectOptions.ConsiderIdentityMutating)).toBe(true);
    });
  });
});
