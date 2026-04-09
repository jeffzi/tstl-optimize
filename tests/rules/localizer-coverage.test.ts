// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use any for internal TS/TSTL types
import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it, vi } from "vitest";
import { createVisitors } from "../../src/rules/localizer";
import { compile, normalizeLua } from "../helpers";

describe("localizer coverage", () => {
  it("Lines 139-143, 147, 151, 154: hasNestedFunctionExit branches", () => {
    // Need a loop where hoistArrayElements is called.
    // Must NOT have call expressions.
    // Must have profitable array access (threshold default is 2).
    const code = `
      function test(x: number, arr: number[]) {
        for (let i = 0; i < 10; i++) {
          if ((x as any) === 1) {
             if ((x as any) === 2) {} else if ((x as any) === 3) { return; }
          }
          if ((x as any) === 4) {
             if ((x as any) === 5) {} else { return; }
          }
          do { if ((x as any) === 6) return; } while(false);
          while ((x as any) === 7) { return; }
          for (const k in {} as any) { return; }
          
          arr[i] = arr[i] + 1;
          arr[i] = arr[i] + 1;
        }
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });

  // GotoStatement is not directly emittable from TypeScript syntax.
  // Line 136 of localizer.ts handles isGotoStatement but cannot be reached via TS input.
  it.todo("Lines 136: GotoStatement in hasNestedFunctionExit");

  it("Lines 177, 181, 184: hasEarlyExit branches", () => {
    const code = `
      function test(x: number, arr: number[]) {
        for (let i = 0; i < 10; i++) {
          if ((x as any) === 1) {
            do { return; } while(false);
          }
          if ((x as any) === 2) {
            while ((x as any) === 3) { return; }
          }
          if ((x as any) === 4) {
            for (let j = 0; j < 10; j++) { return; }
          }
          arr[i] = arr[i] + 1;
          arr[i] = arr[i] + 1;
        }
      }
    `;
    const lua = normalizeLua(compile(code));
    expect(lua).toContain("arr[i + 1] = arr[i + 1] + 1");
    expect(lua).not.toContain("local ____arr");
  });

  it("Lines 431-437: createVisitors SourceFile fallback", () => {
    const mockContext: any = {
      superTransformNode: vi.fn().mockReturnValue(undefined),
      superTransformStatements: vi.fn().mockReturnValue([]),
      usedLuaLibFeatures: new Set(),
      options: { rules: { localizer: {} } },
    };
    const mockNode: any = {
      kind: ts.SyntaxKind.SourceFile,
      statements: [],
      getSourceFile: vi.fn().mockReturnValue({ fileName: "test.ts" }),
      parent: undefined,
    };

    const visitors = createVisitors({} as any, { rules: { localizer: {} } } as any);
    const visitor = visitors[ts.SyntaxKind.SourceFile];
    if (typeof visitor === "function") {
      const result = visitor(mockNode, mockContext);
      expect(tstl.isFile(result as any)).toBe(true);
    }
  });

  it("SourceFile fallback with statements", () => {
    const mockContext: any = {
      superTransformNode: vi.fn().mockReturnValue(undefined),
      superTransformStatements: vi.fn().mockReturnValue([tstl.createDoStatement([])]),
      usedLuaLibFeatures: new Set(),
      options: { rules: { localizer: {} } },
    };
    const mockNode: any = {
      kind: ts.SyntaxKind.SourceFile,
      statements: [{} as any],
      getSourceFile: vi.fn().mockReturnValue({ fileName: "test.ts" }),
      parent: undefined,
    };

    const visitors = createVisitors({} as any, { rules: { localizer: {} } } as any);
    const visitor = visitors[ts.SyntaxKind.SourceFile];
    if (typeof visitor === "function") {
      const result = visitor(mockNode, mockContext);
      expect(tstl.isFile(result as any)).toBe(true);
      expect((result as any).statements.length).toBeGreaterThan(0);
    }
  });
});
