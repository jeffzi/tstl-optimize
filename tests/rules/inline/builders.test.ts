import ts from "typescript";
import { describe, expect, it } from "vitest";
import { bodyDeclaresLocal } from "../../../src/rules/inline/builders";

function varStmt(name: string): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(ts.factory.createIdentifier(name)),
    ]),
  );
}

describe("bodyDeclaresLocal", () => {
  describe("when an if statement has a non-block then branch", () => {
    it("returns true when the non-Block thenStatement declares the name", () => {
      const ifStmt = ts.factory.createIfStatement(ts.factory.createTrue(), varStmt("x"), undefined);
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(true);
    });
  });

  describe("when an if statement has no else branch", () => {
    it("returns false when thenStatement does not declare the name and there is no else", () => {
      const ifStmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        undefined,
      );
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(false);
    });
  });

  describe("when an if statement has a non-block else branch", () => {
    it.each([
      { elseName: "x", expected: true },
      { elseName: "y", expected: false },
    ])("returns $expected when the else branch declares $elseName", ({ elseName, expected }) => {
      const ifStmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        varStmt(elseName),
      );
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(expected);
    });
  });

  describe("when a loop has a non-block body", () => {
    it("returns true when the non-Block while-loop body declares the name", () => {
      const whileStmt = ts.factory.createWhileStatement(ts.factory.createTrue(), varStmt("x"));
      expect(bodyDeclaresLocal([whileStmt], "x")).toBe(true);
    });
  });

  describe("when a try statement has a finally block without the name", () => {
    it("returns false when finallyBlock is present but contains a different name", () => {
      const tryStmt = ts.factory.createTryStatement(
        ts.factory.createBlock([]),
        undefined,
        ts.factory.createBlock([varStmt("y")]),
      );
      expect(bodyDeclaresLocal([tryStmt], "x")).toBe(false);
    });
  });
});
