// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { type TraversalControl, walkStatements } from "./lua-walker";

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
  const hooks = {
    shallow,
    guardDepth: 0,
    expr: (
      expr: tstl.Expression,
      _replace: (n: tstl.Expression) => void,
      control: TraversalControl,
    ) => {
      if (tstl.isTableIndexExpression(expr)) {
        const chain = luaPropertyChain(expr);
        if (chain !== undefined) {
          if (hooks.guardDepth === 0) {
            chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
          }
          control.skip();
        }
      }
      if (!shallow && tstl.isFunctionExpression(expr) && expr.params) {
        for (const param of expr.params) {
          if (tstl.isIdentifier(param)) {
            scopeDefs.add(param.text);
          }
        }
      }
    },
    stmt: (stmt: tstl.Statement) => {
      if (tstl.isVariableDeclarationStatement(stmt) || tstl.isAssignmentStatement(stmt)) {
        for (const lhs of stmt.left) {
          if (tstl.isIdentifier(lhs)) scopeDefs.add(lhs.text);
        }
      }
      if (tstl.isForInStatement(stmt)) {
        for (const name of stmt.names) {
          if (tstl.isIdentifier(name)) scopeDefs.add(name.text);
        }
      }
      if (tstl.isForStatement(stmt) && tstl.isIdentifier(stmt.controlVariable)) {
        scopeDefs.add(stmt.controlVariable.text);
      }
    },
  };
  walkStatements(statements, hooks);
  return { chainCounts, scopeDefs };
}

export interface ArrayElementInfo {
  /** Read-count per base name (LHS writes are NOT counted — only reads benefit from localization) */
  counts: Map<string, number>;
  /** Base names that appear as LHS of assignments */
  writes: Set<string>;
  /** Which loop variable is used as index for each base name */
  loopVar: Map<string, string>;
}

/**
 * Walk a statement list counting `base[loopVar]` patterns for array element localization.
 * Only RHS reads are counted toward the threshold — LHS writes are tracked separately
 * because the write-back still needs one table access, so writes don't save lookups.
 */
export function collectArrayElementAccesses(
  statements: tstl.Statement[],
  loopVarNames: ReadonlySet<string>,
  shallow: boolean,
): ArrayElementInfo {
  const counts = new Map<string, number>();
  const writes = new Set<string>();
  const loopVar = new Map<string, string>();
  // Bases used with multiple different loop vars — excluded from hoisting
  const mixedIndex = new Set<string>();

  function trackLoopVar(baseName: string, indexName: string): void {
    const existing = loopVar.get(baseName);
    if (existing !== undefined && existing !== indexName) {
      mixedIndex.add(baseName);
    } else {
      loopVar.set(baseName, indexName);
    }
  }

  const hooks = {
    shallow,
    guardDepth: 0,
    expr: (
      expr: tstl.Expression,
      _replace: (n: tstl.Expression) => void,
      control: TraversalControl,
    ) => {
      if (
        tstl.isTableIndexExpression(expr) &&
        tstl.isIdentifier(expr.table) &&
        tstl.isIdentifier(expr.index) &&
        loopVarNames.has(expr.index.text)
      ) {
        if (hooks.guardDepth === 0) {
          trackLoopVar(expr.table.text, expr.index.text);
          counts.set(expr.table.text, (counts.get(expr.table.text) ?? 0) + 1);
        }
        control.skip();
      }
    },
    stmt: (stmt: tstl.Statement) => {
      if (tstl.isAssignmentStatement(stmt)) {
        for (const lhs of stmt.left) {
          if (
            tstl.isTableIndexExpression(lhs) &&
            tstl.isIdentifier(lhs.table) &&
            tstl.isIdentifier(lhs.index) &&
            loopVarNames.has(lhs.index.text)
          ) {
            trackLoopVar(lhs.table.text, lhs.index.text);
            writes.add(lhs.table.text);
          }
        }
      }
    },
  };
  walkStatements(statements, hooks);

  // Remove bases with inconsistent indices
  for (const name of mixedIndex) {
    counts.delete(name);
    writes.delete(name);
    loopVar.delete(name);
  }

  return { counts, writes, loopVar };
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
