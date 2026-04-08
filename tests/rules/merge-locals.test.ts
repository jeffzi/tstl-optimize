import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import createPlugin from "../../src/index";
import { compile, normalizeLua } from "../helpers";

describe("merge-locals", () => {
  describe("when encountering consecutive variable declarations", () => {
    it("merges multiple consecutive pure single-var locals", () => {
      const code = `
        function f(): number {
          const a = 1;
          const b = 2;
          const c = 3;
          return a + b + c;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, b, c = 1, 2, 3");
    });

    it("breaks run at call expression RHS — merges pure runs independently", () => {
      const code = `
        declare function get(): number;
        function f(): number {
          const a = 1;
          const b = 2;
          const c = get();
          const d = 4;
          const e = 5;
          return a + b + c + d + e;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, b = 1, 2");
      expect(lua).toContain("local c = get()");
      expect(lua).toContain("local d, e = 4, 5");
    });

    it("breaks run at multi-LHS declaration", () => {
      const code = `
        declare function get(): [number, number];
        function f(): number {
          const a = 1;
          const [x, y] = get();
          const b = 2;
          return a + x + y + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      // 'a' alone — no merge
      expect(lua).toContain("local a = 1");
      // multi-LHS stays unchanged
      expect(lua).toContain("x, y");
      // 'b' alone — no merge
      expect(lua).toContain("local b = 2");
    });

    it("does not merge single-element declarations", () => {
      const code = `
        declare function get(): number;
        function f(): number {
          const x = get();
          const y = 1;
          return x + y;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local x = get()");
      expect(lua).toContain("local y = 1");
      expect(lua).not.toContain("local x, y");
    });
  });

  describe("scope", () => {
    it("does NOT merge module-level consecutive pure single-var locals", () => {
      // Module-level consts are emitted without 'local' by TSTL in module scope
      // (they become global assignments). What matters is they are NOT batched together.
      const code = `
        export const a = 1;
        export const b = 2;
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("a = 1");
      expect(lua).toContain("b = 2");
      expect(lua).not.toContain("local a, b");
    });

    it("merges pure locals inside a function body", () => {
      const code = `
        function foo(): number {
          const a = 1;
          const b = 2;
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, b = 1, 2");
    });
  });

  describe("disabled", () => {
    it("does not merge when merge-locals is disabled", () => {
      const code = `
        function f(): number {
          const a = 1;
          const b = 2;
          return a + b;
        }
      `;

      const lua = normalizeLua(
        compile(code, { pluginOptions: { rules: { "merge-locals": false } } }),
      );

      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local b = 2");
      expect(lua).not.toContain("local a, b");
    });
  });

  describe("forward reference safety", () => {
    it("does NOT merge when a later RHS references an LHS declared earlier in the same run", () => {
      // Merging would produce: local a, b = 1, a
      // In Lua, all RHS are evaluated before any assignment, so `a` on the RHS
      // would be nil (or an outer `a`), not 1. The merge must be suppressed.
      const code = `
        function f(): number {
          const a = 1;
          const b = a;
          return b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local b = a");
      expect(lua).not.toContain("local a, b");
    });

    it("does NOT merge when a later RHS references a prior LHS inside a table constructor", () => {
      // Merging would produce: local a, t = 1, {x = a}
      // The `a` inside the table constructor is evaluated before `a` is assigned.
      const code = `
        function f(): number {
          const a = 1;
          const t = { x: a };
          return t.x;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a = 1");
      expect(lua).not.toContain("local a, t");
    });
  });

  describe("edge cases", () => {
    it("includes local with no RHS (nil-initializer) in a run", () => {
      // TypeScript 'let x: number;' — no initializer
      const code = `
        function f(): number {
          let a: number;
          const b = 2;
          a = 1;
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      // 'a' has no RHS — treated as pure, included in run with 'b'
      expect(lua).toContain("local a, b");
    });

    it("includes identifier RHS in a run (pure)", () => {
      const code = `
        function f(x: number): number {
          const a = x;
          const b = 2;
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, b = x, 2");
    });

    it("includes table-constructor RHS in a run (pure)", () => {
      // Table constructor is pure — no side effects
      const code = `
        function f(): number {
          const t = { x: 1 };
          const b = 2;
          return t.x + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local t, b");
    });
  });

  describe("nested function expressions", () => {
    it.each([
      {
        name: "callback passed as a call argument",
        source: `
          declare function run(fn: () => number): void;
          function outer(): void {
            run(function(): number {
              const a = 1;
              const b = 2;
              return a + b;
            });
          }
        `,
      },
      {
        name: "function stored in a table value",
        source: `
          function outer() {
            const obj = { handler: function(): number {
              const a = 1;
              const b = 2;
              return a + b;
            } };
            return obj;
          }
        `,
      },
    ])("merges consecutive pure locals inside $name", ({ source }) => {
      const lua = normalizeLua(compile(source));

      expect(lua).toContain("local a, b = 1, 2");
    });
  });

  describe("closure upvalue capture", () => {
    it("does NOT merge function that captures upvalue from current run", () => {
      const code = `
        function f(): number {
          const a = 1;
          const fn = function() { return a; };
          return fn();
        }
      `;

      const lua = normalizeLua(compile(code));

      // The function captures 'a', so it must NOT be merged with 'a = 1' in the same statement.
      // In Lua, RHS are evaluated left-to-right BEFORE binding, so `a` in the closure would be nil.
      // Must have separate local statements.
      expect(lua).not.toContain("local a, fn");
      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local function fn()");
    });

    it("does NOT merge function with nested capture of upvalue from run", () => {
      const code = `
        function f(): number {
          const a = 1;
          const t = { fn: function() { return a; } };
          return t.fn();
        }
      `;

      const lua = normalizeLua(compile(code));

      // The nested function in the table captures 'a', so the table constructor
      // references 'a'. Must NOT merge with 'a = 1'.
      expect(lua).not.toContain("local a, t");
      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local t = {");
    });

    it("merges function with NO upvalue capture from run", () => {
      const code = `
        function f(): number {
          const a = 1;
          const fn = function() { return 2; };
          const b = 3;
          return fn() + a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      // The function does NOT capture 'a' or 'b', so it CAN be merged.
      expect(lua).toContain("local a, fn, b");
    });

    it("merges function that captures external variable (not from run)", () => {
      const code = `
        let global_var = 10;
        function f(): number {
          const a = 1;
          const fn = function() { return global_var; };
          return fn() + a;
        }
      `;

      const lua = normalizeLua(compile(code));

      // The function captures global_var (not in the current run), so it CAN be merged with 'a'.
      expect(lua).toContain("local a, fn");
    });

    it("merges function when upvalue is shadowed by function parameter", () => {
      const code = `
        function f(): number {
          const a = 1;
          const fn = function(a: number) { return a; };
          return fn(2) + a;
        }
      `;
      const lua = normalizeLua(compile(code));
      // The function parameter 'a' shadows the outer 'a'. It does NOT capture the outer 'a'.
      expect(lua).toContain("local a, fn");
    });

    it("merges function when upvalue is shadowed by local variable", () => {
      const code = `
        function f(): number {
          const a = 1;
          const fn = function() { 
            const a = 2; 
            return a; 
          };
          return fn() + a;
        }
      `;
      const lua = normalizeLua(compile(code));
      // The local 'a' shadows the outer 'a'. It does NOT capture the outer 'a'.
      expect(lua).toContain("local a, fn");
    });
  });

  describe("source position propagation", () => {
    /**
     * Compile TS source with the optimize plugin and capture the Lua AST via afterPrint.
     * Returns the top-level Lua File node so tests can inspect AST properties like line/column.
     */
    function compileToAst(source: string): tstl.File {
      const plugin = createPlugin();
      let capturedAst: tstl.File | undefined;

      const spyPlugin: tstl.Plugin = {
        afterPrint(_program, _options, _emitHost, result) {
          const file = result[0];
          if (file && "luaAst" in file && file.luaAst) {
            capturedAst = file.luaAst;
          }
        },
      };

      tstl.transpileVirtualProject(
        { "main.ts": source },
        {
          noHeader: true,
          luaPlugins: [{ plugin }, { plugin: spyPlugin }],
          noImplicitSelf: true,
          luaTarget: tstl.LuaTarget.Lua51,
          strict: true,
          target: ts.ScriptTarget.ESNext,
          lib: ["lib.esnext.d.ts"],
          types: ["@typescript-to-lua/language-extensions"],
        },
      );

      if (!capturedAst) {
        throw new Error("Failed to capture Lua AST from afterPrint");
      }
      return capturedAst;
    }

    /**
     * Find the first VariableDeclarationStatement whose left-hand identifiers
     * match the given names, searching inside the first function body.
     */
    function findMergedLocal(
      ast: tstl.File,
      names: string[],
    ): tstl.VariableDeclarationStatement | undefined {
      // The function declaration is the first top-level statement.
      // TSTL emits module-level functions as AssignmentStatement (kind=4),
      // not VariableDeclarationStatement (kind=3).
      const fnDecl = ast.statements[0];
      const right = tstl.isVariableDeclarationStatement(fnDecl)
        ? fnDecl.right
        : tstl.isAssignmentStatement(fnDecl)
          ? fnDecl.right
          : undefined;
      const fnExpr = right?.[0];
      if (!fnExpr || !tstl.isFunctionExpression(fnExpr)) return undefined;

      for (const stmt of fnExpr.body.statements) {
        if (!tstl.isVariableDeclarationStatement(stmt)) continue;
        const leftNames = stmt.left.map((id) => id.text);
        if (names.every((n) => leftNames.includes(n))) {
          return stmt;
        }
      }
      return undefined;
    }

    it("merged statement carries line and column of the first original statement", () => {
      const code = `
        function f(): number {
          const a = 1;
          const b = 2;
          return a + b;
        }
      `;

      const ast = compileToAst(code);
      const merged = findMergedLocal(ast, ["a", "b"]);

      if (merged === undefined) {
        expect.fail("merged local not found");
      }

      // The first identifier in the merged statement (a) retains position info
      // from TSTL's transpilation. The merged statement itself should carry
      // that same position so source maps remain accurate.
      const firstIdentifier = merged.left[0];
      expect(firstIdentifier.line).toBeDefined();

      // The merged statement node should inherit position from the first
      // original statement, not be left as undefined.
      expect(merged.line).toBe(firstIdentifier.line);
      expect(merged.column).toBe(firstIdentifier.column);
    });
  });
});
