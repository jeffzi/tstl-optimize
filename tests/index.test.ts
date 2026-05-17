import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { LuaLibImportKind, LuaTarget, transpileVirtualProject } from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import type { DebugStripConfig, LocalizerConfig } from "../src/config";
import { isRuleEnabled, parseConfig, resolveLocalizerConfig } from "../src/config";
import pluginFactory, { OptimizePlugin } from "../src/index";
import { getTransformedFile } from "../src/rules/source-file";
import { compile, normalizeLua } from "./helpers";

function assertLocalizerConfig(config: LocalizerConfig | false): asserts config is LocalizerConfig {
  expect(config).not.toBe(false);
}

interface MockedIndexModule {
  OptimizePlugin: typeof OptimizePlugin;
}

type RuleVisitorFactory = () => Record<number, unknown>;

interface MockedRuleVisitors {
  conditionalCompilation?: RuleVisitorFactory;
  constantFolding?: RuleVisitorFactory;
}

const VISITOR_MERGE_RULES = {
  "conditional-compilation": true,
  "constant-folding": true,
  "remove-empty-branch": false,
  "math-intrinsics": false,
  "loop-rebase": false,
  inline: false,
  "dead-local": false,
  "merge-locals": false,
  localizer: false,
  "debug-strip": false,
};

const ONLY_CONDITIONAL_COMPILATION_RULES = {
  ...VISITOR_MERGE_RULES,
  "constant-folding": false,
};

async function withMockedRuleVisitors<T>(
  mocks: MockedRuleVisitors,
  run: (indexModule: MockedIndexModule) => Promise<T> | T,
): Promise<T> {
  vi.resetModules();

  if (mocks.conditionalCompilation) {
    vi.doMock("../src/rules/conditional-compilation", () => ({
      createVisitors: mocks.conditionalCompilation,
    }));
  }
  if (mocks.constantFolding) {
    vi.doMock("../src/rules/constant-folding", () => ({
      createVisitors: mocks.constantFolding,
    }));
  }

  try {
    return await run(await import("../src/index.js"));
  } finally {
    vi.doUnmock("../src/rules/conditional-compilation");
    vi.doUnmock("../src/rules/constant-folding");
    vi.resetModules();
  }
}

function transpileWithPlugin(plugin: tstl.Plugin, source = "const x = 1;"): string {
  const result = transpileVirtualProject(
    { "main.ts": source },
    {
      noHeader: true,
      luaPlugins: [{ plugin }],
      noImplicitSelf: true,
      luaTarget: LuaTarget.Lua51,
      luaLibImport: LuaLibImportKind.None,
      target: ts.ScriptTarget.ESNext,
      lib: ["lib.esnext.d.ts"],
      types: ["@typescript-to-lua/language-extensions"],
    },
  );
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(errors.map((diagnostic) => String(diagnostic.messageText)).join("\n"));
  }
  const file = result.transpiledFiles.find((entry) => entry.outPath.endsWith("main.lua"));
  if (file?.lua === undefined) {
    throw new Error("No Lua output.");
  }
  return normalizeLua(file.lua);
}

describe("default export", () => {
  it("is a factory function so TSTL passes plugin options from tsconfig", () => {
    // TSTL checks `typeof factory === "function"` to decide whether to call
    // factory(pluginOption). A pre-instantiated object bypasses options entirely.
    expect(typeof pluginFactory).toBe("function");
  });

  it("constructs an OptimizePlugin instance", () => {
    expect(pluginFactory({ target: "puc" })).toBeInstanceOf(OptimizePlugin);
  });
});

