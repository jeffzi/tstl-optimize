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
    it("replaces with x ^ 0.5 when argument is pure", () => {
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
      const noFold = { pluginOptions: { rules: { "constant-folding": false } } };

      const lua = compile("const x = Math.abs(-42);", noFold);

      expect(lua).toContain("-(-42)");
      expect(lua).not.toMatch(/--\d/);
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

  describe("constant-folding interaction", () => {
    it("folds Math.floor with constant argument to literal", () => {
      const lua = compile("const x = Math.floor(1.7);");

      expect(lua).toContain("= 1");
      expect(lua).not.toContain("% 1");
    });

    it("folds Math.abs conditional with constant argument", () => {
      const lua = compile("const x = Math.abs(-42);");

      expect(lua).toContain("true and");
      expect(lua).not.toContain("math.abs");
      expect(lua).not.toMatch(/--\d/);
    });

    it("folds Math.max conditional with constant arguments", () => {
      const lua = compile("const x = Math.max(5, 3);");

      expect(lua).toContain("true and 5 or 3");
      expect(lua).not.toContain("math.max");
    });

    it("folds x ** 2 with constant base to literal", () => {
      const lua = compile("const x = 3 ** 2;");

      expect(lua).toContain("= 9");
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

    it.each([
      {
        name: "skips floor transform",
        source: "declare const x: number; const a = Math.floor(x);",
        contains: ["math.floor"],
      },
      {
        name: "skips sqrt transform",
        source: "declare const x: number; const a = Math.sqrt(x);",
        contains: ["math.sqrt"],
      },
      {
        name: "skips abs transform",
        source: "declare const x: number; const a = Math.abs(x);",
        contains: ["math.abs"],
      },
      {
        name: "skips max transform",
        source: "declare const a: number; declare const b: number; const c = Math.max(a, b);",
        contains: ["math.max"],
      },
      {
        name: "skips min transform",
        source: "declare const a: number; declare const b: number; const c = Math.min(a, b);",
        contains: ["math.min"],
      },
      {
        name: "still applies x ** 2 → x * x",
        source: "declare const x: number; const a = x ** 2;",
        contains: ["x * x"],
        excludes: ["^"],
      },
    ])("$name on LuaJIT", ({ source, contains, excludes }) => {
      const lua = compile(source, jit);
      for (const s of contains) expect(lua).toContain(s);
      for (const s of excludes ?? []) expect(lua).not.toContain(s);
    });
  });
});
