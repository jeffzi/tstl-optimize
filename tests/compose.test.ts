import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConstantValue,
  createScopedOptimizeVisitors,
  findOptimizerPluginEntry,
  isTruthy,
  mergeVisitorMaps,
  type OptimizeComposeOptions,
  resolveConstantFromOptions,
} from "../src/compose";
import { OptimizePlugin } from "../src/index";
import { extractTranspiledLua, normalizeLua } from "./helpers";

/** Loose visitor type matching the merge protocol (undefined = "not handled"). */
type LooseVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;

// ---------------------------------------------------------------------------
// Base transpile options that mirror helpers.ts `transpile()`.
// ---------------------------------------------------------------------------
const BASE_OPTIONS: Partial<tstl.CompilerOptions> = {
  noHeader: true,
  noImplicitSelf: true,
  luaLibImport: tstl.LuaLibImportKind.None,
  strict: true,
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.esnext.d.ts"],
  types: ["@typescript-to-lua/language-extensions"],
  luaTarget: tstl.LuaTarget.Lua51,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All files in the virtual project are owned. */
const ownAll = (_fileName: string): boolean => true;

/** Only files whose basename starts with "owned_" are owned. */
const ownByPrefix = (fileName: string): boolean => {
  const base = fileName.split("/").pop() ?? fileName;
  return base.startsWith("owned_");
};

/**
 * Transpile a virtual project using an owner plugin built with
 * `createScopedOptimizeVisitors`, plus optional extra `luaPlugins`.
 */
function transpileWithOwner(
  files: Record<string, string>,
  isOwned: (fileName: string) => boolean,
  rules?: OptimizeComposeOptions["rules"],
  extraPlugins: tstl.InMemoryLuaPlugin[] = [],
): tstl.TranspileVirtualProjectResult {
  class OwnerPlugin implements tstl.Plugin {
    visitors: tstl.Visitors = {};

    beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
      this.visitors = createScopedOptimizeVisitors(
        program,
        options,
        isOwned,
        rules !== undefined ? { rules } : undefined,
      );
    }
  }

  return tstl.transpileVirtualProject(files, {
    ...BASE_OPTIONS,
    luaPlugins: [{ plugin: new OwnerPlugin() }, ...extraPlugins],
  });
}

function extractLua(result: tstl.TranspileVirtualProjectResult, suffix = "main.lua"): string {
  return extractTranspiledLua(result, { suffix });
}

/**
 * Extract optimization errors from transpile diagnostics.
 * Filters for errors with source "tstl-optimize".
 */
function getOptimizeErrors(result: tstl.TranspileVirtualProjectResult): ts.Diagnostic[] {
  return result.diagnostics.filter(
    (d) => d.source === "tstl-optimize" && d.category === ts.DiagnosticCategory.Error,
  );
}

