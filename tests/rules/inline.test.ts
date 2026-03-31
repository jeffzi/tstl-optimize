import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { mapLuaStatements } from "../../src/rules/inline";
import { compile, compileMultiFileWithDiagnostics, compileWithDiagnostics } from "../helpers";

describe("inline", () => {
  describe("positive: inlined", () => {
    it("inlines function declaration with single return", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("= double(");
    });

    it("inlines arrow function with expression body", () => {
      const lua = compile(`
        /** @inline */
        const double = (x: number) => x * 2;
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("double(");
    });

    it("inlines function expression with single return", () => {
      const lua = compile(`
        /** @inline */
        const double = function(x: number) { return x * 2; };
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("double(");
    });

    it("inlines multiple parameters", () => {
      const lua = compile(`
        /** @inline */
        function add(a: number, b: number) { return a + b; }
        declare const x: number;
        declare const y: number;
        const r = add(x, y);
      `);
      expect(lua).toContain("x + y");
      expect(lua).not.toContain("= add(");
    });

    it("inlines zero parameters", () => {
      const lua = compile(`
        /** @inline */
        function pi() { return 3.14; }
        const r = pi();
      `);
      expect(lua).toContain("3.14");
      expect(lua).not.toContain("= pi(");
    });

    it("inlines when body references module-scope variable", () => {
      const lua = compile(`
        const factor = 10;
        /** @inline */
        function scale(x: number) { return x * factor; }
        declare const a: number;
        const r = scale(a);
      `);
      expect(lua).toContain("a * factor");
      expect(lua).not.toContain("= scale(");
    });

    it("inlines when argument is an expression", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a + 1);
      `);
      expect(lua).toContain("(a + 1) * 2");
      expect(lua).not.toContain("= double(");
    });

    it("wraps compound body in parentheses for operator precedence safety", () => {
      const lua = compile(`
        /** @inline */
        function inc(x: number) { return x + 1; }
        declare const a: number;
        const r = inc(a) * 2;
      `);
      // inc(a) should become (a + 1) * 2, not a + 1 * 2
      expect(lua).toContain("(a + 1) * 2");
      expect(lua).not.toContain("= inc(");
    });

    it("inlines side-effecting arg when param used only once", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare function foo(): number;
        const r = double(foo());
      `);
      expect(lua).toContain("foo() * 2");
      expect(lua).not.toContain("= double(");
    });

    it("inlines function returning object literal", () => {
      const lua = compile(`
        /** @inline */
        function wrap(x: number) { return { value: x }; }
        declare const a: number;
        const r = wrap(a);
      `);
      expect(lua).toContain("value = a");
      expect(lua).not.toContain("= wrap(");
    });

    it("inlines function with property access on parameter", () => {
      const lua = compile(`
        /** @inline */
        function getX(obj: { x: number }) { return obj.x; }
        declare const t: { x: number };
        const r = getX(t);
      `);
      expect(lua).toContain("t.x");
      expect(lua).not.toContain("= getX(");
    });

    it("inlines function with negated parameter", () => {
      const lua = compile(`
        /** @inline */
        function neg(x: number) { return -x; }
        declare const a: number;
        const r = neg(a);
      `);
      expect(lua).toContain("-a");
      expect(lua).not.toContain("= neg(");
    });

    it("inlines function with call expression in body", () => {
      const lua = compile(`
        declare function process(x: number): number;
        /** @inline */
        function wrap(x: number) { return process(x); }
        declare const a: number;
        const r = wrap(a);
      `);
      expect(lua).toContain("process(a)");
      expect(lua).not.toContain("= wrap(");
    });

    it("inlines expression-body @inline at statement position", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a);
      `);
      expect(lua).toContain("a * 2");
      // The call double(a) at statement position should be inlined
      expect(lua).not.toContain("double(a)");
    });
  });

  describe("comment cleanup", () => {
    it("strips @inline JSDoc comment from any function form", () => {
      const luaDecl = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(luaDecl).not.toContain("@inline");

      const luaArrow = compile(`
        /** @inline */
        const double = (x: number) => x * 2;
        declare const a: number;
        const r = double(a);
      `);
      expect(luaArrow).not.toContain("@inline");
    });
  });

  describe("edge cases", () => {
    it("does not inline when rule is disabled", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `,
        { pluginOptions: { rules: { inline: false } } },
      );
      expect(lua).toContain("double(");
    });

    it("math-intrinsics still works when inline is active", () => {
      const lua = compile(`
        declare const x: number;
        const r = Math.floor(x);
      `);
      expect(lua).toContain("% 1");
      expect(lua).not.toContain("math.floor");
    });

    it("handles arity mismatch gracefully", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        const r = (double as any)();
      `);
      expect(lua).toContain("double(");
    });
  });

  describe("warnings", () => {
    it("warns on multi-statement body at expression position", () => {
      // Multi-statement inline cannot be spliced into an expression context.
      // Use a nested call position (e.g., inside a binary expression) to trigger this.
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function compute(x: number) {
          const tmp = x * 2;
          return tmp + 1;
        }
        declare const a: number;
        const r = compute(a) + 1;
      `);
      expect(lua).toContain("compute(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain(
        "multi-statement body cannot be inlined at expression position",
      );
    });

    it("warns on empty body at expression position", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function noop() {}
        const r = noop();
      `);
      expect(lua).toContain("noop(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("@inline ignored");
    });

    it("warns on arity mismatch", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function double(x: number) { return x * 2; }
        // @ts-expect-error testing arity mismatch
        const r = double();
      `);
      expect(lua).toContain("double(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("argument count");
    });

    it("warns on rest parameters", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function first(...args: number[]) { return args[0]; }
        const r = first(1, 2, 3);
      `);
      expect(lua).toContain("first(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("rest parameters");
    });

    it("warns on optional parameters", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function maybe(x?: number) { return x; }
        const r = maybe(5);
      `);
      expect(lua).toContain("maybe(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("optional parameters");
    });

    it("warns on default parameters", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function withDefault(x: number = 0) { return x; }
        const r = withDefault(5);
      `);
      expect(lua).toContain("withDefault(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("default parameters");
    });

    it("warns on non-module scope", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        function outer() {
          const captured = 10;
          /** @inline */
          function inner(x: number) { return x + captured; }
          return inner(5);
        }
      `);
      expect(lua).toContain("inner(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("module scope");
    });

    it("warns on recursive function", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function recurse(x: number): number { return recurse(x); }
        const r = recurse(5);
      `);
      expect(lua).toContain("recurse(");
      // Both the outer call recurse(5) and the inner body call recurse(x) are visited
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].messageText).toContain("recursive");
    });

    it("warns on parameter written inside body", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number) { return (x = 1, x); }
        const result = f(0);
      `);
      expect(lua).toContain("f(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("written inside body");
    });

    it("warns on side-effect duplication", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function square(x: number) { return x * x; }
        declare function foo(): number;
        const r = square(foo());
      `);
      expect(lua).toContain("square(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("side effects");
    });

    it("emits no warning without @inline tag", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("double(");
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("cross-module: inlined (self-contained)", () => {
    it("inlines self-contained function from another module", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          /** @inline */
          export function double(x: number) { return x * 2; }
        `,
        "main.ts": `
          import { double } from "./utils";
          declare const a: number;
          const r = double(a);
        `,
      });
      expect(lua).toContain("a * 2");
      expect(lua).not.toContain("double(");
      expect(diagnostics).toHaveLength(0);
    });

    it("inlines when body uses const enum (baked as literal by TSTL)", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const enum Dir { Up = 1, Down = 2 }
          /** @inline */
          export function isUp(d: number) { return d === Dir.Up; }
        `,
        "main.ts": `
          import { isUp } from "./utils";
          declare const d: number;
          const r = isUp(d);
        `,
      });
      expect(lua).toContain("d == 1");
      expect(lua).not.toContain("isUp(");
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("cross-module: not inlined (free variables)", () => {
    it("rejects function referencing module constant", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const factor = 10;
          /** @inline */
          export function scale(x: number) { return x * factor; }
        `,
        "main.ts": `
          import { scale } from "./utils";
          declare const a: number;
          const r = scale(a);
        `,
      });
      expect(lua).toContain("scale(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(diagnostics[0].source).toBe("tstl-optimize");
    });

    it("rejects function calling module-scope function", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          function helper(x: number) { return x + 1; }
          /** @inline */
          export function wrap(x: number) { return helper(x); }
        `,
        "main.ts": `
          import { wrap } from "./utils";
          declare const a: number;
          const r = wrap(a);
        `,
      });
      expect(lua).toContain("wrap(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
    });

    it("rejects function referencing non-const enum", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          enum Dir { Up = 1, Down = 2 }
          /** @inline */
          export function isUp(d: number) { return d === Dir.Up; }
        `,
        "main.ts": `
          import { isUp } from "./utils";
          declare const d: number;
          const r = isUp(d);
        `,
      });
      expect(lua).toContain("isUp(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
    });
  });

  describe("cross-module: multi-statement statement bodies", () => {
    it("inlines cross-module void multi-statement with self-contained body", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          /** @inline */
          export function log(x: number): void {
            const y = x + 1;
            const z = y * 2;
          }
        `,
        "main.ts": `
          import { log } from "./utils";
          declare const a: number;
          log(a);
        `,
      });
      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("log(");
    });

    it("rejects cross-module void multi-statement with module-scope free variable", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const factor = 10;
          /** @inline */
          export function scale(x: number): void {
            const y = x * factor;
          }
        `,
        "main.ts": `
          import { scale } from "./utils";
          declare const a: number;
          scale(a);
        `,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(diagnostics[0].code).toBe(90001);
      expect(lua).toContain("scale(");
    });

    it("rejects cross-module var-decl statementsWithReturn with free variable", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const offset = 5;
          /** @inline */
          export function compute(x: number): number {
            const temp = x + offset;
            return temp * 2;
          }
        `,
        "main.ts": `
          import { compute } from "./utils";
          declare const a: number;
          const r = compute(a);
        `,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(lua).toContain("compute(");
    });

    it("rejects cross-module return-statement statementsWithReturn with free variable", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const multiplier = 3;
          /** @inline */
          export function triple(x: number): number {
            const temp = x * multiplier;
            return temp;
          }
        `,
        "main.ts": `
          import { triple } from "./utils";
          declare const a: number;
          function wrapper(x: number) { return triple(x); }
        `,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(lua).toContain("triple(");
    });
  });
});

