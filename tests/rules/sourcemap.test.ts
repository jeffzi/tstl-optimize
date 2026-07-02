import { describe, expect, it } from "vitest";
import { compileWithSourceMap } from "../helpers";
import {
  assertLineMapsTo,
  assertMapped,
  assertTracebackMapsTo,
  findLuaLine,
  rhsStartCol,
} from "../sourcemap-helpers";

/** Find the 0-based Lua column of `needle` on an emitted line. */
function luaColOf(luaLineText: string, needle: string): number {
  const col = luaLineText.indexOf(needle);
  if (col === -1) throw new Error(`"${needle}" not found on Lua line: ${luaLineText}`);
  return col;
}

/** Find the 0-based TS column of `needle` on TS line `lineIndex` (0-based). */
function tsColOf(source: string, lineIndex: number, needle: string): number {
  const line = source.split("\n")[lineIndex];
  if (line === undefined) throw new Error(`Source has no line ${lineIndex}`);
  const col = line.indexOf(needle);
  if (col === -1) throw new Error(`"${needle}" not found on TS line ${lineIndex}: ${line}`);
  return col;
}

// ---------------------------------------------------------------------------
// conditional-compilation: folded constant carries original identifier position
//
// `tryFoldExpression` calls `constantToLuaLiteral(value)` and returns the
// fresh Lua literal without position, so the debugger maps it to column 0
// (the assignment statement start) instead of the identifier's column.
//
// After `tstl.setNodeOriginal(lit, node)`, the literal root carries the
// TS identifier's position.
//
// Column-level assertion: the assignment statement already maps the line, so
// a line-only check cannot detect whether the literal itself is stamped.
// ---------------------------------------------------------------------------

describe("conditional-compilation sourcemap: folded constant maps to identifier position", () => {
  // line 1: declare const DEBUG: boolean;
  // line 2: const x = DEBUG;
  // DEBUG is configured as `false` → folded to Lua `false`.
  // The `false` literal should carry the TS position of `DEBUG`.
  const source = `\
declare const DEBUG: boolean;
const x = DEBUG;`;

  it("folded false literal maps to DEBUG identifier column (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: {
        rules: {
          "constant-propagation": false,
          "conditional-compilation": {
            constants: { DEBUG: { env: "TEST_CC_DEBUG", default: false } },
          },
        },
      },
    });

    // TSTL emits module-level `const x` as `x = false` (no `local`).
    // Lua: "x = false"
    //       012345678
    // `false` starts at col 4.
    const luaLine = findLuaLine(lua, "x = false");
    const pos = await assertMapped(externalMap, luaLine, 4);
    expect(pos.line).toBe(2);
    // TS line 2: "const x = DEBUG;" → `DEBUG` starts at col 10
    const tsLine2 = source.split("\n")[1];
    const tsDebugCol = tsLine2.indexOf("DEBUG");
    expect(pos.column).toBe(tsDebugCol);
  });
});

// ---------------------------------------------------------------------------
// loop-rebase: position stamping on rewritten nodes
//
// The rebase mutates the ForStatement in-place: init 0→1, limit adjusted,
// and body `i+1` BinaryExpressions replaced with bare `i`.  Each freshly
// created Lua node needs `withPositionFrom` so the debugger maps them back
// to the original TypeScript positions instead of falling back to the
// surrounding statement's column-0 segment.
// ---------------------------------------------------------------------------

describe("loop-rebase sourcemap: rebased init literal maps to original 0 position", () => {
  // line 1: declare const arr: number[];
  // line 2: declare const n: number;
  // line 3: for (const i of $range(0, n - 1)) {   ← `0` at col 23
  // line 4:   const x = arr[i];
  // line 5: }
  const source = `\
declare const arr: number[];
declare const n: number;
for (const i of $range(0, n - 1)) {
  const x = arr[i];
}`;

  it("rebased init `1` maps to TS col of `0` in $range", async () => {
    const { lua, externalMap, traceback } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "loop-rebase": true } },
    });

    const forLine = findLuaLine(lua, "for i = 1, n do");
    // "for i = 1, n do"
    //  01234567890
    // `1` is at col 8
    const pos = await assertMapped(externalMap, forLine, 8);
    expect(pos.line).toBe(3);

    // col 23 is where `0` appears in `for (const i of $range(0, n - 1)) {`
    const tsLine3 = source.split("\n")[2];
    const tsZeroCol = tsLine3.indexOf("$range(") + "$range(".length;
    expect(pos.column).toBe(tsZeroCol);
    assertTracebackMapsTo(traceback, forLine, 3);
  });
});

