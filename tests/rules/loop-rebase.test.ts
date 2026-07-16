import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compile, expectLuaSnippets } from "../helpers";

describe("loop-rebase", () => {
  describe("when loop qualifies for rebase", () => {
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

    it("keeps a foreign 1 + j index intact while rebasing arr[i]", () => {
      const lua = compile(
        "declare const arr: number[]; declare const brr: number[]; declare const j: number; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i] + brr[1 + j]; }",
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "brr[1 + j + 1]"],
        excludes: ["brr[i + 1]"],
      });
    });

    it("rebases nested expression: result += arr[i] * 2", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let result = 0; for (const i of $range(0, n - 1)) { result += arr[i] * 2; }",
      );
      expect(lua).toContain("for i = 1, n do");
      expect(lua).not.toContain("i + 1");
    });
  });

  describe("when loop does not qualify for rebase", () => {
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

    it.each([
      { index: "2 + i", preserved: "arr[2 + i + 1]" },
      { index: "i + 4", preserved: "arr[i + 4 + 1]" },
    ])("blocks when index offset is not the +1 pattern: arr[$index]", ({ index, preserved }) => {
      const lua = compile(
        `declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[${index}]; }`,
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 0, n - 1 do", preserved],
        excludes: ["for i = 1, n do"],
      });
    });

    it("leaves a loop untouched when the body never uses i", () => {
      const lua = compile(
        "declare const n: number; let count = 0; for (const i of $range(0, n - 1)) { count += 1; }",
      );
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

  describe("when handling edge cases", () => {
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

    it("blocks when a closure with a non-shadowing param reads i", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare function consume(f: (j: number) => number): void;",
          "for (const i of $range(0, n - 1)) {",
          "  consume((j: number) => j + i);",
          "  arr[i] = 0;",
          "}",
        ].join("\n"),
      );
      // Param `j` does not shadow `i` — the closure body's bare `i` blocks rebase
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("blocks a shadowing declaration even after a rebase target was found", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1)) {",
          "  arr[i] = 0;",
          "  if (n > 0) {",
          "    let i = 99;",
          "    sum += arr[i];",
          "  }",
          "}",
        ].join("\n"),
      );
      // arr[i] earlier in the body is a valid target, but the shadow decl still blocks
      expect(lua).toContain("for i = 0, n - 1 do");
    });

    it("rebases when the only target sits inside a non-shadowing nested loop", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare const m: number;",
          "for (const i of $range(0, n - 1)) {",
          "  for (const j of $range(1, m)) {",
          "    arr[i] = j;",
          "  }",
          "}",
        ].join("\n"),
      );
      // Inner loop's control variable is j — its body must still be analyzed for i targets
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "for j = 1, m do", "arr[i]"],
        excludes: ["for i = 0, n - 1 do"],
      });
    });

    it("skips a shadowing for-in body that reads its own i", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare const obj: Record<string, number>;",
          "declare const out: Record<string, number>;",
          "for (const i of $range(0, n - 1)) {",
          "  arr[i] = 0;",
          "  for (const i in obj) {",
          "    out[i] = 1;",
          "  }",
          "}",
        ].join("\n"),
      );
      // The for-in's own `i` reads must not block the outer rebase
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "out[i] = 1"],
        excludes: ["for i = 0, n - 1 do"],
      });
    });

    it("analyzes a non-shadowing for-in body for targets", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare const obj: Record<string, number>;",
          "for (const i of $range(0, n - 1)) {",
          "  for (const k in obj) {",
          "    arr[i] = 0;",
          "  }",
          "}",
        ].join("\n"),
      );
      // k does not shadow i — the for-in body must still be analyzed, finding the target
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "arr[i]"],
        excludes: ["for i = 0, n - 1 do"],
      });
    });

    it("skips a destructured pairs() for-in when any name shadows i", () => {
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "declare const obj: LuaTable<string, number>;",
          "declare const out: Record<string, number>;",
          "for (const i of $range(0, n - 1)) {",
          "  arr[i] = 0;",
          "  for (const [i, v] of obj) {",
          "    out[i] = v;",
          "  }",
          "}",
        ].join("\n"),
      );
      // names are [i, v] — one shadowing name is enough to skip the body
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "out[i] = v"],
        excludes: ["for i = 0, n - 1 do"],
      });
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

    it("increments an additive limit (n + 1) via the fallback path", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n + 1)) { sum += arr[i]; }",
      );
      // n + 1 is binary but not the n - 1 shape — fallback appends + 1
      expect(lua).toContain("for i = 1, n + 1 + 1 do");
    });

    it("increments a literal limit without relying on constant folding", () => {
      const lua = compile(
        "declare const arr: number[]; let sum = 0; for (const i of $range(0, 9)) { sum += arr[i]; }",
        { pluginOptions: { rules: { "constant-folding": false } } },
      );
      // The literal fast path emits 10 directly, not a 9 + 1 expression
      expectLuaSnippets(lua, {
        contains: ["for i = 1, 10 do"],
        excludes: ["9 + 1"],
      });
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

    it("rebases when step is explicitly 1 (numeric literal, not absent)", () => {
      // Covers the `value === 1` branch in loop-rebase.ts — step expression is present
      // but equals the identity step, so rebase should still apply.
      const lua = compile(
        [
          "declare const arr: number[];",
          "declare const n: number;",
          "let sum = 0;",
          "for (const i of $range(0, n - 1, 1)) { sum += arr[i]; }",
        ].join("\n"),
      );
      expect(lua).toContain("for i = 1, n, 1 do");
      expect(lua).not.toContain("i + 1");
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

  describe("when loop pattern matching and step validation are evaluated", () => {
    it("rebases loops while preserving a leading offset in array indices", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[1 + i]; }",
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "arr[i + 1]"],
        excludes: ["for i = 0, n - 1 do", "arr[i + 2]"],
      });
    });

    it("rebases while decrementing a trailing offset (arr[i + 1] stays one ahead)", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i + 1]; }",
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "arr[i + 1]"],
        excludes: ["arr[i + 2]", "arr[i]]"],
      });
    });

    it("does not rebase when the index uses a multiplicative expression (i * 1)", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i * 1]; }",
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 0, n - 1 do", "arr[i * 1 + 1]"],
        excludes: ["for i = 1, n do"],
      });
    });

    it("rewrites only control-variable indices — a foreign index keeps its + 1", () => {
      const lua = compile(
        "declare const arr: number[]; declare const brr: number[]; declare const j: number; declare const n: number; let sum = 0; for (const i of $range(0, n - 1)) { sum += arr[i] + brr[j]; }",
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n do", "arr[i]", "brr[j + 1]"],
        excludes: ["brr[j]]"],
      });
    });

    it("does not collapse a limit - 2 bound (only limit - 1 simplifies to limit)", () => {
      const lua = compile(
        "declare const arr: number[]; declare const n: number; let sum = 0; for (const i of $range(0, n - 2)) { sum += arr[i]; }",
      );
      expectLuaSnippets(lua, {
        contains: ["for i = 1, n - 2 + 1 do"],
        excludes: ["for i = 1, n - 1 do", "for i = 1, n do"],
      });
    });

    it.each([
      {
        label: "step = 2",
        src: `
          declare const arr: number[];
          const sum = (function () {
            let sum = 0;
            for (let i = 0; i < 10; i += 2) {
              sum += arr[i];
            }
            return sum;
          })();
        `,
        contains: ["while i < 10 do", "i = i + 2"],
        excludes: ["for i = 1"],
      },
      {
        label: "step = 0.5 (fractional)",
        src: `
          declare const arr: number[];
          const sum = (function () {
            let sum = 0;
            for (let i = 0; i < 10; i += 0.5) {
              sum += arr[i];
            }
            return sum;
          })();
        `,
        contains: ["while i < 10 do", "i = i + 0.5"],
        excludes: ["for i = 1"],
      },
      {
        label: "step = -1 (negative)",
        src: `
          declare const arr: number[];
          const sum = (function () {
            let sum = 0;
            for (let i = 10; i > 0; i--) {
              sum += arr[i];
            }
            return sum;
          })();
        `,
        contains: ["while i > 0 do", "i = i - 1"],
        excludes: ["for i = 1"],
      },
    ])("does not rebase loop when step is $label", ({ src, contains, excludes }) => {
      const lua = compile(src);
      expectLuaSnippets(lua, { contains, excludes });
    });
  });

  describe("loop-rebase properties", () => {
    const FC_OPTS: Parameters<typeof fc.assert>[1] = { numRuns: 20 };

    it("rebases $range(0, N) for any literal N ≥ 0 → for i = 1, N+1 do, no +1 indexing", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 50 }), (n) => {
          const lua = compile(
            `declare const arr: number[]; let sum = 0; for (const i of $range(0, ${n})) { sum += arr[i]; }`,
          );
          return lua.includes(`for i = 1, ${n + 1} do`) && !lua.includes("i + 1");
        }),
        FC_OPTS,
      );
    }, 20_000);

    it("does not rebase when step is any literal ≠ 1", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 10 }),
          fc.integer({ min: 5, max: 20 }),
          (step, limit) => {
            const lua = compile(
              `declare const arr: number[]; let sum = 0; for (const i of $range(0, ${limit}, ${step})) { sum += arr[i]; }`,
            );
            return lua.includes(`for i = 0, ${limit}, ${step} do`);
          },
        ),
        FC_OPTS,
      );
    }, 20_000);
  });
});
