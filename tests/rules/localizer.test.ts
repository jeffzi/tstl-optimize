// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

const MODULE_SCOPE = { pluginOptions: { rules: { localizer: { scope: "module" as const } } } };
const FUNC_SCOPE = { pluginOptions: { rules: { localizer: { scope: "function" as const } } } };
const ALL_SCOPE = { pluginOptions: { rules: { localizer: { scope: "all" as const } } } };

describe("localizer", () => {
  describe("positive cases (hoisted)", () => {
    it("hoists math.ceil used 2+ times at module scope", () => {
      const lua = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x + 1);",
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
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
        { ...FUNC_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
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
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["item"] } },
          },
        },
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
        {
          pluginOptions: { rules: { localizer: { scope: "function" as const, include: ["obj"] } } },
        },
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
        { ...ALL_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
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
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
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
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
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
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["a", "b"] } },
          },
        },
      );
      expect(lua).toContain("local ____a_x = a.x");
      expect(lua).toContain("local ____b_x = b.x");
    });

    it("hoists chain even when last segment matches an existing local (prefixed name avoids collision)", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "const floor = 42;",
          "const a = Math.floor(x);",
          "const b = Math.floor(x);",
        ].join("\n"),
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
      expect(lua).toContain("local ____math_floor = math.floor");
      expect(lua).toContain("____math_floor(x)");
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
        {
          pluginOptions: { rules: { localizer: { scope: "function" as const, include: ["obj"] } } },
        },
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
        {
          pluginOptions: { rules: { localizer: { scope: "function" as const, include: ["obj"] } } },
        },
      );
      expect(lua).toContain("local ____obj_x = obj.x");
    });
  });

  describe("negative cases (not hoisted)", () => {
    it("does not hoist chain used only once", () => {
      const lua = compile("declare const x: number; const a = Math.ceil(x);", {
        ...MODULE_SCOPE,
        luaTarget: tstl.LuaTarget.LuaJIT,
      });
      expect(lua).not.toContain("local ____math_ceil = math.ceil");
      expect(lua).toContain("math.ceil");
    });

    it("does not hoist chain whose base is locally defined in the same scope", () => {
      const lua = compile(
        [
          "const config = { graphics: { width: 1920, height: 1080 } };",
          "const a = config.graphics.width;",
          "const b = config.graphics.width;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
      );
      // config is a local — hoisting above its definition would make config nil
      expect(lua).not.toContain("local ____config_graphics_width = config.graphics.width");
      expect(lua).toContain("config.graphics.width");
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
        { pluginOptions: { rules: { localizer: { scope: "module" as const, include: ["obj"] } } } },
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
        {
          pluginOptions: { rules: { localizer: { scope: "module" as const, include: ["item"] } } },
        },
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
        { pluginOptions: { rules: { localizer: { scope: "module" as const, include: ["obj"] } } } },
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
      const threshold3 = {
        pluginOptions: { rules: { localizer: { threshold: 3, scope: "module" as const } } },
        luaTarget: tstl.LuaTarget.LuaJIT,
      };
      const twoUses = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x);",
        threshold3,
      );
      expect(twoUses).not.toContain("local ____math_ceil = math.ceil");

      const threeUses = compile(
        "declare const x: number; const a = Math.ceil(x); const b = Math.ceil(x); const c = Math.ceil(x);",
        threshold3,
      );
      expect(threeUses).toContain("local ____math_ceil = math.ceil");
    });

    it("scope: function does not hoist module-level chains", () => {
      const lua = compile(
        ["declare const x: number;", "const a = Math.ceil(x);", "const b = Math.ceil(x);"].join(
          "\n",
        ),
        { ...FUNC_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
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
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
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
        FUNC_SCOPE,
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
        FUNC_SCOPE,
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
        FUNC_SCOPE,
      );
      // Only 1 read — below default threshold 2
      expect(lua).not.toContain("local ____arr");
      expect(lua).toContain("arr[i]");
    });

    it("localizes array element with write-only access (LHS writes counted)", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "for (const i of $range(0, n - 1)) {",
          "  arr[i] = 1;",
          "  arr[i] = 2;",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // 2 LHS writes ≥ threshold 2 — should localize and write-back
      expect(lua).toContain("local ____arr = arr[i]");
      expect(lua).toContain("arr[i] = ____arr");
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
        FUNC_SCOPE,
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
        FUNC_SCOPE,
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
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____arr = arr[i]");
    });

    it("skips written arrays when loop has early exit in if-block", () => {
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
        FUNC_SCOPE,
      );
      // vel has writes + loop has break → write-back might not execute
      expect(lua).not.toContain("local ____vel = vel[i]");
    });

    it("skips written arrays when loop has early exit in else-block", () => {
      const lua = compile(
        [
          "declare const vel: number[];",
          "declare const n: number;",
          "declare const friction: number;",
          "for (const i of $range(0, n - 1)) {",
          "  vel[i] = vel[i] * friction;",
          "  const v = vel[i];",
          "  if (v < 100) { vel[i] = v; } else { break; }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____vel = vel[i]");
    });

    it("skips written arrays when loop has early exit in elseif chain", () => {
      const lua = compile(
        [
          "declare const vel: number[];",
          "declare const n: number;",
          "declare const friction: number;",
          "for (const i of $range(0, n - 1)) {",
          "  vel[i] = vel[i] * friction;",
          "  const v = vel[i];",
          "  if (v < 50) { vel[i] = v; } else if (v < 100) { vel[i] = v * 2; } else { break; }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("local ____vel = vel[i]");
    });

    it("skips written arrays when nested loop has return", () => {
      const lua = compile(
        [
          "declare const vel: number[];",
          "declare const n: number;",
          "declare const m: number;",
          "declare const friction: number;",
          "declare const limit: number;",
          "function process(vel: number[], n: number, m: number): void {",
          "  for (const i of $range(0, n - 1)) {",
          "    vel[i] = vel[i] * friction;",
          "    const v = vel[i];",
          "    for (const j of $range(0, m - 1)) {",
          "      if (v > limit) return;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // return inside nested loop exits the entire function, skipping the write-back
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
        FUNC_SCOPE,
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
        FUNC_SCOPE,
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
        { pluginOptions: { rules: { localizer: { scope: "all" as const, include: ["config"] } } } },
      );
      // Static chains hoisted at module level
      expect(lua).toContain("local ____config_physics_friction = config.physics.friction");
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
      // Array element localized in loop
      expect(lua).toContain("local ____velY = velY[i]");
      expect(lua).toContain("velY[i] = ____velY");
    });
  });

  describe("lualib interaction", () => {
    it("does not hoist class prototype chains when class is locally defined", () => {
      const lua = compile(
        [
          "class Animal {",
          "  name: string;",
          "  constructor(name: string) { this.name = name; }",
          "  speak(): string { return this.name; }",
          "  greet(): string { return this.name; }",
          "}",
        ].join("\n"),
        { ...MODULE_SCOPE, luaLibImport: tstl.LuaLibImportKind.Inline },
      );
      // Animal is locally assigned (Animal = __TS__Class()), so Animal.prototype
      // chains must NOT be hoisted — hoisting above the assignment would read nil.
      expect(lua).not.toContain("local ____Animal_prototype");
      expect(lua).toContain("Animal.prototype");
    });

    it("does not hoist chains on inherited class with lualib", () => {
      const lua = compile(
        [
          "class Animal {",
          "  name: string;",
          "  constructor(name: string) { this.name = name; }",
          "  speak(): string { return this.name; }",
          "}",
          "class Dog extends Animal {",
          "  breed: string;",
          "  constructor(name: string, breed: string) { super(name); this.breed = breed; }",
          "  speak(): string { return this.name + ' barks'; }",
          "  greet(): string { return this.name + ' wags'; }",
          "}",
          "const d = new Dog('Rex', 'Lab');",
        ].join("\n"),
        { ...MODULE_SCOPE, luaLibImport: tstl.LuaLibImportKind.Inline },
      );
      // Both classes are locally assigned — no hoisting of their chains
      expect(lua).not.toContain("local ____Animal_prototype");
      expect(lua).not.toContain("local ____Dog_prototype");
    });
  });

  describe("nested statement processing", () => {
    it("hoists chain inside function nested in while loop", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "declare let running: boolean;",
          "while (running) {",
          "  function step() {",
          "    const a = config.physics.gravity;",
          "    const b = config.physics.gravity;",
          "    return a + b;",
          "  }",
          "  running = false;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["config"] } },
          },
        },
      );
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
    });

    it("hoists chain inside function nested in if-else", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "declare const x: number;",
          "if (x > 0) {",
          "  const pos = function() { return config.physics.gravity + config.physics.gravity; };",
          "} else {",
          "  const neg = function() { return config.physics.gravity + config.physics.gravity; };",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["config"] } },
          },
        },
      );
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
    });

    it("hoists chain inside function nested in elseif chain", () => {
      const lua = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "declare const x: number;",
          "if (x > 0) {",
          "  const pos = function() { return config.physics.gravity + config.physics.gravity; };",
          "} else if (x < 0) {",
          "  const neg = function() { return config.physics.gravity + config.physics.gravity; };",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["config"] } },
          },
        },
      );
      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
    });
  });

  describe("root filtering", () => {
    it("default config only hoists stdlib roots", () => {
      // math is stdlib — should be hoisted
      const lua = compile(
        ["declare const x: number;", "const a = Math.ceil(x); const b = Math.ceil(x);"].join("\n"),
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("default config does NOT hoist non-stdlib roots", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "const a = config.graphics.width;",
          "const b = config.graphics.width;",
        ].join("\n"),
        MODULE_SCOPE,
      );
      // config is not stdlib — should NOT be hoisted with default config
      expect(lua).not.toContain("local ____config_graphics_width");
      expect(lua).toContain("config.graphics.width");
    });

    it("include adds non-stdlib root to allowed set", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "const a = config.graphics.width;",
          "const b = config.graphics.width;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
      );
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
    });

    it("exclude removes stdlib root from allowed set", () => {
      const lua = compile(
        ["declare const x: number;", "const a = Math.ceil(x); const b = Math.ceil(x);"].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "module" as const, exclude: ["math"] } } },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // math is excluded — should NOT be hoisted
      expect(lua).not.toContain("local ____math_ceil");
      expect(lua).toContain("math.ceil");
    });

    it("include: ['*'] hoists all roots except blocklist", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "const a = config.graphics.width;",
          "const b = config.graphics.width;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" as const, include: ["*"] } } } },
      );
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
    });

    it("include: ['*'] with exclude blocks specific roots", () => {
      const lua = compile(
        ["declare const x: number;", "const a = Math.ceil(x); const b = Math.ceil(x);"].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["*"], exclude: ["math"] } },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      expect(lua).not.toContain("local ____math_ceil");
      expect(lua).toContain("math.ceil");
    });

    it("blocklisted root is not hoisted by default", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag;",
          "const b = assert.are_not.flag;",
        ].join("\n"),
        MODULE_SCOPE,
      );
      expect(lua).not.toContain("local ____assert_are_not_flag");
    });

    it("explicit include overrides blocklist", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag;",
          "const b = assert.are_not.flag;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["assert"] } },
          },
        },
      );
      expect(lua).toContain("local ____assert_are_not_flag = assert.are_not.flag");
    });

    it("wildcard does NOT override blocklist", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag;",
          "const b = assert.are_not.flag;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" as const, include: ["*"] } } } },
      );
      // wildcard alone does not override blocklist
      expect(lua).not.toContain("local ____assert_are_not_flag");
    });

    it("wildcard with explicit include overrides blocklist for that root", () => {
      const lua = compile(
        [
          "declare const assert: { are_not: { flag: boolean } };",
          "const a = assert.are_not.flag;",
          "const b = assert.are_not.flag;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["*", "assert"] } },
          },
        },
      );
      expect(lua).toContain("local ____assert_are_not_flag = assert.are_not.flag");
    });

    it("wildcard with non-stdlib exclude: excluded root not hoisted, stdlib still hoisted", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "declare const x: number;",
          "const a = config.graphics.width; const b = config.graphics.width;",
          "const c = Math.ceil(x); const d = Math.ceil(x);",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: { scope: "module" as const, include: ["*"], exclude: ["config"] },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // config is excluded — should NOT be hoisted
      expect(lua).not.toContain("local ____config_graphics_width");
      expect(lua).toContain("config.graphics.width");
      // math is stdlib and not excluded — should still be hoisted
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("multiple non-stdlib includes: both roots hoisted alongside stdlib", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "declare const go: { msg: { post: (id: string) => void } };",
          "const a = config.graphics.width; const b = config.graphics.width;",
          "const c = go.msg.post; const d = go.msg.post;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config", "go"] } },
          },
        },
      );
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
      expect(lua).toContain("local ____go_msg_post = go.msg.post");
    });

    it("redundant include of stdlib root is a no-op: math still hoisted", () => {
      const lua = compile(
        ["declare const x: number;", "const a = Math.ceil(x); const b = Math.ceil(x);"].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["math"] } },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // math is already in stdlib — including it again should be harmless
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("exclude of non-allowed root is a no-op: root still not hoisted", () => {
      const lua = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "const a = config.graphics.width; const b = config.graphics.width;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, exclude: ["config"] } },
          },
        },
      );
      // config was already not in allowed set — excluding it changes nothing
      expect(lua).not.toContain("local ____config_graphics_width");
      expect(lua).toContain("config.graphics.width");
    });

    it("resolution formula: (STDLIB union include) minus exclude minus (BLOCKLIST minus include)", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "declare const go: { msg: { post: (id: string) => void } };",
          "declare const assert: { are_not: { flag: boolean } };",
          // Each chain used 2+ times to meet threshold
          "const a = Math.ceil(x); const b = Math.ceil(x);",
          "const c = go.msg.post; const d = go.msg.post;",
          "const e = assert.are_not.flag; const f = assert.are_not.flag;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: {
              localizer: {
                scope: "module" as const,
                include: ["go"],
                exclude: ["math"],
              },
            },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // math: in STDLIB but excluded → NOT hoisted
      expect(lua).not.toContain("local ____math_ceil");
      expect(lua).toContain("math.ceil");
      // go: in include, not excluded, not blocklisted → IS hoisted
      expect(lua).toContain("local ____go_msg_post = go.msg.post");
      // assert: in BLOCKLIST, NOT in include → NOT hoisted
      expect(lua).not.toContain("local ____assert_are_not_flag");
      expect(lua).toContain("assert.are_not.flag");
    });
  });

  describe("root filtering interactions", () => {
    it("root filter applied in function scope mode", () => {
      // Without include: non-stdlib config NOT hoisted
      const luaDefault = compile(
        [
          "function process() {",
          "  const a = config.graphics.width;",
          "  const b = config.graphics.width;",
          "  return a + b;",
          "}",
          "declare const config: { graphics: { width: number } };",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(luaDefault).not.toContain("local ____config_graphics_width");

      // With include: config IS hoisted in function scope
      const luaInclude = compile(
        [
          "declare const config: { graphics: { width: number } };",
          "function process() {",
          "  const a = config.graphics.width;",
          "  const b = config.graphics.width;",
          "  return a + b;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["config"] } },
          },
        },
      );
      expect(luaInclude).toContain("local ____config_graphics_width = config.graphics.width");
    });

    it("root filter applied in all scope mode", () => {
      const lua = compile(
        [
          "declare const x: number;",
          "declare const config: { graphics: { width: number } };",
          "const a = Math.ceil(x); const b = Math.ceil(x);",
          "function process() {",
          "  const c = config.graphics.width;",
          "  const d = config.graphics.width;",
          "  return c + d;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "all" as const, include: ["config"] } },
          },
          luaTarget: tstl.LuaTarget.LuaJIT,
        },
      );
      // math.ceil hoisted at module level (stdlib)
      expect(lua).toContain("local ____math_ceil = math.ceil");
      // config.graphics.width hoisted inside function (non-stdlib, included)
      expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
    });

    it("root filter does not affect array element localization", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "for (const i of $range(0, n - 1)) {",
          "  const a = arr[i] + arr[i];",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // arr is NOT in stdlib or include, but array element localization is independent
      expect(lua).toContain("local ____arr = arr[i]");
      expect(lua).toContain("____arr + ____arr");
    });

    it("root filter and array element localization coexist", () => {
      // With include: config hoisted AND velY[i] localized
      const luaWithInclude = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "declare const velY: number[];",
          "declare const n: number;",
          "declare const dt: number;",
          "for (const i of $range(0, n - 1)) {",
          "  velY[i] = velY[i] + config.physics.gravity * dt;",
          "  velY[i] = velY[i] * config.physics.gravity;",
          "}",
          "const g = config.physics.gravity + config.physics.gravity;",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "all" as const, include: ["config"] } },
          },
        },
      );
      // config chain hoisted at module level
      expect(luaWithInclude).toContain("local ____config_physics_gravity = config.physics.gravity");
      // velY[i] localized in loop body
      expect(luaWithInclude).toContain("local ____velY = velY[i]");

      // Without include: config NOT hoisted but velY[i] still localized
      const luaDefault = compile(
        [
          "declare const config: { physics: { gravity: number } };",
          "declare const velY: number[];",
          "declare const n: number;",
          "declare const dt: number;",
          "for (const i of $range(0, n - 1)) {",
          "  velY[i] = velY[i] + config.physics.gravity * dt;",
          "  velY[i] = velY[i] * config.physics.gravity;",
          "}",
          "const g = config.physics.gravity + config.physics.gravity;",
        ].join("\n"),
        ALL_SCOPE,
      );
      // config NOT hoisted (not in allowed set)
      expect(luaDefault).not.toContain("local ____config_physics_gravity");
      // velY[i] still localized (array element localization is independent)
      expect(luaDefault).toContain("local ____velY = velY[i]");
    });
  });

  describe("interaction with other rules", () => {
    it("math-intrinsics transforms Math.floor to inline on PUC — nothing for localizer to hoist", () => {
      const lua = compile(
        "declare const x: number; const a = Math.floor(x); const b = Math.floor(x);",
        MODULE_SCOPE,
      );
      // PUC target: math-intrinsics replaces Math.floor with x - x % 1
      expect(lua).not.toContain("math.floor");
      expect(lua).not.toContain("local ____math_floor = math.floor");
      expect(lua).toContain("x % 1");
    });

    it("LuaJIT target: math-intrinsics skips, localizer hoists math.floor", () => {
      const lua = compile(
        "declare const x: number; const a = Math.floor(x); const b = Math.floor(x);",
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
      // LuaJIT: math-intrinsics doesn't transform, localizer hoists
      expect(lua).toContain("local ____math_floor = math.floor");
      expect(lua).toContain("____math_floor(x)");
    });
  });
});