/** Transpile with NO plugins (baseline) for scoping assertion. */
function transpileNoPlugin(files: Record<string, string>): tstl.TranspileVirtualProjectResult {
  return tstl.transpileVirtualProject(files, {
    ...BASE_OPTIONS,
    luaPlugins: [],
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const INLINE_SHARED = `
  /** @inline */
  export function add(a: number, b: number): number {
    return a + b;
  }
`;

const INLINE_MAIN = `
  import { add } from "./owned_shared";
  export const result = add(2, 3);
`;

const NON_INLINE_EXPORTED = `
  export function greet(name: string): string {
    return "hello " + name;
  }
`;

const INLINE_LOOP = `
  import { add } from "./owned_shared";

  export function sumLoop(): number {
    let total = 0;
    for (let i = 0; i < 5; i++) {
      total = add(total, i);
    }
    return total;
  }
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createScopedOptimizeVisitors", () => {
  describe("when all files are owned", () => {
    it("inlines @inline calls across module boundaries", () => {
      const files = {
        "owned_shared.ts": INLINE_SHARED,
        "main.ts": INLINE_MAIN,
      };

      const result = transpileWithOwner(files, ownAll);
      const lua = extractLua(result);
      const normalized = normalizeLua(lua);

      expect(getOptimizeErrors(result)).toHaveLength(0);
      // The call should be inlined — add(2, 3) must not appear
      expect(normalized).not.toContain("add(2, 3)");
      // The inlined arithmetic or result literal should be present
      expect(normalized).toMatch(/2 \+ 3|5/);
    });

    it("preserves non-@inline exported functions", () => {
      const files = {
        "main.ts": NON_INLINE_EXPORTED,
      };

      const result = transpileWithOwner(files, ownAll);
      const lua = extractLua(result);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain("greet");
    });

    it("inlines @inline calls inside for loops", () => {
      const files = {
        "owned_shared.ts": INLINE_SHARED,
        "main.ts": INLINE_LOOP,
      };

      const result = transpileWithOwner(files, ownAll);
      const lua = extractLua(result);
      const normalized = normalizeLua(lua);

      expect(getOptimizeErrors(result)).toHaveLength(0);
      // The add() call should be inlined inside the loop
      expect(normalized).not.toContain("add(total");
    });
  });

  describe("when a file is not owned", () => {
    it("emits the file byte-identical to the no-plugin baseline", () => {
      // "unowned.ts" holds an optimizable constant expression (`1 + 2`) but is NOT
      // owned, so the guard must skip it. The fixture must be something the
      // optimizer WOULD change (constant-folding turns `1 + 2` into `3`) — an inert
      // function would make this assertion pass even with a broken guard.
      const files = {
        "owned_shared.ts": INLINE_SHARED,
        "unowned.ts": "export const folded = 1 + 2;",
      };

      const ownerResult = transpileWithOwner(files, ownByPrefix);
      const baselineResult = transpileNoPlugin(files);

      const ownerLua = extractLua(ownerResult, "unowned.lua");
      const baselineLua = extractLua(baselineResult, "unowned.lua");

      expect(ownerLua).toStrictEqual(baselineLua);
      // The baseline really does leave the expression un-folded, so equality above
      // means the guard skipped optimization — not that there was nothing to do.
      expect(normalizeLua(baselineLua)).toContain("1 + 2");
    });
  });
});

describe("mergeVisitorMaps", () => {
  describe("when overlay returns undefined", () => {
    it("falls through to optimizer and inlines without erasing other output", () => {
      // The owner plugin injects a comment-like marker by prepending a local before every
      // CallExpression. We detect this by checking that the resulting Lua still has both:
      //   1. The owner's observable effect (we'll use a simple approach: wrap calls differently)
      //   2. The optimizer's effect (@inline resolves)
      //
      // Simpler approach: the owner's CallExpression visitor returns undefined for non-matching
      // calls (so optimizer runs as fallback), and for a sentinel call it returns a custom
      // transform. Assert both run.

      const files = {
        "owned_shared.ts": INLINE_SHARED,
        "main.ts": `
          import { add } from "./owned_shared";
          export const inlined = add(1, 2);
          export const sentinel = (function() { return 42; })();
        `,
      };

      class MergeTestPlugin implements tstl.Plugin {
        visitors: tstl.Visitors = {};

        beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
          const optimizeVisitors = createScopedOptimizeVisitors(program, options, ownAll);

          // Own visitor returns undefined for every call, so the optimizer (the
          // merge fallback) handles each CallExpression. Uses the loose-visitor
          // cast the rules use, since tstl.Visitors doesn't model undefined returns.
          const ownVisitors: Record<number, LooseVisitor> = {
            [ts.SyntaxKind.CallExpression]: () => undefined,
          };

          this.visitors = mergeVisitorMaps(ownVisitors as tstl.Visitors, optimizeVisitors);
        }
      }

      const result = tstl.transpileVirtualProject(files, {
        ...BASE_OPTIONS,
        luaPlugins: [{ plugin: new MergeTestPlugin() }],
      });

      const lua = extractLua(result);
      const normalized = normalizeLua(lua);

      expect(getOptimizeErrors(result)).toHaveLength(0);

      // Optimizer fallback should inline add(1, 2)
      expect(normalized).not.toContain("add(1, 2)");
      // The IIFE call or its result should still appear (not erased by merge)
      expect(normalized).toMatch(/sentinel|42/);
    });
  });

  describe("when overlay and optimizer both handle the same kind", () => {
    it("overlay result takes precedence over optimizer", () => {
      // We use a CallExpression visitor in the overlay that returns a literal `99` for ALL calls,
      // and put the optimizer in the base (second arg). The output should reflect the overlay's
      // substitution, not the optimizer's inlining — proving overlay runs first and wins.
      const files = {
        "owned_shared.ts": INLINE_SHARED,
        "main.ts": `
          import { add } from "./owned_shared";
          export const result = add(1, 2);
        `,
      };

      class OverlayPrecedencePlugin implements tstl.Plugin {
        visitors: tstl.Visitors = {};

        beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
          const optimizeVisitors = createScopedOptimizeVisitors(program, options, ownAll);

          // Overlay CallExpression visitor: always emits a numeric literal 99.
          const ownVisitors: Record<number, LooseVisitor> = {
            [ts.SyntaxKind.CallExpression]: () => tstl.createNumericLiteral(99),
          };

          this.visitors = mergeVisitorMaps(ownVisitors as tstl.Visitors, optimizeVisitors);
        }
      }

      const result = tstl.transpileVirtualProject(files, {
        ...BASE_OPTIONS,
        luaPlugins: [{ plugin: new OverlayPrecedencePlugin() }],
      });

      const lua = extractLua(result);
      // Overlay ran first and returned 99 for the add(1, 2) call → result = 99
      expect(normalizeLua(lua)).toContain("99");
      // add() was NOT inlined (overlay took precedence over optimizer)
      expect(normalizeLua(lua)).not.toContain("1 + 2");
    });
  });

  describe("when primary entry is an object-form visitor", () => {
    it("recognizes { transform } entries the same as bare functions", () => {
      const files = {
        "owned_shared.ts": INLINE_SHARED,
        "main.ts": `
          import { add } from "./owned_shared";
          export const result = add(1, 2);
        `,
      };

      class ObjectFormPlugin implements tstl.Plugin {
        visitors: tstl.Visitors = {};

        beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
          const optimizeVisitors = createScopedOptimizeVisitors(program, options, ownAll);

          const ownVisitors = {
            [ts.SyntaxKind.CallExpression]: {
              transform: () => tstl.createNumericLiteral(77),
            },
          };

          this.visitors = mergeVisitorMaps(ownVisitors as tstl.Visitors, optimizeVisitors);
        }
      }

      const result = tstl.transpileVirtualProject(files, {
        ...BASE_OPTIONS,
        luaPlugins: [{ plugin: new ObjectFormPlugin() }],
      });

      const lua = extractLua(result);
      expect(normalizeLua(lua)).toContain("77");
      expect(normalizeLua(lua)).not.toContain("1 + 2");
    });
  });

  describe("when a visitor entry is explicit undefined", () => {
    // A caller may build a map conditionally, e.g. `{ [kind]: flag ? fn : undefined }`.
    // An explicit `undefined` value is an own-enumerable key, so `Object.entries`
    // surfaces it from whichever map holds it. The merged map must never expose that
    // key mapped to an undefined value — every key it carries must map to a real
    // visitor, regardless of which side carried the undefined.
    const withUndefined = { [ts.SyntaxKind.CallExpression]: undefined } as tstl.Visitors;
    const empty: tstl.Visitors = {};

    it.each<[label: string, primary: tstl.Visitors, fallback: tstl.Visitors]>([
      ["primary", withUndefined, empty],
      ["fallback", empty, withUndefined],
    ])("omits the kind from the merged map (in %s)", (_label, primary, fallback) => {
      const merged = mergeVisitorMaps(primary, fallback);

      expect(ts.SyntaxKind.CallExpression in merged).toBe(false);
    });
  });

  describe("when a visitor entry is explicit null", () => {
    // An untyped JS caller could build a map with explicit null values, e.g.
    // `{ [kind]: flag ? fn : null }`. The fallback-map filter must exclude null
    // the same way it excludes undefined to avoid casting null into the merged map.
    const withNull = {
      [ts.SyntaxKind.CallExpression]: null as unknown as tstl.Visitors[keyof tstl.Visitors],
    } as tstl.Visitors;
    const empty: tstl.Visitors = {};

    it.each<[label: string, primary: tstl.Visitors, fallback: tstl.Visitors]>([
      ["primary", withNull, empty],
      ["fallback", empty, withNull],
    ])("omits the kind from the merged map (in %s)", (_label, primary, fallback) => {
      const merged = mergeVisitorMaps(primary, fallback);

      expect(ts.SyntaxKind.CallExpression in merged).toBe(false);
    });
  });
});

describe("target resolution", () => {
  // math-intrinsics rewrites Math.sqrt for PUC Lua but leaves `math.sqrt` intact
  // for LuaJIT, so the presence of `math.sqrt` in the output is an observable
  // proxy for which interpreter target was resolved.
  const SQRT = "declare const x: number; export const a = Math.sqrt(x);";

  function transpileSqrt(
    plugin: tstl.Plugin,
    luaTarget: tstl.LuaTarget,
  ): tstl.TranspileVirtualProjectResult {
    return tstl.transpileVirtualProject(
      { "main.ts": SQRT },
      { ...BASE_OPTIONS, luaTarget, luaPlugins: [{ plugin }] },
    );
  }

  describe("when no explicit target is configured", () => {
    it("derives the target from options.luaTarget", () => {
      class P implements tstl.Plugin {
        visitors: tstl.Visitors = {};
        beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
          this.visitors = createScopedOptimizeVisitors(program, options, ownAll);
        }
      }

      const result = transpileSqrt(new P(), tstl.LuaTarget.LuaJIT);

      // LuaJIT was derived → Math.sqrt is left as math.sqrt (not rewritten).
      expect(normalizeLua(extractLua(result))).toContain("math.sqrt");
    });
  });

  describe("when an explicit config.target is set", () => {
    it("honors the explicit target over the inferred options.luaTarget", () => {
      class P implements tstl.Plugin {
        visitors: tstl.Visitors = {};
        beforeTransform(program: ts.Program, options: tstl.CompilerOptions): void {
          this.visitors = createScopedOptimizeVisitors(program, options, ownAll, {
            target: "luajit",
          });
        }
      }

      // luaTarget is Lua51 (which would infer "puc" and rewrite Math.sqrt), but the
      // explicit "luajit" config wins, so math.sqrt survives.
      const result = transpileSqrt(new P(), tstl.LuaTarget.Lua51);

      expect(normalizeLua(extractLua(result))).toContain("math.sqrt");
    });
  });
});

describe("idempotency", () => {
  it("owner-plugin-alone and owner-plugin+global-optimize yield byte-identical output", () => {
    const files = {
      "owned_shared.ts": INLINE_SHARED,
      "main.ts": INLINE_MAIN,
    };

    // Owner-only run
    const ownerOnlyResult = transpileWithOwner(files, ownAll);
    const ownerOnlyLua = extractLua(ownerOnlyResult);

    // Owner + global OptimizePlugin (with same defaults) run
    const globalPlugin = new OptimizePlugin();
    const doubleResult = transpileWithOwner(files, ownAll, undefined, [{ plugin: globalPlugin }]);
    const doubleLua = extractLua(doubleResult);

    expect(normalizeLua(doubleLua)).toStrictEqual(normalizeLua(ownerOnlyLua));
  });
});

describe("findOptimizerPluginEntry", () => {
  it("returns the entry when name is exactly 'tstl-optimize'", () => {
    // Arrange
    const entry: tstl.LuaPluginImport = { name: "tstl-optimize" };
    const options: Partial<tstl.CompilerOptions> = { luaPlugins: [entry] };

    // Act
    const result = findOptimizerPluginEntry(options as tstl.CompilerOptions);

    // Assert
    expect(result).toStrictEqual(entry);
  });

  it("returns the entry when name contains tstl-optimize as a path segment", () => {
    // Arrange
    const entry: tstl.LuaPluginImport = {
      name: "../node_modules/tstl-optimize/dist/index.js",
    };
    const options: Partial<tstl.CompilerOptions> = { luaPlugins: [entry] };

    // Act
    const result = findOptimizerPluginEntry(options as tstl.CompilerOptions);

    // Assert
    expect(result).toStrictEqual(entry);
  });

  it.each<[label: string, input: Partial<tstl.CompilerOptions>]>([
    ["near-miss name (my-tstl-optimizer)", { luaPlugins: [{ name: "my-tstl-optimizer" }] }],
    [
      "nameless in-memory entry",
      // biome-ignore lint/suspicious/noExplicitAny: intentionally creating invalid plugin entry
      { luaPlugins: [{ plugin: {} as any }] as tstl.InMemoryLuaPlugin[] },
    ],
    ["no luaPlugins", {}],
    ["only non-optimize plugins", { luaPlugins: [{ name: "other-plugin" }] }],
  ])("returns undefined when %s", (_label, options) => {
    // Act
    const result = findOptimizerPluginEntry(options as tstl.CompilerOptions);

    // Assert
    expect(result).toBeUndefined();
  });
});

describe("resolveConstantFromOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function optionsWith(ruleConfig: unknown, pluginName = "tstl-optimize"): tstl.CompilerOptions {
    return {
      luaPlugins: [{ name: pluginName, rules: { "conditional-compilation": ruleConfig } }],
    } as tstl.CompilerOptions;
  }

  it("returns undefined when no luaPlugins configured", () => {
    // Arrange
    const options: tstl.CompilerOptions = {} as tstl.CompilerOptions;

    // Act
    const result = resolveConstantFromOptions(options, "ANY_CONSTANT");

    // Assert
    expect(result).toBeUndefined();
  });

  it("returns undefined when only non-optimize plugins registered", () => {
    // Arrange
    const options: tstl.CompilerOptions = {
      luaPlugins: [{ name: "other-plugin" }],
    } as tstl.CompilerOptions;

    // Act
    const result = resolveConstantFromOptions(options, "ANY_CONSTANT");

    // Assert
    expect(result).toBeUndefined();
  });

  it("returns true when constant default is true with env unset", () => {
    // Arrange
    const options = optionsWith({
      constants: { MY_FLAG: { env: "MY_ENV_VAR", default: true } },
    });

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBe(true);
  });

  it("returns false when constant default is false with env unset", () => {
    // Arrange
    const options = optionsWith({
      constants: { MY_FLAG: { env: "MY_ENV_VAR", default: false } },
    });

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBe(false);
  });

  it("returns false when env 'false' overrides a true default", () => {
    // Arrange
    vi.stubEnv("TEST_COMPOSE_ENV_FALSE", "false");
    const options = optionsWith({
      constants: { MY_FLAG: { env: "TEST_COMPOSE_ENV_FALSE", default: true } },
    });

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBe(false);
  });

  it("returns true when env '1' overrides a false default", () => {
    // Arrange
    vi.stubEnv("TEST_COMPOSE_ENV_ONE", "1");
    const options = optionsWith({
      constants: { MY_FLAG: { env: "TEST_COMPOSE_ENV_ONE", default: false } },
    });

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBe(true);
  });

  it("returns undefined when rule object has enabled: false", () => {
    // Arrange
    const options = optionsWith({
      enabled: false,
      constants: { MY_FLAG: { env: "MY_ENV", default: true } },
    });

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBeUndefined();
  });

  it("returns undefined when rule value is true (no constants map)", () => {
    // Arrange
    const options = optionsWith(true);

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBeUndefined();
  });

  it("returns undefined when constant definition is malformed (literal instead of object)", () => {
    // Arrange
    const options = optionsWith({
      constants: { MY_FLAG: "not-a-constant-def" },
    });

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBeUndefined();
  });

  it("resolves constant when plugin name is a path with tstl-optimize as segment", () => {
    // Arrange
    const options = optionsWith(
      {
        constants: { MY_FLAG: { env: "MY_ENV", default: 42 } },
      },
      "../node_modules/tstl-optimize/dist/index.js",
    );

    // Act
    const result = resolveConstantFromOptions(options, "MY_FLAG");

    // Assert
    expect(result).toBe(42);
  });

  it("returns undefined when constant name is not in the resolved map", () => {
    // Arrange
    const options = optionsWith({
      constants: { EXISTING: { env: "ENV", default: true } },
    });

    // Act
    const result = resolveConstantFromOptions(options, "NONEXISTENT");

    // Assert
    expect(result).toBeUndefined();
  });
});

describe("isTruthy", () => {
  it("returns false for false (only falsy value in Lua)", () => {
    expect(isTruthy(false)).toBe(false);
  });

  it.each<ConstantValue>([
    true,
    0,
    "",
    1,
    -1,
    42,
    "hello",
  ])("returns true for truthy value %s (Lua semantics)", (value) => {
    expect(isTruthy(value)).toBe(true);
  });
});
