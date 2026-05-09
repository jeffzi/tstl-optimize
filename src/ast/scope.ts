// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { withPositionFrom } from "./deep-clone";
import { type TraversalControl, Walk, walkStatements } from "./lua-walker";

/** Build a dotted chain string from a Lua TableIndexExpression. */
export function luaPropertyChain(node: tstl.TableIndexExpression): string | undefined {
  const parts: string[] = [];

  let current: tstl.Expression = node;
  while (tstl.isTableIndexExpression(current)) {
    if (tstl.isStringLiteral(current.index)) {
      parts.push(current.index.value);
    } else {
      return undefined; // non-string index — can't represent as dotted chain
    }
    current = current.table;
  }
  if (tstl.isIdentifier(current)) {
    parts.push(current.text);
    return parts.reverse().join(".");
  }
  return undefined;
}

/** Collected metadata about table-index chains and variable definitions in a scope.
 *
 * - `chainCounts`: Read frequency for each dotted chain (e.g., "math.floor" → 3),
 *   excluding guarded accesses and shadowed chains.
 * - `scopeDefs`: All variable names defined in this scope via declarations or assignments.
 * - `firstChainUse`: First node (statement) observing each chain, used to position hoisted locals.
 */
export interface ScopeInfo {
  chainCounts: Map<string, number>;
  scopeDefs: Set<string>;
  /** First TableIndexExpression observed for each chain string (in source order). */
  firstChainUse: Map<string, tstl.Node>;
}

export function isRootShadowedInActiveScopes(
  root: string,
  shadowStack: ReadonlyArray<ReadonlySet<string>>,
): boolean {
  return shadowStack.some((shadowFrame) => shadowFrame.has(root));
}

/**
 * Walk a statement list in a single pass, collecting both:
 * - all unique TableIndexExpression chains and their counts (skips sub-expressions of matched chains)
 * - all variable/assignment LHS identifiers defined in the scope
 *
 * When `shallow` is true, skips FunctionExpression bodies.
 * When `shallow` is false, descends into nested functions with scope-aware tracking:
 * nested function parameters are NOT added to scopeDefs (they belong to nested scopes).
 * We track shadowed roots via shadowStack and exclude chains with BOTH outer and inner reads
 * when the inner reads come from a nested function parameter that shadows the root name.
 */
export function collectScopeInfo(
  statements: readonly tstl.Statement[],
  shallow: boolean,
): ScopeInfo {
  const chainCounts = new Map<string, number>();
  const firstChainUse = new Map<string, tstl.Node>();
  const scopeDefs = new Set<string>();
  const shadowStack: Array<Set<string>> = []; // Stack of shadowed param names as we enter/exit nested funcs
  const shadowedChains = new Set<string>(); // Tracks chains with mixed outer + shadowed inner reads
  // Track the current top-level statement so we can record it as the position source for
  // firstChainUse. Statements have line/column in the Lua AST; TableIndexExpression nodes don't.
  let currentStmt: tstl.Statement | undefined;

  const hooks = {
    shallow,
    guardDepth: 0,
    expr: (expr: tstl.Expression) => {
      if (tstl.isTableIndexExpression(expr)) {
        const chain = luaPropertyChain(expr);
        if (chain !== undefined) {
          const root = chain.split(".")[0];
          const isShadowed = isRootShadowedInActiveScopes(root, shadowStack);
          const immediateShadow = shadowStack[shadowStack.length - 1]?.has(root) ?? false;

          // Only count unguarded chains at every scope. Guarded accesses (inside
          // if/else branches, &&/|| RHS, ternary branches) would be hoisted ABOVE
          // the guard, turning a conditional dereference into an unconditional one.
          // Branch-local hoisting happens via recursive hoistScope calls on each
          // branch's statement list from the caller.
          if (hooks.guardDepth === 0) {
            if (immediateShadow) {
              // Inside a nested function with shadowing param — mark chain as dangerous
              // (has reads at both outer and inner scope with shadowing)
              shadowedChains.add(chain);
            } else if (!isShadowed) {
              // Either at module scope or shadowing doesn't apply — count normally
              chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
              if (!firstChainUse.has(chain) && currentStmt !== undefined) {
                firstChainUse.set(chain, currentStmt);
              }
            }
          }
          return Walk.skip;
        }
      }
      return Walk.keep;
    },
    stmt: (stmt: tstl.Statement) => {
      currentStmt = stmt;
      if (tstl.isVariableDeclarationStatement(stmt) || tstl.isAssignmentStatement(stmt)) {
        const isFunctionDef =
          tstl.isAssignmentStatement(stmt) &&
          stmt.right.length === 1 &&
          tstl.isFunctionExpression(stmt.right[0]);

        for (const lhs of stmt.left) {
          if (tstl.isIdentifier(lhs)) {
            scopeDefs.add(lhs.text);
          } else if (tstl.isTableIndexExpression(lhs)) {
            // Only add table index chains if this is a function definition (e.g., module.fn = function() end).
            // Regular assignments like obj.foo.bar = 99 mutate existing values and should not prevent
            // hoisting of reads that occur before the assignment — the safety check handles that.
            if (isFunctionDef || tstl.isVariableDeclarationStatement(stmt)) {
              const chain = luaPropertyChain(lhs);
              if (chain !== undefined) {
                scopeDefs.add(chain);
              }
            }
          }
        }
        // NOTE: We do NOT add nested function parameters to scopeDefs here.
        // Nested function parameters belong to their own scope and should not block
        // hoisting of outer-scope chains, even if the names shadow outer variables.
        // The shadowing is handled via shadowStack tracking in the expr hook.
      }
      if (tstl.isForInStatement(stmt)) {
        for (const name of stmt.names) {
          if (tstl.isIdentifier(name)) scopeDefs.add(name.text);
        }
      }
      if (tstl.isForStatement(stmt)) {
        scopeDefs.add(stmt.controlVariable.text);
      }
    },
    funcEnter: (expr: tstl.FunctionExpression) => {
      const params = new Set<string>();
      for (const param of expr.params ?? []) {
        if (tstl.isIdentifier(param)) {
          params.add(param.text);
        }
      }
      shadowStack.push(params);
    },
    funcExit: (_expr: tstl.FunctionExpression) => {
      shadowStack.pop();
    },
  };
  walkStatements(statements, hooks);

  for (const chain of shadowedChains) {
    chainCounts.delete(chain);
  }

  return { chainCounts, scopeDefs, firstChainUse };
}

