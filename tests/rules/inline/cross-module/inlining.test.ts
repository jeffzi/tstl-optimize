import { describe, expect, it } from "vitest";
import { compileMultiFileWithDiagnostics, normalizeLua } from "../../../helpers";
import { CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC, hasDiagnosticCode } from "../helpers";

describe("cross-module inlining", () => {
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
    // `require` is a Lua built-in; declare it to satisfy the TypeScript type checker
    // in the virtual project. The "bit" module is a native Lua library that does not
    // exist as a TypeScript file — include a minimal stub so TSTL's module resolver
    // can find it without emitting broken output.
    const REQUIRE_DECL = "declare function require(path: string): any;";
    const BIT_STUB = "export declare const band: (a: number, b: number) => number;";

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
