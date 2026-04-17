import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  containsConditionalCaseBreak,
  shouldPreserveFoldedBlock,
} from "../../../src/rules/conditional-compilation/fold-safety";

function parseSource(code: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
}

describe("shouldPreserveFoldedBlock", () => {
  describe("when owner is inside a namespace (ModuleBlock parent)", () => {
    it("returns true because parent is not SourceFile or Block", () => {
      // The if-statement's parent is a ModuleBlock — neither SourceFile nor Block.
      // hasFollowingSiblingStatements returns true for unrecognised parent types.
      // The block uses `let` to satisfy blockRequiresScope.
      const source = parseSource("namespace Foo { if (true) { let x = 1; } }");
      const ns = source.statements[0] as ts.ModuleDeclaration;
      const moduleBlock = ns.body as ts.ModuleBlock;
      const ifStmt = moduleBlock.statements[0] as ts.IfStatement;
      const block = ifStmt.thenStatement as ts.Block;

      expect(shouldPreserveFoldedBlock(block, ifStmt)).toBe(true);
    });
  });
});

describe("containsConditionalCaseBreak", () => {
  describe("IfStatement with else-clause containing a break", () => {
    it("returns true when the else-clause directly contains a break", () => {
      const stmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        ts.factory.createBreakStatement(),
      );
      expect(containsConditionalCaseBreak([stmt])).toBe(true);
    });
  });

  describe("labeled statement containing a break", () => {
    it("returns true — the break inside the label is conditional from the switch perspective", () => {
      const labeledStmt = ts.factory.createLabeledStatement(
        ts.factory.createIdentifier("outer"),
        ts.factory.createBreakStatement(),
      );
      expect(containsConditionalCaseBreak([labeledStmt])).toBe(true);
    });

    it("returns true when labeled statement wraps a block with a break", () => {
      const breakInBlock = ts.factory.createBlock([ts.factory.createBreakStatement()]);
      const labeledStmt = ts.factory.createLabeledStatement(
        ts.factory.createIdentifier("lbl"),
        breakInBlock,
      );
      expect(containsConditionalCaseBreak([labeledStmt])).toBe(true);
    });

    it("returns false when labeled statement body contains no break", () => {
      const labeledStmt = ts.factory.createLabeledStatement(
        ts.factory.createIdentifier("outer"),
        ts.factory.createBlock([]),
      );
      expect(containsConditionalCaseBreak([labeledStmt])).toBe(false);
    });
  });
});
