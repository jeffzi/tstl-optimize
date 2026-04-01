import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  compile,
  compileMultiFileWithDiagnostics,
  compileWithDiagnostics,
  normalizeLua,
} from "../helpers";

describe("inline", () => {
  describe("positive: inlined", () => {
    it("inlines function declaration", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
    });

    it("inlines arrow function", () => {
      const lua = compile(`
        /** @inline */
        const double = (x: number) => x * 2;
        declare const a: number;
        const r = double(a);
      `);
      expect(lua).toContain("a * 2");
    });

    it("inlines multi-param call with literal args", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function add(a: number, b: number) { return a + b; }
        const x = add(1, 2);
      `),
      );
      expect(lua).toContain("1 + 2");
    });

    it("inlines zero-param function", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function pi() { return 3.14; }
        const r = pi();
      `),
      );
      expect(lua).toContain("r = 3.14");
    });

    it("handles complex body expressions and precedence", () => {
      const lua = compile(`
        /** @inline */
        function inc(x: number) { return x + 1; }
        declare const a: number;
        const r = inc(a) * 2;
      `);
      expect(lua).toContain("(a + 1) * 2");
    });

    it("inlines side-effecting args used once", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare function foo(): number;
        const r = double(foo());
      `);
      expect(lua).toContain("foo() * 2");
    });
  });

  describe("expression-body deep clone", () => {
    it("substitutes nested property access used multiple times without corruption", () => {
      const lua = compile(`
        /** @inline */
        function mul(x: number): number { return x * x; }
        declare const obj: { a: { b: { c: number } } };
        const r = mul(obj.a.b.c);
      `);

      // substituteParams must deep-clone the argument for each occurrence.
      // With shallow clone (tstl.cloneNode), the two substituted positions
      // share child AST nodes (obj.a.b). A downstream pass mutating one copy
      // would corrupt the other. Verify both occurrences are correct.
      expect(lua).toContain("obj.a.b.c * obj.a.b.c");
    });
  });

  describe("void multi-statement inline", () => {
    it("expands body into do...end block", () => {
      const lua = compile(`
        /** @inline */
        function setup(x: number) { let a = x + 1; print(a); }
        setup(10);
      `);
      expect(lua).toContain("do");
      // It might use an arg temp: ____inline_arg_0 = 10
      expect(lua).toMatch(/10 \+ 1|____inline_arg_0 \+ 1/);
      expect(lua).not.toContain("setup(10)");
    });

    it("hoists arguments to temporaries to preserve order", () => {
      const lua = compile(`
        /** @inline */
        function foo(a: number, b: number) { print(a + b); }
        declare function s1(): number; declare function s2(): number;
        foo(s1(), s2());
      `);
      expect(lua).toContain("____inline_arg_0 = s1()");
      expect(lua).toContain("____inline_arg_1 = s2()");
    });
  });

  describe("return-value multi-statement inline", () => {
    it("expands const r = foo(x) to local r / do...end block", () => {
      const lua = compile(`
        /** @inline */
        function compute(x: number): number { const y = x + 1; return y * 2; }
        const r = compute(10);
      `);
      expect(lua).toContain("local r");
      expect(lua).toContain("do");
      expect(lua).toContain("r = y * 2");
    });

    it("expands return foo(x) to flat sequence", () => {
      const lua = compile(`
        /** @inline */
        function compute(x: number): number { const y = x + 1; return y * 2; }
        function caller() { return compute(10); }
      `);
      // No do...end block should be present at return sites
      expect(lua).not.toMatch(/\bdo\b/);
      expect(lua).toMatch(/10 \+ 1|____inline_arg_0 \+ 1/);
      expect(lua).toContain("return y * 2");
    });

    it("uses temp variable when body local collides with outer binding name", () => {
      const lua = compile(`
        /** @inline */
        function fn(x: number): number {
          let result = x + 1;
          return result;
        }
        declare const n: number;
        const result = fn(n);
      `);
      // When the inlined body declares a local named "result" — the same name as the
      // call-site binding — the expander must use a collision-safe temp inside the
      // do...end block. Otherwise the inner local shadows the result variable,
      // turning the return assignment into a no-op.
      expect(lua).toContain("do");
      expect(lua).toMatch(/local result = ____inline_result_\d+/);
    });
  });

  describe("switch with break in body", () => {
    it("inlines multi-statement body with switch containing break", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function classify(x: number): void {
          let label: string;
          switch (x) {
            case 0: label = "zero"; break;
            case 1: label = "one"; break;
            default: label = "other"; break;
          }
          print(label);
        }
        declare const n: number;
        classify(n);
      `);

      const pluginWarnings = diagnostics.filter(
        (d) => d.category === ts.DiagnosticCategory.Warning,
      );
      expect(pluginWarnings).toHaveLength(0);
      expect(lua).toContain("do");
    });

    it("inlines statementsWithReturn body with switch containing break", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function compute(x: number): string {
          let result: string;
          switch (x) {
            case 0: result = "zero"; break;
            default: result = "other"; break;
          }
          return result;
        }
        declare const n: number;
        const label = compute(n);
      `);

      const pluginWarnings = diagnostics.filter(
        (d) => d.category === ts.DiagnosticCategory.Warning,
      );
      expect(pluginWarnings).toHaveLength(0);
      expect(lua).toContain("do");
    });
  });

  describe("warnings and rejections", () => {
    it.each([
      { body: "if (x > 0) return; print(x);", name: "early return" },
      { body: "break;", name: "break" },
      { body: "continue;", name: "continue" },
    ])("rejects bodies with $name", ({ body }) => {
      const { diagnostics } = compileWithDiagnostics(`
          /** @inline */
          function f(x: number) { ${body} }
          for (let i = 0; i < 10; i++) f(i);
        `);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].messageText).toContain("@inline ignored");
    });

    it.each([
      { decl: "function f(...args: any[]) {}", name: "rest parameters" },
      { decl: "function f(x?: number) {}", name: "optional parameters" },
      { decl: "function f(x: number = 0) {}", name: "default parameters" },
    ])("rejects unsupported $name", ({ decl }) => {
      const { diagnostics } = compileWithDiagnostics(`
          /** @inline */
          ${decl}
          f();
        `);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].messageText).toContain("not supported");
    });

    it("warns on multi-statement body at expression position", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number) { const y = x + 1; return y; }
        const r = f(1) + 1;
      `);
      expect(diagnostics[0].messageText).toContain("cannot be inlined at expression position");
    });

    it("warns on side-effect duplication", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number) { return x * x; }
        declare function foo(): number;
        f(foo());
      `);
      expect(diagnostics[0].messageText).toContain("side effects");
    });
  });

  describe("cross-module", () => {
    it("inlines self-contained functions", () => {
      const { lua } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          /** @inline */
          export function double(x: number) { return x * 2; }
        `,
        "main.ts": `
          import { double } from "./utils";
          const r = double(10);
        `,
      });
      expect(lua).toContain("10 * 2");
    });

    it("rejects functions with free variables", () => {
      const { diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          const factor = 10;
          /** @inline */
          export function f(x: number) { return x * factor; }
        `,
        "main.ts": `
          import { f } from "./utils";
          f(1);
        `,
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("non-parameter");
    });
  });

  describe("destructuring parameter rejection", () => {
    it.each([
      {
        name: "object destructuring",
        decl: "function f({ x, y }: { x: number; y: number }) { return x + y; }",
        call: "f({ x: 1, y: 2 });",
      },
      {
        name: "array destructuring",
        decl: "function f([a, b]: [number, number]) { return a + b; }",
        call: "f([1, 2]);",
      },
    ])("rejects $name parameter", ({ decl, call }) => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        ${decl}
        ${call}
      `);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("destructuring parameters are not supported");
    });
  });

  describe("LuaMultiReturn destructuring", () => {
    it("preserves all values when destructuring multi-return inline function", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
          const tmp = a;
          return $multi(b, tmp);
        }
        declare const x: number;
        declare const y: number;
        const [p, q] = swap(x, y);
      `);
      const warnings = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning);
      expect(warnings).toHaveLength(0);
      // The multi-statement body should be inlined: the call should be expanded,
      // not left as a plain function call. The function definition is stripped by
      // TSTL for @inline-annotated functions, so leaving the call un-expanded
      // produces a reference to an undefined function.
      expect(lua).not.toContain("swap(");
      // After inlining, both destructured variables must receive values.
      // A correct expansion must NOT assign multi-return to a single temp variable
      // (in Lua, "a, b = singleVar" sets b to nil).
      const brokenPattern = /\w+, \w+ = ____inline_result_\d+$/m;
      expect(lua).not.toMatch(brokenPattern);
    });
  });

  describe("strict mode", () => {
    it("promotes warnings to errors when strict: true", () => {
      const { diagnostics } = compileWithDiagnostics(
        `
        /** @inline */
        function f(x: number) { return x * x; }
        declare function foo(): number;
        f(foo());
      `,
        { pluginOptions: { strict: true } },
      );
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });
  });
});
