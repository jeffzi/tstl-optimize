import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

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

  describe("uncovered branches: unary evaluation and control flow dead-code elimination", () => {
    it("folds double negation to positive value", () => {
      // Lines 120-122: tests that unary NegationOperator folds correctly
      // When operand is itself a unary expression (double negation)
      const lua = compile(`
        const x = -(-42);
      `);
      // Double negation should fold to positive
      expect(lua).toContain("x = 42");
    });

    it("folds triple negation correctly", () => {
      // Lines 120-122: additional test for NegationOperator path
      const lua = compile(`
        const x = -(-(-42));
      `);
      // Triple negation should fold to single negation
      expect(lua).toContain("x = -42");
    });

    // Note: bitwise operations are not supported in Lua 5.1, so we skip testing
    // the BitwiseNotOperator branch. The evaluateUnary function will return undefined
    // for non-number operands or for bitwise ops on number operands in Lua 5.1 target.

    it("folds logical-not on boolean literals", () => {
      // Lines 110-111: tests NotOperator on boolean operand
      const lua = compile(`
        const x = !!!true;
      `);
      // !!!true = false
      expect(lua).toContain("x = false");
    });

    it("removes unreachable statements after unconditional return in nested block", () => {
      // Lines 143-144: tests the statement truncation after return in optimizeControlFlow
      // Ensures statements after return are removed (the splicing logic)
      const lua = compile(`
        function f() {
          const x = 1;
          return x;
          const unreachable1 = 2;
          const unreachable2 = 3;
          return unreachable1;
        }
      `);
      // All statements after the first return should be removed
      expect(lua).toContain("return x");
      expect(lua).not.toContain("unreachable1");
      expect(lua).not.toContain("unreachable2");
    });

    it("removes unreachable statements in if-block after return", () => {
      // Lines 143-144: tests truncation within if-block bodies
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
      // Unreachable inside if block should be removed
      expect(lua).not.toContain("unreachable");
      // But afterIf is reachable
      expect(lua).toContain("afterIf");
    });

    it("removes unreachable statements after return in do-block", () => {
      // Lines 143-144: tests truncation within do-block bodies
      const lua = compile(`
        function f() {
          do {
            const x = 1;
            return x;
            const unreachable = 2;
          } while (false);
        }
      `);
      // Unreachable code after return in do-block should be removed
      expect(lua).not.toContain("unreachable");
    });

    it("preserves all statements when no return is present", () => {
      // Lines 143-144: negative case — no truncation when no return
      const lua = compile(`
        function f() {
          const x = 1;
          const y = 2;
          const z = 3;
          return x + y + z;
        }
      `);
      // All statements should be present when return is at the end
      expect(lua).toContain("x");
      expect(lua).toContain("y");
      expect(lua).toContain("z");
    });

    it("handles complex control flow with multiple returns", () => {
      // Lines 143-144: tests truncation across multiple conditional paths
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
      // All dead code after each return should be gone
      expect(lua).not.toContain("dead1");
      expect(lua).not.toContain("dead2");
      expect(lua).not.toContain("dead3");
      expect(lua).toContain("return 1");
      expect(lua).toContain("return 3");
      expect(lua).toContain("return 5");
    });
  });
});
