import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileWithSourceMap } from "../../helpers";
import {
  assertEveryLineMapped,
  assertEveryTracebackLineMapsTo,
  assertLineMapsTo,
  assertMapped,
  assertTracebackMapsTo,
  findLuaLine,
  keywordSkip,
  mappingFor,
  RAW_KEYWORD_SKIP,
  rhsStartCol,
} from "../../sourcemap-helpers";

// Exported @inline functions are never erased (they're part of the public API),
// so the comment-stripping path must handle them structurally — not via text regex.
const EXPORTED_LERP = `\
/** @inline */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}`;

// TS line numbers for EXPORTED_LERP (1-indexed, no leading blank line):
// 1: /** @inline */
// 2: export function lerp(...)
// 3:   return ...
// 4: }
const LERP_DECL_TS_LINE = 2;

describe("inline: @inline comment stripping", () => {
  describe("exported @inline function", () => {
    it("maps function declaration to correct TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(EXPORTED_LERP);
      const luaLine = findLuaLine(lua, "____exports.lerp");
      await assertLineMapsTo(externalMap, luaLine, LERP_DECL_TS_LINE);
      assertTracebackMapsTo(traceback, luaLine, LERP_DECL_TS_LINE);
    });
  });

  describe("exported @inline variable-stored function", () => {
    // Arrow functions stored in variables also get @inline stripped via
    // handleVariableStatementDeclaration's fall-through path.
    const source = `\
/** @inline */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;`;

    // TS line numbers:
    // 1: /** @inline */
    // 2: export const lerp = ...
    const DECL_TS_LINE = 2;

    it("maps declaration to correct TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const luaLine = findLuaLine(lua, "____exports.lerp");
      await assertLineMapsTo(externalMap, luaLine, DECL_TS_LINE);
      assertTracebackMapsTo(traceback, luaLine, DECL_TS_LINE);
    });
  });

  describe("later declarations after stripped comments", () => {
    // line 1: declare function print(...args: unknown[]): void;
    // line 2: /** @inline */
    // line 3: function identity(x: number): number { return x; }
    // line 4: /** @inline */
    // line 5: function inc(x: number): number { return x + 1; }
    // line 6: const hp = 50;
    // line 7: const total = identity(hp) + inc(hp);
    // line 8: print(total);
    const HP_TS_LINE = 6;
    const source = `\
declare function print(...args: unknown[]): void;
/** @inline */
function identity(x: number): number { return x; }
/** @inline */
function inc(x: number): number { return x + 1; }
const hp = 50;
const total = identity(hp) + inc(hp);
print(total);`;

    it("maps a later const declaration to its original TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const luaLine = findLuaLine(lua, "hp = 50");
      await assertLineMapsTo(externalMap, luaLine, HP_TS_LINE);
      assertTracebackMapsTo(traceback, luaLine, HP_TS_LINE);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 4: call-site position propagation for inlined bodies
//
// Every node emitted as part of an inline expansion must carry a sourcemap
// mapping.  Structural nodes (do, end, result decl, temp decls) must point to
// the call expression's TS line.  Argument-substituted leaves retain the
// argument expression's position.
// ---------------------------------------------------------------------------

// TS line numbers for each fixture are documented inline.  All are 1-indexed,
// matching editor conventions and what originalPositionFor / the traceback
// table return.

describe("inline: call-site position propagation", () => {
  // -------------------------------------------------------------------------
  // Statement-body void-call: do...end block
  // -------------------------------------------------------------------------
  describe("statement-body void-call: do...end block", () => {
    // line 1: /** @inline */
    // line 2: function twoOps(a: number, b: number): void {
    // line 3:   const sum = a + b;
    // line 4:   const product = a * b;
    // line 5: }
    // line 6: twoOps(1, 2);
    const CALL_TS_LINE = 6;
    const source = `\
/** @inline */
function twoOps(a: number, b: number): void {
  const sum = a + b;
  const product = a * b;
}
twoOps(1, 2);`;

    // TSTL's printer emits `do` and `end` keywords via concatNodes (no createSourceNode),
    // so those lines never appear in the external sourcemap or the traceback table.
    // We skip them in coverage assertions and test other mapped nodes instead.
    const skipKeywords = keywordSkip(RAW_KEYWORD_SKIP);

    it("every inlined Lua line maps to the call site", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const firstArgLine = findLuaLine(lua, "____inline_arg_0");
      const endLine = findLuaLine(lua, /^\s*end\s*$/);
      await assertEveryLineMapped(
        externalMap,
        lua,
        { start: firstArgLine, end: endLine },
        { skip: skipKeywords },
      );
      assertEveryTracebackLineMapsTo(
        traceback,
        lua,
        { start: firstArgLine, end: endLine },
        CALL_TS_LINE,
        { skip: skipKeywords },
      );
    });

    it("arg temp decl maps to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const tempDeclLine = findLuaLine(lua, "____inline_arg_0");
      await assertLineMapsTo(externalMap, tempDeclLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, tempDeclLine, CALL_TS_LINE);
    });
  });

  // -------------------------------------------------------------------------
  // Statement-body var-decl inline: result decl + do...end
  // -------------------------------------------------------------------------
  describe("statement-body var-decl inline: structural nodes map to call site", () => {
    // line 1: /** @inline */
    // line 2: function compute(x: number): number {
    // line 3:   const y = x + 1;
    // line 4:   return y * 2;
    // line 5: }
    // line 6: const r = compute(10);
    const CALL_TS_LINE = 6;
    const source = `\
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}
const r = compute(10);`;

    // TSTL's printer emits `do` and `end` keywords via concatNodes (no createSourceNode),
    // so those lines never appear in the external sourcemap or the traceback table.
    const skipKeywords = keywordSkip(RAW_KEYWORD_SKIP);

    it("every inlined Lua line has an external-map mapping", async () => {
      const { lua, externalMap } = compileWithSourceMap(source);
      const resultDeclLine = findLuaLine(lua, "local r");
      const endLine = findLuaLine(lua, /^\s*end\s*$/);
      await assertEveryLineMapped(
        externalMap,
        lua,
        { start: resultDeclLine, end: endLine },
        { skip: skipKeywords },
      );
    });

    it("result decl maps to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const resultDeclLine = findLuaLine(lua, "local r");
      await assertLineMapsTo(externalMap, resultDeclLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, resultDeclLine, CALL_TS_LINE);
    });

    it("arg temp decl maps to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const tempDeclLine = findLuaLine(lua, "____inline_arg_0");
      await assertLineMapsTo(externalMap, tempDeclLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, tempDeclLine, CALL_TS_LINE);
    });

    it("body local maps to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const bodyLocalLine = findLuaLine(lua, "local y = ____inline_arg_0 + 1");
      await assertLineMapsTo(externalMap, bodyLocalLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, bodyLocalLine, CALL_TS_LINE);
    });
  });

  // -------------------------------------------------------------------------
  // Expression-body inline: entire inlined expression maps to call TS line
  // -------------------------------------------------------------------------
  describe("expression-body inline: call-site mapping", () => {
    // line 1: /** @inline */
    // line 2: function lerp(a: number, b: number, t: number): number {
    // line 3:   return a + (b - a) * t;
    // line 4: }
    // line 5: const result = lerp(0, 100, 0.5);
    const CALL_TS_LINE = 5;
    const source = `\
/** @inline */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
const result = lerp(0, 100, 0.5);`;

    it("maps result line to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const resultLine = findLuaLine(lua, "result");
      await assertLineMapsTo(externalMap, resultLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, resultLine, CALL_TS_LINE);
    });
  });

  // -------------------------------------------------------------------------
  // Argument-leaf invariant: multi-line call argument
  //
  // The call expression starts on TS line 6; the argument "argValue" is on
  // TS line 7.  Structural nodes (result decl, do) must map to TS line 6.
  // The argument expression retains TS line 7 at column granularity inside
  // the temp-decl line.
  // -------------------------------------------------------------------------
  describe("argument-leaf invariant: multi-line call", () => {
    // line 1: declare const argValue: number;
    // line 2: /** @inline */
    // line 3: function compute(x: number): number {
    // line 4:   const y = x + 1;
    // line 5:   return y * 2;
    // line 6: }
    // line 7: const r = compute(
    // line 8:   argValue
    // line 9: );
    const CALL_START_TS_LINE = 7;
    const ARG_TS_LINE = 8;
    const source = `\
declare const argValue: number;
/** @inline */
function compute(x: number): number {
  const y = x + 1;
  return y * 2;
}
const r = compute(
  argValue
);`;

    it("result decl (structural) maps to call start TS line", async () => {
      const { lua, externalMap } = compileWithSourceMap(source);
      const resultDeclLine = findLuaLine(lua, "local r");
      await assertLineMapsTo(externalMap, resultDeclLine, CALL_START_TS_LINE);
    });

    it("arg temp decl (structural) maps to call start TS line", async () => {
      const { lua, externalMap } = compileWithSourceMap(source);
      const tempDeclLine = findLuaLine(lua, "____inline_arg_0");
      await assertLineMapsTo(externalMap, tempDeclLine, CALL_START_TS_LINE);
    });

    it("argument expression RHS maps to arg TS line at column granularity", async () => {
      const { lua, externalMap } = compileWithSourceMap(source);
      const argDeclLine = findLuaLine(lua, "____inline_arg_0");
      const argDeclText = lua.split("\n")[argDeclLine - 1] ?? "";
      // "argValue" starts at the column after "local ____inline_arg_0 = "
      // Use the declared variable so constant-folding can't simplify the argument away.
      const rhsColumn = argDeclText.indexOf("argValue");
      expect(rhsColumn).toBeGreaterThan(0);
      const argMapping = await assertMapped(externalMap, argDeclLine, rhsColumn);
      expect(argMapping.line).toBe(ARG_TS_LINE);
    });
  });

  // -------------------------------------------------------------------------
  // Property-based: expression-body inline — every inlined line maps to call
  // -------------------------------------------------------------------------
  describe("property-based: expression-body inline maps to call TS line", () => {
    // Generate random arithmetic expressions involving parameter 'a'.
    // All these produce expression-body inlines (single Lua expression substituted
    // in place).  The call is always on a fixed TS line; every resulting Lua line
    // containing the inlined expression must map to that TS line AND column.
    const arbBodyExpr: fc.Arbitrary<string> = fc.letrec<{ expr: string }>((tie) => ({
      expr: fc.oneof(
        { maxDepth: 3, depthIdentifier: "expr" },
        fc.constant("a"),
        fc.integer({ min: -100, max: 100 }).map(String),
        fc.tuple(tie("expr"), tie("expr")).map(([l, r]) => `(${l} + ${r})`),
        fc.tuple(tie("expr"), tie("expr")).map(([l, r]) => `(${l} * ${r})`),
        tie("expr").map((e) => `(-(${e}))`),
      ),
    })).expr;

    it("result RHS always maps to call expression across random bodies", {
      timeout: 60_000,
    }, async () => {
      // line 1: /** @inline */
      // line 2: function f(a: number): number { return EXPR; }
      // line 3: const result = f(1);  ← call on TS line 3, `f(1)` at col 15
      const CALL_TS_LINE = 3;
      const CALL_LINE_TEXT = "const result = f(1);";
      const CALL_TS_COL = CALL_LINE_TEXT.indexOf("f(1)");
      await fc.assert(
        fc.asyncProperty(arbBodyExpr, async (bodyExpr) => {
          const source = [
            "/** @inline */",
            `function f(a: number): number { return ${bodyExpr}; }`,
            CALL_LINE_TEXT,
          ].join("\n");
          const { lua, externalMap } = compileWithSourceMap(source);
          const resultLine = findLuaLine(lua, "result");
          const luaLineText = lua.split("\n")[resultLine - 1] ?? "";
          const rhsCol = rhsStartCol(luaLineText);
          const pos = await mappingFor(externalMap, resultLine, rhsCol);
          return pos !== null && pos.line === CALL_TS_LINE && pos.column >= CALL_TS_COL;
        }),
        { numRuns: 50 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2: multi-return inline body position propagation
//
// transformInlineBodyAndReturn clears positions on luaReturnStmts but not on
// luaBody.  Body statements therefore retain their original function-body
// positions, and stampCallSitePositions (which only stamps position-less nodes)
// cannot override them.  After the fix (clearNodePositions(luaBody)), every
// body statement is attributed to the call site.
// ---------------------------------------------------------------------------

describe("inline: multi-return body position propagation", () => {
  // -------------------------------------------------------------------------
  // Return-site: `return swap(x, y)` expanded via buildReturnSiteInline
  // -------------------------------------------------------------------------
  describe("multi-return return-site: body statements map to call TS line", () => {
    // line 1: /** @inline */
    // line 2: function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
    // line 3:   const tmp = a;
    // line 4:   return $multi(b, tmp);
    // line 5: }
    // line 6: function pair(x: number, y: number): LuaMultiReturn<[number, number]> {
    // line 7:   return swap(x, y);
    // line 8: }
    const CALL_TS_LINE = 7;
    const source = `\
/** @inline */
function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
  const tmp = a;
  return $multi(b, tmp);
}
function pair(x: number, y: number): LuaMultiReturn<[number, number]> {
  return swap(x, y);
}`;

    it("body statement maps to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const tmpDeclLine = findLuaLine(lua, "local tmp");
      await assertLineMapsTo(externalMap, tmpDeclLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, tmpDeclLine, CALL_TS_LINE);
    });
  });

  // -------------------------------------------------------------------------
  // Array destructure-site: `const [p, q] = swap(x, y)` via buildArrayDestructureInline
  // -------------------------------------------------------------------------
  describe("multi-return array-destructure-site: body statements map to call TS line", () => {
    // line 1: /** @inline */
    // line 2: function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
    // line 3:   const tmp = a;
    // line 4:   return $multi(b, tmp);
    // line 5: }
    // line 6: declare const x: number;
    // line 7: declare const y: number;
    // line 8: const [p, q] = swap(x, y);
    const CALL_TS_LINE = 8;
    const source = `\
/** @inline */
function swap(a: number, b: number): LuaMultiReturn<[number, number]> {
  const tmp = a;
  return $multi(b, tmp);
}
declare const x: number;
declare const y: number;
const [p, q] = swap(x, y);`;

    it("body statement maps to call TS line", async () => {
      const { lua, externalMap, traceback } = compileWithSourceMap(source);
      const tmpDeclLine = findLuaLine(lua, "local tmp");
      await assertLineMapsTo(externalMap, tmpDeclLine, CALL_TS_LINE);
      assertTracebackMapsTo(traceback, tmpDeclLine, CALL_TS_LINE);
    });
  });
});
