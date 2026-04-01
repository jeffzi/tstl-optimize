// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("rule interaction", () => {
  describe("localizer + blocks", () => {
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
      expect(lua).toContain("____math_ceil");
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

  describe("math-intrinsics + inline", () => {
    it("replaces Math functions inside inlined expression body", () => {
      const lua = compile(`
        /** @inline */
        function fastFloor(x: number) { return Math.floor(x); }
        declare const v: number;
        const r = fastFloor(v);
      `);
      expect(normalizeLua(lua)).toBe("r = (v - v % 1)");
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
      expect(lua).toMatch(/v - v % 1|____inline_arg_0 - ____inline_arg_0 % 1/);
      expect(lua).not.toContain("math.floor");
      expect(lua).not.toContain("doFloor(v)");
    });
  });

  describe("localizer + inline", () => {
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
      expect(lua).toContain("____math_floor");
      expect(lua).not.toContain("doWork(v)");
    });
  });
});
