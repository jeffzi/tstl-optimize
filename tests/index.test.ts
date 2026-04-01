// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import type { LocalizerConfig } from "../src/config";
import { isRuleEnabled, parseConfig, resolveLocalizerConfig } from "../src/config";
import pluginFactory from "../src/index";
import { compile } from "./helpers";

function assertLocalizerConfig(config: LocalizerConfig | false): asserts config is LocalizerConfig {
  expect(config).not.toBe(false);
}

describe("default export", () => {
  it("is a factory function so TSTL passes plugin options from tsconfig", () => {
    // TSTL checks `typeof factory === "function"` to decide whether to call
    // factory(pluginOption). A pre-instantiated object bypasses options entirely.
    expect(typeof pluginFactory).toBe("function");
  });
});

describe("plugin infrastructure", () => {
  it("produces Lua output with default or empty config", () => {
    expect(compile("const x = 1;")).toContain("x = 1");
    expect(compile("const x = 1;", {})).toContain("x = 1");
  });

  it("accepts rules config with disabled rule", () => {
    const lua = compile("const x = 1;", {
      pluginOptions: { rules: { "math-intrinsics": false } },
    });
    expect(lua).toContain("x = 1");
  });
});

describe("parseConfig target", () => {
  it("defaults target to undefined when not specified", () => {
    expect(parseConfig().target).toBeUndefined();
    expect(parseConfig({}).target).toBeUndefined();
  });

  it.each(["puc", "luajit"] as const)("accepts '%s' as target", (target) => {
    expect(parseConfig({ target }).target).toBe(target);
  });

  it("ignores invalid target values", () => {
    expect(parseConfig({ target: "v8" }).target).toBeUndefined();
    expect(parseConfig({ target: 42 }).target).toBeUndefined();
    expect(parseConfig({ target: true }).target).toBeUndefined();
  });
});

describe("isRuleEnabled", () => {
  it("returns true for boolean true", () => {
    const config = parseConfig({ rules: { "math-intrinsics": true } });
    expect(isRuleEnabled(config.rules, "math-intrinsics")).toBe(true);
  });

  it("returns false for boolean false", () => {
    const config = parseConfig({ rules: { "math-intrinsics": false } });
    expect(isRuleEnabled(config.rules, "math-intrinsics")).toBe(false);
  });

  it("returns true for object config with enabled: true", () => {
    const config = parseConfig({ rules: { localizer: { enabled: true, threshold: 5 } } });
    expect(isRuleEnabled(config.rules, "localizer")).toBe(true);
  });

  it("returns false for object config with enabled: false", () => {
    const config = parseConfig({ rules: { localizer: { enabled: false } } });
    expect(isRuleEnabled(config.rules, "localizer")).toBe(false);
  });

  it("returns true for object config without enabled field", () => {
    const config = parseConfig({ rules: { localizer: { threshold: 3 } } });
    expect(isRuleEnabled(config.rules, "localizer")).toBe(true);
  });
});

