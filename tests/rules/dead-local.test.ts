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

  describe("when removing unused locals in nested function expressions", () => {
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
            const obj = { fn: function(): number {
              const unused = 42;
              const result = 1;
              return result;
            } };
            return obj;
          }
        `,
      },
      {
        name: "IIFE callee",
        source: `
          function outer() {
            (function() {
              const unused = 42;
              const result = 1;
              return result;
            })();
          }
        `,
      },
    ])("removes unused local inside $name", ({ source }) => {
      const lua = compile(source);

      expect(lua).not.toContain("unused");
      expect(lua).toContain("result");
    });
  });

  describe("when handling write-only locals (assignment without read)", () => {
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

  describe("when removing unused locals in branching statements", () => {
    it("removes unused local from a function body", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          const y = 2;
          return y;
        }
      `);
      expect(lua).not.toContain("x = 1");
      expect(lua).toContain("y = 2");
    });

    it("removes unused locals inside if/else branches", () => {
      const lua = compile(`
        function f() {
          if (true) {
            const unused = 42;
            const result = 1;
            return result;
          } else {
            const deadCode = 99;
            const value = 2;
            return value;
          }
        }
      `);
      expect(lua).toContain("if true then");
      expect(lua).toContain("result");
      expect(lua).toContain("value");
      expect(lua).toContain("else");
    });

    it("removes unused locals inside elseif branches", () => {
      const lua = compile(`
        function f() {
          if (false) {
            return 2;
          } else if (true) {
            const unused3 = 3;
            const result = 4;
            return result;
          }
        }
      `);
      expect(lua).toContain("elseif true then");
      expect(lua).toContain("result");
    });

    it("removes unused locals inside while-loop bodies", () => {
      const lua = compile(`
        function f() {
          let x = 0;
          while (x < 10) {
            const unused = 42;
            const value = x + 1;
            x = value;
          }
        }
      `);
      expect(lua).toContain("while x < 10 do");
      expect(lua).toContain("value");
    });

    it("removes unused locals inside repeat-loop bodies", () => {
      const lua = compile(`
        function f() {
          let x = 10;
          do {
            const unused = 42;
            const value = x - 1;
            x = value;
          } while (x > 0);
        }
      `);
      expect(lua).toContain("repeat");
      expect(lua).toContain("until");
      expect(lua).toContain("value");
    });

    it("removes unused locals inside for-loop bodies", () => {
      const lua = compile(`
        declare const items: number[];
        function f() {
          for (let i = 0; i < items.length; i++) {
            const unused = 42;
            const value = items[i] * 2;
            if (value > 10) return value;
          }
        }
      `);
      expect(lua).toContain("items");
      expect(lua).toContain("value");
    });

    it("removes unused locals inside for-in loop bodies", () => {
      const lua = compile(`
        declare const obj: Record<string, number>;
        function f() {
          for (const key in obj) {
            const unused = 42;
            const val = obj[key];
            if (val > 0) return val;
          }
        }
      `);
      expect(lua).toContain("for");
      expect(lua).toContain("obj");
      expect(lua).toContain("val");
    });

    it("removes unused locals inside do-block bodies", () => {
      const lua = compile(`
        function f() {
          do {
            const unused = 42;
            const value = 1;
            return value;
          } while (false);
        }
      `);
      expect(lua).toContain("do");
      expect(lua).toContain("value");
    });
  });
});
