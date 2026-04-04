import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isRuleEnabled, parseConfig, resolveInlineConfig } from "../src/config";

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
  it("returns true for InlineConfig object without enabled: false", () => {
    const config = parseConfig({ rules: { inline: { strict: false } } });
    expect(isRuleEnabled(config.rules, "inline")).toBe(true);
  });

  it("returns false for InlineConfig object with enabled: false", () => {
    const config = parseConfig({ rules: { inline: { enabled: false } } });
    expect(isRuleEnabled(config.rules, "inline")).toBe(false);
  });
});

const EXPECTED_RULE_KEYS = [
  "conditional-compilation",
  "constant-folding",
  "math-intrinsics",
  "loop-rebase",
  "inline",
  "dead-local",
  "localizer",
  "debug-strip",
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

        expect(Object.keys(config.rules).sort()).toStrictEqual(EXPECTED_RULE_KEYS.sort());
      }),
    );
  });

  it("boolean shorthand produces correct enabled state", () => {
    const arbRuleBooleans = fc.record({
      "conditional-compilation": fc.boolean(),
      "constant-folding": fc.boolean(),
      "math-intrinsics": fc.boolean(),
      "loop-rebase": fc.boolean(),
      inline: fc.boolean(),
      "dead-local": fc.boolean(),
      localizer: fc.boolean(),
      "debug-strip": fc.boolean(),
    });

    fc.assert(
      fc.property(arbRuleBooleans, (ruleBooleans) => {
        const config = parseConfig({ rules: ruleBooleans });

        for (const [key, value] of Object.entries(ruleBooleans)) {
          expect(isRuleEnabled(config.rules, key as keyof typeof config.rules)).toBe(value);
        }
      }),
    );
  });

  it("resolveInlineConfig always returns correct shape", () => {
    const arbInlineInput = fc.oneof(
      fc.boolean(),
      fc.record({ enabled: fc.boolean(), strict: fc.boolean() }),
      fc.constant(undefined),
    );

    fc.assert(
      fc.property(arbInlineInput, (input) => {
        const result = resolveInlineConfig(input);

        expect(typeof result.enabled).toBe("boolean");
        expect(typeof result.strict).toBe("boolean");
      }),
    );
  });

  it("parseConfig({}) matches defaults from parseConfig()", () => {
    const fromNoArgs = parseConfig();
    const fromEmpty = parseConfig({});
    const fromUndefined = parseConfig(undefined);

    expect(fromEmpty.rules).toStrictEqual(fromNoArgs.rules);
    expect(fromUndefined.rules).toStrictEqual(fromNoArgs.rules);
  });
});
