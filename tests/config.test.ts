import { describe, expect, it } from "vitest";
import { isRuleEnabled, parseConfig, resolveInlineConfig } from "../src/config";

describe("resolveInlineConfig", () => {
  it("resolves from boolean or undefined", () => {
    expect(resolveInlineConfig(false)).toStrictEqual({ enabled: false, strict: false });
    expect(resolveInlineConfig(undefined)).toStrictEqual({ enabled: true, strict: false });
    expect(resolveInlineConfig(true)).toStrictEqual({ enabled: true, strict: false });
  });

  it("resolves from object with enabled/strict fields", () => {
    expect(resolveInlineConfig({ enabled: false })).toStrictEqual({
      enabled: false,
      strict: false,
    });
    expect(resolveInlineConfig({ strict: true })).toStrictEqual({ enabled: true, strict: true });
    expect(resolveInlineConfig({ enabled: false, strict: true })).toStrictEqual({
      enabled: false,
      strict: true,
    });
  });
});

describe("parseConfig", () => {
  describe("inline rule", () => {
    it("preserves InlineConfig object", () => {
      const config = parseConfig({ rules: { inline: { strict: false } } });
      expect(config.rules.inline).toStrictEqual({ strict: false });
    });

    it("accepts boolean values", () => {
      expect(parseConfig({ rules: { inline: false } }).rules.inline).toBe(false);
      expect(parseConfig({ rules: { inline: true } }).rules.inline).toBe(true);
    });

    it("falls back to default for invalid values", () => {
      const config = parseConfig({ rules: { inline: "invalid" as unknown as boolean } });
      expect(config.rules.inline).toBe(true);
    });
  });

  describe("strict field", () => {
    it("returns true only when explicitly provided", () => {
      expect(parseConfig({ strict: true }).strict).toBe(true);
      expect(parseConfig({}).strict).toBe(false);
      expect(parseConfig().strict).toBe(false);
      expect(parseConfig({ strict: false }).strict).toBe(false);
      expect(parseConfig({ strict: "yes" as unknown as boolean }).strict).toBe(false);
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
