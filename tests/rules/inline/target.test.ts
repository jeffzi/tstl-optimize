import ts from "typescript";
import { describe, expect, it } from "vitest";
import { declarationHasLuaMultiReturnReturnType } from "../../../src/rules/inline/target";

const luaMultiReturnTypeNode = ts.factory.createTypeReferenceNode("LuaMultiReturn", undefined);

describe("declarationHasLuaMultiReturnReturnType", () => {
  describe("VariableDeclaration with arrow function initializer", () => {
    it("returns true when the arrow function has a LuaMultiReturn return type", () => {
      const arrowFn = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        luaMultiReturnTypeNode,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock([]),
      );
      const varDecl = ts.factory.createVariableDeclaration("fn", undefined, undefined, arrowFn);
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(true);
    });

    it("returns false when the arrow function has no explicit return type", () => {
      const arrowFn = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock([]),
      );
      const varDecl = ts.factory.createVariableDeclaration("fn", undefined, undefined, arrowFn);
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(false);
    });

    it("returns false when the arrow function return type is not LuaMultiReturn", () => {
      const arrowFn = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock([]),
      );
      const varDecl = ts.factory.createVariableDeclaration("fn", undefined, undefined, arrowFn);
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(false);
    });
  });

  describe("VariableDeclaration with function expression initializer", () => {
    it("returns true when the function expression has a LuaMultiReturn return type", () => {
      const fnExpr = ts.factory.createFunctionExpression(
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        luaMultiReturnTypeNode,
        ts.factory.createBlock([]),
      );
      const varDecl = ts.factory.createVariableDeclaration("fn", undefined, undefined, fnExpr);
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(true);
    });
  });

  describe("VariableDeclaration with non-function initializer", () => {
    it("returns false when initializer is a numeric literal", () => {
      const varDecl = ts.factory.createVariableDeclaration(
        "x",
        undefined,
        undefined,
        ts.factory.createNumericLiteral(42),
      );
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(false);
    });

    it("returns false when there is no initializer", () => {
      const varDecl = ts.factory.createVariableDeclaration("x", undefined, undefined, undefined);
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(false);
    });
  });
});
