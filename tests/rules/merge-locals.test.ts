import { describe, expect, it } from "vitest";
import { compile, normalizeLua } from "../helpers";

describe("merge-locals", () => {
  describe("run merging", () => {
    it("merges two consecutive pure single-var locals", () => {
      const lua = normalizeLua(
        compile(`
          function f(): number {
            const a = 1;
            const b = 2;
            return a + b;
          }
        `),
      );
      expect(lua).toContain("local a, b = 1, 2");
    });

    it("merges three consecutive pure single-var locals", () => {
      const lua = normalizeLua(
        compile(`
          function f(): number {
            const a = 1;
            const b = 2;
            const c = 3;
            return a + b + c;
          }
        `),
      );
      expect(lua).toContain("local a, b, c = 1, 2, 3");
    });

    it("breaks run at call expression RHS — merges pure runs independently", () => {
      const lua = normalizeLua(
        compile(`
          declare function get(): number;
          function f(): number {
            const a = 1;
            const b = 2;
            const c = get();
            const d = 4;
            const e = 5;
            return a + b + c + d + e;
          }
        `),
      );
      expect(lua).toContain("local a, b = 1, 2");
      expect(lua).toContain("local c = get()");
      expect(lua).toContain("local d, e = 4, 5");
    });

    it("breaks run at multi-LHS declaration", () => {
      const lua = normalizeLua(
        compile(`
          declare function get(): [number, number];
          function f(): number {
            const a = 1;
            const [x, y] = get();
            const b = 2;
            return a + x + y + b;
          }
        `),
      );
      // 'a' alone — no merge
      expect(lua).toContain("local a = 1");
      // multi-LHS stays unchanged
      expect(lua).toContain("x, y");
      // 'b' alone — no merge
      expect(lua).toContain("local b = 2");
    });

    it("does not merge a single-element non-pure run (call RHS)", () => {
      const lua = normalizeLua(
        compile(`
          declare function get(): number;
          function f(): number {
            const x = get();
            return x;
          }
        `),
      );
      expect(lua).toContain("local x = get()");
    });

    it("does not merge a single-element pure run", () => {
      const lua = normalizeLua(
        compile(`
          function f(): number {
            const x = 1;
            return x;
          }
        `),
      );
      expect(lua).toContain("local x = 1");
      expect(lua).not.toContain("local x, ");
    });
  });

  describe("scope", () => {
    it("does NOT merge module-level consecutive pure single-var locals", () => {
      // Module-level consts are emitted without 'local' by TSTL in module scope
      // (they become global assignments). What matters is they are NOT batched together.
      const lua = normalizeLua(
        compile(`
          export const a = 1;
          export const b = 2;
        `),
      );
      expect(lua).toContain("a = 1");
      expect(lua).toContain("b = 2");
      expect(lua).not.toContain("local a, b");
    });

    it("merges pure locals inside a function body", () => {
      const lua = normalizeLua(
        compile(`
          function foo(): number {
            const a = 1;
            const b = 2;
            return a + b;
          }
        `),
      );
      expect(lua).toContain("local a, b = 1, 2");
    });
  });

  describe("disabled", () => {
    it("does not merge when merge-locals is disabled", () => {
      const lua = normalizeLua(
        compile(
          `
            function f(): number {
              const a = 1;
              const b = 2;
              return a + b;
            }
          `,
          { pluginOptions: { rules: { "merge-locals": false } } },
        ),
      );
      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local b = 2");
      expect(lua).not.toContain("local a, b");
    });
  });

  describe("forward reference safety", () => {
    it("does NOT merge when a later RHS references an LHS declared earlier in the same run", () => {
      // Merging would produce: local a, b = 1, a
      // In Lua, all RHS are evaluated before any assignment, so `a` on the RHS
      // would be nil (or an outer `a`), not 1. The merge must be suppressed.
      const lua = normalizeLua(
        compile(`
          function f(): number {
            const a = 1;
            const b = a;
            return b;
          }
        `),
      );

      expect(lua).toContain("local a = 1");
      expect(lua).toContain("local b = a");
      expect(lua).not.toContain("local a, b");
    });

    it("does NOT merge when a later RHS references a prior LHS inside a table constructor", () => {
      // Merging would produce: local a, t = 1, {x = a}
      // The `a` inside the table constructor is evaluated before `a` is assigned.
      const lua = normalizeLua(
        compile(`
          function f(): number {
            const a = 1;
            const t = { x: a };
            return t.x;
          }
        `),
      );

      expect(lua).toContain("local a = 1");
      expect(lua).not.toContain("local a, t");
    });
  });

  describe("edge cases", () => {
    it("includes local with no RHS (nil-initializer) in a run", () => {
      // TypeScript 'let x: number;' — no initializer
      const lua = normalizeLua(
        compile(`
          function f(): number {
            let a: number;
            const b = 2;
            a = 1;
            return a + b;
          }
        `),
      );
      // 'a' has no RHS — treated as pure, included in run with 'b'
      expect(lua).toContain("local a, b");
    });

    it("includes identifier RHS in a run (pure)", () => {
      const lua = normalizeLua(
        compile(`
          function f(x: number): number {
            const a = x;
            const b = 2;
            return a + b;
          }
        `),
      );
      expect(lua).toContain("local a, b = x, 2");
    });

    it("includes table-constructor RHS in a run (pure)", () => {
      // Table constructor is pure — no side effects
      const lua = normalizeLua(
        compile(`
          function f(): number {
            const t = { x: 1 };
            const b = 2;
            return t.x + b;
          }
        `),
      );
      expect(lua).toContain("local t, b");
    });
  });

  describe("nested function expressions", () => {
    it.each([
      {
        name: "callback passed as a call argument",
        source: `
          declare function run(fn: () => number): void;
          function outer(): void {
            run(function(): number {
              const a = 1;
              const b = 2;
              return a + b;
            });
          }
        `,
      },
      {
        name: "function stored in a table value",
        source: `
          function outer() {
            const obj = { handler: function(): number {
              const a = 1;
              const b = 2;
              return a + b;
            } };
            return obj;
          }
        `,
      },
    ])("merges consecutive pure locals inside $name", ({ source }) => {
      const lua = normalizeLua(compile(source));

      expect(lua).toContain("local a, b = 1, 2");
    });
  });
});
