// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use any for internal TS/TSTL types
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createVisitors } from "../../src/rules/math-intrinsics";
import { compile, normalizeLua } from "../helpers";

describe("math-intrinsics coverage", () => {
  it("Lines 83, 87, 92: Math methods with wrong number of arguments (manual visitor test)", () => {
    // Manually trigger the visitor with mock nodes that have wrong arg counts
    const mockChecker: any = {
      getSymbolAtLocation: vi.fn().mockReturnValue({}),
      getTypeOfSymbol: vi.fn().mockReturnValue({}),
      typeToString: vi.fn().mockReturnValue("Math"),
    };
    const mockContext: any = {
      transformExpression: vi.fn(),
      superTransformNode: vi.fn(),
    };

    const visitors = createVisitors(mockChecker, { rules: {} } as any);
    const visitor = (visitors as any)[ts.SyntaxKind.CallExpression];

    function createMockCall(methodName: string, argCount: number) {
      return {
        kind: ts.SyntaxKind.CallExpression,
        expression: {
          kind: ts.SyntaxKind.PropertyAccessExpression,
          name: { text: methodName, kind: ts.SyntaxKind.Identifier },
          expression: { kind: ts.SyntaxKind.Identifier, text: "Math" },
        },
        arguments: {
          length: argCount,
          [Symbol.iterator]: function* () {
            for (let i = 0; i < argCount; i++) {
              yield { kind: ts.SyntaxKind.NumericLiteral };
            }
          },
          some: Array.prototype.some,
          filter: Array.prototype.filter,
          map: Array.prototype.map,
          forEach: Array.prototype.forEach,
        },
      } as any;
    }

    expect(visitor(createMockCall("sqrt", 2), mockContext)).toBeUndefined();
    expect(visitor(createMockCall("floor", 2), mockContext)).toBeUndefined();
    expect(visitor(createMockCall("abs", 2), mockContext)).toBeUndefined();
    expect(visitor(createMockCall("max", 1), mockContext)).toBeUndefined();
    expect(visitor(createMockCall("min", 3), mockContext)).toBeUndefined();
    expect(visitor(createMockCall("unknown", 1), mockContext)).toBeUndefined();
  });

  it("Line 119: CallExpression kind mismatch", () => {
    const visitors = createVisitors({} as any, { rules: {} } as any);
    const visitor = (visitors as any)[ts.SyntaxKind.CallExpression];
    // Passing a node that is NOT a CallExpression
    const result = visitor({ kind: ts.SyntaxKind.BinaryExpression }, {} as any);
    expect(result).toBeUndefined();
  });

  it("Line 129: BinaryExpression kind mismatch", () => {
    const visitors = createVisitors({} as any, { rules: {} } as any);
    const visitor = (visitors as any)[ts.SyntaxKind.BinaryExpression];
    // Passing a node that is NOT a BinaryExpression
    const result = visitor({ kind: ts.SyntaxKind.CallExpression }, {} as any);
    expect(result).toBeUndefined();
  });

  it("math methods with side effects", () => {
    const code = `
      declare function get(): number;
      const a = Math.floor(get());
      const b = Math.abs(get());
      const c = Math.max(get(), 1);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("math.floor");
    expect(lua).toContain("math.abs");
    expect(lua).toContain("math.max");
  });
});
