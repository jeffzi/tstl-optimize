import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import { createVisitors } from "../../src/rules/constant-folding";
import { compile, normalizeLua } from "../helpers";

describe("constant-folding", () => {
  it("folds binary arithmetic expressions", () => {
    const lua = compile("const a = 1 + 2 * 3;");
    expect(lua).toContain("a = 7");
  });

  it("folds string concatenation", () => {
    const lua = compile("const a = 'foo' + 'bar';");
    expect(lua).toContain('a = "foobar"');
  });

  it("folds boolean logic", () => {
    const lua = compile("const a = true && false; const b = !true;");
    expect(lua).toContain("a = false");
    expect(lua).toContain("b = false");
  });

  it("leaves side-effects untouched", () => {
    const lua = compile("let x = 1; const a = (x = 2) + 3;");
    expect(lua).toContain("x = 2");
    expect(lua).toContain("+ 3");
  });

  it("removes empty if blocks", () => {
    const lua = compile("if (true) {} else if (false) {} else {} const a = 1;");
    expect(lua).not.toContain("if");
    expect(lua).toContain("a = 1");
  });

  it("removes statements after return", () => {
    const lua = compile("function foo() { return 1; const a = 2; }");
    expect(lua).toContain("return 1");
    expect(lua).not.toContain("local a = 2");
  });

  it.each([
    // Lua: (-7) % 3 == 2   (floored toward -inf)
    // JS:  (-7) % 3 == -1  (truncated toward zero)
    { source: "const x = (-7) % 3;", expected: "x = 2", label: "negative dividend" },
    // Lua: 7 % (-3) == -2
    // JS:  7 % (-3) == 1
    { source: "const x = 7 % (-3);", expected: "x = -2", label: "negative divisor" },
  ])("folds modulo using Lua floored semantics ($label)", ({ source, expected }) => {
    const lua = compile(source);

    expect(lua).toContain(expected);
  });

  describe("unary negation folding (multi-pass)", () => {
    it("folds double negation to the positive value", () => {
      const lua = compile("const x = -(-5);");

      expect(lua).toContain("x = 5");
    });

    it("folds triple negation to a single negation", () => {
      const lua = compile("const x = -(-(-5));");

      expect(lua).toContain("x = -5");
    });
  });

  describe("non-finite results are not folded", () => {
    it.each([
      { label: "division by zero (Infinity)", source: "const x = 1 / 0;", expected: "1 / 0" },
      { label: "zero divided by zero (NaN)", source: "const x = 0 / 0;", expected: "0 / 0" },
      {
        label: "power expression that evaluates to NaN",
        source: "const x = (-4.2) ** (-4.2);",
        expected: "(-4.2) ^ (-4.2)",
      },
    ])("preserves $label", ({ source, expected }) => {
      const lua = compile(source);
      expect(lua).toContain(expected);
    });
  });

  describe("optimizeControlFlow preserves side-effectful conditions in empty if-blocks", () => {
    it("preserves call expression when if-body and else-body are both empty", () => {
      const lua = compile(`
        declare function sideEffect(): boolean;
        if (sideEffect()) {}
      `);

      expect(lua).toContain("sideEffect()");
    });

    it("preserves elseif call expression when elseif-body is empty", () => {
      const lua = compile(`
        declare function sideEffect(): boolean;
        declare let x: boolean;
        if (x) { x = false; } else if (sideEffect()) {}
      `);

      expect(lua).toContain("sideEffect()");
    });
  });

  describe("dead code elimination after return statements", () => {
    it("folds logical-not on boolean literals", () => {
      const lua = compile("const x = !!!true;");

      expect(lua).toContain("x = false");
    });

    it("removes unreachable statements after unconditional return in nested block", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          return x;
          const unreachable1 = 2;
          const unreachable2 = 3;
          return unreachable1;
        }
      `);

      expect(lua).toContain("return x");
      expect(lua).not.toContain("unreachable1");
      expect(lua).not.toContain("unreachable2");
    });

    it("removes unreachable statements in if-block after return", () => {
      const lua = compile(`
        function f(cond: boolean) {
          if (cond) {
            const x = 1;
            return x;
            const unreachable = 2;
          }
          const afterIf = 3;
          return afterIf;
        }
      `);

      expect(lua).not.toContain("unreachable");
      expect(lua).toContain("afterIf");
    });

    it("removes unreachable statements after return in do-block", () => {
      const lua = compile(`
        function f() {
          do {
            const x = 1;
            return x;
            const unreachable = 2;
          } while (false);
        }
      `);

      expect(lua).not.toContain("unreachable");
    });

    it("preserves all statements when no return is present", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          const y = 2;
          const z = 3;
          return x + y + z;
        }
      `);

      expect(lua).toContain("x");
      expect(lua).toContain("y");
      expect(lua).toContain("z");
    });

    it("handles complex control flow with multiple returns", () => {
      const lua = compile(`
        function f(a: boolean, b: boolean) {
          if (a) {
            return 1;
            const dead1 = 2;
          }
          if (b) {
            return 3;
            const dead2 = 4;
          }
          return 5;
          const dead3 = 6;
        }
      `);

      expect(lua).not.toContain("dead1");
      expect(lua).not.toContain("dead2");
      expect(lua).not.toContain("dead3");
      expect(lua).toContain("return 1");
      expect(lua).toContain("return 3");
      expect(lua).toContain("return 5");
    });
  });

  describe("binary and unary operator type coverage", () => {
    it("folds comparison operators for numbers", () => {
      const code = `
        export const eq = (1 as any) === (1 as any);
        export const neq = (1 as any) !== (2 as any);
        export const le = (1 as any) <= (2 as any);
        export const ge = (2 as any) >= (1 as any);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = true");
      expect(lua).toContain("neq = true");
      expect(lua).toContain("le = true");
      expect(lua).toContain("ge = true");
    });

    it("folds comparison operators for strings", () => {
      const code = `
        export const eq = ("a" as any) === ("a" as any);
        export const neq = ("a" as any) !== ("b" as any);
        export const lt = ("a" as any) < ("b" as any);
        export const le = ("a" as any) <= ("b" as any);
        export const gt = ("b" as any) > ("a" as any);
        export const ge = ("b" as any) >= ("a" as any);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = true");
      expect(lua).toContain("neq = true");
      expect(lua).toContain("lt = true");
      expect(lua).toContain("le = true");
      expect(lua).toContain("gt = true");
      expect(lua).toContain("ge = true");
    });

    it("folds comparison and logical operators for booleans", () => {
      const code = `
        export const eq = (true as any) === (true as any);
        export const neq = (true as any) !== (false as any);
        export const or_val = (true as any) || (false as any);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = true");
      expect(lua).toContain("neq = true");
      expect(lua).toContain("or_val = true");
    });

    it("folds cross-type equality comparisons", () => {
      const code = `
        export const eq = (1 as any) === ("1" as any);
        export const neq = (1 as any) !== ("1" as any);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = false");
      expect(lua).toContain("neq = true");
    });

    it("folds string length and unary negation", () => {
      const code = `
        export const len = "abc".length;
        export const neg = -(1);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("len = 3");
      expect(lua).toContain("neg = -1");
    });
  });

  describe("SourceFile visitor", () => {
    it("folds BitwiseNot at Lua AST level", () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock plugin context for internal visitor access
      const visitors = createVisitors({} as any, { rules: { "constant-folding": true } } as any);
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal visitor map by SyntaxKind
      const visitor = (visitors as any)[ts.SyntaxKind.SourceFile];

      const bitwiseNot = tstl.createUnaryExpression(
        tstl.createNumericLiteral(1),
        tstl.SyntaxKind.BitwiseNotOperator,
      );
      const stmt = tstl.createVariableDeclarationStatement(
        [tstl.createIdentifier("x")],
        [bitwiseNot],
      );
      const file = tstl.createFile([stmt], new Set(), "");

      // biome-ignore lint/suspicious/noExplicitAny: mock context for internal visitor
      const mockContext: any = {
        superTransformNode: vi.fn().mockReturnValue(file),
      };

      // biome-ignore lint/suspicious/noExplicitAny: mock node for internal visitor
      const result = visitor({} as any, mockContext);

      const resultStmt = result.statements[0] as tstl.VariableDeclarationStatement;
      // biome-ignore lint/style/noNonNullAssertion: test asserts right exists before access
      expect(tstl.isNumericLiteral(resultStmt.right![0])).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: test asserts right exists before access
      expect((resultStmt.right![0] as tstl.NumericLiteral).value).toBe(-2);
    });
  });

  it("preserves if-statement when elseif condition has side effects", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function get(): boolean;
      if (true) {
        print(1);
      } else if (get()) {
        print(2);
      }
    `;

    const lua = normalizeLua(compile(code));

    expect(lua.trim().length).toBeGreaterThan(0);
  });
});
