import { describe, expect, it } from "vitest";
import { compileMultiFileWithDiagnostics, normalizeLua } from "../../../helpers";
import { CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC, hasDiagnosticCode } from "../helpers";

describe("cross-module inlining", () => {
  // `require` is a Lua built-in; declare it to satisfy the TypeScript type checker
  // in the virtual project. The "bit" module is a native Lua library that does not
  // exist as a TypeScript file — include a minimal stub so TSTL's module resolver
  // can find it without emitting broken output.
  const REQUIRE_DECL = "declare function require(path: string): any;";
  const BIT_STUB = "export declare const band: (a: number, b: number) => number;";

  describe("when the target has no blocking module state", () => {
    it("inlines a function that only uses parameters and local temporaries", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "shared.ts": `
          /** @inline */
          export function offset(value: number): number {
            const next = value + 1;
            return next;
          }
        `,
        "main.ts": `
          import { offset } from "./shared";

          export const result = offset(3);
        `,
      });
      const normalized = normalizeLua(lua);

      expect(diagnostics).toHaveLength(0);
      expect(normalized).toMatch(/local next = (4|3 \+ 1|____inline_arg_\d+ \+ 1)/);
      expect(normalized).not.toContain("offset(3)");
    });

    it("inlines expression-bodied arrow multi-return functions", () => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "utils.ts": `
          /** @inline */
          export const swap = (a: number, b: number): LuaMultiReturn<[number, number]> =>
            $multi(b, a);
        `,
        "main.ts": `
          import { swap } from "./utils";

          declare const x: number;
          declare const y: number;
          const [p, q] = swap(x, y);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      expect(lua).not.toContain("swap(");
      expect(lua).toMatch(/local p, q = .*____inline_result_/);
    });

    it("ignores type-only references", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics(
        {
          "shared.ts": `
            export type Shared = { value: number };
            /** @inline */
            export function pickValue(input: Shared) {
              return input.value;
            }
          `,
          "main.ts": `
            import { pickValue, type Shared } from "./shared";
            declare const shared: Shared;
            export const result = pickValue(shared);
          `,
        },
        {},
      );

      expect(diagnostics).toHaveLength(0);
      expect(lua).toContain("shared.value");
    });

    it("inlines imported aliases that only reference local params through type assertions", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "shared.ts": `
          export type SharedNumber = number;

          /** @inline */
          export function identity(value: number): number {
            const typed = value as SharedNumber;
            return typed;
          }
        `,
        "main.ts": `
          import { identity as alias } from "./shared";

          export const result = alias(1);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      expect(normalizeLua(lua)).not.toContain("alias(1)");
    });

    it("inlines a function whose body uses an ambient global (Math.floor)", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "shared.ts": `
          /** @inline */
          export function floorIt(x: number): number {
            return Math.floor(x);
          }
        `,
        "main.ts": `
          import { floorIt } from "./shared";

          export const result = floorIt(3.7);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      expect(normalizeLua(lua)).not.toContain("floorIt(");
    });
  });

  describe("when the target closes over non-substitutable module state", () => {
    it.each<{
      expectedCall: string;
      files: Record<string, string>;
      name: string;
    }>([
      {
        name: "a return-site expression",
        expectedCall: "return multiply(3)",
        files: {
          "shared.ts": `
            let factor = 2;

            /** @inline */
            export function multiply(value: number): number {
              const result = value * factor;
              return result;
            }
          `,
          "main.ts": `
            import { multiply } from "./shared";

            export function test() {
              return multiply(3);
            }
          `,
        },
      },
      {
        name: "a variable initializer",
        expectedCall: "multiply(5)",
        files: {
          "utils.ts": `
            export let factor = 2;

            /** @inline */
            export function multiply(x: number): number {
              return x * factor;
            }
          `,
          "main.ts": `
            import { multiply } from "./utils";

            function test() {
              const result = multiply(5);
            }
          `,
        },
      },
      {
        name: "an imported binding inside the inline target",
        expectedCall: "multiply(5)",
        files: {
          "config.ts": `
            export let factor = 2;
          `,
          "utils.ts": `
            import { factor } from "./config";

            /** @inline */
            export function multiply(x: number): number {
              return x * factor;
            }
          `,
          "main.ts": `
            import { multiply } from "./utils";

            function test() {
              const result = multiply(5);
            }
          `,
        },
      },
      {
        name: "a statement-position call",
        expectedCall: "incrementAndLog()",
        files: {
          "store.ts": `
            let counter = 0;

            /** @inline */
            export
            function incrementAndLog(): void {
              counter++;
              const msg = "Count: " + counter;
            }
          `,
          "main.ts": `
            import { incrementAndLog } from "./store";

            function main() {
              incrementAndLog();
            }
          `,
        },
      },
      {
        name: "a statement-position call accessing imported module scope",
        expectedCall: "processValue(42)",
        files: {
          "config.ts": `
            export let debugMode = true;
          `,
          "utils.ts": `
            import { debugMode } from "./config";

            /** @inline */
            export
            function processValue(value: number): void {
              const x = value + 1;
              const y = debugMode ? x : 0;
            }
          `,
          "main.ts": `
            import { processValue } from "./utils";

            function main() {
              processValue(42);
            }
          `,
        },
      },
    ])("preserves $expectedCall for $name", ({ expectedCall, files }) => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics(files, {
        pluginOptions: { rules: { inline: { warnCrossModule: true } } },
      });

      expect(hasDiagnosticCode(diagnostics, CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC)).toBe(true);
      expect(normalizeLua(lua)).toContain(expectedCall);
    });
  });

  describe("when the target closes over require() bindings", () => {
    // Shared compat module: exports bit_and as a member require binding.
    // Used across the "consumer already imports" sub-suite to keep each test's
    // file map focused on what it actually exercises.
    const COMPAT_TS = `
      ${REQUIRE_DECL}
      export const bit_and = (require("bit") as any).band;
    `;

    it("substitutes a direct require with member access in the inlined body", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const band = (require("bit") as any).band;

          /** @inline */
          export function bitwiseAnd(a: number, b: number): number {
            return band(a, b);
          }
        `,
        "main.ts": `
          import { bitwiseAnd } from "./utils";
          export const result = bitwiseAnd(5, 3);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain('require("bit").band');
      expect(normalized).not.toContain("bitwiseAnd(");
    });

    it("substitutes a bare require (no member) in the inlined body", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const bit = require("bit") as any;

          /** @inline */
          export function getBitLib(): any {
            return bit;
          }
        `,
        "main.ts": `
          import { getBitLib } from "./utils";
          export const lib = getBitLib();
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain('require("bit")');
      expect(normalized).not.toContain("getBitLib(");
    });

    it("substitutes both a const literal and a require binding when both appear in the body", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const X = 42;
          const band = (require("bit") as any).band;

          /** @inline */
          export function maskWith42(a: number): number {
            return band(a, X);
          }
        `,
        "main.ts": `
          import { maskWith42 } from "./utils";
          export const result = maskWith42(255);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain('require("bit").band');
      expect(normalized).toContain("42");
      expect(normalized).not.toContain("maskWith42(");
    });

    it("inlines a multi-statement body that references a require binding", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const band = (require("bit") as any).band;

          /** @inline */
          export function mask(a: number, b: number): number {
            const masked = band(a, b);
            return masked;
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
      expect(normalized).not.toContain("mask(");
    });

    it("inlines an expression-bodied arrow function that references a require binding", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "utils.ts": `
          ${REQUIRE_DECL}
          const band = (require("bit") as any).band;

          /** @inline */
          export const bitwiseAnd = (a: number, b: number): number => band(a, b);
        `,
        "main.ts": `
          import { bitwiseAnd } from "./utils";
          export const result = bitwiseAnd(12, 10);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain('require("bit").band');
      expect(normalized).not.toContain("bitwiseAnd(");
    });

    describe("when the consumer already imports the same require binding", () => {
      it("reuses the consumer's existing local for a member require binding in an expression body", () => {
        // consumer imports bit_and from ./compat (and uses it directly so TSTL emits a local);
        // archetype also imports bit_and from ./compat and uses it in an @inline expression body —
        // the inlined body in main.lua should reference the consumer's existing bit_and local
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "compat.ts": COMPAT_TS,
          "archetype.ts": `
            import { bit_and } from "./compat";

            /** @inline */
            export const maskBits = (a: number, b: number): number => bit_and(a, b);
          `,
          "main.ts": `
            import { bit_and } from "./compat";
            import { maskBits } from "./archetype";
            // Use bit_and directly so TSTL emits a local for it (not just for maskBits)
            export const direct = bit_and(1, 2);
            export const result = maskBits(0xff, 0x0f);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Should use the consumer's existing bit_and local, not a fresh require chain
        expect(normalized).not.toContain('require("bit").band');
        expect(normalized).toContain("bit_and(");
        expect(normalized).not.toContain("maskBits(");
      });

      it("still emits require chain when consumer does NOT import the symbol", () => {
        // consumer does NOT import bit_and — fallback to synthesized require chain
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "compat.ts": COMPAT_TS,
          "archetype.ts": `
            import { bit_and } from "./compat";

            /** @inline */
            export const maskBits = (a: number, b: number): number => bit_and(a, b);
          `,
          "main.ts": `
            import { maskBits } from "./archetype";
            export const result = maskBits(0xff, 0x0f);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        expect(normalized).toContain('require("bit").band');
        expect(normalized).not.toContain("maskBits(");
      });

      it("reuses the consumer's existing local for a bare require binding in an expression body", () => {
        // consumer imports the whole module (no member) and uses it directly;
        // archetype uses the same binding @inline — inlined body reuses the consumer's local
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "compat.ts": `
            ${REQUIRE_DECL}
            export const bit = require("bit") as any;
          `,
          "archetype.ts": `
            import { bit } from "./compat";

            /** @inline */
            export const getBit = (): any => bit;
          `,
          "main.ts": `
            import { bit } from "./compat";
            import { getBit } from "./archetype";
            // Use bit directly so TSTL emits a local for it
            export const band = bit.band;
            export const result = getBit();
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Should use the consumer's existing bit local, not a fresh require("bit")
        expect(normalized).not.toContain('require("bit")');
        expect(normalized).toContain("bit");
        expect(normalized).not.toContain("getBit(");
      });

      it("reuses the consumer's existing local for a require binding in a multi-statement body", () => {
        // consumer imports bit_and from ./compat and uses it directly;
        // archetype uses bit_and in an @inline multi-statement (statements + return) body —
        // the inlined body in main.lua should reference the consumer's existing bit_and local,
        // not synthesize a fresh require("bit").band chain
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "compat.ts": COMPAT_TS,
          "archetype.ts": `
            import { bit_and } from "./compat";

            /** @inline */
            export function mask(a: number, b: number): number {
              const masked = bit_and(a, b);
              return masked;
            }
          `,
          "main.ts": `
            import { bit_and } from "./compat";
            import { mask } from "./archetype";
            // Use bit_and directly so TSTL emits a local for it
            export const direct = bit_and(1, 2);
            export const result = mask(0xff, 0x0f);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Should use the consumer's existing bit_and local, not a fresh require chain
        expect(normalized).not.toContain('require("bit").band');
        expect(normalized).toContain("bit_and(");
        expect(normalized).not.toContain("mask(");
      });

      it("reuses the consumer's existing local for a require binding in a void (do-end) inline body", () => {
        // consumer imports bit_and from ./compat and uses it directly;
        // archetype uses bit_and in an @inline void function (statement-level call) —
        // the inlined do..end block in main.lua should reference the consumer's bit_and local
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "compat.ts": COMPAT_TS,
          "archetype.ts": `
            import { bit_and } from "./compat";

            /** @inline */
            export function logMask(a: number, b: number): void {
              const masked = bit_and(a, b);
              const msg = "mask: " + masked;
            }
          `,
          "main.ts": `
            import { bit_and } from "./compat";
            import { logMask } from "./archetype";
            // Use bit_and directly so TSTL emits a local for it
            export const direct = bit_and(1, 2);
            export function run(): void {
              logMask(0xff, 0x0f);
            }
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Should use the consumer's existing bit_and local inside the do..end block
        expect(normalized).not.toContain('require("bit").band');
        expect(normalized).toContain("bit_and(");
        expect(normalized).not.toContain("logMask(");
      });
    });

    // Shared assertion helper: verifies that require("bit").band was hoisted into a single
    // named local (____req_* prefix) and that local is referenced at least at its declaration
    // plus two use sites. Pass the inlined function name to check it was eliminated.
    function assertRequireBandHoisted(normalized: string, inlinedFnName: string): void {
      const hoistedLocalMatch = normalized.match(/local (____req_\w+) = require\("bit"\)\.band/);
      expect(hoistedLocalMatch).not.toBeNull();
      const hoistedName = hoistedLocalMatch?.[1];
      // The require chain must appear ONLY in the hoisted declaration — never inline
      const requireOccurrences = (normalized.match(/require\("bit"\)\.band/g) ?? []).length;
      expect(requireOccurrences).toBe(1);
      // The hoisted local must appear at least 3 times: declaration + 2 call sites
      const useCount = (normalized.match(new RegExp(`\\b${hoistedName}\\b`, "g")) ?? []).length;
      expect(useCount).toBeGreaterThanOrEqual(3);
      expect(normalized).not.toContain(`${inlinedFnName}(`);
    }

    describe("when the inlined body uses the same require chain multiple times", () => {
      it("hoists a member require pattern used 2+ times into a single local in a return-value inline", () => {
        // main.ts does NOT import bit_and — consumer has no existing local to reuse.
        // The inlined body uses band(a, b) twice (via require("bit").band each time).
        // Expect ONE hoisted local for require("bit").band, referenced from both call sites.
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
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
            export const result = doubleMask(0xff, 0x0f);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        assertRequireBandHoisted(normalizeLua(lua), "doubleMask");
      });

      it("hoists a member require pattern used 2+ times into a single local in a do-end (void) inline", () => {
        // main.ts does NOT import bit_and — inlined void function uses band twice.
        // Expect one hoisted local in the do..end block.
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "utils.ts": `
            ${REQUIRE_DECL}
            const band = (require("bit") as any).band;

            /** @inline */
            export function logDouble(a: number, b: number): void {
              const first = band(a, b);
              const second = band(first, b);
              const msg = "results: " + first + ", " + second;
            }
          `,
          "main.ts": `
            import { logDouble } from "./utils";
            export function run(): void {
              logDouble(0xff, 0x0f);
            }
          `,
        });

        expect(diagnostics).toHaveLength(0);
        assertRequireBandHoisted(normalizeLua(lua), "logDouble");
      });

      it("does not hoist when the require pattern appears only once in a multi-statement body", () => {
        // body uses band exactly once — no hoisting, require("bit").band emitted inline
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "utils.ts": `
            ${REQUIRE_DECL}
            const band = (require("bit") as any).band;

            /** @inline */
            export function mask(a: number, b: number): number {
              const masked = band(a, b);
              return masked;
            }
          `,
          "main.ts": `
            import { mask } from "./utils";
            export const result = mask(0xff, 0x0f);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Single occurrence — must appear inline, no hoisted local
        expect(normalized).toContain('require("bit").band');
        expect(normalized).not.toMatch(/local ____req_\w+ = require\("bit"\)\.band/);
        expect(normalized).not.toContain("mask(");
      });

      it("hoists a bare require (no member) used 2+ times and leaves a single-occurrence member require inline", () => {
        // Body uses a bare require("transform") twice (no .member) and require("bit").band once.
        // The bare pattern gets hoisted; the member pattern stays inline (only 1 occurrence).
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "transform.ts": "export declare function transform(x: number): number;",
          "utils.ts": `
            ${REQUIRE_DECL}
            const transform = require("transform") as (x: number) => number;
            const band = (require("bit") as any).band;

            /** @inline */
            export function process(x: number, mask: number): number {
              const masked = band(x, mask);
              const a = transform(masked);
              const b = transform(a);
              return b;
            }
          `,
          "main.ts": `
            import { process } from "./utils";
            export const result = process(42, 0xff);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Bare require("transform") appears 2+ times → hoisted into a local
        const hoistedMatch = normalized.match(
          /local (____req_transform\w*) = require\("transform"\)/,
        );
        expect(hoistedMatch).not.toBeNull();
        const hoistedName = hoistedMatch?.[1];
        // Hoisted local used at declaration + 2 call sites
        const useCount = (normalized.match(new RegExp(`\\b${hoistedName}\\b`, "g")) ?? []).length;
        expect(useCount).toBeGreaterThanOrEqual(3);
        // Member require("bit").band appears once → NOT hoisted, left inline
        expect(normalized).toContain('require("bit").band');
        expect(normalized).not.toContain("process(");
      });

      it("does not hoist in an expression-body inline even when the require chain appears multiple times", () => {
        // Expression bodies have no statement context — no hoisting possible.
        // (A single-expression body cannot reference band twice in practice, but the
        //  rule must not crash when it's not invoked for expression bodies.)
        // Use a single-occurrence expression body to confirm the current emit is unchanged.
        const { diagnostics, lua } = compileMultiFileWithDiagnostics({
          "bit.ts": BIT_STUB,
          "utils.ts": `
            ${REQUIRE_DECL}
            const band = (require("bit") as any).band;

            /** @inline */
            export const bitwiseAnd = (a: number, b: number): number => band(a, b);
          `,
          "main.ts": `
            import { bitwiseAnd } from "./utils";
            export const result = bitwiseAnd(12, 10);
          `,
        });

        expect(diagnostics).toHaveLength(0);
        const normalized = normalizeLua(lua);
        // Expression body — require chain emitted directly, no hoisted local
        expect(normalized).toContain('require("bit").band');
        expect(normalized).not.toMatch(/local ____req_\w+ = require\("bit"\)\.band/);
        expect(normalized).not.toContain("bitwiseAnd(");
      });
    });
  });

  describe("regression: issue-2 reproduction", () => {
    it("three-module chain: consumer importing bit_and reuses its local inside inlined mask_satisfies body", () => {
      // Exact reproduction of the issue-2 scenario:
      //   compat.ts    — exports bit_and = require("bit").band
      //   archetype.ts — imports bit_and, exports @inline mask_satisfies using it
      //   main.ts      — imports BOTH bit_and (direct use) and mask_satisfies
      // The inlined body of mask_satisfies must reuse main's bit_and local,
      // not synthesise a fresh require("bit").band chain.
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "compat.ts": `
          ${REQUIRE_DECL}
          const lib = require("bit");
          export const bit_and = lib.band;
        `,
        "archetype.ts": `
          import { bit_and } from "./compat";

          /** @inline */
          export function mask_satisfies(mask: number, all_mask: number): boolean {
            return bit_and(mask, all_mask) === all_mask;
          }
        `,
        "main.ts": `
          import { bit_and } from "./compat";
          import { mask_satisfies } from "./archetype";

          export function check(mask: number, all_mask: number): boolean {
            return mask_satisfies(mask, all_mask) && bit_and(mask, 1) === 1;
          }
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      // Inlined body must reuse the consumer's bit_and local — no raw require chain
      expect(normalized).not.toContain('require("bit").band');
      // Consumer's local must be present in the output
      expect(normalized).toContain("bit_and(");
      // mask_satisfies call must have been inlined away
      expect(normalized).not.toContain("mask_satisfies(");
    });

    it("consumer without matching import: body using require binding twice gets a hoisted local", () => {
      // main.ts does NOT import bit_and itself, but calls an @inline function whose
      // multi-statement body references bit_and twice.
      // Expect the emitted Lua to hoist a single local for require("bit").band rather
      // than repeating the require chain at each call site.
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "bit.ts": BIT_STUB,
        "compat.ts": `
          ${REQUIRE_DECL}
          const lib = require("bit");
          export const bit_and = lib.band;
        `,
        "utils.ts": `
          import { bit_and } from "./compat";

          /** @inline */
          export function doubleBand(x: number, y: number, z: number): number {
            const a = bit_and(x, y);
            return bit_and(a, z);
          }
        `,
        "main.ts": `
          import { doubleBand } from "./utils";

          export function run(x: number, y: number, z: number): number {
            return doubleBand(x, y, z);
          }
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      // At most one require("bit").band occurrence — hoisted into a local, not repeated
      const requireOccurrences = (normalized.match(/require\("bit"\)\.band/g) ?? []).length;
      expect(requireOccurrences).toBeLessThanOrEqual(1);
      // The inline function call must have been eliminated
      expect(normalized).not.toContain("doubleBand(");
    });
  });

  describe("warnCrossModule", () => {
    const CROSS_MODULE_FILES = {
      "utils.ts": `
        let factor = 2;
        /** @inline */
        export function scale(value: number): number {
          return value * factor;
        }
      `,
      "main.ts": `
        import { scale } from "./utils";
        export const result = scale(7);
      `,
    };

    it("suppresses TS90003 by default when cross-module inline is rejected", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics(CROSS_MODULE_FILES);
      expect(diagnostics).toHaveLength(0);
      expect(normalizeLua(lua)).toContain("scale(7)");
    });

    it("emits TS90003 when warnCrossModule is true", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics(CROSS_MODULE_FILES, {
        pluginOptions: { rules: { inline: { warnCrossModule: true } } },
      });
      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(true);
      expect(normalizeLua(lua)).toContain("scale(7)");
    });
  });
});
