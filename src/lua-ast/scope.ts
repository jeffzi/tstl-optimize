// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { walkStatements } from "./lua-walker";

/** Build a dotted chain string from a Lua TableIndexExpression. */
export function luaPropertyChain(node: tstl.TableIndexExpression): string | undefined {
  const parts: string[] = [];

  let current: tstl.Expression = node;
  while (tstl.isTableIndexExpression(current)) {
    if (tstl.isStringLiteral(current.index)) {
      parts.unshift(current.index.value);
    } else {
      return undefined; // non-string index — can't represent as dotted chain
    }
    current = current.table;
  }
  if (tstl.isIdentifier(current)) {
    parts.unshift(current.text);
    return parts.join(".");
  }
  return undefined;
}

export interface ScopeInfo {
  chainCounts: Map<string, number>;
  scopeDefs: Set<string>;
}

/**
 * Walk a statement list in a single pass, collecting both:
 * - all unique TableIndexExpression chains and their counts (skips sub-expressions of matched chains)
 * - all variable/assignment LHS identifiers defined in the scope
 *
 * When `shallow` is true, skips FunctionExpression bodies.
 */
export function collectScopeInfo(statements: tstl.Statement[], shallow: boolean): ScopeInfo {
  const chainCounts = new Map<string, number>();
  const scopeDefs = new Set<string>();
  walkStatements(statements, {
    shallow,
    expr: (expr, _replace, control) => {
      if (tstl.isTableIndexExpression(expr)) {
        const chain = luaPropertyChain(expr);
        if (chain !== undefined) {
          chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
          control.skip();
        }
      }
    },
    stmt: (stmt) => {
      if (tstl.isVariableDeclarationStatement(stmt) || tstl.isAssignmentStatement(stmt)) {
        for (const lhs of stmt.left) {
          if (tstl.isIdentifier(lhs)) scopeDefs.add(lhs.text);
        }
      }
    },
  });
  return { chainCounts, scopeDefs };
}

/** Reconstruct a TableIndexExpression from a dotted chain string (e.g. "math.floor"). */
export function buildChainExpression(chain: string): tstl.TableIndexExpression {
  const parts = chain.split(".");
  if (parts.length < 2) {
    throw new Error(`buildChainExpression requires a dotted chain (got "${chain}")`);
  }
  let expr: tstl.Expression = tstl.createIdentifier(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    expr = tstl.createTableIndexExpression(expr, tstl.createStringLiteral(parts[i]));
  }
  return expr as tstl.TableIndexExpression;
}