describe("statement-position calls", () => {
  it("non-inline expression statement preserved with both inline and debug-strip enabled", () => {
    const lua = compile(
      `
      declare function someFunc(x: number): void;
      declare const a: number;
      someFunc(a);
    `,
      { pluginOptions: { rules: { inline: true, "debug-strip": { functions: ["debug"] } } } },
    );
    expect(lua).toContain("someFunc(a)");
  });

  it("non-@inline function call at statement position is preserved unchanged", () => {
    const { lua, diagnostics } = compileWithDiagnostics(`
      function notInlined(x: number) { return x * 2; }
      declare const a: number;
      notInlined(a);
    `);
    expect(lua).toContain("notInlined(a)");
    expect(diagnostics).toHaveLength(0);
  });
});

describe("void multi-statement inline", () => {
  it("expands 2+ statement body into do...end block", () => {
    const lua = compile(`
      /** @inline */
      function setup(x: number) { let a = x + 1; console.log(a); }
      declare const n: number;
      setup(n);
    `);
    expect(lua).toContain("do");
    expect(lua).toContain("end");
    // The call setup(n) should be replaced with the do...end block
    expect(lua).not.toContain("setup(n)");
  });

  it("hoists all arguments to temporaries before do...end", () => {
    const lua = compile(`
      /** @inline */
      function foo(a: number, b: number) { let x = a; let y = b; }
      declare const p: number;
      declare const q: number;
      foo(p, q);
    `);
    expect(lua).toContain("____inline_arg_0");
    expect(lua).toContain("____inline_arg_1");
    // Temporaries should appear before do
    const argIdx = lua.indexOf("____inline_arg_0");
    const doIdx = lua.indexOf("do", argIdx);
    expect(argIdx).toBeLessThan(doIdx);
  });

  it("preserves left-to-right evaluation order for side-effecting arguments", () => {
    const lua = compile(`
      /** @inline */
      function bar(a: number, b: number) { let x = a + b; }
      declare function sideEffect1(): number;
      declare function sideEffect2(): number;
      bar(sideEffect1(), sideEffect2());
    `);
    // sideEffect1 should be assigned to temp before sideEffect2
    const idx1 = lua.indexOf("sideEffect1()");
    const idx2 = lua.indexOf("sideEffect2()");
    expect(idx1).toBeLessThan(idx2);
    expect(lua).toContain("____inline_arg_0");
    expect(lua).toContain("____inline_arg_1");
  });

  it("rejects @inline function with top-level early return", () => {
    const { lua, diagnostics } = compileWithDiagnostics(`
      /** @inline */
      function bail(x: number) { if (x > 0) { console.log(x); } return; }
      bail(1);
    `);
    expect(lua).toContain("bail(");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].messageText).toContain("@inline ignored");
    expect(diagnostics[0].messageText).toContain("early return");
  });

  it("rejects @inline function with top-level break or continue", () => {
    const { diagnostics: breakDiags } = compileWithDiagnostics(`
      /** @inline */
      function stopLoop() { break; }
      for (let i = 0; i < 10; i++) {
        stopLoop();
      }
    `);
    expect(breakDiags.length).toBeGreaterThanOrEqual(1);
    expect(
      breakDiags.some((d) => typeof d.messageText === "string" && d.messageText.includes("break")),
    ).toBe(true);

    const { diagnostics: continueDiags } = compileWithDiagnostics(`
      /** @inline */
      function skipIter() { continue; }
      for (let i = 0; i < 10; i++) {
        skipIter();
      }
    `);
    expect(continueDiags.length).toBeGreaterThanOrEqual(1);
    expect(
      continueDiags.some(
        (d) => typeof d.messageText === "string" && d.messageText.includes("continue"),
      ),
    ).toBe(true);
  });

  it("erases empty @inline function body at statement site (no do end)", () => {
    const { lua, diagnostics } = compileWithDiagnostics(`
      /** @inline */
      function noop() {}
      noop();
    `);
    // Empty body produces no output at call site -- no do...end, no call
    // noop() call should be erased; function declaration `function noop()` may remain
    expect(lua).not.toMatch(/\bdo\b/);
    // Verify no standalone noop() call (exclude function declaration line)
    const lines = lua.split("\n").map((l) => l.trim());
    const callLines = lines.filter((l) => l === "noop()");
    expect(callLines).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("isolates inlined locals from caller scope via do...end", () => {
    const lua = compile(`
      /** @inline */
      function setX() { let x = 42; }
      let x = 10;
      setX();
      console.log(x);
    `);
    // The inlined body should be inside do...end
    expect(lua).toMatch(/\bdo\b/);
    // No standalone setX() call in the output (function declaration may remain)
    const lines = lua.split("\n").map((l) => l.trim());
    expect(lines.filter((l) => l === "setX()")).toHaveLength(0);
    // Caller's x should be unaffected (console.log(x) still references caller's x)
    expect(lua).toContain("console.log(x)");
  });

  it("inlines zero-parameter void multi-statement function (no temporaries)", () => {
    const lua = compile(`
      /** @inline */
      function init() { let a = 1; let b = 2; }
      init();
    `);
    expect(lua).toMatch(/\bdo\b/);
    expect(lua).not.toContain("____inline_arg");
    // No standalone init() call (function declaration may remain)
    const lines = lua.split("\n").map((l) => l.trim());
    expect(lines.filter((l) => l === "init()")).toHaveLength(0);
  });
});

