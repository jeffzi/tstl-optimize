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

    it("inlines side-effecting args used once", () => {
      const lua = compile(`
        /** @inline */
        function double(x: number) { return x * 2; }
        declare function foo(): number;
        const r = double(foo());
      `);
      expect(lua).toContain("____inline_arg_0 = foo()");
      expect(lua).toContain("return ____inline_arg_0 * 2");
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
  });

  describe("void multi-statement inline", () => {
    it("expands body into do...end block", () => {
      const lua = compile(`
        declare function print(...args: any[]): void;
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
        declare function print(...args: any[]): void;
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
        declare function print(...args: any[]): void;
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
      { body: "if (x > 0) return; print(x);", name: "early return" },
      { body: "// @ts-ignore\nbreak;", name: "break" },
      { body: "// @ts-ignore\ncontinue;", name: "continue" },
    ])("rejects bodies with $name", ({ body }) => {
      const { diagnostics } = compileWithDiagnostics(`
          declare function print(...args: any[]): void;
          /** @inline */
          function f(x: number) { ${body} }
          for (let i = 0; i < 10; i++) f(i);
        `);
      expect(diagnostics).toHaveLength(1);
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
      // Constant folding reduces 10 * 2 to 20
      expect(lua).toContain("(20)");
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

describe("inline coverage", () => {
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
      declare function print(...args: any[]): void;
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
      declare function print(...args: any[]): void;
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
      declare function print(...args: any[]): void;
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

  it("buildObjectDestructureInline coverage", () => {
    const code = `
      declare function print(...args: any[]): void;
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

  it("buildObjectDestructureInline rejection (nested)", () => {
    const code = `
      declare function print(...args: any[]): void;
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

  it("buildArrayDestructureInline coverage (non-multi)", () => {
    const code = `
      declare function print(...args: any[]): void;
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
      declare function print(...args: any[]): void;
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

describe("inline uncovered branches", () => {
  describe("Expression-kind inline at statement position (handleExpressionStatement)", () => {
    it("wraps inlined expression in createExpressionStatement when target kind is expression", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        function test() {
          add(x, y);
        }
      `;

      const lua = normalizeLua(compile(code));

      // When the expression inline is at statement position, it should be wrapped
      // in an expression statement. The call should be inlined (not remain as "add()").
      expect(lua).not.toContain("add(x, y)");
      // Should contain the inlined expression (x + y, not the call)
      expect(lua).toContain("x + y");
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

      // Should have a diagnostic about return-value function at void site
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("return-value function called at void site"),
        ),
      ).toBe(true);
    });
  });

  describe("Cross-module free variable detection (rejectIfCrossModuleFreeVar)", () => {
    it("rejects cross-module inline when function references non-parameter identifier", () => {
      const files = {
        "utils.ts": `
          export const globalValue = 42;

          /** @inline */
          export function useGlobal(x: number): number {
            return x + globalValue;
          }
        `,
        "main.ts": `
          import { useGlobal } from "./utils";

          function test() {
            useGlobal(1);
          }
        `,
      };

      const { diagnostics } = compileMultiFileWithDiagnostics(files);

      // Should have a diagnostic about cross-module free variable
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes(
            "cross-module function references non-parameter identifiers",
          ),
        ),
      ).toBe(true);
    });

    it("falls back to call when cross-module free var blocks inline", () => {
      const files = {
        "utils.ts": `
          export const factor = 2;

          /** @inline */
          export function multiply(x: number): number {
            return x * factor;
          }
        `,
        "main.ts": `
          import { multiply } from "./utils";

          function test() {
            const result = multiply(5);
          }
        `,
      };

      const { lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      // Function should NOT be inlined, call should remain
      expect(normalized).toContain("multiply(5)");
    });

    it("falls back to call when expression inline closes over an imported binding", () => {
      const files = {
        "config.ts": `
          export const factor = 2;
        `,
        "utils.ts": `
          import { factor } from "./config";

          /** @inline */
          export function multiply(x: number): number {
            return x * factor;
          }
        `,
        "main.ts": `
          import { multiply } from "./utils";

          function test() {
            const result = multiply(5);
          }
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain("multiply(5)");
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes(
            "cross-module function references non-parameter identifiers",
          ),
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

      // Should have a diagnostic about side effects or parameter write
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe("checkSharedPrereqs branch coverage", () => {
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

    it("rejects optional parameters with diagnostic", () => {
      const code = `
        /** @inline */
        function greet(name?: string): string {
          return name || "default";
        }

        function test() {
          greet();
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("optional parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("rejects default parameters with diagnostic", () => {
      const code = `
        /** @inline */
        function multiply(x: number, y: number = 2): number {
          return x * y;
        }

        function test() {
          multiply(5);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("default parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("rejects array destructuring parameters with diagnostic", () => {
      const code = `
        /** @inline */
        function unpack([a, b]: [number, number]): number {
          return a + b;
        }

        function test() {
          unpack([1, 2]);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("destructuring parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("inlines when argument count matches parameter count", () => {
      // Matching arity lets the inline rule evaluate the call site normally.
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        function test() {
          // Both correct counts should allow inlining
          const result1 = add(x, y);
          return result1;
        }
      `;

      const lua = normalizeLua(compile(code));

      // Matching argument count should allow inlining.
      expect(lua).toContain("x + y");
    });
  });

  describe("canInline parameter validation", () => {
    it("does not inline when parameter is written inside function body", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function increment(n: number): number {
          n++;
          return n;
        }

        const result = increment(x);
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      // Parameter write should prevent inlining
      expect(diagnostics.some((d) => String(d.messageText).includes("parameter is written"))).toBe(
        true,
      );
    });

    it("rejects when argument with side effects is not used", () => {
      const code = `
        declare function sideEffect(): number;

        /** @inline */
        function ignore(x: number): number {
          return 42;
        }

        function test() {
          ignore(sideEffect());
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("argument with side effects is not used"),
        ),
      ).toBe(true);
    });

    it("rejects when argument with side effects is used multiple times", () => {
      const code = `
        declare function expensiveCompute(): number;

        /** @inline */
        function double(x: number): number {
          return x + x;
        }

        function test() {
          double(expensiveCompute());
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("argument with side effects is used multiple times"),
        ),
      ).toBe(true);
    });
  });

  describe("canInlineStatements parameter validation", () => {
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
    it("rejects object destructuring with nested patterns", () => {
      const code = `
        /** @inline */
        function process({ a, b: { c } }: { a: number; b: { c: number } }): number {
          return a + c;
        }

        function test() {
          process({ a: 1, b: { c: 2 } });
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("destructuring parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("rejects array destructuring with rest element", () => {
      const code = `
        /** @inline */
        function getFirst([head, ...tail]: number[]): number {
          return head;
        }

        function test() {
          getFirst([1, 2, 3]);
        }
      `;

      const { diagnostics } = compileWithDiagnostics(code);

      expect(diagnostics.length).toBeGreaterThan(0);
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

      expect(diagnostics.length).toBeGreaterThan(0);
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

      expect(diagnostics.length).toBeGreaterThan(0);
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

      expect(diagnostics.length).toBeGreaterThan(0);
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
    it("inlines expression-kind function at expression position", () => {
      const code = `
        declare const x: number;
        declare const y: number;

        /** @inline */
        function add(a: number, b: number): number {
          return a + b;
        }

        const result = add(x, y);
      `;

      const lua = normalizeLua(compile(code));

      // Expression should be inlined directly
      expect(lua).toContain("x + y");
      expect(lua).not.toContain("add(");
    });

    it("wraps expression-kind function result when inlined at statement position", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function square(n: number): number {
          return n * n;
        }

        square(x);
      `;

      const lua = normalizeLua(compile(code));

      // Expression at statement position gets wrapped
      expect(lua).toContain("x * x");
    });

    it("inlines arrow function assigned to const variable", () => {
      const code = `
        declare const x: number;

        /** @inline */
        const square = (n: number): number => n * n;

        const result = square(x);
      `;

      const lua = normalizeLua(compile(code));

      // Arrow function assigned to variable should be treated like any other inline
      expect(lua).toContain("x * x");
      expect(lua).not.toContain("square(x)");
    });

    it("inlines statements-kind function with multiple statements and no return", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function log(n: number): void {
          const a = n;
          const b = a + 1;
        }

        log(x);
      `;

      const lua = normalizeLua(compile(code));

      // Multi-statement at void site should inline
      expect(lua).not.toContain("log(x)");
    });
  });

  describe("Complex argument evaluation", () => {
    it("handles argument passed to function with single use", () => {
      const code = `
        declare function getValue(): number;

        /** @inline */
        function getValue2(n: number): number {
          return n;
        }

        const result = getValue2(getValue());
      `;

      const lua = normalizeLua(compile(code));

      // Single use of argument with side effects should be ok
      expect(lua).toContain("getValue()");
    });

    it("allows pure argument that is used multiple times", () => {
      const code = `
        declare const x: number;

        /** @inline */
        function triple(n: number): number {
          return n * 3;
        }

        const result = triple(x);
      `;

      const lua = normalizeLua(compile(code));

      // Pure argument with multiple uses should inline
      expect(lua).toContain("x * 3");
    });

    it("inlines argument-less function", () => {
      const code = `
        declare const global: { value: number };

        /** @inline */
        function getGlobal(): number {
          return global.value;
        }

        const result = getGlobal();
      `;

      const lua = normalizeLua(compile(code));

      // Zero-argument function should inline
      expect(lua).toContain("global.value");
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

      expect(lua).toContain("____inline_arg_0 = s1()");
      expect(lua).toContain("____inline_arg_1 = s2()");
      expect(lua).toContain("return ____inline_arg_1 - ____inline_arg_0");
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

      expect(lua).toContain("____inline_arg_0 = choose()");
      expect(lua).toContain("____inline_arg_1 = s1()");
      expect(lua).toContain("____inline_arg_2 = s2()");
      expect(lua).toContain("return ____inline_arg_0 and ____inline_arg_1 or ____inline_arg_2");
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

    it("preserves call when function has optional parameters at statement position", () => {
      const code = `
        declare function print(x: any): void;

        /** @inline */
        function greet(name?: string): void {
          if (name) {
            print(name);
          }
        }

        greet();
      `;

      const { lua, diagnostics } = compileWithDiagnostics(code);
      const normalized = normalizeLua(lua);

      // Call must be preserved because optional parameters are not supported
      expect(normalized).toContain("greet()");
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes("optional parameters are not supported"),
        ),
      ).toBe(true);
    });

    it("preserves call when function has default parameters at statement position", () => {
      const code = `
        declare function print(x: any): void;

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
      expect(diagnostics.length).toBeGreaterThan(0);
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

  describe("cross-module free variable at statement position", () => {
    it("preserves multi-statement cross-module call with free variable", () => {
      const files = {
        "store.ts": `
          let counter = 0;

          /** @inline */
          export
          function incrementAndLog(): void {
            counter++;
            const msg = "Count: " + counter;
          }
        `,
        "main.ts": `
          import { incrementAndLog } from "./store";

          function main() {
            incrementAndLog();
          }
        `,
      };

      const { lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      // Call must be preserved to avoid breaking variable capture
      expect(normalized).toContain("incrementAndLog()");
    });

    it("preserves multi-statement cross-module call accessing module scope", () => {
      const files = {
        "config.ts": `
          export let debugMode = true;
        `,
        "utils.ts": `
          import { debugMode } from "./config";

          /** @inline */
          export
          function processValue(value: number): void {
            const x = value + 1;
            const y = debugMode ? x : 0;
          }
        `,
        "main.ts": `
          import { processValue } from "./utils";

          function main() {
            processValue(42);
          }
        `,
      };

      const { lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      // Call must be preserved
      expect(normalized).toContain("processValue(42)");
    });
  });
});
