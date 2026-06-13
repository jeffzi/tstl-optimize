import { describe, expect, it } from "vitest";
import { compileMultiFileWithDiagnostics, normalizeLua } from "../helpers";

// Shared declarations used across tests that exercise require() chains.
const REQUIRE_DECL = "declare function require(path: string): any;";
const BIT_STUB = "export declare const band: (a: number, b: number) => number;";

// Compat module: exports band as a member-require binding.
// This is the typical cross-module pattern that inline materializes into
// require("bit").band chains in the consumer's Lua output.
const COMPAT_TS = `
  ${REQUIRE_DECL}
  export const bit_and = (require("bit") as any).band;
`;

const HOIST_PATTERN = /local ____req_\w+ = require\("bit"\)\.band/;

/**
 * Shared file map used in dedup tests: two call sites (at function scope or module scope)
 * each expand to require("bit").band after inlining.
 *
 * Pass `mainTs` to control whether the call sites are inside a function or at top level.
 */
function makeBitAndFiles(mainTs: string): Record<string, string> {
  return {
    "bit.ts": BIT_STUB,
    "compat.ts": COMPAT_TS,
    "helper.ts": `
      import { bit_and } from "./compat";

      /** @inline */
      export const maskBits = (a: number, b: number): number => bit_and(a, b);
    `,
    "main.ts": mainTs,
  };
}

/**
 * Asserts that `requireExpr` was hoisted into a single ____req_* local, that
 * the raw chain appears only in the hoisted declaration, and that the hoisted
 * local is referenced at least 3 times (declaration + 2 call sites).
 */
function assertRequireHoisted(normalized: string, requireExpr: RegExp): void {
  const hoistMatch = normalized.match(new RegExp(`local (____req_\\w+) = ${requireExpr.source}`));
  expect(hoistMatch).not.toBeNull();
  const hoistName = hoistMatch?.[1];

  const rawOccurrences = (normalized.match(requireExpr) ?? []).length;
  expect(rawOccurrences).toBe(1);

  const useCount = (normalized.match(new RegExp(`\\b${hoistName}\\b`, "g")) ?? []).length;
  expect(useCount).toBeGreaterThanOrEqual(3);
}

function assertBitBandHoisted(normalized: string): void {
  assertRequireHoisted(normalized, /require\("bit"\)\.band/g);
}

