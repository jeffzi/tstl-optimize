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
});
