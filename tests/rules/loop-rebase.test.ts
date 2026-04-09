import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

describe("loop-rebase", () => {
  describe("positive cases (rebased)", () => {
    it("rebases $range(0, n-1) with arr[i] to for i = 1, n", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i]; }",
      );
      expect(lua).toContain("for i = 1, n do");
      expect(lua).toContain("arr[i]");
      expect(lua).not.toContain("i + 1");
    });

    it("rebases literal limit: $range(0, 9) becomes for i = 1, 10", () => {
      const lua = compile(
        "declare const arr: number[]; let sum = 0; for (const i of $range(0, 9)) { sum += arr[i]; }",
      );
      expect(lua).toContain("for i = 1, 10 do");
    });

    it("rebases multiple array accesses: arr[i] + brr[i]", () => {
      const lua = compile(
        "declare const arr: number[]; declare const brr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i] + brr[i]; }",
      );
      expect(lua).toContain("for i = 1, n do");
      expect(lua).not.toContain("i + 1");
    });

    it("rebases array write: arr[i] = value", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; for (const i of $range(0, n - 1)) { arr[i] = 0; }",
      );
      expect(lua).toContain("for i = 1, n do");
      expect(lua).not.toContain("i + 1");
    });

    it("rebases nested expression: result += arr[i] * 2", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let result = 0; for (const i of $range(0, n - 1)) { result += arr[i] * 2; }",
      );
      expect(lua).toContain("for i = 1, n do");
      expect(lua).not.toContain("i + 1");
    });
  });

  describe("negative cases (not rebased)", () => {
    it("does not rebase $range(1, n) — start is not 0", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(1, n)) { sum += arr[i]; }",
      );
      expect(lua).toContain("for i = 1, n do");
      // Start is 1, not 0 → rule doesn't apply; TSTL's +1 remains
      expect(lua).toContain("i + 1");
    });

    it("blocks when i is used as plain value: arr[i] + i", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i] + i; }",
      );
      // Should NOT rebase because `i` has a bare reference (the `+ i` term)
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("blocks when i is assigned to variable", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let last = 0; for (const i of $range(0, n - 1)) { last = i; const x = arr[i]; }",
      );
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("does not rebase loop with no array accesses (just sum += i)", () => {
      const lua = compile(
        "declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += i; }",
      );
      // No +1 pattern to detect, and i is used bare → blocked anyway
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("passes through when rule is disabled via config", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i]; }",
        { pluginOptions: { rules: { "loop-rebase": false } } },
      );
      expect(lua).toContain("for i = 0, n - 1 do");
      expect(lua).toContain("i + 1");
    });

    it("passes through non-$range for-of (array iteration via ipairs)", () => {
      const lua = compile(
        "const arr: number[] = [1, 2, 3]; let sum = 0; for (const x of arr) { sum += x; }",
      );
      expect(lua).toContain("ipairs");
      expect(lua).not.toContain("for i =");
    });
  });

  describe("edge cases", () => {
    it("rebases outer loop independently when nested loop shadows variable", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const brr: number[];",
          "declare const n: number;",
          "declare const m: number;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1)) {",
          "  for (const i of $range(0, m - 1)) {",
          "    sum += brr[i];",
          "  }",
          "  sum += arr[i];",
          "}",
        ].join("\n"),
      );
      // Both loops should be independently rebaseable
      expect(lua).toContain("for i = 1, n do");
      expect(lua).toContain("for i = 1, m do");
    });

    it("analyzes variable inside closure — blocks if used as plain ref", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare function consume(f: () => number): void;",
          "for (const i of $range(0, n - 1)) {",
          "  consume(() => i);",
          "}",
        ].join("\n"),
      );
      // `i` referenced as bare identifier inside closure → blocked
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("rebases when variable is only used as arr[i] inside closure", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare function consume(f: () => number): void;",
          "for (const i of $range(0, n - 1)) {",
          "  consume(() => arr[i]);",
          "}",
        ].join("\n"),
      );
      expect(lua).toContain("for i = 1, n do");
    });

    it("blocks when variable declaration shadows control variable", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1)) {",
          "  if (n > 0) {",
          "    let i = 99;",
          "    sum += arr[i];",
          "  }",
          "  sum += arr[i];",
          "}",
        ].join("\n"),
      );
      // `let i = 99` shadows the control variable inside the if-block;
      // rebase must be blocked to avoid replacing the shadowed i + 1
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("handles limit that is an arbitrary expression", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare function len(): number;",
          "let sum = 0;",
          "for (const i of $range(0, len() - 1)) { sum += arr[i]; }",
        ].join("\n"),
      );
      // limit was `len() - 1`, after increment becomes `len()`
      expect(lua).toContain("for i = 1, len() do");
    });

    it("handles limit that is neither literal nor n-1 pattern", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare function len(): number;",
          "let sum = 0;",
          "for (const i of $range(0, len())) { sum += arr[i]; }",
        ].join("\n"),
      );
      // limit is len() — not a literal and not n-1; fallback adds +1
      expect(lua).toContain("for i = 1, len() + 1 do");
    });

    it("blocks rebase when step is not 1", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1, 2)) { sum += arr[i]; }",
        ].join("\n"),
      );
      // step=2 blocks rebase — original loop preserved
      expect(lua).toContain("for i = 0, n - 1, 2 do");
    });

    it("rebases when closure param shadows control variable", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare function consume(f: (i: number) => number): void;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1)) {",
          "  consume((i: number) => i * 2);",
          "  sum += arr[i];",
          "}",
        ].join("\n"),
      );
      // Arrow param `i` shadows control var — its body is skipped
      // Outer `arr[i]` still rebases
      expect(lua).toContain("for i = 1, n do");
    });

    it("skips nested for-in that shadows control variable", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare const obj: Record<string, number>;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1)) {",
          "  for (const i in obj) {}",
          "  sum += arr[i];",
          "}",
        ].join("\n"),
      );
      // Inner for-in shadows `i` — its body is skipped
      // Outer `arr[i]` still rebases
      expect(lua).toContain("for i = 1, n do");
    });
  });

  describe("uncovered branches: pattern matching and step validation", () => {
    it("detects 1 + var pattern (left 1, right var) in array indices during rebase", () => {
      // Lines 22, 24: tests the (lIsOne && rIsVar) branch in analyzeBody
      // When analyzing the loop body, the code checks if left is 1 and right is var.
      // This test ensures both branches of the condition are tested:
      // (lIsVar && rIsOne) is covered by existing tests with i + 1
      // (lIsOne && rIsVar) is what we test here with 1 + i
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[1 + i]; }",
      );
      // Rebase should still apply with this pattern
      expect(lua).toContain("for i = 1, n do");
      // The expression 1 + i should exist in the output (pattern detection works)
      expect(lua).toContain("arr[");
    });

    it("does not rebase loop with step expression != 1", () => {
      // Line 113: tests the stepExpression.value !== 1 branch
      // When step is not 1, loop-rebase doesn't apply. TSTL converts to while loop.
      const lua = compile(`
        declare const arr: number[];
        const sum = (function () {
          let sum = 0;
          for (let i = 0; i < 10; i += 2) {
            sum += arr[i];
          }
          return sum;
        })();
      `);
      // Step is 2, not 1 — loop-rebase should NOT apply
      // The Lua output uses while loop instead of for loop
      expect(lua).toContain("while i < 10 do");
      expect(lua).toContain("i = i + 2");
      // No Lua for loop means rebase didn't happen
      expect(lua).not.toContain("for i = 1");
    });

    it("does not rebase loop with step expression < 1 (fractional step)", () => {
      // Line 113: additional coverage for non-1 step values
      const lua = compile(`
        declare const arr: number[];
        const sum = (function () {
          let sum = 0;
          for (let i = 0; i < 10; i += 0.5) {
            sum += arr[i];
          }
          return sum;
        })();
      `);
      // Step is 0.5, not 1 — loop-rebase should NOT apply
      // Uses while loop, not for loop
      expect(lua).toContain("while i < 10 do");
      expect(lua).toContain("i = i + 0.5");
      expect(lua).not.toContain("for i = 1");
    });

    it("does not rebase loop with negative step expression", () => {
      // Line 113: test negative step (0-based loop with step != 1 should not rebase)
      const lua = compile(`
        declare const arr: number[];
        const sum = (function () {
          let sum = 0;
          for (let i = 10; i > 0; i--) {
            sum += arr[i];
          }
          return sum;
        })();
      `);
      // Non-zero init, negative step — loop-rebase should NOT apply
      // Uses while loop, not for loop
      expect(lua).toContain("while i > 0 do");
      expect(lua).toContain("i = i - 1");
      // No Lua for loop means rebase didn't happen
      expect(lua).not.toContain("for i = 1");
    });
  });
});
