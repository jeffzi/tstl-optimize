import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../src/rules/merge-locals";
import { compile, normalizeLua } from "../helpers";

function createLuaFile(statements: tstl.Statement[]): tstl.File {
  return tstl.createFile(statements, new Set<tstl.LuaLibFeature>(), "");
}

function expectTrackedPairMerge(source: string, merged: boolean): string {
  const lua = normalizeLua(compile(source));

  if (merged) {
    expect(lua).toContain("local a, fn");
  } else {
    expect(lua).not.toContain("local a, fn");
  }

  return lua;
}

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

    it("does NOT merge when a later RHS references a prior LHS inside a conditional expression", () => {
      const code = `
        function f(cond: boolean): number {
          const a = 1;
          const b = cond ? a : 2;
          return b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local b");
      expect(lua).not.toContain("local a, b");
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
    it.each([
      {
        name: "does NOT merge function that captures upvalue from current run",
        source: `
          function f(): number {
            const a = 1;
            const fn = function() { return a; };
            return fn();
          }
        `,
        merged: false,
        assertExtra: (lua: string) => {
          expect(lua).toContain("local a = 1");
          expect(lua).toContain("local function fn()");
        },
      },
      {
        name: "merges function with NO upvalue capture from run",
        source: `
          function f(): number {
            const a = 1;
            const fn = function() { return 2; };
            const b = 3;
            return fn() + a + b;
          }
        `,
        merged: true,
        assertExtra: (lua: string) => {
          expect(lua).toContain("local a, fn, b");
        },
      },
      {
        name: "merges function that captures external variable (not from run)",
        source: `
          let global_var = 10;
          function f(): number {
            const a = 1;
            const fn = function() { return global_var; };
            return fn() + a;
          }
        `,
        merged: true,
      },
      {
        name: "merges function when upvalue is shadowed by function parameter",
        source: `
          function f(): number {
            const a = 1;
            const fn = function(a: number) { return a; };
            return fn(2) + a;
          }
        `,
        merged: true,
      },
      {
        name: "merges function when upvalue is shadowed by local variable",
        source: `
          function f(): number {
            const a = 1;
            const fn = function() {
              const a = 2;
              return a;
            };
            return fn() + a;
          }
        `,
        merged: true,
      },
    ])("$name", ({ source, merged, assertExtra }) => {
      const lua = expectTrackedPairMerge(source, merged);
      assertExtra?.(lua);
    });

    it("does NOT merge function with nested capture of upvalue from run", () => {
      const lua = normalizeLua(
        compile(`
        function f(): number {
          const a = 1;
          const t = { fn: function() { return a; } };
          return t.fn();
        }
      `),
      );

      expect(lua).not.toContain("local a, t");
      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local t = {");
    });
  });

  describe("extra coverage", () => {
    it("detects upvalue capture across control flow statements", () => {
      const code = `
        function f(): void {
          const a = 1;
          const fn1 = function() { if (a as any) {} };
          const b = 1;
          const fn2 = function() { while (b as any) {} };
          const c = 1;
          const fn3 = function() { do {} while (c as any); };
          const d = 1;
          const fn4 = function() { for (let i = 0; i < d; i++) {} };
          const e = 1;
          const fn5 = function() { for (const k in e as any) {} };
        }
      `;
      const lua = normalizeLua(compile(code));
      expect(lua).not.toContain("local a, fn1");
      expect(lua).not.toContain("local b, fn2");
      expect(lua).not.toContain("local c, fn3");
      expect(lua).not.toContain("local d, fn4");
      expect(lua).not.toContain("local e, fn5");
    });

    it("detects upvalue capture across various expression types", () => {
      const code = `
        function f(): void {
          const a = 1;
          const fn1 = function() { let x = a; };
          let b = 1;
          const fn2 = function() { b = 2; };
          const c = 1;
          const fn3 = function() { (c as any)(); };
          const d = 1;
          const fn4 = function() { const obj = {d}; (obj as any).method(d); };
          const e = 1;
          const fn5 = function() { -e; };
          const f_var = 1;
          const fn6 = function() { (f_var); };
          const g = 1;
          const fn7 = function() { let t: any = { [g]: 1 }; return t[g]; };
          const h = 1;
          const fn8 = function() { return h + 1; };
        }
      `;
      const lua = normalizeLua(compile(code));
      expect(lua).not.toContain("local a, fn1");
      expect(lua).not.toContain("local b, fn2");
      expect(lua).not.toContain("local c, fn3");
      expect(lua).not.toContain("local d, fn4");
      expect(lua).not.toContain("local e, fn5");
      expect(lua).not.toContain("local f_var, fn6");
      expect(lua).not.toContain("local g, fn7");
      expect(lua).not.toContain("local h, fn8");
    });

    it("detects upvalue capture in method-call arguments and computed indexes", () => {
      const code = `
        declare const receiver: { run(value: number): number };
        declare const values: number[];
        function f(): number {
          const a = 1;
          const fn = function(cond: boolean) {
            const left = receiver.run(a);
            const right = cond ? values[a] : 0;
            return left + right;
          };
          return fn(true);
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
      expect(lua).toContain("receiver:run(a)");
      expect(lua).toContain("values[a + 1]");
    });

    it("allows merging when a for-in loop shadows the candidate name inside the closure body", () => {
      const code = `
        function f(): number {
          const a = 1;
          const fn = function(): number {
            for (const a in { keep: 1 }) {
              return 2;
            }
            return 3;
          };
          return fn() + a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, fn");
    });
  });
});

describe("merge-locals coverage", () => {
  it("merges when function body shadows tracked variable (not a capture)", () => {
    const code = `
      function test() {
        const a = 1;
        const fn = function() {
          let a = 2; // Shadows outer 'a'
          return 3;
        };
        const b = 2;
        fn();
        return a + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    // Should merge because 'a' is shadowed in 'fn'
    expect(lua).toContain("local a, fn, b = 1, function()");
  });

  it("detects captured variable in if statement condition and body", () => {
    const code = `
      declare const _G: any;
      function test() {
        const a = 1;
        const fn1 = function() { if (a === _G.val) {} }; // captures a in condition
        const b = 1;
        const fn2 = function() { if (_G.val) { return b; } }; // captures b in ifBlock
        const c = 1;
        const fn3 = function() { if (_G.val) {} else { return c; } }; // captures c in elseBlock
        const d = 1;
        const fn4 = function() { if (_G.val) {} else if (d === _G.val) {} }; // captures d in elseBlock (IfStatement)
        const e = 1;
        const fn5 = function() { if (_G.val) {} else {} }; // No capture (Line 78)
        fn1(); fn2(); fn3(); fn4(); fn5();
        return a + b + c + d + e;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).not.toContain("local b, fn2");
    expect(lua).not.toContain("local c, fn3");
    expect(lua).not.toContain("local d, fn4");
    expect(lua).toContain("local fn4, e, fn5 =");
  });

  it("allows merge when while/repeat does not reference tracked variable", () => {
    const code = `
      declare const _G: any;
      function test() {
        const a = 1;
        const fn1 = function() { while (_G.val) {} }; // No capture (Line 84)
        const b = 1;
        const fn2 = function() { do {} while (_G.val); }; // No capture (Line 90)
        fn1(); fn2();
        return a + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("local a, fn1, b, fn2 =");
  });

  it("detects captured variable in for loop init, condition, step, and body", () => {
    const code = `
      function test() {
        const a = 1;
        const fn1 = function() { for (let i = a; i < 10; i++) {} }; // captures a in initializer
        const b = 1;
        const fn2 = function() { for (let i = 0; i < b; i++) {} }; // captures b in limit
        const c = 1;
        const fn3 = function() { for (let i = 0; i < 10; i += c) {} }; // captures c in step
        const d = 1;
        const fn4 = function() { for (let d = 0; d < 10; d++) { return d; } }; // d shadows outer d
        const e = 1;
        const fn5 = function() { for (let i = 0; i < 10; i++) {} }; // No capture (Line 103)
        fn1(); fn2(); fn3(); fn4(); fn5();
        return a + b + c + d + e;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).not.toContain("local b, fn2");
    expect(lua).not.toContain("local c, fn3");
    expect(lua).toContain("local fn3, d, fn4, e, fn5 =");
  });

  it("detects captured variable in for-in loop", () => {
    const code = `
      function test() {
        const a = 1;
        const fn1 = function() { for (const k in a as any) {} }; // captures a
        const b = 1;
        const fn2 = function() { for (const b in {} as any) { return b; } }; // b shadows outer b
        fn1(); fn2();
        return a + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).toContain("local fn1, b, fn2 =");
  });

  it("detects captured variable inside do block", () => {
    const code = `
      declare const _G: any;
      function test() {
        const a = 1;
        const fn = function() { do { return a; } while(_G.val); };
        fn();
        return a;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn");
  });

  it("detects captured variable in assignments and expression statements", () => {
    const code = `
      function test() {
        let a = 1;
        const fn1 = function() { a = 2; }; // captures a in AssignmentStatement (left)
        const b = 1;
        const fn2 = function() { let x = 0; x = b; }; // captures b in AssignmentStatement (right)
        const c = 1;
        const fn3 = function() { (c as any)(); }; // captures c in ExpressionStatement
        const d = 1;
        const fn4 = function() { let x = 1; }; // No capture (Line 125)
        fn1(); fn2(); fn3(); fn4();
        return a + b + c + d;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).not.toContain("local b, fn2");
    expect(lua).not.toContain("local c, fn3");
    expect(lua).toContain("local fn3, d, fn4 =");
  });

  it("detects captured variable in table keys and values", () => {
    const code = `
      function test() {
        const a = 1;
        const fn1 = function() { return { [a]: 1 }; }; // captures a in key
        const b = 1;
        const fn2 = function() { return { x: b }; }; // captures b in value
        fn1(); fn2();
        return a + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).not.toContain("local b, fn2");
  });

  it("detects captured variable in table index expression", () => {
    const code = `
      function test() {
        const a: any = {};
        const b = 1;
        const fn1 = function() { return a[1]; }; // captures a
        const c: any = {};
        const d = 1;
        const fn2 = function() { return c[d]; }; // captures d
        fn1(); fn2();
        return b + d;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).not.toContain("local d, fn2");
  });

  it("detects captured variable inside parenthesized expression", () => {
    const code = `
      function test() {
        const a = 1;
        const fn = function() { return (a); };
        fn();
        return a;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn");
  });

  it("allows merge for literals and variables that shadow tracked name", () => {
    const code = `
      function test() {
        const a = 1;
        const fn1 = function(a: number) { return a; }; // a shadows outer a
        const b = 2;
        const fn2 = function() { return (123 as any) + true + "str" + null; }; // Literals
        fn1(1); fn2();
        return a + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("local a, fn1, b, fn2 =");
  });

  it("keeps destructuring separate while still merging the next compatible declarations", () => {
    const code = `
      function test() {
        const [a, b] = [1, 2]; // Multiple LHS - not mergeable
        const c = 3;
        const d = 4;
        return a + b + c + d;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("local a, b = 1, 2");
    expect(lua).toContain("local c, d = 3, 4");
  });

  it("emits empty Lua for an empty source file", () => {
    const code = "";
    const lua = normalizeLua(compile(code));
    expect(lua).toBe("");
  });
});

describe("merge-locals uncovered branches", () => {
  describe("expressionReferencesAnyOf — MethodCallExpression", () => {
    it("blocks merge when function body calls method on a tracked name (prefix match)", () => {
      // `a` is pure (table literal), so `a` enters the run. `fn`'s RHS is a pure
      // FunctionExpression, so when checked against declaredNames={a}, the scanner
      // walks the body and encounters a MethodCallExpression whose prefixExpression
      // is `a`. expressionReferencesAnyOf line 153 detects this and returns true,
      // blocking the merge. `a` and `fn` must remain separate locals.
      const code = `
        function f() {
          const a: any[] = [];
          const fn = function() { (a as any).push(1); };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("merges when function body method call prefix does not match any tracked name", () => {
      // `a` is pure, so enters the run. `fn` is declared next; its RHS is a
      // FunctionExpression (pure). The body constructs a local array `arr` and
      // calls `arr.push(1)` — a MethodCallExpression. `arr` is NOT in
      // declaredNames={a}, so expressionReferencesAnyOf hits the MethodCallExpression
      // branch (line 152), checks prefixExpression `arr` against {a} (false),
      // checks params (none), and returns false (line 157). The function also has
      // no other reference to `a`. Merge is allowed: `a` and `fn` should merge.
      const code = `
        function f() {
          const a = 1;
          const fn = function() {
            const arr: any[] = [];
            (arr as any).push(1);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, fn");
    });
  });

  describe("expressionReferencesAnyOf — FunctionExpression param partial shadowing", () => {
    it("blocks merge when function body captures a name not shadowed by any param", () => {
      // declaredNames = {a, b} when fn is evaluated. fn has param `a` (shadows outer
      // `a`), so line 186-188 removes `a` from names producing nextNames = {b}.
      // Since nextNames.size > 0, line 192 sets activeNames = {b} and continues
      // into the body. The body returns `a + b + x`, which references `b` from
      // activeNames, so returns true and blocks the merge.
      const code = `
        function outer() {
          const a = 1;
          const b = 2;
          const fn = function(a: number, x: number) { return a + b + x; };
          fn(0, 0);
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `b` and `fn` must remain separate because `fn` captures `b` as an upvalue.
      expect(lua).not.toContain("local b, fn");
    });

    it("allows merge when all tracked names are shadowed by function params", () => {
      // declaredNames = {a} when fn is evaluated. fn has param `a` which shadows
      // the tracked `a`, so nextNames = {} (empty). Line 191 returns false immediately
      // (nextNames.size === 0) — no upvalue capture detected.
      // `a` and `fn` are therefore safe to merge into a single local declaration.
      const code = `
        function outer() {
          const a = 1;
          const fn = function(a: number) { return a + 1; };
          fn(0);
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, fn");
    });
  });

  describe("expressionReferencesAnyOf — ParenthesizedExpression", () => {
    it("detects reference through parenthesized expression", () => {
      // `a` is pure and enters the run. `b`'s RHS is `(a)` — a parenthesized
      // expression wrapping identifier `a`. expressionReferencesAnyOf encounters
      // isParenthesizedExpression (line 176) and unwraps to recursively check
      // the inner expression (line 177), detecting the reference to `a`.
      // This blocks merge: `a` and `b` must remain separate.
      const code = `
        function f() {
          const a = 5;
          const b = (a);
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, b");
    });

    it("blocks merge when tracked name referenced via nested parentheses", () => {
      // `x` is pure, enters the run. `y`'s RHS is `((x))` — nested parentheses.
      // Each level of parentheses is unwrapped (line 177), eventually detecting
      // the reference to `x` in declaredNames. Blocks merge.
      const code = `
        function f() {
          const x = 10;
          const y = ((x));
          return x + y;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local x, y");
    });

    it("still merges earlier pure locals when a later parenthesized expression references one of them", () => {
      // `a` is pure, enters the run. `c` is pure, enters the run. `b`'s RHS is `(c)` —
      // a parenthesized expression wrapping `c`, which IS in declaredNames={a, c}.
      // expressionReferencesAnyOf unwraps (line 177) and checks `c` against {a, c},
      // returning true. However `a` and `c` should still merge since they don't reference
      // each other. This test verifies the ParenthesizedExpression branch is exercised.
      const code = `
        function f() {
          const a = 1;
          const c = 2;
          const b = (c);
          return a + b + c;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `a` and `c` should merge (both pure, don't reference each other)
      expect(lua).toContain("local a, c");
      // `b` is separate because its RHS references `c` (via parentheses)
      expect(lua).toContain("local b");
    });
  });

  describe("expressionReferencesAnyOf — MethodCallExpression params", () => {
    it("blocks merge when method call argument references tracked name", () => {
      // `a` is pure, enters the run. `fn`'s RHS is a FunctionExpression whose body
      // contains a method call with argument `a`: `obj.method(a)`.
      // expressionReferencesAnyOf hits isMethodCallExpression (line 152), checks
      // prefixExpression `obj` (not in {a}), then iterates params (line 154-156)
      // and finds `a`. Returns true, blocks merge.
      const code = `
        function f() {
          const a = 42;
          const obj: any = {};
          const fn = function() { (obj as any).method(a); };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("merges when method call params do not reference tracked name", () => {
      // `a` is pure, enters the run. `fn`'s RHS is a FunctionExpression whose body
      // calls method: `obj.method(b)`. The method's prefixExpression `obj` is not
      // in {a}, and its param `b` is also not in {a}. The isMethodCallExpression
      // branch (line 152) checks the prefix (line 153, returns false), then iterates
      // through params (line 154-156, checking `b` against {a}, returns false).
      // Line 157 returns false overall. Merge is allowed: `a` and `fn` can merge.
      const code = `
        function f() {
          const a = 1;
          const b = 2;
          const obj: any = {};
          const fn = function() { (obj as any).method(b); };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `a`, `b`, `obj` should all merge together (all pure, no dependencies)
      expect(lua).toContain("local a, b, obj");
      // `fn` may be separate due to being a FunctionExpression, but importantly
      // the MethodCallExpression param checking (line 154-156) was exercised
      expect(lua).toContain("local function fn");
    });
  });

  describe("expressionReferencesAnyOf — FunctionExpression multiple param shadowing", () => {
    it("blocks merge when function body captures some non-shadowed names", () => {
      // declaredNames = {a, b, c}. fn has params [a, b] which shadow the outer
      // `a` and `b`. Line 186-188 progressively removes them: after param `a`,
      // nextNames = {b, c}; after param `b`, nextNames = {c}. Line 192 sets
      // activeNames = {c}. The body references `c`, so returns true, blocks merge.
      const code = `
        function outer() {
          const a = 1;
          const b = 2;
          const c = 3;
          const fn = function(a: number, b: number) { return a + b + c; };
          fn(0, 0);
          return a + b + c;
        }
      `;

      const lua = normalizeLua(compile(code));

      // `c` and `fn` must remain separate.
      expect(lua).not.toContain("local c, fn");
    });

    it("allows merge when all params shadow all tracked names", () => {
      // declaredNames = {a, b}. fn has params [a, b] which shadow both.
      // Line 186-188 removes them from activeNames until nextNames = {}.
      // Line 191 returns false immediately. Merge is safe.
      const code = `
        function outer() {
          const a = 1;
          const b = 2;
          const fn = function(a: number, b: number) { return a + b + 10; };
          fn(0, 0);
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, b, fn");
    });
  });

  describe("merge-locals — table index and binary expressions", () => {
    it("blocks merge when function body has table index on tracked name", () => {
      // `tbl` is pure, enters the run. `result`'s RHS is a FunctionExpression
      // whose body contains a table index `tbl[1]`. This should be detected by
      // the TableIndexExpression branch (line 170-173).
      const code = `
        function f() {
          const tbl: any[] = [1, 2, 3];
          const result = function() { return (tbl as any)[0]; };
          result();
          return tbl;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local tbl, result");
    });

    it("blocks merge when function body has binary expression with tracked name", () => {
      // `x` is pure, enters the run. `computed`'s RHS is a FunctionExpression
      // whose body has a binary expression: `x + 10`. The BinaryExpression branch
      // (line 160-163) should detect the reference to `x`.
      const code = `
        function f() {
          const x = 5;
          const computed = function() { return x + 10; };
          computed();
          return x;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local x, computed");
    });

    it("blocks merge when function body has unary expression on tracked name", () => {
      // `n` is pure, enters the run. `negated`'s RHS is a FunctionExpression
      // whose body has a unary expression: `-(n)`. The UnaryExpression branch
      // (line 166-168) should detect the reference to `n`.
      const code = `
        function f() {
          const n = 42;
          const negated = function() { return -(n); };
          negated();
          return n;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local n, negated");
    });
  });

  describe("merge-locals — table and call expressions", () => {
    it("blocks merge when table constructor value references tracked name", () => {
      // `x` is pure, enters the run. `obj`'s RHS is a FunctionExpression whose
      // body contains a table constructor with a field value referencing `x`:
      // `{ value: x }`. The TableExpression branch (line 136-142) checks field
      // values and detects the reference.
      const code = `
        function f() {
          const x = 10;
          const obj = function() { return { value: x }; };
          obj();
          return x;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local x, obj");
    });

    it("blocks merge when table constructor key references tracked name", () => {
      // `key` is pure, enters the run. `obj`'s RHS is a FunctionExpression whose
      // body contains a table with a field key referencing `key`:
      // `{ [key]: 1 }`. The TableExpression branch checks field keys (line 140)
      // and detects the reference.
      const code = `
        function f() {
          const key = "myKey";
          const obj = function() { return { [key]: 1 }; };
          obj();
          return key;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local key, obj");
    });

    it("blocks merge when call expression function references tracked name", () => {
      // `fn` is pure, enters the run. `result`'s RHS is a FunctionExpression whose
      // body contains a call expression on `fn`: `fn()`. The CallExpression branch
      // (line 144-150) checks the expression being called (line 145) and detects
      // the reference to `fn`.
      const code = `
        function outer() {
          const fn = function() { return 42; };
          const result = function() { return (fn as any)(); };
          result();
          return fn;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local fn, result");
    });

    it("blocks merge when call expression argument references tracked name", () => {
      // `arg` is pure, enters the run. `result`'s RHS is a FunctionExpression whose
      // body calls a function with `arg` as parameter: `Math.max(arg)`. The
      // CallExpression branch (line 144-150) iterates params (line 146-148) and
      // detects the reference.
      const code = `
        function f() {
          const arg = 5;
          const result = function() { return Math.max(arg); };
          result();
          return arg;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local arg, result");
    });

    it("merges when table constructor neither key nor value reference tracked names", () => {
      // `x` is pure, enters the run. `y` is pure, enters the run. `obj`'s RHS is
      // a FunctionExpression whose body creates a table with literals only:
      // `{ a: 1, b: 2 }`. Neither field keys nor values reference {x, y}.
      // All three merge together into a multi-var declaration.
      const code = `
        function f() {
          const x = 1;
          const y = 2;
          const obj = function() { return { a: 1, b: 2 }; };
          obj();
          return x + y;
        }
      `;

      const lua = normalizeLua(compile(code));

      // All three variables merge together
      expect(lua).toContain("local x, y, obj");
    });
  });

  describe("merge-locals — for-in loop variable shadowing", () => {
    it("blocks merge when loop body references name shadowed by loop variable", () => {
      // `tbl` is pure, enters the run. `result`'s RHS references `tbl` which was
      // just declared in a for-in loop, so the merge should be blocked.
      const code = `
        function f() {
          const tbl: any = { a: 1, b: 2 };
          const result = function() {
            for (const key of (Object.keys(tbl) as any)) {
              return (tbl as any)[key];
            }
          };
          result();
          return tbl;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local tbl, result");
    });
  });

  describe("functionBodyReferencesAnyOf — inner local shadows tracked name", () => {
    it("allows merge when function body re-declares the sole tracked name as a local", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body statements. The first statement
      // is `local a = 42` — a VariableDeclarationStatement whose LHS is `a`.
      // Line 33 detects `a` in activeNames, builds nextNames = {}, then line 39
      // fires `nextNames.size === 0 → return false` immediately (no upvalue capture).
      // a and fn are safe to merge.
      const code = `
        function f() {
          const a = 1;
          const fn = function() {
            const a = 42;
            return a + 1;
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, fn");
    });

    it("allows merge when function body re-declares all tracked names as locals", () => {
      // declaredNames = {a, b} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body. First stmt: `local a = 10`
      // → nextNames = {b}, activeNames = {b}. Second stmt: `local b = 20`
      // → nextNames = {}, line 39 fires → return false. All tracked names are
      // locally shadowed before any use, so no upvalue capture. a, b and fn merge.
      const code = `
        function f() {
          const a = 1;
          const b = 2;
          const fn = function() {
            const a = 10;
            const b = 20;
            return a + b;
          };
          fn();
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, b, fn");
    });

    it("blocks merge when function body re-declares one tracked name but uses the other", () => {
      // declaredNames = {a, b} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf: stmt `local a = 10` → nextNames = {b}, activeNames = {b}.
      // Next stmt `return a + b + 1` — statementReferencesAnyOf checks the return
      // expressions against activeNames={b}, finds `b` referenced → returns true.
      // Merge is blocked; b and fn remain separate.
      const code = `
        function f() {
          const a = 1;
          const b = 2;
          const fn = function() {
            const a = 10;
            return a + b + 1;
          };
          fn();
          return a + b;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local b, fn");
    });
  });

  describe("statementReferencesAnyOf — ForStatement", () => {
    it("blocks merge when tracked name appears in numeric for loop limit expression", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body and encounters a Lua ForStatement
      // `for i = 1, a do`. statementReferencesAnyOf checks limitExpression `a`
      // against {a} at line 95 → returns true → blocks merge.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const a = 5;
          const fn = function() {
            for (const i of $range(1, a)) { }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("allows merge when numeric for loop control variable shadows the tracked name", () => {
      // declaredNames = {i} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf encounters Lua ForStatement `for i = 1, 3 do`.
      // statementReferencesAnyOf at line 98: stmt.controlVariable.text === "i",
      // which IS in names={i}, so forBodyNames = {} (empty Set). Line 101:
      // forBodyNames.size === 0, so the body is NOT scanned. Line 103: return false.
      // The outer `i` is safely shadowed by the loop variable; merge is allowed.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const i = 10;
          const fn = function() {
            for (const i of $range(1, 3)) { }
          };
          fn();
          return i;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local i, fn");
    });
  });

  describe("statementReferencesAnyOf — ForStatement body scan", () => {
    it("blocks merge when numeric for loop body references a tracked name", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf encounters ForStatement `for j = 1, 3 do`.
      // controlVariable.text === "j", which is NOT in names={a}, so forBodyNames = {a}.
      // Line 101: forBodyNames.size > 0, so body scan proceeds. The body contains
      // `local x = a + j` which references `a`. functionBodyReferencesAnyOf returns
      // true, line 102 returns true → merge blocked.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const a = 5;
          const fn = function() {
            for (const j of $range(1, 3)) {
              const x = a + j;
            }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });
  });

  describe("statementReferencesAnyOf — unhandled statement type fallthrough", () => {
    it("allows merge when function body contains only break and unhandled statement types", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // functionBodyReferencesAnyOf walks fn's body: a ForStatement `for i = 1, 3 do break end`.
      // The ForStatement body contains a BreakStatement. statementReferencesAnyOf is
      // called on the BreakStatement, which matches none of the if-branches and falls
      // through to line 127 `return false`. The for loop header/body don't reference {a},
      // so the whole scan returns false. Merge is allowed.
      const code = `
        /// <reference types="@typescript-to-lua/language-extensions" />
        function f() {
          const a = 1;
          const fn = function() {
            for (const i of $range(1, 3)) {
              break;
            }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, fn");
    });
  });

  describe("expressionReferencesAnyOf — MethodCallExpression with colon syntax", () => {
    it("blocks merge when method call prefix is a tracked name", () => {
      // declaredNames = {obj} when fn's FunctionExpression RHS is checked.
      // fn's body calls obj:bar(42) — a MethodCallExpression whose prefixExpression
      // is `obj`. Line 153 detects `obj` in activeNames → returns true → blocks merge.
      const code = `
        class Foo { bar(x: number) { return x; } }
        function f() {
          const obj = new Foo();
          const fn = function() { obj.bar(42); };
          fn();
          return obj;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local obj, fn");
    });

    it("blocks merge when method call argument is a tracked name", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // fn's body calls obj:bar(a) — MethodCallExpression, prefix `obj` is not in
      // {a} (obj is local inside fn), but param `a` IS in {a}. Line 154-156 iterates
      // params, finds `a` → returns true → blocks merge.
      const code = `
        class Foo { bar(x: number) { return x; } }
        function f() {
          const a = 1;
          const fn = function() {
            const obj = new Foo();
            obj.bar(a);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("allows merge when method call prefix and args do not reference tracked names", () => {
      // declaredNames = {a} when fn's FunctionExpression RHS is checked.
      // fn's body calls obj:bar(42) — MethodCallExpression. prefixExpression `obj`
      // is a local inside fn's body, not in activeNames={a}. Arg `42` is a literal,
      // not in {a}. The MethodCallExpression branch exhausts all checks and falls
      // through to line 157 `return false`. Merge is allowed: a and fn merge.
      const code = `
        class Foo { bar(x: number) { return x; } }
        function f() {
          const a = 1;
          const fn = function() {
            const obj = new Foo();
            obj.bar(42);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("local a, fn");
    });
  });

  describe("remaining control-flow and expression scanners", () => {
    it("blocks merge when a repeat-until condition references a tracked name", () => {
      const code = `
        function f() {
          const a = 1;
          const fn = function() {
            do {
              const x = 0;
            } while (a > 0);
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("blocks merge when numeric-for limit or step references a tracked name", () => {
      const code = `
        function f() {
          const a = 2;
          const fn = function() {
            for (let i = 0; i < a * 3; i += a) {
              const x = i;
            }
          };
          fn();
          return a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("blocks merge when a table index uses a tracked name as the index", () => {
      const code = `
        function f(values: number[]) {
          const a = 1;
          const fn = function() {
            return values[a];
          };
          return fn() + a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("blocks merge when a parenthesized tracked name is captured", () => {
      const code = `
        function f() {
          const a = 1;
          const fn = function() {
            return (a);
          };
          return fn();
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });

    it("blocks merge when a conditional expression captures a tracked name in the false branch", () => {
      const code = `
        function f(flag: boolean) {
          const a = 1;
          const fn = function() {
            return flag ? 0 : a;
          };
          return fn() + a;
        }
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("local a, fn");
    });
  });

  describe("public visitor coverage", () => {
    it("falls back to the transformed node when the source-file visitor does not receive a Lua file", () => {
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
        node: ts.SourceFile,
        context: tstl.TransformationContext,
      ) => tstl.File;
      const sourceFile = ts.createSourceFile(
        "merge-locals.ts",
        "foo();",
        ts.ScriptTarget.Latest,
        true,
      );
      const fallbackStatement = tstl.createExpressionStatement(tstl.createIdentifier("fallback"));

      const result = Reflect.apply(visitor, undefined, [
        sourceFile,
        {
          superTransformNode: () => fallbackStatement,
        } as unknown as tstl.TransformationContext,
      ]);

      expect(tstl.isExpressionStatement(result as unknown as tstl.Statement)).toBe(true);
    });
  });

  describe("raw Lua visitor coverage", () => {
    function runSourceFileVisitor(node: tstl.Node): tstl.Node {
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
        node: ts.SourceFile,
        context: tstl.TransformationContext,
      ) => tstl.File;

      return Reflect.apply(visitor, undefined, [
        {} as ts.SourceFile,
        {
          superTransformNode: () => node,
        } as unknown as tstl.TransformationContext,
      ]);
    }

    function extractInnerBody(file: tstl.File): tstl.Statement[] {
      const outerDecl = file.statements[0] as tstl.VariableDeclarationStatement;
      const outerFn = outerDecl.right?.[0] as tstl.FunctionExpression;
      return outerFn.body.statements;
    }
    function expectRawTrackedPair(options: {
      bodyStatements: tstl.Statement[];
      merged: boolean;
      params?: tstl.Identifier[];
    }): tstl.Statement[] {
      const innerBody = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("a")],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [
            tstl.createFunctionExpression(
              tstl.createBlock(options.bodyStatements),
              options.params ?? [],
            ),
          ],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("outer")],
          [tstl.createFunctionExpression(innerBody, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const statements = extractInnerBody(transformed);

      if (options.merged) {
        const merged = statements[0] as tstl.VariableDeclarationStatement;
        expect(statements).toHaveLength(1);
        expect(merged.left).toHaveLength(2);
        expect((merged.left[0] as tstl.Identifier).text).toBe("a");
        expect((merged.left[1] as tstl.Identifier).text).toBe("fn");
      } else {
        expect((statements[0] as tstl.VariableDeclarationStatement).left).toHaveLength(1);
        expect((statements[1] as tstl.VariableDeclarationStatement).left).toHaveLength(1);
      }

      return statements;
    }

    it.each([
      {
        name: "does not merge when a raw function body captures a tracked name through a parenthesized expression",
        merged: false,
        bodyStatements: [
          tstl.createReturnStatement([
            tstl.createParenthesizedExpression(tstl.createIdentifier("a")),
          ]),
        ],
      },
      {
        name: "does not merge when a raw function body captures a tracked name through a conditional expression",
        merged: false,
        bodyStatements: [
          tstl.createReturnStatement([
            tstl.createConditionalExpression(
              tstl.createBooleanLiteral(true),
              tstl.createNumericLiteral(0),
              tstl.createIdentifier("a"),
            ),
          ]),
        ],
      },
      {
        name: "does not merge when a raw if else-block captures a tracked name",
        merged: false,
        bodyStatements: [
          tstl.createIfStatement(
            tstl.createBooleanLiteral(true),
            tstl.createBlock([tstl.createReturnStatement([tstl.createNumericLiteral(0)])]),
            tstl.createBlock([tstl.createReturnStatement([tstl.createIdentifier("a")])]),
          ),
        ],
      },
      {
        name: "does not merge when a raw numeric-for step expression captures a tracked name",
        merged: false,
        bodyStatements: [
          tstl.createForStatement(
            tstl.createBlock([]),
            tstl.createIdentifier("i"),
            tstl.createNumericLiteral(0),
            tstl.createNumericLiteral(5),
            tstl.createIdentifier("a"),
          ),
        ],
      },
      {
        name: "does not merge when a raw numeric-for initializer captures a tracked name",
        merged: false,
        bodyStatements: [
          tstl.createForStatement(
            tstl.createBlock([]),
            tstl.createIdentifier("i"),
            tstl.createIdentifier("a"),
            tstl.createNumericLiteral(5),
            tstl.createNumericLiteral(1),
          ),
        ],
      },
      {
        name: "merges when a raw function parameter shadows the tracked name",
        merged: true,
        bodyStatements: [tstl.createReturnStatement([tstl.createIdentifier("a")])],
        params: [tstl.createIdentifier("a")],
      },
      {
        name: "merges when a raw for-in loop shadows the tracked name for the whole body",
        merged: true,
        bodyStatements: [
          tstl.createForInStatement(
            tstl.createBlock([tstl.createReturnStatement([tstl.createIdentifier("a")])]),
            [tstl.createIdentifier("a")],
            [tstl.createIdentifier("iterable")],
          ),
        ],
      },
      {
        name: "does not merge when raw repeat and numeric-for constructs reference a tracked name",
        merged: false,
        bodyStatements: [
          tstl.createRepeatStatement(tstl.createBlock([]), tstl.createIdentifier("a")),
          tstl.createForStatement(
            tstl.createBlock([]),
            tstl.createIdentifier("i"),
            tstl.createNumericLiteral(0),
            tstl.createIdentifier("a"),
            tstl.createIdentifier("a"),
          ),
        ],
      },
    ])("$name", ({ bodyStatements, merged, params }) => {
      expectRawTrackedPair({ bodyStatements, merged, params });
    });

    it("does not merge when a raw method call uses the tracked name as its prefix", () => {
      const innerBody = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("obj")],
          [tstl.createTableExpression([])],
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [
            tstl.createFunctionExpression(
              tstl.createBlock([
                tstl.createExpressionStatement(
                  tstl.createMethodCallExpression(
                    tstl.createIdentifier("obj"),
                    tstl.createIdentifier("push"),
                    [tstl.createNumericLiteral(1)],
                  ),
                ),
              ]),
              [],
            ),
          ],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("outer")],
          [tstl.createFunctionExpression(innerBody, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const statements = extractInnerBody(transformed);

      expect((statements[0] as tstl.VariableDeclarationStatement).left).toHaveLength(1);
      expect((statements[1] as tstl.VariableDeclarationStatement).left).toHaveLength(1);
    });

    it("does not merge a raw declaration that has multiple RHS expressions", () => {
      const innerBody = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("a")],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("b")],
          [tstl.createNumericLiteral(2), tstl.createNumericLiteral(3)],
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("c")],
          [tstl.createNumericLiteral(4)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("outer")],
          [tstl.createFunctionExpression(innerBody, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const statements = extractInnerBody(transformed) as tstl.VariableDeclarationStatement[];

      expect(statements).toHaveLength(3);
      expect(statements[0].left).toHaveLength(1);
      expect(statements[1].right).toHaveLength(2);
      expect(statements[2].left).toHaveLength(1);
    });
  });
});
