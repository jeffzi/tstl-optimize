import { describe, expect, it } from "vitest";
import { compileMultiFileWithDiagnostics, normalizeLua } from "../../../helpers";
import { hasDiagnosticCode } from "../helpers";

const CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC = 90003;

function compileMultiFile(files: Record<string, string>) {
  const { lua, diagnostics } = compileMultiFileWithDiagnostics(files);
  return { diagnostics, normalized: normalizeLua(lua) };
}

function compileAndExpectNoDiagnostics(files: Record<string, string>): string {
  const { diagnostics, normalized } = compileMultiFile(files);
  expect(diagnostics).toHaveLength(0);
  return normalized;
}

function compileAndExpectCrossModuleDiagnostic(files: Record<string, string>): string {
  const { diagnostics, normalized } = compileMultiFile(files);
  expect(hasDiagnosticCode(diagnostics, CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC)).toBe(true);
  return normalized;
}

describe("cross-module const literal inlining", () => {
  describe("when substituting literals inside rewritten bodies", () => {
    it("substitutes exported const literals inside compound expressions", () => {
      const normalized = compileAndExpectNoDiagnostics({
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

      expect(normalized).toContain("(43)");
      expect(normalized).not.toContain("addOffset(1)");
    });

    it("substitutes exported const literals through imported aliases", () => {
      const normalized = compileAndExpectNoDiagnostics({
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

      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
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

      expect(hasDiagnosticCode(diagnostics, CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC)).toBe(true);
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
      {
        name: "the exported const is the receiver of an element-access expression",
        files: {
          "utils.ts": `
            export const NAME = "Alice";

            /** @inline */
            export function getChar(): string {
              return NAME[0];
            }
          `,
          "main.ts": `
            import { getChar } from "./utils";

            export const result = getChar();
          `,
        },
        preservedCall: "____exports.result = getChar()",
      },
      {
        name: "the inline body reads an ambient global that the call site shadows",
        files: {
          "globals.d.ts": `
            declare const GLOBAL_VALUE: number;
          `,
          "utils.ts": `
            /** @inline */
            export function readGlobal(): number {
              return GLOBAL_VALUE;
            }
          `,
          "main.ts": `
            import { readGlobal } from "./utils";

            const GLOBAL_VALUE = 1;
            export const result = readGlobal();
          `,
        },
        preservedCall: "____exports.result = readGlobal()",
      },
      {
        name: "the inline body reads an ambient global shadowed by a local function",
        files: {
          "globals.d.ts": `
            declare const GLOBAL_VALUE: number;
          `,
          "utils.ts": `
            /** @inline */
            export function readGlobal(): number {
              return GLOBAL_VALUE;
            }
          `,
          "main.ts": `
            import { readGlobal } from "./utils";

            function GLOBAL_VALUE(): number {
              return 1;
            }
            export const result = readGlobal();
          `,
        },
        preservedCall: "____exports.result = readGlobal()",
      },
      {
        name: "the inline body reads an ambient global shadowed by an import alias",
        files: {
          "globals.d.ts": `
            declare const GLOBAL_VALUE: number;
          `,
          "shadow.ts": `
            export const localValue = 1;
          `,
          "utils.ts": `
            /** @inline */
            export function readGlobal(): number {
              return GLOBAL_VALUE;
            }
          `,
          "main.ts": `
            import { localValue as GLOBAL_VALUE } from "./shadow";
            import { readGlobal } from "./utils";

            export const result = readGlobal();
          `,
        },
        preservedCall: "____exports.result = readGlobal()",
      },
      {
        name: "the inline body reads an ambient global shadowed by a class",
        files: {
          "globals.d.ts": `
            declare const GLOBAL_VALUE: number;
          `,
          "utils.ts": `
            /** @inline */
            export function readGlobal(): number {
              return GLOBAL_VALUE;
            }
          `,
          "main.ts": `
            import { readGlobal } from "./utils";

            class GLOBAL_VALUE {}
            export const result = readGlobal();
          `,
        },
        preservedCall: "____exports.result = readGlobal()",
      },
      {
        name: "the inline body reads an ambient global shadowed by an enum",
        files: {
          "globals.d.ts": `
            declare const GLOBAL_VALUE: number;
          `,
          "utils.ts": `
            /** @inline */
            export function readGlobal(): number {
              return GLOBAL_VALUE;
            }
          `,
          "main.ts": `
            import { readGlobal } from "./utils";

            enum GLOBAL_VALUE {
              Local = 1,
            }
            export const result = readGlobal();
          `,
        },
        preservedCall: "____exports.result = readGlobal()",
      },
      {
        name: "the inline body reads an ambient global shadowed by a namespace",
        files: {
          "globals.d.ts": `
            declare const GLOBAL_VALUE: number;
          `,
          "utils.ts": `
            /** @inline */
            export function readGlobal(): number {
              return GLOBAL_VALUE;
            }
          `,
          "main.ts": `
            import { readGlobal } from "./utils";

            namespace GLOBAL_VALUE {
              export const local = 1;
            }
            export const result = readGlobal();
          `,
        },
        preservedCall: "____exports.result = readGlobal()",
      },
      {
        name: "the inline body reads declarationless runtime arguments",
        files: {
          "utils.ts": `
            /** @inline */
            export function argumentCount(): number {
              return arguments.length;
            }
          `,
          "main.ts": `
            import { argumentCount } from "./utils";

            export const result = argumentCount();
          `,
        },
        preservedCall: "____exports.result = argumentCount()",
      },
    ])("emits diagnostic 90003 when $name", ({ files, preservedCall }) => {
      const normalized = compileAndExpectCrossModuleDiagnostic(files);
      expect(normalized).toContain(preservedCall);
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

      const normalized = compileAndExpectCrossModuleDiagnostic(files);
      expect(normalized).toContain("readAt(values)");
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

      expect(hasDiagnosticCode(diagnostics, CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC)).toBe(true);
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

      const normalized = compileAndExpectNoDiagnostics({
        "main.ts": code,
      });

      expect(normalized).toContain("42");
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

      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
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
      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain(assertion);
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

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("42");
    });
  });

  describe("when const is not exported", () => {
    it("substitutes non-exported const literal and inlines successfully", () => {
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

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("42");
      expect(normalized).not.toContain("getPrivate(");
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
      const normalized = compileAndExpectNoDiagnostics(files);
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

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain('""');
    });
  });

  describe("when const is a computed expression", () => {
    it("inlines simple computed const (power operation)", () => {
      const files = {
        "shared.ts": `
          const BITS = 24;
          export const MAX = 2 ** BITS;

          /** @inline */
          export function scale(x: number): number {
            return x * MAX;
          }
        `,
        "main.ts": `
          import { scale } from "./shared";
          export const result = scale(3);
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("50331648");
    });

    it("inlines chained computed consts", () => {
      const files = {
        "shared.ts": `
          const A = 2;
          const B = A ** 3;
          export const C = B * 2;

          /** @inline */
          export function apply(x: number): number {
            return x + C;
          }
        `,
        "main.ts": `
          import { apply } from "./shared";
          export const result = apply(1);
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("17");
    });

    it("emits diagnostic 90003 when mixed computed const and blocking refs", () => {
      const files = {
        "shared.ts": `
          const BITS = 8;
          export const MAX = 2 ** BITS;
          export function helper(): number {
            return 1;
          }

          /** @inline */
          export function mixed(): number {
            return MAX + helper();
          }
        `,
        "main.ts": `
          import { mixed } from "./shared";
          const r = mixed();
        `,
      };

      const { diagnostics } = compileMultiFileWithDiagnostics(files);

      expect(hasDiagnosticCode(diagnostics, CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC)).toBe(true);
    });

    it("inlines computed const through import alias", () => {
      const files = {
        "constants.ts": `
          const BASE = 255;
          export const MULTIPLIER = BASE * 8;
        `,
        "shared.ts": `
          import { MULTIPLIER } from "./constants";

          /** @inline */
          export function scale(val: number): number {
            return val * MULTIPLIER;
          }
        `,
        "main.ts": `
          import { scale } from "./shared";
          export const result = scale(2);
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("4080");
    });

    it("inlines computed const whose initializer reads an imported const", () => {
      const files = {
        "constants.ts": `
          export const BASE = 255;
        `,
        "shared.ts": `
          import { BASE } from "./constants";
          export const MULTIPLIER = BASE * 8;

          /** @inline */
          export function scale(val: number): number {
            return val * MULTIPLIER;
          }
        `,
        "main.ts": `
          import { scale } from "./shared";
          export const result = scale(2);
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("4080");
    });
  });

  describe("when body references computed template literal const", () => {
    it("inlines simple computed template literal", () => {
      const files = {
        "utils.ts": `
          export const MAX = 2 ** 8;
          export const MSG = \`max: \${MAX - 1}\`;

          /** @inline */
          export function getMessage(): string {
            return MSG;
          }
        `,
        "main.ts": `
          import { getMessage } from "./utils";
          const m = getMessage();
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain('"max: 255"');
    });

    it("inlines OVERFLOW_MSG pattern with computed template literal and computed const", () => {
      const files = {
        "utils.ts": `
          const SAFE_BITS = 53;
          const GEN_BITS = 24;
          export const MAX_INDEX = 2 ** (SAFE_BITS - GEN_BITS);

          export const OVERFLOW_MSG = \`entity index overflow (max \${MAX_INDEX - 1} per world)\`;

          /** @inline */
          export function getConstraints(): { msg: string; limit: number } {
            return { msg: OVERFLOW_MSG, limit: MAX_INDEX };
          }
        `,
        "main.ts": `
          import { getConstraints } from "./utils";
          const c = getConstraints();
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain('"entity index overflow (max 536870911 per world)"');
      expect(normalized).toContain("536870912");
    });

    it("inlines cross-module function with non-exported same-file const literal", () => {
      const files = {
        "utils.ts": `
          const MSG = "boom";

          /** @inline */
          export function bang(): string {
            return MSG;
          }
        `,
        "main.ts": `
          import { bang } from "./utils";
          const m = bang();
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain('"boom"');
    });

    it("inlines cross-module function with non-exported computed const literal", () => {
      const files = {
        "utils.ts": `
          const BITS = 24;
          const MAX = 2 ** BITS;

          /** @inline */
          export function getMax(): number {
            return MAX;
          }
        `,
        "main.ts": `
          import { getMax } from "./utils";
          const m = getMax();
        `,
      };

      const normalized = compileAndExpectNoDiagnostics(files);
      expect(normalized).toContain("16777216");
    });
  });
});
