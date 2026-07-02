import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { withPositionFrom } from "../ast/deep-clone";
import { createLiteral, getLiteralValue } from "../ast/lua-literal";
import { forEachAccess } from "../ast/lua-references";
import { Walk, walkStatements } from "../ast/lua-walker";
import type { ConstantValue, RuleFactory } from "../config";
import { resolveConstLiteral } from "./inline/const-literal";
import { getTransformedFile } from "./source-file";

// Constant propagation: substitutes literal values for single-assignment locals.
//
// Intentional gaps:
// - nil propagation: ConstantValue is boolean | number | string; supporting nil
//   would require widening the type and auditing all consumers.
// - Closure capture: reads inside nested FunctionExpression bodies are conservatively
//   excluded even though single-assignment locals are provably safe. This simplifies
//   the rule and defends against future reassignment-detection bugs.

type Candidate = { value: ConstantValue; declStmt: tstl.VariableDeclarationStatement };

/**
 * Resolve and create a Lua literal from a TS symbol.
 * Handles both direct symbols and aliased re-exports.
 */
function createResolvedLiteral(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  sourceNode: ts.Node,
): tstl.Expression | undefined {
  if (symbol === undefined) {
    return undefined;
  }

  // Resolve aliases (re-exported members appear as aliases)
  const resolvedSymbol =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

  const resolvedLiteral = resolveConstLiteral(resolvedSymbol, checker);
  if (resolvedLiteral === undefined) {
    return undefined;
  }

  const luaLiteral = createLiteral(resolvedLiteral.value, { wrapNegativeNumber: true });
  tstl.setNodeOriginal(luaLiteral, sourceNode);
  return luaLiteral;
}

function propagateScope(statements: tstl.Statement[]): void {
  // Step 1: collect candidates — single-var declarations with literal initializers
  const candidates = new Map<number, Candidate>();

  for (const stmt of statements) {
    if (!tstl.isVariableDeclarationStatement(stmt)) continue;
    if (stmt.left.length !== 1 || stmt.right?.length !== 1) continue;

    const lhs = stmt.left[0];
    const rhs = stmt.right[0];
    const symbolId = lhs.symbolId;
    if (symbolId === undefined) continue;

    const value = getLiteralValue(rhs);
    if (value !== undefined) {
      candidates.set(symbolId, { value, declStmt: stmt });
    }
  }

  // Build a name→symbolId index so symbolId-less writes can conservatively
  // disqualify candidates that share the same declared name. No TS input
  // currently produces symbolId-less writes, but plugin-emitted code can
  // (see dead-local commit 53482b1 for the same bug class).
  /* v8 ignore start -- defensive: no TS-reachable path produces symbolId-less writes */
  const candidatesByName = new Map<string, number[]>();
  for (const [symbolId, candidate] of candidates) {
    const name = candidate.declStmt.left[0].text;
    const ids = candidatesByName.get(name);
    if (ids !== undefined) {
      ids.push(symbolId);
    } else {
      candidatesByName.set(name, [symbolId]);
    }
  }
  /* v8 ignore stop */

  // Step 2: filter — disqualify writes after declaration and reads in nested functions
  for (const stmt of statements) {
    forEachAccess(stmt, ({ identifier, kind, inFunctionBody }) => {
      const symbolId = identifier.symbolId;
      if (symbolId === undefined) {
        /* v8 ignore next 5 -- defensive: see candidatesByName comment above */
        if (kind === "write") {
          const ids = candidatesByName.get(identifier.text);
          if (ids !== undefined) {
            for (const id of ids) candidates.delete(id);
          }
        }
        return;
      }

      const candidate = candidates.get(symbolId);
      if (candidate === undefined) return;

      // Skip the declaration write itself
      if (kind === "write" && stmt === candidate.declStmt) {
        return;
      }

      // Remove if reassigned
      if (kind === "write") {
        candidates.delete(symbolId);
      }

      // Remove if read inside a nested function body (closure capture)
      if (kind === "read" && inFunctionBody) {
        candidates.delete(symbolId);
      }
    });
  }

  // Step 3: substitute — replace reads with literals
  walkStatements(statements, {
    shallow: true,
    expr: (expr) => {
      if (!tstl.isIdentifier(expr)) return Walk.keep;

      const symbolId = expr.symbolId;
      if (symbolId === undefined) return Walk.keep;

      const candidate = candidates.get(symbolId);
      if (candidate === undefined) return Walk.keep;

      const literal = createLiteral(candidate.value, { wrapNegativeNumber: true });
      return Walk.replace(withPositionFrom(literal, expr));
    },
  });

  // Step 4: recurse into nested function bodies
  walkStatements(statements, {
    shallow: true,
    expr: (expr) => {
      if (tstl.isFunctionExpression(expr)) {
        propagateScope(expr.body.statements);
        return Walk.skip;
      }
      return Walk.keep;
    },
  });
}

export const createVisitors: RuleFactory = (checker): tstl.Visitors => ({
  [ts.SyntaxKind.Identifier]: (
    node: ts.Identifier,
    context: tstl.TransformationContext,
  ): tstl.Expression => {
    // Resolve imported constant identifiers at the TS level.
    // If the identifier is an import alias for a const literal, create
    // the Lua literal directly, allowing it to feed into constant-folding
    // and other downstream rules.
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) {
      return context.superTransformExpression(node);
    }

    const literal = createResolvedLiteral(checker.getAliasedSymbol(symbol), checker, node);
    return literal ?? context.superTransformExpression(node);
  },
  [ts.SyntaxKind.PropertyAccessExpression]: (
    node: ts.PropertyAccessExpression,
    context: tstl.TransformationContext,
  ): tstl.Expression => {
    // Resolve namespace-import member accesses (import * as mod from '...'; mod.X).
    // The member symbol is obtained directly from the property access node; if it
    // is an alias (re-export) it is followed through to the original declaration.
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) {
      return context.superTransformExpression(node);
    }

    const literal = createResolvedLiteral(symbol, checker, node);
    return literal ?? context.superTransformExpression(node);
  },
  [ts.SyntaxKind.SourceFile]: (
    node: ts.SourceFile,
    context: tstl.TransformationContext,
  ): tstl.File => {
    const nodes = context.superTransformNode(node);
    const file = getTransformedFile(nodes);
    propagateScope(file.statements);
    return file;
  },
});
