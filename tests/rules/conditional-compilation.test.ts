import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { resolveConditionalCompilationConfig } from "../../src/config";
import { compile, compileWithDiagnostics, normalizeLua } from "../helpers";

function ccOpts(constants: Record<string, { env: string; default: boolean | number | string }>) {
  return {
    pluginOptions: { rules: { "conditional-compilation": { constants } } },
  };
}

describe("resolveConditionalCompilationConfig", () => {
  it("returns false for disabled or missing config", () => {
    expect(resolveConditionalCompilationConfig(undefined)).toBe(false);
    expect(resolveConditionalCompilationConfig(false)).toBe(false);
    expect(resolveConditionalCompilationConfig({ enabled: false, constants: {} })).toBe(false);
  });

  it("returns empty map for boolean true", () => {
    expect(resolveConditionalCompilationConfig(true)).toStrictEqual(new Map());
  });

  it("resolves constants from environment or default", () => {
    vi.stubEnv("TEST_CC_BOOL_TRUE", "true");
    vi.stubEnv("TEST_CC_BOOL_ONE", "1");
    vi.stubEnv("TEST_CC_NUM", "42.5");
    vi.stubEnv("TEST_CC_NAN", "abc");
    vi.stubEnv("TEST_CC_STR", "HTML5");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: {
        A: { env: "TEST_CC_BOOL_TRUE", default: false },
        B: { env: "TEST_CC_BOOL_ONE", default: false },
        C: { env: "TEST_CC_BOOL_OTHER", default: true },
        D: { env: "TEST_CC_NUM", default: 0 },
        E: { env: "TEST_CC_NAN", default: 99 },
        F: { env: "TEST_CC_STR", default: "native" },
      },
    });

    expect(result).toStrictEqual(
      new Map<string, boolean | number | string>([
        ["A", true],
        ["B", true],
        ["C", true],
        ["D", 42.5],
        ["E", 99],
        ["F", "HTML5"],
      ]),
    );
  });
});

describe("conditional-compilation", () => {
  describe("if-statement folding", () => {
    it.each([
      { name: "truthy", value: true, expected: "print(1)" },
      { name: "falsy", value: false, expected: "print(2)" },
    ])("folds if/else to $name branch", ({ value, expected }) => {
      const src = "declare const DEBUG: boolean; if (DEBUG) { print(1); } else { print(2); }";

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });

    it("strips if-statement without else when falsy", () => {
      const src = "declare const DEBUG: boolean; if (DEBUG) { print(1); } print(2);";

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: false } })));

      expect(lua).toBe("print(2)");
    });

    it("folds to matching else-if branch", () => {
      const src =
        'declare const PLATFORM: string; if (PLATFORM === "web") { print(1); } else if (PLATFORM === "native") { print(2); } else { print(3); }';

      const lua = normalizeLua(compile(src, ccOpts({ PLATFORM: { env: "X", default: "native" } })));

      expect(lua).toBe("print(2)");
    });
  });

  describe("ternary folding", () => {
    it.each([
      { name: "truthy", value: true, expected: "x = 1" },
      { name: "falsy", value: false, expected: "x = 2" },
    ])("folds ternary to $name branch", ({ value, expected }) => {
      const src = "declare const DEBUG: boolean; const x = DEBUG ? 1 : 2;";

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });
  });

  describe("expression evaluation", () => {
    const opts = ccOpts({
      A: { env: "X", default: true },
      B: { env: "X", default: false },
      VAL: { env: "X", default: 42 },
    });

    it.each([
      {
        name: "logical AND with negation",
        src: "declare const A: boolean, B: boolean; if (A && !B) { print(1); }",
        expected: "print(1)",
      },
      {
        name: "logical OR",
        src: "declare const A: boolean, B: boolean; if (A || B) { print(1); }",
        expected: "print(1)",
      },
      {
        name: "numeric equality",
        src: "declare const VAL: number; if (VAL === 42) { print(1); }",
        expected: "print(1)",
      },
      { name: "literal true", src: "if (true) { print(1); }", expected: "print(1)" },
      { name: "literal false", src: "if (false) { print(1); }", expected: "" },
    ])("folds $name condition", ({ src, expected }) => {
      expect(normalizeLua(compile(src, opts))).toBe(expected);
    });
  });

  describe("switch-statement folding", () => {
    const src = `
      declare const P: string;
      switch (P) {
        case "a": print(1); break;
        case "b":
        case "c": print(2); break;
        default: print(3);
      }
    `;

    it.each([
      { name: "direct match", value: "a", expected: "print(1)" },
      { name: "fall-through match", value: "b", expected: "print(2)" },
      { name: "default", value: "z", expected: "print(3)" },
    ])("folds to $name case", ({ value, expected }) => {
      const lua = normalizeLua(compile(src, ccOpts({ P: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });
  });

  describe("diagnostics", () => {
    const partialSrc =
      "declare const DEBUG: boolean, unknown: boolean; if (DEBUG && unknown) { print(1); }";

    it("warns on partially resolvable conditions", () => {
      const { diagnostics } = compileWithDiagnostics(
        partialSrc,
        ccOpts({ DEBUG: { env: "X", default: true } }),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("could not be fully resolved");
    });

    it("promotes warning to error in strict mode", () => {
      const { pluginOptions } = ccOpts({ DEBUG: { env: "X", default: true } });
      const { diagnostics } = compileWithDiagnostics(partialSrc, {
        pluginOptions: { ...pluginOptions, strict: true },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });
  });

  describe("edge cases", () => {
    it("does not fold when rule is disabled", () => {
      const lua = compile("if (true) { print(1); }", {
        pluginOptions: { rules: { "conditional-compilation": false } },
      });
      expect(lua).toContain("if true then");
    });

    it("interacts with other rules correctly", () => {
      const lua = compile("declare const DEBUG: boolean; if (DEBUG) { print(Math.floor(1.5)); }", {
        pluginOptions: {
          rules: {
            "conditional-compilation": { constants: { DEBUG: { env: "X", default: true } } },
            "math-intrinsics": true,
          },
        },
      });
      // math-intrinsics converts Math.floor(1.5) to 1.5 - 1.5 % 1,
      // then constant-folding reduces it to 1
      expect(normalizeLua(lua)).toBe("print(1)");
    });
  });
});
