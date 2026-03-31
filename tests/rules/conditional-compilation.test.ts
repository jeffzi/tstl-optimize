import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConditionalCompilationConfig } from "../../src/config";
import { compile, compileWithDiagnostics, normalizeLua } from "../helpers";

function ccOpts(constants: Record<string, { env: string; default: boolean | number | string }>) {
  return {
    pluginOptions: { rules: { "conditional-compilation": { constants } } },
  };
}

describe("resolveConditionalCompilationConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false for undefined or false", () => {
    expect(resolveConditionalCompilationConfig(undefined)).toBe(false);
    expect(resolveConditionalCompilationConfig(false)).toBe(false);
  });

  it("returns empty map for boolean true (no constants)", () => {
    const result = resolveConditionalCompilationConfig(true);
    expect(result).toStrictEqual(new Map());
  });

  it("returns false for { enabled: false }", () => {
    expect(resolveConditionalCompilationConfig({ enabled: false, constants: {} })).toBe(false);
  });

  it("uses default when env var is unset", () => {
    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: { DEBUG: { env: "TEST_CC_UNSET", default: false } },
    });
    expect(result).toStrictEqual(new Map([["DEBUG", false]]));
  });

  it("coerces env var to boolean when default is boolean", () => {
    vi.stubEnv("TEST_CC_BOOL_TRUE", "true");
    vi.stubEnv("TEST_CC_BOOL_ONE", "1");
    vi.stubEnv("TEST_CC_BOOL_OTHER", "nope");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: {
        A: { env: "TEST_CC_BOOL_TRUE", default: false },
        B: { env: "TEST_CC_BOOL_ONE", default: false },
        C: { env: "TEST_CC_BOOL_OTHER", default: true },
      },
    });

    expect(result).toStrictEqual(
      new Map<string, boolean>([
        ["A", true],
        ["B", true],
        ["C", false],
      ]),
    );
  });

  it("coerces env var to number when default is number", () => {
    vi.stubEnv("TEST_CC_NUM", "42.5");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: { VER: { env: "TEST_CC_NUM", default: 0 } },
    });
    expect(result).toStrictEqual(new Map([["VER", 42.5]]));
  });

  it("falls back to default when number coercion produces NaN", () => {
    vi.stubEnv("TEST_CC_NAN", "abc");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: { VER: { env: "TEST_CC_NAN", default: 99 } },
    });
    expect(result).toStrictEqual(new Map([["VER", 99]]));
  });

  it("uses env var as string when default is string", () => {
    vi.stubEnv("TEST_CC_STR", "HTML5");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: { PLATFORM: { env: "TEST_CC_STR", default: "native" } },
    });
    expect(result).toStrictEqual(new Map([["PLATFORM", "HTML5"]]));
  });
});

