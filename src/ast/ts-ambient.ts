import ts from "typescript";

/**
 * Returns true iff `node` is a direct child of a SourceFile AND has the
 * `declare` modifier. Does NOT check whether the source file is a .d.ts file
 * — that widening is left to callers.
 */
export function isExplicitAmbientTopLevelDeclaration(
  node: ts.VariableStatement | ts.FunctionDeclaration | ts.ModuleDeclaration,
): boolean {
  if (!ts.isSourceFile(node.parent)) {
    return false;
  }

  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false)
  );
}