describe("loop-rebase sourcemap: incrementLimit NumericLiteral maps to original limit position", () => {
  // line 1: declare const arr: number[];
  // line 2: for (const i of $range(0, 5)) {   ← `5` at col 26
  // line 3:   const x = arr[i];
  // line 4: }
  //
  // The literal limit 5 becomes 6.  `createNumericLiteral(6)` produces a fresh
  // node with no position; after `withPositionFrom(result, limit)` it should
  // carry the same TS column as the original `5` literal.
  const source = `\
declare const arr: number[];
for (const i of $range(0, 5)) {
  const x = arr[i];
}`;

  it("rebased limit `6` maps to TS col of `5` in $range (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "loop-rebase": true } },
    });

    const forLine = findLuaLine(lua, "for i = 1, 6");
    const forLineText = lua.split("\n")[forLine - 1];
    // col of `6` in `for i = 1, 6 do`
    const luaLimitCol = forLineText.indexOf(", 6") + 2;

    const pos = await assertMapped(externalMap, forLine, luaLimitCol);
    expect(pos.line).toBe(2);
    // TS line 2: `for (const i of $range(0, 5)) {` → `5` is after `$range(0, `
    const tsLine2 = source.split("\n")[1];
    const tsLimitCol = tsLine2.indexOf("$range(0, ") + "$range(0, ".length;
    expect(pos.column).toBe(tsLimitCol);
  });
});

describe("loop-rebase sourcemap: replaced i+1 identifier maps to expression position", () => {
  // Same source as the init test. The `i+1` BinaryExpression in `arr[i+1]` (Lua,
  // before rebase) is replaced by a bare `i` identifier. That new `i` should carry
  // the BinaryExpression's position so the debugger lands on the array index, not
  // on `arr` or the surrounding assignment.
  const source = `\
declare const arr: number[];
declare const n: number;
for (const i of $range(0, n - 1)) {
  const x = arr[i];
}`;

  it("replaced i identifier in arr[i] maps to TS arr[i] access position (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "loop-rebase": true } },
    });

    const bodyLine = findLuaLine(lua, "arr[i]");
    const bodyLineText = lua.split("\n")[bodyLine - 1];
    const luaIndexCol = luaColOf(bodyLineText, "i]");
    const pos = await assertMapped(externalMap, bodyLine, luaIndexCol);
    // TS line 4: `  const x = arr[i];`
    expect(pos.line).toBe(4);
    expect(pos.column).toBe(tsColOf(source, 3, "arr[i]"));
  });
});

// ---------------------------------------------------------------------------
// math-intrinsics: rewritten expression root carries call-site position
//
// Each build* helper returns a fresh Lua expression root created without
// a position.  After setNodeOriginal(root, tsCallExpr), the root is stamped
// with the call expression's source location so a debugger lands on the call
// line (and column) rather than deep inside the rewritten ternary or on the
// adjacent assignment.
//
// Column-level assertions catch regressions: the assignment statement already
// maps the line correctly, so a line-only check cannot detect whether the
// expression root itself is stamped.  For buildFloor / buildAbs the root
// node starts at a Lua column that precedes the first positioned child, making
// the two cases distinguishable.
// ---------------------------------------------------------------------------

// Math.floor(x) falls through to math.floor(x) (no inline rewrite).
// Verify the passthrough still maps to the original call site.

describe("math-intrinsics sourcemap: Math.floor passthrough maps to call site", () => {
  // line 1: declare const x: number;
  // line 2: const a = Math.floor(x);
  const source = `\
declare const x: number;
const a = Math.floor(x);`;

  it("passthrough math.floor column maps to Math.floor call (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "math-intrinsics": true } },
    });

    const luaLine = findLuaLine(lua, "math.floor");
    const luaLineText = lua.split("\n")[luaLine - 1];
    const exprCol = rhsStartCol(luaLineText);
    const expectedTsCol = tsColOf(source, 1, "Math.floor");

    const pos = await assertMapped(externalMap, luaLine, exprCol);
    expect(pos.line).toBe(2);
    expect(pos.column).toBe(expectedTsCol);
  });
});

