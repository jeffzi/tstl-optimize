import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("dead-local", () => {
  it("removes unused inline arg temp", () => {
    const lua = compile(`
      /** @inline */
      function double(x: number): number { return x * 2; }
      const result = double(21);
    `);
    // ____inline_arg_0 should be eliminated as an unused temp
    expect(lua).not.toContain("____inline_arg_");
  });

  it("preserves variable that is read in same scope", () => {
    const lua = compile("function f() { const x = 1; return x; }");
    expect(lua).toContain("x = 1");
  });

  it("removes unused variable with pure RHS (literal)", () => {
    const lua = compile("function f() { const x = 42; }");
    expect(lua).not.toContain("x = 42");
  });

  it("preserves variable whose RHS has a side effect (call expression)", () => {
    const lua = compile(`
      declare function someFunc(): number;
      function f() { const x = someFunc(); }
    `);
    // The call must still execute; the whole declaration stays
    expect(lua).toContain("someFunc()");
  });

  it("does NOT remove module-level unused locals", () => {
    // Top-level const — module scope, out of scope for dead-local
    const lua = compile("const x = 1;");
    expect(lua).toContain("x = 1");
  });

  it("does NOT touch multi-LHS declarations", () => {
    // local a, b = f() — must not be removed
    const lua = compile(`
      declare function pair(): [number, number];
      function f() {
        const [a, b] = pair();
        return a + b;
      }
    `);
    expect(lua).toMatch(/local a, b\b/);
    expect(lua).toContain("a + b");
  });

  it("preserves variable used inside a nested closure", () => {
    const lua = compile(`
      function outer() {
        const x = 1;
        const fn = () => x;
        return fn();
      }
    `);
    // x is captured by the closure — must not be removed
    // (merge-locals may merge x and fn into one statement, but x must still be declared)
    expect(lua).toMatch(/local x[,\s]/);
  });

  it("removes unused local function declaration (post-inline residue)", () => {
    const lua = compile(`
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      const r1 = add(1, 2);
      const r2 = add(3, 4);
    `);
    expect(lua).not.toContain("local function add");
  });

  it("rule can be disabled via config", () => {
    const lua = compile("function f() { const x = 42; }", {
      pluginOptions: { rules: { "dead-local": false } },
    });
    expect(lua).toContain("x = 42");
  });

  describe("nested function expressions", () => {
    it.each([
      {
        name: "callback passed as a call argument",
        source: `
          declare function run(fn: () => number): void;
          function outer() {
            run(function(): number {
              const unused = 42;
              const result = 1;
              return result;
            });
          }
        `,
      },
      {
        name: "function stored in a table value",
        source: `
          function outer() {
            const obj = { handler: function(): number {
              const unused = 42;
              const result = 1;
              return result;
            } };
            return obj;
          }
        `,
      },
    ])("removes unused local inside $name", ({ source }) => {
      const lua = compile(source);

      expect(lua).not.toContain("unused");
      expect(lua).toContain("result");
    });
  });

  describe("write-only locals (assignment without read)", () => {
    it("preserves declaration when local is assigned after initialization", () => {
      const lua = compile(`
        function f() {
          let x = 1;
          x = 5;
        }
      `);
      // The declaration must be kept because x is assigned to
      expect(lua).toContain("local x");
      expect(lua).toMatch(/local x\s*=\s*1/);
    });

    it("preserves declaration when local with impure RHS is assigned", () => {
      const lua = compile(`
        declare function foo(): number;
        declare function bar(): number;
        function f() {
          let x = foo();
          x = bar();
        }
      `);
      // x is assigned to, so declaration must be kept (even though RHS is impure)
      expect(lua).toContain("local x");
      expect(lua).toContain("foo()");
    });

    it("still removes unused local when NOT followed by assignment", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          const y = 2;
          return y;
        }
      `);
      // x is never read and never assigned — should be eliminated
      expect(lua).not.toContain("x");
      expect(lua).toContain("y");
    });

    it("preserves declaration when local is assigned and then read", () => {
      const lua = compile(`
        function f() {
          let x = 1;
          x = 2;
          return x;
        }
      `);
      // x is assigned and read — declaration must be kept
      expect(lua).toContain("local x");
      expect(lua).toContain("x = 2");
    });
  });
});
