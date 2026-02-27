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

/**
 * Walk a statement list, collecting all unique TableIndexExpression chains and their counts.
 * Skips sub-expressions of matched chains (avoids double-counting "math" when "math.floor" matches).
 * When `shallow` is true, skips FunctionExpression bodies.
 */
export function collectChains(statements: tstl.Statement[], shallow: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  walkStatements(statements, {
    shallow,
    expr: (expr, _replace, control) => {
      if (tstl.isTableIndexExpression(expr)) {
        const chain = luaPropertyChain(expr);
        if (chain !== undefined) {
          counts.set(chain, (counts.get(chain) ?? 0) + 1);
          control.skip();
        }
      }
    },
  });
  return counts;
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
