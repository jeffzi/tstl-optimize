import fc from "fast-check";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConditionalCompilationConfig } from "../../src/config";
import { arbSafeString } from "../arbitraries";
import { compile, compileWithDiagnostics, normalizeLua } from "../helpers";

// Lua global not in TypeScript's lib — declare it so TS does not error on test sources.
const PRINT_DECL = "declare function print(...args: unknown[]): void;";

function ccOpts(constants: Record<string, { env: string; default: boolean | number | string }>) {
  return {
    pluginOptions: { rules: { "conditional-compilation": { constants } } },
  };
}

describe("resolveConditionalCompilationConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      const src = `${PRINT_DECL} declare const DEBUG: boolean; if (DEBUG) { print(1); } else { print(2); }`;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });

    it("strips if-statement without else when falsy", () => {
      const src = `${PRINT_DECL} declare const DEBUG: boolean; if (DEBUG) { print(1); } print(2);`;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: false } })));

      expect(lua).toBe("print(2)");
    });

    it("folds to matching else-if branch", () => {
      const src = `${PRINT_DECL} declare const PLATFORM: string; if (PLATFORM === "web") { print(1); } else if (PLATFORM === "native") { print(2); } else { print(3); }`;

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
        src: `${PRINT_DECL} declare const A: boolean, B: boolean; if (A && !B) { print(1); }`,
        expected: "print(1)",
      },
      {
        name: "logical OR",
        src: `${PRINT_DECL} declare const A: boolean, B: boolean; if (A || B) { print(1); }`,
        expected: "print(1)",
      },
      {
        name: "numeric equality",
        src: `${PRINT_DECL} declare const VAL: number; if (VAL === 42) { print(1); }`,
        expected: "print(1)",
      },
      { name: "literal true", src: `${PRINT_DECL} if (true) { print(1); }`, expected: "print(1)" },
      { name: "literal false", src: `${PRINT_DECL} if (false) { print(1); }`, expected: "" },
    ])("folds $name condition", ({ src, expected }) => {
      expect(normalizeLua(compile(src, opts))).toBe(expected);
    });
  });

  describe("switch-statement folding", () => {
    const src = `
      ${PRINT_DECL}
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
    const partialSrc = `${PRINT_DECL} declare const DEBUG: boolean, unknown: boolean; if (DEBUG && unknown) { print(1); }`;

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
      const lua = compile(`${PRINT_DECL} if (true) { print(1); }`, {
        pluginOptions: { rules: { "conditional-compilation": false } },
      });
      expect(lua).toContain("if true then");
    });

    it("interacts with other rules correctly", () => {
      const lua = compile(
        `${PRINT_DECL} declare const DEBUG: boolean; if (DEBUG) { print(Math.floor(1.5)); }`,
        {
          pluginOptions: {
            rules: {
              "conditional-compilation": { constants: { DEBUG: { env: "X", default: true } } },
              "math-intrinsics": true,
            },
          },
        },
      );
      // math-intrinsics converts Math.floor(1.5) to 1.5 - 1.5 % 1,
      // then constant-folding reduces it to 1
      expect(normalizeLua(lua)).toBe("print(1)");
    });
  });

  describe("switch fallthrough with conditional breaks", () => {
    it("preserves fallthrough when break is conditional", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        declare const FLAG: boolean;
        switch (MODE) {
          case "a":
            print(1);
            if (FLAG) break;
          case "b":
            print(2);
            break;
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "a" } })));

      // When MODE="a" and the break is conditional (guarded by FLAG),
      // fallthrough should still happen to case b.
      // Both print(1) and print(2) should appear in the output.
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });

    it("halts fallthrough on unconditional break", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        switch (MODE) {
          case "a":
            print(1);
            break;
          case "b":
            print(2);
            break;
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "a" } })));

      // With an unconditional break after print(1), fallthrough should stop.
      // Only print(1) should appear.
      expect(lua).toBe("print(1)");
    });
  });

  describe("switch with unresolved cases", () => {
    it("preserves unresolved cases when switch value is resolved", () => {
      const src = `
        ${PRINT_DECL}
        declare const SWITCH_VAL: string;
        declare const CASE_UNRESOLVED: string;
        switch (SWITCH_VAL) {
          case CASE_UNRESOLVED:
            print(1);
            break;
          case "resolved":
            print(2);
            break;
          default:
            print(3);
        }
      `;

      const lua = normalizeLua(
        compile(src, ccOpts({ SWITCH_VAL: { env: "X", default: "resolved" } })),
      );

      // SWITCH_VAL is resolved to "resolved", but CASE_UNRESOLVED is unresolved.
      // The switch should fold to the matching resolved case ("resolved" -> print(2)),
      // but the unresolved case should NOT cause us to incorrectly pick default.
      expect(lua).toBe("print(2)");
    });

    it("does not fold to default when unresolved case is present", () => {
      const src = `
        ${PRINT_DECL}
        declare const SWITCH_VAL: string;
        declare const CASE_UNRESOLVED: string;
        switch (SWITCH_VAL) {
          case CASE_UNRESOLVED:
            print(1);
            break;
          case "other":
            print(2);
            break;
          default:
            print(3);
        }
      `;

      const lua = normalizeLua(
        compile(src, ccOpts({ SWITCH_VAL: { env: "X", default: "nomatch" } })),
      );

      // SWITCH_VAL is resolved to "nomatch", which doesn't match "other".
      // But there's an unresolved case CASE_UNRESOLVED that might match at runtime.
      // So the switch must be preserved, not folded to default.
      expect(lua).toContain("repeat");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
      expect(lua).toContain("print(3)");
    });

    it("does not skip unresolved case when it could match the switch value", () => {
      const src = `
        ${PRINT_DECL}
        declare const SWITCH_VAL: string;
        declare const CASE_VALUE: string;
        switch (SWITCH_VAL) {
          case CASE_VALUE:
            print(1);
            break;
          default:
            print(2);
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ SWITCH_VAL: { env: "X", default: "test" } })));

      // SWITCH_VAL is resolved to "test", but CASE_VALUE is unresolved.
      // We cannot statically determine if CASE_VALUE == "test", so we must preserve
      // the switch with the unresolved case, NOT fold to default.
      // The code should keep the switch structure intact.
      expect(lua).toContain("repeat");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });
  });
});