describe("conditional-compilation", () => {
  describe("if-statement folding", () => {
    it("truthy condition keeps then-branch, strips else", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (DEBUG) { const a = x + 1; } else { const b = x + 2; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("falsy condition with else keeps else-branch, strips then", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (DEBUG) { const a = x + 1; } else { const b = x + 2; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: false } }),
      );
      expect(normalizeLua(lua)).toBe("b = x + 2");
    });

    it("falsy condition without else strips entire if", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (DEBUG) { const a = x + 1; }",
          "const b = x;",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: false } }),
      );
      expect(normalizeLua(lua)).toBe("b = x");
    });

    it("handles else-if chains", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          'if (PLATFORM === "HTML5") { const a = 1; }',
          'else if (PLATFORM === "native") { const b = 2; }',
          "else { const c = 3; }",
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "native" } }),
      );
      expect(normalizeLua(lua)).toBe("b = 2");
    });

    it("unknown condition passes through as runtime if", () => {
      const lua = compile(
        ["declare const cond: boolean;", "if (cond) { const a = 1; } else { const b = 2; }"].join(
          "\n",
        ),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(lua).toContain("if cond then");
    });

    it("multiple statements in then-branch are all kept", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (DEBUG) { const a = x + 1; const b = x + 2; const c = x + 3; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toContain("a = x + 1");
      expect(normalizeLua(lua)).toContain("b = x + 2");
      expect(normalizeLua(lua)).toContain("c = x + 3");
    });
  });

  describe("ternary folding", () => {
    it("truthy condition keeps whenTrue expression", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "const a = DEBUG ? x + 1 : x + 2;",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("falsy condition keeps whenFalse expression", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "const a = DEBUG ? x + 1 : x + 2;",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: false } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 2");
    });

    it("unknown condition leaves ternary as runtime code", () => {
      const lua = compile(
        [
          "declare const cond: boolean;",
          "declare const x: number;",
          "const a = cond ? x + 1 : x + 2;",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(lua).toContain("cond");
      expect(lua).toContain("x + 1");
      expect(lua).toContain("x + 2");
    });

    it("nested ternary folds correctly", () => {
      const lua = compile(
        [
          "declare const LEVEL: number;",
          "declare const x: number;",
          "const a = LEVEL === 1 ? x + 10 : LEVEL === 2 ? x + 20 : x + 30;",
        ].join("\n"),
        ccOpts({ LEVEL: { env: "CC_UNUSED", default: 2 } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 20");
    });
  });

  describe("expression evaluation", () => {
    it("boolean constants: true is truthy, false is falsy", () => {
      const lua = compile(
        [
          "declare const A: boolean;",
          "declare const B: boolean;",
          "declare const x: number;",
          "if (A) { const a = 1; }",
          "if (B) { const b = 2; }",
          "const z = x;",
        ].join("\n"),
        ccOpts({
          A: { env: "CC_UNUSED", default: true },
          B: { env: "CC_UNUSED", default: false },
        }),
      );
      expect(normalizeLua(lua)).toContain("a = 1");
      expect(normalizeLua(lua)).not.toContain("b = 2");
    });

    it("numeric constants: 0 is falsy, non-zero is truthy", () => {
      const lua = compile(
        [
          "declare const LEVEL: number;",
          "declare const ZERO: number;",
          "declare const x: number;",
          "if (LEVEL) { const a = 1; }",
          "if (ZERO) { const b = 2; }",
          "const z = x;",
        ].join("\n"),
        ccOpts({
          LEVEL: { env: "CC_UNUSED", default: 3 },
          ZERO: { env: "CC_UNUSED", default: 0 },
        }),
      );
      expect(normalizeLua(lua)).toContain("a = 1");
      expect(normalizeLua(lua)).not.toContain("b = 2");
    });

    it('string constants: "" is falsy, non-empty is truthy', () => {
      const lua = compile(
        [
          "declare const NAME: string;",
          "declare const EMPTY: string;",
          "declare const x: number;",
          "if (NAME) { const a = 1; }",
          "if (EMPTY) { const b = 2; }",
          "const z = x;",
        ].join("\n"),
        ccOpts({
          NAME: { env: "CC_UNUSED", default: "hello" },
          EMPTY: { env: "CC_UNUSED", default: "" },
        }),
      );
      expect(normalizeLua(lua)).toContain("a = 1");
      expect(normalizeLua(lua)).not.toContain("b = 2");
    });

    it("! negation", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (!DEBUG) { const a = x + 1; }",
          "const z = x;",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).not.toContain("a =");
      expect(normalizeLua(lua)).toContain("z = x");
    });

    it("&& short-circuit: falsy left skips right", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const VERBOSE: boolean;",
          "declare const x: number;",
          "if (DEBUG && VERBOSE) { const a = x + 1; }",
          "const z = x;",
        ].join("\n"),
        ccOpts({
          DEBUG: { env: "CC_UNUSED", default: false },
          VERBOSE: { env: "CC_UNUSED", default: true },
        }),
      );
      expect(normalizeLua(lua)).not.toContain("a =");
      expect(normalizeLua(lua)).toContain("z = x");
    });

    it("&& truthy left evaluates right", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const VERBOSE: boolean;",
          "declare const x: number;",
          "if (DEBUG && VERBOSE) { const a = x + 1; }",
        ].join("\n"),
        ccOpts({
          DEBUG: { env: "CC_UNUSED", default: true },
          VERBOSE: { env: "CC_UNUSED", default: true },
        }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("|| short-circuit: truthy left skips right", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const VERBOSE: boolean;",
          "declare const x: number;",
          "if (DEBUG || VERBOSE) { const a = x + 1; }",
        ].join("\n"),
        ccOpts({
          DEBUG: { env: "CC_UNUSED", default: true },
          VERBOSE: { env: "CC_UNUSED", default: false },
        }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("|| falsy left evaluates right", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const VERBOSE: boolean;",
          "declare const x: number;",
          "if (DEBUG || VERBOSE) { const a = x + 1; }",
          "const z = x;",
        ].join("\n"),
        ccOpts({
          DEBUG: { env: "CC_UNUSED", default: false },
          VERBOSE: { env: "CC_UNUSED", default: false },
        }),
      );
      expect(normalizeLua(lua)).not.toContain("a =");
      expect(normalizeLua(lua)).toContain("z = x");
    });

    it("=== comparison", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare const x: number;",
          'if (PLATFORM === "HTML5") { const a = x + 1; } else { const b = x + 2; }',
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "HTML5" } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("!== comparison", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare const x: number;",
          'if (PLATFORM !== "HTML5") { const a = x + 1; } else { const b = x + 2; }',
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "HTML5" } }),
      );
      expect(normalizeLua(lua)).toBe("b = x + 2");
    });

    it("parenthesized grouping", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const VERBOSE: boolean;",
          "declare const ENABLED: boolean;",
          "declare const x: number;",
          "if ((DEBUG || VERBOSE) && ENABLED) { const a = x + 1; }",
        ].join("\n"),
        ccOpts({
          DEBUG: { env: "CC_UNUSED", default: false },
          VERBOSE: { env: "CC_UNUSED", default: true },
          ENABLED: { env: "CC_UNUSED", default: true },
        }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("unknown identifiers return undefined (no folding)", () => {
      const lua = compile(
        [
          "declare const unknownFlag: boolean;",
          "if (unknownFlag) { const a = 1; } else { const b = 2; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(lua).toContain("if unknownFlag then");
    });

    it("literal true/false in conditions fold when rule is active", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (true) { const a = x + 1; }",
          "if (false) { const b = x + 2; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toContain("a = x + 1");
      expect(normalizeLua(lua)).not.toContain("b = x + 2");
    });

    it("numeric literal in ternary folds when rule is active", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "const a = 1 ? x + 10 : x + 20;",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 10");
    });

    it("string literal in ternary folds when rule is active", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          'const a = "yes" ? x + 10 : x + 20;',
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 10");
    });

    it("=== with one unknown side does not fold", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "declare const unknown: string;",
          'if (unknown === "test") { const a = 1; } else { const b = 2; }',
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(lua).toContain("if unknown");
    });
  });

  describe("switch-statement folding", () => {
    it("matching case with break emits only that case body", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare function setupWeb(): void;",
          "declare function setupDesktop(): void;",
          "declare function setupMobile(): void;",
          "switch (PLATFORM) {",
          '  case "web": setupWeb(); break;',
          '  case "desktop": setupDesktop(); break;',
          "  default: setupMobile(); break;",
          "}",
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "desktop" } }),
      );
      expect(normalizeLua(lua)).toBe("setupDesktop()");
    });

    it("matching case without break falls through to next case", () => {
      const lua = compile(
        [
          "declare const LEVEL: number;",
          "declare const x: number;",
          "switch (LEVEL) {",
          "  case 1: const a = x + 1;",
          "  case 2: const b = x + 2; break;",
          "  case 3: const c = x + 3; break;",
          "}",
        ].join("\n"),
        ccOpts({ LEVEL: { env: "CC_UNUSED", default: 1 } }),
      );
      const norm = normalizeLua(lua);
      expect(norm).toContain("a = x + 1");
      expect(norm).toContain("b = x + 2");
      expect(norm).not.toContain("c = x + 3");
    });

    it("no match with default emits default body", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare const x: number;",
          "switch (PLATFORM) {",
          '  case "web": const a = x + 1; break;',
          "  default: const b = x + 2; break;",
          "}",
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "mobile" } }),
      );
      expect(normalizeLua(lua)).toBe("b = x + 2");
    });

    it("no match without default strips entire switch", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare const x: number;",
          "switch (PLATFORM) {",
          '  case "web": const a = x + 1; break;',
          '  case "desktop": const b = x + 2; break;',
          "}",
          "const z = x;",
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "mobile" } }),
      );
      expect(normalizeLua(lua)).toBe("z = x");
    });

    it("unknown expression passes through as runtime switch", () => {
      const lua = compile(
        [
          "declare const mode: number;",
          "switch (mode) {",
          "  case 1: const a = 1; break;",
          "  default: const b = 2; break;",
          "}",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      // TSTL emits repeat...until for switches
      expect(lua).toContain("repeat");
    });

    it("multiple empty cases sharing a body (grouped fallthrough)", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare const x: number;",
          "switch (PLATFORM) {",
          '  case "web":',
          '  case "mobile":',
          "    const a = x + 1; break;",
          '  case "desktop":',
          "    const b = x + 2; break;",
          "}",
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "web" } }),
      );
      expect(normalizeLua(lua)).toBe("a = x + 1");
    });

    it("numeric constant matching", () => {
      const lua = compile(
        [
          "declare const LEVEL: number;",
          "declare const x: number;",
          "switch (LEVEL) {",
          "  case 0: const a = x; break;",
          "  case 1: const b = x + 1; break;",
          "  case 2: const c = x + 2; break;",
          "}",
        ].join("\n"),
        ccOpts({ LEVEL: { env: "CC_UNUSED", default: 2 } }),
      );
      expect(normalizeLua(lua)).toBe("c = x + 2");
    });
  });

  describe("partial-folding diagnostics", () => {
    it("emits warning when && has one known and one unknown operand", () => {
      const { diagnostics } = compileWithDiagnostics(
        [
          "declare const PLATFORM: string;",
          "declare const connected: boolean;",
          'if (PLATFORM === "desktop" && connected) { print("ok"); }',
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "desktop" } }),
      );

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("could not be fully resolved");
    });

    it("emits warning when || has one known and one unknown operand", () => {
      const { diagnostics } = compileWithDiagnostics(
        [
          "declare const DEBUG: boolean;",
          "declare const verbose: boolean;",
          "if (DEBUG || verbose) { print('ok'); }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: false } }),
      );

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("could not be fully resolved");
    });

    it("does not emit warning for fully resolvable conditions", () => {
      const { diagnostics } = compileWithDiagnostics(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (DEBUG) { const a = x + 1; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );

      expect(diagnostics).toHaveLength(0);
    });

    it("does not emit warning for fully unknown conditions", () => {
      const { diagnostics } = compileWithDiagnostics(
        [
          "declare const unknown: boolean;",
          "if (unknown) { const a = 1; } else { const b = 2; }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );

      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("expression substitution", () => {
    it("replaces boolean constant identifier with literal", () => {
      const lua = compile(
        ["declare const DEBUG: boolean;", "const isDebug = DEBUG;"].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: false } }),
      );

      expect(normalizeLua(lua)).toBe("isDebug = false");
    });

    it("replaces string constant identifier with literal", () => {
      const lua = compile(
        ["declare const PLATFORM: string;", "const p = PLATFORM;"].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "desktop" } }),
      );

      expect(normalizeLua(lua)).toBe('p = "desktop"');
    });

    it("folds === comparison to boolean literal", () => {
      const lua = compile(
        ["declare const PLATFORM: string;", 'const isWeb = PLATFORM === "web";'].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "desktop" } }),
      );

      expect(normalizeLua(lua)).toBe("isWeb = false");
    });

    it("folds !constant to boolean literal", () => {
      const lua = compile(
        ["declare const DEBUG: boolean;", "const notDebug = !DEBUG;"].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: false } }),
      );

      expect(normalizeLua(lua)).toBe("notDebug = true");
    });

    it("folds && expression to literal when fully resolvable", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const VERBOSE: boolean;",
          "const both = DEBUG && VERBOSE;",
        ].join("\n"),
        ccOpts({
          DEBUG: { env: "CC_UNUSED", default: true },
          VERBOSE: { env: "CC_UNUSED", default: false },
        }),
      );

      expect(normalizeLua(lua)).toBe("both = false");
    });

    it("does not substitute unknown identifiers", () => {
      const lua = compile(
        ["declare const unknown: boolean;", "const x = unknown;"].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );

      expect(normalizeLua(lua)).toBe("x = unknown");
    });

    it("substitutes constant in mixed expression (partial improvement)", () => {
      const lua = compile(
        [
          "declare const PLATFORM: string;",
          "declare const connected: boolean;",
          'if (PLATFORM === "desktop" && connected) { print("ok"); }',
        ].join("\n"),
        ccOpts({ PLATFORM: { env: "CC_UNUSED", default: "desktop" } }),
      );

      // PLATFORM === "desktop" folds to true, connected passes through
      expect(lua).toContain("true");
      expect(lua).toContain("connected");
      expect(lua).not.toContain("PLATFORM");
    });
  });

  describe("edge cases", () => {
    it("rule disabled → no folding", () => {
      const lua = compile("if (true) { const a = 1; } else { const b = 2; }", {
        pluginOptions: { rules: { "conditional-compilation": false } },
      });
      expect(lua).toContain("if true then");
      expect(lua).toContain("a = 1");
      expect(lua).toContain("b = 2");
    });

    it("empty constants map → no identifiers resolve, no folding", () => {
      const lua = compile(
        ["declare const x: boolean;", "if (x) { const a = 1; } else { const b = 2; }"].join("\n"),
        ccOpts({}),
      );
      expect(lua).toContain("if x then");
    });

    it("interaction with math-intrinsics: surviving branch gets optimized", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          "if (DEBUG) { const a = Math.floor(x); } else { const b = Math.ceil(x); }",
        ].join("\n"),
        ccOpts({ DEBUG: { env: "CC_UNUSED", default: true } }),
      );
      expect(normalizeLua(lua)).toContain("x - x % 1");
      expect(lua).not.toContain("math.ceil");
    });

    it("interaction with debug-strip on surviving branch", () => {
      const lua = compile(
        [
          "declare const DEBUG: boolean;",
          "declare const x: number;",
          'if (DEBUG) { print("debug"); const a = x; } else { const b = x; }',
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              "conditional-compilation": {
                constants: { DEBUG: { env: "CC_UNUSED", default: true } },
              },
              "debug-strip": true,
            },
          },
        },
      );
      expect(lua).not.toContain("print");
      expect(normalizeLua(lua)).toBe("a = x");
    });
  });
});

