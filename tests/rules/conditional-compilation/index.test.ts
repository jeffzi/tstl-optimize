import fc from "fast-check";
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: tstl has no default export
import * as tstl from "typescript-to-lua";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConditionalCompilationConfig } from "../../../src/config";
import { createVisitors, evaluateCondition } from "../../../src/rules/conditional-compilation";
import { arbSafeString } from "../../arbitraries";
import { compile, compileWithDiagnostics, normalizeLua } from "../../helpers";

// Lua global not in TypeScript's lib — declare it so TS does not error on test sources.
const PRINT_DECL = "declare function print(...args: unknown[]): void;";

function ccOpts(constants: Record<string, { env: string; default: boolean | number | string }>) {
  return {
    pluginOptions: {
      rules: { "constant-propagation": false, "conditional-compilation": { constants } },
    },
  };
}

function asTypeChecker(checker: Partial<ts.TypeChecker>): ts.TypeChecker {
  return checker as unknown as ts.TypeChecker;
}

function parseExpression(source: string): ts.Expression {
  const file = ts.createSourceFile(
    "expr.ts",
    `const value = ${source};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0];
  if (!ts.isVariableStatement(statement)) {
    throw new Error("Expected variable statement.");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) {
    throw new Error("Expected initializer expression.");
  }
  return initializer;
}

function parseIdentifierExpression(source: string): ts.Identifier {
  const expression = parseExpression(source);
  if (!ts.isIdentifier(expression)) {
    throw new Error("Expected identifier expression.");
  }
  return expression;
}

function parseVariableDeclaration(source: string): ts.VariableDeclaration {
  const file = ts.createSourceFile("decl.ts", source, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  if (!ts.isVariableStatement(statement)) {
    throw new Error("Expected variable statement.");
  }

  const declaration = statement.declarationList.declarations[0];
  if (!declaration) {
    throw new Error("Expected variable declaration.");
  }

  return declaration;
}

function parseSwitchStatement(source: string): ts.SwitchStatement {
  const file = ts.createSourceFile("switch.ts", source, ts.ScriptTarget.Latest, true);
  let switchStatement: ts.SwitchStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      switchStatement = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!switchStatement) {
    throw new Error("Expected switch statement.");
  }
  return switchStatement;
}

function expectBooleanLiteral(
  expression: tstl.Expression,
  expectedValue: boolean,
): asserts expression is tstl.BooleanLiteral {
  if (!tstl.isBooleanLiteral(expression)) {
    throw new Error("Expected boolean literal.");
  }

  expect(expression.kind).toBe(
    expectedValue ? tstl.SyntaxKind.TrueKeyword : tstl.SyntaxKind.FalseKeyword,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("evaluateCondition", () => {
  const constants = new Map<string, boolean | number | string>([
    ["FLAG", true],
    ["COUNT", 2],
    ["NAME", "web"],
  ]);

  it.each([
    { name: "identifier", source: "FLAG", expected: true },
    { name: "parenthesized identifier", source: "(FLAG)", expected: true },
    { name: "as-expression", source: "(FLAG as boolean)", expected: true },
    { name: "non-null assertion", source: "FLAG!", expected: true },
    { name: "type assertion", source: "<boolean>FLAG", expected: true },
    { name: "true literal", source: "true", expected: true },
    { name: "false literal", source: "false", expected: false },
    { name: "numeric literal", source: "2", expected: 2 },
    { name: "string literal", source: '"web"', expected: "web" },
    { name: "logical not", source: "!FLAG", expected: false },
    { name: "logical not of numeric truthy constant", source: "!COUNT", expected: false },
    { name: "numeric negation", source: "-COUNT", expected: -2 },
    { name: "logical and with truthy lhs", source: "FLAG && COUNT", expected: 2 },
    { name: "logical and with falsy lhs", source: "false && COUNT", expected: false },
    { name: "logical or with truthy lhs", source: "FLAG || UNKNOWN", expected: true },
    { name: "logical or with falsy lhs", source: '"" || NAME', expected: "web" },
    { name: "strict equality", source: 'NAME === "web"', expected: true },
    { name: "strict inequality", source: 'NAME !== "native"', expected: true },
    { name: "loose equality with same types", source: "COUNT == 2", expected: true },
    { name: "loose inequality with same types", source: "COUNT != 3", expected: true },
  ])("evaluates $name", ({ expected, source }) => {
    expect(evaluateCondition(parseExpression(source), constants)).toBe(expected);
  });

  it.each([
    { name: "unknown identifier", source: "UNKNOWN" },
    { name: "logical not of unknown identifier", source: "!UNKNOWN" },
    { name: "boolean negation of number", source: "-FLAG" },
    { name: "numeric negation of unknown identifier", source: "-UNKNOWN" },
    { name: "logical and with unknown lhs", source: "UNKNOWN && FLAG" },
    { name: "logical or with unknown lhs", source: "UNKNOWN || FLAG" },
    { name: "strict equality with unknown side", source: "UNKNOWN === FLAG" },
    { name: "loose equality across different types", source: 'COUNT == "2"' },
    { name: "loose equality with unknown side", source: "UNKNOWN == COUNT" },
    { name: "unhandled call expression", source: "foo()" },
  ])("returns undefined for $name", ({ source }) => {
    expect(evaluateCondition(parseExpression(source), constants)).toBeUndefined();
  });
});

describe("resolveConditionalCompilationConfig", () => {
  it.each([
    { name: "undefined", input: undefined },
    { name: "false", input: false as const },
    { name: "{ enabled: false }", input: { enabled: false, constants: {} } as const },
  ])("returns false for $name", ({ input }) => {
    expect(resolveConditionalCompilationConfig(input)).toBe(false);
  });

  it("returns empty map for boolean true", () => {
    expect(resolveConditionalCompilationConfig(true)).toStrictEqual(new Map());
  });

  it("resolves constants from environment or default", () => {
    vi.stubEnv("TEST_CC_BOOL_TRUE", "true");
    vi.stubEnv("TEST_CC_BOOL_ONE", "1");
    vi.stubEnv("TEST_CC_NUM", "42.5");
    vi.stubEnv("TEST_CC_NAN", "abc");
    vi.stubEnv("TEST_CC_STR", "HTML5");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: {
        A: { env: "TEST_CC_BOOL_TRUE", default: false },
        B: { env: "TEST_CC_BOOL_ONE", default: false },
        C: { env: "TEST_CC_BOOL_OTHER", default: true },
        D: { env: "TEST_CC_NUM", default: 0 },
        E: { env: "TEST_CC_NAN", default: 99 },
        F: { env: "TEST_CC_STR", default: "native" },
      },
    });

    expect(result).toStrictEqual(
      new Map<string, boolean | number | string>([
        ["A", true],
        ["B", true],
        ["C", true],
        ["D", 42.5],
        ["E", 99],
        ["F", "HTML5"],
      ]),
    );
  });

  it("falls back to the default when a numeric env constant is non-finite", () => {
    vi.stubEnv("TEST_CC_POS_INF", "Infinity");
    vi.stubEnv("TEST_CC_NEG_INF", "-Infinity");
    vi.stubEnv("TEST_CC_NAN_LITERAL", "NaN");

    const result = resolveConditionalCompilationConfig({
      enabled: true,
      constants: {
        POS_INF: { env: "TEST_CC_POS_INF", default: 10 },
        NEG_INF: { env: "TEST_CC_NEG_INF", default: -10 },
        NAN_LITERAL: { env: "TEST_CC_NAN_LITERAL", default: 99 },
      },
    });

    expect(result).toStrictEqual(
      new Map<string, boolean | number | string>([
        ["POS_INF", 10],
        ["NEG_INF", -10],
        ["NAN_LITERAL", 99],
      ]),
    );
  });
});

describe("conditional-compilation", () => {
  describe("when constant identifiers are replaced", () => {
    it("falls back to the configured default for non-finite env values", () => {
      vi.stubEnv("TEST_CC_LIMIT", "Infinity");

      const src = "declare const LIMIT: number; const x = LIMIT;";
      const lua = normalizeLua(
        compile(src, ccOpts({ LIMIT: { env: "TEST_CC_LIMIT", default: 7 } })),
      );

      expect(lua).toBe("x = 7");
    });
  });

  describe("when if-statement folding", () => {
    it.each([
      { name: "truthy", value: true, expected: "print(1)" },
      { name: "falsy", value: false, expected: "print(2)" },
    ])("folds if/else to $name branch", ({ value, expected }) => {
      const src = `${PRINT_DECL} declare const DEBUG: boolean; if (DEBUG) { print(1); } else { print(2); }`;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });

    it("strips if-statement without else when falsy", () => {
      const src = `${PRINT_DECL} declare const DEBUG: boolean; if (DEBUG) { print(1); } print(2);`;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: false } })));

      expect(lua).toBe("print(2)");
    });

    it("folds to matching else-if branch", () => {
      const src = `${PRINT_DECL} declare const PLATFORM: string; if (PLATFORM === "web") { print(1); } else if (PLATFORM === "native") { print(2); } else { print(3); }`;

      const lua = normalizeLua(compile(src, ccOpts({ PLATFORM: { env: "X", default: "native" } })));

      expect(lua).toBe("print(2)");
    });

    it("preserves block scope when folding to a kept block branch", () => {
      const src = `
        ${PRINT_DECL}
        declare const DEBUG: boolean;
        if (DEBUG) {
          const x = 1;
          print(x);
        }
        const x = 2;
        print(x);
      `;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: true } })));

      expect(lua).toBe("do\nlocal x = 1\nprint(x)\nend\nx = 2\nprint(x)");
    });

    it("drops the folded block wrapper when there are no following sibling statements", () => {
      const src = `
        ${PRINT_DECL}
        declare const DEBUG: boolean;
        if (DEBUG) {
          const x = 1;
          print(x);
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: true } })));

      expect(lua).toBe("x = 1\nprint(x)");
    });

    it("does not fold a function-local declaration that shadows a configured constant", () => {
      const src = `
        ${PRINT_DECL}
        declare const DEBUG: boolean;
        function test() {
          const DEBUG = false;
          if (DEBUG) {
            print(1);
          } else {
            print(2);
          }
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: true } })));

      expect(lua).toContain("if DEBUG then\nprint(1)\nelse\nprint(2)");
    });

    it("folds a top-level boolean const initializer instead of the configured fallback", () => {
      const src = `
        ${PRINT_DECL}
        const DEBUG = false;
        if (DEBUG) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: true } })));

      expect(lua).toBe("DEBUG = false\nprint(2)");
    });

    it("folds a top-level string const initializer instead of the configured fallback", () => {
      const src = `
        ${PRINT_DECL}
        const MODE = "native";
        if (MODE === "native") {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "web" } })));

      expect(lua).toBe('MODE = "native"\nprint(1)');
    });
  });

  describe("when ternary folding", () => {
    it.each([
      { name: "truthy", value: true, expected: "x = 1" },
      { name: "falsy", value: false, expected: "x = 2" },
    ])("folds ternary to $name branch", ({ value, expected }) => {
      const src = "declare const DEBUG: boolean; const x = DEBUG ? 1 : 2;";

      const lua = normalizeLua(compile(src, ccOpts({ DEBUG: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });
  });

  describe("when expression evaluation", () => {
    const opts = ccOpts({
      A: { env: "X", default: true },
      B: { env: "X", default: false },
      VAL: { env: "X", default: 42 },
      DEBUG: { env: "X", default: true },
    });

    it.each([
      {
        name: "logical AND with negation",
        src: `${PRINT_DECL} declare const A: boolean, B: boolean; if (A && !B) { print(1); }`,
        expected: "print(1)",
      },
      {
        name: "logical OR",
        src: `${PRINT_DECL} declare const A: boolean, B: boolean; if (A || B) { print(1); }`,
        expected: "print(1)",
      },
      {
        name: "numeric equality",
        src: `${PRINT_DECL} declare const VAL: number; if (VAL === 42) { print(1); }`,
        expected: "print(1)",
      },
      { name: "literal true", src: `${PRINT_DECL} if (true) { print(1); }`, expected: "print(1)" },
      { name: "literal false", src: `${PRINT_DECL} if (false) { print(1); }`, expected: "" },
      {
        name: "type assertion in parenthesized expression with OR",
        src: `${PRINT_DECL} declare const A: boolean, DEBUG: boolean; if ((A) || DEBUG) { print(1); }`,
        expected: "print(1)",
      },
    ])("folds $name condition", ({ src, expected }) => {
      expect(normalizeLua(compile(src, opts))).toBe(expected);
    });

    it.each([
      {
        name: "loose equality across number and string",
        src: `${PRINT_DECL} declare const VAL: number | string; if (VAL == "42") { print(1); } else { print(2); }`,
      },
      {
        name: "loose inequality across number and string",
        src: `${PRINT_DECL} declare const VAL: number | string; if (VAL != "42") { print(1); } else { print(2); }`,
      },
    ])("does not fold $name when coercion would matter", ({ src }) => {
      const lua = normalizeLua(compile(src, opts));

      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });
  });

  describe("when switch-statement folding", () => {
    const src = `
      ${PRINT_DECL}
      declare const P: string;
      switch (P) {
        case "a": print(1); break;
        case "b":
        case "c": print(2); break;
        default: print(3);
      }
    `;

    it.each([
      { name: "direct match", value: "a", expected: "print(1)" },
      { name: "fall-through match", value: "b", expected: "print(2)" },
      { name: "default", value: "z", expected: "print(3)" },
    ])("folds to $name case", ({ value, expected }) => {
      const lua = normalizeLua(compile(src, ccOpts({ P: { env: "X", default: value } })));

      expect(lua).toBe(expected);
    });
  });

  describe("when diagnostics", () => {
    const partialSrc = `${PRINT_DECL} declare const DEBUG: boolean, unknown: boolean; if (DEBUG && unknown) { print(1); }`;

    it("warns on partially resolvable conditions", () => {
      const { diagnostics } = compileWithDiagnostics(
        partialSrc,
        ccOpts({ DEBUG: { env: "X", default: true } }),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("could not be fully resolved");
    });

    it("promotes warning to error in strict mode", () => {
      const { pluginOptions } = ccOpts({ DEBUG: { env: "X", default: true } });
      const { diagnostics } = compileWithDiagnostics(partialSrc, {
        pluginOptions: { ...pluginOptions, strict: true },
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].category).toBe(ts.DiagnosticCategory.Error);
    });

    it("warns when a partially resolvable switch discriminant is preserved", () => {
      const switchSrc = `
        ${PRINT_DECL}
        declare const MODE: number;
        declare function foo(): number;
        switch (MODE + foo()) {
          case 1:
            print(1);
            break;
        }
      `;

      const { diagnostics, lua } = compileWithDiagnostics(
        switchSrc,
        ccOpts({ MODE: { env: "X", default: 1 } }),
      );

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].messageText).toContain("could not be fully resolved");
      expect(normalizeLua(lua)).toContain("1 + foo()");
    });
  });

  describe("when non-null and type assertions", () => {
    const opts = ccOpts({
      IS_DEBUG: { env: "X", default: true },
      IS_ENABLED: { env: "X", default: false },
    });

    it.each([
      {
        name: "non-null assertion on truthy constant",
        src: `${PRINT_DECL} declare const IS_DEBUG: boolean; if (IS_DEBUG!) { print(1); } else { print(2); }`,
        expected: "print(1)",
      },
      {
        name: "type assertion on truthy constant",
        src: `${PRINT_DECL} declare const IS_DEBUG: boolean; if (<any>IS_DEBUG) { print(1); } else { print(2); }`,
        expected: "print(1)",
      },
      {
        name: "parenthesized non-null assertion on falsy constant",
        src: `${PRINT_DECL} declare const IS_ENABLED: boolean; if ((IS_ENABLED!)) { print(1); } else { print(2); }`,
        expected: "print(2)",
      },
    ])("folds $name", ({ src, expected }) => {
      const lua = normalizeLua(compile(src, opts));

      expect(lua).toBe(expected);
    });
  });

  describe("when edge cases", () => {
    it("does not fold when rule is disabled", () => {
      const lua = compile(`${PRINT_DECL} if (true) { print(1); }`, {
        pluginOptions: { rules: { "conditional-compilation": false } },
      });
      expect(lua).toContain("if true then");
    });

    it("applies math-intrinsics then constant-folding inside the kept branch", () => {
      const lua = compile(
        `${PRINT_DECL} declare const DEBUG: boolean; if (DEBUG) { print(Math.floor(1.5)); }`,
        {
          pluginOptions: {
            rules: {
              "conditional-compilation": { constants: { DEBUG: { env: "X", default: true } } },
              "math-intrinsics": true,
            },
          },
        },
      );
      // math-intrinsics converts Math.floor(1.5) to 1.5 - 1.5 % 1,
      // then constant-folding reduces it to 1
      expect(normalizeLua(lua)).toBe("print(1)");
    });

    it("returns no visitors when the rule is disabled at creation time", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        asTypeChecker({}),
        { rules: { "conditional-compilation": false }, strict: false },
      ]);

      expect(visitors).toStrictEqual({});
    });
  });

  describe("when switch fallthrough with conditional breaks", () => {
    it("preserves fallthrough when break is conditional", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        declare const FLAG: boolean;
        switch (MODE) {
          case "a":
            print(1);
            if (FLAG) break;
          case "b":
            print(2);
            break;
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "a" } })));

      // When MODE="a" and the break is conditional (guarded by FLAG),
      // fallthrough should still happen to case b.
      // Both print(1) and print(2) should appear in the output.
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });

    it("halts fallthrough on unconditional break", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        switch (MODE) {
          case "a":
            print(1);
            break;
          case "b":
            print(2);
            break;
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "a" } })));

      // With an unconditional break after print(1), fallthrough should stop.
      // Only print(1) should appear.
      expect(lua).toBe("print(1)");
    });

    it("halts fallthrough on continue inside a loop", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        function run() {
          while (true) {
            switch (MODE) {
              case "a":
                print(1);
                continue;
              case "b":
                print(2);
                break;
            }
          }
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "a" } })));

      expect(lua).toContain("print(1)");
      expect(lua).not.toContain("print(2)");
    });

    it("preserves switch when stripping would expose a conditional bare break", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        declare const FLAG: boolean;
        switch (MODE) {
          case "a":
            if (FLAG) break;
            print(1);
            break;
          case "b":
            print(2);
            break;
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: "a" } })));

      expect(lua).toContain("repeat");
      expect(lua).toContain("until true");
      expect(lua).not.toBe("print(1)");
    });

    it.each([
      {
        body: `
            if (FLAG) {
              print(1);
            } else {
              break;
            }
            print(2);
        `,
        name: "an else branch",
        skipLuaCheck: false,
      },
      {
        body: `
            try {
              print(1);
            } catch {
              break;
            }
            print(2);
        `,
        name: "a catch block",
        // TSTL wraps catch bodies in `local function ____catch() ... end`, so a `break`
        // inside the catch ends up inside a function with no enclosing loop — invalid Lua.
        // This is a TSTL codegen limitation; the conditional-compilation rule under test
        // is correct (it preserves the switch as required).
        skipLuaCheck: true,
      },
      {
        body: `
            try {
              print(1);
            } finally {
              if (FLAG) {
                break;
              }
            }
            print(2);
        `,
        name: "a finally block",
        skipLuaCheck: false,
      },
    ])("preserves switch when a conditional case break appears in $name", ({
      body,
      skipLuaCheck,
    }) => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: string;
        declare const FLAG: boolean;
        switch (MODE) {
          case "a":
${body}
            break;
          case "b":
            print(3);
            break;
        }
      `;

      const lua = normalizeLua(
        compile(src, { ...ccOpts({ MODE: { env: "X", default: "a" } }), skipLuaCheck }),
      );

      expect(lua).toContain("repeat");
      expect(lua).toContain("until true");
      expect(lua).toContain("print(3)");
    });
  });

  describe("when switch case body in block", () => {
    it("strips break from case body wrapped in block", () => {
      const src = `
        ${PRINT_DECL}
        const MODE: 1 = 1;
        switch (MODE) {
          case 1: {
            print("body");
            break;
          }
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: 1 } })));

      // The block should be opened and statements executed, but no break
      expect(lua).toContain('print("body")');
      expect(lua).not.toContain("break");
    });

    it("preserves nested break inside for loop in case block", () => {
      const src = `
        ${PRINT_DECL}
        const MODE: 2 = 2;
        switch (MODE) {
          case 2: {
            for (let i = 0; i < 5; i++) {
              if (i === 3) break;
              print(i);
            }
            print("after loop");
            break;
          }
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: 2 } })));

      // The loop's break should be preserved
      expect(lua).toContain('print("after loop")');
      expect(lua).toContain("break");
    });

    it("preserves nested block scope when folding to a kept case block", () => {
      const src = `
        ${PRINT_DECL}
        declare const MODE: number;
        switch (MODE) {
          case 1: {
            const x = 1;
            print(x);
            break;
          }
        }
        const x = 2;
        print(x);
      `;

      const lua = normalizeLua(compile(src, ccOpts({ MODE: { env: "X", default: 1 } })));

      expect(lua).toBe("do\nlocal x = 1\nprint(x)\nend\nx = 2\nprint(x)");
    });
  });

  describe("when switch with unresolved cases", () => {
    it("preserves switch when an earlier unresolved case could shadow a later resolved match", () => {
      const src = `
        ${PRINT_DECL}
        declare const SWITCH_VAL: string;
        declare const CASE_UNRESOLVED: string;
        switch (SWITCH_VAL) {
          case CASE_UNRESOLVED:
            print(1);
            break;
          case "resolved":
            print(2);
            break;
          default:
            print(3);
        }
      `;

      const lua = normalizeLua(
        compile(src, ccOpts({ SWITCH_VAL: { env: "X", default: "resolved" } })),
      );

      // SWITCH_VAL is resolved to "resolved", but CASE_UNRESOLVED is unresolved and appears first.
      // It could still match at runtime, so folding to the later resolved case would skip the
      // earlier branch and change first-match switch semantics.
      expect(lua).toContain("repeat");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
      expect(lua).toContain("print(3)");
    });

    it("does not fold to default when unresolved case is present", () => {
      const src = `
        ${PRINT_DECL}
        declare const SWITCH_VAL: string;
        declare const CASE_UNRESOLVED: string;
        switch (SWITCH_VAL) {
          case CASE_UNRESOLVED:
            print(1);
            break;
          case "other":
            print(2);
            break;
          default:
            print(3);
        }
      `;

      const lua = normalizeLua(
        compile(src, ccOpts({ SWITCH_VAL: { env: "X", default: "nomatch" } })),
      );

      // SWITCH_VAL is resolved to "nomatch", which doesn't match "other".
      // But there's an unresolved case CASE_UNRESOLVED that might match at runtime.
      // So the switch must be preserved, not folded to default.
      expect(lua).toContain("repeat");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
      expect(lua).toContain("print(3)");
    });

    it("does not skip unresolved case when it could match the switch value", () => {
      const src = `
        ${PRINT_DECL}
        declare const SWITCH_VAL: string;
        declare const CASE_VALUE: string;
        switch (SWITCH_VAL) {
          case CASE_VALUE:
            print(1);
            break;
          default:
            print(2);
        }
      `;

      const lua = normalizeLua(compile(src, ccOpts({ SWITCH_VAL: { env: "X", default: "test" } })));

      // SWITCH_VAL is resolved to "test", but CASE_VALUE is unresolved.
      // We cannot statically determine if CASE_VALUE == "test", so we must preserve
      // the switch with the unresolved case, NOT fold to default.
      // The code should keep the switch structure intact.
      expect(lua).toContain("repeat");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });
  });

  describe("when unary minus operator", () => {
    it("folds negative numeric literal in equality check", () => {
      const src = `${PRINT_DECL} declare const CONST: number; if (CONST === -1) { print(1); } else { print(2); }`;

      const lua = normalizeLua(compile(src, ccOpts({ CONST: { env: "X", default: -1 } })));

      expect(lua).toBe("print(1)");
    });

    it("emits parenthesized negative constant in exponentiation expression", () => {
      const src =
        "function getExp(): number { return 2; } declare const K: number; const x = K ** getExp();";

      const lua = normalizeLua(compile(src, ccOpts({ K: { env: "X", default: -2 } })));

      // -2 ^ getExp() parses as -(2 ^ getExp()) in Lua, but we want (-2) ^ getExp()
      // Should emit (-2) to preserve operator precedence when parenthesized
      expect(lua).toContain("(-2)");
    });

    it("emits parenthesized negative constant in plain expression position", () => {
      const src = "declare const K: number; const x = K;";

      const lua = normalizeLua(compile(src, ccOpts({ K: { env: "X", default: -2 } })));

      // Negative constant should be parenthesized for consistency
      expect(lua).toContain("(-2)");
    });

    it("negates numeric constant with minus operator", () => {
      const src = `${PRINT_DECL} declare const FOO: number; if (-FOO === 5) { print(1); } else { print(2); }`;

      const lua = normalizeLua(compile(src, ccOpts({ FOO: { env: "X", default: -5 } })));

      expect(lua).toBe("print(1)");
    });

    it("does not fold negation of boolean constant", () => {
      const src = `${PRINT_DECL} declare const FLAG: boolean; if (-FLAG === -1) { print(1); } else { print(2); }`;

      const lua = normalizeLua(compile(src, ccOpts({ FLAG: { env: "X", default: true } })));

      // -FLAG is undefined (cannot negate a boolean), so the condition cannot be fully resolved
      // The if-statement should be preserved
      expect(lua).toContain("if");
    });
  });

  describe("when branch detection in nested control flow", () => {
    const opts = ccOpts({
      TRUE_CONST: { env: "TRUE_CONST", default: true },
      FALSE_CONST: { env: "FALSE_CONST", default: false },
      VAL_1: { env: "VAL_1", default: 1 },
    });

    it("preserves return inside a doubly-nested block when folding", () => {
      const code = `
        ${PRINT_DECL}
        function test() {
          if (true) {
            { return 1; }
          }
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("return 1");
    });

    it("preserves break inside a while loop with a nested block when folding", () => {
      const code = `
        ${PRINT_DECL}
        function test2() {
          while(true) {
            if (true) {
              { break; }
            }
          }
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("break");
    });

    it("folds constant inside parenthesized expression", () => {
      const code = `
        ${PRINT_DECL}
        declare const TRUE_CONST: boolean;
        if ((TRUE_CONST)) {
          print(1);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("print(1)");
      expect(lua).not.toContain("if");
    });

    it("preserves condition with non-constant expression kind", () => {
      const code = `
        declare function foo(): any;
        declare const TRUE_CONST: boolean;
        export const x = (foo() || { a: TRUE_CONST }) ? 1 : 2;
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("or 2");
    });

    it("does not fold a configured constant name when it is shadowed by a parameter", () => {
      const code = `
        ${PRINT_DECL}
        declare const TRUE_CONST: boolean;
        function run(TRUE_CONST: boolean) {
          if (TRUE_CONST) {
            print(1);
          } else {
            print(2);
          }
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("function run(");
      expect(lua).toContain("if");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });

    it("does not fold a configured constant name when it is shadowed by a top-level const", () => {
      const code = `
        ${PRINT_DECL}
        declare function readDebug(): boolean;
        const DEBUG = readDebug();
        if (DEBUG) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, ccOpts({ DEBUG: { env: "DEBUG", default: true } })));

      expect(lua).toContain("DEBUG = readDebug()");
      expect(lua).toContain("if DEBUG then");
      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
    });

    it("folds a configured constant name when a top-level const initializer is statically known", () => {
      const code = `
        ${PRINT_DECL}
        const TRUE_CONST = true;
        if (TRUE_CONST) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toBe("TRUE_CONST = true\nprint(1)");
    });

    it("folds a configured constant name when the top-level const initializer is wrapped in a type assertion", () => {
      const code = `
        ${PRINT_DECL}
        const TRUE_CONST = (true as boolean);
        if (TRUE_CONST) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toBe("TRUE_CONST = true\nprint(1)");
    });
  });

  describe("when partial folding output", () => {
    const opts = ccOpts({
      TRUE_CONST: { env: "TRUE_CONST", default: true },
      FALSE_CONST: { env: "FALSE_CONST", default: false },
      VAL_1: { env: "VAL_1", default: 1 },
    });

    it("preserves partially foldable ternary condition in emitted Lua", () => {
      const code = `
        declare const TRUE_CONST: boolean;
        declare function foo(): boolean;
        export const x = (TRUE_CONST && foo()) ? 1 : 2;
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("true and foo()");
    });

    it("preserves partially foldable switch discriminant in emitted Lua", () => {
      const code = `
        ${PRINT_DECL}
        declare const VAL_1: number;
        declare function foo(): number;
        switch (VAL_1 + foo()) {
          case 1: print(1); break;
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("1 + foo()");
    });
  });

  describe("when boolean and logical expression folding", () => {
    const opts = ccOpts({
      TRUE_CONST: { env: "TRUE_CONST", default: true },
      FALSE_CONST: { env: "FALSE_CONST", default: false },
      VAL_1: { env: "VAL_1", default: 1 },
    });

    it("folds negation of constant boolean", () => {
      const code = `
        declare const TRUE_CONST: boolean;
        export const x = !TRUE_CONST;
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("x = false");
    });

    it("folds ternary to else branch when condition is false constant", () => {
      const code = `
        declare function foo(): number;
        declare const FALSE_CONST: boolean;
        const x = FALSE_CONST ? 1 : foo();
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("x = foo()");
    });

    it("short-circuits && when left operand is false constant", () => {
      const code = `
        declare function foo(): boolean;
        declare const FALSE_CONST: boolean;
        const x = FALSE_CONST && foo();
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("x = false");
    });

    it("short-circuits || when left operand is true constant", () => {
      const code = `
        declare function foo(): boolean;
        declare const TRUE_CONST: boolean;
        const x = TRUE_CONST || foo();
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("x = true");
    });

    it("folds if-statement with negated constant condition", () => {
      const code = `
        ${PRINT_DECL}
        declare const TRUE_CONST: boolean;
        if (!TRUE_CONST) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toBe("print(2)");
    });

    it.each([
      { operator: "!==", condition: "VAL_1 !== 2" },
      { operator: "==", condition: "VAL_1 == 1" },
      { operator: "!=", condition: "VAL_1 != 2" },
    ])("folds if-condition with $operator operator against constant", ({ condition }) => {
      const code = `
        ${PRINT_DECL}
        declare const VAL_1: number;
        if (${condition}) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toBe("print(1)");
    });

    it("preserves if-condition when string constant has no resolved value", () => {
      const code = `
        ${PRINT_DECL}
        declare const STR_VAL: string;
        if (STR_VAL) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("STR_VAL");
    });

    it("folds if-condition to false when constant is zero", () => {
      const code = `
        ${PRINT_DECL}
        declare const ZERO: number;
        if (ZERO) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, ccOpts({ ZERO: { env: "ZERO", default: 0 } })));

      expect(lua).toBe("print(2)");
    });

    it("folds nested if-statements with known constants", () => {
      const code = `
        ${PRINT_DECL}
        declare const TRUE_CONST: boolean;
        declare const FALSE_CONST: boolean;
        if (TRUE_CONST) {
          if (FALSE_CONST) {
            print(1);
          } else {
            print(2);
          }
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toBe("print(2)");
    });

    it("folds negative statically-known top-level const initializers", () => {
      const code = `
        ${PRINT_DECL}
        const LIMIT = -1;
        if (LIMIT === -1) {
          print(1);
        } else {
          print(2);
        }
      `;

      const lua = normalizeLua(compile(code, ccOpts({ LIMIT: { env: "LIMIT", default: 0 } })));

      expect(lua).toBe("LIMIT = (-1)\nprint(1)");
    });

    it("preserves && chain when left side has partial fold result", () => {
      const code = `
        declare function foo(): boolean;
        declare const TRUE_CONST: boolean;
        const x = (TRUE_CONST && foo()) && true;
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("foo()");
    });

    it("preserves || chain when left side has partial fold result", () => {
      const code = `
        declare function foo(): boolean;
        declare const FALSE_CONST: boolean;
        const x = (FALSE_CONST || foo()) || false;
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("foo()");
    });

    it("preserves if-condition when first operand is a function call", () => {
      const code = `
        ${PRINT_DECL}
        declare function foo(): boolean;
        declare const TRUE_CONST: boolean;
        if (foo() && TRUE_CONST) {
          print(1);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("if foo()");
    });
  });

  describe("when switch folding edge cases", () => {
    const opts = ccOpts({
      TRUE_CONST: { env: "TRUE_CONST", default: true },
      FALSE_CONST: { env: "FALSE_CONST", default: false },
      VAL_1: { env: "VAL_1", default: 1 },
    });

    it("folds switch with fallthrough when constant matches case", () => {
      const code = `
        ${PRINT_DECL}
        declare const VAL_1: number;
        switch (VAL_1) {
          case 1:
            print(1);
          case 2:
            print(2);
            break;
          default:
            print(0);
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("print(1)");
      expect(lua).toContain("print(2)");
      expect(lua).not.toContain("print(0)");
    });

    it("eliminates switch when constant matches no case and no default", () => {
      const code = `
        ${PRINT_DECL}
        declare const VAL_1: number;
        switch (VAL_1) {
          case 2:
            print(2);
            break;
          case 3:
            print(3);
            break;
        }
        print(4);
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toBe("print(4)");
    });

    it("folds switch to matching case that contains return in block", () => {
      const oneOpts = ccOpts({ ONE: { env: "ONE", default: 1 } });
      const code = `
        ${PRINT_DECL}
        declare const ONE: number;
        function test() {
          switch (ONE) {
            case 1: {
              return 1;
            }
            case 2:
              print(2);
              break;
          }
        }
      `;

      const lua = normalizeLua(compile(code, oneOpts));

      expect(lua).toContain("return 1");
      expect(lua).not.toContain("print(2)");
    });

    it("does not emit later fallthrough clauses after a throw", () => {
      const oneOpts = ccOpts({ ONE: { env: "ONE", default: 1 } });
      const code = `
        ${PRINT_DECL}
        declare const ONE: number;
        switch (ONE) {
          case 1:
            print(1);
            throw "boom";
          case 2:
            print(2);
            break;
          default:
            print(0);
        }
      `;

      const lua = normalizeLua(compile(code, oneOpts));

      expect(lua).toContain("print(1)");
      expect(lua).not.toContain("print(2)");
      expect(lua).not.toContain("print(0)");
    });

    it("preserves switch when case expression is a function call", () => {
      const code = `
        ${PRINT_DECL}
        declare function foo(): number;
        declare const VAL_1: number;
        switch (VAL_1) {
          case foo():
            print(1);
            break;
          case 2:
            print(2);
            break;
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("foo()");
      expect(lua).toContain("switch");
    });

    it("preserves switch when case contains unresolvable expression and no default", () => {
      const code = `
        ${PRINT_DECL}
        declare function foo(): number;
        declare const VAL_1: number;
        switch (VAL_1) {
          case foo():
            print(1);
            break;
        }
      `;

      const lua = normalizeLua(compile(code, opts));

      expect(lua).toContain("switch");
      expect(lua).toContain("foo()");
    });
  });

  describe("when labeled statements appear in switch cases", () => {
    it("surfaces TSTL's labeled-statement error end-to-end", () => {
      const code = `
        declare const MODE: string;
        switch (MODE) {
          case "a":
            outer: {
              break outer;
            }
            break;
        }
      `;

      expect(() => compile(code, ccOpts({ MODE: { env: "X", default: "a" } }))).toThrow(
        "Unsupported node kind LabeledStatement",
      );
    });
  });

  describe("when visitors are called directly with a partial type checker", () => {
    function createRuleVisitors(checker: Partial<ts.TypeChecker>): tstl.Visitors {
      return Reflect.apply(createVisitors, undefined, [
        asTypeChecker(checker),
        {
          rules: {
            "conditional-compilation": {
              constants: {
                FLAG: { env: "FLAG", default: true },
              },
            },
          },
          strict: false,
        },
      ]);
    }

    function foldIdentifierWithChecker(checker: Partial<ts.TypeChecker>): tstl.Expression {
      const visitors = createRuleVisitors(checker);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.Identifier) as (
        node: ts.Identifier,
        context: tstl.TransformationContext,
      ) => tstl.Expression;
      const node = parseIdentifierExpression("FLAG");

      return Reflect.apply(visitor, undefined, [
        node,
        {
          diagnostics: [],
          superTransformExpression: () => tstl.createNilLiteral(),
        } as unknown as tstl.TransformationContext,
      ]);
    }

    it("folds configured identifiers when the checker cannot resolve a symbol", () => {
      const result = foldIdentifierWithChecker({
        getSymbolAtLocation: () => undefined,
      });

      expectBooleanLiteral(result, true);
    });

    it("folds configured identifiers when the checker returns a symbol without declarations", () => {
      const result = foldIdentifierWithChecker({
        getSymbolAtLocation: () => ({ declarations: undefined }) as ts.Symbol,
      });

      expectBooleanLiteral(result, true);
    });

    it("does not fold when local declarations have conflicting initializers", () => {
      const result = foldIdentifierWithChecker({
        getSymbolAtLocation: () =>
          ({
            declarations: [
              parseVariableDeclaration("const FLAG = true;"),
              parseVariableDeclaration("const FLAG = false;"),
            ],
          }) as unknown as ts.Symbol,
      });

      // Conflicting declarations prevent folding — falls back to superTransformExpression (nil)
      expect(tstl.isNilLiteral(result)).toBe(true);
    });

    function expectSwitchStatementFallback(source: string): void {
      const visitors = createRuleVisitors({ getSymbolAtLocation: () => undefined });
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SwitchStatement) as (
        node: ts.SwitchStatement,
        context: tstl.TransformationContext,
      ) => tstl.Statement[] | undefined;
      const node = parseSwitchStatement(source);
      const fallbackStatement = tstl.createDoStatement([]);
      const superTransformStatements = vi.fn(() => [fallbackStatement]);
      const transformStatements = vi.fn(() => {
        throw new Error("Expected switch case to fall back before transforming statements.");
      });

      const result = Reflect.apply(visitor, undefined, [
        node,
        {
          diagnostics: [],
          superTransformStatements,
          transformStatements,
        } as unknown as tstl.TransformationContext,
      ]);

      expect(superTransformStatements).toHaveBeenCalledOnce();
      expect(superTransformStatements).toHaveBeenCalledWith(node);
      expect(transformStatements).not.toHaveBeenCalled();
      expect(result).toStrictEqual([fallbackStatement]);
    }

    it.each([
      {
        name: "a labeled conditional break",
        source: `
        switch (1) {
          case 1:
            outer: {
              if (FLAG) {
                break outer;
              }
            }
            break;
        }
      `,
      },
      {
        name: "a conditional break inside a try block",
        source: `
        switch (1) {
          case 1:
            try {
              if (FLAG) {
                break;
              }
            } catch {}
            break;
        }
      `,
      },
      {
        name: "a conditional break inside a finally block",
        source: `
        switch (1) {
          case 1:
            try {
              const ok = 1;
            } finally {
              if (FLAG) {
                break;
              }
            }
            break;
        }
      `,
      },
    ])("falls back when a folded switch case contains $name", ({ source }) => {
      expectSwitchStatementFallback(source);
    });

    it("warns and falls back when a switch discriminant only partially folds", () => {
      const visitors = Reflect.apply(createVisitors, undefined, [
        asTypeChecker({ getSymbolAtLocation: () => undefined }),
        {
          rules: {
            "conditional-compilation": {
              constants: {
                MODE: { env: "MODE", default: 1 },
              },
            },
          },
          strict: false,
        },
      ]);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SwitchStatement) as (
        node: ts.SwitchStatement,
        context: tstl.TransformationContext,
      ) => tstl.Statement[] | undefined;
      const node = parseSwitchStatement(`
        switch (MODE + foo()) {
          case 1:
            break;
        }
      `);
      const diagnostics: ts.Diagnostic[] = [];
      const fallbackStatement = tstl.createDoStatement([]);
      const superTransformStatements = vi.fn(() => [fallbackStatement]);

      const result = Reflect.apply(visitor, undefined, [
        node,
        {
          diagnostics,
          superTransformStatements,
        } as unknown as tstl.TransformationContext,
      ]);

      expect(diagnostics).toHaveLength(1);
      expect(String(diagnostics[0]?.messageText)).toContain("could not be fully resolved");
      expect(superTransformStatements).toHaveBeenCalledOnce();
      expect(superTransformStatements).toHaveBeenCalledWith(node);
      expect(result).toStrictEqual([fallbackStatement]);
    });
  });
});

describe("conditional-compilation when property-based inputs vary", () => {
  const NUM_RUNS = 50;
  const TIMEOUT = 30_000;

  it.each([
    {
      name: "a direct boolean constant",
      sourceFor: () => `
        declare const MY_FLAG: boolean;
        if (MY_FLAG) { const kept = "yes"; } else { const removed = "no"; }
      `,
      whenFalse: '"no"',
      whenTrue: '"yes"',
    },
    {
      name: "a negated boolean constant",
      sourceFor: () => `
        declare const MY_FLAG: boolean;
        if (!MY_FLAG) { const kept = "yes"; } else { const removed = "no"; }
      `,
      whenFalse: '"yes"',
      whenTrue: '"no"',
    },
  ])(
    "selects the correct branch for $name",
    ({ sourceFor, whenFalse, whenTrue }) => {
      expect.hasAssertions();
      fc.assert(
        fc.property(fc.boolean(), (value) => {
          const lua = compile(sourceFor(), ccOpts({ MY_FLAG: { env: "X", default: value } }));
          const expected = value ? whenTrue : whenFalse;
          const unexpected = value ? whenFalse : whenTrue;

          expect(lua).toContain(expected);
          expect(lua).not.toContain(unexpected);
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "string equality selects correct branch",
    () => {
      expect.hasAssertions();
      fc.assert(
        fc.property(arbSafeString, arbSafeString, (constValue, compareValue) => {
          const src = `
            declare const PLATFORM: string;
            if (PLATFORM === "${compareValue}") { const matched = "yes"; } else { const unmatched = "no"; }
          `;

          const lua = compile(src, ccOpts({ PLATFORM: { env: "X", default: constValue } }));

          if (constValue === compareValue) {
            expect(lua).toContain('"yes"');
            expect(lua).not.toContain('"no"');
          } else {
            expect(lua).toContain('"no"');
            expect(lua).not.toContain('"yes"');
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Phase 3 — interaction and coverage-targeted tests
// ---------------------------------------------------------------------------

describe("conditional-compilation — switch with nested control flow", () => {
  it("collapses a switch case whose body contains an if with no break in either arm", () => {
    const lua = compile(
      `
        ${PRINT_DECL}
        declare const MODE: number;
        let x = 0;
        switch (MODE) {
          case 1:
            if (x > 0) { x = 10; } else { x = 20; }
            break;
          default:
            x = 99;
        }
        print(x);
      `,
      ccOpts({ MODE: { env: "CC_MODE", default: 1 } }),
    );
    // case 1 body survives; default is stripped
    expect(lua).not.toContain("x = 99");
    expect(lua).toContain("x = 20");
  });

  it("preserves switch when case body has a break inside an if (conditional break)", () => {
    // containsConditionalCaseBreak returns true for a break inside an if-arm → unsafe to fold
    const lua = compile(
      `
        ${PRINT_DECL}
        declare const MODE: number;
        let x = 0;
        switch (MODE) {
          case 1:
            if (x > 0) { break; }
            x = 10;
            break;
          default:
            x = 99;
        }
        print(x);
      `,
      ccOpts({ MODE: { env: "CC_MODE", default: 1 } }),
    );
    // Conditional break inside if → rule must preserve the switch structure
    expect(lua).toContain("x = 99");
  });

  it("collapses a switch case whose body has an if with multiple statements (no inner break)", () => {
    // Additional coverage for the if-analysis walk when both arms are present and neither breaks.
    const lua = compile(
      `
        ${PRINT_DECL}
        declare const MODE: number;
        let x = 0;
        let y = 0;
        switch (MODE) {
          case 2:
            if (x > 5) { y = 10; x = 1; } else { y = 20; x = 2; }
            break;
          default:
            x = 99;
        }
        print(x);
        print(y);
      `,
      ccOpts({ MODE: { env: "CC_MODE", default: 2 } }),
    );
    expect(lua).not.toContain("x = 99");
    expect(lua).toContain("y = 20");
  });
});

describe("conditional-compilation — interaction with other rules", () => {
  it("cc + constant-folding: dead branch stripped before folding runs on live branch", () => {
    // CC removes the debug branch; constant-folding simplifies 2 + 3 in the live branch.
    const lua = compile(
      `
        ${PRINT_DECL}
        declare const DEBUG: boolean;
        let x = 0;
        if (DEBUG) {
          x = 100 + 200;
        } else {
          x = 2 + 3;
        }
        print(x);
      `,
      ccOpts({ DEBUG: { env: "CC_DEBUG", default: false } }),
    );
    // The else branch is kept; constant-folding should fold 2 + 3 → 5
    expect(lua).not.toContain("100");
    expect(lua).toContain("5");
    expect(lua).not.toContain("2 + 3");
  });

  it("cc + remove-empty-branch: cc-collapsed empty block is then cleaned by remove-empty-branch", () => {
    const lua = compile(
      `
        ${PRINT_DECL}
        declare const DEBUG: boolean;
        let x = 1;
        if (DEBUG) {
          // empty when stripped
        }
        print(x);
      `,
      ccOpts({ DEBUG: { env: "CC_DEBUG", default: false } }),
    );
    // Both CC and remove-empty-branch should eliminate the if entirely
    expect(lua).not.toContain("if");
    expect(lua).toContain("x = 1");
  });

  it("cc + inline: inlined function body survives cc stripping the surrounding branch", () => {
    const lua = compile(
      `
        ${PRINT_DECL}
        declare const DEBUG: boolean;
        /** @inline */
        function doubled(n: number): number { return n * 2; }
        let result = 0;
        if (!DEBUG) {
          result = doubled(21);
        }
        print(result);
      `,
      ccOpts({ DEBUG: { env: "CC_DEBUG", default: false } }),
    );
    // !DEBUG is true → live branch kept; inline substitutes doubled(21), then constant-folding
    // evaluates 21 * 2 → 42. The call site must be eliminated regardless.
    expect(lua).not.toContain("doubled(");
    // The inline rule substitutes the call; constant-folding may further reduce 21 * 2 → 42.
    expect(lua).toMatch(/21 \* 2|42/);
  });
});
