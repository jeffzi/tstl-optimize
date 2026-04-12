// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("optimize rule interactions", () => {
  describe("when localizer works with block-scoped code", () => {
    it("hoists repeated chains from inside do...end to module scope", () => {
      const lua = compile(
        `
        declare const x: number;
        {
          const a = Math.ceil(x);
          const b = Math.ceil(x + 1);
          const c = Math.ceil(x + 2);
        }
      `,
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("hoists chains from inside nested blocks", () => {
      const lua = compile(
        `
        declare const x: number;
        { { const a = Math.ceil(x); const b = Math.ceil(x + 1); } }
      `,
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain("local ____math_ceil = math.ceil");
      expect(normalizedLua).toContain("local a = ____math_ceil(x)");
      expect(normalizedLua).toContain("local b = ____math_ceil(x + 1)");
    });

    it("does not hoist chains rooted at block-local variables", () => {
      const lua = compile(
        `
        {
          const obj = { nested: { value: 1 } };
          const a = obj.nested.value;
          const b = obj.nested.value;
          const c = obj.nested.value;
        }
      `,
        {
          pluginOptions: {
            rules: { localizer: { scope: "module", include: ["obj"] } },
          },
        },
      );
      expect(lua).not.toContain("____obj");
      expect(lua).toContain("obj.nested.value");
    });
  });

  describe("when math-intrinsics and inline rules interact", () => {
    it("replaces Math functions inside inlined expression body", () => {
      const lua = compile(`
        /** @inline */
        function fastFloor(x: number) { return Math.floor(x); }
        declare const v: number;
        const r = fastFloor(v);
      `);
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain("r =");
      expect(normalizedLua).toContain("math.floor(v)");
      expect(normalizedLua).toContain("v - v % 1");
    });

    it("replaces Math functions inside inlined do...end block", () => {
      const lua = compile(`
        /** @inline */
        function doFloor(x: number): void {
          const y = Math.floor(x);
          const z = y + 1;
        }
        declare const v: number;
        doFloor(v);
      `);
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain(
        "local y = (____inline_arg_0 == math.huge or ____inline_arg_0 == -(math.huge)) and math.floor(____inline_arg_0) or ____inline_arg_0 - ____inline_arg_0 % 1",
      );
      expect(normalizedLua).not.toContain("doFloor(v)");
    });
  });

  describe("when localizer and inline rules interact", () => {
    it("processes property chains and calls from inlined body", () => {
      const src = `
        declare const obj: { pos: { x: number } };
        /** @inline */
        function getX() { return obj.pos.x; }
        const a = getX(); const b = getX(); const c = getX();
      `;
      const lua = compile(src, {
        pluginOptions: { rules: { localizer: { scope: "module", include: ["obj"] } } },
      });
      expect(lua).toContain("____obj_pos_x");
      expect(lua).not.toContain("getX(");
    });

    it("hoists repeated chains from inside inlined do...end block", () => {
      const src = `
        /** @inline */
        function doWork(x: number): void {
          const a = Math.floor(x);
          const b = Math.floor(x + 1);
          const c = Math.floor(x + 2);
        }
        declare const v: number;
        doWork(v);
      `;
      const lua = compile(src, {
        pluginOptions: { rules: { localizer: { scope: "module" } } },
        luaTarget: tstl.LuaTarget.LuaJIT,
      });
      const normalizedLua = normalizeLua(lua);
      expect(normalizedLua).toContain("local ____math_floor = math.floor");
      expect(normalizedLua).toContain("local a = ____math_floor(____inline_arg_0)");
      expect(normalizedLua).toContain("local b = ____math_floor(____inline_arg_0 + 1)");
      expect(normalizedLua).toContain("local c = ____math_floor(____inline_arg_0 + 2)");
      expect(normalizedLua).not.toContain("doWork(v)");
    });
  });
});
