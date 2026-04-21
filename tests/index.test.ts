import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { LuaLibImportKind, LuaTarget, transpileVirtualProject } from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import type { DebugStripConfig, LocalizerConfig } from "../src/config";
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
  it("does not route statement fallback back through the previous SourceFile visitor", async () => {
    vi.resetModules();

    vi.doMock("../src/rules/conditional-compilation", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.SourceFile]: (
          node: ts.Node,
          context: { superTransformNode(node: ts.Node): unknown },
        ) => {
          if (!ts.isSourceFile(node)) {
            throw new Error(`expected SourceFile, got ${ts.SyntaxKind[node.kind]}`);
          }
          const result = context.superTransformNode(node);
          return Array.isArray(result) ? result[0] : result;
        },
      }),
    }));

    vi.doMock("../src/rules/constant-folding", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.SourceFile]: (
          node: ts.SourceFile,
          context: {
            superTransformStatements(node: ts.Statement): tstl.Statement[];
            usedLuaLibFeatures: Set<tstl.LuaLibFeature>;
          },
        ) => {
          const statements: tstl.Statement[] = [];
          for (const statement of node.statements) {
            statements.push(...context.superTransformStatements(statement));
          }
          return tstl.createFile(statements, context.usedLuaLibFeatures, "", node);
        },
      }),
    }));

    try {
      const { OptimizePlugin: MockedOptimizePlugin } = await import("../src/index.js");
      const plugin = new MockedOptimizePlugin({
        rules: {
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
        },
      });

      Reflect.set(plugin, "checker", {});
      const buildVisitors = Reflect.get(plugin, "buildVisitors");
      if (typeof buildVisitors !== "function") {
        throw new Error("missing buildVisitors");
      }
      Reflect.apply(buildVisitors, plugin, []);

      const sourceVisitor = plugin.visitors[ts.SyntaxKind.SourceFile];
      if (typeof sourceVisitor !== "function") {
        throw new Error("missing SourceFile visitor");
      }

      const sourceFile = ts.createSourceFile("main.ts", "const x = 1;", ts.ScriptTarget.ESNext);
      const transformedStatements: tstl.Statement[] = [];
      const context = {
        superTransformNode: () => tstl.createFile([], new Set(), "", sourceFile),
        superTransformStatements: (statement: ts.Statement) => {
          transformedStatements.push(tstl.createDoStatement([], statement));
          return transformedStatements;
        },
      };

      const result = Reflect.apply(sourceVisitor, undefined, [sourceFile, context]);

      expect(result).toMatchObject({ kind: tstl.SyntaxKind.File });
      expect(transformedStatements).toHaveLength(1);
    } finally {
      vi.doUnmock("../src/rules/conditional-compilation");
      vi.doUnmock("../src/rules/constant-folding");
      vi.resetModules();
    }
  });

  it("passes through existing SourceFile array results without re-wrapping them", async () => {
    vi.resetModules();

    vi.doMock("../src/rules/conditional-compilation", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile) => [tstl.createDoStatement([], node)],
      }),
    }));

    vi.doMock("../src/rules/constant-folding", () => ({
      createVisitors: () => ({
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
      }),
    }));

    try {
      const { OptimizePlugin: MockedOptimizePlugin } = await import("../src/index.js");
      const plugin = new MockedOptimizePlugin({
        rules: {
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
        },
      });

      Reflect.set(plugin, "checker", {});
      const buildVisitors = Reflect.get(plugin, "buildVisitors");
      if (typeof buildVisitors !== "function") {
        throw new Error("missing buildVisitors");
      }
      Reflect.apply(buildVisitors, plugin, []);

      const sourceVisitor = plugin.visitors[ts.SyntaxKind.SourceFile];
      if (typeof sourceVisitor !== "function") {
        throw new Error("missing SourceFile visitor");
      }

      const sourceFile = ts.createSourceFile("main.ts", "const x = 1;", ts.ScriptTarget.ESNext);
      const result = Reflect.apply(sourceVisitor, undefined, [
        sourceFile,
        {
          superTransformNode: () => tstl.createFile([], new Set(), "", sourceFile),
          superTransformStatements: () => [],
          usedLuaLibFeatures: new Set<tstl.LuaLibFeature>(),
        },
      ]);

      expect(result).toMatchObject({
        kind: tstl.SyntaxKind.File,
        statements: [expect.objectContaining({ kind: tstl.SyntaxKind.DoStatement })],
      });
    } finally {
      vi.doUnmock("../src/rules/conditional-compilation");
      vi.doUnmock("../src/rules/constant-folding");
      vi.resetModules();
    }
  });
});

