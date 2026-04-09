// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use any for internal TS/TSTL types
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createVisitors } from "../../src/rules/inline";
import { compile, normalizeLua } from "../helpers";

describe("inline coverage", () => {
  it("Line 540, 546: detects recursion in inlined body/return expression", () => {
    const code = `
      /** @inline */
      function fact(n: number): number {
        if (n <= 1) return 1;
        return n * fact(n - 1);
      }
      export const x = fact(5);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("fact(5)");
  });

  it("Line 557: detects parameter write in return expression", () => {
    const code = `
      /** @inline */
      function foo(x: number): number {
        return (x = 1);
      }
      export const a = foo(5);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo(5)");
  });

  it("Line 680-681: handleCallExpression with reason", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function foo() { print(1); }
      // multi-stmt at expr position fails prereq
      export const x = { val: foo() };
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo()");
  });

  it("Line 697-700: multi-statement body at expression position", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function foo() {
        print(1);
        return 2;
      }
      export const x = 1 + foo();
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo()");
  });

  it("Line 1232-1235: return-value function called at void site (statementsWithReturn)", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function foo() {
        print("side effect");
        return 1;
      }
      function test() {
        foo(); // Void site
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("foo()");
  });

  it("buildObjectDestructureInline coverage", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function getObj() { 
        print("side effect");
        return { a: 1, b: 2 }; 
      }
      function test() {
        const { a: myA, b } = getObj();
        return myA + b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("side effect");
    expect(lua).toContain("myA");
    expect(lua).toContain("b");
  });

  it("buildObjectDestructureInline rejection (nested)", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function getObj() { 
        print("side effect");
        return { a: { b: 1 } }; 
      }
      function test() {
        const { a: { b } } = getObj();
        return b;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("getObj()");
  });

  it("buildArrayDestructureInline coverage (non-multi)", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function getArr() { 
        print("side effect");
        return [1, 2]; 
      }
      function test() {
        const [x, y] = getArr();
        return x + y;
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("unpack");
  });

  it("Line 514-522: hasLinearControlFlow with Try and Labeled statements", () => {
    const code = `
      declare function print(...args: any[]): void;
      /** @inline */
      function withTry() {
        try { return 1; } catch(e) { return 2; } finally { print(3); }
      }
      /** @inline */
      function withLabel() {
        foo: { return 1; }
      }
      export const a = withTry();
      export const b = withLabel();
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("withTry()");
    expect(lua).toContain("withLabel()");
  });

  it("Manual visitor tests for coverage gaps", () => {
    const mockChecker: any = {
      getSymbolAtLocation: vi.fn(),
      getResolvedSignature: vi.fn(),
      getAliasedSymbol: vi.fn(),
      getSymbolsInScope: vi.fn().mockReturnValue([]),
    };
    const mockContext: any = {
      diagnostics: [],
      nextSymbolId: vi.fn().mockReturnValue(1),
      transformExpression: vi.fn((expr) => expr),
      transformStatements: vi.fn((stmts) => stmts),
      superTransformNode: vi.fn((node) => node),
      superTransformStatements: vi.fn((stmts) => stmts),
      superTransformExpression: vi.fn((expr) => expr),
    };

    const visitors = createVisitors(mockChecker, { rules: { inline: true } } as any);
    expect(visitors).toBeDefined();

    // Test 1: VariableStatement visitor exists and is callable
    const varVisitor = visitors[ts.SyntaxKind.VariableStatement] as (
      node: any,
      context: any,
    ) => any;
    expect(typeof varVisitor).toBe("function");

    // Test 2: Verify early exit when initializer is not a CallExpression
    const mockVarStmtNonCall: any = {
      kind: ts.SyntaxKind.VariableStatement,
      declarationList: {
        declarations: [
          {
            name: { kind: ts.SyntaxKind.Identifier, text: "x" },
            initializer: { kind: ts.SyntaxKind.NumericLiteral },
          },
        ],
      },
    };
    const result1 = varVisitor(mockVarStmtNonCall, mockContext);
    expect(result1).toBeUndefined();

    // Test 3: Verify early exit when symbol cannot be resolved (callExpression.expression is not resolvable)
    const mockVarStmtCall: any = {
      kind: ts.SyntaxKind.VariableStatement,
      declarationList: {
        declarations: [
          {
            name: { kind: ts.SyntaxKind.Identifier, text: "result" },
            initializer: {
              kind: ts.SyntaxKind.CallExpression,
              expression: { kind: ts.SyntaxKind.Identifier, text: "unknownFunc" },
            },
          },
        ],
      },
    };
    mockChecker.getSymbolAtLocation.mockReturnValue(undefined);
    const result2 = varVisitor(mockVarStmtCall, mockContext);
    expect(result2).toBeUndefined();
    // Verify the visitor attempted symbol resolution
    expect(mockChecker.getSymbolAtLocation).toHaveBeenCalled();

    // Test 4: Verify visitor reaches getInlineTarget when symbol is found
    // and attempts to call getDeclarations to classify the target
    const mockSymbol: any = {
      flags: 0, // not an alias
      getDeclarations: vi.fn().mockReturnValue([
        {
          kind: ts.SyntaxKind.VariableDeclaration,
          parent: {
            parent: {
              kind: ts.SyntaxKind.VariableStatement,
            },
          },
          initializer: {
            kind: ts.SyntaxKind.ArrowFunction,
            parameters: [],
            body: {
              kind: ts.SyntaxKind.Block,
              statements: [
                {
                  kind: ts.SyntaxKind.ReturnStatement,
                  expression: { kind: ts.SyntaxKind.NumericLiteral, text: "42" },
                },
              ],
            },
          },
        },
      ]),
    };

    mockChecker.getSymbolAtLocation.mockClear();
    mockChecker.getSymbolAtLocation.mockReturnValue(mockSymbol);
    varVisitor(mockVarStmtCall, mockContext);
    // Verify getSymbolAtLocation was called with the call expression's expression
    expect(mockChecker.getSymbolAtLocation).toHaveBeenCalledWith(
      mockVarStmtCall.declarationList.declarations[0].initializer.expression,
    );
    // Verify that getDeclarations was called (part of getInlineTarget logic)
    expect(mockSymbol.getDeclarations).toHaveBeenCalled();

    // Test 5: Verify visitor handles multiple declarations correctly
    // (early exit before attempting symbol resolution)
    const mockVarStmtMultiDecl: any = {
      kind: ts.SyntaxKind.VariableStatement,
      declarationList: {
        declarations: [
          {
            name: { kind: ts.SyntaxKind.Identifier, text: "a" },
            initializer: {
              kind: ts.SyntaxKind.CallExpression,
              expression: { kind: ts.SyntaxKind.Identifier },
            },
          },
          {
            name: { kind: ts.SyntaxKind.Identifier, text: "b" },
            initializer: { kind: ts.SyntaxKind.NumericLiteral },
          },
        ],
      },
    };
    mockChecker.getSymbolAtLocation.mockClear();
    const result5 = varVisitor(mockVarStmtMultiDecl, mockContext);
    expect(result5).toBeUndefined();
    // Should NOT attempt symbol resolution for multiple declarations
    expect(mockChecker.getSymbolAtLocation).not.toHaveBeenCalled();

    // Test 6: Verify visitor processes ObjectBindingPattern destructuring
    // (tests that handleVariableStatement reaches destructuring code paths)
    const mockVarStmtDestructure: any = {
      kind: ts.SyntaxKind.VariableStatement,
      declarationList: {
        declarations: [
          {
            name: {
              kind: ts.SyntaxKind.ObjectBindingPattern,
              elements: [],
            },
            initializer: {
              kind: ts.SyntaxKind.CallExpression,
              expression: { kind: ts.SyntaxKind.Identifier, text: "factory" },
            },
          },
        ],
      },
    };
    mockChecker.getSymbolAtLocation.mockClear();
    const mockSymbol2: any = {
      flags: 0,
      getDeclarations: vi.fn().mockReturnValue([
        {
          kind: ts.SyntaxKind.VariableDeclaration,
          parent: { parent: { kind: ts.SyntaxKind.VariableStatement } },
          initializer: {
            kind: ts.SyntaxKind.ArrowFunction,
            parameters: [],
            body: {
              kind: ts.SyntaxKind.Block,
              statements: [
                {
                  kind: ts.SyntaxKind.ReturnStatement,
                  expression: { kind: ts.SyntaxKind.ObjectLiteralExpression },
                },
              ],
            },
          },
        },
      ]),
    };
    mockChecker.getSymbolAtLocation.mockReturnValue(mockSymbol2);
    varVisitor(mockVarStmtDestructure, mockContext);
    // Should attempt symbol resolution for destructuring pattern
    expect(mockChecker.getSymbolAtLocation).toHaveBeenCalledWith(
      mockVarStmtDestructure.declarationList.declarations[0].initializer.expression,
    );
    // Should call getDeclarations on the resolved symbol
    expect(mockSymbol2.getDeclarations).toHaveBeenCalled();

    // Test 7: Verify that return statement visitor exists and is callable
    const returnVisitor = visitors[ts.SyntaxKind.ReturnStatement] as (
      node: any,
      context: any,
    ) => any;
    expect(typeof returnVisitor).toBe("function");

    // Test 8: Verify ReturnStatement visitor returns undefined for non-CallExpression returns
    const mockReturnStmt: any = {
      kind: ts.SyntaxKind.ReturnStatement,
      expression: { kind: ts.SyntaxKind.NumericLiteral, text: "42" },
    };
    const returnResult = returnVisitor(mockReturnStmt, mockContext);
    expect(returnResult).toBeUndefined();

    // Test 9: Verify FunctionDeclaration visitor exists and is callable
    const funcDeclVisitor = visitors[ts.SyntaxKind.FunctionDeclaration] as (
      node: any,
      context: any,
    ) => any;
    expect(typeof funcDeclVisitor).toBe("function");

    // Test 10: Verify FunctionDeclaration visitor returns undefined for normal functions
    // (visitor only affects @inline-decorated module-scope non-exported functions)
    const mockFuncDeclNormal: any = {
      kind: ts.SyntaxKind.FunctionDeclaration,
      name: { text: "normalFn" },
    };
    const funcDeclResult = funcDeclVisitor(mockFuncDeclNormal, mockContext);
    // Should return undefined (let default transformer handle it)
    expect(funcDeclResult).toBeUndefined();

    // Test 11: Verify that contexts with diagnostics array work correctly
    // (exercises diagnostics handling in inlining failures)
    const mockContextWithDiags: any = {
      diagnostics: [],
      nextSymbolId: vi.fn().mockReturnValue(2),
      transformExpression: vi.fn((expr) => expr),
      transformStatements: vi.fn((stmts) => stmts),
      superTransformStatements: vi.fn((stmts) => stmts),
      superTransformExpression: vi.fn((expr) => expr),
    };
    mockChecker.getSymbolAtLocation.mockClear();
    mockChecker.getSymbolAtLocation.mockReturnValue(undefined);
    const resultWithDiags = varVisitor(mockVarStmtCall, mockContextWithDiags);
    expect(resultWithDiags).toBeUndefined();
    // Verify context diagnostics array is accessible for error reporting
    expect(mockContextWithDiags.diagnostics).toStrictEqual([]);
  });
});
