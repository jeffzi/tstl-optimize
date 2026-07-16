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

    it("does not hoist when the rule is disabled via config", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        {
          "bit.ts": BIT_STUB,
          "main.ts": `
            ${REQUIRE_DECL}
            export const a = (require("bit") as any).band;
            export const b = (require("bit") as any).band;
          `,
        },
        { pluginOptions: { rules: { "hoist-require": false } } },
      );

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).not.toContain("____req_");
      expect((normalized.match(/require\("bit"\)\.band/g) ?? []).length).toBe(2);
    });

    it("sanitizes special characters in the member name of the hoisted local", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "main.ts": `
          ${REQUIRE_DECL}
          export const a = (require("bit") as any)["band-x"];
          export const b = (require("bit") as any)["band-x"];
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain('local ____req_bit_band_x = require("bit")["band-x"]');
      expect(normalized).toContain("____exports.a = ____req_bit_band_x");
    });

    it("does not combine occurrence counts across scopes (one per scope stays inline)", () => {
      // The pattern appears once at module scope and once inside a function body —
      // each scope sees a single occurrence, so neither reaches the dedup threshold.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "main.ts": `
          ${REQUIRE_DECL}
          export function f(): any { return (require("bit") as any).band; }
          export const a = (require("bit") as any).band;
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).not.toContain("____req_");
      expect((normalized.match(/require\("bit"\)\.band/g) ?? []).length).toBe(2);
    });

    it("hoists distinct members of the same module into distinct locals", () => {
      // The dedup cache key must include the member name: band and bor come from
      // the same module but must not share a hoisted local.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "main.ts": `
          ${REQUIRE_DECL}
          export const a = (require("bit") as any).band;
          export const b = (require("bit") as any).bor;
          export const c = (require("bit") as any).band;
          export const d = (require("bit") as any).bor;
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain('local ____req_bit_band = require("bit").band');
      expect(normalized).toContain('local ____req_bit_bor = require("bit").bor');
      expect(normalized).toContain("____exports.a = ____req_bit_band");
      expect(normalized).toContain("____exports.b = ____req_bit_bor");
      // Each raw chain survives only in its own hoisted declaration.
      expect((normalized.match(/require\("bit"\)\.band/g) ?? []).length).toBe(1);
      expect((normalized.match(/require\("bit"\)\.bor/g) ?? []).length).toBe(1);
    });

    it("hoists bare require and member require of the same module into distinct locals", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "main.ts": `
          ${REQUIRE_DECL}
          export const a = require("bit") as any;
          export const b = require("bit") as any;
          export const c = (require("bit") as any).band;
          export const d = (require("bit") as any).band;
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toContain('local ____req_bit = require("bit")');
      expect(normalized).toContain('local ____req_bit_band = require("bit").band');
      expect(normalized).toContain("____exports.a = ____req_bit");
      expect(normalized).toContain("____exports.c = ____req_bit_band");
    });

    it("sanitizes special characters in the require path into a valid Lua local name", () => {
      // "@scope/pkg-name" contains @, /, and -, none of which are legal in a Lua
      // identifier. The generated local must be sanitized (the emitted Lua passes
      // the luac syntax check run by the compile helper).
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "@scope/pkg-name.ts": "export declare const x: number;",
        "main.ts": `
          ${REQUIRE_DECL}
          export const a = require("@scope/pkg-name") as any;
          export const b = require("@scope/pkg-name") as any;
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      expect(normalized).toMatch(/local ____req__scope_pkg_name = require\("@scope[./]pkg-name"\)/);
      expect(normalized).toContain("____exports.a = ____req__scope_pkg_name");
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

  describe("collision avoidance", () => {
    it("adds suffix to hoisted local when module-scope user local shadows the generated name", () => {
      // A user-declared local ____req_bit_band at module scope (whose only read is
      // constant-propagated away) must not collide with the hoisted require local.
      // The hoisted local gets a suffix: ____req_bit_band_1
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";

          // User local with the same name as the hoisted require local.
          // Its only read gets constant-propagated away, so it becomes dead code.
          const ____req_bit_band = 2;
          export const z = ____req_bit_band + 1;

          declare const x: number;
          declare const y: number;
          export const a = maskBits(x, y);
          export const b = maskBits(a, y);
        `),
      );

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      // The hoisted local should use a suffixed name to avoid collision
      expect(normalized).toMatch(/local ____req_bit_band_\d+ = require\("bit"\)\.band/);

      // Both call sites should reference the suffixed hoisted local
      const hoistMatch = normalized.match(/local (____req_bit_band_\d+) = require\("bit"\)\.band/);
      expect(hoistMatch).not.toBeNull();
      const hoistName = hoistMatch?.[1];
      if (hoistName) {
        const useCount = (normalized.match(new RegExp(`\\b${hoistName}\\b`, "g")) ?? []).length;
        expect(useCount).toBeGreaterThanOrEqual(3); // declaration + 2 call sites
      }
    });

    it("adds suffix to hoisted local when nested function declares a shadowing name", () => {
      // A user-declared local ____req_bit_band inside a nested function (with a
      // surviving use) must force the function-scope hoisted local onto a suffixed name.
      // Use an external parameter so the local can't be constant-propagated away.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";

          declare const x: number;
          declare const y: number;

          export function outer(externalValue: number): number {
            // Nested function declares a local that shadows the hoisted require local name.
            // Use it with an external value so constant-propagation can't optimize it away.
            const inner = (param: number): number => {
              const ____req_bit_band = param + externalValue;
              return ____req_bit_band * 2;
            };

            const a = maskBits(x, y);
            const b = maskBits(a, y);
            return a + b + inner(10);
          }

          export const result = outer(5);
        `),
      );

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      // Function-scope hoisted local must use a suffixed name to avoid collision
      // with the user's local declared in the nested function
      expect(normalized).toMatch(/local ____req_bit_band_\d+ = require\("bit"\)\.band/);

      // Both call sites should reference the suffixed hoisted local
      const hoistMatch = normalized.match(/local (____req_bit_band_\d+) = require\("bit"\)\.band/);
      expect(hoistMatch).not.toBeNull();
      const hoistName = hoistMatch?.[1];
      if (hoistName) {
        const useCount = (normalized.match(new RegExp(`\\b${hoistName}\\b`, "g")) ?? []).length;
        expect(useCount).toBeGreaterThanOrEqual(3); // declaration + 2 call sites
      }
    });

    it("adds suffix to hoisted local when for-loop control variable shadows the generated name", () => {
      // A for-of loop with control variable named ____req_bit_band must force
      // the hoisted local onto a suffixed name.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";

          declare const x: number;
          declare const y: number;

          export function process(): number {
            let result = 0;
            // for-of loop with control variable that shadows the hoisted require local name
            for (const ____req_bit_band of [1, 2, 3]) {
              result += ____req_bit_band;
            }

            const a = maskBits(x, y);
            const b = maskBits(a, y);
            return result + a + b;
          }
        `),
      );

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      // Function-scope hoisted local should use a suffixed name
      expect(normalized).toMatch(/local ____req_bit_band_\d+ = require\("bit"\)\.band/);

      // Both call sites should reference the suffixed hoisted local
      const hoistMatch = normalized.match(/local (____req_bit_band_\d+) = require\("bit"\)\.band/);
      expect(hoistMatch).not.toBeNull();
      const hoistName = hoistMatch?.[1];
      if (hoistName) {
        const useCount = (normalized.match(new RegExp(`\\b${hoistName}\\b`, "g")) ?? []).length;
        expect(useCount).toBeGreaterThanOrEqual(3); // declaration + 2 call sites
      }
    });

    it("regression: adds suffix when user local has surviving read at module scope", () => {
      // When a user declares a local with the name matching the hoisted require local,
      // and that local has a surviving read in an expression, the hoisted local must
      // get a suffix to avoid collision.
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(
        makeBitAndFiles(`
          import { maskBits } from "./helper";

          // User local with surviving read in an expression
          const userLocal = 10;
          const ____req_bit_band = userLocal + 1;

          declare const x: number;
          declare const y: number;
          export const a = maskBits(x, y);
          export const b = maskBits(a, y);
          export const z = ____req_bit_band;
        `),
      );

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);

      // The hoisted local should have a suffix to avoid collision with the user's local
      expect(normalized).toMatch(/local ____req_bit_band_\d+ = require\("bit"\)\.band/);

      // Both call sites should reference the suffixed hoisted local
      const hoistMatch = normalized.match(/local (____req_bit_band_\d+) = require\("bit"\)\.band/);
      expect(hoistMatch).not.toBeNull();
      const hoistName = hoistMatch?.[1];
      if (hoistName) {
        const useCount = (normalized.match(new RegExp(`\\b${hoistName}\\b`, "g")) ?? []).length;
        expect(useCount).toBeGreaterThanOrEqual(3); // declaration + 2 call sites
      }

      // The user's local should still be present (constant-propagation may fold the expression)
      expect(normalized).toContain("local ____req_bit_band = ");
    });
  });
});
