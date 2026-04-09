import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("merge-locals coverage", () => {
  it("Line 39-40: functionBodyReferencesAnyOf shadowing", () => {
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

  it("Lines 70-78: IfStatement capture detection (and negative case)", () => {
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
    expect(lua).toMatch(/local .*e, fn5/);
  });

  it("Lines 81-90: While and Repeat negative cases", () => {
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
    expect(lua).toMatch(/local .*a, fn1/);
    expect(lua).toMatch(/local .*b, fn2/);
  });

  it("Lines 94-103: ForStatement capture detection (and negative case)", () => {
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
    expect(lua).toMatch(/local .*d, fn4/);
    expect(lua).toMatch(/local .*e, fn5/);
  });

  it("Lines 106-115: ForInStatement capture detection", () => {
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
    expect(lua).toMatch(/local .*b, fn2/);
  });

  it("Lines 117-119: DoStatement capture detection", () => {
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

  it("Lines 57-62, 121-125: Assignment and ExpressionStatement capture", () => {
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
    expect(lua).toMatch(/local .*d, fn4/);
  });

  it("Lines 134-140: TableExpression capture detection (keys and values)", () => {
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

  it("Lines 150-156: MethodCallExpression capture detection (prefix and params)", () => {
    const code = `
      function test() {
        const a: any = { method: () => 1 };
        const b = 1;
        const fn1 = function() { return a.method(); }; // captures a (prefix)
        const c = 1;
        const fn2 = function() { const x: any = {}; return x.method(c); }; // captures c (param)
        fn1(); fn2();
        return b + c;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("local a, fn1");
    expect(lua).not.toContain("local c, fn2");
  });

  it("Lines 168-172: TableIndexExpression capture detection", () => {
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

  it("Lines 174-176: ParenthesizedExpression capture detection", () => {
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

  it("Lines 189-191: expressionReferencesAnyOf shadowing and Literal branches", () => {
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
    expect(lua).toMatch(/local .*a, fn1/);
    expect(lua).toMatch(/local .*b, fn2/);
  });

  it("isMergeable branches: Multiple LHS and Multiple RHS", () => {
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

  it("Empty file / no statements", () => {
    const code = "";
    const lua = normalizeLua(compile(code));
    expect(lua).toBe("");
  });
});
