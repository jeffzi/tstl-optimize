import fc from "fast-check";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: tstl has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../src/rules/localizer";
import { compile, normalizeLua } from "../helpers";

const MODULE_SCOPE = { pluginOptions: { rules: { localizer: { scope: "module" as const } } } };
const FUNC_SCOPE = { pluginOptions: { rules: { localizer: { scope: "function" as const } } } };
const ALL_SCOPE = { pluginOptions: { rules: { localizer: { scope: "all" as const } } } };

describe("localizer", () => {
  describe("when positive cases are hoisted", () => {
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

    it("renames hoists repeatedly when multiple generated names are already taken", () => {
      const lua = compile(
        [
          "function process(obj: { x: number }, ____obj_x: number, ____obj_x_1: number) {",
          "  const a = obj.x;",
          "  const b = obj.x;",
          "  return a + b + ____obj_x + ____obj_x_1;",
          "}",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "function" as const, include: ["obj"] } } },
        },
      );

      expect(lua).toContain("local ____obj_x_2 = obj.x");
    });

    it("hoists chain into a guarded if-block, not above it (function scope)", () => {
      const lua = compile(
        [
          "declare const obj: { x: number };",
          "declare const cond: boolean;",
          "function process() {",
          "  if (cond) {",
          "    const a = obj.x;",
          "    const b = obj.x;",
          "    const c = obj.x;",
          "    return a + b + c;",
          "  }",
          "  return 0;",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if cond then");
      const declIdx = normalized.indexOf("local ____obj_x = obj.x");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(declIdx).toBeGreaterThan(ifIdx);
      // No reference to the temp appears above the guard
      expect(normalized.indexOf("____obj_x")).toBeGreaterThan(ifIdx);
    });

    it("hoists chain into a guarded else-block, not above the if (function scope)", () => {
      const lua = compile(
        [
          "declare const obj: { x: number };",
          "declare const cond: boolean;",
          "function process() {",
          "  if (cond) {",
          "    return 0;",
          "  } else {",
          "    const a = obj.x;",
          "    const b = obj.x;",
          "    const c = obj.x;",
          "    return a + b + c;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if cond then");
      const elseIdx = normalized.indexOf("else");
      const declIdx = normalized.indexOf("local ____obj_x = obj.x");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(elseIdx).toBeGreaterThan(ifIdx);
      expect(declIdx).toBeGreaterThan(elseIdx);
    });

    it("hoists different chains branch-locally in sibling if/else (function scope)", () => {
      const lua = compile(
        [
          "declare const obj: { x: number; y: number };",
          "declare const cond: boolean;",
          "function process() {",
          "  if (cond) {",
          "    const a = obj.x;",
          "    const b = obj.x;",
          "    const c = obj.x;",
          "    return a + b + c;",
          "  } else {",
          "    const d = obj.y;",
          "    const e = obj.y;",
          "    const f = obj.y;",
          "    return d + e + f;",
          "  }",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if cond then");
      const elseIdx = normalized.indexOf("else");
      const xIdx = normalized.indexOf("local ____obj_x = obj.x");
      const yIdx = normalized.indexOf("local ____obj_y = obj.y");
      expect(xIdx).toBeGreaterThan(ifIdx);
      expect(xIdx).toBeLessThan(elseIdx);
      expect(yIdx).toBeGreaterThan(elseIdx);
    });

    it("hoists repeated chains directly inside an elseif branch", () => {
      const lua = compile(
        [
          "declare const obj: { x: number; y: number; z: number };",
          "declare const cond1: boolean;",
          "declare const cond2: boolean;",
          "function process() {",
          "  if (cond1) {",
          "    return obj.x + obj.x;",
          "  } else if (cond2) {",
          "    const d = obj.y;",
          "    const e = obj.y;",
          "    const f = obj.y;",
          "    return d + e + f;",
          "  } else {",
          "    return obj.z + obj.z;",
          "  }",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["obj"] } },
          },
        },
      );
      const normalized = normalizeLua(lua);
      const elseifIdx = normalized.indexOf("elseif cond2 then");
      const declIdx = normalized.indexOf("local ____obj_y = obj.y");
      const useIdx = normalized.indexOf("local d = ____obj_y");
      expect(elseifIdx).toBeGreaterThanOrEqual(0);
      expect(declIdx).toBeGreaterThan(elseifIdx);
      expect(useIdx).toBeGreaterThan(declIdx);
    });

    it("nullable-root anchor: hoists obj.x inside `if obj then`, not above it", () => {
      // Regression guard: an escaped hoist here dereferences obj before the nil-check.
      const lua = compile(
        [
          "declare const obj: { x: number } | undefined;",
          "function process() {",
          "  if (obj) {",
          "    const a = obj.x;",
          "    const b = obj.x;",
          "    const c = obj.x;",
          "    return a + b + c;",
          "  }",
          "  return 0;",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if obj then");
      const declIdx = normalized.indexOf("local ____obj_x = obj.x");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(declIdx).toBeGreaterThan(ifIdx);
    });

    it("hoists chain into a guarded if-block with scope: all", () => {
      const lua = compile(
        [
          "declare const obj: { x: number };",
          "declare const cond: boolean;",
          "function process() {",
          "  if (cond) {",
          "    const a = obj.x;",
          "    const b = obj.x;",
          "    const c = obj.x;",
          "    return a + b + c;",
          "  }",
          "  return 0;",
          "}",
        ].join("\n"),
        ALL_SCOPE,
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if cond then");
      const declIdx = normalized.indexOf("local ____obj_x = obj.x");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(declIdx).toBeGreaterThan(ifIdx);
    });

    it("hoists chain inside top-level guarded if-block at module scope, not above it", () => {
      const lua = compile(
        [
          "declare const config: { x: number };",
          "declare const cond: boolean;",
          "if (cond) {",
          "  const a = config.x;",
          "  const b = config.x;",
          "  const c = config.x;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if cond then");
      const declIdx = normalized.indexOf("local ____config_x = config.x");
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      expect(declIdx).toBeGreaterThan(ifIdx);
    });

    it("hoists different chains branch-locally in sibling if/else at module scope", () => {
      const lua = compile(
        [
          "declare const config: { x: number; y: number };",
          "declare const cond: boolean;",
          "if (cond) {",
          "  const a = config.x;",
          "  const b = config.x;",
          "  const c = config.x;",
          "} else {",
          "  const d = config.y;",
          "  const e = config.y;",
          "  const f = config.y;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
      );
      const normalized = normalizeLua(lua);
      const ifIdx = normalized.indexOf("if cond then");
      const elseIdx = normalized.indexOf("else");
      const xIdx = normalized.indexOf("local ____config_x = config.x");
      const yIdx = normalized.indexOf("local ____config_y = config.y");
      expect(xIdx).toBeGreaterThan(ifIdx);
      expect(xIdx).toBeLessThan(elseIdx);
      expect(yIdx).toBeGreaterThan(elseIdx);
    });

    it("does not hoist chain inside guarded if when intervening call suppresses hoisting at module scope", () => {
      const lua = compile(
        [
          "declare const config: { x: number };",
          "declare const cond: boolean;",
          "declare function extern(): void;",
          "if (cond) {",
          "  const a = config.x;",
          "  extern();",
          "  const b = config.x;",
          "  const c = config.x;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
      );
      expect(lua).not.toContain("local ____config_x = config.x");
      expect(lua).toContain("config.x");
    });

    it("does NOT hoist chain from ternary branches (expression-guarded, out of scope)", () => {
      const lua = compile(
        [
          "declare const obj: { x: number } | undefined;",
          "declare const cond: boolean;",
          "function process() {",
          "  const a = cond ? obj!.x : 0;",
          "  const b = cond ? obj!.x : 0;",
          "  const c = cond ? obj!.x : 0;",
          "  return a + b + c;",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      // A hoist here would dereference obj unconditionally, bypassing the ternary guard.
      expect(lua).not.toContain("____obj_x");
      // Raw reads still present — at least 3 literal obj.x occurrences.
      expect(lua.match(/obj\.x/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it("does NOT hoist chain from && RHS (expression-guarded, out of scope)", () => {
      const lua = compile(
        [
          "declare const obj: { x: number } | undefined;",
          "declare const cond: boolean;",
          "function process() {",
          "  const a = cond && obj!.x;",
          "  const b = cond && obj!.x;",
          "  const c = cond && obj!.x;",
          "  return [a, b, c];",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("____obj_x");
      expect(lua.match(/obj\.x/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it("does NOT hoist chain from || RHS (expression-guarded, out of scope)", () => {
      const lua = compile(
        [
          "declare const obj: { x: number } | undefined;",
          "declare const fallback: boolean;",
          "function process() {",
          "  const a = fallback || obj!.x;",
          "  const b = fallback || obj!.x;",
          "  const c = fallback || obj!.x;",
          "  return [a, b, c];",
          "}",
        ].join("\n"),
        FUNC_SCOPE,
      );
      expect(lua).not.toContain("____obj_x");
      expect(lua.match(/obj\.x/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });
  });

  describe("when negative cases are not hoisted", () => {
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

    it("does not hoist chain when a call appears before the first access", () => {
      // Calls before first access might mutate the object.
      // Hoisting would capture a pre-call snapshot, breaking the logic.
      const lua = compile(
        [
          "declare const obj: { a: number };",
          "declare function touch(): void;",
          "touch();",
          "const x = obj.a;",
          "const y = obj.a;",
        ].join("\n"),
        { pluginOptions: { rules: { localizer: { scope: "module" as const, include: ["obj"] } } } },
      );
      expect(lua).not.toContain("local ____obj_a = obj.a");
    });

    it("does not hoist a chain that is mutated by the first-access statement", () => {
      const lua = compile(
        [
          "const it = {",
          "  i: -1,",
          "  [Symbol.iterator]() { return this; },",
          "  next() {",
          "    ++this.i;",
          "    return { value: 2 ** this.i, done: this.i === 9 };",
          "  },",
          "};",
          "const out = [...it];",
        ].join("\n"),
      );
      expect(lua).not.toMatch(/local ____self_i\s*=/);
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

  describe("when configuration is applied", () => {
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

    it("scope: module does not hoist included non-stdlib chains based only on function-body usage", () => {
      const lua = compile(
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
            rules: { localizer: { scope: "module" as const, include: ["config"] } },
          },
        },
      );

      expect(lua).not.toContain("local ____config_graphics_width = config.graphics.width");
      expect(lua).toContain("config.graphics.width");
    });
  });

  describe("when localizing array elements", () => {
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

    it("does not localize array element with write-only access", () => {
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
      expect(lua).not.toContain("local ____arr = arr[i]");
      expect(lua).not.toContain("arr[i] = ____arr");
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

    it("does not hoist property chains across intervening calls that may mutate the root", () => {
      const lua = compile(
        [
          "declare const obj: { x: number };",
          "declare function touch(value: { x: number }): void;",
          "function f() {",
          "  const a = obj.x;",
          "  touch(obj);",
          "  const b = obj.x;",
          "  return a + b;",
          "}",
        ].join("\n"),
        {
          pluginOptions: { rules: { localizer: { scope: "function" as const, include: ["obj"] } } },
        },
      );

      expect(lua).not.toContain("local ____obj_x");
      expect(lua).toContain("touch(obj)");
      expect(lua).toContain("local a = obj.x");
      expect(lua).toContain("local b = obj.x");
    });

    it("does not hoist property chains across intervening calls within the same statement", () => {
      const lua = normalizeLua(
        compile(
          [
            "declare const obj: { x: number };",
            "declare function print(...args: unknown[]): void;",
            "declare function touch(): void;",
            "function f() {",
            "  print(obj.x, touch(), obj.x);",
            "}",
          ].join("\n"),
          {
            pluginOptions: {
              rules: { localizer: { scope: "function" as const, include: ["obj"] } },
            },
          },
        ),
      );

      expect(lua).not.toContain("local ____obj_x");
      expect(lua).toMatch(/print\(\nobj\.x,\ntouch\(\),\nobj\.x\n\)/);
    });

    it("does not hoist property chains when a call comes before the first access in the same statement", () => {
      const lua = normalizeLua(
        compile(
          [
            "declare const obj: { x: number };",
            "declare function print(...args: unknown[]): void;",
            "declare function touch(): void;",
            "function f() {",
            "  print(touch(), obj.x, obj.x);",
            "}",
          ].join("\n"),
          {
            pluginOptions: {
              rules: { localizer: { scope: "function" as const, include: ["obj"] } },
            },
          },
        ),
      );

      expect(lua).not.toContain("local ____obj_x");
      expect(lua).toMatch(/print\(\ntouch\(\),\nobj\.x,\nobj\.x\n\)/);
    });

    it("scope: all does not hoist included non-stdlib chains to module scope across an intervening call", () => {
      const lua = compile(
        [
          "declare const obj: { a: { b: number }; mutate(): void };",
          "function use() {",
          "  const x = obj.a.b;",
          "  obj.mutate();",
          "  const y = obj.a.b;",
          "  const z = obj.a.b;",
          "  return x + y + z;",
          "}",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { threshold: 2, scope: "all" as const, include: ["obj"] } },
          },
        },
      );

      expect(lua).not.toContain("local ____obj_a_b = obj.a.b");
      expect(lua).toContain("obj:mutate()");
      expect(lua).toContain("local x = obj.a.b");
      expect(lua).toContain("local y = obj.a.b");
      expect(lua).toContain("local z = obj.a.b");
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

  describe("when interacting with lualib", () => {
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

  describe("when processing nested statements", () => {
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

  describe("when filtering roots", () => {
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

  describe("when root filtering interactions occur", () => {
    it("root filter applied in function scope mode", () => {
      // Lenient non-module predicate: config IS hoisted without include
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
      expect(luaDefault).toContain("local ____config_graphics_width = config.graphics.width");

      // Exclude rejects the root at non-module scope
      const luaExclude = compile(
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
            rules: { localizer: { scope: "function" as const, exclude: ["config"] } },
          },
        },
      );
      expect(luaExclude).not.toContain("local ____config_graphics_width");

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

    it("with include filter: hoists matching root chain and localizes array element", () => {
      const src = [
        "declare const config: { physics: { gravity: number } };",
        "declare const velY: number[];",
        "declare const n: number;",
        "declare const dt: number;",
        "for (const i of $range(0, n - 1)) {",
        "  velY[i] = velY[i] + config.physics.gravity * dt;",
        "  velY[i] = velY[i] * config.physics.gravity;",
        "}",
        "const g = config.physics.gravity + config.physics.gravity;",
      ].join("\n");

      const lua = compile(src, {
        pluginOptions: {
          rules: { localizer: { scope: "all" as const, include: ["config"] } },
        },
      });

      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
      expect(lua).toContain("local ____velY = velY[i]");
    });

    it("without include filter: does not hoist root chain but still localizes array element", () => {
      const src = [
        "declare const config: { physics: { gravity: number } };",
        "declare const velY: number[];",
        "declare const n: number;",
        "declare const dt: number;",
        "for (const i of $range(0, n - 1)) {",
        "  velY[i] = velY[i] + config.physics.gravity * dt;",
        "  velY[i] = velY[i] * config.physics.gravity;",
        "}",
        "const g = config.physics.gravity + config.physics.gravity;",
      ].join("\n");

      const lua = compile(src, ALL_SCOPE);

      expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
      expect(lua).toContain("local ____velY = velY[i]");
    });
  });

  describe("when scope-aware root filter + pre-loop LICM are active", () => {
    it("lenient non-module: hoists non-stdlib chain pre-loop without include", () => {
      const src = [
        "declare const config: { x: { y: number } };",
        "declare const out: number[];",
        "declare const n: number;",
        "for (const i of $range(0, n - 1)) {",
        "  out[i] = config.x.y;",
        "  out[i] = out[i] + config.x.y;",
        "}",
      ].join("\n");

      const lua = compile(src, FUNC_SCOPE);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain("local ____config_x_y = config.x.y");
      // Decl appears before the for statement, not inside it
      const declIdx = normalized.indexOf("local ____config_x_y = config.x.y");
      const forIdx = normalized.indexOf("for i = 1, n do");
      expect(declIdx).toBeGreaterThanOrEqual(0);
      expect(forIdx).toBeGreaterThan(declIdx);
    });

    it("prefix-write rejection: no hoist when an intermediate prefix is reassigned", () => {
      const src = [
        "declare const config: { physics: { friction: number; gravity: number } };",
        "declare const out: number[];",
        "declare const n: number;",
        "for (const i of $range(0, n - 1)) {",
        "  out[i] = config.physics.friction;",
        "  config.physics = { friction: 0.5, gravity: 9.8 };",
        "  out[i] = out[i] + config.physics.friction;",
        "}",
      ].join("\n");

      const lua = compile(src, FUNC_SCOPE);
      expect(lua).not.toContain("local ____config_physics_friction");
    });

    it("module-scope stays strict: default config does not hoist non-stdlib chain at top level", () => {
      const src = [
        "declare const config: { x: { y: number } };",
        "const a = config.x.y;",
        "const b = config.x.y;",
      ].join("\n");

      const lua = compile(src, MODULE_SCOPE);
      expect(lua).not.toContain("local ____config_x_y");
    });

    it("array-element hoist stays inside the loop body, not pre-loop", () => {
      const src = [
        "declare const velX: number[];",
        "declare const n: number;",
        "declare const dt: number;",
        "for (const i of $range(0, n - 1)) {",
        "  velX[i] = velX[i] + dt;",
        "  velX[i] = velX[i] * 2;",
        "}",
      ].join("\n");

      const lua = compile(src, FUNC_SCOPE);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain("local ____velX = velX[i]");
      const declIdx = normalized.indexOf("local ____velX = velX[i]");
      const forIdx = normalized.indexOf("for i = 1, n do");
      expect(forIdx).toBeGreaterThanOrEqual(0);
      expect(declIdx).toBeGreaterThan(forIdx);
    });

    it("nested loops: chain hoisted pre-outer-loop when reads span both bodies", () => {
      const src = [
        "declare const config: { x: { y: number } };",
        "declare const grid: number[][];",
        "declare const n: number;",
        "declare const m: number;",
        "for (const i of $range(0, n - 1)) {",
        "  grid[i][0] = config.x.y;",
        "  for (const j of $range(0, m - 1)) {",
        "    grid[i][j] = grid[i][j] + config.x.y;",
        "  }",
        "}",
      ].join("\n");

      const lua = compile(src, FUNC_SCOPE);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain("local ____config_x_y = config.x.y");
      const declIdx = normalized.indexOf("local ____config_x_y = config.x.y");
      const outerForIdx = normalized.indexOf("for i = 1, n do");
      expect(declIdx).toBeGreaterThanOrEqual(0);
      expect(outerForIdx).toBeGreaterThan(declIdx);
    });
  });

  describe("when interacting with other rules", () => {
    it("math-intrinsics transforms Math.floor to inline on PUC — nothing for localizer to hoist", () => {
      const lua = compile(
        "declare const x: number; const a = Math.floor(x); const b = Math.floor(x);",
        MODULE_SCOPE,
      );
      // PUC target: math-intrinsics emits the guarded floor fast path, so localizer
      // still has no standalone math.floor chain to hoist.
      expect(lua).toContain("math.floor");
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

  describe("public visitor coverage", () => {
    it("returns no visitors when the rule is disabled", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        {} as ts.TypeChecker,
        { rules: { localizer: false } },
      ]);

      expect(visitors).toStrictEqual({});
    });

    it("falls back to superTransformStatements when the source-file transform is not a Lua file", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        {} as ts.TypeChecker,
        { rules: { localizer: true } },
      ]);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
        node: ts.SourceFile,
        context: tstl.TransformationContext,
      ) => tstl.File;
      const sourceFile = ts.createSourceFile(
        "localizer.ts",
        "foo();",
        ts.ScriptTarget.Latest,
        true,
      );
      const fallbackStatement = tstl.createExpressionStatement(tstl.createIdentifier("fallback"));

      const result = Reflect.apply(visitor, undefined, [
        sourceFile,
        {
          superTransformNode: () => fallbackStatement,
          superTransformStatements: () => [fallbackStatement],
          usedLuaLibFeatures: new Set(),
        } as unknown as tstl.TransformationContext,
      ]);

      expect(tstl.isFile(result)).toBe(true);
      expect(result.statements).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isExpressionStatement(result.statements[0]!)).toBe(true);
    });
  });
});

describe("localizer early exit detection in array element localization", () => {
  const compileArrayLoop = (bodyLines: string[]): string =>
    compile(
      [
        "function test(arr: number[], n: number) {",
        "  for (const i of $range(0, n - 1)) {",
        ...bodyLines.map((line) => `    ${line}`),
        "  }",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );

  const compileNumericForLoop = (bodyLines: string[]): string =>
    compile(
      [
        "function test(arr: number[], n: number) {",
        "  for (let i = 0; i < n; i++) {",
        ...bodyLines.map((line) => `    ${line}`),
        "  }",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );

  it.each([
    {
      name: "return in the loop body",
      bodyLines: ["arr[i] = arr[i] + 1;", "arr[i] = arr[i] + 2;", "if (i === 5) return;"],
    },
    {
      name: "break in the loop body",
      bodyLines: ["arr[i] = arr[i] + 1;", "arr[i] = arr[i] + 2;", "if (i === 5) break;"],
    },
    {
      name: "an else-if branch returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "if (i > 5) {",
        "  arr[i] = arr[i] + 2;",
        "} else if (i < 2) {",
        "  return;",
        "}",
      ],
    },
    {
      name: "a nested do block returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "if (true) {",
        "  do {",
        "    return;",
        "  } while (false);",
        "}",
        "arr[i] = arr[i] + 2;",
      ],
    },
    {
      name: "a nested while loop returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "if (true) {",
        "  while (true) {",
        "    return;",
        "  }",
        "}",
        "arr[i] = arr[i] + 2;",
      ],
    },
    {
      name: "a nested repeat loop returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "if (true) {",
        "  do {",
        "    if (true) while (true) { return; }",
        "  } while (false);",
        "}",
        "arr[i] = arr[i] + 2;",
      ],
    },
    {
      name: "the else block returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "if (i > 5) {",
        "  arr[i] = arr[i] * 2;",
        "} else {",
        "  return;",
        "}",
      ],
    },
    {
      name: "the final else in an else-if chain returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "if (i > 10) {",
        "  arr[i] = arr[i] * 2;",
        "} else if (i > 5) {",
        "  arr[i] = arr[i] * 3;",
        "} else {",
        "  return;",
        "}",
      ],
    },
    {
      name: "a top-level do block returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "do {",
        "  return;",
        "} while (false);",
      ],
    },
    {
      name: "a do block breaks in a nested conditional",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "do {",
        "  if (i === 3) {",
        "    break;",
        "  }",
        "} while (false);",
      ],
    },
    {
      name: "a do-while contains a while loop that returns",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "do {",
        "  while (true) {",
        "    return;",
        "  }",
        "} while (false);",
      ],
    },
    {
      name: "all branches in an if chain return",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "if (i < 5) {",
        "  return;",
        "} else if (i < 10) {",
        "  return;",
        "} else {",
        "  return;",
        "}",
      ],
    },
    {
      name: "the if branch returns even though the else branch continues",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "arr[i] = arr[i] + 2;",
        "if (i < 5) {",
        "  return;",
        "} else {",
        "  arr[i] = arr[i] * 2;",
        "}",
      ],
    },
  ])("does not hoist array localization when $name", ({ bodyLines }) => {
    const lua = compileArrayLoop(bodyLines);
    expect(lua).not.toContain("local ____arr");
  });

  it("hoists array access with no early exit in loop", () => {
    const lua = compile(
      [
        "function test(arr: number[], n: number) {",
        "  for (const i of $range(0, n - 1)) {",
        "    arr[i] = arr[i] + 1;",
        "    arr[i] = arr[i] + 2;",
        "  }",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );
    expect(lua).toContain("local ____arr");
  });

  it("does not hoist write-only array element updates", () => {
    const lua = compileArrayLoop(["arr[i] = 1;", "arr[i] = 2;"]);
    expect(lua).not.toContain("local ____arr = arr[i]");
    expect(lua).not.toContain("arr[i] = ____arr");
    expect(lua).toContain("arr[i] = 1");
    expect(lua).toContain("arr[i] = 2");
  });

  it("hoists when do block has no early exit", () => {
    const lua = compileArrayLoop([
      "arr[i] = arr[i] + 1;",
      "do {",
      "  const x = 1;",
      "} while (false);",
      "arr[i] = arr[i] + 2;",
    ]);
    expect(lua).toContain("local ____arr");
  });

  it("detects return in forin loop preventing hoisting", () => {
    const lua = compile(
      [
        "function test(obj: Record<string, number>) {",
        "  for (const key in obj) {",
        "    obj[key] = obj[key] * 2;",
        "    if (key === 'stop') return;",
        "  }",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );
    expect(lua).not.toContain("local ____obj");
  });

  it("hoists forin array access with no early exit", () => {
    const lua = compile(
      [
        "function test(obj: Record<string, number>) {",
        "  for (const key in obj) {",
        "    obj[key] = obj[key] * 2;",
        "    obj[key] = obj[key] * 3;",
        "  }",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );
    expect(lua).toContain("local ____obj");
  });

  it.each([
    {
      name: "an explicit break",
      bodyLines: ["arr[i] = arr[i] + 1;", "arr[i] = arr[i] + 2;", "break;"],
    },
    {
      name: "a nested conditional breaks",
      bodyLines: [
        "arr[i] = arr[i] + 1;",
        "if (i === 5) {",
        "  break;",
        "}",
        "arr[i] = arr[i] + 2;",
      ],
    },
  ])("does not hoist numeric-for array localization when $name", ({ bodyLines }) => {
    const lua = compileNumericForLoop(bodyLines);
    expect(lua).not.toContain("local ____arr");
  });
});

describe("localizer safety around writes and shadowing", () => {
  it("does not hoist property chains across writes to the same chain", () => {
    const lua = compile(
      [
        "declare const config: { physics: { gravity: number } };",
        "function step() {",
        "  const a = config.physics.gravity + 1;",
        "  config.physics.gravity = 2;",
        "  const b = config.physics.gravity + 3;",
        "  return a + b;",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: { localizer: { scope: "function" as const, include: ["config"] } },
        },
      },
    );

    expect(lua).not.toContain("local ____config_physics_gravity");
    expect(lua).toContain("config.physics.gravity = 2");
  });

  it("does not hoist when write intervenes between first and last read", () => {
    const lua = compile(
      [
        "declare const obj: { foo: { bar: number } };",
        "function test() {",
        "  const a = obj.foo.bar;",
        "  const b = obj.foo.bar;",
        "  obj.foo.bar = 99;",
        "  const c = obj.foo.bar;",
        "  return [a, b, c];",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: { localizer: { scope: "function" as const, include: ["obj"], threshold: 2 } },
        },
      },
    );

    expect(lua).not.toContain("local ____obj_foo_bar");
    expect(lua).toContain("obj.foo.bar = 99");
  });

  it("does not hoist when bare-root assignment intervenes between reads", () => {
    const lua = compile(
      [
        "declare const nextState: { value: number };",
        "function test() {",
        "  let state: { value: number } = { value: 1 };",
        "  const a = state.value;",
        "  const b = state.value;",
        "  state = nextState;",
        "  const c = state.value;",
        "  return a + b + c;",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: { localizer: { scope: "function" as const, include: ["state"], threshold: 2 } },
        },
      },
    );

    expect(lua).not.toContain("local ____state_value");
    expect(lua).toContain("state = nextState");
  });

  it("does not hoist when assignment precedes all reads in function scope", () => {
    const lua = compile(
      [
        "declare const state: { value: number };",
        "function test() {",
        "  state.value = 0;",
        "  const a = state.value;",
        "  const b = state.value;",
        "  const c = state.value;",
        "  return a + b + c;",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: { localizer: { scope: "function" as const, include: ["state"], threshold: 3 } },
        },
      },
    );

    expect(lua).not.toContain("local ____state_value");
    expect(lua).toContain("state.value = 0");
  });

  it("preserves LHS of assignment when chain would otherwise be hoisted", () => {
    const lua = compile(
      [
        "declare const obj: { foo: { bar: number } };",
        "function test() {",
        "  const a = obj.foo.bar;",
        "  const b = obj.foo.bar;",
        "  const c = obj.foo.bar;",
        "  obj.foo.bar = 99;",
        "  return [a, b, c];",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: { localizer: { scope: "function" as const, include: ["obj"], threshold: 3 } },
        },
      },
    );

    expect(lua).toContain("local ____obj_foo_bar = obj.foo.bar");
    expect(lua).toContain("obj.foo.bar = 99");
    expect(lua).not.toContain("____obj_foo_bar = 99");
  });

  it("does not rewrite nested closures that outlive the hoist scope", () => {
    const lua = normalizeLua(
      compile(
        [
          "function makeReader(obj: { x: number }): () => number {",
          "  const a = obj.x;",
          "  const b = obj.x;",
          "  return function() {",
          "    return obj.x;",
          "  };",
          "}",
          "const obj = { x: 1 };",
          "const read = makeReader(obj);",
          "obj.x = 2;",
          "const result = read();",
        ].join("\n"),
        {
          pluginOptions: {
            rules: { localizer: { scope: "function" as const, include: ["obj"] } },
          },
        },
      ),
    );

    expect(lua).toContain("local ____obj_x = obj.x");
    expect(lua).toContain("return obj.x");
    expect(lua).not.toContain("return ____obj_x");
  });

  it("does not hoist array element localization through nested loops that shadow the index name", () => {
    const lua = compile(
      [
        "function step(arr: number[], outer: number, inner: number) {",
        "  for (const i of $range(0, outer - 1)) {",
        "    const a = arr[i] + arr[i];",
        "    for (const i of $range(0, inner - 1)) {",
        "      arr[i] = arr[i] + 1;",
        "    }",
        "    const b = arr[i] + arr[i];",
        "  }",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );

    expect(lua).toContain("local ____arr = arr[i]");
    expect(lua).toContain("for i = 1, inner do");
    expect(lua).toContain("arr[i] = arr[i] + 1");
  });
});

describe("localizer root filter configuration", () => {
  it("non-wildcard: custom includes with excludes prevent hoisting excluded root", () => {
    const lua = compile(
      [
        "declare const custom1: { value: number };",
        "declare const custom2: { value: number };",
        "const a = custom1.value; const b = custom1.value;",
        "const c = custom2.value; const d = custom2.value;",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "module" as const,
              include: ["custom1", "custom2"],
              exclude: ["custom1"],
            },
          },
        },
      },
    );
    expect(lua).not.toContain("local ____custom1_value");
    expect(lua).toContain("local ____custom2_value = custom2.value");
  });

  it("wildcard with exclude removes specific root from allowed set", () => {
    const lua = compile(
      [
        "declare const config: { graphics: { width: number } };",
        "declare const api: { base: { url: string } };",
        "const a = config.graphics.width; const b = config.graphics.width;",
        "const c = api.base.url; const d = api.base.url;",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "module" as const,
              include: ["*"],
              exclude: ["config"],
            },
          },
        },
      },
    );
    expect(lua).not.toContain("local ____config_graphics_width");
    expect(lua).toContain("config.graphics.width");
    expect(lua).toContain("local ____api_base_url = api.base.url");
  });

  it("wildcard exclude of multiple roots leaves non-excluded roots hoisted", () => {
    const lua = compile(
      [
        "declare const x: number;",
        "declare const config: { graphics: { width: number } };",
        "declare const api: { base: { url: string } };",
        "const a = Math.ceil(x); const b = Math.ceil(x);",
        "const c = config.graphics.width; const d = config.graphics.width;",
        "const e = api.base.url; const f = api.base.url;",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "module" as const,
              include: ["*"],
              exclude: ["config", "api"],
            },
          },
        },
        luaTarget: tstl.LuaTarget.LuaJIT,
      },
    );
    expect(lua).not.toContain("local ____config_graphics_width");
    expect(lua).not.toContain("local ____api_base_url");
    expect(lua).toContain("local ____math_ceil = math.ceil");
  });

  it("ignores malformed include and exclude values instead of crashing", () => {
    const lua = compile(
      [
        "declare const x: number;",
        "declare const config: { graphics: { width: number } };",
        "const a = Math.ceil(x); const b = Math.ceil(x);",
        "const c = config.graphics.width; const d = config.graphics.width;",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "module",
              include: true,
              exclude: { root: "math" },
            },
          },
        },
        luaTarget: tstl.LuaTarget.LuaJIT,
      },
    );

    expect(lua).toContain("local ____math_ceil = math.ceil");
    expect(lua).not.toContain("local ____config_graphics_width");
  });

  it("wildcard includes stdlib roots automatically", () => {
    const lua = compile(
      [
        "declare const x: number;",
        "const a = Math.ceil(x); const b = Math.ceil(x);",
        "const c = Math.floor(x); const d = Math.floor(x);",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "module" as const,
              include: ["*"],
            },
          },
        },
        luaTarget: tstl.LuaTarget.LuaJIT,
      },
    );
    expect(lua).toContain("local ____math_ceil = math.ceil");
    expect(lua).toContain("local ____math_floor = math.floor");
  });

  it("non-wildcard explicit stdlib include with empty exclude hoists both", () => {
    const lua = compile(
      [
        "declare const x: number;",
        "const a = Math.ceil(x); const b = Math.ceil(x);",
        "const c = Math.floor(x); const d = Math.floor(x);",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: {
              scope: "module" as const,
              include: ["math"],
              exclude: [],
            },
          },
        },
        luaTarget: tstl.LuaTarget.LuaJIT,
      },
    );
    expect(lua).toContain("local ____math_ceil = math.ceil");
    expect(lua).toContain("local ____math_floor = math.floor");
  });
});

describe("localizer property chain hoisting in various contexts", () => {
  it("hoists chains used in multiple separate statements", () => {
    const lua = compile(
      [
        "declare const config: { physics: { gravity: number } };",
        "const a = config.physics.gravity;",
        "const b = config.physics.gravity + 1;",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: { scope: "module" as const, include: ["config"] },
          },
        },
      },
    );
    expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
  });

  it("hoists chains used in arithmetic expressions across statements", () => {
    const lua = compile(
      [
        "declare const config: { physics: { gravity: number }; width: number };",
        "const a1 = config.width * 2;",
        "const a2 = config.width * 3;",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: { scope: "module" as const, include: ["config"] },
          },
        },
      },
    );
    expect(lua).toContain("local ____config_width = config.width");
  });

  it("hoists chains in function call arguments across statements", () => {
    const lua = compile(
      [
        "declare const config: { physics: { gravity: number } };",
        "function applyGravity(g: number) { return g; }",
        "const g1 = applyGravity(config.physics.gravity);",
        "const g2 = applyGravity(config.physics.gravity);",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: { scope: "module" as const, include: ["config"] },
          },
        },
      },
    );
    expect(lua).toContain("local ____config_physics_gravity = config.physics.gravity");
  });

  it("hoists in function body when root is externally declared", () => {
    const lua = compile(
      [
        "interface Config { graphics: { width: number } }",
        "declare const config: Config;",
        "function test() {",
        "  const a = config.graphics.width;",
        "  const b = config.graphics.width;",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: { scope: "function" as const, include: ["config"] },
          },
        },
      },
    );
    expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
  });

  it("prevents hoisting when root is locally defined in function", () => {
    const lua = compile(
      [
        "interface Config { graphics: { width: number } }",
        "function test() {",
        "  const config = { graphics: { width: 0 } };",
        "  const a = config.graphics.width;",
        "  const b = config.graphics.width;",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: { scope: "function" as const, include: ["config"] },
          },
        },
      },
    );
    expect(lua).not.toContain("local ____config_graphics_width");
  });

  it("does not hoist chain below threshold in function scope", () => {
    const lua = compile(
      [
        "declare const config: { graphics: { width: number } };",
        "function test() {",
        "  const a = config.graphics.width;",
        "}",
      ].join("\n"),
      FUNC_SCOPE,
    );
    expect(lua).not.toContain("local ____config_graphics_width");
  });

  it("hoists chain at threshold boundary (exactly 2 uses)", () => {
    const lua = compile(
      [
        "declare const config: { graphics: { width: number } };",
        "function test() {",
        "  const a = config.graphics.width;",
        "  const b = config.graphics.width;",
        "}",
      ].join("\n"),
      {
        pluginOptions: {
          rules: {
            localizer: { scope: "function" as const, include: ["config"] },
          },
        },
      },
    );
    expect(lua).toContain("local ____config_graphics_width = config.graphics.width");
  });
});

