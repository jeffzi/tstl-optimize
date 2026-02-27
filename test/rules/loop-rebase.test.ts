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
  });
});
