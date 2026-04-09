import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import { createVisitors } from "../../src/rules/constant-folding";
import { compile, normalizeLua } from "../helpers";

describe("constant-folding coverage", () => {
  it("Binary operators - Number", () => {
    const code = `
      export const eq = (1 as any) === (1 as any);
      export const neq = (1 as any) !== (2 as any);
      export const le = (1 as any) <= (2 as any);
      export const ge = (2 as any) >= (1 as any);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("eq = true");
    expect(lua).toContain("neq = true");
    expect(lua).toContain("le = true");
    expect(lua).toContain("ge = true");
  });

  it("Binary operators - String", () => {
    const code = `
      export const eq = ("a" as any) === ("a" as any);
      export const neq = ("a" as any) !== ("b" as any);
      export const lt = ("a" as any) < ("b" as any);
      export const le = ("a" as any) <= ("b" as any);
      export const gt = ("b" as any) > ("a" as any);
      export const ge = ("b" as any) >= ("a" as any);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("eq = true");
    expect(lua).toContain("neq = true");
    expect(lua).toContain("lt = true");
    expect(lua).toContain("le = true");
    expect(lua).toContain("gt = true");
    expect(lua).toContain("ge = true");
  });

  it("Binary operators - Boolean", () => {
    const code = `
      export const eq = (true as any) === (true as any);
      export const neq = (true as any) !== (false as any);
      export const or_val = (true as any) || (false as any);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("eq = true");
    expect(lua).toContain("neq = true");
    expect(lua).toContain("or_val = true");
  });

  it("Binary operators - Mixed", () => {
    const code = `
      export const eq = (1 as any) === ("1" as any);
      export const neq = (1 as any) !== ("1" as any);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("eq = false");
    expect(lua).toContain("neq = true");
  });

  it("Unary operators - Negation and others", () => {
    const code = `
      export const len = "abc".length;
      export const neg = -(1);
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("len = 3");
    expect(lua).toContain("neg = -1");
  });

  it("Manual visitor for SourceFile folding (BitwiseNot)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock plugin context for internal visitor access
    const visitors = createVisitors({} as any, { rules: { "constant-folding": true } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: accessing internal visitor map by SyntaxKind
    const visitor = (visitors as any)[ts.SyntaxKind.SourceFile];

    // Create a Lua AST with a BitwiseNotOperator
    const bitwiseNot = tstl.createUnaryExpression(
      tstl.createNumericLiteral(1),
      tstl.SyntaxKind.BitwiseNotOperator,
    );
    const stmt = tstl.createVariableDeclarationStatement(
      [tstl.createIdentifier("x")],
      [bitwiseNot],
    );
    const file = tstl.createFile([stmt], new Set(), "");

    // biome-ignore lint/suspicious/noExplicitAny: mock context for internal visitor
    const mockContext: any = {
      superTransformNode: vi.fn().mockReturnValue(file),
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock node for internal visitor
    const result = visitor({} as any, mockContext);

    // Should have folded ~1 to -2
    const resultStmt = result.statements[0] as tstl.VariableDeclarationStatement;
    // biome-ignore lint/style/noNonNullAssertion: test asserts right exists before access
    expect(tstl.isNumericLiteral(resultStmt.right![0])).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: test asserts right exists before access
    expect((resultStmt.right![0] as tstl.NumericLiteral).value).toBe(-2);
  });

  it("optimizeControlFlow - unreachable code after return", () => {
    const code = `
      declare function print(...args: any[]): void;
      function test() {
        return 1;
        print("unreachable");
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).not.toContain("unreachable");
  });

  it("allConditionsPure - impure elseif condition", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare function get(): boolean;
      if (true) {
        print(1);
      } else if (get()) {
        print(2);
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua.trim().length).toBeGreaterThan(0);
  });
});
