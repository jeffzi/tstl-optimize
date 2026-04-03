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
    it("folds basic if/else branches", () => {
      const src = "declare const DEBUG: boolean; if (DEBUG) { print(1); } else { print(2); }";

      expect(normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: true } })))).toBe(
        "print(1)",
      );
      expect(normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: false } })))).toBe(
        "print(2)",
      );
    });

    it("strips if-statement without else when falsy", () => {
      const src = "declare const DEBUG: boolean; if (DEBUG) { print(1); } print(2);";
      expect(normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: false } })))).toBe(
        "print(2)",
      );
    });

    it("handles else-if chains", () => {
      const src =
        'declare const PLATFORM: string; if (PLATFORM === "web") { print(1); } else if (PLATFORM === "native") { print(2); } else { print(3); }';
      expect(
        normalizeLua(compile(src, ccOpts({ PLATFORM: { env: "X", default: "native" } }))),
      ).toBe("print(2)");
    });
  });

  describe("ternary folding", () => {
    it("folds ternary expressions", () => {
      const src = "declare const DEBUG: boolean; const x = DEBUG ? 1 : 2;";
      expect(normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: true } })))).toBe(
        "x = 1",
      );
      expect(normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: false } })))).toBe(
        "x = 2",
      );
    });
  });

  describe("expression evaluation", () => {
    it("evaluates logical operators and comparisons", () => {
      const opts = ccOpts({
        A: { env: "X", default: true },
        B: { env: "X", default: false },
        VAL: { env: "X", default: 42 },
      });

      expect(
        normalizeLua(
          compile("declare const A: boolean, B: boolean; if (A && !B) { print(1); }", opts),
        ),
      ).toBe("print(1)");
      expect(
        normalizeLua(
          compile("declare const A: boolean, B: boolean; if (A || B) { print(1); }", opts),
        ),
      ).toBe("print(1)");
      expect(
        normalizeLua(compile("declare const VAL: number; if (VAL === 42) { print(1); }", opts)),
      ).toBe("print(1)");
    });

    it("handles literal values in conditions", () => {
      const opts = ccOpts({ DEBUG: { env: "X", default: true } });
      expect(normalizeLua(compile("if (true) { print(1); }", opts))).toBe("print(1)");
      expect(normalizeLua(compile("if (false) { print(1); }", opts))).toBe("");
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

    it("folds to matching case", () => {
      expect(normalizeLua(compile(src, ccOpts({ P: { env: "X", default: "a" } })))).toBe(
        "print(1)",
      );
      expect(normalizeLua(compile(src, ccOpts({ P: { env: "X", default: "b" } })))).toBe(
        "print(2)",
      );
    });

    it("folds to default case", () => {
      expect(normalizeLua(compile(src, ccOpts({ P: { env: "X", default: "z" } })))).toBe(
        "print(3)",
      );
    });
  });

  describe("diagnostics", () => {
    it("warns on partially resolvable conditions", () => {
      const { diagnostics } = compileWithDiagnostics(
        "declare const DEBUG: boolean, unknown: boolean; if (DEBUG && unknown) { print(1); }",
        ccOpts({ DEBUG: { env: "X", default: true } }),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("could not be fully resolved");
    });

    it("respects strict mode for partial resolutions", () => {
      const src =
        "declare const DEBUG: boolean, unknown: boolean; if (DEBUG && unknown) { print(1); }";
      const opts = {
        pluginOptions: {
          strict: true,
          rules: {
            "conditional-compilation": { constants: { DEBUG: { env: "X", default: true } } },
          },
        },
      };
      const { diagnostics } = compileWithDiagnostics(src, opts);
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
      const opts = {
        pluginOptions: {
          rules: {
            "conditional-compilation": { constants: { DEBUG: { env: "X", default: true } } },
            "math-intrinsics": true,
          },
        },
      };
      const lua = compile(
        "declare const DEBUG: boolean; if (DEBUG) { print(Math.floor(1.5)); }",
        opts,
      );
      // math-intrinsics converts Math.floor(1.5) to 1.5 - 1.5 % 1,
      // then constant-folding reduces it to 1
      expect(normalizeLua(lua)).toBe("print(1)");
    });
  });
});