describe("conditional-compilation strict mode (code 90002)", () => {
  const partialConditionSrc = [
    "declare const PLATFORM: string;",
    "declare const connected: boolean;",
    'if (PLATFORM === "desktop" && connected) { print("ok"); }',
  ].join("\n");

  const baseConstants = { PLATFORM: { env: "CC_UNUSED", default: "desktop" } };

  describe("global strict: true promotes 90002 to Error", () => {
    it("emits Error when global strict: true and no per-rule override", () => {
      const { diagnostics } = compileWithDiagnostics(partialConditionSrc, {
        pluginOptions: {
          strict: true,
          rules: { "conditional-compilation": { constants: baseConstants } },
        },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90002);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
      expect(diagnostics[0].source).toBe("tstl-optimize");
    });

    it("emits Warning when global strict: false (default)", () => {
      const { diagnostics } = compileWithDiagnostics(partialConditionSrc, {
        pluginOptions: {
          strict: false,
          rules: { "conditional-compilation": { constants: baseConstants } },
        },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90002);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    });
  });

  describe("per-rule conditional-compilation.strict override", () => {
    it("emits Warning when global strict: true but rule strict: false", () => {
      const { diagnostics } = compileWithDiagnostics(partialConditionSrc, {
        pluginOptions: {
          strict: true,
          rules: {
            "conditional-compilation": { constants: baseConstants, strict: false },
          },
        },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90002);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    });

    it("emits Error when global strict: false but rule strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(partialConditionSrc, {
        pluginOptions: {
          strict: false,
          rules: {
            "conditional-compilation": { constants: baseConstants, strict: true },
          },
        },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90002);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });

    it("emits Error when both global strict: true and rule strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(partialConditionSrc, {
        pluginOptions: {
          strict: true,
          rules: {
            "conditional-compilation": { constants: baseConstants, strict: true },
          },
        },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90002);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });
  });
});