describe("statementsWithReturn data model", () => {
  describe("classifyBody: statementsWithReturn variant", () => {
    it("multi-statement body with terminal return emits statementsWithReturn diagnostic (D-10) at void site", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function compute(x: number): number {
          const tmp = x * 2;
          return tmp + 1;
        }
        declare const a: number;
        compute(a);
      `);
      // void call site: D-10 warns, does not inline
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("return-value function called at void site");
      expect(lua).toContain("compute(a)");
    });

    it("multi-statement body with no terminal return still produces statements target (no regression)", () => {
      // A void multi-statement function (no terminal return) should still inline
      const lua = compile(`
        /** @inline */
        function setup(x: number): void {
          let a = x + 1;
          let b = a + 2;
        }
        declare const n: number;
        setup(n);
      `);
      expect(lua).toContain("do");
      expect(lua).not.toContain("setup(n)");
    });

    it("single-statement return still produces expression target (no regression)", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number): number { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
      // function declaration has double( in it; verify no standalone call "= double("
      expect(lua).not.toContain("= double(");
    });
  });

  describe("canInlineStatements: statementsWithReturn validation", () => {
    it("rejects return-value function with early return in pre-return stmts", () => {
      // This has an early return inside the body stmts (before the terminal return)
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number): number {
          if (x > 0) { return 0; }
          const y = x + 1;
          return y;
        }
        declare const a: number;
        f(a);
      `);
      // early return in body should still be rejected
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("@inline ignored");
      expect(lua).toContain("f(a)");
    });

    it("rejects return-value function with recursive call in return expression (void site emits D-10)", () => {
      // At a void site, D-10 fires before recursive check — but a diagnostic is still emitted
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function fib(n: number): number {
          const a = n - 1;
          return fib(a);
        }
        declare const x: number;
        fib(x);
      `);
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      // At void site: D-10 fires (return-value function called at void site)
      expect(
        diagnostics.some(
          (d) => typeof d.messageText === "string" && d.messageText.includes("@inline ignored"),
        ),
      ).toBe(true);
    });
  });
});

describe("statement visitor fallthrough", () => {
  it("non-inline VariableStatement is preserved when inline rule is active", () => {
    // TSTL emits module-level vars without `local`; function-level vars use `local`.
    const lua = compile(`
      function makeLocals(): void {
        const x = 5;
        const r = x + 1;
      }
    `);
    expect(lua).toContain("local x = 5");
  });

  it("non-inline ReturnStatement is preserved when inline rule is active", () => {
    const lua = compile(`
      function getVal(): number {
        declare const y: number;
        return 42;
      }
    `);
    expect(lua).toContain("return 42");
  });
});

describe("mapLuaStatements (unit)", () => {
  /** leafFn that replaces any Identifier with text "x" with one named "replaced". */
  const leafFn = (n: tstl.Expression): tstl.Expression | undefined => {
    if (n.kind === tstl.SyntaxKind.Identifier && (n as tstl.Identifier).text === "x") {
      return tstl.createIdentifier("replaced");
    }
    return undefined;
  };

  it("returns empty array for empty input", () => {
    const result = mapLuaStatements([], leafFn);
    expect(result).toStrictEqual([]);
  });

  it("substitutes in ExpressionStatement", () => {
    const stmt = tstl.createExpressionStatement(tstl.createIdentifier("x"));
    const [result] = mapLuaStatements([stmt], leafFn);
    const expr = (result as tstl.ExpressionStatement).expression as tstl.Identifier;
    expect(expr.text).toBe("replaced");
  });

  it("substitutes in VariableDeclarationStatement right side", () => {
    const stmt = tstl.createVariableDeclarationStatement(
      [tstl.createIdentifier("y")],
      [tstl.createIdentifier("x")],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const varDecl = result as tstl.VariableDeclarationStatement;
    expect(varDecl.right).toBeDefined();
    expect((varDecl.right?.[0] as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in AssignmentStatement right side", () => {
    const stmt = tstl.createAssignmentStatement(
      [tstl.createIdentifier("y") as tstl.AssignmentLeftHandSideExpression],
      [tstl.createIdentifier("x")],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const assign = result as tstl.AssignmentStatement;
    expect((assign.right[0] as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in AssignmentStatement TableIndexExpression left side", () => {
    const tblIndex = tstl.createTableIndexExpression(
      tstl.createIdentifier("x"),
      tstl.createIdentifier("key"),
    );
    const stmt = tstl.createAssignmentStatement(
      [tblIndex as tstl.AssignmentLeftHandSideExpression],
      [tstl.createNumericLiteral(1)],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const assign = result as tstl.AssignmentStatement;
    const lhs = assign.left[0] as tstl.TableIndexExpression;
    expect((lhs.table as tstl.Identifier).text).toBe("replaced");
  });

  it("recurses into DoStatement", () => {
    const inner = tstl.createExpressionStatement(tstl.createIdentifier("x"));
    const stmt = tstl.createDoStatement([inner]);
    const [result] = mapLuaStatements([stmt], leafFn);
    const doStmt = result as tstl.DoStatement;
    const innerResult = doStmt.statements[0] as tstl.ExpressionStatement;
    expect((innerResult.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in IfStatement condition and blocks", () => {
    const stmt = tstl.createIfStatement(
      tstl.createIdentifier("x"),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const ifStmt = result as tstl.IfStatement;
    expect((ifStmt.condition as tstl.Identifier).text).toBe("replaced");
    const ifBlock = ifStmt.ifBlock.statements[0] as tstl.ExpressionStatement;
    expect((ifBlock.expression as tstl.Identifier).text).toBe("replaced");
    const elseBlock = (ifStmt.elseBlock as tstl.Block).statements[0] as tstl.ExpressionStatement;
    expect((elseBlock.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in chained IfStatement (elseif)", () => {
    const elseIf = tstl.createIfStatement(
      tstl.createIdentifier("x"),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("y"))]),
    );
    const stmt = tstl.createIfStatement(
      tstl.createIdentifier("y"),
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("y"))]),
      elseIf,
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const ifStmt = result as tstl.IfStatement;
    const elseIfStmt = ifStmt.elseBlock as tstl.IfStatement;
    expect((elseIfStmt.condition as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in WhileStatement condition and body", () => {
    const stmt = tstl.createWhileStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createIdentifier("x"),
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const whileStmt = result as tstl.WhileStatement;
    expect((whileStmt.condition as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = whileStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in RepeatStatement body and condition", () => {
    const stmt = tstl.createRepeatStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createIdentifier("x"),
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const repeatStmt = result as tstl.RepeatStatement;
    expect((repeatStmt.condition as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = repeatStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in ForStatement expressions but not controlVariable", () => {
    const stmt = tstl.createForStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      tstl.createIdentifier("i"),
      tstl.createIdentifier("x"), // controlVariableInitializer
      tstl.createIdentifier("x"), // limitExpression
      tstl.createIdentifier("x"), // stepExpression
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const forStmt = result as tstl.ForStatement;
    // controlVariable should NOT be substituted
    expect((forStmt.controlVariable as tstl.Identifier).text).toBe("i");
    // Expressions should be substituted
    expect((forStmt.controlVariableInitializer as tstl.Identifier).text).toBe("replaced");
    expect((forStmt.limitExpression as tstl.Identifier).text).toBe("replaced");
    expect((forStmt.stepExpression as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = forStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in ForInStatement expressions but not names", () => {
    const stmt = tstl.createForInStatement(
      tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("x"))]),
      [tstl.createIdentifier("k")],
      [tstl.createIdentifier("x")],
    );
    const [result] = mapLuaStatements([stmt], leafFn);
    const forInStmt = result as tstl.ForInStatement;
    // names should NOT be substituted
    expect(forInStmt.names[0].text).toBe("k");
    // expressions should be substituted
    expect((forInStmt.expressions[0] as tstl.Identifier).text).toBe("replaced");
    const bodyExpr = forInStmt.body.statements[0] as tstl.ExpressionStatement;
    expect((bodyExpr.expression as tstl.Identifier).text).toBe("replaced");
  });

  it("substitutes in ReturnStatement expressions", () => {
    const stmt = tstl.createReturnStatement([tstl.createIdentifier("x")]);
    const [result] = mapLuaStatements([stmt], leafFn);
    const retStmt = result as tstl.ReturnStatement;
    expect((retStmt.expressions[0] as tstl.Identifier).text).toBe("replaced");
  });

  it("does not mutate original statements", () => {
    const original = tstl.createExpressionStatement(tstl.createIdentifier("x"));
    const stmts = [original];
    mapLuaStatements(stmts, leafFn);
    // Original should be unchanged
    expect((original.expression as tstl.Identifier).text).toBe("x");
    expect(stmts).toHaveLength(1);
  });

  it("passes through leaf statements (break, goto, label) unchanged", () => {
    const breakStmt = tstl.createBreakStatement();
    const [breakResult] = mapLuaStatements([breakStmt], leafFn);
    expect(breakResult.kind).toBe(tstl.SyntaxKind.BreakStatement);

    const gotoStmt = tstl.createGotoStatement("lbl");
    const [gotoResult] = mapLuaStatements([gotoStmt], leafFn);
    expect(gotoResult.kind).toBe(tstl.SyntaxKind.GotoStatement);
    expect((gotoResult as tstl.GotoStatement).label).toBe("lbl");

    const labelStmt = tstl.createLabelStatement("lbl");
    const [labelResult] = mapLuaStatements([labelStmt], leafFn);
    expect(labelResult.kind).toBe(tstl.SyntaxKind.LabelStatement);
    expect((labelResult as tstl.LabelStatement).name).toBe("lbl");
  });
});

describe("variable-declaration multi-statement inline", () => {
  it("expands const r = foo(x) to local r / arg temps / do...end block with assignment", () => {
    const lua = compile(`
      /** @inline */
      function compute(x: number): number {
        const y = x + 1;
        return y * 2;
      }
      declare const a: number;
      const r = compute(a);
    `);
    expect(lua).toContain("local r");
    expect(lua).toMatch(/\bdo\b/);
    expect(lua).toContain("r =");
    expect(lua).not.toContain("= compute(");
    // arg temp hoisted before do...end block
    const argIdx = lua.indexOf("____inline_arg_0");
    expect(argIdx).toBeGreaterThan(-1);
    const doIdx = lua.indexOf("do", argIdx);
    expect(argIdx).toBeLessThan(doIdx);
  });

  it("handles zero-parameter return-value function: no temp decls", () => {
    const lua = compile(`
      /** @inline */
      function getVal(): number {
        const x = 42;
        return x;
      }
      const r = getVal();
    `);
    expect(lua).toContain("local r");
    expect(lua).not.toContain("____inline_arg");
    expect(lua).toMatch(/\bdo\b/);
    expect(lua).toContain("r =");
    expect(lua).not.toContain("= getVal(");
  });

  it("handles multiple parameters: all arg temps outside do...end", () => {
    const lua = compile(`
      /** @inline */
      function add(a: number, b: number): number {
        const sum = a + b;
        return sum;
      }
      declare const x: number;
      declare const y: number;
      const r = add(x, y);
    `);
    expect(lua).toContain("____inline_arg_0");
    expect(lua).toContain("____inline_arg_1");
    // Both temps should appear before do
    const arg0Idx = lua.indexOf("____inline_arg_0");
    const doIdx = lua.indexOf("do", arg0Idx);
    expect(arg0Idx).toBeLessThan(doIdx);
    expect(lua).not.toContain("= add(");
  });

  it("isolates inlined body locals inside do...end (scoping)", () => {
    const lua = compile(`
      /** @inline */
      function compute(x: number): number {
        const y = x * 10;
        return y + 1;
      }
      declare const a: number;
      const y = 99;
      const r = compute(a);
      const z = y;
    `);
    // The do...end should scope the body's 'y' away from the caller's 'y'
    expect(lua).toMatch(/\bdo\b/);
    expect(lua).not.toContain("= compute(");
    // Caller's y=99 should still be present
    expect(lua).toContain("99");
  });

  it("non-inline variable declaration passes through unchanged", () => {
    const lua = compile(`
      function notInlined(x: number): number { return x * 2; }
      declare const a: number;
      const r = notInlined(a);
    `);
    expect(lua).toContain("notInlined(a)");
  });

  it("variable declaration with non-call initializer passes through unchanged", () => {
    const lua = compile(`
      declare const a: number;
      const r = a + 1;
    `);
    expect(lua).toContain("a + 1");
  });

  it("warns on void-body @inline at var-decl site: no inline expansion, call preserved", () => {
    // A void multi-statement @inline called at var-decl site: handler returns undefined for
    // non-statementsWithReturn target — TSTL handles it, call is preserved in output.
    const { lua } = compileWithDiagnostics(`
      /** @inline */
      function doStuff(x: number): void { let a = x + 1; let b = a + 2; }
      declare const a: number;
      const r = (doStuff as any)(a);
    `);
    // The call is preserved (handler returns undefined for statements target)
    expect(lua).toContain("doStuff(");
  });
});

describe("return-statement multi-statement inline", () => {
  it("expands return foo(x) to flat sequence: arg temps + body + return", () => {
    const lua = compile(`
      /** @inline */
      function compute(x: number): number {
        const y = x + 1;
        return y * 2;
      }
      declare const a: number;
      function caller(): number {
        return compute(a);
      }
    `);
    expect(lua).toContain("local y");
    expect(lua).toContain("return y");
    // no do...end wrapping at return site (flat emission)
    expect(lua).not.toMatch(/\bdo\b/);
    expect(lua).not.toContain("return compute(");
    // arg temp appears before body statements within caller
    const callerIdx = lua.indexOf("caller");
    const argIdx = lua.indexOf("____inline_arg_0", callerIdx);
    const bodyIdx = lua.indexOf("local y", argIdx);
    expect(argIdx).toBeGreaterThan(-1);
    expect(argIdx).toBeLessThan(bodyIdx);
  });

  it("handles zero-parameter return-value function at return site", () => {
    const lua = compile(`
      /** @inline */
      function getVal(): number {
        const x = 42;
        return x;
      }
      function caller(): number {
        return getVal();
      }
    `);
    // no arg temps
    expect(lua).not.toContain("____inline_arg");
    // body and return emitted
    expect(lua).toContain("local x = 42");
    expect(lua).toContain("return x");
    // no do...end
    expect(lua).not.toMatch(/\bdo\b/);
    // no call preserved
    expect(lua).not.toContain("return getVal()");
  });

  it("non-inline return statement preserved unchanged", () => {
    const lua = compile(`
      function caller(x: number): number {
        return x + 1;
      }
    `);
    expect(lua).toContain("return x + 1");
  });

  it("return without call expression preserved unchanged", () => {
    const lua = compile(`
      function caller(): number {
        const x = 42;
        return x;
      }
    `);
    expect(lua).toContain("return x");
    expect(lua).not.toContain("____inline_arg");
  });

  it("warns on void-body @inline at return site: returns undefined, call preserved", () => {
    // A void multi-statement @inline at return site: handler returns undefined for
    // non-statementsWithReturn target.
    const { lua } = compileWithDiagnostics(`
      /** @inline */
      function doStuff(x: number): void { let a = x + 1; let b = a + 2; }
      declare const a: number;
      function caller() {
        return (doStuff as any)(a);
      }
    `);
    // The call is preserved (handler returns undefined for statements target)
    expect(lua).toContain("doStuff(");
  });

  it("body locals appear in caller scope (no do...end at return site)", () => {
    // At a return site, no caller code follows, so body locals in caller scope is safe.
    const lua = compile(`
      /** @inline */
      function compute(x: number): number {
        const y = x * 10;
        return y + 1;
      }
      declare const a: number;
      function caller(): number {
        return compute(a);
      }
    `);
    expect(lua).toContain("local y");
    expect(lua).not.toMatch(/\bdo\b/);
    expect(lua).not.toContain("return compute(");
  });
});

describe("destructuring multi-statement inline", () => {
  it("object destructuring: expands const { a, b } = foo(x) with result ident and field-access assignments", () => {
    const lua = compile(`
      /** @inline */
      function foo(x: number): { a: number; b: number } {
        const obj = { a: x, b: x + 1 };
        return obj;
      }
      declare const x: number;
      const { a, b } = foo(x);
    `);
    expect(lua).toMatch(/____inline_result_\d+/);
    expect(lua).toMatch(/\bdo\b/);
    expect(lua).toMatch(/\.a\b/);
    expect(lua).toMatch(/\.b\b/);
    expect(lua).not.toContain("= foo(");
    // field-access assignments appear after the do...end block
    const endIdx = lua.lastIndexOf("end");
    expect(lua.indexOf(".a", endIdx)).toBeGreaterThan(endIdx);
    expect(lua.indexOf(".b", endIdx)).toBeGreaterThan(endIdx);
  });

  it("object destructuring: renamed binding uses propertyName as key and binding name as local", () => {
    const lua = compile(`
      /** @inline */
      function foo(x: number): { a: number } {
        const obj = { a: x };
        return obj;
      }
      declare const x: number;
      const { a: myA } = foo(x);
    `);
    // Local binding should use 'myA', access via .a key
    expect(lua).toContain("myA");
    expect(lua).toMatch(/\.a\b/);
    // No field named 'myA' — only field key 'a'
    expect(lua).not.toMatch(/\.myA\b/);
  });

  it("non-inline object destructuring passes through unchanged", () => {
    const lua = compile(`
      function foo(): { a: number; b: number } { return { a: 1, b: 2 }; }
      const { a, b } = foo();
    `);
    // No inline expansion
    expect(lua).not.toMatch(/____inline_result_\d+/);
    // Original call preserved
    expect(lua).toContain("foo()");
  });

  it("array destructuring: expands const [a, b] = foo(x) with result ident and unpack call", () => {
    const lua = compile(`
      /** @inline */
      function foo(x: number): number[] {
        const arr = [x, x + 1];
        return arr;
      }
      declare const x: number;
      const [a, b] = foo(x);
    `);
    expect(lua).toMatch(/____inline_result_\d+/);
    expect(lua).toMatch(/\bdo\b/);
    expect(lua).toContain("unpack(");
    expect(lua).not.toContain("= foo(");
    // binding identifiers appear in unpack assignment
    expect(lua).toContain("a,");
    expect(lua).toContain("b");
  });

  it("non-inline array destructuring passes through unchanged", () => {
    const lua = compile(`
      function foo(): number[] { return [1, 2]; }
      const [a, b] = foo();
    `);
    // No inline expansion
    expect(lua).not.toMatch(/____inline_result_\d+/);
    // Original call preserved
    expect(lua).toContain("foo()");
  });
});

describe("cross-module statement body: void multi-statement", () => {
  it("allows cross-module void multi-statement inline when body is self-contained (param-only)", () => {
    const { lua, diagnostics } = compileMultiFileWithDiagnostics({
      "utils.ts": `
        /** @inline */
        export function setup(x: number): void {
          let a = x + 1;
          let b = a * 2;
        }
      `,
      "main.ts": `
        import { setup } from "./utils";
        declare const n: number;
        setup(n);
      `,
    });
    // Body is self-contained: all identifiers come from params — should be inlined
    expect(diagnostics).toHaveLength(0);
    expect(lua).not.toContain("setup(n)");
    expect(lua).toMatch(/\bdo\b/);
  });

  it("rejects cross-module void multi-statement inline when body references free variable", () => {
    const { lua, diagnostics } = compileMultiFileWithDiagnostics({
      "utils.ts": `
        const factor = 10;
        /** @inline */
        export function scale(x: number): void {
          let a = x * factor;
          let b = a + 1;
        }
      `,
      "main.ts": `
        import { scale } from "./utils";
        declare const n: number;
        scale(n);
      `,
    });
    // factor is a free variable from the source module — should be rejected
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].messageText).toContain("non-parameter");
    expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    expect(diagnostics[0].code).toBe(90001);
    expect(lua).toContain("scale(n)");
  });
});

describe("cross-module statement body: var-decl statementsWithReturn", () => {
  it("allows cross-module var-decl multi-statement inline when body is self-contained", () => {
    const { lua, diagnostics } = compileMultiFileWithDiagnostics({
      "utils.ts": `
        /** @inline */
        export function compute(x: number): number {
          const tmp = x * 2;
          return tmp + 1;
        }
      `,
      "main.ts": `
        import { compute } from "./utils";
        declare const a: number;
        const r = compute(a);
      `,
    });
    // Self-contained: tmp is a local, x comes from params — should be inlined.
    // buildVarDeclInline uses the binding name (r) as the result variable, not ____inline_result_N.
    expect(diagnostics).toHaveLength(0);
    expect(lua).not.toContain("= compute(");
    expect(lua).toContain("local r");
    expect(lua).toContain("____inline_arg_0");
  });

  it("rejects cross-module var-decl multi-statement inline when body references free variable", () => {
    const { lua, diagnostics } = compileMultiFileWithDiagnostics({
      "utils.ts": `
        const factor = 10;
        /** @inline */
        export function scale(x: number): number {
          const tmp = x * factor;
          return tmp + 1;
        }
      `,
      "main.ts": `
        import { scale } from "./utils";
        declare const a: number;
        const r = scale(a);
      `,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].messageText).toContain("non-parameter");
    expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    expect(diagnostics[0].code).toBe(90001);
    expect(lua).toContain("scale(a)");
  });
});

describe("cross-module statement body: return-statement statementsWithReturn", () => {
  it("allows cross-module return-statement multi-statement inline when body is self-contained", () => {
    const { lua, diagnostics } = compileMultiFileWithDiagnostics({
      "utils.ts": `
        /** @inline */
        export function compute(x: number): number {
          const tmp = x * 2;
          return tmp + 1;
        }
      `,
      "main.ts": `
        import { compute } from "./utils";
        declare const a: number;
        function caller(): number {
          return compute(a);
        }
      `,
    });
    // Self-contained: should be inlined at return site
    expect(diagnostics).toHaveLength(0);
    expect(lua).not.toContain("return compute(");
  });

  it("rejects cross-module return-statement multi-statement inline when body references free variable", () => {
    const { lua, diagnostics } = compileMultiFileWithDiagnostics({
      "utils.ts": `
        const factor = 10;
        /** @inline */
        export function scale(x: number): number {
          const tmp = x * factor;
          return tmp + 1;
        }
      `,
      "main.ts": `
        import { scale } from "./utils";
        declare const a: number;
        function caller(): number {
          return scale(a);
        }
      `,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].messageText).toContain("non-parameter");
    expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    expect(diagnostics[0].code).toBe(90001);
    expect(lua).toContain("return scale(a)");
  });
});

describe("inline strict mode", () => {
  describe("global strict: true promotes warnings to errors (code 90001)", () => {
    it("emits Error when global strict: true and no per-rule override (expression body)", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a + 1, a);
        `,
        { pluginOptions: { strict: true } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });

    it("emits Warning when global strict: false (default)", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a + 1, a);
        `,
        { pluginOptions: { strict: false } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    });

    it("emits Error for statement-body inline warning when global strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function greet(x: number) { let y = x + 1; y = y + 1; }
        declare const a: number;
        const r = greet(a);
        `,
        { pluginOptions: { strict: true } },
      );
      // statementsWithReturn or statements at expression position -> Warning/Error
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });
  });

  describe("per-rule inline.strict override", () => {
    it("emits Warning when global strict: true but inline.strict: false", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a + 1, a);
        `,
        { pluginOptions: { strict: true, rules: { inline: { strict: false } } } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
    });

    it("emits Error when global strict: false but inline.strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a + 1, a);
        `,
        { pluginOptions: { strict: false, rules: { inline: { strict: true } } } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });

    it("emits Error when both global strict: true and inline.strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a + 1, a);
        `,
        { pluginOptions: { strict: true, rules: { inline: { strict: true } } } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });
  });

  describe("diagnostic code 90001 still correct regardless of strict mode", () => {
    it("code is 90001 with global strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        double(a + 1, a);
        `,
        { pluginOptions: { strict: true } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe(90001);
      expect(diagnostics[0].source).toBe("tstl-optimize");
    });
  });
});

