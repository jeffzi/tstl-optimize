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
      expect(lua).toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("____math_ceil(x)");
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
      expect(lua).toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("____math_ceil(x)");
    });

    it("hoists chain inside for-in loop body with scope: function", () => {
      const lua = compile(
        [
          "function process(items: Array<{x: {y: number}}>) {",
          "  for (const item of items) {",
          "    const a = item.x.y;",
          "    const b = item.x.y;",
          "  }",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      expect(lua).toContain("local ____item_x_y = item.x.y");
    });

    it("hoists parameter-based chain inside function body with scope: function", () => {
      const lua = compile(
        [
          "function process(obj: { x: { y: number } }) {",
          "  const a = obj.x.y;",
          "  const b = obj.x.y;",
          "  return a + b;",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      expect(lua).toContain("local ____obj_x_y = obj.x.y");
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
      const matches = lua.match(/local ____math_ceil = math\.ceil/g);
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
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
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
      expect(lua).toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("local ____math_floor = math.floor");
    });

    it("hoists two chains sharing the same last segment", () => {
      const lua = compile(
        [
          "declare const a: { x: number };",
          "declare const b: { x: number };",
          "const r = a.x + a.x + b.x + b.x;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      expect(lua).toContain("local ____a_x = a.x");
      expect(lua).toContain("local ____b_x = b.x");
    });
  });

  describe("negative cases (not hoisted)", () => {
    it("does not hoist chain used only once", () => {
      const lua = compile("declare const x: number; const a = Math.ceil(x);", {
        pluginOptions: { rules: { localizer: { scope: "module" } } },
        luaTarget: tstl.LuaTarget.LuaJIT,
      });
      expect(lua).not.toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("math.ceil");
    });

    it("hoists chain even when last segment matches an existing local (prefixed name avoids collision)", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "const floor = 42;",
          "const a = Math.floor(x);",
          "const b = Math.floor(x);",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).toContain("local ____math_floor = math.floor");
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
      // config is a local — hoisting above its definition would make config nil
      expect(lua).not.toContain("local ____config_graphics_width = config.graphics.width");
      expect(lua).toContain("config.graphics.width");
    });

    it("hoists chain even when last segment matches a function parameter (prefixed name avoids collision)", () => {
      const lua = compile(
        [
          "function process(y: number, obj: { x: { y: number } }) {",
          "  const a = obj.x.y;",
          "  const b = obj.x.y;",
          "  return a + b + y;",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      expect(lua).toContain("local ____obj_x_y = obj.x.y");
    });

    it("hoists chain even when last segment matches a loop variable (prefixed name avoids collision)", () => {
      const lua = compile(
        [
          "declare const items: number[];",
          "declare const obj: { x: number };",
          "function process() {",
          "  for (const x of items) {",
          "    const a = obj.x + obj.x + x;",
          "  }",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      expect(lua).toContain("local ____obj_x = obj.x");
    });

    it("does not hoist chain whose base is a function parameter to module level", () => {
      const lua = compile(
        [
          "function process(obj: { x: { y: number } }) {",
          "  const a = obj.x.y;",
          "  const b = obj.x.y;",
          "  return a + b;",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      expect(lua).not.toContain("local ____obj_x_y = obj.x.y");
    });

    it("does not hoist chain whose base is a for-in loop variable to module level", () => {
      const lua = compile(
        [
          "function process(items: Array<{x: {y: number}}>) {",
          "  for (const item of items) {",
          "    const a = item.x.y;",
          "    const b = item.x.y;",
          "  }",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      expect(lua).not.toContain("local ____item_x_y = item.x.y");
    });

    it("does not hoist chain appearing only in and/or short-circuit RHS", () => {
      const lua = compile(
        [
          "declare const obj: { name: string } | undefined;",
          "const a = obj && obj.name;",
          "const b = obj && obj.name;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" } } } },
      );
      // obj.name is inside `obj and obj.name` — conditionally evaluated.
      // Hoisting would make it unconditional, crashing when obj is nil.
      expect(lua).not.toContain("local ____obj_name = obj.name");
    });

    it("does nothing when rule is disabled", () => {
      const lua = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x + 1);",
        {
          pluginOptions: { rules: { localizer: false } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).not.toContain("local ____math_ceil = math.ceil");
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
      expect(twoUses).not.toContain("local ____math_ceil = math.ceil");

      const threeUses = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x); const c = Math.ceil(x);",
        {
          pluginOptions: { rules: { localizer: { threshold: 3, scope: "module" } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(threeUses).toContain("local ____math_ceil = math.ceil");
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
      expect(lua).not.toContain("local ____math_ceil = math.ceil");
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
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });
  });

  describe("array element localization", () => {
    it("localizes read-only array access", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          // $range(0, n-1) → loop-rebase produces `for i = 1, n` with clean arr[i]
          "for (const i of $range(0, n - 1)) {",
          "  const a = arr[i] + arr[i];",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      expect(lua).toContain("local ____arr = arr[i]");
      expect(lua).toContain("____arr + ____arr");
      // No write-back — arr[i] was never assigned to
      expect(lua).not.toMatch(/arr\[i\] = ____arr/);
    });

    it("localizes read+write array access with write-back", () => {
      const lua = compile(
        [
          "declare const vel: number[];",
          "declare const n: number;",
          "declare const friction: number;",
          "declare const dt: number;",
          "for (const i of $range(0, n - 1)) {",
          "  vel[i] = vel[i] * friction;",
          "  const pos = vel[i] * dt;",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // 2 reads (RHS of assignment + RHS of const) ≥ threshold 2
      expect(lua).toContain("local ____vel = vel[i]");
      expect(lua).toContain("____vel * friction");
      expect(lua).toContain("____vel * dt");
      // Write-back at end of loop body
      expect(lua).toContain("vel[i] = ____vel");
    });

    it("does not localize below threshold", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "for (const i of $range(0, n - 1)) {",
          "  const a = arr[i];",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // Only 1 read — below default threshold 2
      expect(lua).not.toContain("local ____arr");
      expect(lua).toContain("arr[i]");
    });

    it("does not localize non-loop-var index", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare const j: number;",
          "for (const i of $range(0, n - 1)) {",
          "  const a = arr[j] + arr[j];",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // j is not the loop variable — not localized
      expect(lua).not.toContain("local ____arr");
    });

    it("does not localize complex index expression", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "for (const i of $range(0, n - 1)) {",
          "  const a = arr[i + 1] + arr[i + 1];",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // i + 1 is not a plain identifier — not localized
      expect(lua).not.toContain("local ____arr");
    });

    it("does not localize when base is locally defined", () => {
      const lua = compile(
        [
          "declare const n: number;",
          "for (const i of $range(0, n - 1)) {",
          "  const arr: number[] = [];",
          "  const a = arr[i] + arr[i];",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      expect(lua).not.toContain("local ____arr = arr[i]");
    });

    it("skips written arrays when loop has early exit", () => {
      const lua = compile(
        [
          "declare const vel: number[];",
          "declare const n: number;",
          "declare const friction: number;",
          "for (const i of $range(0, n - 1)) {",
          "  vel[i] = vel[i] * friction;",
          "  const v = vel[i];",
          "  if (v > 100) { break; }",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // vel has writes + loop has break → write-back might not execute
      expect(lua).not.toContain("local ____vel = vel[i]");
    });

    it("does not localize when loop body has function call", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare function mutate(t: number[]): void;",
          "for (const i of $range(0, n - 1)) {",
          "  arr[i] = arr[i] + 1;",
          "  mutate(arr);",
          "  const x = arr[i];",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // Function call could modify arr[i] — caching is unsafe
      expect(lua).not.toContain("local ____arr");
      expect(lua).toContain("arr[i]");
    });

    it("does not localize any base when loop body has function call", () => {
      const lua = compile(
        [
          "declare const a: number[];",
          "declare const b: number[];",
          "declare const n: number;",
          "declare function process(): void;",
          "for (const i of $range(0, n - 1)) {",
          "  const x = a[i] + a[i] + b[i] + b[i];",
          "  process();",
          "}",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "function" } } } },
      );
      // Even though process() doesn't take a or b as args, it could access them
      // as upvalues/globals — skip all bases when any call exists
      expect(lua).not.toContain("local ____a");
      expect(lua).not.toContain("local ____b");
    });

    it("works alongside static chain hoisting", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number; friction: number } };",
          "declare const velY: number[];",
          "declare const n: number;",
          "declare const dt: number;",
          "for (const i of $range(0, n - 1)) {",
          "  velY[i] = velY[i] + config.physics.gravity * dt;",
          "  velY[i] = velY[i] * config.physics.friction;",
          "}",
          // Extra use outside loop so each chain reaches threshold 2
          "const terminalSpeed = config.physics.gravity / config.physics.friction;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "all" } } } },
      );
      // Static chains hoisted at module level
      expect(lua).toContain("local ____config_physics_friction = config.physics.friction");
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
      // Array element localized in loop
      expect(lua).toContain("local ____velY = velY[i]");
      expect(lua).toContain("velY[i] = ____velY");
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
      expect(lua).not.toContain("local ____math_floor = math.floor");
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
      expect(lua).toContain("local ____math_floor = math.floor");
      expect(lua).toContain("____math_floor(x)");
    });
  });
});
