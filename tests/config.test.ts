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
      const config = parseConfig({ rules: { inline: input } as Record<string, unknown> });
      expect(config.rules.inline).toStrictEqual(expected);
    });
  });

  describe("strict field", () => {
    it.each([
      { input: { strict: true }, expected: true },
      { input: {}, expected: false },
      { input: undefined, expected: false },
      { input: { strict: false }, expected: false },
      { input: { strict: "yes" }, expected: false },
    ])("returns $expected for input $input", ({ input, expected }) => {
      expect(parseConfig(input as Record<string, unknown>).strict).toBe(expected);
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
