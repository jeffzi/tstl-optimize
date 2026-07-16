import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("unspill", () => {
  describe("statement-form compound assignment collapse", () => {
    it("POSITIVE: $range compound assign collapses with pure base and key", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i] += brr[i] * 0.016;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + brr[i] * 0.016");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it("POSITIVE: postfix arr[i]++ statement collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i]++;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + 1");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it("POSITIVE: prefix ++arr[i] statement collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
for (const i of $range(0, 999)) {
  ++arr[i];
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + 1");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });
  });

  describe("safety: declined when base or key are impure", () => {
    it("NEGATIVE: impure base (property chain) is declined", () => {
      const lua = compile(
        `/** @noSelfInFile */
const obj = { arr: [] as number[] };
const brr: number[] = [];
for (const i of $range(0, 999)) {
  obj.arr[i] += brr[i] * 0.016;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // base is obj.arr (TableIndexExpression) → impure → declined
      expect(lua).toContain("local ____obj_arr_0");
      // should NOT collapse to a direct property access assignment
      expect(lua).not.toContain("obj.arr[i] = obj.arr[i] +");
    });

    it("NEGATIVE: impure key (arithmetic) is declined when loop-rebase is off", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i] += brr[i] * 0.016;
}`,
        {
          pluginOptions: {
            rules: { "loop-rebase": false, localizer: false },
          },
        },
      );

      // key is i + 1 (BinaryExpression) → impure → declined
      expect(lua).toContain("local ____arr_0");
      expect(lua).toContain("____temp_1");
    });
  });

  describe("nested-scope recursion: function bodies", () => {
    it("POSITIVE: $range compound assign inside function body collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
export function process(): void {
  for (const i of $range(0, 999)) {
    arr[i] += brr[i] * 0.016;
  }
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + brr[i] * 0.016");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it("POSITIVE: compound assign inside nested function (function-in-function) collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
export function outer(): void {
  const inner = () => {
    for (const i of $range(0, 999)) {
      arr[i] += brr[i] * 0.016;
    }
  };
  inner();
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + brr[i] * 0.016");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });
  });

  describe("value-temp (expression-form) compound assignment collapse", () => {
    it("POSITIVE: string-key map value-temp consumed by return collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const m: Record<string, number> = {};
export function bump(): number {
  return (m["k"] += 5);
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // TSTL's printer canonicalizes a string-literal index that is a valid Lua
      // identifier (`["k"]`) to dot notation (`.k`) once the key temp is folded away.
      expect(lua).toContain("local ____m_k_2 = m.k + 5");
      expect(lua).toContain("m.k = ____m_k_2");
      expect(lua).toContain("return ____m_k_2");
      expect(lua).not.toContain("____m_0");
      expect(lua).not.toContain("____k_1");
    });

    it("POSITIVE: rebased $range value-temp consumed by assignment collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
let acc = 0;
for (const i of $range(0, 999)) {
  acc = (arr[i] += 5);
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local ____arr_index_2 = arr[i] + 5");
      expect(lua).toContain("arr[i] = ____arr_index_2");
      expect(lua).toContain("acc = ____arr_index_2");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it("POSITIVE: postfix arr[i]++ value-temp consumed by assignment collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
let acc = 0;
for (const i of $range(0, 999)) {
  acc = arr[i]++;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local ____arr_index_2 = arr[i]");
      expect(lua).toContain("arr[i] = ____arr_index_2 + 1");
      expect(lua).toContain("acc = ____arr_index_2");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it("NEGATIVE: impure key (i + 1 outside $range rebase) is declined", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
export function bump(i: number): number {
  return (arr[i] += 5);
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local ____arr_0, ____temp_1 = arr, i + 1");
      expect(lua).toContain("____temp_1");
    });
  });

  describe("pipeline interaction with localizer", () => {
    it("POSITIVE: unspilled L-value survives localizer pass (single-read RHS, no hoisting)", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i] += brr[i] * 0.016;
}`,
        {},
      );

      // Unspill collapsed the base/key temps; localizer left both arr[i] and brr[i] inline
      // because reads per base are below the threshold of 2 (LHS writes do not count).
      expect(lua).toContain("arr[i] = arr[i] + brr[i] * 0.016");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
      expect(lua).not.toContain("local ____brr");
    });

    it("POSITIVE: localizer hoists multi-read RHS while leaving unspilled L-value inline", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i] += brr[i] + brr[i] * 0.016;
}`,
        {},
      );

      // brr[i] occurs twice (read count = 2) → hoisted into a local;
      // arr[i] is the assignment target (RHS read count = 1) → stays inline.
      expect(lua).toContain("local ____brr = brr[i]");
      expect(lua).toContain("arr[i] = arr[i] + (____brr + ____brr * 0.016)");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });
  });

  describe("rule gating", () => {
    it("CONFIG: unspill off leaves temps intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i] += brr[i] * 0.016;
}`,
        {
          pluginOptions: {
            rules: { unspill: false, localizer: false },
          },
        },
      );

      expect(lua).toContain("local ____arr_0");
      expect(lua).toContain("____temp_1");
    });
  });

  describe("safety: declined when temps appear bare in RHS", () => {
    // After merge-locals, user locals can form a 2-local decl that matches
    // the unspill pattern. If the RHS of the assignment contains bare reads
    // of v1/v2 (not inside v1[v2]), the fold must be declined — otherwise
    // dropping the decl orphans those references (reads nil at runtime).
    it("bare v1 in RHS declines fold (preserves local decl)", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = t[key] + t;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // Inside function scope, merge-locals combines into: local t, key = obj, k
      // The bare `t` in `t[key] + t` must prevent unspill from folding.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("t[key] = t[key] + t");
    });

    it("genuine TSTL temps (no bare reads) still fold", () => {
      const lua = compile(
        `/** @noSelfInFile */
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  arr[i] += brr[i] * 0.016;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + brr[i] * 0.016");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it("bare temp inside a call argument declines fold", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function f(x: any): number;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = t[key] + f(t);
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // Bare t inside f(t) is unreachable by the substituter.
      // The fold must be declined to preserve the local decl.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("f(t)");
    });

    it("v1[v2] pattern inside a call argument declines fold", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function g(x: any): number;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = t[key] + g(t[key]);
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // t[key] inside g(...) is unreachable by the substituter
      // (the substituter only walks into TableIndexExpression and BinaryExpression).
      // The fold must be declined to preserve the local decl.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("g(t[key])");
    });

    it.each([
      { label: "foreign table with the key temp as index", read: "other[key]" },
      { label: "the base temp with a foreign index", read: "t[idx]" },
    ])("NEGATIVE: partial-name index read of $label ($read) declines fold", ({ read }) => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<number, any>;
declare const k: number;
declare const other: Record<number, number>;
declare const idx: number;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = t[key] + ${read} + key;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // A partial-name index read (only one of table/index matches a temp name)
      // is not substitutable — treating it as a v1[v2] pattern would orphan the
      // non-matching temp reference when the decl is dropped.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain(`t[key] = t[key] + ${read} + key`);
    });
  });

  describe("safety: temps referenced beyond the spill site", () => {
    // Dropping `local t, key = obj, k` while a later statement still reads t or key
    // would orphan that read (nil at runtime), so the fold must be declined.
    it.each([
      "t",
      "key",
    ])("NEGATIVE: 2-temp fold declined when %s is read after the assignment", (escapee) => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function f(x: any): number;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = t[key] + 1;
  f(${escapee});
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain(`f(${escapee})`);
    });

    it("POSITIVE: control — same 2-temp shape with no trailing read folds", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = t[key] + 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("obj[k] = obj[k] + 1");
      expect(lua).not.toContain("local t, key");
    });

    it.each([
      "t",
      "key",
    ])("NEGATIVE: value-temp fold declined when %s is read beyond the 3-statement window", (escapee) => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function f(x: any): number;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = t[key] + 1;
  t[key] = v3;
  f(${escapee});
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("local v3 = t[key] + 1");
      expect(lua).toContain(`f(${escapee})`);
    });

    it("POSITIVE: control — same value-temp shape with no trailing read collapses", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = t[key] + 1;
  t[key] = v3;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local v3 = obj[k] + 1");
      expect(lua).toContain("obj[k] = v3");
      expect(lua).not.toContain("local t, key");
    });

    it("NEGATIVE: bare temp read in the value-temp initializer declines the fold", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = t[key] + t;
  t[key] = v3;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("local v3 = t[key] + t");
    });

    it("NEGATIVE: bare temp read in the value-temp assignment RHS declines the fold", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<number, any>;
declare const k: number;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = t[key] + 1;
  t[key] = v3 + key;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("t[key] = v3 + key");
    });
  });

  describe("shape rejections: declaration must bind exactly two locals", () => {
    it("NEGATIVE: single-binding declaration before an index assignment is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  t[k] = t[k] + 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t = obj");
      expect(lua).toContain("t[k] = t[k] + 1");
    });

    it("NEGATIVE: three-binding declaration before an index assignment is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  let x;
  t[key] = t[key] + 1;
  x = 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // merge-locals combines all three into: local t, key, x = obj, k, nil
      expect(lua).toContain("local t, key, x = obj, k, nil");
      expect(lua).toContain("t[key] = t[key] + 1");
    });

    it("NEGATIVE: declaration from a multi-return destructure (single RHS) is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare function f(): LuaMultiReturn<[any, string]>;
function test() {
  const [t, key] = f();
  t[key] = t[key] + 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t, key = f()");
      expect(lua).toContain("t[key] = t[key] + 1");
    });

    it("NEGATIVE: declaration with a third RHS value (over-length tuple) is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const [t, key] = [obj, k, 0];
  t[key] = t[key] + 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // A fold here would drop the declaration along with its third RHS value.
      expect(lua).toContain("local t, key = obj, k, 0");
      expect(lua).toContain("t[key] = t[key] + 1");
    });
  });

  describe("shape rejections: value-temp declaration must bind one local from v1[v2]", () => {
    it("NEGATIVE: multi-binding value-temp declaration is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  const [v3, v4] = [t[key] + 1, 2];
  t[key] = v3;
  return v4;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // A fold here would rebuild the declaration with a single RHS expression,
      // dropping v4's initializer.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("local v3, v4 = t[key] + 1, 2");
    });

    it("NEGATIVE: value-temp pattern truncated at scope end (no assignment) is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = t[key] + 1;
}`,
        { pluginOptions: { rules: { localizer: false, "dead-local": false } } },
      );

      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("local v3 = t[key] + 1");
    });

    it("NEGATIVE: value temp followed by a store to a different table is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<number, any>;
declare const k: number;
declare const other: Record<number, number>;
declare const idx: number;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = t[key] + 1;
  other[idx] = v3;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("local v3 = t[key] + 1");
      expect(lua).toContain("other[idx] = v3");
    });

    it("NEGATIVE: value-temp initializer without a v1[v2] read is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function g(): number;
function test() {
  const t: any = obj;
  const key = k;
  const v3 = g();
  t[key] = v3;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // The value temp must be derived from v1[v2] — an unrelated initializer
      // means this is not the TSTL 3-temp spill pattern.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("local v3 = g()");
    });
  });

  describe("shape rejections: following assignment must write v1[v2]", () => {
    it("NEGATIVE: plain store without a self-read (t[key] = 5) is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = 5;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // A fold here would drop the decl and emit obj[k] = 5 — the rule only
      // targets compound assignments, whose RHS reads back v1[v2].
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("t[key] = 5");
    });

    it.each([
      { label: "both mismatched", lhs: "key[t]" },
      { label: "index mismatched", lhs: "t[t]" },
      { label: "table mismatched", lhs: "key[key]" },
    ])("NEGATIVE: LHS temp names $label ($lhs) is left intact", ({ lhs }) => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
function test() {
  const t: any = obj;
  const key: any = k;
  ${lhs} = t[key] + 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // A fold here would rebuild the LHS as obj[k], silently redirecting the
      // write away from the location the source names.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain(`${lhs} = t[key] + 1`);
    });

    it("NEGATIVE: RHS reading only a foreign table (no v1[v2] read) is left intact", () => {
      const lua = compile(
        `/** @noSelfInFile */
declare const obj: Record<number, any>;
declare const k: number;
declare const other: Record<number, number>;
declare const idx: number;
function test() {
  const t: any = obj;
  const key = k;
  t[key] = other[idx] + 1;
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      // The rule only targets compound assignments, whose RHS reads back v1[v2];
      // an unrelated index read must not satisfy that requirement.
      expect(lua).toContain("local t, key = obj, k");
      expect(lua).toContain("t[key] = other[idx] + 1");
    });
  });

  describe("nested-scope recursion: control-flow blocks", () => {
    it.each([
      {
        block: "if",
        body: `if (flag) {
    arr[i] += brr[i] * 0.016;
  }`,
      },
      {
        block: "else",
        body: `if (flag) {
    arr[i] = 0;
  } else {
    arr[i] += brr[i] * 0.016;
  }`,
      },
      {
        block: "do",
        body: `{
    arr[i] += brr[i] * 0.016;
  }`,
      },
    ])("POSITIVE: compound assign inside $block block collapses", ({ body }) => {
      const lua = compile(
        `/** @noSelfInFile */
declare const flag: boolean;
const arr: number[] = [];
const brr: number[] = [];
for (const i of $range(0, 999)) {
  ${body}
}`,
        { pluginOptions: { rules: { localizer: false } } },
      );

      expect(lua).toContain("arr[i] = arr[i] + brr[i] * 0.016");
      expect(lua).not.toContain("____arr_0");
      expect(lua).not.toContain("____temp_1");
    });

    it.each([
      {
        block: "while body",
        source: `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function cond(): boolean;
function test() {
  while (cond()) {
    const t: any = obj;
    const key = k;
    t[key] = t[key] + 1;
  }
}`,
      },
      {
        block: "repeat body",
        source: `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare function cond(): boolean;
function test() {
  do {
    const t: any = obj;
    const key = k;
    t[key] = t[key] + 1;
  } while (cond());
}`,
      },
      {
        block: "else-if branch",
        source: `/** @noSelfInFile */
declare const obj: Record<string, any>;
declare const k: string;
declare const a: boolean;
declare const b: boolean;
function test() {
  if (a) {
    return;
  } else if (b) {
    const t: any = obj;
    const key = k;
    t[key] = t[key] + 1;
  }
}`,
      },
    ])("POSITIVE: 2-temp fold applies inside a $block", ({ source }) => {
      const lua = compile(source, { pluginOptions: { rules: { localizer: false } } });

      expect(lua).toContain("obj[k] = obj[k] + 1");
      expect(lua).not.toContain("local t, key");
    });
  });
});
