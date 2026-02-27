// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("localizer", () => {
  describe("positive cases (hoisted)", () => {
    it("hoists math.ceil used 2+ times at module scope", () => {
      const lua = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x + 1);",
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ceil = math.ceil");
      expect(lua).toContain("ceil(x)");
    });

    it("hoists chain inside function body with scope: function", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "function process() {",
          "  const a = Math.ceil(x);",
          "  const b = Math.ceil(x + 1);",
          "  return a + b;",
          "}",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "function" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ceil = math.ceil");
      expect(lua).toContain("ceil(x)");
    });

    it("scope: all hoists at module level, no redundant function-level hoist", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "const a = Math.ceil(x);",
          "const b = Math.ceil(x + 1);",
          "function process() {",
          "  return Math.ceil(x);",
          "}",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "all" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // Should appear only once as a module-level local
      const matches = lua.match(/local ceil = math\.ceil/g);
      expect(matches).toHaveLength(1);
    });

    it("hoists three-segment chain", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "const a = config.graphics.width;",
          "const b = config.graphics.width;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      expect(lua).toContain("local width = config.graphics.width");
    });

    it("hoists two different chains each meeting threshold", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "const a = Math.ceil(x); const b = Math.ceil(x);",
          "const c = Math.floor(x); const d = Math.floor(x);",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ceil = math.ceil");
      expect(lua).toContain("local floor = math.floor");
    });
  });

  describe("negative cases (not hoisted)", () => {
    it("does not hoist chain used only once", () => {
      const lua = compile("declare const x: number; const a = Math.ceil(x);", {
        pluginOptions: { rules: { localizer: { scope: "module" } } },
        luaTarget: tstl.LuaTarget.LuaJIT,
      });
      expect(lua).not.toContain("local ceil");
      expect(lua).toContain("math.ceil");
    });

    it("does not hoist chain whose base is locally defined in the same scope", () => {
      const lua = compile(
        [
          "const config = { graphics: { width: 1920, height: 1080 } };",
          "const a = config.graphics.width;",
          "const b = config.graphics.width;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      // config is a local — hoisting "local width = config.graphics.width" above
      // config's definition would make config nil at that point
      expect(lua).not.toContain("local width");
      expect(lua).toContain("config.graphics.width");
    });

    it("does nothing when rule is disabled", () => {
      const lua = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x + 1);",
        {
          pluginOptions: { rules: { localizer: false } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).not.toContain("local ceil");
    });
  });

  describe("configuration", () => {
    it("threshold: 3 with 2 uses does not hoist, with 3 uses hoists", () => {
      const twoUses = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x);",
        {
          pluginOptions: { rules: { localizer: { threshold: 3, scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(twoUses).not.toContain("local ceil");

      const threeUses = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x); const c = Math.ceil(x);",
        {
          pluginOptions: { rules: { localizer: { threshold: 3, scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(threeUses).toContain("local ceil = math.ceil");
    });

    it("scope: function does not hoist module-level chains", () => {
      const lua = compile(
        ["declare const x: number;", "const a = Math.ceil(x);", "const b = Math.ceil(x);"].join(
          "\n",
        ),
        {
          pluginOptions: { rules: { localizer: { scope: "function" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).not.toContain("local ceil");
    });

    it("scope: module counts chains inside functions for module-level hoist", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "function process() {",
          "  const a = Math.ceil(x);",
          "  const b = Math.ceil(x);",
          "  return a + b;",
          "}",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ceil = math.ceil");
    });
  });

  describe("interaction with other rules", () => {
    it("math-intrinsics transforms Math.floor to inline on PUC — nothing for localizer to hoist", () => {
      const lua = compile(
        "declare const x: number; const a = Math.floor(x); const b = Math.floor(x);",
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      // PUC target: math-intrinsics replaces Math.floor with x - x % 1
      expect(lua).not.toContain("math.floor");
      expect(lua).not.toContain("local floor");
      expect(lua).toContain("x % 1");
    });

    it("LuaJIT target: math-intrinsics skips, localizer hoists math.floor", () => {
      const lua = compile(
        "declare const x: number; const a = Math.floor(x); const b = Math.floor(x);",
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // LuaJIT: math-intrinsics doesn't transform, localizer hoists
      expect(lua).toContain("local floor = math.floor");
      expect(lua).toContain("floor(x)");
    });
  });
});
