import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { describe, expect, it } from "vitest";
import {
  buildArrayDestructureInline,
  buildObjectDestructureInline,
} from "../../../src/rules/inline/destructure-builders";
import type { ReturnValueInlineTarget } from "../../../src/rules/inline/target";

// Real source file so all nodes have parent pointers and symbols resolve correctly
// through the TypeScript infrastructure used by prepareReturnValueInline.
const SOURCE = "function f(x: number): number { return x; }";
const sourceFile = ts.createSourceFile("test.ts", SOURCE, ts.ScriptTarget.Latest, true);
const firstStmt = sourceFile.statements[0];
if (!ts.isFunctionDeclaration(firstStmt)) throw new Error("expected function declaration");
const funcDecl = firstStmt;
const firstBodyStmt = funcDecl.body?.statements[0];
if (
  firstBodyStmt === undefined ||
  !ts.isReturnStatement(firstBodyStmt) ||
  !firstBodyStmt.expression
) {
  throw new Error("expected return statement with expression");
}
const returnExpr = firstBodyStmt.expression;

function makeTarget(): ReturnValueInlineTarget {
  return {
    kind: "statementsWithReturn",
    bodyStmts: [],
    returnExpr,
    params: funcDecl.parameters,
    declaration: funcDecl,
    resolvedSymbol: {} as ts.Symbol,
  };
}

function makeCallNode(): ts.CallExpression {
  return ts.factory.createCallExpression(ts.factory.createIdentifier("f"), undefined, [
    ts.factory.createNumericLiteral(1),
  ]);
}

// Checker that returns undefined for every symbol lookup, causing buildParamMap to fail.
function makeFailingChecker(overrides: Partial<ts.TypeChecker> = {}): ts.TypeChecker {
  return {
    getSymbolAtLocation: () => undefined,
    getResolvedSignature: () => undefined,
    getReturnTypeOfSignature: () => undefined,
    ...overrides,
  } as unknown as ts.TypeChecker;
}

// Minimal context sufficient for prepareReturnValueInline / transformInlineBodyAndReturn.
function makeContext(
  transformStatements?: (node: ts.Node) => tstl.Statement[],
): tstl.TransformationContext {
  let symId = 0;
  return {
    nextSymbolId: () => ++symId as tstl.SymbolId,
    symbolIdMaps: new Map(),
    transformExpression: () => tstl.createNilLiteral(),
    transformStatements: transformStatements ?? (() => []),
    pushScope: () => {},
    popScope: () => {},
  } as unknown as tstl.TransformationContext;
}

// Context whose transformStatements returns a valid ReturnStatement so that
// transformInlineBodyAndReturn succeeds (needed to reach the buildParamMap call
// inside the isMultiReturn block).
function makeContextWithReturn(): tstl.TransformationContext {
  return makeContext((node) => {
    if (ts.isReturnStatement(node)) {
      return [tstl.createReturnStatement([tstl.createNilLiteral()])];
    }
    return [];
  });
}

// Checker that reports the call returns LuaMultiReturn, but has no symbols for
// parameter lookups so buildParamMap fails inside the isMultiReturn block.
function makeMultiReturnFailingChecker(): ts.TypeChecker {
  return makeFailingChecker({
    getResolvedSignature: () => ({}) as unknown as ts.Signature,
    getReturnTypeOfSignature: () =>
      ({
        aliasSymbol: { name: "LuaMultiReturn" } as ts.Symbol,
      }) as unknown as ts.Type,
  });
}

describe("buildObjectDestructureInline", () => {
  describe("when buildParamMap cannot resolve a parameter symbol", () => {
    it("returns undefined", () => {
      const pattern = ts.factory.createObjectBindingPattern([
        ts.factory.createBindingElement(
          undefined,
          undefined,
          ts.factory.createIdentifier("a"),
          undefined,
        ),
      ]);

      const result = buildObjectDestructureInline(
        pattern,
        makeTarget(),
        makeCallNode(),
        makeFailingChecker(),
        makeContext(),
      );

      expect(result).toBeUndefined();
    });
  });
});

describe("buildArrayDestructureInline", () => {
  describe("when the return type is LuaMultiReturn but buildParamMap cannot resolve a symbol", () => {
    it("returns undefined", () => {
      const pattern = ts.factory.createArrayBindingPattern([
        ts.factory.createBindingElement(
          undefined,
          undefined,
          ts.factory.createIdentifier("a"),
          undefined,
        ),
        ts.factory.createBindingElement(
          undefined,
          undefined,
          ts.factory.createIdentifier("b"),
          undefined,
        ),
      ]);

      const result = buildArrayDestructureInline(
        pattern,
        makeTarget(),
        makeCallNode(),
        makeMultiReturnFailingChecker(),
        makeContextWithReturn(),
      );

      expect(result).toBeUndefined();
    });
  });

  describe("when the return type is not LuaMultiReturn and buildParamMap cannot resolve a symbol", () => {
    it("returns undefined", () => {
      const pattern = ts.factory.createArrayBindingPattern([
        ts.factory.createBindingElement(
          undefined,
          undefined,
          ts.factory.createIdentifier("a"),
          undefined,
        ),
      ]);

      const result = buildArrayDestructureInline(
        pattern,
        makeTarget(),
        makeCallNode(),
        makeFailingChecker(),
        makeContext(),
      );

      expect(result).toBeUndefined();
    });
  });
});