describe("visitor metadata", () => {
  it("preserves object-form visitor metadata when building plugin visitors", async () => {
    vi.resetModules();

    vi.doMock("../src/rules/conditional-compilation", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.CallExpression]: {
          priority: 9,
          transform: () => undefined,
        },
      }),
    }));

    vi.doMock("../src/rules/constant-folding", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.CallExpression]: () => undefined,
      }),
    }));

    try {
      const { OptimizePlugin: MockedOptimizePlugin } = await import("../src/index.js");
      const plugin = new MockedOptimizePlugin({
        rules: {
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
        },
      });

      Reflect.set(plugin, "checker", {});
      const buildVisitors = Reflect.get(plugin, "buildVisitors");
      if (typeof buildVisitors !== "function") {
        throw new Error("missing buildVisitors");
      }
      Reflect.apply(buildVisitors, plugin, []);

      expect(plugin.visitors[ts.SyntaxKind.CallExpression]).toMatchObject({
        priority: 9,
      });
    } finally {
      vi.doUnmock("../src/rules/conditional-compilation");
      vi.doUnmock("../src/rules/constant-folding");
      vi.resetModules();
    }
  });

  it("preserves the higher priority when both merged visitors provide one", async () => {
    vi.resetModules();

    vi.doMock("../src/rules/conditional-compilation", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.CallExpression]: {
          priority: 3,
          transform: () => undefined,
        },
      }),
    }));

    vi.doMock("../src/rules/constant-folding", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.CallExpression]: {
          priority: 9,
          transform: () => undefined,
        },
      }),
    }));

    try {
      const { OptimizePlugin: MockedOptimizePlugin } = await import("../src/index.js");
      const plugin = new MockedOptimizePlugin({
        rules: {
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
        },
      });

      Reflect.set(plugin, "checker", {});
      const buildVisitors = Reflect.get(plugin, "buildVisitors");
      if (typeof buildVisitors !== "function") {
        throw new Error("missing buildVisitors");
      }
      Reflect.apply(buildVisitors, plugin, []);

      expect(plugin.visitors[ts.SyntaxKind.CallExpression]).toMatchObject({
        priority: 9,
      });
    } finally {
      vi.doUnmock("../src/rules/conditional-compilation");
      vi.doUnmock("../src/rules/constant-folding");
      vi.resetModules();
    }
  });

  it("skips undefined visitors returned by a rule factory", async () => {
    vi.resetModules();

    vi.doMock("../src/rules/conditional-compilation", () => ({
      createVisitors: () => ({
        [ts.SyntaxKind.CallExpression]: undefined,
      }),
    }));

    try {
      const { OptimizePlugin: MockedOptimizePlugin } = await import("../src/index.js");
      const plugin = new MockedOptimizePlugin({
        rules: {
          "conditional-compilation": true,
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
      });

      Reflect.set(plugin, "checker", {});
      const buildVisitors = Reflect.get(plugin, "buildVisitors");
      if (typeof buildVisitors !== "function") {
        throw new Error("missing buildVisitors");
      }
      Reflect.apply(buildVisitors, plugin, []);

      expect(plugin.visitors[ts.SyntaxKind.CallExpression]).toBeUndefined();
    } finally {
      vi.doUnmock("../src/rules/conditional-compilation");
      vi.resetModules();
    }
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

  it("SourceFile visitor with existing visitors (merge logic)", () => {
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
