import { describe, expect, it } from "vitest";
import { compile, compileMultiFileWithDiagnostics } from "../helpers";

function wrapBody(body: string): string {
  return `function f() { ${body} } export function g() { return f(); }`;
}

interface LiteralTestCase {
  name: string;
  declaration: string;
  expectedInLua: string;
}

interface CrossModuleLiteralCase {
  type: string;
  tsValue: string;
  luaExpected: string;
}

const CROSS_MODULE_LITERAL_CASES: CrossModuleLiteralCase[] = [
  {
    type: "number",
    tsValue: "42",
    luaExpected: "____exports.OUT = 42",
  },
  {
    type: "negative number",
    tsValue: "-5",
    luaExpected: "____exports.OUT = (-5)",
  },
  {
    type: "string",
    tsValue: '"hello"',
    luaExpected: '____exports.OUT = "hello"',
  },
  {
    type: "boolean",
    tsValue: "true",
    luaExpected: "____exports.OUT = true",
  },
];

describe("constant-propagation", () => {
  describe("when propagating simple literals", () => {
    const cases: LiteralTestCase[] = [
      {
        name: "positive number",
        declaration: "const x = 42; return x;",
        expectedInLua: "return 42",
      },
      {
        name: "negative number",
        declaration: "const x = -5; return x;",
        expectedInLua: "return (-5)",
      },
      {
        name: "string",
        declaration: 'const s = "hello"; return s;',
        expectedInLua: 'return "hello"',
      },
      { name: "true", declaration: "const b = true; return b;", expectedInLua: "return true" },
      { name: "false", declaration: "const b = false; return b;", expectedInLua: "return false" },
    ];

    it.each(cases)("propagates $name literal to read sites", ({ declaration, expectedInLua }) => {
      const lua = compile(wrapBody(declaration));
      expect(lua).toContain(expectedInLua);
      // Verify the original variable reference is NOT in the Lua (only the literal is used).
      const varName = declaration.match(/const\s+(\w+)/)?.[1];
      expect(lua).not.toContain(`return ${varName}`);
    });
  });

  describe("when local is reassigned after declaration", () => {
    it("does NOT propagate when reassigned", () => {
      const lua = compile(wrapBody("let x = 1; x = 2; return x;"));
      expect(lua).toContain("return x");
      expect(lua).not.toContain("return 1");
    });
  });

  describe("when local is read inside a nested function body", () => {
    it("does NOT propagate reads inside function expressions", () => {
      const lua = compile(
        wrapBody("const x = 1; const fn = function() { return x; }; return fn();"),
      );
      expect(lua).toContain("return x");
      expect(lua).not.toContain("return 1");
    });
  });

  describe("when initializer is not a literal", () => {
    it("does NOT propagate non-literal expressions", () => {
      const source = `
        function pair(): [number, number] { return [1, 2]; }
        function f() { const x = pair()[0]; return x; }
        export function g() { return f(); }
      `;
      const lua = compile(source, { skipLuaCheck: true });
      expect(lua).not.toContain("return 1");
    });
  });

  describe("when declaration has multiple LHS", () => {
    it("does NOT propagate destructured locals", () => {
      const source = `
        function pair(): [number, number] { return [1, 2]; }
        function f() { const [a, b] = pair(); return a; }
        export function g() { return f(); }
      `;
      const lua = compile(source, { skipLuaCheck: true });
      expect(lua).toContain("return a");
    });
  });

  describe("at module level", () => {
    it("propagates module-level constants to subsequent statements", () => {
      const lua = compile("const X = 42; export const Y = X;");
      expect(lua).toContain("____exports.Y = 42");
      expect(lua).not.toContain("____exports.Y = X");
    });
  });

  describe("inside function bodies", () => {
    it("propagates constants within function scope", () => {
      const source = `
        function f(side_effect: () => void) {
          const x = 10;
          const y = x;
          side_effect();
          return y;
        }
        export function g() { return f(() => {}); }
      `;
      const lua = compile(source);
      expect(lua).toContain("return 10");
      expect(lua).not.toContain("return y");
    });
  });

  describe("in nested function bodies", () => {
    it("propagates outer and inner constants independently", () => {
      const source = `
        function f(side_effect: () => void) {
          const a = 1;
          const z = a;
          function g() {
            const b = 2;
            const c = b;
            return c;
          }
          side_effect();
          return z;
        }
        export function h() { return f(() => {}); }
      `;
      const lua = compile(source);
      expect(lua).not.toContain("return c");
      expect(lua).not.toContain("return z");
    });
  });

  describe("when rule is disabled", () => {
    it("does not propagate when constant-propagation is disabled", () => {
      const lua = compile(wrapBody("const x = 42; return x;"), {
        pluginOptions: { rules: { "constant-propagation": false } },
      });
      expect(lua).toContain("return x");
      expect(lua).not.toContain("return 42");
    });
  });

  describe("when multiple read sites exist", () => {
    it("propagates to all read sites", () => {
      const source = `
        function f(fn: (x: number) => void) {
          const x = 5;
          let a = x;
          let b = x + x;
          fn(a);
          fn(b);
          return x;
        }
        export function g() { return f(() => {}); }
      `;
      const lua = compile(source);
      expect(lua).toContain("5, 10");
      expect(lua).toContain("return 5");
      expect(lua).not.toContain("= x");
    });
  });

  describe("when a property access has no const binding", () => {
    it("passes through regular object property access unchanged", () => {
      // obj.X is a non-import PropertyAccessExpression; the property symbol carries no
      // const literal initializer, so resolveConstLiteral returns undefined and the
      // visitor falls through to TSTL's default transform.
      const lua = compile("const obj = { X: 42 }; export const OUT = obj.X;");
      expect(lua).toContain("obj.X");
    });

    it("passes through property access on an any-typed value unchanged", () => {
      // getSymbolAtLocation returns undefined for a property access on `any`,
      // so the PropertyAccessExpression visitor exits early via superTransformExpression.
      const lua = compile("declare const x: any; export const OUT = x.prop;");
      expect(lua).toContain("x.prop");
    });
  });

  describe("cross-module propagation", () => {
    describe("with named imports", () => {
      it.each(CROSS_MODULE_LITERAL_CASES)("propagates $type literal", ({
        tsValue,
        luaExpected,
      }) => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": `export const X = ${tsValue};`,
          "main.ts": "import { X } from './shared'; export const OUT = X;",
        });
        expect(lua).toContain(luaExpected);
      });

      it("propagates computed const expression", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": "const BITS = 24; export const MAX = 2 ** BITS;",
          "main.ts": "import { MAX } from './shared'; export const OUT = MAX;",
        });
        expect(lua).toContain("____exports.OUT = 16777216");
      });

      it("propagates through import alias chain", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "constants.ts": "export const VALUE = 7;",
          "bridge.ts": "import { VALUE } from './constants'; export { VALUE };",
          "main.ts": "import { VALUE } from './bridge'; export const OUT = VALUE;",
        });
        expect(lua).toContain("____exports.OUT = 7");
      });

      it("chains with constant-folding when propagated literal feeds into expression", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": "export const X = 5;",
          "main.ts": "import { X } from './shared'; export const Y = X + 1;",
        });
        expect(lua).toContain("____exports.Y = 6");
      });

      it("propagates constant even when also used in other expressions", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": "export const X = 42;",
          "main.ts": "import { X } from './shared'; export const Y = X; export const Z = X + 10;",
        });
        expect(lua).toContain("____exports.Y = 42");
        expect(lua).toContain("52");
      });
    });

    describe("with namespace imports", () => {
      it.each(CROSS_MODULE_LITERAL_CASES)("propagates $type literal", ({
        tsValue,
        luaExpected,
      }) => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": `export const X = ${tsValue};`,
          "main.ts": "import * as mod from './shared'; export const OUT = mod.X;",
        });
        expect(lua).toContain(luaExpected);
      });

      it("propagates computed const expression", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": "const BITS = 24; export const MAX = 2 ** BITS;",
          "main.ts": "import * as mod from './shared'; export const OUT = mod.MAX;",
        });
        expect(lua).toContain("____exports.OUT = 16777216");
      });

      it("propagates through re-export chain", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "constants.ts": "export const VALUE = 7;",
          "bridge.ts": "import * as c from './constants'; export const VALUE = c.VALUE;",
          "main.ts": "import * as mod from './bridge'; export const OUT = mod.VALUE;",
        });
        expect(lua).toContain("____exports.OUT = 7");
      });

      it("chains with constant-folding when propagated literal feeds into expression", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": "export const X = 5;",
          "main.ts": "import * as mod from './shared'; export const Y = mod.X + 1;",
        });
        expect(lua).toContain("____exports.Y = 6");
      });

      it("propagates constant even when also used in other expressions", () => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": "export const X = 42;",
          "main.ts":
            "import * as mod from './shared'; export const Y = mod.X; export const Z = mod.X + 10;",
        });
        expect(lua).toContain("____exports.Y = 42");
        expect(lua).toContain("52");
      });

      it.each([
        {
          name: "mutable export (let)",
          sharedCode: "export let X = 42;",
        },
        {
          name: "non-literal const (function call)",
          sharedCode: "function compute() { return 42; } export const X = compute();",
        },
      ])("does NOT propagate $name", ({ sharedCode }) => {
        const { lua } = compileMultiFileWithDiagnostics({
          "shared.ts": sharedCode,
          "main.ts": "import * as mod from './shared'; export const OUT = mod.X;",
        });
        expect(lua).not.toContain("____exports.OUT = 42");
      });
    });
  });
});
