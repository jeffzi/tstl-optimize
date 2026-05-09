import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../src/rules/constant-folding";
import { compile, normalizeLua } from "../helpers";

describe("constant-folding", () => {
  function createLuaFile(statements: tstl.Statement[]): tstl.File {
    return tstl.createFile(statements, new Set<tstl.LuaLibFeature>(), "");
  }

  it("folds binary arithmetic expressions", () => {
    const lua = compile("const a = 1 + 2 * 3;");
    expect(lua).toContain("a = 7");
  });

  it("folds string concatenation", () => {
    const lua = compile("const a = 'foo' + 'bar';");
    expect(lua).toContain('a = "foobar"');
  });

  it("folds boolean logic", () => {
    const lua = compile("const a = true && false; const b = !true;");
    expect(lua).toContain("a = false");
    expect(lua).toContain("b = false");
  });

  it("leaves side-effects untouched", () => {
    const lua = compile("let x = 1; const a = (x = 2) + 3;");
    expect(lua).toContain("x = 2");
    expect(lua).toContain("+ 3");
  });

  it("removes empty if blocks", () => {
    const lua = compile("if (true) {} else if (false) {} else {} const a = 1;");
    expect(lua).not.toContain("if");
    expect(lua).toContain("a = 1");
  });

  it("removes statements after return", () => {
    const lua = compile("function foo() { return 1; const a = 2; }");
    expect(lua).toContain("return 1");
    expect(lua).not.toContain("local a = 2");
  });

  it.each([
    // Lua: (-7) % 3 == 2   (floored toward -inf)
    // JS:  (-7) % 3 == -1  (truncated toward zero)
    { source: "const x = (-7) % 3;", expected: "x = 2", label: "negative dividend" },
    // Lua: 7 % (-3) == -2
    // JS:  7 % (-3) == 1
    { source: "const x = 7 % (-3);", expected: "x = (-2)", label: "negative divisor" },
  ])("folds modulo using Lua floored semantics ($label)", ({ source, expected }) => {
    const lua = compile(source);

    expect(lua).toContain(expected);
  });

  describe("unary negation folding (multi-pass)", () => {
    it("folds double negation to the positive value", () => {
      const lua = compile("const x = -(-5);");

      expect(lua).toContain("x = 5");
    });

    it("folds triple negation to a single negation", () => {
      const lua = compile("const x = -(-(-5));");

      expect(lua).toContain("x = -5");
    });
  });

  describe("non-finite results are not folded", () => {
    it.each([
      { label: "division by zero (Infinity)", source: "const x = 1 / 0;", expected: "1 / 0" },
      { label: "zero divided by zero (NaN)", source: "const x = 0 / 0;", expected: "0 / 0" },
      {
        label: "power expression that evaluates to NaN",
        source: "const x = (-4.2) ** (-4.2);",
        expected: "(-4.2) ^ (-4.2)",
      },
    ])("preserves $label", ({ source, expected }) => {
      const lua = compile(source);
      expect(lua).toContain(expected);
    });
  });

  it("parenthesizes folded negative literals when they stay inside exponentiation", () => {
    const lua = normalizeLua(
      compile("declare function exp(): number; export const value = (1 - 3) ** exp();"),
    );

    expect(lua).toContain("value = (-2) ^ exp()");
  });

  it("keeps folded unary negatives grouped before exponentiation", () => {
    const lua = normalizeLua(
      compile("declare function exp(): number; export const value = (-(-(1 - 3))) ** exp();"),
    );

    expect(lua).toContain("value = (-2) ^ exp()");
  });

  describe("optimizeControlFlow preserves side-effectful conditions in empty if-blocks", () => {
    it("preserves call expression when if-body and else-body are both empty", () => {
      const lua = compile(`
        declare function sideEffect(): boolean;
        if (sideEffect()) {}
      `);

      expect(lua).toContain("sideEffect()");
    });

    it("preserves elseif call expression when elseif-body is empty", () => {
      const lua = compile(`
        declare function sideEffect(): boolean;
        declare let x: boolean;
        if (x) { x = false; } else if (sideEffect()) {}
      `);

      expect(lua).toContain("sideEffect()");
    });
  });

  describe("dead code elimination after return statements", () => {
    it("folds logical-not on boolean literals", () => {
      const lua = compile("const x = !!!true;");

      expect(lua).toContain("x = false");
    });

    it("removes unreachable statements after unconditional return in nested block", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          return x;
          const unreachable1 = 2;
          const unreachable2 = 3;
          return unreachable1;
        }
      `);

      expect(lua).toContain("return x");
      expect(lua).not.toContain("unreachable1");
      expect(lua).not.toContain("unreachable2");
    });

    it("removes unreachable statements in if-block after return", () => {
      const lua = compile(`
        function f(cond: boolean) {
          if (cond) {
            const x = 1;
            return x;
            const unreachable = 2;
          }
          const afterIf = 3;
          return afterIf;
        }
      `);

      expect(lua).not.toContain("unreachable");
      expect(lua).toContain("afterIf");
    });

    it("removes unreachable statements after return in do-block", () => {
      const lua = compile(`
        function f() {
          do {
            const x = 1;
            return x;
            const unreachable = 2;
          } while (false);
        }
      `);

      expect(lua).not.toContain("unreachable");
    });

    it("preserves all statements when no return is present", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          const y = 2;
          const z = 3;
          return x + y + z;
        }
      `);

      expect(lua).toContain("x");
      expect(lua).toContain("y");
      expect(lua).toContain("z");
    });

    it("handles complex control flow with multiple returns", () => {
      const lua = compile(`
        function f(a: boolean, b: boolean) {
          if (a) {
            return 1;
            const dead1 = 2;
          }
          if (b) {
            return 3;
            const dead2 = 4;
          }
          return 5;
          const dead3 = 6;
        }
      `);

      expect(lua).not.toContain("dead1");
      expect(lua).not.toContain("dead2");
      expect(lua).not.toContain("dead3");
      expect(lua).toContain("return 1");
      expect(lua).toContain("return 3");
      expect(lua).toContain("return 5");
    });
  });

  describe("binary and unary operator type coverage", () => {
    it("folds comparison operators for numbers", () => {
      const code = `
        export const eq = 1 === 1;
        export const neq = (1 as number) !== (2 as number);
        export const le = (1 as number) <= (2 as number);
        export const ge = (2 as number) >= (1 as number);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = true");
      expect(lua).toContain("neq = true");
      expect(lua).toContain("le = true");
      expect(lua).toContain("ge = true");
    });

    it("folds comparison operators for strings", () => {
      const code = `
        export const eq = "a" === "a";
        export const neq = ("a" as string) !== ("b" as string);
        export const lt = ("a" as string) < ("b" as string);
        export const le = ("a" as string) <= ("b" as string);
        export const gt = ("b" as string) > ("a" as string);
        export const ge = ("b" as string) >= ("a" as string);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = true");
      expect(lua).toContain("neq = true");
      expect(lua).toContain("lt = true");
      expect(lua).toContain("le = true");
      expect(lua).toContain("gt = true");
      expect(lua).toContain("ge = true");
    });

    it("folds Unicode string comparisons using Lua byte ordering", () => {
      const code = `
        export const lt = ("😀" as string) < ("\\uFFFD" as string);
        export const gt = ("😀" as string) > ("\\uFFFD" as string);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("lt = false");
      expect(lua).toContain("gt = true");
    });

    it("folds prefix string comparisons by shorter-byte-length ordering", () => {
      const code = `
        export const lt = ("a" as string) < ("aa" as string);
        export const gt = ("aa" as string) > ("a" as string);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("lt = true");
      expect(lua).toContain("gt = true");
    });

    it("folds comparison and logical operators for booleans", () => {
      const code = `
        export const eq = true === true;
        export const neq = (true as boolean) !== (false as boolean);
        export const or_val = (true as boolean) || (false as boolean);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = true");
      expect(lua).toContain("neq = true");
      expect(lua).toContain("or_val = true");
    });

    it("folds cross-type equality comparisons", () => {
      const code = `
        export const eq = (1 as unknown) === ("1" as unknown);
        export const neq = (1 as unknown) !== ("1" as unknown);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("eq = false");
      expect(lua).toContain("neq = true");
    });

    it("folds string length and unary negation", () => {
      const code = `
        export const len = "abc".length;
        export const neg = -(1);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("len = 3");
      expect(lua).toContain("neg = -1");
    });

    it("preserves unary operators whose runtime semantics are not safe to fold for non-matching types", () => {
      const code = `
        export const neq = (1 as any) !== ("1" as any);
        export const notNumber = !(1 as any);
        export const negateString = -("hi" as any);
      `;

      const lua = normalizeLua(compile(code));

      expect(lua).toContain("neq = true");
      expect(lua).toContain("notNumber = not 1");
      expect(lua).toContain('negateString = __TS__Number(-"hi")');
    });

    it("folds string length using Lua byte length", () => {
      const lua = normalizeLua(compile('export const len = "😀".length;'));

      expect(lua).toContain("len = 4");
    });
  });

  describe("when folding BitwiseNot at Lua AST level", () => {
    it("folds ~literal to its numeric result", () => {
      // Use `as number` to prevent TypeScript's own constant folding,
      // so TSTL emits ~1 in Lua and the SourceFile visitor must fold it.
      // Lua 5.3+ is required for bitwise operator support.
      const lua = normalizeLua(
        compile("const x = ~(1 as number);", { luaTarget: tstl.LuaTarget.Lua53 }),
      );
      expect(lua).toContain("x = -2");
    });

    it("folds large integers with Lua53 integer semantics", () => {
      const lua = normalizeLua(
        compile("const x = ~(1099511627776 as number);", { luaTarget: tstl.LuaTarget.Lua53 }),
      );

      expect(lua).toContain("x = -1099511627777");
    });
  });

  it("prunes two consecutive trailing empty elseif branches when all conditions are pure", () => {
    const lua = normalizeLua(
      compile(
        `
        declare const x: boolean;
        declare const a: boolean;
        declare const b: boolean;
        if (x) { const z = 1; } else if (a) {} else if (b) {}
      `,
        { pluginOptions: { rules: { "dead-local": false } } },
      ),
    );

    // pruneFrom=the if(x) node; while loop iterates twice through else-if(a) and else-if(b)
    // covering the toCheck = toCheck.elseBlock path (line 228) on each pass
    expect(lua).not.toContain("elseif");
    expect(lua).toContain("if x then");
    expect(lua).toContain("local z");
  });

  it("preserves if-statement when elseif condition has side effects", () => {
    const code = `
      declare function print(...args: unknown[]): void;
      declare function get(): boolean;
      if (true) {
        print(1);
      } else if (get()) {
        print(2);
      }
    `;

    const lua = normalizeLua(compile(code));

    expect(lua).toContain("elseif get() then");
    expect(lua).toContain("print(2)");
  });

  describe("direct source-file visitor coverage", () => {
    function runSourceFileVisitor(file: tstl.File | tstl.Expression): tstl.File | tstl.Expression {
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
        node: ts.SourceFile,
        context: tstl.TransformationContext,
      ) => tstl.File | tstl.Expression;

      return Reflect.apply(visitor, undefined, [
        {} as ts.SourceFile,
        {
          superTransformNode: () => file,
        } as unknown as tstl.TransformationContext,
      ]);
    }

    it("folds raw Lua floor-division expressions", () => {
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("x")],
          [
            tstl.createBinaryExpression(
              tstl.createNumericLiteral(7),
              tstl.createNumericLiteral(2),
              tstl.SyntaxKind.FloorDivisionOperator,
            ),
          ],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const rhs = (transformed.statements[0] as tstl.VariableDeclarationStatement).right?.[0];

      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(rhs!)).toBe(true);
      expect((rhs as tstl.NumericLiteral).value).toBe(3);
    });

    it("preserves unsupported unary folds", () => {
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("bitwise")],
          [
            tstl.createUnaryExpression(
              tstl.createNumericLiteral(1.5),
              tstl.SyntaxKind.BitwiseNotOperator,
            ),
          ],
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("length")],
          [
            tstl.createUnaryExpression(
              tstl.createNumericLiteral(1),
              tstl.SyntaxKind.LengthOperator,
            ),
          ],
        ),
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("neg")],
          [
            tstl.createUnaryExpression(
              tstl.createBooleanLiteral(true),
              tstl.SyntaxKind.NegationOperator,
            ),
          ],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const [bitwise, length, neg] = transformed.statements as tstl.VariableDeclarationStatement[];

      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isUnaryExpression(bitwise.right![0])).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isUnaryExpression(length.right![0])).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isUnaryExpression(neg.right![0])).toBe(true);
    });

    it("truncates raw Lua statements after a direct return", () => {
      const file = createLuaFile([
        tstl.createReturnStatement([tstl.createNumericLiteral(1)]),
        tstl.createExpressionStatement(tstl.createIdentifier("later")),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;

      expect(transformed.statements).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isReturnStatement(transformed.statements[0]!)).toBe(true);
    });

    it("throws when the source-file transform does not produce a file", () => {
      const nonFile = tstl.createBooleanLiteral(true);

      expect(() => runSourceFileVisitor(nonFile)).toThrow(
        "expected SourceFile transform to produce a Lua file",
      );
    });
  });
});
