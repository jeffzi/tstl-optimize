import { describe, expect, it } from "vitest";
import { isRuleEnabled, parseConfig, resolveInlineConfig } from "../src/config";

describe("resolveInlineConfig", () => {
  it("returns disabled non-strict config when called with false", () => {
    expect(resolveInlineConfig(false)).toStrictEqual({ enabled: false, strict: false });
  });

  it("returns enabled non-strict config when called with undefined or true", () => {
    expect(resolveInlineConfig(undefined)).toStrictEqual({ enabled: true, strict: false });
    expect(resolveInlineConfig(true)).toStrictEqual({ enabled: true, strict: false });
  });

  it("returns disabled non-strict config when object has enabled: false", () => {
    expect(resolveInlineConfig({ enabled: false })).toStrictEqual({
      enabled: false,
      strict: false,
    });
  });

  it("returns enabled strict config when object has strict: true", () => {
    expect(resolveInlineConfig({ strict: true })).toStrictEqual({ enabled: true, strict: true });
  });

  it("returns disabled strict config when object has both enabled: false and strict: true", () => {
    expect(resolveInlineConfig({ enabled: false, strict: true })).toStrictEqual({
      enabled: false,
      strict: true,
    });
  });
});

describe("parseConfig inline rule", () => {
  it("preserves InlineConfig object (not coerced to boolean)", () => {
    const config = parseConfig({ rules: { inline: { strict: false } } });
    expect(config.rules.inline).toStrictEqual({ strict: false });
  });

  it("accepts inline boolean false", () => {
    const config = parseConfig({ rules: { inline: false } });
    expect(config.rules.inline).toBe(false);
  });

  it("accepts inline boolean true", () => {
    const config = parseConfig({ rules: { inline: true } });
    expect(config.rules.inline).toBe(true);
  });

  it("ignores non-boolean non-object inline value", () => {
    const config = parseConfig({ rules: { inline: "invalid" as unknown as boolean } });
    // default (true) preserved
    expect(config.rules.inline).toBe(true);
  });
});

describe("isRuleEnabled with InlineConfig", () => {
  it("returns true for InlineConfig object without enabled field", () => {
    const config = parseConfig({ rules: { inline: { strict: false } } });
    expect(isRuleEnabled(config.rules, "inline")).toBe(true);
  });

  it("returns false for InlineConfig object with enabled: false", () => {
    const config = parseConfig({ rules: { inline: { enabled: false } } });
    expect(isRuleEnabled(config.rules, "inline")).toBe(false);
  });
});

describe("parseConfig strict field", () => {
  it("returns strict: true when strict: true is provided", () => {
    expect(parseConfig({ strict: true }).strict).toBe(true);
  });

  it("returns strict: false when strict is missing, false, or a non-boolean", () => {
    expect(parseConfig({}).strict).toBe(false);
    expect(parseConfig().strict).toBe(false);
    expect(parseConfig({ strict: false }).strict).toBe(false);
    expect(parseConfig({ strict: "yes" as unknown as boolean }).strict).toBe(false);
  });
});
