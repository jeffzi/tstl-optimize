import ts from "typescript";

export const InlineDiagnosticCode = {
  generic: 90001,
  crossModule: 90003,
  recursion: 90004,
  parameterRestriction: 90005,
  sideEffects: 90006,
  controlFlow: 90007,
  moduleScope: 90008,
  voidSite: 90009,
  expressionPosition: 90010,
} as const;

export function createInlineWarning(
  node: ts.CallExpression,
  reason: string,
  strict: boolean,
  code: number = InlineDiagnosticCode.generic,
): ts.Diagnostic {
  return {
    file: node.getSourceFile(),
    start: node.getStart(),
    length: node.getWidth(),
    messageText: `@inline ignored: ${reason}`,
    category: strict ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
    code,
    source: "tstl-optimize",
  };
}