describe("parseConfig rules edge cases", () => {
  it("ignores non-boolean non-object localizer value", () => {
    const config = parseConfig({ rules: { localizer: "invalid" } });
    // Invalid value ignored — default (true) preserved
    expect(config.rules.localizer).toBe(true);
  });

  it("ignores non-boolean non-object debug-strip value", () => {
    const config = parseConfig({ rules: { "debug-strip": "invalid" } });
    expect(config.rules["debug-strip"]).toBe(false);
  });

  it("ignores non-boolean value for simple boolean rules", () => {
    const config = parseConfig({ rules: { "math-intrinsics": "invalid" } });
    expect(config.rules["math-intrinsics"]).toBe(true);
  });

  it("ignores rules when not an object", () => {
    const config = parseConfig({ rules: "bad" });
    expect(config.rules["math-intrinsics"]).toBe(true);
    expect(config.rules.localizer).toBe(true);
  });

  it("accepts localizer object config", () => {
    const config = parseConfig({ rules: { localizer: { threshold: 5 } } });
    expect(config.rules.localizer).toStrictEqual({ threshold: 5 });
  });

  it("accepts debug-strip object config", () => {
    const config = parseConfig({ rules: { "debug-strip": { functions: ["myFn"] } } });
    expect(config.rules["debug-strip"]).toStrictEqual({ functions: ["myFn"] });
  });

  it("defaults conditional-compilation to false", () => {
    const config = parseConfig();
    expect(config.rules["conditional-compilation"]).toBe(false);
  });

  it("accepts conditional-compilation boolean true", () => {
    const config = parseConfig({ rules: { "conditional-compilation": true } });
    expect(config.rules["conditional-compilation"]).toBe(true);
  });

  it("accepts conditional-compilation object config", () => {
    const obj = { constants: { DEBUG: { env: "DEBUG", default: false } } };
    const config = parseConfig({ rules: { "conditional-compilation": obj } });
    expect(config.rules["conditional-compilation"]).toStrictEqual(obj);
  });

  it("ignores non-boolean non-object conditional-compilation value", () => {
    const config = parseConfig({ rules: { "conditional-compilation": "invalid" } });
    expect(config.rules["conditional-compilation"]).toBe(false);
  });
});

describe("resolveLocalizerConfig include/exclude", () => {
  it.each<{
    input: boolean | LocalizerConfig | undefined;
    include: string[];
    exclude: string[];
  }>([
    { input: true, include: [], exclude: [] },
    { input: undefined, include: [], exclude: [] },
    { input: { include: ["go"] }, include: ["go"], exclude: [] },
    { input: { exclude: ["math"] }, include: [], exclude: ["math"] },
    { input: { include: ["*"], exclude: ["debug"] }, include: ["*"], exclude: ["debug"] },
  ])("resolveLocalizerConfig($input) returns include: $include, exclude: $exclude", ({
    input,
    include,
    exclude,
  }) => {
    const config = resolveLocalizerConfig(input);
    assertLocalizerConfig(config);
    expect(config.include).toStrictEqual(include);
    expect(config.exclude).toStrictEqual(exclude);
  });
});

describe("parseConfig include/exclude passthrough", () => {
  it("passes through include array from localizer config", () => {
    const rawConfig = parseConfig({ rules: { localizer: { include: ["go", "msg"] } } });
    const resolved = resolveLocalizerConfig(rawConfig.rules.localizer);
    assertLocalizerConfig(resolved);
    expect(resolved.include).toStrictEqual(["go", "msg"]);
  });

  it("passes through exclude array from localizer config", () => {
    const rawConfig = parseConfig({ rules: { localizer: { exclude: ["math"] } } });
    const resolved = resolveLocalizerConfig(rawConfig.rules.localizer);
    assertLocalizerConfig(resolved);
    expect(resolved.exclude).toStrictEqual(["math"]);
  });

  it("localizer: true resolves to include: [] and exclude: []", () => {
    const rawConfig = parseConfig({ rules: { localizer: true } });
    const resolved = resolveLocalizerConfig(rawConfig.rules.localizer);
    assertLocalizerConfig(resolved);
    expect(resolved.include).toStrictEqual([]);
    expect(resolved.exclude).toStrictEqual([]);
  });
});

describe("target auto-detection", () => {
  const SRC = "declare const x: number; const a = Math.floor(x);";

  it("auto-detects puc for Lua51 target and applies math-intrinsics", () => {
    const lua = compile(SRC, { luaTarget: tstl.LuaTarget.Lua51 });
    expect(lua).toContain("% 1");
    expect(lua).not.toContain("math.floor");
  });

  it("auto-detects luajit and skips floor transform", () => {
    const lua = compile(SRC, { luaTarget: tstl.LuaTarget.LuaJIT });
    expect(lua).toContain("math.floor");
  });

  it("explicit target overrides auto-detection", () => {
    // LuaJIT target but explicit puc override → should inline
    const lua = compile(SRC, {
      pluginOptions: { target: "puc" },
      luaTarget: tstl.LuaTarget.LuaJIT,
    });
    expect(lua).toContain("% 1");
    expect(lua).not.toContain("math.floor");
  });
});
