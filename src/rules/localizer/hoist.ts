// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { walkStatements } from "../../ast/lua-walker";
import { buildChainExpression, collectScopeInfo, luaPropertyChain } from "../../ast/scope";
import { hasInterveningCallForChain, hasTopLevelChainAccess, STDLIB_ROOTS } from "./safety";

export function mergeNameSets(...sets: Array<ReadonlySet<string> | undefined>): Set<string> {
  const merged = new Set<string>();
  for (const names of sets) {
    if (names === undefined) continue;
    for (const name of names) {
      merged.add(name);
    }
  }
  return merged;
}

export function allocateHoistName(baseName: string, unavailableNames: ReadonlySet<string>): string {
  if (!unavailableNames.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  let candidate = `${baseName}_${suffix}`;
  while (unavailableNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}_${suffix}`;
  }
  return candidate;
}

/** True if any prefix of the dotted chain (root, intermediate, or exact) is in scopeDefs. */
function isAnyPrefixBound(chain: string, scopeDefs: ReadonlySet<string>): boolean {
  const parts = chain.split(".");
  for (let i = 1; i <= parts.length; i++) {
    if (scopeDefs.has(parts.slice(0, i).join("."))) return true;
  }
  return false;
}

/** In-place replace matching TableIndexExpression chains with cloned identifiers. */
export function replaceChains(
  statements: tstl.Statement[],
  hoisted: Map<string, tstl.Identifier>,
  shallow: boolean,
): void {
  walkStatements(statements, {
    shallow,
    expr: (expr, replace, control) => {
      if (tstl.isTableIndexExpression(expr)) {
        const chain = luaPropertyChain(expr);
        if (chain !== undefined) {
          const ident = hoisted.get(chain);
          if (ident) {
            replace(tstl.cloneIdentifier(ident));
            control.skip();
          }
        }
      }
    },
  });
}

/**
 * Collect chains meeting threshold, create hoisted declarations, replace in-place,
 * and prepend declarations. Returns the set of newly hoisted chain strings.
 */
export function hoistScope(
  statements: tstl.Statement[],
  threshold: number,
  shallow: boolean,
  alreadyHoisted: ReadonlySet<string>,
  context: tstl.TransformationContext,
  reservedNames?: ReadonlySet<string>,
  isRootAllowed?: (root: string) => boolean,
  outDecls?: tstl.VariableDeclarationStatement[],
  extraBoundNames?: ReadonlySet<string>,
): Set<string> {
  const { chainCounts, scopeDefs } = collectScopeInfo(statements, shallow);
  const unavailableNames = mergeNameSets(scopeDefs, reservedNames);
  const toHoist = new Map<string, tstl.Identifier>();
  const inBodyDecls: tstl.VariableDeclarationStatement[] = [];
  const liftableDecls: tstl.VariableDeclarationStatement[] = [];

  // Sort entries by chain string for deterministic output
  const sorted = [...chainCounts.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [chain, count] of sorted) {
    if (count < threshold || alreadyHoisted.has(chain)) continue;
    const parts = chain.split(".");
    const root = parts[0];
    if (isRootAllowed && !isRootAllowed(root)) continue;
    // Module-scope hoists must come from actual module-scope uses for non-stdlib roots.
    // Otherwise an included mutable root like obj/config would be snapshotted once at load time
    // and reused across later function calls.
    if (!shallow && !STDLIB_ROOTS.has(root) && !hasTopLevelChainAccess(statements, chain)) {
      continue;
    }
    if (hasInterveningCallForChain(statements, chain, shallow)) continue;
    const hoistBaseName = `____${parts.join("_")}`;
    if (isAnyPrefixBound(chain, scopeDefs)) {
      continue;
    }
    // Roots bound only outside this scope (e.g. for-loop control var) can still be
    // cached inside the body, but must NOT be lifted to a pre-loop decl.
    const rootIsExternal = extraBoundNames?.has(root) ?? false;
    const hoistName = allocateHoistName(hoistBaseName, unavailableNames);
    const ident = tstl.createIdentifier(hoistName, undefined, context.nextSymbolId());
    toHoist.set(chain, ident);
    scopeDefs.add(hoistName);
    unavailableNames.add(hoistName);
    const decl = tstl.createVariableDeclarationStatement(ident, buildChainExpression(chain));
    if (outDecls && !rootIsExternal) {
      liftableDecls.push(decl);
    } else {
      inBodyDecls.push(decl);
    }
  }

  if (toHoist.size > 0) {
    replaceChains(statements, toHoist, shallow);
    if (inBodyDecls.length > 0) statements.unshift(...inBodyDecls);
    if (outDecls) outDecls.push(...liftableDecls);
  }

  return new Set(toHoist.keys());
}