describe("strict mode", () => {
  it("promotes partial-folding warning to error when global strict: true", () => {
    const { diagnostics } = compileWithDiagnostics(
      `
      declare const UNKNOWN: boolean;
      if (UNKNOWN && DEBUG) {
        console.log("conditional");
      }
      `,
      {
        pluginOptions: {
          strict: true,
          rules: {
            "conditional-compilation": {
              constants: {
                DEBUG: { env: "DEBUG", default: false },
              },
            },
          },
        },
      },
    );
    // UNKNOWN is not a known constant, so the condition cannot be fully resolved
    // → partial-folding warning should be promoted to error under strict
    const strictDiag = diagnostics.filter((d) => d.code === 90002);
    expect(strictDiag.length).toBeGreaterThanOrEqual(1);
    expect(strictDiag[0].category).toBe(ts.DiagnosticCategory.Error);
  });

  it("keeps warning when per-rule conditional-compilation.strict: false overrides global", () => {
    const { diagnostics } = compileWithDiagnostics(
      `
      declare const UNKNOWN: boolean;
      if (UNKNOWN && DEBUG) {
        console.log("conditional");
      }
      `,
      {
        pluginOptions: {
          strict: true,
          rules: {
            "conditional-compilation": {
              constants: {
                DEBUG: { env: "DEBUG", default: false },
              },
              strict: false,
            },
          },
        },
      },
    );
    const ccDiag = diagnostics.filter((d) => d.code === 90002);
    expect(ccDiag.length).toBeGreaterThanOrEqual(1);
    expect(ccDiag[0].category).toBe(ts.DiagnosticCategory.Warning);
  });
});
