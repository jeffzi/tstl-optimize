// biome-ignore lint/performance/noNamespaceImport: tstl has no default export
import * as tstl from "typescript-to-lua";
import { describe, it } from "vitest";
import { compileWithSourceMap } from "../../helpers";
import { assertLineMapsTo, assertTracebackMapsTo, findLuaLine } from "../../sourcemap-helpers";

// ---------------------------------------------------------------------------
// Localizer: hoisted chain declarations map to first-use line
//
// Math.floor with LuaJIT target emits `math.floor(...)` (stdlib root, dot notation).
// `math` is in STDLIB_ROOTS so module-scope hoisting is allowed.
// ---------------------------------------------------------------------------

describe("localizer sourcemap: hoisted chain declaration", () => {
  // line 1: declare const x: number;
  // line 2: const a = Math.floor(x);  ← first use of math.floor — hoist decl maps here
  // line 3: const b = Math.floor(x + 1);
  // line 4: const c = Math.floor(x + 2);
  const FIRST_USE_TS_LINE = 2;
  const source = `\
declare const x: number;
const a = Math.floor(x);
const b = Math.floor(x + 1);
const c = Math.floor(x + 2);`;

  it("hoisted decl maps to first-use TS line", async () => {
    const { lua, externalMap, traceback } = compileWithSourceMap(source, {
      pluginOptions: { rules: { localizer: { threshold: 2 } } },
      luaTarget: tstl.LuaTarget.LuaJIT,
    });
    const hoistLine = findLuaLine(lua, "____math_floor");
    await assertLineMapsTo(externalMap, hoistLine, FIRST_USE_TS_LINE);
    assertTracebackMapsTo(traceback, hoistLine, FIRST_USE_TS_LINE);
  });
});

// ---------------------------------------------------------------------------
// Localizer: hoisted chain maps to first use, not to second use
// ---------------------------------------------------------------------------

describe("localizer sourcemap: hoisted chain maps to first use line, not second", () => {
  // line 1: declare const x: number;
  // line 2: const unused = 0;              ← separator so first use is not on line 1
  // line 3: const p = Math.floor(x);      ← first use — hoist decl must map here
  // line 4: const q = Math.floor(x + 1);  ← second use
  const FIRST_USE_TS_LINE = 3;
  const source = `\
declare const x: number;
const unused = 0;
const p = Math.floor(x);
const q = Math.floor(x + 1);`;

  it("hoisted decl maps to first-use TS line, not second", async () => {
    const { lua, externalMap, traceback } = compileWithSourceMap(source, {
      pluginOptions: { rules: { localizer: { threshold: 2 } } },
      luaTarget: tstl.LuaTarget.LuaJIT,
    });
    const hoistLine = findLuaLine(lua, "____math_floor");
    await assertLineMapsTo(externalMap, hoistLine, FIRST_USE_TS_LINE);
    assertTracebackMapsTo(traceback, hoistLine, FIRST_USE_TS_LINE);
  });
});

// ---------------------------------------------------------------------------
// Localizer: array element hoisting maps to first access line
// ---------------------------------------------------------------------------

describe("localizer sourcemap: array element hoisted decl", () => {
  // $range is provided globally via types: ["@typescript-to-lua/language-extensions"]
  // in the compile helper — no import needed (explicit import triggers a Lua require error).
  //
  // line 1: declare const arr: number[];
  // line 2: declare const n: number;
  // line 3: let sum = 0;
  // line 4: for (const i of $range(0, n - 1)) {
  // line 5:   sum += arr[i];   ← first access — hoisted decl maps here
  // line 6:   sum += arr[i];
  // line 7:   sum += arr[i];
  // line 8: }
  const FIRST_ACCESS_TS_LINE = 5;
  const source = `\
declare const arr: number[];
declare const n: number;
let sum = 0;
for (const i of $range(0, n - 1)) {
  sum += arr[i];
  sum += arr[i];
  sum += arr[i];
}`;

  it("array element hoisted decl maps to first access TS line", async () => {
    const { lua, externalMap, traceback } = compileWithSourceMap(source, {
      pluginOptions: { rules: { localizer: { threshold: 2 } } },
    });
    const hoistLine = findLuaLine(lua, "____arr");
    await assertLineMapsTo(externalMap, hoistLine, FIRST_ACCESS_TS_LINE);
    assertTracebackMapsTo(traceback, hoistLine, FIRST_ACCESS_TS_LINE);
  });
});

// ---------------------------------------------------------------------------
// Localizer: hoisted declarations from math-intrinsics rewrites are mapped
// ---------------------------------------------------------------------------

describe("localizer sourcemap: math-intrinsics hoisted declarations", () => {
  // line 1: declare function print(...args: unknown[]): void;
  // line 2: declare const x: number;
  // line 3: declare const y: number;
  // line 4: declare const speed: number;
  // line 5: const tileX = Math.floor(x / 32);   first math.floor use
  // line 6: const tileY = Math.floor(y / 32);
  // line 7: const bounded = Math.max(0, speed); first non-rewritten math.max use
  // line 8: const biggest = Math.max(x, y, speed);
  // line 9: print(tileX, tileY, bounded, biggest);
  const source = `\
declare function print(...args: unknown[]): void;
declare const x: number;
declare const y: number;
declare const speed: number;
const tileX = Math.floor(x / 32);
const tileY = Math.floor(y / 32);
const bounded = Math.max(0, speed);
const biggest = Math.max(x, y, speed);
print(tileX, tileY, bounded, biggest);`;
  const { lua, externalMap, traceback } = compileWithSourceMap(source);

  it.each<{ name: string; pattern: string; expectedLine: number }>([
    { name: "____math_floor", pattern: "local ____math_floor = math.floor", expectedLine: 5 },
    { name: "____math_max", pattern: "local ____math_max = math.max", expectedLine: 7 },
  ])("local $name maps to first Math.* call site (TS line $expectedLine)", async ({
    pattern,
    expectedLine,
  }) => {
    const luaLine = findLuaLine(lua, pattern);
    await assertLineMapsTo(externalMap, luaLine, expectedLine);
    assertTracebackMapsTo(traceback, luaLine, expectedLine);
  });
});
