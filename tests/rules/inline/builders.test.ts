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
  describe("IfStatement — thenStatement is not a Block", () => {
    it("returns true when the non-Block thenStatement declares the name", () => {
      const ifStmt = ts.factory.createIfStatement(ts.factory.createTrue(), varStmt("x"), undefined);
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(true);
    });
  });

  describe("IfStatement — no elseStatement", () => {
    it("returns false when thenStatement does not declare the name and there is no else", () => {
      const ifStmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        undefined,
      );
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(false);
    });
  });

  describe("IfStatement — elseStatement is not a Block", () => {
    it("returns true when the non-Block elseStatement declares the name", () => {
      const ifStmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        varStmt("x"),
      );
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(true);
    });

    it("returns false when the non-Block elseStatement does not declare the name", () => {
      const ifStmt = ts.factory.createIfStatement(
        ts.factory.createTrue(),
        ts.factory.createBlock([]),
        varStmt("y"),
      );
      expect(bodyDeclaresLocal([ifStmt], "x")).toBe(false);
    });
  });

  describe("loop statement — body is not a Block", () => {
    it("returns true when the non-Block while-loop body declares the name", () => {
      const whileStmt = ts.factory.createWhileStatement(ts.factory.createTrue(), varStmt("x"));
      expect(bodyDeclaresLocal([whileStmt], "x")).toBe(true);
    });
  });

  describe("TryStatement — finallyBlock exists but does not declare the name", () => {
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
