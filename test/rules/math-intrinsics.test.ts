import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("math-intrinsics", () => {
  describe("Math.floor", () => {
    it("replaces with x - x % 1 when argument is pure", () => {
      const lua = compile("declare const x: number; const a = Math.floor(x);");
      expect(lua).toContain("% 1");
      expect(lua).not.toContain("math.floor");
    });

    it("keeps math.floor when argument has side effects", () => {
      const lua = compile("declare function foo(): number; const a = Math.floor(foo());");
      expect(lua).toContain("math.floor");
    });
  });

  describe("Math.sqrt", () => {
    it("replaces with x ^ 0.5", () => {
      const lua = compile("declare const x: number; const a = Math.sqrt(x);");
      expect(lua).toContain("x ^ 0.5");
      expect(lua).not.toContain("math.sqrt");
    });

    it("replaces even when argument has side effects (single use)", () => {
      const lua = compile("declare function foo(): number; const a = Math.sqrt(foo());");
      expect(lua).toContain("^ 0.5");
      expect(lua).not.toContain("math.sqrt");
    });
  });

  describe("Math.abs", () => {
    it("replaces with conditional when argument is pure", () => {
      const lua = compile("declare const x: number; const a = Math.abs(x);");
      expect(lua).not.toContain("math.abs");
      expect(lua).toContain("x < 0");
    });

    it("parenthesizes negation to avoid Lua comment syntax", () => {
      const lua = compile("const r = Math.abs(-42);");
      expect(lua).not.toContain("--42");
      expect(lua).toContain("-(-42)");
    });

    it("keeps math.abs when argument has side effects", () => {
      const lua = compile("declare function foo(): number; const a = Math.abs(foo());");
      expect(lua).toContain("math.abs");
    });
  });

  describe("Math.max", () => {
    it("replaces 2-arg call with conditional when args are pure", () => {
      const lua = compile(
        "declare const a: number; declare const b: number; const c = Math.max(a, b);",
      );
      expect(lua).not.toContain("math.max");
    });

    it("keeps math.max with 3+ arguments", () => {
      const lua = compile(
        "declare const a: number; declare const b: number; declare const c: number; const d = Math.max(a, b, c);",
      );
      expect(lua).toContain("math.max");
    });

    it("keeps math.max when any argument has side effects", () => {
      const lua = compile(
        "declare function foo(): number; declare const b: number; const c = Math.max(foo(), b);",
      );
      expect(lua).toContain("math.max");
    });
  });

  describe("Math.min", () => {
    it("replaces 2-arg call with conditional when args are pure", () => {
      const lua = compile(
        "declare const a: number; declare const b: number; const c = Math.min(a, b);",
      );
      expect(lua).not.toContain("math.min");
    });

    it("keeps math.min with 3+ arguments", () => {
      const lua = compile(
        "declare const a: number; declare const b: number; declare const c: number; const d = Math.min(a, b, c);",
      );
      expect(lua).toContain("math.min");
    });

    it("keeps math.min when any argument has side effects", () => {
      const lua = compile(
        "declare function foo(): number; declare const b: number; const c = Math.min(foo(), b);",
      );
      expect(lua).toContain("math.min");
    });
  });

  describe("x ** 2", () => {
    it("replaces x ** 2 with x * x when base is pure", () => {
      const lua = compile("declare const x: number; const a = x ** 2;");
      expect(lua).toContain("x * x");
      expect(lua).not.toContain("^");
    });

    it("keeps x ^ 2 when base has side effects", () => {
      const lua = compile("declare function foo(): number; const a = foo() ** 2;");
      expect(lua).toContain("^ 2");
    });

    it("does not replace x ** 3 or other exponents", () => {
      const lua = compile("declare const x: number; const a = x ** 3;");
      expect(lua).toContain("x ^ 3");
    });
  });

  describe("passthrough", () => {
    it("does not transform non-Math calls", () => {
      const lua = compile("declare function floor(x: number): number; const a = floor(1.5);");
      expect(lua).toContain("floor(1.5)");
    });

    it("does not transform unsupported Math methods", () => {
      const lua = compile("declare const x: number; const a = Math.ceil(x);");
      expect(lua).toContain("math.ceil");
    });
  });

  describe("luajit target", () => {
    const jit = { pluginOptions: { target: "luajit" as const } };

    it("skips floor transform on LuaJIT", () => {
      const lua = compile("declare const x: number; const a = Math.floor(x);", jit);
      expect(lua).toContain("math.floor");
    });

    it("skips sqrt transform on LuaJIT", () => {
      const lua = compile("declare const x: number; const a = Math.sqrt(x);", jit);
      expect(lua).toContain("math.sqrt");
    });

    it("skips abs transform on LuaJIT", () => {
      const lua = compile("declare const x: number; const a = Math.abs(x);", jit);
      expect(lua).toContain("math.abs");
    });

    it("skips max transform on LuaJIT", () => {
      const lua = compile(
        "declare const a: number; declare const b: number; const c = Math.max(a, b);",
        jit,
      );
      expect(lua).toContain("math.max");
    });

    it("skips min transform on LuaJIT", () => {
      const lua = compile(
        "declare const a: number; declare const b: number; const c = Math.min(a, b);",
        jit,
      );
      expect(lua).toContain("math.min");
    });

    it("still applies x ** 2 → x * x on LuaJIT", () => {
      const lua = compile("declare const x: number; const a = x ** 2;", jit);
      expect(lua).toContain("x * x");
      expect(lua).not.toContain("^");
    });
  });
});
