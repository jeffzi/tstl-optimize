import { describe, expect, it } from "vitest";
import { compile } from "../helpers";

const assertNoEmptyDoBlock = (lua: string): void => {
  expect(lua).not.toMatch(/\bdo\s+end\b/);
};

describe("phase executor", () => {
  describe("dead-local stripping with conditional compilation — no empty do..end left behind", () => {
    it.each([
      {
        name: "negated DEBUG constant — dead local in surviving branch",
        source: `
          declare const DEBUG: boolean;
          function f(hp: number) {
            if (!DEBUG) {
              const safeHp = hp;
            }
          }
        `,
        constants: { DEBUG: { env: "BUILD_DEBUG", default: false } },
      },
      {
        name: "positive DEBUG constant — dead local in surviving branch",
        source: `
          declare const DEBUG: boolean;
          function f(hp: number) {
            if (DEBUG) {
              const x = hp;
            }
          }
        `,
        constants: { DEBUG: { env: "BUILD_DEBUG", default: true } },
      },
      {
        name: "multi-block with multiple dead locals in surviving branches",
        source: `
          declare const DEBUG: boolean;
          function f(hp: number, mp: number) {
            if (!DEBUG) {
              const safeHp = hp;
            }
            if (DEBUG) {
              const safeMp = mp;
            }
          }
        `,
        constants: { DEBUG: { env: "BUILD_DEBUG", default: false } },
      },
    ])("$name", ({
      source,
      constants,
    }: {
      name: string;
      source: string;
      constants: Record<string, { env: string; default: boolean }>;
    }) => {
      const lua = compile(source, {
        pluginOptions: {
          rules: {
            "conditional-compilation": { constants },
          },
        },
      });

      assertNoEmptyDoBlock(lua);
    });
  });

  describe("dead local in surviving branch", () => {
    it("removes the local variable and leaves no empty block", () => {
      const lua = compile(
        `
        declare const DEBUG: boolean;
        function f(hp: number) {
          if (!DEBUG) {
            const safeHp = hp;
          }
          return hp;
        }
      `,
        {
          pluginOptions: {
            rules: {
              "conditional-compilation": {
                constants: { DEBUG: { env: "BUILD_DEBUG", default: false } },
              },
            },
          },
        },
      );

      assertNoEmptyDoBlock(lua);
      expect(lua).not.toContain("safeHp");
      expect(lua).toContain("return hp");
    });
  });

  describe("rule interactions — combined optimizations", () => {
    it("eliminates dead local produced by an unused-only initialiser", () => {
      const lua = compile(`
        function f(): number {
          const x = 1;
          return 42;
        }
      `);

      expect(lua).not.toContain("local x");
      expect(lua).toContain("return 42");
    });

    it("rebases 0-based $range loop to 1-based after branch cleanup", () => {
      const lua = compile(`
        declare function print(...args: unknown[]): void;
        declare const arr: number[];
        for (const i of $range(0, arr.length - 1)) {
          print(arr[i]);
        }
      `);

      expect(lua).toMatch(/=\s*1,/);
      expect(lua).not.toContain("= 0,");
    });

    it("inlines @inline function whose body references a hoisted local", () => {
      const lua = compile(`
        declare const math: { floor: (n: number) => number };
        /** @inline */
        function clamp(x: number): number { return math.floor(x); }
        const result = clamp(3.7);
      `);

      expect(lua).not.toContain("clamp(");
      expect(lua).toMatch(/math[.:](floor|floor\()|local\s+\w+\s*=\s*math[.:]floor/);
    });

    it("removes dead local and empty block from conditional branch, preserving the return", () => {
      const lua = compile(
        `
          declare const DEBUG: boolean;
          function heal(amount: number): number {
            if (!DEBUG) {
              const log = amount;
            }
            return amount + 1;
          }
        `,
        {
          pluginOptions: {
            rules: {
              "conditional-compilation": {
                constants: { DEBUG: { env: "BUILD_DEBUG", default: false } },
              },
            },
          },
        },
      );

      assertNoEmptyDoBlock(lua);
      expect(lua).toContain("return amount + 1");
    });
  });
});
