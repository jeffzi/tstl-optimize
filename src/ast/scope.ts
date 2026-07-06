// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { withPositionFrom } from "./deep-clone";
import { type TraversalControl, Walk, walkStatements } from "./lua-walker";

// ---------------------------------------------------------------------------
// Property-chain extraction
// ---------------------------------------------------------------------------

/** Extract root identifier from a table-index chain. */
function extractRootIdentifier(expr: tstl.Expression): tstl.Identifier | undefined {
  let current: tstl.Expression = expr;
  while (tstl.isTableIndexExpression(current)) {
    current = current.table;
  }
  return tstl.isIdentifier(current) ? current : undefined;
}

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

// ---------------------------------------------------------------------------
// Scope collection
// ---------------------------------------------------------------------------

/** Collected metadata about table-index chains and variable definitions in a scope.
 *
 * - `chainCounts`: Read frequency for each dotted chain (e.g., "math.floor" → 3),
 *   excluding guarded accesses and shadowed chains.
 * - `scopeDefs`: All variable names defined in this scope via declarations or assignments.
 * - `firstChainUse`: First node (statement) observing each chain, used to position hoisted locals.
 * - `rootIdentifiers`: Original root identifiers from hoisted chains, preserving symbolId.
 */
interface ScopeInfo {
  chainCounts: Map<string, number>;
  scopeDefs: Set<string>;
  /** First TableIndexExpression observed for each chain string (in source order). */
  firstChainUse: Map<string, tstl.Node>;
  /** Original root identifier nodes for each chain, preserving symbolId for dead-local tracking. */
  rootIdentifiers: Map<string, tstl.Identifier>;
}

export function isRootShadowedInActiveScopes(
  root: string,
  shadowStack: ReadonlyArray<ReadonlySet<string>>,
): boolean {
  return shadowStack.some((shadowFrame) => shadowFrame.has(root));
}

/** Collect parameter names from a function expression into a Set. */
export function collectFunctionParameterNames(expr: tstl.FunctionExpression): Set<string> {
  const names = new Set<string>();
  for (const param of expr.params ?? []) {
    if (tstl.isIdentifier(param)) {
      names.add(param.text);
    }
  }
  return names;
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
  const rootIdentifiers = new Map<string, tstl.Identifier>();
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
          /* v8 ignore next -- chain is non-empty string; split always returns non-empty array */
          if (!root) return Walk.keep;
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
              // Capture the original root identifier to preserve its symbolId for dead-local tracking
              if (!rootIdentifiers.has(chain)) {
                const root = extractRootIdentifier(expr);
                if (root !== undefined) {
                  rootIdentifiers.set(chain, root);
                }
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
        const onlyRight = stmt.right?.length === 1 ? stmt.right[0] : undefined;
        const isFunctionDef =
          tstl.isAssignmentStatement(stmt) &&
          onlyRight !== undefined &&
          tstl.isFunctionExpression(onlyRight);

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
      shadowStack.push(collectFunctionParameterNames(expr));
    },
    funcExit: (_expr: tstl.FunctionExpression) => {
      shadowStack.pop();
    },
  };
  walkStatements(statements, hooks);

  for (const chain of shadowedChains) {
    chainCounts.delete(chain);
  }

  return { chainCounts, scopeDefs, firstChainUse, rootIdentifiers };
}

// ---------------------------------------------------------------------------
// Array-element pattern matchers
// ---------------------------------------------------------------------------

export function matchLoopIndexAccess(
  expr: tstl.Expression,
  loopVarNames: ReadonlySet<string>,
): { base: string; index: string } | undefined {
  if (
    !tstl.isTableIndexExpression(expr) ||
    !tstl.isIdentifier(expr.table) ||
    !tstl.isIdentifier(expr.index) ||
    !loopVarNames.has(expr.index.text)
  ) {
    return undefined;
  }
  return { base: expr.table.text, index: expr.index.text };
}

export function isLoopVarRebind(stmt: tstl.Statement, loopVarNames: ReadonlySet<string>): boolean {
  return (
    (tstl.isForStatement(stmt) && loopVarNames.has(stmt.controlVariable.text)) ||
    (tstl.isForInStatement(stmt) &&
      stmt.names.some((n) => tstl.isIdentifier(n) && loopVarNames.has(n.text)))
  );
}

// ---------------------------------------------------------------------------
// Array-element accesses
// ---------------------------------------------------------------------------

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
interface ArrayElementInfo {
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
      const match = matchLoopIndexAccess(expr, loopVarNames);
      if (match) {
        if (hooks.guardDepth === 0) {
          trackLoopVar(match.base, match.index);
          counts.set(match.base, (counts.get(match.base) ?? 0) + 1);
          if (!firstAccess.has(match.base)) firstAccess.set(match.base, expr);
        }
        return Walk.skip;
      }
      return Walk.keep;
    },
    stmt: (stmt: tstl.Statement, control: TraversalControl) => {
      if (isLoopVarRebind(stmt, loopVarNames)) {
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

// ---------------------------------------------------------------------------
// Chain building
// ---------------------------------------------------------------------------

/**
 * Reconstruct a TableIndexExpression from a dotted chain string (e.g. "math.floor").
 *
 * When `source` is provided, every created node is stamped with `source`'s position
 * via `withPositionFrom` so hoisted declarations map to the first-use site.
 *
 * When `rootIdentifier` is provided (the original identifier from the chain),
 * its symbolId is copied to the synthesized root identifier, ensuring dead-local
 * tracking can see the reference to the original variable.
 */
export function buildChainExpression(
  chain: string,
  source?: tstl.Node,
  rootIdentifier?: tstl.Identifier,
): tstl.TableIndexExpression {
  const [rootName, firstKeyName, ...rest] = chain.split(".");
  if (rootName === undefined || firstKeyName === undefined) {
    throw new Error(`buildChainExpression requires a dotted chain (got "${chain}")`);
  }

  const applySource = (node: tstl.Node): void => {
    if (source) withPositionFrom(node, source);
  };

  const root = rootIdentifier
    ? tstl.createIdentifier(rootName, undefined, rootIdentifier.symbolId)
    : tstl.createIdentifier(rootName);
  applySource(root);

  const firstKey = tstl.createStringLiteral(firstKeyName);
  applySource(firstKey);
  let result: tstl.TableIndexExpression = tstl.createTableIndexExpression(root, firstKey);
  applySource(result);

  for (const part of rest) {
    const key = tstl.createStringLiteral(part);
    applySource(key);
    result = tstl.createTableIndexExpression(result, key);
    applySource(result);
  }

  return result;
}
