import { describe, it } from "vitest";
import { compile, expectLuaSnippets } from "../../helpers";

const NO_PROP = { pluginOptions: { rules: { "constant-propagation": false } } };

describe("inline: call-site eligibility", () => {
  describe("when the function has no @inline annotation", () => {
    it("never inlines — the call and the definition both survive", () => {
      const lua = compile(
        `
        function double(x: number) { return x * 2; }
        declare const a: number;
        export const r = double(a);
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "double(a)"],
        excludes: ["a * 2"],
      });
    });
  });

  describe("when the callee is not a direct reference to the annotated function", () => {
    it("leaves a call through an alias variable intact", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        const alias = double;
        export const r = alias(a);
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "local alias = double", "alias(a)"],
      });
    });

    it("leaves a call through a conditional callee intact", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        function triple(x: number) { return x * 3; }
        declare const cond: boolean;
        declare const a: number;
        export const r = (cond ? double : triple)(a);
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "(cond and double or triple)(a)"],
      });
    });
  });

  describe("when the function is referenced via shorthand property assignment", () => {
    it("keeps the definition for shorthand property ref (arrow function)", () => {
      const lua = compile(
        `
        /** @inline */
        const double = (x: number) => x * 2;
        export const holder = { double };
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "double = double"],
      });
    });

    it("keeps the definition for shorthand property ref (function declaration)", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        export const holder = { double };
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "double = double"],
      });
    });

    it("inlines call sites but keeps definition for value reference", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        declare const a: number;
        export const holder = { double };
        export const inlined = double(a);
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "double = double", "a * 2"],
      });
    });

    it("already blocks erasure for explicit property syntax", () => {
      const lua = compile(
        `
        /** @inline */
        function double(x: number) { return x * 2; }
        export const holder = { double: double };
      `,
        NO_PROP,
      );

      expectLuaSnippets(lua, {
        contains: ["local function double", "double = double"],
      });
    });
  });
});