describe("hoist-require", () => {
  describe("when the rule is disabled", () => {
    it("does not hoist any require patterns when hoist-require is false", () => {
      // Two call sites produce require("bit").band — with the rule disabled, no hoisted
      // local should appear.
      const { lua } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";
          declare const x: number;
          declare const y: number;
          export const a = maskBits(x, y);
          export const b = maskBits(a, y);
        `),
        { pluginOptions: { rules: { "hoist-require": false } } },
      );
      expect(lua).not.toMatch(/local ____req_\w+ = require/);
    });
  });

  describe("function-scope member-require dedup", () => {
    it("hoists require('path').member used 2+ times in a function body into a single local", () => {
      // Two call sites in the same function both expand to require("bit").band after inline.
      // hoist-require should produce exactly one hoisted local.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";

          export function process(x: number, y: number): number {
            const a = maskBits(x, y);
            const b = maskBits(a, y);
            return a + b;
          }
        `),
      );

      expect(diagnostics).toHaveLength(0);
      assertBitBandHoisted(normalizeLua(lua));
    });

    it("hoists require pattern inside a function when hoist-require is enabled by default", () => {
      // Default config has hoist-require enabled.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const band = (require("bit") as any).band;

          /** @inline */
          export function doubleMask(a: number, b: number): number {
            const first = band(a, b);
            const second = band(first, b);
            return second;
          }
        `,
        "main.ts": `
          import { doubleMask } from "./utils";
          export function run(x: number, y: number): number {
            return doubleMask(x, y);
          }
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      // At most one raw require chain occurrence (in the hoisted declaration)
      const rawOccurrences = (normalized.match(/require\("bit"\)\.band/g) ?? []).length;
      expect(rawOccurrences).toBeLessThanOrEqual(1);
      expect(normalized).toMatch(HOIST_PATTERN);
    });
  });

  describe("single occurrence left inline", () => {
    it("does not hoist a member require pattern that appears only once", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const band = (require("bit") as any).band;

          /** @inline */
          export function mask(a: number, b: number): number {
            return band(a, b);
          }
        `,
        "main.ts": `
          import { mask } from "./utils";
          export const result = mask(0xff, 0x0f);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain('require("bit").band');
      expect(normalized).not.toMatch(HOIST_PATTERN);
    });

    it("does not hoist a bare require pattern that appears only once", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const bit = require("bit") as any;

          /** @inline */
          export function getBit(): any {
            return bit;
          }
        `,
        "main.ts": `
          import { getBit } from "./utils";
          export const lib = getBit();
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain('require("bit")');
      expect(normalized).not.toMatch(/local ____req_bit\b[^\s=]* = require\("bit"\)\s*\n/);
    });
  });

  describe("module-scope dedup", () => {
    it("hoists require pattern used 2+ times at module scope (top-level statements)", () => {
      // Two top-level call sites both expand to require("bit").band after inlining.
      // hoist-require should produce a single hoisted local at the top of the file.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";
          declare const x: number;
          declare const y: number;
          export const a = maskBits(x, y);
          export const b = maskBits(a, y);
        `),
      );

      expect(diagnostics).toHaveLength(0);
      assertBitBandHoisted(normalizeLua(lua));
    });
  });

  describe("bare require dedup", () => {
    it("hoists bare require('path') used 2+ times into a single local", () => {
      // Two separate @inline call sites each produce one bare require("transform").
      // The inline rule deduplicates within each individual inlined body, but cannot
      // see across call sites. hoist-require in refold sees both occurrences and
      // deduplicates them into a single hoisted local.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "transform.ts": "export declare function transform(x: number): number;",
        "utils.ts": `
          ${REQUIRE_DECL}
          const transform = require("transform") as (x: number) => number;

          /** @inline */
          export const applyOnce = (x: number): number => transform(x);

          /** @inline */
          export const applyTwice = (x: number): number => transform(transform(x));
        `,
        "main.ts": `
          import { applyOnce, applyTwice } from "./utils";
          export function run(x: number): number {
            const a = applyOnce(x);
            const b = applyTwice(a);
            return a + b;
          }
        `,
      });

      expect(diagnostics).toHaveLength(0);
      assertRequireHoisted(normalizeLua(lua), /require\("transform"\)/g);
    });

    it("leaves single-occurrence member require inline when bare require is also hoisted", () => {
      // Two separate @inline call sites each produce one bare require("transform"),
      // and a third call site produces require("bit").band exactly once.
      // The bare pattern gets hoisted; the single member pattern stays inline.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "transform.ts": "export declare function transform(x: number): number;",
        "utils.ts": `
          ${REQUIRE_DECL}
          const transform = require("transform") as (x: number) => number;
          const band = (require("bit") as any).band;

          /** @inline */
          export const applyTransform = (x: number): number => transform(x);

          /** @inline */
          export const applyTransform2 = (x: number): number => transform(x + 1);

          /** @inline */
          export const maskOnce = (a: number, b: number): number => band(a, b);
        `,
        "main.ts": `
          import { applyTransform, applyTransform2, maskOnce } from "./utils";
          export function run(x: number, y: number): number {
            const a = applyTransform(x);
            const b = applyTransform2(a);
            const c = maskOnce(b, y);
            return c;
          }
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      // Bare require("transform") hoisted (2 call sites)
      expect(normalized).toMatch(/local ____req_transform\w* = require\("transform"\)/);

      // Member require("bit").band appears once → NOT hoisted, stays inline
      expect(normalized).toContain('require("bit").band');
      expect(normalized).not.toMatch(HOIST_PATTERN);
    });
  });

  describe("cross-call-site dedup", () => {
    it.each([
      {
        name: "two call sites inside a function",
        mainTs: `
          import { maskBits } from "./helper";

          export function compute(x: number, y: number, z: number): number {
            const first = maskBits(x, y);
            const second = maskBits(first, z);
            return first + second;
          }
        `,
      },
      {
        name: "two call sites at module scope",
        mainTs: `
          import { maskBits } from "./helper";
          declare const x: number;
          declare const y: number;
          export const a = maskBits(x, y);
          export const b = maskBits(a, y);
        `,
      },
    ])("hoists require pattern shared by two separate @inline call sites ($name)", ({ mainTs }) => {
      // Two separate expression-body @inline call sites both produce require("bit").band
      // after the inline phase. hoist-require in refold must deduplicate them into a
      // single hoisted local.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(makeBitAndFiles(mainTs));

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).not.toContain("maskBits(");
      assertBitBandHoisted(normalized);
    });

    it("does not hoist when only one @inline call site produces the require chain", () => {
      // Only one call site in the function body — no deduplication needed.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";

          export function compute(x: number, y: number): number {
            return maskBits(x, y);
          }
        `),
      );

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain('require("bit").band');
      expect(normalized).not.toMatch(HOIST_PATTERN);
    });
  });
});
