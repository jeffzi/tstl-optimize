import { describe, expect, it } from "vitest";
import {
  isRecord,
  parseConfig,
  resolveConditionalCompilationStrict,
  resolveDebugStripConfig,
  resolveEffectiveStrict,
  resolveLocalizerConfig,
} from "../src/config";

describe("config coverage", () => {
  it("Line 89: resolveDebugStripConfig(false)", () => {
    expect(resolveDebugStripConfig(false)).toBe(false);
  });

  it("Line 97: resolveLocalizerConfig(false)", () => {
    expect(resolveLocalizerConfig(false)).toBe(false);
  });

  it("Line 148: resolveConditionalCompilationStrict with non-objects", () => {
    expect(resolveConditionalCompilationStrict(undefined)).toBeUndefined();
    expect(resolveConditionalCompilationStrict(true)).toBeUndefined();
    expect(resolveConditionalCompilationStrict(false)).toBeUndefined();
  });

  it("Line 160: resolveEffectiveStrict(true, false) returns false", () => {
    expect(resolveEffectiveStrict(true, false)).toBe(false);
    expect(resolveEffectiveStrict(true, undefined)).toBe(true);
    expect(resolveEffectiveStrict(false, true)).toBe(true);
  });

  it("isRecord with array/null", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord({})).toBe(true);
  });

  it("parseConfig with strict: true", () => {
    const config = parseConfig({ strict: true });
    expect(config.strict).toBe(true);
  });

  it("parseConfig ignores non-boolean for simple rules", () => {
    // math-intrinsics is not in STRUCTURED_RULES
    const config = parseConfig({ rules: { "math-intrinsics": "not-a-boolean" } });
    expect(config.rules["math-intrinsics"]).toBe(true); // default
  });
});
