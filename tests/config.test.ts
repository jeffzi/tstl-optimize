import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConditionalCompilationConfig, LocalizerConfig, RulesConfig } from "../src/config";
import {
  isRecord,
  isRuleEnabled,
  parseConfig,
  resolveConditionalCompilationConfig,
  resolveConditionalCompilationStrict,
  resolveDebugStripConfig,
  resolveEffectiveStrict,
  resolveInlineConfig,
  resolveLocalizerConfig,
} from "../src/config";

describe("resolveConditionalCompilationConfig", () => {
  it("returns empty map when constants is empty", () => {
    const config: ConditionalCompilationConfig = { enabled: true, constants: {} };
    expect(resolveConditionalCompilationConfig(config)).toStrictEqual(new Map());
  });

  it("ignores malformed constant definitions", () => {
    const result = Reflect.apply(resolveConditionalCompilationConfig, undefined, [
      {
        enabled: true,
        constants: {
          GOOD: { env: "TEST_CC_VALID", default: false },
          BAD_ENV: { env: 42, default: true },
          BAD_DEFAULT: { env: "TEST_CC_INVALID_DEFAULT", default: { nested: true } },
          MISSING_ENV: { default: true },
        },
      },
    ]);

    expect(result).toStrictEqual(new Map([["GOOD", false]]));
  });

  it("ignores non-record constants at resolution time", () => {
    const result = Reflect.apply(resolveConditionalCompilationConfig, undefined, [
      {
        enabled: true,
        constants: "DEBUG",
      },
    ]);

    expect(result).toStrictEqual(new Map());
  });
});

describe("resolveInlineConfig", () => {
  it.each([
    { input: false, expected: { enabled: false, strict: false } },
    { input: undefined, expected: { enabled: true, strict: false } },
    { input: true, expected: { enabled: true, strict: false } },
    { input: { enabled: false }, expected: { enabled: false, strict: false } },
    { input: { strict: true }, expected: { enabled: true, strict: true } },
    { input: { enabled: false, strict: true }, expected: { enabled: false, strict: true } },
  ])("resolves $input to $expected", ({ input, expected }) => {
    expect(resolveInlineConfig(input)).toStrictEqual(expected);
  });
});

describe("parseConfig", () => {
  describe("when parsing inline rule config", () => {
    it.each([
      { input: { strict: false }, expected: { strict: false } },
      { input: false, expected: false },
      { input: true, expected: true },
      { input: "invalid", expected: true },
    ])("parses inline: $input as $expected", ({ input, expected }) => {
      const config = parseConfig({ rules: { inline: input } });
      expect(config.rules.inline).toStrictEqual(expected);
    });
  });

  describe("when parsing conditional-compilation rule config", () => {
    it("preserves enabled and strict flags even without a constants object", () => {
      const config = parseConfig({
        rules: {
          "conditional-compilation": {
            enabled: false,
            strict: true,
          },
        },
      });

      expect(config.rules["conditional-compilation"]).toStrictEqual({
        enabled: false,
        strict: true,
        constants: {},
      });
    });
  });

  describe("when parsing strict field", () => {
    it.each<{ input: Record<string, unknown> | undefined; expected: boolean }>([
      { input: { strict: true }, expected: true },
      { input: {}, expected: false },
      { input: undefined, expected: false },
      { input: { strict: false }, expected: false },
      { input: { strict: "yes" }, expected: false },
    ])("returns $expected for input $input", ({ input, expected }) => {
      expect(parseConfig(input).strict).toBe(expected);
    });
  });
});

describe("isRuleEnabled", () => {
  it.each([
    { config: { rules: { inline: { strict: false } } }, expected: true },
    { config: { rules: { inline: { enabled: false } } }, expected: false },
  ])("isRuleEnabled returns $expected for $config", ({ config, expected }) => {
    const parsed = parseConfig(config);
    expect(isRuleEnabled(parsed.rules, "inline")).toBe(expected);
  });
});

const EXPECTED_RULE_KEYS: ReadonlyArray<keyof RulesConfig> = [
  "conditional-compilation",
  "constant-folding",
  "dead-local",
  "debug-strip",
  "inline",
  "localizer",
  "loop-rebase",
  "math-intrinsics",
  "merge-locals",
  "remove-empty-branch",
];

function collectRuleEnabledStates(
  rules: ReturnType<typeof parseConfig>["rules"],
): ReadonlyArray<readonly [keyof RulesConfig, boolean]> {
  return EXPECTED_RULE_KEYS.map((key) => [key, isRuleEnabled(rules, key)] as const);
}