describe("property-based", () => {
  const NUM_RUNS = 50;
  const TIMEOUT = 15_000;

  it(
    "boolean constant selects correct branch",
    () => {
      fc.assert(
        fc.property(fc.boolean(), (value) => {
          const src = `
            declare const MY_FLAG: boolean;
            if (MY_FLAG) { const kept = "yes"; } else { const removed = "no"; }
          `;

          const lua = compile(src, ccOpts({ MY_FLAG: { env: "X", default: value } }));

          if (value) {
            expect(lua).toContain('"yes"');
            expect(lua).not.toContain('"no"');
          } else {
            expect(lua).toContain('"no"');
            expect(lua).not.toContain('"yes"');
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "negation inverts branch selection",
    () => {
      fc.assert(
        fc.property(fc.boolean(), (value) => {
          const src = `
            declare const MY_FLAG: boolean;
            if (!MY_FLAG) { const kept = "yes"; } else { const removed = "no"; }
          `;

          const lua = compile(src, ccOpts({ MY_FLAG: { env: "X", default: value } }));

          if (value) {
            expect(lua).toContain('"no"');
            expect(lua).not.toContain('"yes"');
          } else {
            expect(lua).toContain('"yes"');
            expect(lua).not.toContain('"no"');
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "string equality selects correct branch",
    () => {
      fc.assert(
        fc.property(arbSafeString, arbSafeString, (constValue, compareValue) => {
          const src = `
            declare const PLATFORM: string;
            if (PLATFORM === "${compareValue}") { const matched = "yes"; } else { const unmatched = "no"; }
          `;

          const lua = compile(src, ccOpts({ PLATFORM: { env: "X", default: constValue } }));

          if (constValue === compareValue) {
            expect(lua).toContain('"yes"');
            expect(lua).not.toContain('"no"');
          } else {
            expect(lua).toContain('"no"');
            expect(lua).not.toContain('"yes"');
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT,
  );
});
