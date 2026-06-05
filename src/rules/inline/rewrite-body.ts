import ts from "typescript";
import { type ImportBinding, type LiteralKind, synthesizeLiteralExpression } from "./const-literal";

/**
 * Rewrites a TypeScript node, substituting identifiers that map to const literals or
 * import require-chain bindings.
 *
 * - Skips type nodes (which don't emit to Lua)
 * - Avoids rewriting property names (only the object side of property access)
 * - Resolves symbols and their aliases, looking up in substitutions and imports
 * - Literal substitutions (`substitutions`) take priority over import substitutions (`imports`)
 * - Synthesized require nodes are terminal — the visitor does not recurse into them
 * - Returns a fresh node with substitutions applied (deep rewrite via ts.transform)
 *
 * If both `substitutions` and `imports` are empty/absent, returns the node unchanged (fast path).
 */
export function rewriteWithConstSubstitutions<T extends ts.Node>(
  node: T,
  substitutions: Map<ts.Symbol, LiteralKind>,
  checker: ts.TypeChecker,
  imports?: ReadonlyMap<ts.Symbol, ImportBinding>,
  skipSymbols?: ReadonlySet<ts.Symbol>,
): T {
  if (substitutions.size === 0 && (!imports || imports.size === 0)) {
    return node;
  }

  let transformCtx: ts.TransformationContext;

  function findSubstitution(sym: ts.Symbol): LiteralKind | undefined {
    const symbolsToCheck =
      sym.flags & ts.SymbolFlags.Alias ? [sym, checker.getAliasedSymbol(sym)] : [sym];

    for (const symbolToCheck of symbolsToCheck) {
      const literal = substitutions.get(symbolToCheck);
      if (literal !== undefined) {
        return literal;
      }
    }

    return undefined;
  }

  function findImportSubstitution(sym: ts.Symbol): ImportBinding | undefined {
    if (!imports || imports.size === 0) return undefined;

    const symbolsToCheck =
      sym.flags & ts.SymbolFlags.Alias ? [sym, checker.getAliasedSymbol(sym)] : [sym];

    for (const symbolToCheck of symbolsToCheck) {
      // When the consumer already has an in-scope local for this binding,
      // skip synthesizing a fresh require chain — let TSTL resolve it via symbolIdMaps.
      if (skipSymbols?.has(symbolToCheck) === true) return undefined;

      const binding = imports.get(symbolToCheck);
      if (binding !== undefined) {
        return binding;
      }
    }

    return undefined;
  }

  function synthesizeRequireExpression(binding: ImportBinding): ts.Expression {
    const requireCall = ts.factory.createCallExpression(
      ts.factory.createIdentifier("require"),
      undefined,
      [ts.factory.createStringLiteral(binding.requirePath)],
    );

    if (binding.memberName !== undefined) {
      return ts.factory.createPropertyAccessExpression(requireCall, binding.memberName);
    }

    return requireCall;
  }

  function visit(n: ts.Node): ts.Node {
    // Skip type nodes — they don't emit to Lua
    if (ts.isTypeNode(n)) {
      return n;
    }

    // On property access, only rewrite the object side, not the property name
    if (ts.isPropertyAccessExpression(n)) {
      const rewrittenExpr = ts.visitNode(n.expression, visit);
      /* v8 ignore next -- property-access expressions only visit expression children */
      if (!rewrittenExpr || !ts.isExpression(rewrittenExpr)) return n;
      return ts.factory.updatePropertyAccessExpression(n, rewrittenExpr, n.name);
    }

    if (ts.isPropertyAssignment(n)) {
      const rewrittenInitializer = ts.visitNode(n.initializer, visit);
      /* v8 ignore next -- property assignments only visit expression initializers */
      if (!rewrittenInitializer || !ts.isExpression(rewrittenInitializer)) return n;

      if (ts.isComputedPropertyName(n.name)) {
        const rewrittenName = ts.visitNode(n.name.expression, visit);
        /* v8 ignore next -- computed property names only visit expression children */
        if (!rewrittenName || !ts.isExpression(rewrittenName)) {
          return ts.factory.updatePropertyAssignment(n, n.name, rewrittenInitializer);
        }
        return ts.factory.updatePropertyAssignment(
          n,
          ts.factory.updateComputedPropertyName(n.name, rewrittenName),
          rewrittenInitializer,
        );
      }

      return ts.factory.updatePropertyAssignment(n, n.name, rewrittenInitializer);
    }

    if (ts.isShorthandPropertyAssignment(n)) {
      const sym =
        checker.getShorthandAssignmentValueSymbol(n) ?? checker.getSymbolAtLocation(n.name);
      if (sym) {
        const literal = findSubstitution(sym);
        if (literal !== undefined) {
          return ts.factory.createPropertyAssignment(n.name, synthesizeLiteralExpression(literal));
        }
      }

      const rewrittenInitializer = n.objectAssignmentInitializer
        ? ts.visitNode(n.objectAssignmentInitializer, visit)
        : undefined;
      /* v8 ignore next -- shorthand initializers are expression children when present */
      if (rewrittenInitializer !== undefined && !ts.isExpression(rewrittenInitializer)) return n;
      return ts.factory.updateShorthandPropertyAssignment(n, n.name, rewrittenInitializer);
    }

    if (ts.isIdentifier(n)) {
      const sym = checker.getSymbolAtLocation(n);
      /* v8 ignore next -- synthetic nodes lack source positions */
      if (!sym) return n;

      // Literal substitution takes priority over import substitution
      const literal = findSubstitution(sym);
      if (literal !== undefined) {
        return synthesizeLiteralExpression(literal);
      }

      // Import substitution: synthesize require("path").member or bare require("path").
      // The synthesized node is terminal — do NOT recurse into it.
      const importBinding = findImportSubstitution(sym);
      if (importBinding !== undefined) {
        return synthesizeRequireExpression(importBinding);
      }

      return n;
    }

    return ts.visitEachChild(n, visit, transformCtx);
  }

  const result = ts.transform<T>(node, [
    (ctx) => {
      transformCtx = ctx;
      return (root) => ts.visitNode(root, visit) as T;
    },
  ]);
  const transformed = result.transformed[0];
  result.dispose();
  return transformed;
}
