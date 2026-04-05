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
  it("returns the boolean value directly for boolean configs", () => {
    const enabled = parseConfig({ rules: { "math-intrinsics": true } });
    expect(isRuleEnabled(enabled.rules, "math-intrinsics")).toBe(true);

    const disabled = parseConfig({ rules: { "math-intrinsics": false } });
    expect(isRuleEnabled(disabled.rules, "math-intrinsics")).toBe(false);
  });

  it("checks enabled field for object configs, defaulting to true", () => {
    const withTrue = parseConfig({ rules: { localizer: { enabled: true, threshold: 5 } } });
    expect(isRuleEnabled(withTrue.rules, "localizer")).toBe(true);

    const withFalse = parseConfig({ rules: { localizer: { enabled: false } } });
    expect(isRuleEnabled(withFalse.rules, "localizer")).toBe(false);

    const withoutField = parseConfig({ rules: { localizer: { threshold: 3 } } });
    expect(isRuleEnabled(withoutField.rules, "localizer")).toBe(true);
  });
});

describe("parseConfig rules edge cases", () => {
  it("ignores non-boolean non-object values, falling back to defaults", () => {
    const loc = parseConfig({ rules: { localizer: "invalid" } });
    expect(loc.rules.localizer).toBe(true);

    const ds = parseConfig({ rules: { "debug-strip": "invalid" } });
    expect(ds.rules["debug-strip"]).toBe(false);

    const mi = parseConfig({ rules: { "math-intrinsics": "invalid" } });
    expect(mi.rules["math-intrinsics"]).toBe(true);

    const cc = parseConfig({ rules: { "conditional-compilation": "invalid" } });
    expect(cc.rules["conditional-compilation"]).toBe(false);
  });

  it("ignores rules when not an object", () => {
    const config = parseConfig({ rules: "bad" });
    expect(config.rules["math-intrinsics"]).toBe(true);
    expect(config.rules.localizer).toBe(true);
  });

  it("accepts object config for structured rules", () => {
    const loc = parseConfig({ rules: { localizer: { threshold: 5 } } });
    expect(loc.rules.localizer).toStrictEqual({ threshold: 5 });

    const ds = parseConfig({ rules: { "debug-strip": { functions: ["myFn"] } } });
    expect(ds.rules["debug-strip"]).toStrictEqual({ functions: ["myFn"] });
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
