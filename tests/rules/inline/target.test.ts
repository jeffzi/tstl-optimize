import ts from "typescript";
import { describe, expect, it } from "vitest";
import { declarationHasLuaMultiReturnReturnType } from "../../../src/rules/inline/target";

function createLuaMultiReturnTypeNode(): ts.TypeReferenceNode {
  return ts.factory.createTypeReferenceNode("LuaMultiReturn", undefined);
}

function createArrowFunction(returnType: ts.TypeNode | undefined): ts.ArrowFunction {
  return ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    returnType,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createBlock([]),
  );
}

function createFunctionExpression(returnType: ts.TypeNode | undefined): ts.FunctionExpression {
  return ts.factory.createFunctionExpression(
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    returnType,
    ts.factory.createBlock([]),
  );
}

function createVariableDeclaration(
  name: string,
  initializer: ts.Expression | undefined,
): ts.VariableDeclaration {
  return ts.factory.createVariableDeclaration(name, undefined, undefined, initializer);
}

describe("declarationHasLuaMultiReturnReturnType", () => {
  describe("when the declaration is a variable initialized with an arrow function", () => {
    it.each([
      {
        caseName: "the arrow function returns LuaMultiReturn",
        returnType: createLuaMultiReturnTypeNode(),
        expected: true,
      },
      {
        caseName: "the arrow function omits an explicit return type",
        returnType: undefined,
        expected: false,
      },
      {
        caseName: "the arrow function returns a non-LuaMultiReturn type",
        returnType: ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        expected: false,
      },
    ])("returns $expected when $caseName", ({ returnType, expected }) => {
      const varDecl = createVariableDeclaration("fn", createArrowFunction(returnType));
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(expected);
    });
  });

  describe("when the declaration is a variable initialized with a function expression", () => {
    it("returns true when the function expression returns LuaMultiReturn", () => {
      const varDecl = createVariableDeclaration(
        "fn",
        createFunctionExpression(createLuaMultiReturnTypeNode()),
      );
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(true);
    });
  });

  describe("when the declaration is not initialized with an inlineable function", () => {
    it("returns false when initializer is a numeric literal", () => {
      const varDecl = createVariableDeclaration("x", ts.factory.createNumericLiteral(42));
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(false);
    });

    it("returns false when there is no initializer", () => {
      const varDecl = createVariableDeclaration("x", undefined);
      expect(declarationHasLuaMultiReturnReturnType(varDecl)).toBe(false);
    });
  });
});
