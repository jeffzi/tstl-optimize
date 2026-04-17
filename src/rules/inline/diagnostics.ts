import ts from "typescript";

export function createInlineWarning(
  node: ts.CallExpression,
  reason: string,
  strict: boolean,
): ts.Diagnostic {
  return {
    file: node.getSourceFile(),
    start: node.getStart(),
    length: node.getWidth(),
    messageText: `@inline ignored: ${reason}`,
    category: strict ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
    code: 90001,
    source: "tstl-optimize",
  };
}