describe("diagnostic messages", () => {
  describe("rejection reasons are specific", () => {
    it("rejects early return with specific message", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function bad(x: number): void {
          if (x > 0) return;
          const y = x + 1;
        }
        declare const a: number;
        bad(a);
      `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("early return in body");
    });

    it("rejects break in body with specific message", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function bad(x: number): void {
          break;
        }
        declare const a: number;
        bad(a);
      `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("break in body");
    });

    it("rejects rest parameters with specific message", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function bad(...args: number[]): void {
          const x = args[0];
        }
        declare const a: number;
        bad(a);
      `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("rest parameters are not supported");
    });
  });

  it("emits specific message for multi-statement call at expression position", () => {
    const { diagnostics } = compileWithDiagnostics(`
      /** @inline */
      function effect(x: number): number {
        const y = x + 1;
        return y * 2;
      }
      declare const a: number;
      const r = effect(a) + 1;
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].messageText).toContain(
      "multi-statement body cannot be inlined at expression position",
    );
    expect(diagnostics[0].messageText).toContain("only statement-position calls supported");
    expect(diagnostics[0].code).toBe(90001);
  });
});

describe("@inline JSDoc stripping", () => {
  it("strips @inline comment from single-expression function Lua output", () => {
    const lua = compile(`
      /** @inline */
      function single(x: number) { return x + 1; }
      declare const a: number;
      const r = single(a);
    `);
    expect(lua).not.toContain("@inline");
    expect(lua).not.toContain("---");
  });

  it("strips @inline comment from multi-statement function Lua output", () => {
    const lua = compile(`
      /** @inline */
      function multi(x: number): void {
        const y = x + 1;
        const z = y * 2;
      }
      declare const a: number;
      multi(a);
    `);
    expect(lua).not.toContain("@inline");
    // The function declaration's JSDoc block (---\n-- @inline\n) must not appear
    expect(lua).not.toContain("-- @inline");
  });
});