// buildAbs: Math.abs(x) → ternary
// Root `or` BinaryExpression also starts before the first positioned child.

describe("math-intrinsics sourcemap: buildAbs root maps to call site", () => {
  // line 1: declare const x: number;
  // line 2: const a = Math.abs(x);
  const source = `\
declare const x: number;
const a = Math.abs(x);`;

  it("rewritten expression root column maps to Math.abs call (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "math-intrinsics": true } },
    });

    const luaLine = findLuaLine(lua, "a =");
    const luaLineText = lua.split("\n")[luaLine - 1];
    const exprCol = rhsStartCol(luaLineText);
    const expectedTsCol = tsColOf(source, 1, "Math.abs");

    const pos = await assertMapped(externalMap, luaLine, exprCol);
    expect(pos.line).toBe(2);
    expect(pos.column).toBe(expectedTsCol);
  });
});

// buildSqrt: Math.sqrt(x) → x ^ 0.5
// Line-level: the root expression maps to the correct TS line.

describe("math-intrinsics sourcemap: buildSqrt root maps to call site", () => {
  const source = `\
declare const x: number;
const a = Math.sqrt(x);`;

  it("rewritten expression line maps to Math.sqrt call (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "math-intrinsics": true } },
    });

    const luaLine = findLuaLine(lua, "^ 0.5");
    const luaLineText = lua.split("\n")[luaLine - 1];
    const pos = await assertMapped(externalMap, luaLine, rhsStartCol(luaLineText));
    expect(pos.line).toBe(2);
    expect(pos.column).toBe(tsColOf(source, 1, "Math.sqrt"));
  });
});

// BinaryExpression visitor: x ** 2 → x * x
// Line-level: the root expression maps to the correct TS line.

describe("math-intrinsics sourcemap: x ** 2 rewrite maps to call site", () => {
  const source = `\
declare const x: number;
const a = (x + 1) ** 2;`;

  it("rewritten x * x expression line maps to x ** 2 TS line (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "math-intrinsics": true } },
    });

    const luaLine = findLuaLine(lua, "*");
    const luaLineText = lua.split("\n")[luaLine - 1];
    const pos = await assertMapped(externalMap, luaLine, rhsStartCol(luaLineText));
    expect(pos.line).toBe(2);
    expect(pos.column).toBe(tsColOf(source, 1, "(x + 1) ** 2"));
  });
});

// builtin-alias branch: const M = Math; M.floor(x) → M.floor(x)
// Line-level: result expression root maps to call site.

describe("math-intrinsics sourcemap: builtin-alias branch maps to call site", () => {
  const source = `\
declare const x: number;
const M = Math;
const a = M.floor(x);`;

  it("builtin-alias rewrite maps to call site TS line (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "math-intrinsics": true } },
    });

    // M.floor(x) triggers the builtin-alias branch — emits a CallExpression
    const luaLine = findLuaLine(lua, "M.floor");
    const luaLineText = lua.split("\n")[luaLine - 1];
    const pos = await assertMapped(externalMap, luaLine, rhsStartCol(luaLineText));
    // Line 3 in TS: const a = M.floor(x);
    expect(pos.line).toBe(3);
    expect(pos.column).toBe(tsColOf(source, 2, "M.floor"));
  });
});

// ---------------------------------------------------------------------------
// remove-empty-branch: position on the negated condition
//
// When an if-block is empty and the else-block is non-empty, the rule
// promotes the else-block by negating the condition (`not cond`).  The
// fresh UnaryExpression has no position, so the debugger falls back to the
// if-statement's column 0 instead of landing on the original condition.
//
// After `withPositionFrom(unaryExpr, originalCondition)`, the root of the
// negated expression maps to the original condition's TS position.
//
// Column-level assertion: the if statement already maps the line, so a
// line-only check cannot detect whether the `not` expression root itself
// is stamped.  The column check distinguishes the if-statement start (col 0)
// from the condition start (col 4 for `if (x) {`).
// ---------------------------------------------------------------------------

