import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  containsBreakOrReturn,
  containsConditionalCaseBreak,
  shouldPreserveFoldedBlock,
} from "../../../src/rules/conditional-compilation/fold-safety";

function parseSource(code: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
}

describe("shouldPreserveFoldedBlock", () => {
  describe("when owner is inside a namespace (ModuleBlock parent)", () => {
    it("returns true", () => {
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
  describe("when else-clause directly contains a break", () => {
    it("returns true when the else-clause directly contains a break", () => {
      const stmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        ts.factory.createBreakStatement(),
      );
      expect(containsConditionalCaseBreak([stmt])).toBe(true);
    });
  });

  describe("when input contains a labeled statement", () => {
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

  describe("when input has only a top-level break statement", () => {
    it("returns false for a direct top-level break (not inside a conditional)", () => {
      // A top-level break in the case body is unconditional — not a conditional case break.
      expect(containsConditionalCaseBreak([ts.factory.createBreakStatement()])).toBe(false);
    });
  });

  describe("when input contains a try-statement", () => {
    it("returns true when the try-block contains a break", () => {
      const tryStmt = ts.factory.createTryStatement(
        ts.factory.createBlock([ts.factory.createBreakStatement()]),
        undefined,
        undefined,
      );
      expect(containsConditionalCaseBreak([tryStmt])).toBe(true);
    });

    it("returns true when the catch-clause contains a break", () => {
      const tryStmt = ts.factory.createTryStatement(
        ts.factory.createBlock([]),
        ts.factory.createCatchClause(
          undefined,
          ts.factory.createBlock([ts.factory.createBreakStatement()]),
        ),
        undefined,
      );
      expect(containsConditionalCaseBreak([tryStmt])).toBe(true);
    });

    it("returns true when the finally-block contains a break", () => {
      const tryStmt = ts.factory.createTryStatement(
        ts.factory.createBlock([]),
        undefined,
        ts.factory.createBlock([ts.factory.createBreakStatement()]),
      );
      expect(containsConditionalCaseBreak([tryStmt])).toBe(true);
    });

    it("returns false when no clause contains a break", () => {
      const tryStmt = ts.factory.createTryStatement(
        ts.factory.createBlock([]),
        ts.factory.createCatchClause(
          undefined,
          ts.factory.createBlock([ts.factory.createReturnStatement()]),
        ),
        ts.factory.createBlock([]),
      );
      expect(containsConditionalCaseBreak([tryStmt])).toBe(false);
    });
  });
});

describe("containsBreakOrReturn", () => {
  it.each([
    { name: "break", stmt: ts.factory.createBreakStatement() },
    { name: "continue", stmt: ts.factory.createContinueStatement() },
    { name: "return", stmt: ts.factory.createReturnStatement() },
    { name: "throw", stmt: ts.factory.createThrowStatement(ts.factory.createStringLiteral("e")) },
  ])("returns true for a top-level $name statement", ({ stmt }) => {
    expect(containsBreakOrReturn([stmt])).toBe(true);
  });

  it("returns true when a break appears inside a nested block", () => {
    const block = ts.factory.createBlock([ts.factory.createBreakStatement()]);
    expect(containsBreakOrReturn([block])).toBe(true);
  });

  it("returns false for an empty statement list", () => {
    expect(containsBreakOrReturn([])).toBe(false);
  });

  it("returns false when a break is inside an if-statement (conditional — does not stop fallthrough)", () => {
    const ifStmt = ts.factory.createIfStatement(
      ts.factory.createTrue(),
      ts.factory.createBlock([ts.factory.createBreakStatement()]),
    );
    expect(containsBreakOrReturn([ifStmt])).toBe(false);
  });
});