describe("strict mode", () => {
  describe("global strict: true promotes inline warnings to errors", () => {
    it("promotes warning to error for multi-statement call at expression position", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function effect(x: number): number {
          const y = x + 1;
          return y * 2;
        }
        declare const a: number;
        const r = effect(a) + 1;
        `,
        { pluginOptions: { strict: true, rules: { inline: true } } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
      expect(diagnostics[0].code).toBe(90001);
    });

    it("promotes warning to error for early-return rejection", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function bad(x: number): void {
          if (x > 0) return;
          const y = x + 1;
        }
        declare const a: number;
        bad(a);
        `,
        { pluginOptions: { strict: true, rules: { inline: true } } },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
      expect(diagnostics[0].code).toBe(90001);
    });
  });

  describe("per-rule inline.strict: false overrides global strict: true", () => {
    it("keeps warning when per-rule strict is false", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function effect(x: number): number {
          const y = x + 1;
          return y * 2;
        }
        declare const a: number;
        const r = effect(a) + 1;
        `,
        {
          pluginOptions: {
            strict: true,
            rules: { inline: { strict: false } },
          },
        },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(diagnostics[0].code).toBe(90001);
    });
  });

  describe("per-rule inline.strict: true with global strict: false promotes to error", () => {
    it("promotes to error when only per-rule strict is true", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function effect(x: number): number {
          const y = x + 1;
          return y * 2;
        }
        declare const a: number;
        const r = effect(a) + 1;
        `,
        {
          pluginOptions: {
            strict: false,
            rules: { inline: { strict: true } },
          },
        },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
      expect(diagnostics[0].code).toBe(90001);
    });
  });
});
