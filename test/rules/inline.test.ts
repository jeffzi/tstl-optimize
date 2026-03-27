import { describe, expect, it } from "vitest";
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
  });

  describe("negative: not inlined", () => {
    it("does not inline without @inline tag", () => {
      const lua = compile(`
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("double(");
    });

    it("does not inline multi-statement body", () => {
      const lua = compile(`
        /** @inline */
        function compute(x: number) {
          const tmp = x * 2;
          return tmp + 1;
        }
        declare const a: number;
        const r = compute(a);
      `);
      expect(lua).toContain("compute(");
    });

    it("does not inline when side-effecting arg is used multiple times", () => {
      const lua = compile(`
        /** @inline */
        function square(x: number) { return x * x; }
        declare function foo(): number;
        const r = square(foo());
      `);
      expect(lua).toContain("square(");
    });

    it("does not inline rest parameters", () => {
      const lua = compile(`
        /** @inline */
        function first(...args: number[]) { return args[0]; }
        const r = first(1, 2, 3);
      `);
      expect(lua).toContain("first(");
    });

    it("does not inline optional parameters", () => {
      const lua = compile(`
        /** @inline */
        function maybe(x?: number) { return x; }
        const r = maybe(5);
      `);
      expect(lua).toContain("maybe(");
    });

    it("does not inline default parameters", () => {
      const lua = compile(`
        /** @inline */
        function withDefault(x: number = 0) { return x; }
        const r = withDefault(5);
      `);
      expect(lua).toContain("withDefault(");
    });

    it("does not inline closure capture from non-module scope", () => {
      const lua = compile(`
        function outer() {
          const captured = 10;
          /** @inline */
          function inner(x: number) { return x + captured; }
          return inner(5);
        }
      `);
      expect(lua).toContain("inner(");
    });

    it("does not inline when parameter is written inside body", () => {
      const lua = compile(`
        /** @inline */
        function f(x: number) { return (x = 1, x); }
        const result = f(0);
      `);
      expect(lua).toContain("f(");
    });

    it("does not inline recursive function", () => {
      const lua = compile(`
        /** @inline */
        function recurse(x: number): number { return recurse(x); }
        const r = recurse(5);
      `);
      expect(lua).toContain("recurse(");
    });
  });

  describe("comment cleanup", () => {
    it("strips @inline JSDoc comment from function declaration", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).not.toContain("@inline");
    });

    it("strips @inline JSDoc comment from arrow function", () => {
      const lua = compile(`
        /** @inline */
        const double = (x: number) => x * 2;
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).not.toContain("@inline");
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
    it("warns on multi-statement body", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function compute(x: number) {
          const tmp = x * 2;
          return tmp + 1;
        }
        declare const a: number;
        const r = compute(a);
      `);
      expect(lua).toContain("compute(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("single return statement");
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
      const { diagnostics } = compileWithDiagnostics(`
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(diagnostics).toHaveLength(0);
    });
  });

  describe("cross-module", () => {
    it("does not inline cross-module function with free variables", () => {
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
      expect(diagnostics[0].messageText).toContain("cross-module");
    });

    it("does not inline cross-module function even when self-contained", () => {
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
      expect(lua).toContain("double(");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("cross-module");
    });

    it("warns with correct diagnostic metadata", () => {
      const { diagnostics } = compileMultiFileWithDiagnostics({
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
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("cross-module inlining is not supported");
      expect(diagnostics[0].category).toBe(0); // ts.DiagnosticCategory.Warning
      expect(diagnostics[0].source).toBe("tstl-optimize");
    });
  });
});
