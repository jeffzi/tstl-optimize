import { describe, expect, it } from "vitest";
import { compileMultiFileWithDiagnostics, normalizeLua } from "../../../helpers";
import { hasDiagnosticCode } from "../helpers";

describe("cross-module const literal inlining", () => {
  describe("when substituting literals inside rewritten bodies", () => {
    it("substitutes exported const literals inside compound expressions", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "shared.ts": `
          export const OFFSET = 42;

          /** @inline */
          export function addOffset(value: number): number {
            return value + OFFSET;
          }
        `,
        "main.ts": `
          import { addOffset } from "./shared";

          export const result = addOffset(1);
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("(43)");
      expect(normalized).not.toContain("addOffset(1)");
    });

    it("substitutes exported const literals through imported aliases", () => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics({
        "constants.ts": `
          export const VALUE = 7;
        `,
        "shared.ts": `
          import { VALUE } from "./constants";

          /** @inline */
          export function readValue(): number {
            return VALUE;
          }
        `,
        "main.ts": `
          import { readValue } from "./shared";

          export const result = readValue();
        `,
      });

      expect(diagnostics).toHaveLength(0);
      const normalized = normalizeLua(lua);
      expect(normalized).toContain("7");
      expect(normalized).not.toContain("readValue()");
    });
  });

  describe("when inlining primitive const literals", () => {
    it.each<{ constVal: string; assertion: string; varName: string; returnType: string }>([
      { constVal: "42", assertion: "42", varName: "MAX", returnType: "number" },
      { constVal: '"Alice"', assertion: '"Alice"', varName: "NAME", returnType: "string" },
      { constVal: "true", assertion: "true", varName: "FLAG", returnType: "boolean" },
      { constVal: "-1", assertion: "-1", varName: "OFFSET", returnType: "number" },
    ])("$varName = $constVal inlines without diagnostic 90003", ({
      constVal,
      assertion,
      varName,
      returnType,
    }) => {
      const files = {
        "utils.ts": `
            export const ${varName} = ${constVal};

            /** @inline */
            export function get${varName}(): ${returnType} {
              return ${varName};
            }
          `,
        "main.ts": `
            import { get${varName} } from "./utils";
            const r = get${varName}();
          `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain(assertion);
    });
  });

  describe("when const has type assertion", () => {
    it("inlines hex literal with type assertion", () => {
      const files = {
        "utils.ts": `
          export const MASK = 0xff as number;

          /** @inline */
          export function getMask(): number {
            return MASK;
          }
        `,
        "main.ts": `
          import { getMask } from "./utils";
          const m = getMask();
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain("255");
    });
  });

  describe("when body has blocking references", () => {
    it("emits diagnostic 90003 when body mixes const literal and non-const function call", () => {
      const files = {
        "utils.ts": `
          export const X = 10;
          export function helper() { return 1; }

          /** @inline */
          export function usesBoth(): number {
            return X + helper();
          }
        `,
        "main.ts": `
          import { usesBoth } from "./utils";
          const r = usesBoth();
        `,
      };

      const { diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(true);
      expect(
        diagnostics.some((d) =>
          String(d.messageText).includes(
            "cross-module function references non-parameter identifiers",
          ),
        ),
      ).toBe(true);
    });

    it.each<{ name: string; files: Record<string, string>; preservedCall: string }>([
      {
        name: "the exported const is the receiver of a property access",
        files: {
          "utils.ts": `
            export const NAME = "Alice";

            /** @inline */
            export function getLength(): number {
              return NAME.length;
            }
          `,
          "main.ts": `
            import { getLength } from "./utils";

            export const result = getLength();
          `,
        },
        preservedCall: "____exports.result = getLength()",
      },
      {
        name: "the exported const is the receiver of a method call",
        files: {
          "utils.ts": `
            export const FLAG = true;

            /** @inline */
            export function describeFlag(): string {
              return FLAG.toString();
            }
          `,
          "main.ts": `
            import { describeFlag } from "./utils";

            export const result = describeFlag();
          `,
        },
        preservedCall: "____exports.result = describeFlag()",
      },
    ])("emits diagnostic 90003 when $name", ({ files, preservedCall }) => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(true);
      expect(normalizeLua(lua)).toContain(preservedCall);
    });

    it("emits diagnostic 90003 when an exported const is used as an element-access index", () => {
      const files = {
        "utils.ts": `
          export const OFFSET = 1;

          /** @inline */
          export function readAt(values: number[]): number {
            return values[OFFSET];
          }
        `,
        "main.ts": `
          import { readAt } from "./utils";

          const values = [10, 20, 30];
          const result = readAt(values);
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(true);
      expect(normalizeLua(lua)).toContain("readAt(values)");
    });
  });

  describe("when const is not a primitive literal", () => {
    it.each<{ name: string; files: Record<string, string> }>([
      {
        name: "function call result",
        files: {
          "utils.ts": `
            function compute() { return 42; }
            export const X = compute();

            /** @inline */
            export function useX(): number {
              return X;
            }
          `,
          "main.ts": `
            import { useX } from "./utils";
            const r = useX();
          `,
        },
      },
      {
        name: "object literal",
        files: {
          "utils.ts": `
            export const OBJ = { x: 1 };

            /** @inline */
            export function useObj(): number {
              return OBJ.x;
            }
          `,
          "main.ts": `
            import { useObj } from "./utils";
            const r = useObj();
          `,
        },
      },
    ])("emits diagnostic 90003 when const is $name", ({ files }) => {
      const { diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(true);
    });
  });

  describe("when function and const are in same module", () => {
    it("inlines without emitting diagnostic 90003", () => {
      const code = `
        const MAX = 42;

        /** @inline */
        function getMax(): number {
          return MAX;
        }

        function test() {
          const r = getMax();
        }
      `;

      const { lua, diagnostics } = compileMultiFileWithDiagnostics({
        "main.ts": code,
      });

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalizeLua(lua)).toContain("42");
    });
  });

  describe("when body references multiple consts", () => {
    it("inlines a primitive const exported from a multi-declaration export list", () => {
      const files = {
        "utils.ts": `
          const A = 1, B = 2;
          export { B };

          /** @inline */
          export function getB(): number {
            return B;
          }
        `,
        "main.ts": `
          import { getB } from "./utils";
          const r = getB();
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain("2");
      expect(normalized).not.toContain("getB()");
    });

    it("inlines when all referenced consts are primitives", () => {
      const files = {
        "utils.ts": `
          export const A = 1;
          export const B = "hello";
          export const C = true;

          /** @inline */
          export function combine(): string {
            return A + B + C;
          }
        `,
        "main.ts": `
          import { combine } from "./utils";
          const r = combine();
        `,
      };

      const { diagnostics, lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).not.toContain("combine()");
      expect(normalized).toContain("1");
      expect(normalized).toContain('"hello"');
      expect(normalized).toContain("true");
    });
  });

  describe("when a shorthand object property references a substituted const", () => {
    it("emits an explicit property assignment with the literal value", () => {
      const files = {
        "utils.ts": `
          export const X = 10;

          /** @inline */
          export function getObject(): { X: number } {
            return { X };
          }
        `,
        "main.ts": `
          import { getObject } from "./utils";
          const result = getObject();
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain("{X = 10}");
      expect(normalized).not.toContain("____exports.X");
    });
  });

  describe("when object literal properties reference substituted consts", () => {
    it.each<{
      expectedLua: string;
      files: Record<string, string>;
      removedCall: string;
      name: string;
    }>([
      {
        name: "computed property name",
        expectedLua: "____exports.result = {x = 3}",
        removedCall: "buildObject(3)",
        files: {
          "shared.ts": `
            export const KEY = "x";

            /** @inline */
            export function buildObject(value: number): object {
              return { [KEY]: value };
            }
          `,
          "main.ts": `
            import { buildObject } from "./shared";

            export const result = buildObject(3);
          `,
        },
      },
      {
        name: "property assignment initializer",
        expectedLua: "____exports.result = {value = 10}",
        removedCall: "buildObject()",
        files: {
          "shared.ts": `
            export const LIMIT = 10;

            /** @inline */
            export function buildObject(): object {
              return { value: LIMIT };
            }
          `,
          "main.ts": `
            import { buildObject } from "./shared";

            export const result = buildObject();
          `,
        },
      },
    ])("inlines $name", ({ expectedLua, files, removedCall }) => {
      const { diagnostics, lua } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain(expectedLua);
      expect(normalized).not.toContain(removedCall);
    });
  });

  describe("when a LuaMultiReturn inline path references a substituted const", () => {
    it("emits the literal at cross-module return sites", () => {
      const files = {
        "utils.ts": `
          export const X = 10;

          /** @inline */
          export function pair(value: number): LuaMultiReturn<[number, number]> {
            return $multi(X, value);
          }
        `,
        "main.ts": `
          import { pair } from "./utils";

          export function usePair(value: number): LuaMultiReturn<[number, number]> {
            return pair(value);
          }
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toMatch(/return 10, (value|____inline_arg_0)/);
      expect(normalized).not.toContain("____exports.X");
    });

    it("emits the literal at cross-module destructuring sites", () => {
      const files = {
        "utils.ts": `
          export const X = 10;

          /** @inline */
          export function pair(value: number): LuaMultiReturn<[number, number]> {
            return $multi(X, value);
          }
        `,
        "main.ts": `
          import { pair } from "./utils";

          declare const input: number;
          const [left, right] = pair(input);
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain("10");
      expect(normalized).not.toContain("____exports.X");
    });
  });

  describe("when const is zero or negative zero", () => {
    it.each<{ constVal: string; assertion: string }>([
      { constVal: "0", assertion: "0" },
      { constVal: "-0", assertion: "-0" },
    ])("inlines $constVal", ({ constVal, assertion }) => {
      const files = {
        "utils.ts": `
          export const ZERO = ${constVal};

          /** @inline */
          export function getZero(): number {
            return ZERO;
          }
        `,
        "main.ts": `
          import { getZero } from "./utils";
          const z = getZero();
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalizeLua(lua)).toContain(assertion);
    });
  });

  describe("when const is imported from another module", () => {
    it("inlines through imported const", () => {
      const files = {
        "constants.ts": `
          export const VALUE = 42;
        `,
        "utils.ts": `
          import { VALUE } from "./constants";

          /** @inline */
          export function getValue(): number {
            return VALUE;
          }
        `,
        "main.ts": `
          import { getValue } from "./utils";
          const v = getValue();
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalizeLua(lua)).toContain("42");
    });
  });

  describe("when const is not exported", () => {
    it("emits diagnostic 90003", () => {
      const files = {
        "utils.ts": `
          const PRIVATE = 42;

          /** @inline */
          export function getPrivate(): number {
            return PRIVATE;
          }
        `,
        "main.ts": `
          import { getPrivate } from "./utils";
          const v = getPrivate();
        `,
      };

      const { diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(true);
    });
  });

  describe("when function body has multiple statements", () => {
    it.each<{ name: string; files: Record<string, string>; assertion: string }>([
      {
        name: "number-returning",
        assertion: "3",
        files: {
          "utils.ts": `
            export const MULTIPLIER = 3;

            /** @inline */
            export function triple(x: number): number {
              const z = x * MULTIPLIER;
              return z;
            }
          `,
          "main.ts": `
            import { triple } from "./utils";
            const r = triple(5);
          `,
        },
      },
      {
        name: "void",
        assertion: "0",
        files: {
          "utils.ts": `
            export const INIT = 0;

            /** @inline */
            export function reset(obj: { count: number }): void {
              obj.count = INIT;
            }
          `,
          "main.ts": `
            import { reset } from "./utils";
            const o = { count: 5 };
            reset(o);
          `,
        },
      },
    ])("inlines $name function with const reference", ({ files, assertion }) => {
      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
      const normalized = normalizeLua(lua);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalized).toContain(assertion);
    });
  });

  describe("when const is empty string", () => {
    it("inlines empty string const literal", () => {
      const files = {
        "utils.ts": `
          export const EMPTY = "";

          /** @inline */
          export function getEmpty(): string {
            return EMPTY;
          }
        `,
        "main.ts": `
          import { getEmpty } from "./utils";
          const e = getEmpty();
        `,
      };

      const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, 90003)).toBe(false);
      expect(normalizeLua(lua)).toContain('""');
    });
  });
});
