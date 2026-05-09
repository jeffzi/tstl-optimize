import { describe, expect, it } from "vitest";
import { filterInlineComments } from "../../../src/rules/inline/handlers";
import { compile } from "../../helpers";

describe("inline comment stripping", () => {
  describe("exported @inline declarations", () => {
    it("omits @inline comments from function output", () => {
      const lua = compile(`\
/** @inline */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}`);
      expect(lua).not.toContain("@inline");
    });

    it("omits @inline comments from variable-stored function output", () => {
      const lua = compile(`\
/** @inline */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;`);
      expect(lua).not.toContain("@inline");
    });
  });

  describe("non-@inline comments", () => {
    it("preserves other JSDoc comments", () => {
      const lua = compile(`\
/**
 * Linearly interpolates between a and b.
 * @param t interpolation factor
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}`);
      expect(lua).toContain("Linearly interpolates between a and b");
    });
  });

  describe("nested string[] JSDoc block", () => {
    it("strips @inline from a nested string[] entry while preserving other lines", () => {
      const input: Array<string | string[]> = [["-", " @inline", " @returns the value"]];
      const result = filterInlineComments(input);
      expect(result).not.toBeUndefined();
      const flat = (result ?? []).flat();
      expect(flat.some((s) => typeof s === "string" && /^\s*@inline\s*$/.test(s))).toBe(false);
      expect(flat.some((s) => typeof s === "string" && s.includes("@returns"))).toBe(true);
    });

    it("drops a nested string[] entry that becomes empty after @inline removal", () => {
      const input: Array<string | string[]> = [[" @inline"]];
      const result = filterInlineComments(input);
      expect(result).toBeUndefined();
    });
  });
});
