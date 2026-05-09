import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isExplicitAmbientTopLevelDeclaration } from "../../src/ast/ts-ambient";

function parseSource(code: string, fileName = "test.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

function getTopLevelDeclaration(
  sourceFile: ts.SourceFile,
  code: string,
): ts.VariableStatement | ts.FunctionDeclaration | ts.ModuleDeclaration {
  if (code.includes("namespace")) {
    const first = sourceFile.statements[0];
    if (!first || !ts.isModuleDeclaration(first)) {
      throw new Error(
        `Expected ModuleDeclaration, got ${first ? ts.SyntaxKind[first.kind] : "nothing"}`,
      );
    }
    if (!first.body || !ts.isModuleBlock(first.body)) {
      throw new Error("Expected ModuleBlock body");
    }
    const inner = first.body.statements[0];
    if (!inner || !ts.isVariableStatement(inner)) {
      throw new Error(
        `Expected VariableStatement, got ${inner ? ts.SyntaxKind[inner.kind] : "nothing"}`,
      );
    }
    return inner;
  }
  const first = sourceFile.statements[0];
  if (
    !first ||
    (!ts.isVariableStatement(first) &&
      !ts.isFunctionDeclaration(first) &&
      !ts.isModuleDeclaration(first))
  ) {
    throw new Error("Expected VariableStatement | FunctionDeclaration | ModuleDeclaration");
  }
  return first;
}

describe("isExplicitAmbientTopLevelDeclaration", () => {
  it.each([
    {
      name: "declare const at top level of regular .ts file",
      fileName: "test.ts",
      code: "declare const X = 1;",
      shouldBeAmbient: true,
    },
    {
      name: "const without declare at top level",
      fileName: "test.ts",
      code: "const X = 1;",
      shouldBeAmbient: false,
    },
    {
      name: "declare const nested inside namespace",
      fileName: "test.ts",
      code: `declare namespace Foo {
  declare const X = 1;
}`,
      shouldBeAmbient: false,
    },
    {
      name: "const without declare in .d.ts file",
      fileName: "test.d.ts",
      code: "const X = 1;",
      shouldBeAmbient: false,
    },
  ])("$name", ({ fileName, code, shouldBeAmbient }) => {
    const sourceFile = parseSource(code, fileName);
    const targetNode = getTopLevelDeclaration(sourceFile, code);

    expect(isExplicitAmbientTopLevelDeclaration(targetNode)).toBe(shouldBeAmbient);
  });
});
