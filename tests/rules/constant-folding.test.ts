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
});
