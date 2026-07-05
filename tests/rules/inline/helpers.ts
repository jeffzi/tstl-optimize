import ts from "typescript";
import { expect } from "vitest";
import { compileMultiFileWithDiagnostics, normalizeLua } from "../../helpers";

export const CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC = 90003;

/**
 * Creates a single-file TypeScript program with strict mode enabled.
 * Use for unit tests that exercise pure type-system behavior without module resolution.
 */
export function makeChecker(source: string): {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const fileName = "test.ts";
  const host = ts.createCompilerHost({});
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) =>
    name === fileName
      ? ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
      : originalGetSourceFile(name, lang);
  const program = ts.createProgram([fileName], { strict: true }, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error("expected source file");
  return { checker: program.getTypeChecker(), sourceFile };
}

/**
 * Creates a multi-file TypeScript program with CommonJS/Node10 module resolution.
 * Use for tests that need cross-module import/export analysis.
 */
export function makeMultiFileChecker(
  files: Record<string, string>,
  rootFile: string,
): {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const host = ts.createCompilerHost({ moduleResolution: ts.ModuleResolutionKind.Node10 });
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) =>
    files[name]
      ? ts.createSourceFile(name, files[name], ts.ScriptTarget.Latest, true)
      : originalGetSourceFile(name, lang);
  const program = ts.createProgram(
    Object.keys(files),
    {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
    },
    host,
  );
  const sourceFile = program.getSourceFile(rootFile);
  if (!sourceFile) throw new Error("expected source file");
  return { checker: program.getTypeChecker(), sourceFile };
}

export function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T | undefined {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => findNode(child, predicate));
}

export function hasDiagnosticCode(diagnostics: { code?: number }[], code: number): boolean {
  return diagnostics.some((d) => d.code === code);
}

function compileMultiFile(
  files: Record<string, string>,
  options?: Parameters<typeof compileMultiFileWithDiagnostics>[1],
): {
  diagnostics: { code?: number }[];
  normalized: string;
} {
  const { lua, diagnostics } = compileMultiFileWithDiagnostics(files, options);
  return { diagnostics, normalized: normalizeLua(lua) };
}

export function compileAndExpectNoDiagnostics(files: Record<string, string>): string {
  const { diagnostics, normalized } = compileMultiFile(files);
  expect(diagnostics).toHaveLength(0);
  return normalized;
}

export function compileAndExpectCrossModuleDiagnostic(files: Record<string, string>): string {
  const { diagnostics, normalized } = compileMultiFile(files, {
    pluginOptions: { rules: { inline: { warnCrossModule: true } } },
  });
  expect(hasDiagnosticCode(diagnostics, CROSS_MODULE_CONST_LITERAL_DIAGNOSTIC)).toBe(true);
  return normalized;
}
