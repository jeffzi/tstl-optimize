import fc from "fast-check";
import { describe, expect, it } from "vitest";
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
  it("returns empty map when given object without constants property", () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally passing malformed configs to test defensive handling
    expect(resolveConditionalCompilationConfig({ enabled: true } as any)).toStrictEqual(new Map());
    // biome-ignore lint/suspicious/noExplicitAny: intentionally passing malformed configs to test defensive handling
    expect(resolveConditionalCompilationConfig({ DEBUG: true } as any)).toStrictEqual(new Map());
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
  describe("inline rule", () => {
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

  describe("strict field", () => {
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

const EXPECTED_RULE_KEYS = [
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

describe("property-based", () => {
  it("parseConfig never throws for arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        parseConfig(input as Record<string, unknown>);
      }),
    );
  });

  it("parseConfig always returns all rule keys", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const config = parseConfig(input as Record<string, unknown>);

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

        for (const [key, value] of Object.entries(ruleBooleans)) {
          expect(isRuleEnabled(config.rules, key as keyof typeof config.rules)).toBe(value);
        }
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
});

describe("resolveLocalizerConfig", () => {
  it("returns disabled config when given false", () => {
    expect(resolveLocalizerConfig(false)).toBe(false);
  });
});

describe("resolveConditionalCompilationStrict", () => {
  it("returns false for non-object inputs", () => {
    expect(resolveConditionalCompilationStrict(undefined)).toBeUndefined();
    expect(resolveConditionalCompilationStrict(true)).toBeUndefined();
  });
});

describe("resolveEffectiveStrict", () => {
  it("rule-level override takes precedence", () => {
    expect(resolveEffectiveStrict(true, false)).toBe(false);
    expect(resolveEffectiveStrict(true, undefined)).toBe(true);
    expect(resolveEffectiveStrict(false, true)).toBe(true);
  });
});

describe("isRecord", () => {
  it("returns false for array and null, true for plain object", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord({})).toBe(true);
  });
});