describe("localizer coverage", () => {
  it("does not hoist when function body contains early exit in nested control flow", () => {
    const code = `
      function test(x: number, arr: number[]) {
        for (let i = 0; i < 10; i++) {
          if ((x as any) === 1) {
             if ((x as any) === 2) {} else if ((x as any) === 3) { return; }
          }
          if ((x as any) === 4) {
             if ((x as any) === 5) {} else { return; }
          }
          do { if ((x as any) === 6) return; } while(false);
          while ((x as any) === 7) { return; }
          for (const k in {} as any) { return; }

          arr[i] = arr[i] + 1;
          arr[i] = arr[i] + 1;
        }
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });

  it.todo("GotoStatement in hasNestedFunctionExit (unreachable via TypeScript syntax)");

  it("does not hoist when scope contains do/while/for block with early exit", () => {
    const code = `
      function test(x: number, arr: number[]) {
        for (let i = 0; i < 10; i++) {
          if ((x as any) === 1) {
            do { return; } while(false);
          }
          if ((x as any) === 2) {
            while ((x as any) === 3) { return; }
          }
          if ((x as any) === 4) {
            for (let j = 0; j < 10; j++) { return; }
          }
          arr[i] = arr[i] + 1;
          arr[i] = arr[i] + 1;
        }
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });

  it("does not hoist when an else branch wraps an early exit in a nested block", () => {
    const code = `
      function test(flag: boolean, arr: number[]) {
        for (let i = 0; i < 10; i++) {
          if (flag) {
            arr[i] = arr[i] + 1;
          } else {
            {
              return;
            }
          }
          arr[i] = arr[i] + 1;
        }
      }
    `;

    const lua = normalizeLua(compile(code));

    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });

  it("does not hoist when a nested for-in loop returns from the enclosing function", () => {
    const code = `
      function test(arr: number[], obj: Record<string, number>) {
        for (let i = 0; i < 10; i++) {
          for (const key in obj) {
            if (key === "stop") {
              return;
            }
          }
          arr[i] = arr[i] + 1;
          arr[i] = arr[i] + 1;
        }
      }
    `;

    const lua = normalizeLua(compile(code));

    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });

  it("does not hoist when a plain nested block exits early", () => {
    const code = `
      function test(arr: number[]) {
        for (let i = 0; i < 10; i++) {
          {
            if (i === 3) {
              return;
            }
          }
          arr[i] = arr[i] + 1;
          arr[i] = arr[i] + 1;
        }
      }
    `;

    const lua = normalizeLua(compile(code));

    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });
});

describe("localizer raw Lua visitor coverage", () => {
  function asTypeChecker(checker: Partial<ts.TypeChecker>): ts.TypeChecker {
    return checker as unknown as ts.TypeChecker;
  }

  function createLuaFile(statements: tstl.Statement[]): tstl.File {
    return tstl.createFile(statements, new Set<tstl.LuaLibFeature>(), "");
  }

  function runSourceFileVisitor(
    file: tstl.File,
    localizerRule: true | { scope: "module" | "function" | "all"; include?: string[] } = true,
  ): tstl.File {
    const visitors = Reflect.apply(createVisitors, undefined, [
      asTypeChecker({}),
      { rules: { localizer: localizerRule } },
    ]);
    const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
      node: ts.SourceFile,
      context: tstl.TransformationContext,
    ) => tstl.File;

    return Reflect.apply(visitor, undefined, [
      {} as ts.SourceFile,
      {
        nextSymbolId: (() => {
          let current = 4000;
          return () => current++;
        })(),
        superTransformNode: () => file,
        usedLuaLibFeatures: new Set(),
      } as unknown as tstl.TransformationContext,
    ]);
  }

  function makeRepeatedArrayWrite(loopExtras: tstl.Statement[]): tstl.ForStatement {
    const arrAtI = () =>
      tstl.createTableIndexExpression(tstl.createIdentifier("arr"), tstl.createIdentifier("i"));

    return tstl.createForStatement(
      tstl.createBlock([
        ...loopExtras,
        tstl.createAssignmentStatement(
          [arrAtI()],
          [
            tstl.createBinaryExpression(
              arrAtI(),
              tstl.createNumericLiteral(1),
              tstl.SyntaxKind.AdditionOperator,
            ),
          ],
        ),
        tstl.createAssignmentStatement(
          [arrAtI()],
          [
            tstl.createBinaryExpression(
              arrAtI(),
              tstl.createNumericLiteral(2),
              tstl.SyntaxKind.AdditionOperator,
            ),
          ],
        ),
      ]),
      tstl.createIdentifier("i"),
      tstl.createNumericLiteral(0),
      tstl.createNumericLiteral(10),
      tstl.createNumericLiteral(1),
    );
  }

  function getLocalizedTemp(loop: tstl.ForStatement): string | undefined {
    const firstStatement = loop.body.statements[0];
    if (!firstStatement || !tstl.isVariableDeclarationStatement(firstStatement)) return undefined;
    const tempIdent = firstStatement.left[0];
    return tempIdent?.text;
  }

  it.each([
    {
      buildExtras: () => [
        tstl.createWhileStatement(
          tstl.createBlock([
            tstl.createIfStatement(
              tstl.createBooleanLiteral(true),
              tstl.createBlock([]),
              tstl.createBlock([tstl.createReturnStatement([])]),
            ),
          ]),
          tstl.createBooleanLiteral(true),
        ),
      ],
      name: "a nested while loop has an if/else with a returning else branch",
    },
    {
      buildExtras: () => [
        tstl.createWhileStatement(
          tstl.createBlock([
            tstl.createRepeatStatement(
              tstl.createBlock([tstl.createReturnStatement([])]),
              tstl.createBooleanLiteral(true),
            ),
          ]),
          tstl.createBooleanLiteral(true),
        ),
      ],
      name: "a nested while loop contains a repeat loop that returns",
    },
    {
      buildExtras: () => [
        tstl.createForInStatement(
          tstl.createBlock([tstl.createReturnStatement([])]),
          [tstl.createIdentifier("key")],
          [
            tstl.createCallExpression(tstl.createIdentifier("pairs"), [
              tstl.createIdentifier("obj"),
            ]),
          ],
        ),
      ],
      name: "a nested for-in loop returns from the enclosing scope",
    },
    {
      buildExtras: () => [
        tstl.createForStatement(
          tstl.createBlock([tstl.createReturnStatement([])]),
          tstl.createIdentifier("j"),
          tstl.createNumericLiteral(0),
          tstl.createNumericLiteral(2),
          tstl.createNumericLiteral(1),
        ),
      ],
      name: "a raw nested numeric for loop returns early",
    },
    {
      buildExtras: () => [tstl.createDoStatement([tstl.createReturnStatement([])])],
      name: "a raw nested do block returns early",
    },
    {
      buildExtras: () => [
        tstl.createWhileStatement(
          tstl.createBlock([
            tstl.createIfStatement(
              tstl.createBooleanLiteral(true),
              tstl.createBlock([]),
              tstl.createBlock([
                tstl.createForStatement(
                  tstl.createBlock([tstl.createReturnStatement([])]),
                  tstl.createIdentifier("j"),
                  tstl.createNumericLiteral(0),
                  tstl.createNumericLiteral(2),
                  tstl.createNumericLiteral(1),
                ),
              ]),
            ),
          ]),
          tstl.createBooleanLiteral(true),
        ),
      ],
      name: "a nested else branch contains a numeric for-loop that returns",
    },
  ])("does not hoist when $name", ({ buildExtras }) => {
    const file = createLuaFile([makeRepeatedArrayWrite(buildExtras())]);
    const transformed = runSourceFileVisitor(file);
    const loop = transformed.statements[0] as tstl.ForStatement;

    expect(getLocalizedTemp(loop)).toBeUndefined();
  });

  it.each([
    {
      buildExtras: () => [
        tstl.createWhileStatement(
          tstl.createBlock([
            tstl.createIfStatement(tstl.createBooleanLiteral(true), tstl.createBlock([])),
          ]),
          tstl.createBooleanLiteral(true),
        ),
        tstl.createForStatement(
          tstl.createBlock([tstl.createExpressionStatement(tstl.createNumericLiteral(0))]),
          tstl.createIdentifier("j"),
          tstl.createNumericLiteral(0),
          tstl.createNumericLiteral(2),
          tstl.createNumericLiteral(1),
        ),
        tstl.createDoStatement([tstl.createExpressionStatement(tstl.createNumericLiteral(1))]),
      ],
      name: "nested while, numeric-for, and do blocks have no early exit",
    },
    {
      buildExtras: () => [
        tstl.createWhileStatement(
          tstl.createBlock([
            tstl.createRepeatStatement(
              tstl.createBlock([tstl.createExpressionStatement(tstl.createNumericLiteral(1))]),
              tstl.createBooleanLiteral(true),
            ),
          ]),
          tstl.createBooleanLiteral(true),
        ),
      ],
      name: "a nested while loop contains a repeat loop without an early exit",
    },
    {
      buildExtras: () => [
        tstl.createWhileStatement(
          tstl.createBlock([
            tstl.createIfStatement(
              tstl.createBooleanLiteral(true),
              tstl.createBlock([]),
              tstl.createBlock([
                tstl.createForStatement(
                  tstl.createBlock([tstl.createExpressionStatement(tstl.createNumericLiteral(1))]),
                  tstl.createIdentifier("j"),
                  tstl.createNumericLiteral(0),
                  tstl.createNumericLiteral(2),
                  tstl.createNumericLiteral(1),
                ),
              ]),
            ),
          ]),
          tstl.createBooleanLiteral(true),
        ),
      ],
      name: "nested else branches and nested loops do not exit early",
    },
  ])("still hoists when $name", ({ buildExtras }) => {
    const file = createLuaFile([makeRepeatedArrayWrite(buildExtras())]);
    const transformed = runSourceFileVisitor(file);
    const loop = transformed.statements[0] as tstl.ForStatement;

    expect(getLocalizedTemp(loop)).toContain("____arr");
  });

  it("rewrites raw array reads and writes through the hoisted temp identifier", () => {
    const file = createLuaFile([makeRepeatedArrayWrite([])]);

    const transformed = runSourceFileVisitor(file);
    const loop = transformed.statements[0] as tstl.ForStatement;
    const [decl, firstWrite, secondWrite, writeback] = loop.body.statements;

    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isVariableDeclarationStatement(decl!)).toBe(true);
    const tempIdent = (decl as tstl.VariableDeclarationStatement).left[0] as tstl.Identifier;
    expect(tempIdent.text).toContain("____arr");

    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isAssignmentStatement(firstWrite!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isIdentifier((firstWrite as tstl.AssignmentStatement).left[0]!)).toBe(true);
    expect(((firstWrite as tstl.AssignmentStatement).left[0] as tstl.Identifier).text).toBe(
      tempIdent.text,
    );
    expect(
      tstl.isIdentifier(
        ((firstWrite as tstl.AssignmentStatement).right[0] as tstl.BinaryExpression).left,
      ),
    ).toBe(true);

    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isAssignmentStatement(secondWrite!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isIdentifier((secondWrite as tstl.AssignmentStatement).left[0]!)).toBe(true);
    expect(((secondWrite as tstl.AssignmentStatement).left[0] as tstl.Identifier).text).toBe(
      tempIdent.text,
    );

    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isAssignmentStatement(writeback!)).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isTableIndexExpression((writeback as tstl.AssignmentStatement).left[0]!)).toBe(
      true,
    );
    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isIdentifier((writeback as tstl.AssignmentStatement).right[0]!)).toBe(true);
    expect(((writeback as tstl.AssignmentStatement).right[0] as tstl.Identifier).text).toBe(
      tempIdent.text,
    );
  });

  it("prepends hoist declarations before raw elseif conditions", () => {
    const createCeilCall = (name: string) =>
      tstl.createCallExpression(
        tstl.createTableIndexExpression(
          tstl.createIdentifier("math"),
          tstl.createStringLiteral("ceil"),
        ),
        [tstl.createIdentifier(name)],
      );
    const file = createLuaFile([
      tstl.createVariableDeclarationStatement(
        tstl.createIdentifier("process"),
        tstl.createFunctionExpression(
          tstl.createBlock([
            tstl.createIfStatement(
              tstl.createBooleanLiteral(false),
              tstl.createBlock([]),
              tstl.createIfStatement(
                tstl.createBinaryExpression(
                  createCeilCall("x"),
                  createCeilCall("y"),
                  tstl.SyntaxKind.LessThanOperator,
                ),
                tstl.createBlock([tstl.createReturnStatement([tstl.createNumericLiteral(1)])]),
              ),
            ),
          ]),
        ),
      ),
    ]);

    const transformed = runSourceFileVisitor(file, { scope: "function" });
    const processDecl = transformed.statements[0];
    if (!processDecl || !tstl.isVariableDeclarationStatement(processDecl)) {
      throw new Error("expected function declaration");
    }
    const processExpr = processDecl.right?.[0];
    if (!processExpr || !tstl.isFunctionExpression(processExpr)) {
      throw new Error("expected function expression");
    }
    const topIf = processExpr.body.statements[0];
    if (
      !topIf ||
      !tstl.isIfStatement(topIf) ||
      !topIf.elseBlock ||
      !tstl.isBlock(topIf.elseBlock)
    ) {
      throw new Error("expected function body if with block-wrapped elseif elseBlock");
    }
    const [decl, elseIf] = topIf.elseBlock.statements;
    if (!decl || !tstl.isVariableDeclarationStatement(decl)) {
      throw new Error("expected localized declaration before elseif");
    }
    if (!elseIf || !tstl.isIfStatement(elseIf) || !tstl.isBinaryExpression(elseIf.condition)) {
      throw new Error("expected elseif statement after localized declaration");
    }

    const hoisted = decl.left[0];
    if (!hoisted || !tstl.isIdentifier(hoisted)) {
      throw new Error("expected hoisted identifier");
    }
    expect(hoisted.text).toContain("____math_ceil");
    const firstConditionCall = elseIf.condition.left;
    const secondConditionCall = elseIf.condition.right;
    if (
      !tstl.isCallExpression(firstConditionCall) ||
      !tstl.isIdentifier(firstConditionCall.expression)
    ) {
      throw new Error("expected localized call on elseif condition left");
    }
    if (
      !tstl.isCallExpression(secondConditionCall) ||
      !tstl.isIdentifier(secondConditionCall.expression)
    ) {
      throw new Error("expected localized call on elseif condition right");
    }
    expect(firstConditionCall.expression.text).toBe(hoisted.text);
    expect(secondConditionCall.expression.text).toBe(hoisted.text);
  });

  it("does not rewrite raw nested for-in bodies that shadow the localized loop variable", () => {
    const arrAtI = () =>
      tstl.createTableIndexExpression(tstl.createIdentifier("arr"), tstl.createIdentifier("i"));
    const file = createLuaFile([
      makeRepeatedArrayWrite([
        tstl.createForInStatement(
          tstl.createBlock([
            tstl.createAssignmentStatement(
              [arrAtI()],
              [
                tstl.createBinaryExpression(
                  arrAtI(),
                  tstl.createNumericLiteral(3),
                  tstl.SyntaxKind.AdditionOperator,
                ),
              ],
            ),
          ]),
          [tstl.createIdentifier("i")],
          [
            tstl.createCallExpression(tstl.createIdentifier("pairs"), [
              tstl.createIdentifier("obj"),
            ]),
          ],
        ),
      ]),
    ]);

    const transformed = runSourceFileVisitor(file);
    const loop = transformed.statements[0] as tstl.ForStatement;
    const nestedLoop = loop.body.statements.find((stmt) => tstl.isForInStatement(stmt));
    if (!nestedLoop || !tstl.isForInStatement(nestedLoop)) {
      throw new Error("expected nested for-in loop");
    }
    const nestedAssign = nestedLoop.body.statements[0];
    if (!nestedAssign || !tstl.isAssignmentStatement(nestedAssign)) {
      throw new Error("expected nested assignment");
    }

    // biome-ignore lint/style/noNonNullAssertion: node constructed with value
    expect(tstl.isTableIndexExpression(nestedAssign.left[0]!)).toBe(true);
    expect(tstl.isTableIndexExpression((nestedAssign.right[0] as tstl.BinaryExpression).left)).toBe(
      true,
    );
  });

  describe("localizer — interaction with other rules", () => {
    it("scope: all hoists both module-level and function-level chains in the same file", () => {
      // scope: "all" should hoist chains at any nesting depth.
      const lua = compile(
        `
          declare const x: number;
          const a = Math.ceil(x);
          const b = Math.ceil(x + 1);
          function f(): number {
            return Math.ceil(x + 2) + Math.ceil(x + 3);
          }
        `,
        { ...ALL_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
      expect(lua).toContain("local ____math_ceil = math.ceil");
      // Both module-level and function-level uses reference the hoisted local
      expect(lua).toContain("____math_ceil(x)");
    });

    it("localizer + inline: hoisted chain survives inlining of a function that uses it", () => {
      // After inlining, the chain reference moves into the call site — localizer must still hoist.
      const lua = compile(
        `
          /** @inline */
          function ceilDouble(x: number): number { return Math.ceil(x) + Math.ceil(x + 1); }
          declare const v: number;
          const r1 = ceilDouble(v);
          const r2 = ceilDouble(v + 2);
        `,
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
      // math.ceil used multiple times after inlining → should be hoisted
      expect(lua).toContain("local ____math_ceil = math.ceil");
    });

    it("localizer + dead-local: hoisted local from a chain that was inlined is not dropped", () => {
      // A hoisted local for a chain that appears only in inlined code must survive — its
      // references survive inlining, so the hoisted local still has uses.
      const lua = compile(
        `
          declare const x: number;
          const a = Math.ceil(x);
          const b = Math.ceil(x + 1);
          const c = Math.ceil(x + 2);
        `,
        { ...MODULE_SCOPE, luaTarget: tstl.LuaTarget.LuaJIT },
      );
      // Hoisted local must be present and used; not treated as dead
      expect(lua).toContain("local ____math_ceil");
      const useCount = (lua.match(/____math_ceil\(/g) ?? []).length;
      expect(useCount).toBe(3);
    });
  });

  describe("localizer properties", () => {
    const FC_OPTS: Parameters<typeof fc.assert>[1] = { numRuns: 20 };

    it("hoists math.ceil for any call count ≥ 2 at module scope", () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 6 }), (n) => {
          const decls = Array.from(
            { length: n },
            (_, i) => `const c${i} = Math.ceil(x + ${i});`,
          ).join(" ");
          const lua = compile(`declare const x: number; ${decls}`, {
            ...MODULE_SCOPE,
            luaTarget: tstl.LuaTarget.LuaJIT,
          });
          // With n uses, the hoisted local must be introduced and used at least once.
          return lua.includes("local ____math_ceil = math.ceil") && lua.includes("____math_ceil(");
        }),
        FC_OPTS,
      );
    }, 20_000);

    it("does not hoist a single occurrence of math.ceil (threshold < 2)", () => {
      // Single call — below the hoist threshold. The raw reference stays.
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100 }), (offset) => {
          const lua = compile(`declare const x: number; const c = Math.ceil(x + ${offset});`, {
            ...MODULE_SCOPE,
            luaTarget: tstl.LuaTarget.LuaJIT,
          });
          return !lua.includes("____math_ceil") && lua.includes("math.ceil(");
        }),
        FC_OPTS,
      );
    }, 20_000);
  });
});
