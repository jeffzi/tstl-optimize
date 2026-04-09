import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createVisitors } from "../../src/rules/remove-empty-branch";
import { compile, normalizeLua } from "../helpers";

describe("remove-empty-branch coverage", () => {
  it("Line 58: pruneTrailingEmptyBranches - empty plain else", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const x: number;
      if (x === 1) {
        print(1);
      } else {
        // empty
      }
    `;
    const lua = normalizeLua(compile(code));
    // The empty else should be removed
    expect(lua).not.toContain("else\nend");
    expect(lua).toContain("if x == 1 then");
  });

  it("Line 72: pruneTrailingEmptyBranches - empty elseif with pure condition", () => {
    const code = `
      declare function print(...args: any[]): void;
      declare const x: number;
      if (x === 1) {
        print(1);
      } else if (x === 2) {
        // empty
      }
    `;
    const lua = normalizeLua(compile(code));
    // The empty elseif should be removed
    expect(lua).not.toContain("elseif x == 2 then");
  });

  it("Line 163-165: SourceFile visitor branches", () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock plugin context for internal visitor access
    const visitors = createVisitors({} as any, { rules: {} } as any);
    const visitor = visitors[ts.SyntaxKind.SourceFile];
    const transform = typeof visitor === "object" ? visitor.transform : undefined;

    if (transform) {
      // biome-ignore lint/suspicious/noExplicitAny: mock context for internal visitor
      const mockContext: any = {
        superTransformNode: vi.fn().mockReturnValue(undefined),
      };
      // biome-ignore lint/suspicious/noExplicitAny: mock node for internal visitor
      const mockNode: any = {};

      // Line 165: !file
      const result1 = transform(mockNode, mockContext);
      expect(result1).toBeUndefined();

      // Line 165: Array but no file
      mockContext.superTransformNode.mockReturnValue([undefined]);
      const result2 = transform(mockNode, mockContext);
      expect(result2).toBeUndefined();
    }
  });
});