describe("plugin infrastructure", () => {
  it.each<{ label: string; options: Parameters<typeof compile>[1] }>([
    { label: "default config", options: undefined },
    { label: "empty config", options: {} },
  ])("produces Lua output with $label", ({ options }) => {
    expect(compile("const x = 1;", options)).toContain("x = 1");
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
    it.each<{ label: string; input: Record<string, never> | undefined }>([
      { label: "no config", input: undefined },
      { label: "empty config", input: {} },
    ])("defaults target to undefined for $label", ({ input }) => {
      expect(parseConfig(input).target).toBeUndefined();
    });

    it.each<"puc" | "luajit">(["puc", "luajit"])("accepts '%s' as target", (target) => {
      expect(parseConfig({ target }).target).toBe(target);
    });

    it.each<{ label: string; target: unknown }>([
      { label: "string 'v8'", target: "v8" },
      { label: "number 42", target: 42 },
      { label: "boolean true", target: true },
    ])("ignores invalid target value: $label", ({ target }) => {
      expect(parseConfig({ target }).target).toBeUndefined();
    });
  });

  describe("when rule values are invalid", () => {
    it.each<{
      rule: "localizer" | "debug-strip" | "math-intrinsics" | "conditional-compilation";
      expected: boolean;
    }>([
      { rule: "localizer", expected: true },
      { rule: "debug-strip", expected: false },
      { rule: "math-intrinsics", expected: true },
      { rule: "conditional-compilation", expected: false },
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

    it.each<
      | { label: string; rule: "localizer"; value: Partial<LocalizerConfig> }
      | { label: string; rule: "debug-strip"; value: Partial<DebugStripConfig> }
    >([
      { label: "localizer with threshold", rule: "localizer", value: { threshold: 5 } },
      {
        label: "debug-strip with functions",
        rule: "debug-strip",
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
    it.each<{
      label: string;
      input: boolean | Partial<LocalizerConfig>;
      expectedInclude: string[];
      expectedExclude: string[];
    }>([
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
        input: true,
        expectedInclude: [],
        expectedExclude: [],
      },
    ])("passes $label through localizer config", ({ input, expectedInclude, expectedExclude }) => {
      const rawConfig = parseConfig({ rules: { localizer: input } });
      const resolved = resolveLocalizerConfig(rawConfig.rules.localizer);
      assertLocalizerConfig(resolved);
      expect(resolved.include).toStrictEqual(expectedInclude);
      expect(resolved.exclude).toStrictEqual(expectedExclude);
    });
  });
});

describe("isRuleEnabled", () => {
  it.each([
    { label: "boolean true", config: { "math-intrinsics": true }, expected: true },
    { label: "boolean false", config: { "math-intrinsics": false }, expected: false },
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
      const config = resolveLocalizerConfig(input);
      assertLocalizerConfig(config);
      expect(config.include).toStrictEqual(include);
      expect(config.exclude).toStrictEqual(exclude);
    });
  });
});

describe("target auto-detection", () => {
  const SRC = "declare const x: number; const a = Math.floor(x);";

  it("auto-detects puc for Lua51 target and applies math-intrinsics", () => {
    const lua = compile(SRC, { luaTarget: LuaTarget.Lua51 });
    expect(lua).toContain("% 1");
    expect(lua).toContain("math.floor");
  });

  it("auto-detects luajit and skips floor transform", () => {
    const lua = compile(SRC, { luaTarget: LuaTarget.LuaJIT });
    expect(lua).toContain("math.floor");
  });

  it("explicit target overrides auto-detection", () => {
    // LuaJIT target but explicit puc override → should inline
    const lua = compile(SRC, {
      pluginOptions: { target: "puc" },
      luaTarget: LuaTarget.LuaJIT,
    });
    expect(lua).toContain("% 1");
    expect(lua).toContain("math.floor");
  });

  it("recomputes the inferred target when the same plugin instance is reused", () => {
    const plugin = new OptimizePlugin();
    const transpileWith = (luaTarget: LuaTarget): string => {
      const result = transpileVirtualProject(
        { "main.ts": SRC },
        {
          noHeader: true,
          luaPlugins: [{ plugin }],
          noImplicitSelf: true,
          luaTarget,
          luaLibImport: LuaLibImportKind.None,
          target: ts.ScriptTarget.ESNext,
          lib: ["lib.esnext.d.ts"],
          types: ["@typescript-to-lua/language-extensions"],
        },
      );
      const file = result.transpiledFiles.find((entry) => entry.outPath.endsWith("main.lua"));
      if (file?.lua === undefined) {
        throw new Error("No Lua output.");
      }
      return file.lua;
    };

    expect(transpileWith(LuaTarget.LuaJIT)).toContain("math.floor");
    expect(transpileWith(LuaTarget.Lua51)).toContain("% 1");
  });
});

describe("SourceFile visitor fallback", () => {
  it("emits statements when multiple SourceFile rules are enabled", () => {
    const lua = normalizeLua(
      compile("const x = 1; const y = x + 1;", {
        pluginOptions: { rules: VISITOR_MERGE_RULES },
      }),
    );

    expect(lua).toContain("x = 1");
    expect(lua).toContain("y = x + 1");
  });

  it("passes through existing SourceFile statement array results", async () => {
    await withMockedRuleVisitors(
      {
        conditionalCompilation: () => ({
          [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile) => [tstl.createDoStatement([], node)],
        }),
        constantFolding: (() => {
          let registered = false;
          return () => {
            if (registered) return {};
            registered = true;
            return {
              [ts.SyntaxKind.SourceFile]: (
                node: ts.SourceFile,
                context: {
                  superTransformNode(node: ts.Node): unknown;
                  usedLuaLibFeatures: Set<tstl.LuaLibFeature>;
                },
              ) => {
                const statements = context.superTransformNode(node);
                if (!Array.isArray(statements)) {
                  throw new Error("expected statement array");
                }
                return tstl.createFile(statements, context.usedLuaLibFeatures, "", node);
              },
            };
          };
        })(),
      },
      ({ OptimizePlugin: MockedOptimizePlugin }) => {
        const plugin = new MockedOptimizePlugin({ rules: VISITOR_MERGE_RULES });
        const lua = transpileWithPlugin(plugin);

        expect(lua).toContain("do\nend");
      },
    );
  });

  it("wraps upstream SourceFile statement arrays for downstream rules", async () => {
    await withMockedRuleVisitors(
      {
        conditionalCompilation: () => ({
          [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile) => [tstl.createDoStatement([], node)],
        }),
      },
      ({ OptimizePlugin: MockedOptimizePlugin }) => {
        const plugin = new MockedOptimizePlugin({ rules: VISITOR_MERGE_RULES });
        const lua = transpileWithPlugin(plugin);

        expect(lua).toContain("do\nend");
      },
    );
  });
});

describe("getTransformedFile", () => {
  it("returns a direct Lua file result unchanged", () => {
    const file = tstl.createFile([], new Set<tstl.LuaLibFeature>(), "");

    expect(getTransformedFile(file)).toBe(file);
  });

  it("unwraps a single-file array result", () => {
    const file = tstl.createFile([], new Set<tstl.LuaLibFeature>(), "");

    expect(getTransformedFile([file])).toBe(file);
  });

  it("wraps statement array results in a synthetic Lua file", () => {
    const statement = tstl.createDoStatement([]);
    const file = getTransformedFile([statement]);

    expect(tstl.isFile(file)).toBe(true);
    expect(file.statements).toStrictEqual([statement]);
  });

  it("throws for non-file SourceFile transform results", () => {
    expect(() => getTransformedFile([tstl.createNilLiteral()])).toThrow(
      "expected SourceFile transform to produce a Lua file",
    );
  });
});

describe("plugin visitor registration", () => {
  it("runs object-form visitor transforms after building plugin visitors", async () => {
    await withMockedRuleVisitors(
      {
        conditionalCompilation: () => ({
          [ts.SyntaxKind.CallExpression]: {
            priority: 9,
            transform: () => tstl.createNumericLiteral(9),
          },
        }),
        constantFolding: () => ({
          [ts.SyntaxKind.CallExpression]: () => undefined,
        }),
      },
      ({ OptimizePlugin: MockedOptimizePlugin }) => {
        const plugin = new MockedOptimizePlugin({ rules: VISITOR_MERGE_RULES });
        const lua = transpileWithPlugin(
          plugin,
          "declare function marker(): number; const result = marker();",
        );

        expect(lua).toContain("result = 9");
      },
    );
  });

  it("exposes the higher priority when merged visitors both provide one", async () => {
    await withMockedRuleVisitors(
      {
        conditionalCompilation: () => ({
          [ts.SyntaxKind.CallExpression]: {
            priority: 3,
            transform: () => undefined,
          },
        }),
        constantFolding: () => ({
          [ts.SyntaxKind.CallExpression]: {
            priority: 9,
            transform: () => undefined,
          },
        }),
      },
      ({ OptimizePlugin: MockedOptimizePlugin }) => {
        const plugin = new MockedOptimizePlugin({ rules: VISITOR_MERGE_RULES });
        transpileWithPlugin(plugin, "declare function marker(): number; const result = marker();");

        expect(plugin.visitors[ts.SyntaxKind.CallExpression]).toMatchObject({ priority: 9 });
      },
    );
  });

  it("leaves calls to TSTL when a rule factory returns an undefined visitor", async () => {
    await withMockedRuleVisitors(
      {
        conditionalCompilation: () => ({
          [ts.SyntaxKind.CallExpression]: undefined,
        }),
      },
      ({ OptimizePlugin: MockedOptimizePlugin }) => {
        const plugin = new MockedOptimizePlugin({
          rules: ONLY_CONDITIONAL_COMPILATION_RULES,
        });
        const lua = transpileWithPlugin(
          plugin,
          "declare function marker(): number; const result = marker();",
        );

        expect(lua).toContain("marker()");
      },
    );
  });
});

describe("plugin integration", () => {
  it("preserves inline pragma comments when inline is disabled", () => {
    const lua = compile(
      `
        /** @inline */
        function sum(...values: number[]) {
          return values.length;
        }

        sum(1, 2, 3);
      `,
      { pluginOptions: { rules: { inline: false } } },
    );

    expect(lua).toContain("@inline");
    expect(lua).toContain("sum");
  });

  it("strips inline pragma comments when inline is enabled", () => {
    const lua = compile(
      `
        /** @inline */
        function sum(...values: number[]) {
          return values.length;
        }

        sum(1, 2, 3);
      `,
      { pluginOptions: { rules: { inline: true } } },
    );

    expect(lua).not.toContain("@inline");
    expect(lua).toContain("sum");
  });

  it("inlines calls when SourceFile rules are enabled together", () => {
    const code = `
      declare function print(...args: unknown[]): void;
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
    expect(lua).toContain("print(1)");
    expect(lua).not.toContain("foo()");
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