describe("remove-empty-branch sourcemap: negated condition maps to original condition", () => {
  // line 1: declare const x: boolean;
  // line 2: declare function f(): void;
  // line 3: if (x) {
  // line 4: } else {
  // line 5:   f();
  // line 6: }
  // The rule negates the condition and promotes the else body.
  // `not x` (UnaryExpression) root should carry the original `x` position.
  const source = `\
declare const x: boolean;
declare function f(): void;
if (x) {
} else {
  f();
}`;

  it("negated condition root maps to original condition column (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "remove-empty-branch": true } },
    });

    // Lua emits: "if not x then"
    //             0123456789
    // The `not x` UnaryExpression starts at col 3.
    const ifLine = findLuaLine(lua, "if not x then");
    const pos = await assertMapped(externalMap, ifLine, 3);
    expect(pos.line).toBe(3);
    // TS line 3: "if (x) {" → `x` is at col 4
    const tsLine3 = source.split("\n")[2];
    const tsCondCol = tsLine3.indexOf("(") + 1;
    expect(pos.column).toBe(tsCondCol);
  });
});

describe("remove-empty-branch sourcemap: binary-condition negation wraps with position", () => {
  // line 1: declare const x: number;
  // line 2: declare function useY(): void;
  // line 3: if (x > 0) {
  // line 4: } else {
  // line 5:   useY();
  // line 6: }
  //
  // `promoteElseBlock` fires on a BinaryExpression condition.  `negateCondition`
  // wraps the operand in a ParenthesizedExpression (`not (x > 0)`).  After
  // `withPositionFrom(parens, expr)`, the `(` carries an explicit segment mapping
  // to the BinaryExpression's TS column instead of relying on the preceding
  // UnaryExpression segment.
  const source = `\
declare const x: number;
declare function useY(): void;
if (x > 0) {
} else {
  useY();
}`;

  it("parenthesized negation maps to original BinaryExpression column (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "remove-empty-branch": true } },
    });

    // Lua emits: "if not (x > 0) then"
    //             0       7
    // The `(x > 0)` ParenthesizedExpression starts at col 7 (after `if not `).
    const ifLine = findLuaLine(lua, "if not (x > 0) then");
    const luaLineText = lua.split("\n")[ifLine - 1];
    const luaParensCol = luaLineText.indexOf("(x");

    const pos = await assertMapped(externalMap, ifLine, luaParensCol);
    expect(pos.line).toBe(3);
    // TS line 3: `if (x > 0) {` → `x > 0` BinaryExpression starts at `x`, col 4
    const tsLine3 = source.split("\n")[2];
    const tsCondCol = tsLine3.indexOf("x > 0");
    expect(pos.column).toBe(tsCondCol);
  });
});

// ---------------------------------------------------------------------------
// constant-folding: folded literal carries original expression position
//
// `evaluateBinary` returns a fresh literal via `createLiteral(folded)`.  The
// rule then copies `lit.line = expr.line; lit.column = expr.column` from the
// original BinaryExpression.  Without the stamp the literal falls back to the
// surrounding statement's column-0 segment.
//
// Column-level assertion: the assignment statement already maps the line, so
// a line-only check cannot detect whether the folded literal itself is stamped.
// ---------------------------------------------------------------------------

describe("constant-folding sourcemap: folded literal maps to original expression position", () => {
  // line 1: const a = 1 + 2;   ← `1 + 2` at col 10
  const source = "const a = 1 + 2;";

  it("folded literal maps to BinaryExpression column (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "constant-folding": true } },
    });

    // Lua: "a = 3"
    //       01234
    // `3` starts at col 4 (after `a = `).
    const luaLine = findLuaLine(lua, "a = 3");
    const luaLineText = lua.split("\n")[luaLine - 1];
    const pos = await assertMapped(externalMap, luaLine, rhsStartCol(luaLineText));
    expect(pos.line).toBe(1);
    expect(pos.column).toBe(tsColOf(source, 0, "1 + 2"));
  });
});

// ---------------------------------------------------------------------------
// merge-locals: merged statement carries first declaration's position
//
// `mergeConsecutiveLocals` creates a new VariableDeclarationStatement and
// copies `origin.line` and `origin.column` from the first statement in the
// run.  Without the stamp the merged statement has no position and falls back
// to the nearest earlier mapping.
//
// Line-level assertion: the first and second declarations are on different TS
// lines, so verifying the merged statement maps to the first (not second) is
// a meaningful check.
// ---------------------------------------------------------------------------

