import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import {
  createScopedOptimizeVisitors,
  mergeVisitorMaps,
  type OptimizeComposeOptions,
} from "../src/compose";
import { OptimizePlugin } from "../src/index";
import { normalizeLua } from "./helpers";

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

/** Extract the Lua for a specific outPath suffix from a transpile result, throwing on errors. */
function extractLua(result: tstl.TranspileVirtualProjectResult, suffix = "main.lua"): string {
  const errors = result.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error && d.source !== "tstl-optimize",
  );
  if (errors.length > 0) {
    const msgs = errors
      .map((d) => (typeof d.messageText === "string" ? d.messageText : d.messageText.messageText))
      .join("\n");
    throw new Error(msgs);
  }
  const file = result.transpiledFiles.find((f) => f.outPath.endsWith(suffix));
  if (file === undefined || file.lua === undefined) {
    throw new Error(`No Lua output for ${suffix}.`);
  }
  return file.lua;
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

      const tstlOptimizeDiagErrors = result.diagnostics.filter(
        (d) => d.source === "tstl-optimize" && d.category === ts.DiagnosticCategory.Error,
      );
      expect(tstlOptimizeDiagErrors).toHaveLength(0);
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

      const tstlOptimizeDiagErrors = result.diagnostics.filter(
        (d) => d.source === "tstl-optimize" && d.category === ts.DiagnosticCategory.Error,
      );
      expect(tstlOptimizeDiagErrors).toHaveLength(0);
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

      const tstlOptimizeDiagErrors = result.diagnostics.filter(
        (d) => d.source === "tstl-optimize" && d.category === ts.DiagnosticCategory.Error,
      );
      expect(tstlOptimizeDiagErrors).toHaveLength(0);

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
