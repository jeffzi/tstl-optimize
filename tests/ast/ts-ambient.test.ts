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
    const moduleDecl = sourceFile.statements[0] as ts.ModuleDeclaration;
    const moduleBody = moduleDecl.body as ts.ModuleBlock;
    return moduleBody.statements[0] as ts.VariableStatement;
  }
  return sourceFile.statements[0] as
    | ts.VariableStatement
    | ts.FunctionDeclaration
    | ts.ModuleDeclaration;
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