describe("merge-locals sourcemap: merged statement maps to first declaration", () => {
  // line 1: declare function use(x: number): void;
  // line 2: function f(): void {
  // line 3:   const a = 1;      ← first decl — merged maps here
  // line 4:   const b = 2;
  // line 5:   use(a + b);
  // line 6: }
  const FIRST_DECL_TS_LINE = 3;
  const source = `\
declare function use(x: number): void;
function f(): void {
  const a = 1;
  const b = 2;
  use(a + b);
}`;

  it("merged local maps to first declaration TS line", async () => {
    const { lua, externalMap, traceback } = compileWithSourceMap(source, {
      pluginOptions: { rules: { "constant-propagation": false, "merge-locals": true } },
    });
    const mergedLine = findLuaLine(lua, "local a, b");
    await assertLineMapsTo(externalMap, mergedLine, FIRST_DECL_TS_LINE);
    assertTracebackMapsTo(traceback, mergedLine, FIRST_DECL_TS_LINE);
  });
});

// ---------------------------------------------------------------------------
// constant-propagation: propagated literal maps to original identifier position
//
// The rule substitutes an identifier with a fresh literal via
// `createLiteral(value)`. The literal is stamped with the identifier's
// position via `withPositionFrom(literal, expr)` so the debugger maps back
// to the identifier's column, not the assignment column or a default.
//
// Column-level assertion: the assignment statement already maps the line
// correctly, so a line-only check cannot detect whether the literal itself
// is stamped. The column check distinguishes the assignment start (col 0)
// from the identifier location.
// ---------------------------------------------------------------------------

describe("constant-propagation sourcemap: propagated literal maps to original identifier position", () => {
  // line 1: function f() {
  // line 2:   const x = 42;
  // line 3:   return x;     ← `x` at some column, propagated to `42`
  // line 4: }
  const source = `\
function f() {
  const x = 42;
  return x;
}`;

  it("propagated literal maps to identifier column (external map)", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: {
        rules: { "constant-propagation": true },
      },
    });

    // After propagation, Lua emits: "return 42"
    // The `42` should map back to the TS position of `x` in `return x;`
    const luaLine = findLuaLine(lua, "return 42");
    const luaLineText = lua.split("\n")[luaLine - 1];
    // Find column of `42` in the Lua line
    const luaCol = luaColOf(luaLineText, "42");

    const pos = await assertMapped(externalMap, luaLine, luaCol);
    expect(pos.line).toBe(3); // TS line 3: `return x;`
    // TS line 3: "  return x;" → `x` is before the semicolon
    const tsXCol = tsColOf(source, 2, "x");
    expect(pos.column).toBe(tsXCol);
  });
});

// ---------------------------------------------------------------------------
// unspill: folded compound assignment preserves sourcemap positions
//
// Unspill folds TSTL temp pairs back into direct element access:
//   local ____temp_0 = obj; local ____temp_1 = k
//   ____temp_0[____temp_1] = ____temp_0[____temp_1] + other[j]
// →
//   obj[k] = obj[k] + other[j]
//
// Verifies both the matched v1[v2] positions and non-matching nested
// TableIndexExpressions (other[j]) carry sourcemap coverage.
// ---------------------------------------------------------------------------

describe("unspill sourcemap: folded compound assignment maps to original position", () => {
  const source = `\
declare const obj: Record<string, number>;
declare const k: string;
declare const other: Record<string, number>;
declare const j: string;
obj[k] += other[j];`;

  it("folded obj[k] maps to TS compound assignment line", async () => {
    const { lua, externalMap } = compileWithSourceMap(source, {
      pluginOptions: {
        rules: {
          unspill: true,
          "constant-propagation": false,
          "dead-local": false,
          "merge-locals": false,
        },
      },
    });

    const luaLine = findLuaLine(lua, "obj[k] = obj[k] + other[j]");
    const luaLineText = lua.split("\n")[luaLine - 1];

    // Matched substitution: obj[k] on LHS maps to TS line 5
    const lhsPos = await assertMapped(externalMap, luaLine, luaColOf(luaLineText, "obj[k]"));
    expect(lhsPos.line).toBe(5);

    // Non-matching nested expression: other[j] on RHS maps to TS line 5
    const rhsPos = await assertMapped(externalMap, luaLine, luaColOf(luaLineText, "other[j]"));
    expect(rhsPos.line).toBe(5);
    expect(rhsPos.column).toBe(tsColOf(source, 4, "other[j]"));
  });
});
