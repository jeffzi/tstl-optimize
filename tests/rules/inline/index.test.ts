import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors, mapLuaStatements } from "../../../src/rules/inline";
import { isPureAtVoidSite } from "../../../src/rules/inline/eligibility";
import { walkLuaExpression, walkLuaNodes } from "../../../src/rules/inline/lua-substitute";
import { compile, compileWithDiagnostics, normalizeLua } from "../../helpers";

describe("inline", () => {
  describe("void-site purity", () => {
    function parseCallArguments(code: string): ts.NodeArray<ts.Expression> {
      const src = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
      const stmt = src.statements[0];
      if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) {
        throw new Error("Expected call expression statement");
      }
      return stmt.expression.arguments;
    }

    it.each([
      { name: "spread argument with pure inner", code: "keep(...items);" },
      { name: "object spread argument with pure inner", code: "keep({ ...obj });" },
    ])("treats $name as pure at a void site", ({ code }) => {
      const args = parseCallArguments(code);
      expect(isPureAtVoidSite(ts.factory.createIdentifier("value"), args)).toBe(true);
    });
  });

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
      // Constant folding reduces 1 + 2 to 3
      expect(lua).toContain("(3)");
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

    it.each([
      {
        desc: "identity body",
        body: "x",
        fixture: `
          /** @inline */
          function f(x: number) { return x; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "transparent cast body",
        body: "x as unknown",
        fixture: `
          /** @inline */
          function f(x: number) { return x as unknown; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "param multiplied",
        body: "x * 2",
        fixture: `
          /** @inline */
          function f(x: number) { return x * 2; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "param added left",
        body: "x + 1",
        fixture: `
          /** @inline */
          function f(x: number) { return x + 1; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "pure const + param right",
        body: "1 + x",
        fixture: `
          /** @inline */
          function f(x: number) { return 1 + x; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "param property access",
        body: "x.field",
        fixture: `
          /** @inline */
          function f(x: { field: number }) { return x.field; }
          declare function foo(): { field: number };
          const r = f(foo());
        `,
      },
      {
        desc: "template literal pure span before param",
        fixture: `
          /** @inline */
          function f(x: string) { return \`\${0}\` + x; }
          declare function foo(): string;
          const r = f(foo());
        `,
      },
      {
        desc: "array literal with param at tail",
        fixture: `
          /** @inline */
          function f(x: number) { return [1, x]; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "nested array (pure) before param — array traversal returns undefined",
        fixture: `
          /** @inline */
          function f(x: number) { return { precomputed: [1, 2], val: x }; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "nested object (pure) before param — inner object traversal returns undefined",
        fixture: `
          /** @inline */
          function f(x: number) { return { meta: { a: 1 }, val: x }; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "method in object before param — method definition is pure",
        fixture: `
          /** @inline */
          function f(x: number) { return { greet() { return 0; }, val: x }; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "conditional (neither branch has param or SE) before param",
        fixture: `
          /** @inline */
          function f(x: number) { return (flag ? 0 : 1) + x; }
          declare const flag: boolean;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "function expression before param — closure definition is pure",
        fixture: `
          /** @inline */
          function f(x: number) { return { fn: function() { return 0; }, val: x }; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "pure computed property key before param",
        fixture: `
          /** @inline */
          function f(x: number) { return { ["key"]: 1, val: x }; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "negate param (pure prefix unary, not increment)",
        fixture: `
          /** @inline */
          function f(x: number) { return -x; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "param as element-access object",
        fixture: `
          /** @inline */
          function f(x: number[]) { return x[0]; }
          declare function foo(): number[];
          const r = f(foo());
        `,
      },
      {
        desc: "param as element-access index (obj is free var)",
        fixture: `
          /** @inline */
          function f(x: number) { return obj[x]; }
          declare const obj: Record<number, number>;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "param as call callee",
        fixture: `
          /** @inline */
          function f(x: () => number) { return x(); }
          declare function foo(): () => number;
          const r = f(foo());
        `,
      },
      {
        desc: "template literal with param in span",
        fixture: `
          /** @inline */
          function f(x: number) { return \`\${x}!\`; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "tagged template with param in span",
        fixture: `
          /** @inline */
          function f(x: number) { return tag\`\${x}\`; }
          declare function tag(s: TemplateStringsArray, ...values: number[]): string;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "new expression with param as arg (after pure arg)",
        fixture: `
          /** @inline */
          function f(x: number) { return new Foo(1, x); }
          declare class Foo { constructor(n: number, m: number); }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
    ])("skips IIFE wrapper when body has no SE before param first use: $desc", ({ fixture }) => {
      const lua = compile(fixture);
      // Should NOT contain IIFE/eager-temp marker
      expect(lua).not.toContain("____inline_arg_");
      // The arg should appear directly in output
      expect(lua).toContain("foo()");
    });

    it("inlines side-effecting args used once", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare function foo(): number;
        const r = double(foo());
      `);
      expect(lua).not.toContain("____inline_arg_");
      expect(lua).toContain("foo()");
      expect(lua).toContain("* 2");
    });

    it("compiles real const init to Lua code (property access example)", () => {
      const lua = compile(`
        /** @inline */
        function mul(x: number): number { return x * x; }
        const stats = { atk: { base: 100 } };
        const atkSquared = mul(stats.atk.base);
      `);
      // stats table must be defined in Lua output (main fix: const initializer generates code)
      expect(lua).toContain("stats = {");
      expect(lua).toContain("base = 100");
    });

    describe("optional parameters", () => {
      it.each<{ name: string; code: string; assertions: (lua: string) => void }>([
        {
          name: "single optional param when arg supplied",
          code: `
            /** @inline */
            const f = (x?: number) => (x ?? 0) + 1;
            declare const a: number;
            const r = f(a);
          `,
          assertions: (lua) => {
            expect(lua).not.toContain("f(");
            expect(lua).toContain("a");
          },
        },
        {
          name: "single optional param when arg omitted",
          code: `
            /** @inline */
            const f = (x?: number) => (x ?? 0) + 1;
            const r = f();
          `,
          assertions: (lua) => {
            expect(lua).not.toContain("f(");
            expect(lua).toContain("nil");
          },
        },
      ])("inlines expression-body with $name", ({ code, assertions }) => {
        const lua = compile(code);
        assertions(lua);
      });

      it.each<{ name: string; code: string }>([
        {
          name: "all supplied",
          code: `
            /** @inline */
            function add(a: number, b?: number): number { return a + (b ?? 0); }
            declare const x: number;
            declare const y: number;
            const r = add(x, y);
          `,
        },
        {
          name: "optional is omitted",
          code: `
            /** @inline */
            function add(a: number, b?: number): number { return a + (b ?? 0); }
            declare const x: number;
            const r = add(x);
          `,
        },
      ])("inlines with mixed required and optional params when $name", ({ code }) => {
        const lua = compile(code);
        expect(lua).not.toContain("add(");
        expect(lua).toContain("x");
      });

      it("inlines statement-body with optional param at variable-declaration site", () => {
        const lua = compile(`
          /** @inline */
          function process(val: number, flag?: boolean): number {
            const adjusted = flag ? val * 2 : val;
            return adjusted + 1;
          }
          declare const n: number;
          declare const f: boolean;
          const result = process(n, f);
        `);
        expect(lua).not.toContain("process(");
      });

      it("enforces side-effects for supplied optional args", () => {
        const { diagnostics } = compileWithDiagnostics(`
          /** @inline */
          function use(x?: number): number { return (x ?? 0) + (x ?? 0); }
          declare function sideEffect(): number;
          const r = use(sideEffect());
        `);
        const hasDiagnostic = diagnostics.some(
          (d) =>
            String(d.messageText).includes("side effect") ||
            String(d.messageText).includes("argument"),
        );
        expect(hasDiagnostic).toBe(true);
      });

      it("eagerly evaluates supplied args before omitted optional params can short-circuit them", () => {
        const lua = normalizeLua(
          compile(`
            declare function sideEffect(): number;

            /** @inline */
            function f(a: number, b?: boolean): unknown {
              return b && a;
            }

            const r = f(sideEffect());
          `),
        );

        expect(lua).not.toContain("f(");
        expect(lua).toMatch(/local ____inline_arg_\d+ = sideEffect\(\)/);
        expect(lua).not.toContain("nil and sideEffect()");
      });

      it("inlines with multiple optionals when only some are supplied", () => {
        const lua = compile(`
          /** @inline */
          function f(a: number, b?: number, c?: number): number {
            return a + (b ?? 0) + (c ?? 0);
          }
          declare const x: number;
          const r = f(x, 10);
        `);
        expect(lua).not.toContain("f(");
        expect(lua).toContain("x");
        expect(lua).toContain("10");
      });

      it("inlines statement-body with optional omitted at expression-statement position", () => {
        const lua = compile(`
          declare function print(x: unknown): void;
          /** @inline */
          function greet(name?: string): void {
            if (name) { print(name); }
          }
          greet();
        `);
        expect(lua).not.toContain("greet(");
      });

      it("inlines statement-body with optional omitted at return position", () => {
        const lua = compile(`
          /** @inline */
          function maybe(x?: number): number {
            const v = x ?? 42;
            return v;
          }
          function test(): number { return maybe(); }
        `);
        expect(lua).not.toContain("maybe(");
      });

      it.each<{ name: string; code: string }>([
        {
          name: "too many args",
          code: `
            /** @inline */
            function f(x: number, y?: number): number { return x + (y ?? 0); }
            // @ts-ignore exercising plugin validation after type-check suppression
            const r = f(1, 2, 3);
          `,
        },
        {
          name: "missing required args",
          code: `
            /** @inline */
            function f(x: number, y?: number): number { return x + (y ?? 0); }
            // @ts-ignore exercising plugin validation after type-check suppression
            const r = f();
          `,
        },
      ])("rejects call with $name", ({ code }) => {
        const { diagnostics } = compileWithDiagnostics(code);
        const hasArgumentCountError = diagnostics.some((d) =>
          String(d.messageText).includes("argument count"),
        );
        expect(hasArgumentCountError).toBe(true);
      });

      it("inlines nested calls when inner function has optional param omitted", () => {
        const lua = compile(`
          /** @inline */
          function g(x?: number) { return 42; }
          /** @inline */
          function f(x: number) { return x + 1; }
          const r = f(g());
        `);
        expect(lua).not.toContain("f(");
        expect(lua).not.toContain("g(");
      });
    });
  });

  describe("expression-body deep clone", () => {
    it("preserves nested property access used multiple times to avoid duplicating getters", () => {
      const lua = compile(`
        /** @inline */
        function mul(x: number): number { return x * x; }
        declare const obj: { a: { b: { c: number } } };
        const r = mul(obj.a.b.c);
      `);

      expect(lua).toContain("mul(obj.a.b.c)");
    });

    it("preserves closure capture through the call-site temp", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function capture(x: number) {
          return () => x;
        }

        let x = 1;
        const g = capture(x);
        x = 2;
      `),
      );

      expect(lua).toMatch(/____inline_arg_\d+ = x/);
      expect(lua).toMatch(/return function\(\) return ____inline_arg_\d+ end/);
      expect(lua).not.toContain("g = function() return x end");
    });
  });

  describe("void multi-statement inline", () => {
    it("expands body into do...end block", () => {
      const lua = compile(`
        declare function print(...args: unknown[]): void;
        /** @inline */
        function setup(x: number) { let a = x + 1; print(a); }
        setup(10);
      `);
      expect(lua).toContain("do");
      expect(lua).toMatch(/11|10 \+ 1|____inline_arg_\d+ \+ 1/);
      expect(lua).not.toContain("setup(10)");
    });

    it("hoists arguments to temporaries to preserve order", () => {
      const lua = compile(`
        declare function print(...args: unknown[]): void;
        /** @inline */
        function foo(a: number, b: number) { print(a + b); }
        declare function s1(): number; declare function s2(): number;
        foo(s1(), s2());
      `);
      expect(lua).toMatch(/____inline_arg_\d+ = s1\(\)/);
      expect(lua).toMatch(/____inline_arg_\d+ = s2\(\)/);
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
      expect(lua).not.toMatch(/\bdo\b/);
      expect(lua).toMatch(/11|10 \+ 1|____inline_arg_\d+ \+ 1/);
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

    it("uses temp variable when body function declaration collides with outer binding name", () => {
      const lua = compile(`
        /** @inline */
        function fn(x: number): number {
          function result() {}
          return x + 1;
        }
        declare const n: number;
        const result = fn(n);
      `);
      // A function declaration inside the inlined body named "result" must be detected
      // as a collision — same as a variable declaration — so the expander uses a temp.
      expect(lua).toContain("do");
      expect(lua).toMatch(/local result = ____inline_result_\d+/);
    });

    it("uses temp variable when a nested block declares the outer binding name", () => {
      const lua = compile(`
        /** @inline */
        function fn(x: number): number {
          if (x > 0) {
            function result() {}
            result();
          }
          return x + 1;
        }
        declare const n: number;
        const result = fn(n);
      `);

      expect(lua).toContain("do");
      expect(lua).toMatch(/local result = ____inline_result_\d+/);
    });

    it.each([
      {
        name: "switch case block",
        body: `
          switch (x) {
            case 0: {
              const result = 1;
              break;
            }
          }
        `,
      },
      {
        name: "try/finally block",
        body: `
          try {
            const result = x;
          } finally {
            const cleanup = x + 1;
          }
        `,
      },
      {
        name: "catch block",
        body: `
          try {
            const value = x;
          } catch {
            const result = x + 1;
          }
        `,
      },
      {
        name: "finally block",
        body: `
          try {
            const value = x;
          } finally {
            const result = x + 1;
          }
        `,
      },
      {
        name: "while loop body",
        body: `
          let done = false;
          while (!done) {
            const result = x;
            done = true;
          }
        `,
      },
      {
        name: "for-of loop body",
        body: `
          for (const entry of [x]) {
            const result = entry;
          }
        `,
      },
    ])("uses a temp when $name declares the outer binding name", ({ body }) => {
      const lua = compile(`
        /** @inline */
        function fn(x: number): number {
          ${body}
          return x + 1;
        }
        declare const n: number;
        const result = fn(n);
      `);

      expect(lua).toContain("do");
      expect(lua).toMatch(/local result = ____inline_result_\d+/);
    });

    it("preserves binding declaration with correct symbol ID when body local collides", () => {
      const lua = compile(`
        /** @inline */
        function add(a: { n: number; dense: number[] }, index: number): number {
          const di = a.n;
          a.dense[di] = index;
          a.n = di + 1;
          return di;
        }
        function spawn(a: { n: number; dense: number[]; entities: number[] }, index: number, id: number): void {
          const di = add(a, index);
          a.entities[di] = id;
        }
      `);

      // Regression: binding must reuse call-site variable's symbol ID, otherwise
      // dead-local removes it and outer code reads nil instead of the collision-safe value.
      expect(lua).toMatch(/local di = ____inline_result_\d+/);
      expect(lua).toMatch(/a\.entities\[di\b/);

      // Verify the temp is reassigned back to di in the binding declaration
      const collisionTempMatch = lua.match(/local di = (____inline_result_\d+)/);
      expect(collisionTempMatch).not.toBeNull();
      if (collisionTempMatch?.[1]) {
        const tempName = collisionTempMatch[1];
        expect(lua).toMatch(new RegExp(`\\bdi = ${tempName}\\b|local di = ${tempName}\\b`));
      }
    });
  });

  describe("direct argument substitution", () => {
    describe("simple args bypass temp variables", () => {
      it("Case A: single identifier arg substitutes directly — no ____inline_arg_ temp", () => {
        const lua = compile(`
          /** @inline */
          function f(x: number): number {
            const a = x * 2;
            return a;
          }
          declare const v: number;
          const r = f(v);
        `);
        expect(lua).not.toContain("____inline_arg_");
        expect(lua).toContain("v * 2");
      });

      it("Case B: all identifier args substitute directly — no ____inline_arg_ temps", () => {
        const lua = compile(`
          /** @inline */
          function f(x: number, y: number): number {
            const a = y * 2;
            const b = a + 1;
            return b + x;
          }
          declare const u: number;
          declare const v: number;
          const r = f(u, v);
        `);
        expect(lua).not.toContain("____inline_arg_");
        expect(lua).toContain("v * 2");
        expect(lua).toContain("u");
      });

      it("Case C: literal arg substitutes directly — no ____inline_arg_ temp", () => {
        const lua = compile(`
          /** @inline */
          function f(x: number): number {
            const a = x + 1;
            return a;
          }
          const r = f(10);
        `);
        expect(lua).not.toContain("____inline_arg_");
        expect(lua).toMatch(/11|10 \+ 1/);
      });

      it("Case D: caller function params passed as identifier args — no ____inline_arg_ temps", () => {
        const lua = compile(`
          /** @inline */
          function resolve(storage: { world: any }, id: number): number {
            const w = storage.world;
            return w.entity_dense[id];
          }
          function caller(storage: { world: any; entity_dense: number[] }, id: number): number {
            const di = resolve(storage, id);
            return storage.entity_dense[di];
          }
        `);
        expect(lua).not.toContain("____inline_arg_");
        expect(lua).toContain("storage.world");
        expect(lua).toContain("id");
      });
    });

    describe("side-effectful args still create temps (no regression)", () => {
      it("Case E: both args have side effects — temps MUST be created for both", () => {
        const lua = compile(`
          /** @inline */
          function f(x: number, y: number): number {
            const a = x + y;
            return a;
          }
          declare function s1(): number;
          declare function s2(): number;
          const r = f(s1(), s2());
        `);
        expect(lua).toMatch(/____inline_arg_\d+.*= s1\(\)/);
        expect(lua).toMatch(/____inline_arg_\d+.*= s2\(\)/);
      });

      it("Case F: earlier identifier arg gets a temp when a later arg has side effects", () => {
        const lua = compile(`
          /** @inline */
          function f(x: number, y: number): number {
            const a = x + y;
            return a;
          }
          declare const v: number;
          declare function se(): number;
          const r = f(v, se());
        `);
        // v (arg 0) must be temped because se() (arg 1) has side effects
        // and se() runs after v in left-to-right evaluation, potentially
        // mutating the variable that v refers to.
        expect(lua).toMatch(/____inline_arg_\d+.*= v\b/);
        expect(lua).toMatch(/____inline_arg_\d+.*= se\(\)/);
      });
    });
  });

  describe("switch with break in body", () => {
    function expectInlinedWithoutWarnings(source: string): void {
      const { lua, diagnostics } = compileWithDiagnostics(source);
      expect(diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning)).toHaveLength(
        0,
      );
      expect(lua).toContain("do");
    }

    it("inlines multi-statement body with switch containing break", () => {
      expectInlinedWithoutWarnings(`
        declare function print(...args: unknown[]): void;
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
    });

    it("inlines statementsWithReturn body with switch containing break", () => {
      expectInlinedWithoutWarnings(`
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
    });
  });

  describe("warnings and rejections", () => {
    it.each([
      { body: "if (x > 0) return; print(x);", name: "early return", skipLuaCheck: false },
      // TSTL emits bare `break` in a function body (outside any loop) — invalid Lua, unavoidable.
      { body: "// @ts-ignore\nbreak;", name: "break", skipLuaCheck: true },
      { body: "// @ts-ignore\ncontinue;", name: "continue", skipLuaCheck: true },
    ])("rejects bodies with $name", ({ body, skipLuaCheck }) => {
      const { diagnostics } = compileWithDiagnostics(
        `
          declare function print(...args: unknown[]): void;
          /** @inline */
          function f(x: number) { ${body} }
          for (let i = 0; i < 10; i++) f(i);
        `,
        { skipLuaCheck },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("@inline ignored");
    });

    it.each([
      { decl: "function f(...args: unknown[]) {}", name: "rest parameters" },
      { decl: "function f(x: number = 0) {}", name: "default parameters" },
    ])("rejects unsupported $name", ({ decl }) => {
      const { diagnostics } = compileWithDiagnostics(`
          /** @inline */
          ${decl}
          f();
        `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("not supported");
    });

    it("warns on multi-statement body at expression position", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number) { const y = x + 1; return y; }
        const r = f(1) + 1;
      `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("cannot be inlined at expression position");
    });

    it.each([
      {
        name: "argument count mismatch",
        source: `
          /** @inline */
          function add(a: number, b: number) { return a + b; }
          // @ts-ignore exercising plugin validation after type-check suppression
          add(1);
        `,
        expected: "argument count does not match parameter count",
      },
      {
        name: "nested declaration",
        source: `
          function outer(value: number) {
            /** @inline */
            function inner(x: number) { return x * 2; }
            return inner(value);
          }
        `,
        expected: "function must be declared at module scope",
      },
      {
        name: "recursive expression body",
        source: `
          /** @inline */
          function recurse(x: number): number { return recurse(x); }
          recurse(1);
        `,
        expected: "recursive functions cannot be inlined",
      },
      {
        name: "parameter write in expression body",
        source: `
          /** @inline */
          const bump = (x: number) => ++x;
          bump(1);
        `,
        expected: "parameter is written inside body",
      },
    ])("rejects $name", ({ expected, source }) => {
      const { diagnostics } = compileWithDiagnostics(source);

      expect(
        diagnostics.some((diagnostic) => String(diagnostic.messageText).includes(expected)),
      ).toBe(true);
    });

    it("warns on side-effect duplication", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function f(x: number) { return x * x; }
        declare function foo(): number;
        f(foo());
      `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("side effects");
    });

    describe("zero-usage param with side-effecting arg", () => {
      it("rejects inlining and emits a side-effect diagnostic", () => {
        const { diagnostics } = compileWithDiagnostics(`
          /** @inline */
          function f(_x: number) { return 42; }
          declare function sideEffect(): number;
          f(sideEffect());
        `);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].messageText).toContain("side effects");
      });
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

    it("inlines expression-bodied arrow multi-return functions at array destructuring sites", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        const swap = (a: number, b: number): LuaMultiReturn<[number, number]> => $multi(b, a);
        declare const x: number;
        declare const y: number;
        const [p, q] = swap(x, y);
      `);

      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("swap(");
      expect(lua).toMatch(/local p, q = .*____inline_result_/);
    });

    it("preserves return-site context when directly returning an inlined multi-return call", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
          return $multi(b, a);
        }

        function pair(x: number, y: number): LuaMultiReturn<[number, number]> {
          return swap(x, y);
        }
      `);

      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("swap(");
      expect(lua).toMatch(/return (y|____inline_arg_1), (x|____inline_arg_0)/);
    });

    it("inlines expression-bodied arrow multi-return functions at return sites", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        const swap = (a: number, b: number): LuaMultiReturn<[number, number]> => $multi(b, a);

        function pair(x: number, y: number): LuaMultiReturn<[number, number]> {
          return swap(x, y);
        }
      `);

      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("swap(");
      expect(lua).toMatch(/return (y|____inline_arg_1), (x|____inline_arg_0)/);
    });

    it("inlines block-bodied arrow multi-return functions at return sites", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        const swap = (a: number, b: number): LuaMultiReturn<[number, number]> => {
          const tmp = a;
          return $multi(b, tmp);
        };

        function pair(x: number, y: number): LuaMultiReturn<[number, number]> {
          return swap(x, y);
        }
      `);

      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("swap(");
      expect(lua).toMatch(/return (y|____inline_arg_1), (x|tmp|____inline_arg_0)/);
    });

    it("preserves argument evaluation order for block-bodied arrow destructuring sites", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        declare function s1(): number;
        declare function s2(): number;

        /** @inline */
        const swap = (a: number, b: number): LuaMultiReturn<[number, number]> => {
          const tmp = a;
          return $multi(b, tmp);
        };

        const [p, q] = swap(s1(), s2());
      `);

      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("swap(");
      expect(lua).toMatch(/____inline_arg_\d+ = s1\(\)/);
      expect(lua).toMatch(/____inline_arg_\d+ = s2\(\)/);
      expect(lua).toMatch(/local p, q = .*____inline_result_/);
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
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });
  });

  describe("export block detection", () => {
    it.each([
      {
        name: "function declaration via export { name }",
        decl: "function double(x: number) { return x * 2; }",
        exportStmt: "export { double };",
      },
      {
        name: "arrow function via export { name }",
        decl: "const double = (x: number) => x * 2;",
        exportStmt: "export { double };",
      },
      {
        name: "function declaration via export { name as alias }",
        decl: "function double(x: number) { return x * 2; }",
        exportStmt: "export { double as myDouble };",
      },
    ])("preserves and inlines $name", ({ decl, exportStmt }) => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        ${decl}
        declare const a: number;
        const r = double(a);
        ${exportStmt}
      `);

      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({ category: ts.DiagnosticCategory.Warning }),
      );
      expect(lua).toContain("function double");
      expect(lua).toContain("a * 2");
    });

    it("preserves definition when there is no local call site", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function double(x: number) { return x * 2; }
        export { double };
      `);

      expect(diagnostics).not.toContainEqual(
        expect.objectContaining({ category: ts.DiagnosticCategory.Warning }),
      );
      // Without the definition, ____exports.double would reference an undefined local.
      expect(lua).toContain("function double");
    });
  });
});

describe("inline: Lua AST utilities", () => {
  it("maps method-call, conditional, for-loop, and return Lua nodes", () => {
    const statements = mapLuaStatements(
      [
        tstl.createExpressionStatement(
          tstl.createMethodCallExpression(
            tstl.createIdentifier("receiver"),
            tstl.createIdentifier("run"),
            [tstl.createIdentifier("param")],
          ),
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("result")],
          [
            tstl.createConditionalExpression(
              tstl.createIdentifier("param"),
              tstl.createNumericLiteral(1),
              tstl.createNumericLiteral(2),
            ),
          ],
        ),
        tstl.createForStatement(
          tstl.createBlock([tstl.createReturnStatement([tstl.createIdentifier("param")])]),
          tstl.createIdentifier("i"),
          tstl.createNumericLiteral(1),
          tstl.createNumericLiteral(3),
        ),
      ],
      (expr) =>
        tstl.isIdentifier(expr) && expr.text === "param"
          ? tstl.createIdentifier("mapped")
          : undefined,
    );

    const stmt0 = statements[0];
    const stmt1 = statements[1];
    const stmt2 = statements[2];
    if (
      !stmt0 ||
      !tstl.isExpressionStatement(stmt0) ||
      !tstl.isMethodCallExpression(stmt0.expression)
    ) {
      throw new Error("expected stmt0 to be ExpressionStatement(MethodCallExpression)");
    }
    if (
      !stmt1 ||
      !tstl.isVariableDeclarationStatement(stmt1) ||
      !stmt1.right?.[0] ||
      !tstl.isConditionalExpression(stmt1.right[0])
    ) {
      throw new Error(
        "expected stmt1 to be VariableDeclarationStatement with ConditionalExpression RHS",
      );
    }
    if (!stmt2 || !tstl.isForStatement(stmt2)) {
      throw new Error("expected stmt2 to be ForStatement");
    }

    const methodCall = stmt0.expression;
    const conditional = stmt1.right[0];
    const loopBody = stmt2.body.statements;
    const loopReturn = loopBody[0];
    if (!loopReturn || !tstl.isReturnStatement(loopReturn)) {
      throw new Error("expected loopReturn to be ReturnStatement");
    }

    const methodParam = methodCall.params[0];
    const loopExpression = loopReturn.expressions?.[0];
    if (!methodParam || !loopExpression) {
      throw new Error("expected mapped inline nodes");
    }

    expect(tstl.isIdentifier(methodParam) && methodParam.text).toBe("mapped");
    expect(tstl.isIdentifier(conditional.condition) && conditional.condition.text).toBe("mapped");
    expect(tstl.isIdentifier(loopExpression) && loopExpression.text).toBe("mapped");
  });

  it("walkLuaNodes visits conditional and for-loop nodes", () => {
    const visited: tstl.SyntaxKind[] = [];
    const record = (n: tstl.Node) => visited.push(n.kind);

    walkLuaNodes(
      [
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("v")],
          [
            tstl.createConditionalExpression(
              tstl.createIdentifier("c"),
              tstl.createNumericLiteral(1),
              tstl.createNumericLiteral(2),
            ),
          ],
        ),
        tstl.createForStatement(
          tstl.createBlock([tstl.createExpressionStatement(tstl.createIdentifier("body"))]),
          tstl.createIdentifier("i"),
          tstl.createNumericLiteral(0),
          tstl.createNumericLiteral(3),
        ),
      ],
      record,
    );

    expect(visited).toContain(tstl.SyntaxKind.ConditionalExpression);
    expect(visited).toContain(tstl.SyntaxKind.ForStatement);
  });

  it("walkLuaExpression visits conditional expression nodes", () => {
    const visited: tstl.SyntaxKind[] = [];
    walkLuaExpression(
      tstl.createConditionalExpression(
        tstl.createIdentifier("c"),
        tstl.createNumericLiteral(1),
        tstl.createNumericLiteral(2),
      ),
      (n) => visited.push(n.kind),
    );

    expect(visited).toContain(tstl.SyntaxKind.ConditionalExpression);
    expect(visited).toContain(tstl.SyntaxKind.NumericLiteral);
  });

  it("returns no visitors when inline is disabled", () => {
    const visitors = Reflect.apply(createVisitors, undefined, [
      {} as ts.TypeChecker,
      { rules: { inline: false } },
    ]);

    expect(visitors).toStrictEqual({});
  });

  it("returns undefined when direct visitors receive the wrong node kinds", () => {
    const visitors = Reflect.apply(createVisitors, undefined, [
      {} as ts.TypeChecker,
      { rules: { inline: true } },
    ]);
    const context = {} as tstl.TransformationContext;
    const sourceFile = ts.createSourceFile("inline.ts", "foo();", ts.ScriptTarget.Latest, true);
    const stmt0 = sourceFile.statements[0];
    if (!stmt0 || !ts.isExpressionStatement(stmt0)) {
      throw new Error("expected expression statement");
    }
    const expressionStatement = stmt0;
    if (!ts.isCallExpression(expressionStatement.expression)) {
      throw new Error("expected call expression");
    }
    const callNode = expressionStatement.expression;

    expect(
      Reflect.apply(Reflect.get(visitors, ts.SyntaxKind.CallExpression), undefined, [
        expressionStatement,
        context,
      ]),
    ).toBeUndefined();
    expect(
      Reflect.apply(Reflect.get(visitors, ts.SyntaxKind.ExpressionStatement), undefined, [
        callNode,
        context,
      ]),
    ).toBeUndefined();
    expect(
      Reflect.apply(Reflect.get(visitors, ts.SyntaxKind.VariableStatement), undefined, [
        sourceFile,
        context,
      ]),
    ).toBeUndefined();
    expect(
      Reflect.apply(Reflect.get(visitors, ts.SyntaxKind.ReturnStatement), undefined, [
        expressionStatement,
        context,
      ]),
    ).toBeUndefined();
    expect(
      Reflect.apply(Reflect.get(visitors, ts.SyntaxKind.FunctionDeclaration), undefined, [
        expressionStatement,
      ]),
    ).toBeUndefined();
  });
});

describe("inline rejection guard rails", () => {
  it("preserves recursive @inline function call", () => {
    const code = `
      /** @inline */
      function fact(n: number): number {
        if (n <= 1) return 1;
        return n * fact(n - 1);
      }
      export const x = fact(5);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("fact(5)");
  });

  it("preserves @inline function that writes parameter in return expression", () => {
    const code = `
      /** @inline */
      function foo(x: number): number {
        return (x = 1);
      }
      export const a = foo(5);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo(5)");
  });

  it("preserves @inline void function called in object literal", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function foo() { print(1); }
      // multi-stmt at expr position fails prereq
      export const x = { val: foo() };
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo()");
  });

  it("preserves @inline function with multi-statement body at expression position", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function foo() {
        print(1);
        return 2;
      }
      export const x = 1 + foo();
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo()");
  });

  it("preserves @inline function with return value when called at void site", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function foo() {
        print("side effect");
        return 1;
      }
      function test() {
        foo(); // Void site
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo()");
  });

  it("inlines multi-statement body at object destructuring site", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function getObj() { 
        print("side effect");
        return { a: 1, b: 2 }; 
      }
      function test() {
        const { a: myA, b } = getObj();
        return myA + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("side effect");
    expect(lua).toContain("myA");
    expect(lua).toContain("b");
  });

  it("preserves call when object destructuring has nested binding patterns", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function getObj() { 
        print("side effect");
        return { a: { b: 1 } }; 
      }
      function test() {
        const { a: { b } } = getObj();
        return b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("getObj()");
  });

  it("inlines multi-statement body at array destructuring site (non-multi-return)", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function getArr() { 
        print("side effect");
        return [1, 2]; 
      }
      function test() {
        const [x, y] = getArr();
        return x + y;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("unpack");
  });

  it("preserves @inline function containing try-catch", () => {
    // The inline rule cannot inline try-catch bodies (statements kind, VariableDeclaration
    // call site). The erasure guard keeps the declaration; TSTL compiles try-catch to pcall.
    const code = `
      declare function print(...args: unknown[]): void;
      /** @inline */
      function withTry() {
        try { return 1; } catch(e) { return 2; } finally { print(3); }
      }
      export const a = withTry();
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("withTry()");
  });
});

describe("inline: statement-position and argument handling", () => {
  describe("Expression-kind inline at statement position (handleExpressionStatement)", () => {
    // Pure expression-body inline at void site → drop entirely (no side effects)
    it("drops pure expression-body call at statement position", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        add(x, y);
      `;

      const lua = normalizeLua(compile(code));

      // The call add(x, y) should be inlined
      expect(lua).not.toContain("add(");
      // Pure expression x + y at void site should be dropped entirely
      expect(lua).not.toContain("x + y");
      // No invalid bare parenthesized expression statement
      expect(lua).not.toContain("(x + y)");
    });

    it.each<{ name: string; code: string; patterns: string[]; wrapperName: string }>([
      {
        name: "side-effectful body",
        wrapperName: "foo",
        patterns: ["sideEffect()"],
        code: `
          declare function sideEffect(): number;

          /** @inline */
          function foo(): number {
            return sideEffect();
          }

          foo();
        `,
      },
      {
        name: "side-effectful argument",
        wrapperName: "double",
        patterns: ["impure()"],
        code: `
          declare function impure(): number;

          /** @inline */
          function double(n: number): number {
            return n * 2;
          }

          double(impure());
        `,
      },
      {
        name: "both side-effectful body and argument",
        wrapperName: "compute",
        patterns: ["f(", "g()"],
        code: `
          declare function f(x: number): number;
          declare function g(): number;

          /** @inline */
          function compute(n: number): number {
            return f(n);
          }

          compute(g());
        `,
      },
    ])("preserves side effect from expression-body call with $name at statement position", ({
      code,
      patterns,
      wrapperName,
    }) => {
      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain(`${wrapperName}(`);
      for (const pattern of patterns) {
        expect.soft(lua).toContain(pattern);
      }
      expect(lua).not.toContain("local _ =");
      expect(lua).toMatch(/local ____inline_result_\d+ =/);
    });

    it("uses a collision-safe discard temp instead of shadowing an existing underscore local", () => {
      const lua = normalizeLua(
        compile(`
          let _ = 0;
          declare function effect(): number;

          /** @inline */
          function run(): number {
            return effect();
          }

          run();
          const result = _;
        `),
      );

      expect(lua).not.toContain("run()");
      expect(lua).toContain("effect()");
      expect(lua).toContain("result = _");
      expect(lua).not.toContain("local _ =");
      expect(lua).toMatch(/local ____inline_result_\d+ = effect\(\)/);
    });

    it("uses collision-safe discard temp for empty-body inline at void site with side-effectful arg", () => {
      // When conditional-compilation strips the entire body, side-effectful args
      // must still evaluate using a discard temp (____inline_result_N) to avoid
      // shadowing any user-defined underscore local.
      const lua = normalizeLua(
        compile(
          `
            const _ = 42;
            declare const STRIP: boolean;
            declare function sideEffect(): number;

            /** @inline */
            function run(arg: number): void {
              if (!STRIP) {
                const x = arg;
              }
            }

            run(sideEffect());
            const result = _;
          `,
          {
            pluginOptions: {
              rules: {
                "conditional-compilation": {
                  constants: { STRIP: { env: "TSTL_OPT_TEST_STRIP", default: true } },
                },
              },
            },
          },
        ),
      );

      expect(lua).not.toContain("run(");
      expect(lua).toContain("sideEffect()");
      expect(lua).toContain("result = _");
      expect(lua).not.toContain("local _ =");
      expect(lua).toMatch(/local ____inline_result_\d+/);
    });
  });

  describe("Return-value function at void site (statementsWithReturn)", () => {
    it("rejects return-value function called at expression statement position with diagnostic", () => {
      const code = `
        /** @inline */
        function getValue(x: number, y: number): number {
          const a = x + 1;
          const b = y + 1;
          return a + b;
        }

        function test() {
          getValue(1, 2);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("return-value function called at void site"),
        ),
      ).toBe(true);
    });
  });

  describe("Expression inline rejection at statement position", () => {
    it("rejects when canInline returns false for expression at statement position", () => {
      const code = `
        declare const mutableValue: { value: number };

        /** @inline */
        function getAndIncrement(): number {
          mutableValue.value++;
          return mutableValue.value;
        }

        function test() {
          getAndIncrement();
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("return-value function called at void site"),
        ),
      ).toBe(true);
    });
  });

  describe("argument count and shape validation", () => {
    it("does not inline rest parameters functions", () => {
      const code = `
        /** @inline */
        function sum(...args: number[]): number {
          let total = 0;
          for (const arg of args) {
            total += arg;
          }
          return total;
        }

        declare const a: number;
        const result = sum(a, a + 1);
      `;

      const lua = normalizeLua(compile(code));

      // Rest parameters should not be inlined, call should remain
      expect(lua).toContain("sum(a, a + 1)");
    });
  });

  describe("expression-body inlining restrictions", () => {
    it("still inlines unused pure arguments and erases the declaration", () => {
      const { lua, diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function ignore(x: number): number {
          return 42;
        }

        declare const value: number;
        const result = ignore(value);
      `);

      expect(diagnostics).toHaveLength(0);
      expect(lua).toContain("result = 42");
      expect(lua).not.toContain("ignore(value)");
      expect(lua).not.toContain("function ignore");
    });
  });

  describe("statement-body inlining restrictions", () => {
    it("does not inline multi-statement function when parameter is written", () => {
      const code = `
        declare const counter: number;

        /** @inline */
        function increment(n: number): void {
          n++;
          const x = n;
        }

        increment(counter);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Parameter write in multi-statement should be detected
      expect(diagnostics.some((d) => String(d.messageText).includes("parameter is written"))).toBe(
        true,
      );
    });

    it("does not inline multi-statement function when detecting recursion", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function countDown(x: number): void {
          if (x > 0) {
            countDown(x - 1);
          }
        }

        countDown(n);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.some((d) => String(d.messageText).includes("recursive"))).toBe(true);
    });
  });

  describe("Complex destructuring and type patterns", () => {
    it.each([
      {
        name: "object destructuring with nested patterns",
        code: `
          /** @inline */
          function process({ a, b: { c } }: { a: number; b: { c: number } }): number {
            return a + c;
          }

          function test() {
            process({ a: 1, b: { c: 2 } });
          }
        `,
      },
      {
        name: "array destructuring with rest element",
        code: `
          /** @inline */
          function getFirst([head, ...tail]: number[]): number {
            return head;
          }

          function test() {
            getFirst([1, 2, 3]);
          }
        `,
      },
    ])("rejects $name", ({ code }) => {
      const { diagnostics } = compileWithDiagnostics(code);

      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("destructuring parameters are not supported"),
        ),
      ).toBe(true);
    });
  });

  describe("Multi-statement at expression position", () => {
    it("inlines multi-statement body with return at expression position (statementsWithReturn)", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function computeSum(a: number, b: number): number {
          const result = a + b;
          return result;
        }

        function test() {
          const val = computeSum(x, y);
        }
      `;

      const lua = normalizeLua(compile(code));

      // statementsWithReturn should be inlined even at expression position
      // The call should be replaced with the inlined statements
      expect(lua).not.toContain("computeSum(x, y)");
      expect(lua).toContain("result");
    });

    it("rejects multi-statement function called in expression with control flow rejection", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function computeWithBreak(n: number): number {
          if (n > 10) {
            return 10;
          }
          return n;
        }

        function test() {
          const result = computeWithBreak(x);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.some((d) => String(d.messageText).includes("early return in body"))).toBe(
        true,
      );
    });
  });

  describe("Module scope validation", () => {
    it("rejects inline function declared inside another function", () => {
      const code = `
        function outer(x: number): number {
          /** @inline */
          function inner(a: number): number {
            return a * 2;
          }
          return inner(x);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("function must be declared at module scope"),
        ),
      ).toBe(true);
    });

    it("rejects inline function declared in class method", () => {
      const code = `
        class Calculator {
          compute(x: number): number {
            /** @inline */
            function double(n: number): number {
              return n * 2;
            }
            return double(x);
          }
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("function must be declared at module scope"),
        ),
      ).toBe(true);
    });
  });

  describe("Edge cases and linear control flow", () => {
    it("handles function with if statement without else branch", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function maybeIncrement(n: number): number {
          if (n > 0) {
            return n + 1;
          }
          return 0;
        }

        const result = maybeIncrement(x);
      `;

      const lua = normalizeLua(compile(code));

      // If without else but with return in both paths should inline
      expect(lua).toContain("x");
    });

    it("inlines function with while loop when at statement position", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function countUp(x: number): void {
          let i = 0;
          while (i < x) {
            const _ = i;
            i++;
          }
        }

        countUp(n);
      `;

      const lua = normalizeLua(compile(code));

      // While loop with linear control flow should inline at void site
      expect(lua).not.toContain("countUp(n)");
    });

    it("inlines function with do-while loop at statement position", () => {
      const code = `
        declare const n: number;

        /** @inline */
        function countdown(x: number): void {
          let i = x;
          do {
            const _ = i;
            i--;
          } while (i > 0);
        }

        countdown(n);
      `;

      const lua = normalizeLua(compile(code));

      // Do-while with linear control flow should inline
      expect(lua).not.toContain("countdown(n)");
    });

    it("inlines function with for loop at statement position", () => {
      const code = `
        declare const items: number[];

        /** @inline */
        function process(arr: number[]): void {
          for (const item of arr) {
            const _ = item;
          }
        }

        process(items);
      `;

      const lua = normalizeLua(compile(code));

      // For loop with linear control flow should inline
      expect(lua).not.toContain("process(items)");
    });

    it("inlines function with try block at statement position", () => {
      const code = `
        declare const fn: () => void;

        /** @inline */
        function safeCall(callback: () => void): void {
          try {
            callback();
          } catch {
            const _ = 1;
          }
        }

        safeCall(fn);
      `;

      const lua = normalizeLua(compile(code));

      // Try-catch with linear control flow should inline
      expect(lua).not.toContain("safeCall(fn)");
    });

    it("inlines function with switch statement at statement position", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function process(n: number): void {
          switch (n) {
            case 1:
              break;
            case 2:
              break;
          }
        }

        process(x);
      `;

      const lua = normalizeLua(compile(code));

      // Switch with all branches having break should inline
      expect(lua).not.toContain("process(x)");
    });

    it("inlines empty function body", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function noop(n: number): void {
        }

        noop(x);
      `;

      const lua = normalizeLua(compile(code));

      // Empty function should inline to nothing
      expect(lua).not.toContain("noop(x)");
    });
  });

  describe("Expression vs statement inlining decisions", () => {
    it("preserves a side-effecting unused argument for an empty statement body", () => {
      const code = `
        declare function sideEffect(): number;

        /** @inline */
        function run(_value: number): void {}

        run(sideEffect());
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("run(");
      expect(lua).toContain("sideEffect()");
      expect(lua).toMatch(/local ____inline_result_\d+ = sideEffect\(\)/);
    });

    it("preserves side-effecting unused arguments before used argument temps", () => {
      const code = `
        declare function first(): number;
        declare function second(): number;
        declare function print(value: number): void;

        /** @inline */
        function run(_ignored: number, value: number): void {
          print(value);
        }

        run(first(), second());
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).not.toContain("run(");
      expect(lua).toContain("first()");
      expect(lua).toContain("second()");
      expect(lua.indexOf("first()")).toBeLessThan(lua.indexOf("second()"));
    });
  });

  describe("Complex argument evaluation", () => {
    it("allows pure argument that is used multiple times", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function triple(n: number): number {
          return n + n + n;
        }

        const result = triple(x);
      `;

      const lua = normalizeLua(compile(code));

      // Pure argument with multiple uses should inline
      expect(lua).toContain("x + x + x");
    });

    it("preserves left-to-right evaluation when expression-body parameters are used out of order", () => {
      const lua = normalizeLua(
        compile(`
          declare function s1(): number;
          declare function s2(): number;

          /** @inline */
          function sub(a: number, b: number): number {
            return b - a;
          }

          const x = sub(s1(), s2());
        `),
      );

      expect(lua).toMatch(/____inline_arg_\d+ = s1\(\)/);
      expect(lua).toMatch(/____inline_arg_\d+ = s2\(\)/);
      expect(lua).toMatch(/return ____inline_arg_\d+ - ____inline_arg_\d+/);
    });

    it("preserves eager evaluation for arguments that would otherwise sit behind a conditional", () => {
      const lua = normalizeLua(
        compile(`
          declare function choose(): boolean;
          declare function s1(): number;
          declare function s2(): number;

          /** @inline */
          function pick(flag: boolean, a: number, b: number): number {
            return flag ? a : b;
          }

          const x = pick(choose(), s1(), s2());
        `),
      );

      expect(lua).toMatch(/____inline_arg_\d+ = choose\(\)/);
      expect(lua).toMatch(/____inline_arg_\d+ = s1\(\)/);
      expect(lua).toMatch(/____inline_arg_\d+ = s2\(\)/);
      expect(lua).toMatch(/return ____inline_arg_\d+ and ____inline_arg_\d+ or ____inline_arg_\d+/);
    });

    it.each([
      {
        desc: "postfix increment (i++) before param",
        fixture: `
          /** @inline */
          function f(x: number) { return i++ + x; }
          declare let i: number;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "prefix increment (++i) before param",
        fixture: `
          /** @inline */
          function f(x: number) { return ++i + x; }
          declare let i: number;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "property access on free variable before param",
        fixture: `
          /** @inline */
          function f(x: number) { return obj.prop + x; }
          declare const obj: { prop: number };
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "element access before param",
        fixture: `
          /** @inline */
          function f(x: number) { return arr[0] + x; }
          declare const arr: number[];
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "call expression before param",
        fixture: `
          /** @inline */
          function f(x: number) { return g() + x; }
          declare function g(): number;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "spread element in call args before param",
        fixture: `
          /** @inline */
          function f(x: number) { return g(1, ...arr) + x; }
          declare function g(...ns: number[]): number;
          declare const arr: number[];
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "new expression in object literal before param",
        fixture: `
          /** @inline */
          function f(x: number) { return { inst: new Foo(), val: x }; }
          declare class Foo {}
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "tagged template literal (with span) before param",
        fixture: `
          /** @inline */
          function f(x: number) { return tag\`hello \${1} world\` + x; }
          declare function tag(s: TemplateStringsArray, ...values: number[]): number;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "class expression in object literal before param",
        fixture: `
          /** @inline */
          function f(x: number) { return { cls: class {}, val: x }; }
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "spread assignment in object literal before param",
        fixture: `
          /** @inline */
          function f(x: number) { return { ...rest, val: x }; }
          declare const rest: { a: number };
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "spread element in array literal before param",
        fixture: `
          /** @inline */
          function f(x: number) { return [...arr, x]; }
          declare const arr: number[];
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "computed property with SE key before param",
        fixture: `
          /** @inline */
          function f(x: number) { return { [g()]: 1, val: x }; }
          declare function g(): string;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "tagged template with no-substitution literal before param",
        fixture: `
          /** @inline */
          function f(x: number) { return tag\`literal\` + x; }
          declare function tag(s: TemplateStringsArray): number;
          declare function foo(): number;
          const r = f(foo());
        `,
      },
      {
        desc: "new expression without args (no parens) before param",
        fixture: `
          /** @inline */
          function f(x: number) { return { inst: new Foo, val: x }; }
          declare class Foo {}
          declare function foo(): number;
          const r = f(foo());
        `,
      },
    ])("retains IIFE wrapper when body has SE before param first use: $desc", ({ fixture }) => {
      const lua = compile(fixture);
      expect(lua).toContain("____inline_arg_");
    });
  });

  describe("expression statement rejection", () => {
    it("preserves call when function lacks @inline tag at statement position", () => {
      const code = `
        // Note: no @inline tag
        function helper(x: number): number {
          return x * 2;
        }

        helper(5);
      `;

      const { lua } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      // Call must be preserved because function is not tagged @inline
      expect(normalized).toContain("helper(5)");
    });

    it("preserves call when function has default parameters at statement position", () => {
      const code = `
        declare function print(x: unknown): void;

        /** @inline */
        function multiply(x: number, y: number = 2): void {
          print(x * y);
        }

        multiply(5);
      `;

      const { lua, diagnostics } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      // Call must be preserved because default parameters are not supported
      expect(normalized).toContain("multiply(5)");
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("default parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("preserves the declaration when a rejected call site survives", () => {
      const code = `
        /** @inline */
        function helper(x: number): number {
          const y = x + 1;
          return y;
        }

        const a = helper(1);
        const b = helper(1) + 1;
      `;

      const { lua, diagnostics } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain("local a");
      expect(normalized).toContain("b = helper(1) + 1");
      expect(normalized).toContain("function helper(x)");
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes(
            "multi-statement body cannot be inlined at expression position",
          ),
        ),
      ).toBe(true);
    });
  });

  describe("control-flow early-return rejections", () => {
    it.each([
      {
        name: "an else branch returns",
        source: `
          declare const value: number;

          /** @inline */
          function maybeLog(x: number): void {
            if (x > 0) {
              const y = x;
            } else {
              return;
            }
          }

          maybeLog(value);
        `,
      },
      {
        name: "a while loop returns",
        source: `
          declare const value: number;

          /** @inline */
          function maybeLoop(x: number): void {
            while (x > 0) {
              return;
            }
          }

          maybeLoop(value);
        `,
      },
      {
        name: "a numeric for loop returns",
        source: `
          declare const value: number;

          /** @inline */
          function maybeCount(x: number): void {
            for (let i = 0; i < x; i++) {
              return;
            }
          }

          maybeCount(value);
        `,
      },
      {
        name: "a for-in loop returns",
        source: `
          declare const values: Record<string, number>;

          /** @inline */
          function maybeVisit(obj: Record<string, number>): void {
            for (const key in obj) {
              return;
            }
          }

          maybeVisit(values);
        `,
      },
      {
        name: "a do-while loop returns",
        source: `
          declare const value: number;

          /** @inline */
          function maybeRetry(x: number): void {
            do {
              return;
            } while (x > 0);
          }

          maybeRetry(value);
        `,
      },
      {
        name: "a switch clause returns",
        source: `
          declare const value: number;

          /** @inline */
          function maybeSwitch(x: number): void {
            switch (x) {
              case 1:
                return;
              default:
                const y = x;
            }
          }

          maybeSwitch(value);
        `,
      },
      {
        name: "a catch clause returns",
        source: `
          declare function run(): void;

          /** @inline */
          function maybeCatch(): void {
            try {
              run();
            } catch {
              return;
            }
          }

          maybeCatch();
        `,
      },
      {
        name: "a try block returns",
        source: `
          declare function run(): void;

          /** @inline */
          function maybeTry(): void {
            try {
              run();
              return;
            } finally {
              const _ = 1;
            }
          }

          maybeTry();
        `,
      },
      {
        name: "a finally clause returns",
        source: `
          declare function run(): void;

          /** @inline */
          function maybeFinally(): void {
            try {
              run();
            } finally {
              return;
            }
          }

          maybeFinally();
        `,
      },
    ])("does not inline when $name", ({ source }) => {
      const { diagnostics } = compileWithDiagnostics(source);

      expect(diagnostics.some((d) => String(d.messageText).includes("early return in body"))).toBe(
        true,
      );
    });
  });

  describe("variable and return site edge cases", () => {
    it("reports unsupported default parameters from a return-site call", () => {
      const { diagnostics } = compileWithDiagnostics(`
        /** @inline */
        function scale(value: number = 2): number {
          return value * 2;
        }

        function test() {
          return scale();
        }
      `);

      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("default parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("uses a temporary result name when an else branch declares the call-site binding name", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function choose(flag: boolean): number {
          if (flag) {
            const keep = 1;
          } else {
            const result = 2;
          }
          return 3;
        }

        const result = choose(true);
      `),
      );

      expect(lua).toContain("____inline_result_");
      expect(lua).toContain("local result =");
    });
  });

  describe("destructuring fall-back cases", () => {
    it("falls back to the call for object destructuring with a rest element", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getObj(): { a: number; b: number } {
          const obj = { a: 1, b: 2 };
          return obj;
        }

        function test() {
          const { a, ...rest } = getObj();
          return a + rest.b;
        }
      `),
      );

      expect(lua).toContain("getObj()");
    });

    it("falls back to the call for object destructuring with a default initializer", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getObj(): { a?: number } {
          const obj = {};
          return obj;
        }

        function test() {
          const { a = 1 } = getObj();
          return a;
        }
      `),
      );

      expect(lua).toContain("getObj()");
    });

    it("falls back to the call for object destructuring with a string-literal property name", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getObj(): { value: number } {
          const obj = { value: 1 };
          return obj;
        }

        function test() {
          const { "value": localValue } = getObj();
          return localValue;
        }
      `),
      );

      expect(lua).toContain("getObj()");
    });

    it("falls back to the call for array destructuring with an omitted element", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getArr(): [number, number] {
          const values: [number, number] = [1, 2];
          return values;
        }

        function test() {
          const [, second] = getArr();
          return second;
        }
      `),
      );

      expect(lua).toContain("getArr()");
    });

    it("falls back to the call for array destructuring with a rest element", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getArr(): number[] {
          const values = [1, 2, 3];
          return values;
        }

        function test() {
          const [...rest] = getArr();
          return rest.length;
        }
      `),
      );

      expect(lua).toContain("getArr()");
    });

    it("falls back to the call for array destructuring with a nested binding pattern", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getArr(): Array<[number]> {
          const values: Array<[number]> = [[1]];
          return values;
        }

        function test() {
          const [[first]] = getArr();
          return first;
        }
      `),
      );

      expect(lua).toContain("getArr()");
    });

    it("falls back to the call for array destructuring with a default initializer", () => {
      const lua = normalizeLua(
        compile(`
        /** @inline */
        function getArr(): [number?] {
          const values: [number?] = [];
          return values;
        }

        function test() {
          const [first = 1] = getArr();
          return first;
        }
      `),
      );

      expect(lua).toContain("getArr()");
    });
  });

  describe("direct visitor guard rails", () => {
    interface TestProgram {
      checker: ts.TypeChecker;
      getSourceFile(path: string): ts.SourceFile;
    }

    function createTestProgram(files: Record<string, string>): TestProgram {
      const options: ts.CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        strict: true,
      };
      const host = ts.createCompilerHost(options, true);

      host.readFile = (fileName) => files[fileName] ?? ts.sys.readFile(fileName);
      host.fileExists = (fileName) => files[fileName] !== undefined || ts.sys.fileExists(fileName);
      host.getSourceFile = (fileName, languageVersion) => {
        const text = host.readFile(fileName);
        return text === undefined
          ? undefined
          : ts.createSourceFile(fileName, text, languageVersion, true);
      };
      host.writeFile = () => {};

      const program = ts.createProgram(Object.keys(files), options, host);
      return {
        checker: program.getTypeChecker(),
        getSourceFile: (path) => {
          const sourceFile = program.getSourceFile(path);
          if (!sourceFile) {
            throw new Error(`Missing source file: ${path}`);
          }
          return sourceFile;
        },
      };
    }

    function createInlineVisitors(
      files: Record<string, string>,
      config: { rules: { inline: unknown }; strict?: boolean } = { rules: { inline: true } },
    ): { visitors: tstl.Visitors; program: TestProgram } {
      const program = createTestProgram(files);
      const visitors = Reflect.apply(createVisitors, undefined, [program.checker, config]);
      return { visitors, program };
    }

    function createDirectContext(
      overrides: Partial<tstl.TransformationContext> = {},
    ): tstl.TransformationContext {
      let nextSymbolId = 9500;
      return {
        symbolIdMaps: new Map<ts.Symbol, tstl.SymbolId>(),
        diagnostics: [] as ts.Diagnostic[],
        nextSymbolId: () => nextSymbolId++,
        pushScope: () => {},
        popScope: () => {},
        transformExpression: () => tstl.createIdentifier("mapped"),
        transformStatements: () => [],
        // superTransformStatements is called by the @inline comment-strip path when a
        // non-erasable declaration keeps its @inline tag. Return an empty array — the
        // call-path is what's being tested, not the TSTL default transform result.
        superTransformStatements: () => [],
        ...overrides,
      } as unknown as tstl.TransformationContext;
    }

    function toSymbolId(value: number): tstl.SymbolId {
      return value as tstl.SymbolId;
    }

    /**
     * Returns `sourceFile.statements[index]` narrowed to `T` via `guard`, or
     * throws if the statement is missing or has the wrong kind.
     */
    function getStatement<T extends ts.Statement>(
      sourceFile: ts.SourceFile,
      index: number,
      guard: (node: ts.Statement) => node is T,
      label: string,
    ): T {
      const stmt = sourceFile.statements[index];
      if (!stmt || !guard(stmt)) throw new Error(`expected ${label} at statements[${index}]`);
      return stmt;
    }

    /**
     * Returns `block.statements[0]` narrowed to `T` via `guard`, or throws.
     */
    function getFirstBodyStatement<T extends ts.Statement>(
      block: ts.Block,
      guard: (node: ts.Statement) => node is T,
      label: string,
    ): T {
      const stmt = block.statements[0];
      if (!stmt || !guard(stmt)) throw new Error(`expected ${label} as first body statement`);
      return stmt;
    }

    function isReturnStatementNode(
      node: ts.Statement | readonly ts.Statement[],
    ): node is ts.ReturnStatement {
      return "kind" in node && node.kind === ts.SyntaxKind.ReturnStatement;
    }

    type StatementVisitorKind = ts.SyntaxKind.ExpressionStatement | ts.SyntaxKind.VariableStatement;

    function expectDiagnosticFragment(
      diagnostics: readonly ts.Diagnostic[],
      fragment: string,
    ): void {
      expect(
        diagnostics.some((diagnostic) => String(diagnostic.messageText).includes(fragment)),
      ).toBe(true);
    }

    function runDirectStatementVisitor(options: {
      files: Record<string, string>;
      kind: StatementVisitorKind;
      statementIndex: number;
      context: tstl.TransformationContext;
      sourcePath?: string;
    }): unknown {
      const { files, kind, statementIndex, context, sourcePath = "/main.ts" } = options;
      const { visitors, program } = createInlineVisitors(files);
      const sourceFile = program.getSourceFile(sourcePath);
      const visitor = Reflect.get(visitors, kind) as (
        node: ts.Node,
        visitorContext: tstl.TransformationContext,
      ) => unknown;
      const statement = sourceFile.statements[statementIndex];
      if (!statement) {
        throw new Error(`Missing statement at index ${statementIndex}`);
      }

      return Reflect.apply(visitor, undefined, [statement, context]);
    }

    function runDirectReturnVisitor(options: {
      files: Record<string, string>;
      functionStatementIndex: number;
      context: tstl.TransformationContext;
      sourcePath?: string;
    }): unknown {
      const { files, functionStatementIndex, context, sourcePath = "/main.ts" } = options;
      const { visitors, program } = createInlineVisitors(files);
      const sourceFile = program.getSourceFile(sourcePath);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ReturnStatement) as (
        node: ts.Node,
        visitorContext: tstl.TransformationContext,
      ) => unknown;
      const fnStmt = sourceFile.statements[functionStatementIndex];
      if (!fnStmt || !ts.isFunctionDeclaration(fnStmt)) {
        throw new Error("expected function declaration");
      }
      const runBody = fnStmt.body;
      if (!runBody) {
        throw new Error("expected run body");
      }
      const returnStmt = runBody.statements[0];
      if (!returnStmt || !ts.isReturnStatement(returnStmt)) {
        throw new Error("expected return statement");
      }

      return Reflect.apply(visitor, undefined, [returnStmt, context]);
    }

    it("accepts inline config objects with per-rule strict overrides", () => {
      const { visitors } = createInlineVisitors(
        {
          "/main.ts": `
            /** @inline */
            function double(value: number): number {
              return value * 2;
            }
          `,
        },
        { rules: { inline: { strict: true } }, strict: false },
      );

      expect(Reflect.has(visitors, ts.SyntaxKind.CallExpression)).toBe(true);
      expect(Reflect.has(visitors, ts.SyntaxKind.ReturnStatement)).toBe(true);
    });

    it("preserves inline destructured variable declarations when the binding name is not an identifier", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          declare const source: { fn: (value: number) => number };

          /** @inline */
          const { fn } = source;
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      // The declaration is kept (not erased); the visitor strips the @inline comment
      // rather than returning undefined, so the result is an array of statements.
      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 1, ts.isVariableStatement, "variable statement"),
        createDirectContext(),
      ]);

      expect(Array.isArray(result)).toBe(true);
    });

    it("preserves inline-tagged variable call sites when the initializer is not a function", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          const maybeCallable: any = 1;

          maybeCallable();
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.CallExpression) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const expressionStatement = getStatement(
        sourceFile,
        1,
        ts.isExpressionStatement,
        "expression statement",
      );

      const result = Reflect.apply(visitor, undefined, [
        expressionStatement.expression,
        createDirectContext(),
      ]);

      expect(result).toBeUndefined();
    });

    it("leaves multi-declaration variable statements to the fallback visitor", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          function double(value: number): number {
            return value * 2;
          }

          const result = double(2), keep = 1;
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 1, ts.isVariableStatement, "variable statement"),
        {} as tstl.TransformationContext,
      ]);

      expect(result).toBeUndefined();
    });

    it("preserves exported inline variable declarations found through export blocks", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          const double = (value: number) => value * 2;
          export { double as doubled };
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      // Declaration is kept but @inline comment is stripped; visitor returns statements.
      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 0, ts.isVariableStatement, "variable statement"),
        createDirectContext(),
      ]);

      expect(Array.isArray(result)).toBe(true);
    });

    it("erases an inline function declaration when all remaining call sites are fully inlined", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          function double(value: number): number {
            return value * 2;
          }

          const result = double(2);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.FunctionDeclaration) as (
        node: ts.Node,
      ) => unknown;

      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 0, ts.isFunctionDeclaration, "function declaration"),
      ]);

      expect(result).toStrictEqual([]);
    });

    it("preserves nested inline variable declarations outside module scope", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          function outer() {
            /** @inline */
            const double = (value: number) => value * 2;
            return double(1);
          }
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const outerFn = getStatement(sourceFile, 0, ts.isFunctionDeclaration, "outer function");
      const outerBody = outerFn.body;
      if (!outerBody) {
        throw new Error("expected outer function body");
      }
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      // Declaration is kept (not at module scope, can't be erased) but @inline is stripped.
      const result = Reflect.apply(visitor, undefined, [
        getFirstBodyStatement(outerBody, ts.isVariableStatement, "variable statement"),
        createDirectContext(),
      ]);

      expect(Array.isArray(result)).toBe(true);
    });

    it("preserves nested inline function declarations outside module scope", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          function outer() {
            /** @inline */
            function double(value: number): number {
              return value * 2;
            }
            return double(1);
          }
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const outerFn2 = getStatement(sourceFile, 0, ts.isFunctionDeclaration, "outer function");
      const outerBody = outerFn2.body;
      if (!outerBody) {
        throw new Error("expected outer function body");
      }
      const visitor = Reflect.get(visitors, ts.SyntaxKind.FunctionDeclaration) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      // Declaration is kept (not at module scope) but @inline comment is stripped.
      const result = Reflect.apply(visitor, undefined, [
        getFirstBodyStatement(outerBody, ts.isFunctionDeclaration, "inner function declaration"),
        createDirectContext(),
      ]);

      expect(Array.isArray(result)).toBe(true);
    });

    it("keeps an inline function declaration when it is referenced in a non-call position", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          function double(value: number): number {
            return value * 2;
          }

          const alias = double;
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.FunctionDeclaration) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      // Declaration is kept (referenced as value, can't be erased) but @inline is stripped.
      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 0, ts.isFunctionDeclaration, "function declaration"),
        createDirectContext(),
      ]);

      expect(Array.isArray(result)).toBe(true);
    });

    describe("statement-position visitor diagnostics", () => {
      it("expression-statement visitor rejects labeled statements", () => {
        const context = createDirectContext({ diagnostics: [] as ts.Diagnostic[] });

        const result = runDirectStatementVisitor({
          files: {
            "/main.ts": `
              /** @inline */
              function run(flag: boolean): void {
                loop: {
                  if (flag) {
                    break loop;
                  }
                }
              }

              run(true);
            `,
          },
          kind: ts.SyntaxKind.ExpressionStatement,
          statementIndex: 1,
          context,
        });

        expect(result).toBeUndefined();
        expectDiagnosticFragment(context.diagnostics, "labeled statement in body");
      });
    });

    describe("return visitor diagnostics", () => {
      it("reports parameter writes from return expressions", () => {
        const context = createDirectContext({ diagnostics: [] as ts.Diagnostic[] });

        const result = runDirectReturnVisitor({
          files: {
            "/main.ts": `
              /** @inline */
              function bump(value: number): number {
                const keep = value;
                return ++value;
              }

              function run() {
                return bump(1);
              }
            `,
          },
          functionStatementIndex: 1,
          context,
        });

        expect(result).toBeUndefined();
        expectDiagnosticFragment(context.diagnostics, "parameter is written inside body");
      });
    });

    it("keeps lowering statement-position visitors when the lowered body no longer needs the param map", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          function logValue(value: number): void {
            const keep = value;
          }

          logValue(1);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ExpressionStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      // Force the transformed body to be non-empty so the visitor reaches
      // `buildParamMap`, which fails because the mocked `symbolIdMaps` has no
      // entry for the parameter symbol.
      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 1, ts.isExpressionStatement, "expression statement"),
        createDirectContext({
          transformStatements: () => [tstl.createReturnStatement([])],
        }),
      ]);

      expect(result).toBeDefined();
    });

    it("keeps lowering direct call visitors when the lowered expression no longer needs the param map", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          const identity = (value: number) => value;

          identity(1);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.CallExpression) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const expressionStatement = getStatement(
        sourceFile,
        1,
        ts.isExpressionStatement,
        "expression statement",
      );

      const result = Reflect.apply(visitor, undefined, [
        expressionStatement.expression,
        createDirectContext(),
      ]);

      expect(result).toBeDefined();
    });

    it("reports unresolved parameter symbols from direct call visitors", () => {
      const program = createTestProgram({
        "/main.ts": `
          /** @inline */
          const double = (value: number) => value * 2;

          double(1);
        `,
      });
      const checker = {
        ...program.checker,
        getAliasedSymbol: program.checker.getAliasedSymbol.bind(program.checker),
        getResolvedSignature: program.checker.getResolvedSignature.bind(program.checker),
        getReturnTypeOfSignature: program.checker.getReturnTypeOfSignature.bind(program.checker),
        getSymbolAtLocation: (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === "value") {
            return undefined;
          }
          return program.checker.getSymbolAtLocation(node);
        },
      } as ts.TypeChecker;
      const visitors = Reflect.apply(createVisitors, undefined, [
        checker,
        { rules: { inline: true } },
      ]);
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.CallExpression) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const exprStmt = getStatement(
        sourceFile,
        1,
        ts.isExpressionStatement,
        "expression statement",
      );
      const context = createDirectContext({ diagnostics: [] as ts.Diagnostic[] });

      const result = Reflect.apply(visitor, undefined, [exprStmt.expression, context]);

      expect(result).toBeUndefined();
      expect(
        context.diagnostics.some((d) =>
          String(d.messageText).includes("parameter symbol could not be resolved"),
        ),
      ).toBe(true);
    });

    it("returns undefined from direct call visitors when the resolved symbol has no declarations", () => {
      const program = createTestProgram({
        "/main.ts": `
          declare const maybeCallable: (value: number) => number;

          maybeCallable(1);
        `,
      });
      const declarationlessSymbol = {
        flags: ts.SymbolFlags.Function,
        getDeclarations: () => [],
      } as unknown as ts.Symbol;
      const checker = {
        ...program.checker,
        getAliasedSymbol: program.checker.getAliasedSymbol.bind(program.checker),
        getResolvedSignature: program.checker.getResolvedSignature.bind(program.checker),
        getReturnTypeOfSignature: program.checker.getReturnTypeOfSignature.bind(program.checker),
        getSymbolAtLocation: (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === "maybeCallable") {
            return declarationlessSymbol;
          }
          return program.checker.getSymbolAtLocation(node);
        },
      } as ts.TypeChecker;
      const visitors = Reflect.apply(createVisitors, undefined, [
        checker,
        { rules: { inline: true } },
      ]);
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.CallExpression) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const exprStmt2 = getStatement(
        sourceFile,
        1,
        ts.isExpressionStatement,
        "expression statement",
      );

      const result = Reflect.apply(visitor, undefined, [
        exprStmt2.expression,
        createDirectContext(),
      ]);

      expect(result).toBeUndefined();
    });

    it("reports unresolved parameter symbols from direct statement-position visitors", () => {
      const program = createTestProgram({
        "/main.ts": `
          /** @inline */
          function logValue(value: number): void {
            const keep = value;
          }

          logValue(1);
        `,
      });
      const checker = {
        ...program.checker,
        getAliasedSymbol: program.checker.getAliasedSymbol.bind(program.checker),
        getResolvedSignature: program.checker.getResolvedSignature.bind(program.checker),
        getReturnTypeOfSignature: program.checker.getReturnTypeOfSignature.bind(program.checker),
        getSymbolAtLocation: (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === "value" && ts.isParameter(node.parent)) {
            return undefined;
          }
          return program.checker.getSymbolAtLocation(node);
        },
      } as ts.TypeChecker;
      const visitors = Reflect.apply(createVisitors, undefined, [
        checker,
        { rules: { inline: true } },
      ]);
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ExpressionStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const context = createDirectContext({ diagnostics: [] as ts.Diagnostic[] });

      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 1, ts.isExpressionStatement, "expression statement"),
        context,
      ]);

      expect(result).toBeUndefined();
      expect(
        context.diagnostics.some((d) =>
          String(d.messageText).includes("parameter symbol could not be resolved"),
        ),
      ).toBe(true);
    });

    it("returns undefined when buildParamMap fails in the eager temp path", () => {
      const program = createTestProgram({
        "/main.ts": `
          declare function sideEffect(): number;
          declare const cond: boolean;

          /** @inline */
          const f = (value: number) => cond ? value : 0;

          f(sideEffect());
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const fDecl = getStatement(sourceFile, 2, ts.isVariableStatement, "variable statement");
      const arrowInit = fDecl.declarationList.declarations[0]?.initializer;
      if (!arrowInit || !ts.isArrowFunction(arrowInit)) {
        throw new Error("expected arrow function initializer");
      }
      const paramDecl = arrowInit.parameters[0];
      if (!paramDecl) {
        throw new Error("expected inline parameter");
      }
      const paramSymbol = program.checker.getSymbolAtLocation(paramDecl.name);
      if (!paramSymbol) {
        throw new Error("expected parameter symbol");
      }
      let paramLookups = 0;
      const checker = {
        ...program.checker,
        getAliasedSymbol: program.checker.getAliasedSymbol.bind(program.checker),
        getResolvedSignature: program.checker.getResolvedSignature.bind(program.checker),
        getReturnTypeOfSignature: program.checker.getReturnTypeOfSignature.bind(program.checker),
        getSymbolAtLocation: (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === "value" && ts.isParameter(node.parent)) {
            paramLookups++;
            return paramLookups >= 3 ? undefined : paramSymbol;
          }
          return program.checker.getSymbolAtLocation(node);
        },
      } as ts.TypeChecker;
      const visitors = Reflect.apply(createVisitors, undefined, [
        checker,
        { rules: { inline: true } },
      ]);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.CallExpression) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const callExprStmt = getStatement(
        sourceFile,
        3,
        ts.isExpressionStatement,
        "expression statement",
      );

      const result = Reflect.apply(visitor, undefined, [
        callExprStmt.expression,
        createDirectContext({
          symbolIdMaps: new Map<ts.Symbol, tstl.SymbolId>([[paramSymbol, 1 as tstl.SymbolId]]),
          transformExpression: (node) =>
            ts.isCallExpression(node)
              ? tstl.createCallExpression(tstl.createIdentifier("sideEffect"), [])
              : tstl.createIdentifier("mapped"),
        }),
      ]);

      expect(result).toBeUndefined();
    });

    describe("direct variable visitor guard rails", () => {
      it.each([
        {
          name: "keeps lowering identifier bindings when the lowered return no longer needs the param map",
          source: `
            /** @inline */
            function compute(value: number): number {
              const interim = value + 1;
              return interim;
            }

            const result = compute(1);
          `,
          statementIndex: 1,
          buildContext: () =>
            createDirectContext({ transformExpression: () => tstl.createNumericLiteral(1) }),
        },
        {
          name: "keeps lowering destructuring bindings when the lowered return no longer needs the param map",
          source: `
            /** @inline */
            function compute(value: number): { value: number } {
              const result = { value };
              return result;
            }

            const { value } = compute(1);
          `,
          statementIndex: 1,
          buildContext: () => createDirectContext(),
        },
        {
          name: "keeps lowering plain array bindings when the lowered return no longer needs the param map",
          source: `
            /** @inline */
            function pair(value: number): [number, number] {
              const first = value;
              return [first, value + 1];
            }

            const [left, right] = pair(1);
          `,
          statementIndex: 1,
          buildContext: () =>
            createDirectContext({ transformExpression: () => tstl.createNumericLiteral(1) }),
        },
      ])("$name", ({ source, statementIndex, buildContext }) => {
        const result = runDirectStatementVisitor({
          files: { "/main.ts": source },
          kind: ts.SyntaxKind.VariableStatement,
          statementIndex,
          context: buildContext(),
        });

        expect(result).toBeDefined();
      });
    });

    it("keeps lowering multi-return array bindings when the lowered return no longer needs the param map", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          type LuaMultiReturn<T extends unknown[]> = T & { __brand: never };

          /** @inline */
          function pair(value: number): LuaMultiReturn<[number, number]> {
            return undefined as unknown as LuaMultiReturn<[number, number]>;
          }

          const [left, right] = pair(1);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 2, ts.isVariableStatement, "variable statement"),
        createDirectContext({
          transformExpression: () => tstl.createNumericLiteral(1),
          transformStatements: (node) =>
            isReturnStatementNode(node)
              ? [
                  tstl.createReturnStatement([
                    tstl.createNumericLiteral(1),
                    tstl.createNumericLiteral(2),
                  ]),
                ]
              : [],
        }),
      ]);

      expect(result).toBeDefined();
    });

    it("returns undefined from direct variable visitors when multi-return array lowering emits no return node", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          type LuaMultiReturn<T extends unknown[]> = T & { __brand: never };

          /** @inline */
          function pair(value: number): LuaMultiReturn<[number, number]> {
            return undefined as unknown as LuaMultiReturn<[number, number]>;
          }

          const [left, right] = pair(1);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const pairDecl = getStatement(
        sourceFile,
        1,
        ts.isFunctionDeclaration,
        "function declaration",
      );
      const paramDecl = pairDecl.parameters[0];
      if (!paramDecl) {
        throw new Error("expected pair parameter");
      }
      const paramSymbol = program.checker.getSymbolAtLocation(paramDecl.name);
      if (!paramSymbol) {
        throw new Error("expected parameter symbol");
      }
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 2, ts.isVariableStatement, "variable statement"),
        createDirectContext({
          symbolIdMaps: new Map<ts.Symbol, tstl.SymbolId>([[paramSymbol, toSymbolId(1)]]),
          transformExpression: () => tstl.createNumericLiteral(1),
          transformStatements: (node) =>
            isReturnStatementNode(node)
              ? [tstl.createExpressionStatement(tstl.createNumericLiteral(0))]
              : [],
        }),
      ]);

      expect(result).toBeUndefined();
    });

    it("keeps lowering direct return visitors when the lowered return no longer needs the param map", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          function compute(value: number): number {
            const interim = value + 1;
            return interim;
          }

          function run() {
            return compute(1);
          }
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ReturnStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const runFn = getStatement(sourceFile, 1, ts.isFunctionDeclaration, "run function");
      const runBody = runFn.body;
      if (!runBody) {
        throw new Error("expected run body");
      }

      const result = Reflect.apply(visitor, undefined, [
        getFirstBodyStatement(runBody, ts.isReturnStatement, "return statement"),
        createDirectContext({ transformExpression: () => tstl.createNumericLiteral(1) }),
      ]);

      expect(result).toBeDefined();
    });

    it("returns undefined from direct variable visitors when cross-module free variables block inlining", () => {
      const { visitors, program } = createInlineVisitors({
        "/utils.ts": `
          export let factor = 2;

          /** @inline */
          export function multiply(value: number): number {
            const result = value * factor;
            return result;
          }
        `,
        "/main.ts": `
          import { multiply } from "./utils";

          const result = multiply(3);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const context = createDirectContext({ diagnostics: [] as ts.Diagnostic[] });

      const result = Reflect.apply(visitor, undefined, [
        getStatement(sourceFile, 1, ts.isVariableStatement, "variable statement"),
        context,
      ]);

      expect(result).toBeUndefined();
      expect(
        context.diagnostics.some((d) =>
          String(d.messageText).includes(
            "cross-module function references non-parameter identifiers",
          ),
        ),
      ).toBe(true);
    });

    it("returns undefined from direct variable visitors when binding names are syntactically invalid", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          /** @inline */
          function compute(value: number): number {
            const interim = value + 1;
            return interim;
          }

          const result = compute(1);
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const variableStatement = getStatement(
        sourceFile,
        1,
        ts.isVariableStatement,
        "variable statement",
      );
      const declaration = variableStatement.declarationList.declarations[0];
      if (!declaration) {
        throw new Error("expected variable declaration");
      }
      (declaration as { name: ts.BindingName }).name = ts.factory.createStringLiteral(
        "result",
      ) as unknown as ts.BindingName;
      const visitor = Reflect.get(visitors, ts.SyntaxKind.VariableStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;

      const result = Reflect.apply(visitor, undefined, [
        variableStatement,
        createDirectContext({ transformExpression: () => tstl.createNumericLiteral(1) }),
      ]);

      expect(result).toBeUndefined();
    });

    it("returns undefined from direct return visitors when multi-return lowering emits no return node", () => {
      const { visitors, program } = createInlineVisitors({
        "/main.ts": `
          type LuaMultiReturn<T extends unknown[]> = T & { __brand: never };

          /** @inline */
          function pair(value: number): LuaMultiReturn<[number, number]> {
            return undefined as unknown as LuaMultiReturn<[number, number]>;
          }

          function run() {
            return pair(1);
          }
        `,
      });
      const sourceFile = program.getSourceFile("/main.ts");
      const visitor = Reflect.get(visitors, ts.SyntaxKind.ReturnStatement) as (
        node: ts.Node,
        context: tstl.TransformationContext,
      ) => unknown;
      const runFn = getStatement(sourceFile, 2, ts.isFunctionDeclaration, "run function");
      const runBody = runFn.body;
      if (!runBody) {
        throw new Error("expected run body");
      }
      const pairDecl = getStatement(sourceFile, 1, ts.isFunctionDeclaration, "pair function");
      const paramDecl = pairDecl.parameters[0];
      if (!paramDecl) {
        throw new Error("expected pair parameter");
      }
      const paramSymbol = program.checker.getSymbolAtLocation(paramDecl.name);
      if (!paramSymbol) {
        throw new Error("expected parameter symbol");
      }
      let nextSymbolId = 9300;
      const context = {
        symbolIdMaps: new Map<ts.Symbol, tstl.SymbolId>([[paramSymbol, 1 as tstl.SymbolId]]),
        diagnostics: [] as ts.Diagnostic[],
        nextSymbolId: () => nextSymbolId++,
        pushScope: () => {},
        popScope: () => {},
        transformExpression: () => tstl.createNumericLiteral(1),
        transformStatements: () => [tstl.createExpressionStatement(tstl.createNumericLiteral(0))],
      } as unknown as tstl.TransformationContext;

      const result = Reflect.apply(visitor, undefined, [
        getFirstBodyStatement(runBody, ts.isReturnStatement, "return statement"),
        context,
      ]);

      expect(result).toBeUndefined();
    });
  });

  describe("diagnostic codes", () => {
    const findDiagnostic = (
      diags: ReturnType<typeof compileWithDiagnostics>["diagnostics"],
      matcher: (text: string) => boolean,
    ) => {
      const found = diags.find((d) => matcher(String(d.messageText)));
      if (!found) {
        throw new Error("expected diagnostic");
      }
      return found;
    };

    it("recursive function emits code 90004", () => {
      const code = `
        /** @inline */
        function fact(n: number): number {
          if (n <= 1) return 1;
          return n * fact(n - 1);
        }
        export const x = fact(5);
      `;

      const { diagnostics } = compileWithDiagnostics(code);
      const diag = findDiagnostic(diagnostics, (text) => text.includes("recursive"));
      expect(diag.code).toBe(90004);
    });

    it("side-effects restriction: argument with side effects used multiple times (code 90006)", () => {
      const code = `
        declare function sideEffect(): number;

        /** @inline */
        function useArg(x: number): number {
          return x + x;
        }

        export const result = useArg(sideEffect());
      `;

      const { diagnostics } = compileWithDiagnostics(code);
      const diag = findDiagnostic(
        diagnostics,
        (text) => text.includes("side effect") || text.includes("argument"),
      );
      expect(diag.code).toBe(90006);
    });

    it("multi-statement body at expression position emits code 90010", () => {
      const code = `
        declare function print(...args: unknown[]): void;

        /** @inline */
        function foo() {
          print(1);
          return 2;
        }

        export const x = 1 + foo();
      `;

      const { diagnostics } = compileWithDiagnostics(code);
      const diag = findDiagnostic(diagnostics, (text) => text.includes("expression position"));
      expect(diag.code).toBe(90010);
    });
  });
});
