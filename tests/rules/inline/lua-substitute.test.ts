import { describe, expect, it } from "vitest";
import { compile } from "../../helpers";

const NO_PROP = { pluginOptions: { rules: { "constant-propagation": false } } };

describe("inline: Lua body substitution", () => {
  describe("when the call site passes fewer arguments than declared parameters", () => {
    it.each([
      {
        name: "undefined guard comparison",
        body: "return b === undefined ? a : a + b;",
        expected: "____exports.r = (nil == nil and q or q + nil)",
      },
      {
        name: "arithmetic fallback",
        body: "return a + (b ?? 10);",
        expected: "____exports.r = (q + (nil or 10))",
      },
    ])("substitutes nil for the missing optional parameter ($name)", ({ body, expected }) => {
      const lua = compile(
        `
        /** @inline */
        function pick(a: number, b?: number) { ${body} }
        declare const q: number;
        export const r = pick(q);
      `,
        NO_PROP,
      );

      expect(lua).toContain(expected);
    });
  });

  describe("when a body local collides with a call-site local", () => {
    it("scopes the inlined body so the call-site local is not captured", () => {
      const lua = compile(
        `
        /** @inline */
        function scale(x: number) { const t = x * 2; return t + 1; }
        declare const n: number;
        export function run(): number {
          const t = 5;
          const r = scale(n);
          return r + t;
        }
      `,
        NO_PROP,
      );

      // The body's `t` lives inside a do-block; the trailing read of the
      // call-site `t` still sees 5.
      expect(lua).toContain("local t, r = 5, nil");
      expect(lua).toContain("local t = n * 2");
      expect(lua).toContain("r = t + 1");
      expect(lua).toContain("return r + t");
    });
  });

  describe("when the call is the operand of a return statement", () => {
    it("inlines the body expression directly into the return", () => {
      const lua = compile(
        `
        /** @inline */
        function triple(x: number) { return x * 3; }
        export function outer(y: number): number { return triple(y); }
      `,
        NO_PROP,
      );

      expect(lua).toContain("return (y * 3)");
      expect(lua).not.toContain("triple");
    });
  });

  describe("when the inlined result feeds a call argument", () => {
    it("leaves no temporaries behind", () => {
      const lua = compile(
        `
        /** @inline */
        function inc(x: number) { return x + 1; }
        declare function use(v: number): void;
        export function m(y: number) { use(inc(y)); }
      `,
        NO_PROP,
      );

      expect(lua).toContain("use((y + 1))");
      expect(lua).not.toContain("____inline");
    });
  });
});
