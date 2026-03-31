// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("rule interaction: inline + localizer + math-intrinsics", () => {
  describe("localizer processes do...end blocks", () => {
    it("hoists repeated chains from inside do...end to module scope", () => {
      // Use LuaJIT target so math-intrinsics doesn't replace Math.ceil
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
      // Localizer should hoist math.ceil since it is a stdlib root and appears 3 times
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("hoists chains from inside nested do...end blocks", () => {
      const lua = compile(
        `
        declare const x: number;
        {
          {
            const a = Math.ceil(x);
            const b = Math.ceil(x + 1);
          }
        }
      `,
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // Even doubly nested do...end should be processed
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
      // obj is defined inside the do...end block. The module-scope pass sees obj in
      // scopeDefs and correctly skips hoisting (it cannot safely insert a local alias
      // before obj's own declaration). No ____obj_nested_value alias is emitted at all.
      expect(lua).not.toContain("____obj");
      // The do...end block structure is preserved and obj.nested.value is used directly.
      expect(lua).toContain("do");
      expect(lua).toContain("obj.nested.value");
    });
  });

  describe("math-intrinsics with inline", () => {
    it("replaces Math.floor inside inlined expression", () => {
      const lua = compile(`
        /** @inline */
        function fastFloor(x: number) { return Math.floor(x); }
        declare const v: number;
        const r = fastFloor(v);
      `);
      // Math.floor(x) should become x - x % 1 via math-intrinsics
      expect(lua).toContain("% 1");
      expect(lua).not.toContain("math.floor");
      // Call site should be inlined (r = ... not r = fastFloor(v))
      expect(lua).not.toContain("r = fastFloor(");
    });

    it("replaces Math.abs inside inlined expression", () => {
      const lua = compile(`
        /** @inline */
        function absVal(x: number) { return Math.abs(x); }
        declare const v: number;
        const r = absVal(v);
      `);
      // Math.abs should be replaced by intrinsic
      expect(lua).not.toContain("math.abs");
      // Call site should be inlined
      expect(lua).not.toContain("r = absVal(");
    });

    it("replaces Math.sqrt inside inlined expression", () => {
      const lua = compile(`
        /** @inline */
        function sqrtVal(x: number) { return Math.sqrt(x); }
        declare const v: number;
        const r = sqrtVal(v);
      `);
      // Math.sqrt should be replaced by x ^ 0.5
      expect(lua).toContain("^ 0.5");
      expect(lua).not.toContain("math.sqrt");
      // Call site should be inlined
      expect(lua).not.toContain("r = sqrtVal(");
    });
  });

  describe("inline + localizer combined", () => {
    it("localizer processes property chains from inlined expression body", () => {
      const lua = compile(
        `
        declare const obj: { pos: { x: number } };
        /** @inline */
        function getX() { return obj.pos.x; }
        const a = getX();
        const b = getX();
        const c = getX();
      `,
        {
          pluginOptions: {
            rules: { localizer: { scope: "module", include: ["obj"] } },
          },
        },
      );
      // After inlining, obj.pos.x appears 3 times at module scope
      // Localizer should hoist it
      expect(lua).toContain("____obj_pos_x");
      // Call sites should be inlined (no getX() calls in Lua output)
      expect(lua).not.toContain("a = getX(");
    });

    it("localizer and inline both active without conflict", () => {
      const lua = compile(
        `
        declare const x: number;
        /** @inline */
        function fastFloor(x: number) { return Math.floor(x); }
        declare const a: number;
        const r1 = fastFloor(a);
        const r2 = Math.ceil(1);
        const r3 = Math.ceil(2);
        const r4 = Math.ceil(3);
      `,
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // Inline should work (no call to fastFloor at call site)
      expect(lua).not.toContain("r1 = fastFloor(");
      // Localizer should hoist math.ceil
      expect(lua).toContain("____math_ceil");
    });
  });
});