describe("property-based", () => {
  it("parseConfig never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (input) => {
        parseConfig(input);
      }),
    );
  });

  it("parseConfig always returns all rule keys", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (input) => {
        const config = parseConfig(input);

        expect(Object.keys(config.rules).sort()).toStrictEqual(EXPECTED_RULE_KEYS);
      }),
    );
  });

  it("boolean shorthand produces correct enabled state", () => {
    const arbRuleBooleans = fc.record(
      Object.fromEntries(EXPECTED_RULE_KEYS.map((key) => [key, fc.boolean()])),
    );

    fc.assert(
      fc.property(arbRuleBooleans, (ruleBooleans) => {
        const config = parseConfig({ rules: ruleBooleans });
        expect(collectRuleEnabledStates(config.rules)).toStrictEqual(
          EXPECTED_RULE_KEYS.map((key) => [key, ruleBooleans[key]] as const),
        );
      }),
    );
  });

  it("parseConfig({}) matches defaults from parseConfig()", () => {
    const fromNoArgs = parseConfig();
    const fromEmpty = parseConfig({});

    expect(fromEmpty.rules).toStrictEqual(fromNoArgs.rules);
  });

  it("ignores non-boolean for simple rules", () => {
    // "math-intrinsics" is not in STRUCTURED_RULES so falls back to boolean coercion
    const config = parseConfig({
      rules: {
        "math-intrinsics": "not-a-boolean",
      },
    });

    expect(config.rules["math-intrinsics"]).toBe(true);
  });
});

describe("resolveDebugStripConfig", () => {
  it("returns false when given false", () => {
    expect(resolveDebugStripConfig(false)).toBe(false);
  });

  it("falls back to default arrays when direct input contains non-array fields", () => {
    const result = Reflect.apply(resolveDebugStripConfig, undefined, [
      {
        enabled: true,
        functions: "print",
        namespaces: 0,
      },
    ]);

    expect(result).toStrictEqual({
      enabled: true,
      functions: ["print", "assert"],
      namespaces: ["debug"],
    });
  });

  it("filters invalid structured fields before applying defaults", () => {
    const parsed = parseConfig({
      rules: {
        "debug-strip": {
          enabled: false,
          functions: ["print", 123],
          namespaces: [{ nested: true }, "debug"],
        },
      },
    });

    expect(resolveDebugStripConfig(parsed.rules["debug-strip"])).toStrictEqual({
      enabled: false,
      functions: ["print"],
      namespaces: ["debug"],
    });
  });
});

describe("resolveLocalizerConfig", () => {
  it("returns disabled config when given false", () => {
    expect(resolveLocalizerConfig(false)).toBe(false);
  });

  it("falls back to default arrays when direct input contains non-array fields", () => {
    const result = Reflect.apply(resolveLocalizerConfig, undefined, [
      {
        enabled: true,
        include: "math",
        exclude: null,
      },
    ]);

    expect(result).toStrictEqual({
      enabled: true,
      threshold: 2,
      scope: "all",
      include: [],
      exclude: [],
    });
  });

  it("falls back to defaults when partial config contains undefined fields", () => {
    const input: Partial<LocalizerConfig> = {};
    Object.assign(input, {
      enabled: undefined,
      threshold: undefined,
      scope: undefined,
      include: undefined,
      exclude: undefined,
    });

    expect(resolveLocalizerConfig(input)).toStrictEqual({
      enabled: true,
      threshold: 2,
      scope: "all",
      include: [],
      exclude: [],
    });
  });

  it("filters invalid structured fields before applying defaults", () => {
    const parsed = parseConfig({
      rules: {
        localizer: {
          enabled: "yes",
          threshold: "high",
          scope: "global",
          include: ["math", 1],
          exclude: [{ nested: true }, "debug"],
        },
      },
    });

    expect(resolveLocalizerConfig(parsed.rules.localizer)).toStrictEqual({
      enabled: true,
      threshold: 2,
      scope: "all",
      include: ["math"],
      exclude: ["debug"],
    });
  });
});

describe("resolveConditionalCompilationStrict", () => {
  it.each([undefined, true])("returns undefined for non-object input %p", (input) => {
    expect(resolveConditionalCompilationStrict(input)).toBeUndefined();
  });
});

describe("resolveEffectiveStrict", () => {
  it.each([
    { topLevelStrict: true, ruleStrict: false, expected: false },
    { topLevelStrict: true, ruleStrict: undefined, expected: true },
    { topLevelStrict: false, ruleStrict: true, expected: true },
  ])("returns $expected when top-level strict is $topLevelStrict and rule strict is $ruleStrict", ({
    topLevelStrict,
    ruleStrict,
    expected,
  }) => {
    expect(resolveEffectiveStrict(topLevelStrict, ruleStrict)).toBe(expected);
  });
});

describe("isRecord", () => {
  it.each([
    { input: [], expected: false },
    { input: null, expected: false },
    { input: {}, expected: true },
  ])("returns $expected for %p", ({ input, expected }) => {
    expect(isRecord(input)).toBe(expected);
  });
});
