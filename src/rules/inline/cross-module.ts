import ts from "typescript";
import type * as tstl from "typescript-to-lua";
import { createInlineWarning } from "./diagnostics";
import type { InlineTarget } from "./target";

export function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

export function hasCrossModuleFreeVariable(
  nodes: readonly ts.Node[],
  params: readonly ts.ParameterDeclaration[],
  sourceDeclaration: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const sourceFile = sourceDeclaration.getSourceFile();
  const paramSymbols = new Set(
    params
      .map((p) => checker.getSymbolAtLocation(p.name))
      .filter((s): s is ts.Symbol => s !== undefined),
  );

  let found = false;

  function walk(node: ts.Node): void {
    if (found) return;
    // Type annotations don't emit to Lua — skip them to avoid false positives
    // from type-only references (e.g., `param: SomeType` where SomeType is a
    // module-level type alias).
    if (ts.isTypeNode(node)) return;
    if (ts.isPropertyAccessExpression(node)) {
      walk(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym && !paramSymbols.has(sym)) {
        const symbolsToCheck = [sym];
        if (sym.flags & ts.SymbolFlags.Alias) {
          symbolsToCheck.push(checker.getAliasedSymbol(sym));
        }
        for (const symbolToCheck of symbolsToCheck) {
          const decls = symbolToCheck.getDeclarations();
          if (!decls) continue;
          for (const decl of decls) {
            if (decl.getSourceFile() === sourceFile && !isDescendant(decl, sourceDeclaration)) {
              found = true;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  for (const node of nodes) {
    walk(node);
    if (found) break;
  }
  return found;
}

/**
 * If the call crosses module boundaries and the target has free variables from the source module,
 * pushes a diagnostic and returns true (caller should return undefined).
 */
export function rejectIfCrossModuleFreeVar(
  callNode: ts.CallExpression,
  target: InlineTarget,
  nodes: readonly ts.Node[],
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
  strict: boolean,
): boolean {
  const isCrossModule =
    callNode.getSourceFile().fileName !== target.declaration.getSourceFile().fileName;
  if (
    isCrossModule &&
    hasCrossModuleFreeVariable(nodes, target.params, target.declaration, checker)
  ) {
    context.diagnostics.push(
      createInlineWarning(
        callNode,
        "cross-module function references non-parameter identifiers",
        strict,
      ),
    );
    return true;
  }
  return false;
}
