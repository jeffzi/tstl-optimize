// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import type { LocalizerConfig } from "../src/config";
import { isRuleEnabled, parseConfig, resolveLocalizerConfig } from "../src/config";
import pluginFactory, { OptimizePlugin } from "../src/index";
import { compile, normalizeLua } from "./helpers";

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

describe("parseConfig", () => {
  describe("when setting target", () => {
    it.each([undefined, {}] as const)("defaults target to undefined for input %o", (input) => {
      expect(parseConfig(input).target).toBeUndefined();
    });

    it.each(["puc", "luajit"] as const)("accepts '%s' as target", (target) => {
      expect(parseConfig({ target }).target).toBe(target);
    });

    it.each([
      { label: "string 'v8'", target: "v8" as const },
      { label: "number 42", target: 42 },
      { label: "boolean true", target: true },
    ])("ignores invalid target value: $label", ({ target }) => {
      expect(parseConfig({ target } as Record<string, unknown>).target).toBeUndefined();
    });
  });

  describe("when rule values are invalid", () => {
    it.each([
      { rule: "localizer" as const, expected: true },
      { rule: "debug-strip" as const, expected: false },
      { rule: "math-intrinsics" as const, expected: true },
      { rule: "conditional-compilation" as const, expected: false },
    ])("ignores invalid string value for $rule, falls back to default $expected", ({
      rule,
      expected,
    }) => {
      const config = parseConfig({ rules: { [rule]: "invalid" } });
      expect(config.rules[rule]).toBe(expected);
    });

    it("ignores rules when not an object", () => {
      const config = parseConfig({ rules: "bad" });
      expect(config.rules["math-intrinsics"]).toBe(true);
      expect(config.rules.localizer).toBe(true);
    });

    it.each([
      { label: "localizer with threshold", rule: "localizer" as const, value: { threshold: 5 } },
      {
        label: "debug-strip with functions",
        rule: "debug-strip" as const,
        value: { functions: ["myFn"] },
      },
    ])("accepts object config for $label", ({ rule, value }) => {
      const config = parseConfig({ rules: { [rule]: value } });
      expect(config.rules[rule]).toStrictEqual(value);
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

  describe("when passing include/exclude through localizer config", () => {
    it.each([
      {
        label: "include array",
        input: { include: ["go", "msg"] },
        expectedInclude: ["go", "msg"],
        expectedExclude: [],
      },
      {
        label: "exclude array",
        input: { exclude: ["math"] },
        expectedInclude: [],
        expectedExclude: ["math"],
      },
      {
        label: "localizer: true defaults",
        input: true as const,
        expectedInclude: [],
        expectedExclude: [],
      },
    ])("passes $label through localizer config", ({ input, expectedInclude, expectedExclude }) => {
      const rawConfig = parseConfig({ rules: { localizer: input } });
      const resolved = resolveLocalizerConfig(
        rawConfig.rules.localizer as boolean | LocalizerConfig,
      );
      assertLocalizerConfig(resolved);
      expect(resolved.include).toStrictEqual(expectedInclude);
      expect(resolved.exclude).toStrictEqual(expectedExclude);
    });
  });
});

describe("isRuleEnabled", () => {
  it.each([
    { label: "boolean true", config: { "math-intrinsics": true as const }, expected: true },
    { label: "boolean false", config: { "math-intrinsics": false as const }, expected: false },
  ])("returns $expected directly when config is $label", ({ config, expected }) => {
    expect(isRuleEnabled(parseConfig({ rules: config }).rules, "math-intrinsics")).toBe(expected);
  });

  it.each([
    { label: "enabled: true", rule: { enabled: true, threshold: 5 }, expected: true },
    { label: "enabled: false", rule: { enabled: false }, expected: false },
    { label: "no enabled field (defaults to true)", rule: { threshold: 3 }, expected: true },
  ])("checks enabled field for object configs: $label", ({ rule, expected }) => {
    const config = parseConfig({ rules: { localizer: rule } });
    expect(isRuleEnabled(config.rules, "localizer")).toBe(expected);
  });
});

describe("resolveLocalizerConfig", () => {
  describe("when resolving include/exclude", () => {
    it.each<{
      input: boolean | Partial<LocalizerConfig> | undefined;
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
      const config = resolveLocalizerConfig(input as boolean | LocalizerConfig | undefined);
      assertLocalizerConfig(config);
      expect(config.include).toStrictEqual(include);
      expect(config.exclude).toStrictEqual(exclude);
    });
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

describe("OptimizePlugin", () => {
  it("beforeTransform handles LuaJIT target", () => {
    const plugin = new OptimizePlugin();
    // biome-ignore lint/suspicious/noExplicitAny: mock for testing
    const mockProgram: any = { getTypeChecker: vi.fn() };
    const mockOptions: tstl.CompilerOptions = {
      luaTarget: tstl.LuaTarget.LuaJIT,
    };

    plugin.beforeTransform(mockProgram, mockOptions);

    expect(Object.keys(plugin.visitors).length).toBeGreaterThan(0);
  });

  it("beforeEmit when inline is disabled preserves @inline comments", () => {
    const plugin = new OptimizePlugin({
      rules: { inline: false },
    });
    const mockFile: tstl.EmitFile = {
      outputPath: "main.lua",
      code: "-- @inline\nprint(1)",
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock arguments for beforeEmit signature
    plugin.beforeEmit({} as any, {} as any, {} as any, [mockFile]);
    expect(mockFile.code).toContain("@inline");
  });

  it("beforeEmit strips various @inline comment styles", () => {
    const plugin = new OptimizePlugin({
      rules: { inline: true },
    });
    const mockFile: tstl.EmitFile = {
      outputPath: "main.lua",
      code: "--- @inline\n-- @inline\nprint(1)",
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock arguments for beforeEmit signature
    plugin.beforeEmit({} as any, {} as any, {} as any, [mockFile]);
    expect(mockFile.code).not.toContain("@inline");
    expect(mockFile.code).toContain("print(1)");
  });

  it("SourceFile visitor with existing visitors (merge logic)", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function foo() { return 1; }
      print(foo());
    `;
    const lua = normalizeLua(
      compile(code, {
        pluginOptions: {
          rules: {
            "conditional-compilation": true,
            inline: true,
          },
        },
      }),
    );
    expect(lua.trim().length).toBeGreaterThan(0);
  });

  it("disabling all rules leaves code untransformed", () => {
    const code = `
      function test() {
        const x = 1 + 1;
        return x;
      }
    `;
    const lua = normalizeLua(
      compile(code, {
        pluginOptions: {
          rules: {
            "conditional-compilation": false,
            "constant-folding": false,
            "remove-empty-branch": false,
            "math-intrinsics": false,
            "loop-rebase": false,
            inline: false,
            "dead-local": false,
            "merge-locals": false,
            localizer: false,
            "debug-strip": false,
          },
        },
      }),
    );
    expect(lua).toContain("local x = 1 + 1");
  });
});
