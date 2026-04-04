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
    // Both names must still appear in output
    expect(lua).toContain("a");
    expect(lua).toContain("b");
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
    expect(lua).toContain("x = 1");
  });

  it("removes unused local function declaration (post-inline residue)", () => {
    const lua = compile(`
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      const r1 = add(1, 2);
      const r2 = add(3, 4);
    `);
    // The inlined function declaration should not appear
    expect(lua).not.toContain("local function add");
  });

  it("rule can be disabled via config", () => {
    const lua = compile("function f() { const x = 42; }", {
      pluginOptions: { rules: { "dead-local": false } },
    });
    // With rule disabled, unused local remains
    expect(lua).toContain("x = 42");
  });
});