/** Collected metadata about array-element accesses inside a loop.
 *
 * - `counts`: Read frequency per array base name (e.g., "arr" → 4). LHS writes are not counted
 *   because the write-back still requires one table lookup.
 * - `writes`: Base names that appear on the LHS of assignments.
 * - `loopVar`: Which loop variable is used as index for each base name. If multiple indices
 *   are detected, the base is excluded from counts/writes/loopVar.
 * - `firstAccess`: First `base[loopVar]` TableIndexExpression observed for each base name,
 *   used to position hoisted locals.
 */
export interface ArrayElementInfo {
  /** Read-count per base name (LHS writes are NOT counted — only reads benefit from localization) */
  counts: Map<string, number>;
  /** Base names that appear as LHS of assignments */
  writes: Set<string>;
  /** Which loop variable is used as index for each base name */
  loopVar: Map<string, string>;
  /** First `base[loopVar]` TableIndexExpression observed for each base name (in source order). */
  firstAccess: Map<string, tstl.Node>;
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
  const firstAccess = new Map<string, tstl.Node>();
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
    expr: (expr: tstl.Expression) => {
      if (
        tstl.isTableIndexExpression(expr) &&
        tstl.isIdentifier(expr.table) &&
        tstl.isIdentifier(expr.index) &&
        loopVarNames.has(expr.index.text)
      ) {
        if (hooks.guardDepth === 0) {
          trackLoopVar(expr.table.text, expr.index.text);
          counts.set(expr.table.text, (counts.get(expr.table.text) ?? 0) + 1);
          if (!firstAccess.has(expr.table.text)) firstAccess.set(expr.table.text, expr);
        }
        return Walk.skip;
      }
      return Walk.keep;
    },
    stmt: (stmt: tstl.Statement, control: TraversalControl) => {
      if (
        (tstl.isForStatement(stmt) && loopVarNames.has(stmt.controlVariable.text)) ||
        (tstl.isForInStatement(stmt) &&
          stmt.names.some((name) => tstl.isIdentifier(name) && loopVarNames.has(name.text)))
      ) {
        control.skip();
        return;
      }

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

  for (const name of mixedIndex) {
    counts.delete(name);
    writes.delete(name);
    loopVar.delete(name);
  }

  return { counts, writes, loopVar, firstAccess };
}

/**
 * Reconstruct a TableIndexExpression from a dotted chain string (e.g. "math.floor").
 *
 * When `source` is provided, every created node is stamped with `source`'s position
 * via `withPositionFrom` so hoisted declarations map to the first-use site.
 */
export function buildChainExpression(chain: string, source?: tstl.Node): tstl.TableIndexExpression {
  const parts = chain.split(".");
  if (parts.length < 2) {
    throw new Error(`buildChainExpression requires a dotted chain (got "${chain}")`);
  }
  const root = tstl.createIdentifier(parts[0]);
  if (source) withPositionFrom(root, source);
  // Build the first TableIndexExpression from the root identifier. The parts.length < 2
  // guard above ensures parts[1] exists, so the non-null assertion is safe.
  // biome-ignore lint/style/noNonNullAssertion: length guard above proves parts[1] is defined
  const firstKey = tstl.createStringLiteral(parts[1]!);
  if (source) withPositionFrom(firstKey, source);
  let result: tstl.TableIndexExpression = tstl.createTableIndexExpression(root, firstKey);
  if (source) withPositionFrom(result, source);
  for (const part of parts.slice(2)) {
    const key = tstl.createStringLiteral(part);
    if (source) withPositionFrom(key, source);
    result = tstl.createTableIndexExpression(result, key);
    if (source) withPositionFrom(result, source);
  }
  return result;
}
