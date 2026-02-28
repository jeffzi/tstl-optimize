import ts from "typescript";
import { describe, expect, it } from "vitest";
import { hasSideEffects, SideEffectOptions } from "../../src/lua-ast/ts-ast";

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
  describe("pure expressions", () => {
    it("returns false for leaf expressions", () => {
      expect(hasSideEffects(parseExpr("42"))).toBe(false);
      expect(hasSideEffects(parseExpr('"hello"'))).toBe(false);
      expect(hasSideEffects(parseExpr("x"))).toBe(false);
    });

    it("returns false for void with pure operand", () => {
      expect(hasSideEffects(parseExpr("void 0"))).toBe(false);
    });

    it("returns false for typeof with pure operand", () => {
      expect(hasSideEffects(parseExpr("typeof x"))).toBe(false);
    });

    it("returns false for prefix unary non-increment with pure operand", () => {
      expect(hasSideEffects(parseExpr("-x"))).toBe(false);
      expect(hasSideEffects(parseExpr("+x"))).toBe(false);
      expect(hasSideEffects(parseExpr("~x"))).toBe(false);
      expect(hasSideEffects(parseExpr("!x"))).toBe(false);
    });

    it("returns false for property access on identifier", () => {
      expect(hasSideEffects(parseExpr("obj.x"))).toBe(false);
    });

    it("returns false for pure binary expression", () => {
      expect(hasSideEffects(parseExpr("a + b"))).toBe(false);
    });

    it("returns false for parenthesized pure expression", () => {
      expect(hasSideEffects(parseExpr("(a + b)"))).toBe(false);
    });

    it("returns false for conditional with pure branches", () => {
      expect(hasSideEffects(parseExpr("x ? a : b"))).toBe(false);
    });

    it("returns false for as expression wrapping pure expr", () => {
      expect(hasSideEffects(parseExpr("x as number"))).toBe(false);
    });

    it("returns false for non-null assertion on pure expr", () => {
      expect(hasSideEffects(parseExpr("x!"))).toBe(false);
    });

    it("returns false for satisfies expression wrapping pure expr", () => {
      expect(hasSideEffects(parseExpr("x satisfies number"))).toBe(false);
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

    it("returns false for object literal with getter/setter", () => {
      expect(hasSideEffects(parseExpr("({ get x() { return 1; } })"))).toBe(false);
      expect(hasSideEffects(parseExpr("({ set x(v) {} })"))).toBe(false);
    });

    it("returns false for template expression with pure substitutions", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template parsing
      expect(hasSideEffects(parseExpr("`hello ${x}`"))).toBe(false);
    });
  });

  describe("side-effectful expressions", () => {
    it("returns true for call or new expression", () => {
      expect(hasSideEffects(parseExpr("foo()"))).toBe(true);
      expect(hasSideEffects(parseExpr("new Foo()"))).toBe(true);
    });

    it("returns true for tagged template", () => {
      expect(hasSideEffects(parseExpr("tag`hello`"))).toBe(true);
    });

    it("returns true for increment or decrement", () => {
      expect(hasSideEffects(parseExpr("x++"))).toBe(true);
      expect(hasSideEffects(parseExpr("--x"))).toBe(true);
    });

    it("returns true for assignment operators", () => {
      expect(hasSideEffects(parseExpr("x = 1"))).toBe(true);
      expect(hasSideEffects(parseExpr("x += 1"))).toBe(true);
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
      const fn = src.statements[0] as ts.FunctionDeclaration;
      const stmt = fn.body?.statements[0] as ts.ExpressionStatement;
      expect(hasSideEffects(stmt.expression)).toBe(true);
    });

    it("returns true for delete expression", () => {
      expect(hasSideEffects(parseExpr("delete obj.x"))).toBe(true);
    });

    it("returns true for void wrapping call", () => {
      expect(hasSideEffects(parseExpr("void foo()"))).toBe(true);
    });

    it("returns true for typeof wrapping call", () => {
      expect(hasSideEffects(parseExpr("typeof foo()"))).toBe(true);
    });

    it("returns true for prefix unary non-increment wrapping call", () => {
      expect(hasSideEffects(parseExpr("+foo()"))).toBe(true);
    });

    it("returns true for object literal with side-effectful computed key", () => {
      expect(hasSideEffects(parseExpr("({ [foo()]: 1 })"))).toBe(true);
    });

    it("returns true for method with side-effectful computed key", () => {
      expect(hasSideEffects(parseExpr("({ [foo()]() {} })"))).toBe(true);
    });
  });

  describe("recursive detection", () => {
    it("detects call inside property access", () => {
      expect(hasSideEffects(parseExpr("foo().bar"))).toBe(true);
    });

    it("detects call inside element access expression or index", () => {
      expect(hasSideEffects(parseExpr("foo()[0]"))).toBe(true);
      expect(hasSideEffects(parseExpr("arr[foo()]"))).toBe(true);
    });

    it("detects call inside parenthesized expression", () => {
      expect(hasSideEffects(parseExpr("(foo())"))).toBe(true);
    });

    it("detects call in any branch of conditional expression", () => {
      expect(hasSideEffects(parseExpr("foo() ? a : b"))).toBe(true);
      expect(hasSideEffects(parseExpr("x ? foo() : b"))).toBe(true);
      expect(hasSideEffects(parseExpr("x ? a : foo()"))).toBe(true);
    });

    it("detects call inside as expression", () => {
      expect(hasSideEffects(parseExpr("foo() as number"))).toBe(true);
    });

    it("detects call inside non-null assertion", () => {
      expect(hasSideEffects(parseExpr("foo()!"))).toBe(true);
    });

    it("detects call inside satisfies expression", () => {
      expect(hasSideEffects(parseExpr("foo() satisfies number"))).toBe(true);
    });

    it("detects call in either operand of binary expression", () => {
      expect(hasSideEffects(parseExpr("a + foo()"))).toBe(true);
      expect(hasSideEffects(parseExpr("foo() + b"))).toBe(true);
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

  describe("SideEffectOptions", () => {
    describe("AssumeConstructorPure", () => {
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

    describe("AssumeTaggedTemplatePure", () => {
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
});
