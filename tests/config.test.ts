import { describe, expect, it } from "vitest";
import { isRuleEnabled, parseConfig, resolveInlineConfig } from "../src/config";

describe("resolveInlineConfig", () => {
  it("resolveInlineConfig(false) returns { enabled: false, strict: false }", () => {
    expect(resolveInlineConfig(false)).toStrictEqual({ enabled: false, strict: false });
  });

  it("resolveInlineConfig(undefined) returns { enabled: true, strict: false }", () => {
    expect(resolveInlineConfig(undefined)).toStrictEqual({ enabled: true, strict: false });
  });

  it("resolveInlineConfig(true) returns { enabled: true, strict: false }", () => {
    expect(resolveInlineConfig(true)).toStrictEqual({ enabled: true, strict: false });
  });

  it("resolveInlineConfig({ enabled: false }) returns { enabled: false, strict: false }", () => {
    expect(resolveInlineConfig({ enabled: false })).toStrictEqual({
      enabled: false,
      strict: false,
    });
  });

  it("resolveInlineConfig({ strict: true }) returns { enabled: true, strict: true }", () => {
    expect(resolveInlineConfig({ strict: true })).toStrictEqual({ enabled: true, strict: true });
  });

  it("resolveInlineConfig({ enabled: false, strict: true }) returns { enabled: false, strict: true }", () => {
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
  it("parseConfig({ strict: true }).strict === true", () => {
    expect(parseConfig({ strict: true }).strict).toBe(true);
  });

  it("parseConfig({}).strict === false", () => {
    expect(parseConfig({}).strict).toBe(false);
  });

  it("parseConfig() (no arg).strict === false", () => {
    expect(parseConfig().strict).toBe(false);
  });

  it("parseConfig({ strict: 'yes' }).strict === false (non-boolean coerced to false)", () => {
    expect(parseConfig({ strict: "yes" as unknown as boolean }).strict).toBe(false);
  });

  it("parseConfig({ strict: false }).strict === false", () => {
    expect(parseConfig({ strict: false }).strict).toBe(false);
  });
});
