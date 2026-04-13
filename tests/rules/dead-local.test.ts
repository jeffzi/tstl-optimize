import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import { createVisitors } from "../../src/rules/dead-local";
import { compile, normalizeLua } from "../helpers";

describe("dead-local", () => {
  function createLuaFile(statements: tstl.Statement[]): tstl.File {
    return tstl.createFile(statements, new Set<tstl.LuaLibFeature>(), "");
  }

  function toSymbolId(value: number): tstl.SymbolId {
    return value as tstl.SymbolId;
  }

  it("removes unused inline arg temp", () => {
    const lua = compile(`
      /** @inline */
      function double(x: number): number { return x * 2; }
      const result = double(21);
    `);
    // ____inline_arg_0 should be eliminated as an unused temp
    expect(lua).not.toContain("____inline_arg_");
  });

  it("preserves variable that is read in same scope", () => {
    const lua = compile("function f() { const x = 1; return x; }");
    expect(lua).toContain("x = 1");
  });

  it("removes unused variable with pure RHS (literal)", () => {
    const lua = compile("function f() { const x = 42; }");
    expect(lua).not.toContain("x = 42");
  });

  it("preserves variable whose RHS has a side effect (call expression)", () => {
    const lua = compile(`
      declare function someFunc(): number;
      function f() { const x = someFunc(); }
    `);
    // The call must still execute; the whole declaration stays
    expect(lua).toContain("someFunc()");
  });

  it("does NOT remove module-level unused locals", () => {
    // Top-level const — module scope, out of scope for dead-local
    const lua = compile("const x = 1;");
    expect(lua).toContain("x = 1");
  });

  it("does NOT touch multi-LHS declarations", () => {
    // local a, b = f() — must not be removed
    const lua = compile(`
      declare function pair(): [number, number];
      function f() {
        const [a, b] = pair();
        return a + b;
      }
    `);
    expect(lua).toMatch(/local a, b\b/);
    expect(lua).toContain("a + b");
  });

  it("preserves variable used inside a nested closure", () => {
    const lua = compile(`
      function outer() {
        const x = 1;
        const fn = () => x;
        return fn();
      }
    `);
    // x is captured by the closure — must not be removed
    // (merge-locals may merge x and fn into one statement, but x must still be declared)
    expect(lua).toMatch(/local x[,\s]/);
  });

  it("removes unused local function declaration (post-inline residue)", () => {
    const lua = compile(`
      /** @inline */
      function add(a: number, b: number): number { return a + b; }
      const r1 = add(1, 2);
      const r2 = add(3, 4);
    `);
    expect(lua).not.toContain("local function add");
  });

  it("rule can be disabled via config", () => {
    const lua = compile("function f() { const x = 42; }", {
      pluginOptions: { rules: { "dead-local": false } },
    });
    expect(lua).toContain("x = 42");
  });

  describe("when removing unused locals in nested function expressions", () => {
    it.each([
      {
        name: "callback passed as a call argument",
        source: `
          declare function run(fn: () => number): void;
          function outer() {
            run(function(): number {
              const unused = 42;
              const result = 1;
              return result;
            });
          }
        `,
      },
      {
        name: "function stored in a table value",
        source: `
          function outer() {
            const obj = { fn: function(): number {
              const unused = 42;
              const result = 1;
              return result;
            } };
            return obj;
          }
        `,
      },
      {
        name: "IIFE callee",
        source: `
          function outer() {
            (function() {
              const unused = 42;
              const result = 1;
              return result;
            })();
          }
        `,
      },
    ])("removes unused local inside $name", ({ source }) => {
      const lua = compile(source);

      expect(lua).not.toContain("unused");
      expect(lua).toContain("result");
    });
  });

  describe("when handling write-only locals (assignment without read)", () => {
    it("preserves initializer when the first later assignment reads the local", () => {
      const lua = compile(`
        function f() {
          let i = 0;
          i += 1;
          return i;
        }
      `);

      expect(lua).toContain("local i = 0");
      expect(lua).toContain("i = i + 1");
    });

    it("preserves initializer when a closure reads the local before a later write", () => {
      const lua = normalizeLua(
        compile(`
          function f() {
            let x = 1;
            const g = () => x;
            const y = g();
            x = 2;
            return y;
          }
        `),
      );

      expect(lua).toContain("local x = 1");
      expect(lua).toContain("local y = g()");
      expect(lua).toContain("x = 2");
      expect(lua).toContain("return y");
    });

    it("ignores deferred nested-function writes when deciding whether to drop an initializer", () => {
      const lua = compile(`
        function f() {
          let s = "A";
          const touch = (x: string) => {
            s = x;
          };
          s += "B";
          touch("C");
          return s;
        }
      `);

      expect(lua).toContain('local s = "A"');
      expect(lua).toContain('s = s .. "B"');
    });

    it("preserves declaration when local is assigned after initialization", () => {
      const lua = compile(`
        function f() {
          let x = 1;
          x = 5;
        }
      `);
      // The local must survive, but the dead pure initializer should be removed.
      expect(lua).toContain("local x");
      expect(lua).not.toMatch(/local x\s*=\s*1/);
      expect(lua).toContain("x = 5");
    });

    it("preserves declaration when local with impure RHS is assigned", () => {
      const lua = compile(`
        declare function foo(): number;
        declare function bar(): number;
        function f() {
          let x = foo();
          x = bar();
        }
      `);
      // x is assigned to, so declaration must be kept (even though RHS is impure)
      expect(lua).toContain("local x");
      expect(lua).toContain("foo()");
    });

    it("still removes unused local when NOT followed by assignment", () => {
      const lua = compile(`
        function f() {
          const x = 1;
          const y = 2;
          return y;
        }
      `);
      // x is never read and never assigned — should be eliminated
      expect(lua).not.toContain("x");
      expect(lua).toContain("y");
    });

    it("preserves declaration when local is assigned and then read", () => {
      const lua = compile(`
        function f() {
          let x = 1;
          x = 2;
          return x;
        }
      `);
      // x is assigned and read — declaration must be kept, but the dead pure initializer should go.
      expect(lua).toContain("local x");
      expect(lua).not.toMatch(/local x\s*=\s*1/);
      expect(lua).toContain("x = 2");
    });

    it("preserves initializer when the first read is parenthesized before a later write", () => {
      const lua = normalizeLua(
        compile(`
        function f(flag: boolean) {
          let x = 1;
          const y = (x);
          if (flag) {
            x = 2;
          }
          return y;
        }
      `),
      );

      expect(lua).toContain("local x = 1");
      expect(lua).toContain("local y = x");
      expect(lua).toContain("x = 2");
      expect(lua).toContain("return y");
    });

    it("preserves initializer when the first read appears in a conditional expression", () => {
      const lua = normalizeLua(
        compile(`
        function f(flag: boolean) {
          let x = 1;
          const y = flag ? x : 0;
          x = 2;
          return y;
        }
      `),
      );

      expect(lua).toContain("local x = 1");
      expect(lua).toContain("local y = flag and x or 0");
      expect(lua).toContain("x = 2");
      expect(lua).toContain("return y");
    });
  });

  describe("when removing unused locals in branching statements", () => {
    it.each([
      {
        name: "if/else branches",
        source: `
          function f() {
            if (true) {
              const unused = 42;
              const result = 1;
              return result;
            } else {
              const deadCode = 99;
              const value = 2;
              return value;
            }
          }
        `,
        expectedPresent: ["if true then", "result", "value", "else"],
        expectedMissing: ["unused", "deadCode"],
      },
      {
        name: "elseif branches",
        source: `
          function f() {
            if (false) {
              return 2;
            } else if (true) {
              const unused3 = 3;
              const result = 4;
              return result;
            }
          }
        `,
        expectedPresent: ["elseif true then", "result"],
        expectedMissing: ["unused3"],
      },
      {
        name: "while-loop bodies",
        source: `
          function f() {
            let x = 0;
            while (x < 10) {
              const unused = 42;
              const value = x + 1;
              x = value;
            }
          }
        `,
        expectedPresent: ["while x < 10 do", "value"],
        expectedMissing: ["unused"],
      },
      {
        name: "repeat-loop bodies",
        source: `
          function f() {
            let x = 10;
            do {
              const unused = 42;
              const value = x - 1;
              x = value;
            } while (x > 0);
          }
        `,
        expectedPresent: ["repeat", "until", "value"],
        expectedMissing: ["unused"],
      },
      {
        name: "for-loop bodies",
        source: `
          declare const items: number[];
          function f() {
            for (let i = 0; i < items.length; i++) {
              const unused = 42;
              const value = items[i] * 2;
              if (value > 10) return value;
            }
          }
        `,
        expectedPresent: ["items", "value"],
        expectedMissing: ["unused"],
      },
      {
        name: "for-in loop bodies",
        source: `
          declare const obj: Record<string, number>;
          function f() {
            for (const key in obj) {
              const unused = 42;
              const val = obj[key];
              if (val > 0) return val;
            }
          }
        `,
        expectedPresent: ["for", "obj", "val"],
        expectedMissing: ["unused"],
      },
      {
        name: "do-block bodies",
        source: `
          function f() {
            do {
              const unused = 42;
              const value = 1;
              return value;
            } while (false);
          }
        `,
        expectedPresent: ["do", "value"],
        expectedMissing: ["unused"],
      },
    ])("removes unused locals inside $name", ({ expectedMissing, expectedPresent, source }) => {
      const lua = compile(source);

      for (const snippet of expectedPresent) {
        expect(lua).toContain(snippet);
      }

      for (const snippet of expectedMissing) {
        expect(lua).not.toContain(snippet);
      }
    });
  });

  describe("additional read-shape coverage", () => {
    it("preserves locals read through conditional and parenthesized expressions", () => {
      const lua = compile(`
        function f(flag: boolean) {
          const x = 1;
          const y = (flag ? x : 2);
          return (y);
        }
      `);

      expect(lua).toContain("x = 1");
      expect(lua).toContain("return y");
    });

    it("preserves locals read from table keys and values", () => {
      const lua = normalizeLua(
        compile(`
        function f() {
          const key = "value";
          const data = { [key]: key };
          return data[key];
        }
      `),
      );

      expect(lua).toContain('local key = "value"');
      expect(lua).toContain("return data[key]");
    });

    it("preserves locals read through computed assignment targets", () => {
      const lua = normalizeLua(
        compile(`
        function f(arr: number[]) {
          let index = 0;
          arr[index] = arr[index] + 1;
          return index;
        }
      `),
      );

      expect(lua).toContain("local index = 0");
      expect(lua).toContain("arr[index + 1] = arr[index + 1] + 1");
      expect(lua).toContain("return index");
    });

    it("preserves unused function-expression declarations inside nested scopes", () => {
      const lua = normalizeLua(
        compile(`
        function outer() {
          if (true) {
            const keep = function() {
              return 1;
            };
          }
        }
      `),
      );

      expect(lua).toContain("local function keep()");
      expect(lua).toContain("return 1");
    });
  });

  describe("public visitor coverage", () => {
    it("returns non-file transform results unchanged", () => {
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
        node: ts.SourceFile,
        context: tstl.TransformationContext,
      ) => tstl.Expression;
      const nonFile = tstl.createBooleanLiteral(true);

      const transformed = Reflect.apply(visitor, undefined, [
        {} as ts.SourceFile,
        {
          superTransformNode: () => nonFile,
        } as unknown as tstl.TransformationContext,
      ]);

      expect(transformed).toBe(nonFile);
    });
  });

  describe("raw Lua visitor coverage", () => {
    function runSourceFileVisitor(node: tstl.Node): tstl.Node {
      const visitors = Reflect.apply(createVisitors, undefined, []);
      const visitor = Reflect.get(visitors, ts.SyntaxKind.SourceFile) as (
        node: ts.SourceFile,
        context: tstl.TransformationContext,
      ) => tstl.File;

      return Reflect.apply(visitor, undefined, [
        {} as ts.SourceFile,
        {
          superTransformNode: () => node,
        } as unknown as tstl.TransformationContext,
      ]);
    }

    it("preserves an initializer when the first later read is parenthesized inside a nested do block", () => {
      const xSym = toSymbolId(101);
      const body = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createDoStatement([
          tstl.createVariableDeclarationStatement(
            [tstl.createIdentifier("y")],
            [tstl.createParenthesizedExpression(tstl.createIdentifier("x", undefined, xSym))],
          ),
        ]),
        tstl.createAssignmentStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(2)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [tstl.createFunctionExpression(body, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const fnDecl = transformed.statements[0] as tstl.VariableDeclarationStatement;
      const fnExpr = fnDecl.right?.[0] as tstl.FunctionExpression;
      const xDecl = fnExpr.body.statements[0] as tstl.VariableDeclarationStatement;

      expect(xDecl.left).toHaveLength(1);
      expect((xDecl.left[0] as tstl.Identifier).text).toBe("x");
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(xDecl.right![0])).toBe(true);
    });

    it("preserves an initializer when the first later read is conditional inside a nested do block", () => {
      const xSym = toSymbolId(102);
      const body = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createDoStatement([
          tstl.createVariableDeclarationStatement(
            [tstl.createIdentifier("y")],
            [
              tstl.createConditionalExpression(
                tstl.createBooleanLiteral(true),
                tstl.createIdentifier("x", undefined, xSym),
                tstl.createNumericLiteral(0),
              ),
            ],
          ),
        ]),
        tstl.createAssignmentStatement(
          [tstl.createIdentifier("x", undefined, xSym)],
          [tstl.createNumericLiteral(2)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [tstl.createFunctionExpression(body, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const fnDecl = transformed.statements[0] as tstl.VariableDeclarationStatement;
      const fnExpr = fnDecl.right?.[0] as tstl.FunctionExpression;
      const xDecl = fnExpr.body.statements[0] as tstl.VariableDeclarationStatement;

      expect((xDecl.left[0] as tstl.Identifier).text).toBe("x");
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(xDecl.right![0])).toBe(true);
    });

    it("preserves an initializer when a raw numeric-for step expression reads the local before a later write", () => {
      const stepSym = toSymbolId(103);
      const body = tstl.createBlock([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("step", undefined, stepSym)],
          [tstl.createNumericLiteral(1)],
        ),
        tstl.createForStatement(
          tstl.createBlock([]),
          tstl.createIdentifier("i"),
          tstl.createNumericLiteral(0),
          tstl.createNumericLiteral(4),
          tstl.createIdentifier("step", undefined, stepSym),
        ),
        tstl.createAssignmentStatement(
          [tstl.createIdentifier("step", undefined, stepSym)],
          [tstl.createNumericLiteral(2)],
        ),
      ]);
      const file = createLuaFile([
        tstl.createVariableDeclarationStatement(
          [tstl.createIdentifier("fn")],
          [tstl.createFunctionExpression(body, [])],
        ),
      ]);

      const transformed = runSourceFileVisitor(file) as tstl.File;
      const fnDecl = transformed.statements[0] as tstl.VariableDeclarationStatement;
      const fnExpr = fnDecl.right?.[0] as tstl.FunctionExpression;
      const stepDecl = fnExpr.body.statements[0] as tstl.VariableDeclarationStatement;

      expect((stepDecl.left[0] as tstl.Identifier).text).toBe("step");
      // biome-ignore lint/style/noNonNullAssertion: node constructed with value
      expect(tstl.isNumericLiteral(stepDecl.right![0])).toBe(true);
    });
  });
});
