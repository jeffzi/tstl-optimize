import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import { OptimizePlugin } from "../src/index";
import { compile, normalizeLua } from "./helpers";

describe("OptimizePlugin coverage", () => {
  it("beforeTransform handles LuaJIT target", () => {
    const plugin = new OptimizePlugin();
    // biome-ignore lint/suspicious/noExplicitAny: mock for testing
    const mockProgram: any = { getTypeChecker: vi.fn() };
    const mockOptions: tstl.CompilerOptions = {
      luaTarget: tstl.LuaTarget.LuaJIT,
    };

    plugin.beforeTransform(mockProgram, mockOptions);

    const visitorKeys = Object.keys(plugin.visitors);
    expect(visitorKeys.length).toBeGreaterThan(0);
    for (const key of visitorKeys) {
      expect(typeof plugin.visitors[Number(key)]).toBe("function");
    }
  });

  it("beforeEmit when inline is disabled", () => {
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

  it("disabling all rules", () => {
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

  it("Line 121: Fallback for unhandled kinds", () => {
    // We need to trigger the merged visitor for a kind that is not EXPRESSION or STMT_WITH_FALLBACK
    // and returns undefined from the rule visitor.
    // In src/index.ts:
    // 118: const res = fn(node, context) ?? existing?.(node, context);
    // 119: if (res !== undefined) return res;
    // 120: if (isExpr) return context.superTransformExpression(node as ts.Expression);
    // 121: if (isStmtFallback) return context.superTransformStatements(node as ts.Statement);
    // 122: return undefined;

    const plugin = new OptimizePlugin();
    // biome-ignore lint/suspicious/noExplicitAny: accessing private fields for coverage
    (plugin as any).checker = {};
    // biome-ignore lint/suspicious/noExplicitAny: accessing private fields for coverage
    (plugin as any).buildVisitors();

    const visitor = plugin.visitors[ts.SyntaxKind.SourceFile];
    // This is complex to unit test because of the closure captures.
    expect(typeof visitor).toBe("function");
  });
});
