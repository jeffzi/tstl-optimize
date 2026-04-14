import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { walkStatements } from "../ast/lua-walker";
import {
  buildChainExpression,
  collectArrayElementAccesses,
  collectScopeInfo,
  luaPropertyChain,
} from "../ast/scope";
import type { LocalizerConfig, RuleFactory } from "../config";
import { resolveLocalizerConfig } from "../config";

/** Lua stdlib globals that are safe to hoist (flat function tables, no metatables). */
const STDLIB_ROOTS: ReadonlySet<string> = new Set([
  "math",
  "string",
  "table",
  "os",
  "io",
  "coroutine",
  "bit",
  "bit32",
  "jit",
  "debug",
]);

/** Globals known to rely on metatables -- never hoisted unless explicitly included. */
const INTERNAL_BLOCKLIST: ReadonlySet<string> = new Set([
  "assert",
  "spy",
  "stub",
  "mock",
  "describe",
  "it",
  "pending",
  "setup",
  "teardown",
  "before_each",
  "after_each",
  "insist",
]);

/**
 * Build two root predicates:
 *  - strict (module scope):    (STDLIB ∪ include) \ exclude \ (BLOCKLIST \ include)
 *  - lenient (non-module):     (any)              \ exclude \ (BLOCKLIST \ include)
 *
 * The strict form guards against snapshotting a mutable global once at file load.
 * The lenient form is safe at loop/function scope because the caller also enforces
 * "no intervening call" and "no prefix write" — which together prove loop-invariance.
 */
function buildRootFilters(
  include: readonly string[],
  exclude: readonly string[],
): {
  isRootAllowedStrict: (root: string) => boolean;
  isRootAllowedLenient: (root: string) => boolean;
} {
  const hasWildcard = include.includes("*");
  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);

  const isRootAllowedLenient = (root: string): boolean => {
    if (excludeSet.has(root)) return false;
    if (INTERNAL_BLOCKLIST.has(root) && !includeSet.has(root)) return false;
    return true;
  };

  if (hasWildcard) {
    return { isRootAllowedStrict: isRootAllowedLenient, isRootAllowedLenient };
  }

  const allowed = new Set(STDLIB_ROOTS);
  for (const root of include) allowed.add(root);
  for (const root of exclude) allowed.delete(root);
  for (const root of INTERNAL_BLOCKLIST) {
    if (!includeSet.has(root)) allowed.delete(root);
  }
  const isRootAllowedStrict = (root: string): boolean => allowed.has(root);
  return { isRootAllowedStrict, isRootAllowedLenient };
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
function replaceChains(statements: tstl.Statement[], hoisted: Map<string, tstl.Identifier>): void {
  walkStatements(statements, {
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

function mergeNameSets(...sets: Array<ReadonlySet<string> | undefined>): Set<string> {
  const merged = new Set<string>();
  for (const names of sets) {
    if (names === undefined) continue;
    for (const name of names) {
      merged.add(name);
    }
  }
  return merged;
}

function allocateHoistName(baseName: string, unavailableNames: ReadonlySet<string>): string {
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

function statementTouchesChain(
  statement: tstl.Statement,
  chain: string,
  shallow: boolean,
): boolean {
  let found = false;
  walkStatements([statement], {
    shallow,
    expr: (expr, _replace, control) => {
      if (!tstl.isTableIndexExpression(expr)) {
        return;
      }

      if (luaPropertyChain(expr) === chain) {
        found = true;
        control.stop();
      }
    },
  });
  return found;
}

function hasInterveningCallForChain(
  statements: tstl.Statement[],
  chain: string,
  shallow: boolean,
): boolean {
  const root = chain.split(".")[0];
  if (STDLIB_ROOTS.has(root)) {
    return false;
  }

  let firstAccessIndex: number | undefined;
  let lastAccessIndex: number | undefined;
  for (const [index, statement] of statements.entries()) {
    if (!statementTouchesChain(statement, chain, shallow)) {
      continue;
    }

    if (firstAccessIndex === undefined) {
      firstAccessIndex = index;
    }
    lastAccessIndex = index;
  }

  if (
    firstAccessIndex === undefined ||
    lastAccessIndex === undefined ||
    firstAccessIndex >= lastAccessIndex
  ) {
    return false;
  }

  for (let index = firstAccessIndex + 1; index < lastAccessIndex; index += 1) {
    if (hasCallExpression([statements[index]])) {
      return true;
    }
  }

  return false;
}

function hasTopLevelChainAccess(statements: tstl.Statement[], chain: string): boolean {
  return statements.some((statement) => statementTouchesChain(statement, chain, true));
}

/**
 * Collect chains meeting threshold, create hoisted declarations, replace in-place,
 * and prepend declarations. Returns the set of newly hoisted chain strings.
 */
function hoistScope(
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
    replaceChains(statements, toHoist);
    if (inBodyDecls.length > 0) statements.unshift(...inBodyDecls);
    if (outDecls) outDecls.push(...liftableDecls);
  }

  return new Set(toHoist.keys());
}

function getElseStatements(elseBlock: tstl.Block | tstl.IfStatement): tstl.Statement[] {
  return tstl.isIfStatement(elseBlock) ? [elseBlock] : elseBlock.statements;
}

/** Check for return/goto inside nested loops — these exit the function, not just the loop. */
function hasNestedFunctionExit(statements: tstl.Statement[]): boolean {
  for (const stmt of statements) {
    if (tstl.isReturnStatement(stmt) || tstl.isGotoStatement(stmt)) return true;
    if (tstl.isIfStatement(stmt)) {
      if (hasNestedFunctionExit(stmt.ifBlock.statements)) return true;
      if (stmt.elseBlock) {
        if (hasNestedFunctionExit(getElseStatements(stmt.elseBlock))) return true;
      }
    }
    if (tstl.isDoStatement(stmt)) {
      if (hasNestedFunctionExit(stmt.statements)) return true;
    }
    // Recurse into nested loops — return/goto there still exits the enclosing function
    if (tstl.isWhileStatement(stmt) || tstl.isRepeatStatement(stmt)) {
      if (hasNestedFunctionExit(stmt.body.statements)) return true;
    }
    if (tstl.isForStatement(stmt) || tstl.isForInStatement(stmt)) {
      if (hasNestedFunctionExit(stmt.body.statements)) return true;
    }
    // Don't recurse into function expressions — return there exits the nested function
  }
  return false;
}

/** Check for top-level return/break that would prevent write-back from executing. */
function hasEarlyExit(statements: tstl.Statement[]): boolean {
  for (const stmt of statements) {
    if (tstl.isReturnStatement(stmt) || tstl.isBreakStatement(stmt) || tstl.isGotoStatement(stmt))
      return true;
    // Recurse into if/do blocks — break/return there still exits our scope
    if (tstl.isIfStatement(stmt)) {
      if (hasEarlyExit(stmt.ifBlock.statements)) return true;
      if (stmt.elseBlock) {
        if (hasEarlyExit(getElseStatements(stmt.elseBlock))) return true;
      }
    }
    if (tstl.isDoStatement(stmt)) {
      if (hasEarlyExit(stmt.statements)) return true;
    }
    // Recurse into nested loops for return/goto only (break is scoped to the inner loop)
    if (tstl.isWhileStatement(stmt) || tstl.isRepeatStatement(stmt)) {
      if (hasNestedFunctionExit(stmt.body.statements)) return true;
    }
    if (tstl.isForStatement(stmt) || tstl.isForInStatement(stmt)) {
      if (hasNestedFunctionExit(stmt.body.statements)) return true;
    }
  }
  return false;
}

/** Check if any call expression exists in the loop body (not inside nested function bodies). */
function hasCallExpression(statements: tstl.Statement[]): boolean {
  let found = false;
  walkStatements(statements, {
    shallow: true,
    expr: (expr, _replace, control) => {
      if (tstl.isCallExpression(expr) || tstl.isMethodCallExpression(expr)) {
        found = true;
        control.stop();
      }
    },
  });
  return found;
}

/** Replace matching `base[loopVar]` expressions with cloned temp identifiers. */
function replaceArrayElements(
  statements: tstl.Statement[],
  hoisted: Map<string, tstl.Identifier>,
  loopVarNames: ReadonlySet<string>,
): void {
  walkStatements(statements, {
    shallow: true,
    expr: (expr, replace, control) => {
      if (
        tstl.isTableIndexExpression(expr) &&
        tstl.isIdentifier(expr.table) &&
        tstl.isIdentifier(expr.index) &&
        loopVarNames.has(expr.index.text)
      ) {
        const ident = hoisted.get(expr.table.text);
        if (ident) {
          replace(tstl.cloneIdentifier(ident));
          control.skip();
        }
      }
    },
    stmt: (stmt, control) => {
      if (
        (tstl.isForStatement(stmt) && loopVarNames.has(stmt.controlVariable.text)) ||
        (tstl.isForInStatement(stmt) &&
          stmt.names.some((name) => tstl.isIdentifier(name) && loopVarNames.has(name.text)))
      ) {
        control.skip();
        return;
      }

      if (tstl.isAssignmentStatement(stmt)) {
        for (let i = 0; i < stmt.left.length; i++) {
          const lhs = stmt.left[i];
          if (
            tstl.isTableIndexExpression(lhs) &&
            tstl.isIdentifier(lhs.table) &&
            tstl.isIdentifier(lhs.index) &&
            loopVarNames.has(lhs.index.text)
          ) {
            const ident = hoisted.get(lhs.table.text);
            if (ident) {
              stmt.left[i] = tstl.cloneIdentifier(ident);
            }
          }
        }
      }
    },
  });
}

/**
 * Localize repeated `base[loopVar]` accesses into temp variables within a loop body.
 * Prepends `local ____base = base[loopVar]` and appends `base[loopVar] = ____base`
 * for written bases.
 */
function hoistArrayElements(
  statements: tstl.Statement[],
  loopVarNames: ReadonlySet<string>,
  threshold: number,
  context: tstl.TransformationContext,
  reservedNames?: ReadonlySet<string>,
): void {
  const { scopeDefs } = collectScopeInfo(statements, true);
  const unavailableNames = mergeNameSets(scopeDefs, loopVarNames, reservedNames);
  const { counts, writes, loopVar } = collectArrayElementAccesses(statements, loopVarNames, true);

  const earlyExit = hasEarlyExit(statements);

  // A function call anywhere in the loop body could modify any array element
  // through a reference, making cached locals stale
  if (hasCallExpression(statements)) return;

  const toHoist = new Map<string, tstl.Identifier>();
  const decls: tstl.VariableDeclarationStatement[] = [];
  const writebacks: tstl.AssignmentStatement[] = [];

  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [baseName, count] of sorted) {
    if (count < threshold) continue;

    const hoistBaseName = `____${baseName}`;
    const indexName = loopVar.get(baseName);
    if (indexName === undefined) continue;

    // Safety: base locally defined — hoisting would read before definition
    if (scopeDefs.has(baseName)) continue;
    // Safety: written base + early exit → write-back wouldn't always execute
    if (writes.has(baseName) && earlyExit) continue;

    const hoistName = allocateHoistName(hoistBaseName, unavailableNames);
    const ident = tstl.createIdentifier(hoistName, undefined, context.nextSymbolId());
    toHoist.set(baseName, ident);
    scopeDefs.add(hoistName);
    unavailableNames.add(hoistName);

    // local ____base = base[loopVar]
    const tableAccess = tstl.createTableIndexExpression(
      tstl.createIdentifier(baseName),
      tstl.createIdentifier(indexName),
    );
    decls.push(tstl.createVariableDeclarationStatement(ident, tableAccess));

    // base[loopVar] = ____base (only for written bases)
    if (writes.has(baseName)) {
      const writeAccess = tstl.createTableIndexExpression(
        tstl.createIdentifier(baseName),
        tstl.createIdentifier(indexName),
      );
      writebacks.push(tstl.createAssignmentStatement(writeAccess, tstl.cloneIdentifier(ident)));
    }
  }

  if (toHoist.size > 0) {
    replaceArrayElements(statements, toHoist, loopVarNames);
    statements.unshift(...decls);
    statements.push(...writebacks);
  }
}

interface ProcessingContext {
  threshold: number;
  alreadyHoisted: ReadonlySet<string>;
  context: tstl.TransformationContext;
  isRootAllowed: (root: string) => boolean;
  reservedNames: ReadonlySet<string>;
}

function processFile(
  file: tstl.File,
  config: LocalizerConfig,
  context: tstl.TransformationContext,
  isRootAllowedStrict: (root: string) => boolean,
  isRootAllowedLenient: (root: string) => boolean,
): void {
  const { threshold, scope } = config;

  if (scope === "module") {
    hoistScope(
      file.statements,
      threshold,
      false,
      new Set(),
      context,
      undefined,
      isRootAllowedStrict,
    );
  } else if (scope === "function") {
    processFunctionBodies(file.statements, {
      threshold,
      alreadyHoisted: new Set(),
      context,
      isRootAllowed: isRootAllowedLenient,
      reservedNames: new Set(),
    });
  } else {
    // "all": module pass first (strict), then function pass for remaining chains (lenient)
    const alreadyHoisted = hoistScope(
      file.statements,
      threshold,
      false,
      new Set(),
      context,
      undefined,
      isRootAllowedStrict,
    );
    processFunctionBodies(file.statements, {
      threshold,
      alreadyHoisted,
      context,
      isRootAllowed: isRootAllowedLenient,
      reservedNames: new Set(),
    });
  }
}

function processFunctionBodies(statements: tstl.Statement[], ctx: ProcessingContext): void {
  const { threshold, alreadyHoisted, context, isRootAllowed, reservedNames } = ctx;
  const scopeReservedNames = mergeNameSets(
    reservedNames,
    collectScopeInfo(statements, true).scopeDefs,
  );

  walkStatements(statements, {
    shallow: true,
    expr: (expr, _replace, control) => {
      if (tstl.isFunctionExpression(expr)) {
        const paramNames = new Set(expr.params?.filter(tstl.isIdentifier).map((p) => p.text));
        const functionReservedNames = mergeNameSets(scopeReservedNames, paramNames);
        hoistScope(
          expr.body.statements,
          threshold,
          true,
          alreadyHoisted,
          context,
          functionReservedNames,
          isRootAllowed,
        );
        processFunctionBodies(expr.body.statements, {
          ...ctx,
          reservedNames: functionReservedNames,
        });
        control.skip();
      }
    },
  });

  for (let j = 0; j < statements.length; j++) {
    const stmt = statements[j];
    if (tstl.isDoStatement(stmt)) {
      processFunctionBodies(stmt.statements, ctx);
    } else if (tstl.isIfStatement(stmt)) {
      processFunctionBodies(stmt.ifBlock.statements, ctx);
      if (stmt.elseBlock) {
        processFunctionBodies(getElseStatements(stmt.elseBlock), ctx);
      }
    } else if (tstl.isForInStatement(stmt) || tstl.isForStatement(stmt)) {
      const loopNames = tstl.isForInStatement(stmt)
        ? new Set(stmt.names.filter(tstl.isIdentifier).map((n) => n.text))
        : new Set([stmt.controlVariable.text]);
      const loopReservedNames = mergeNameSets(scopeReservedNames, loopNames);
      // Collect chain decls for pre-loop (LICM) placement. The same safety gates that
      // allow hoisting (no intervening call, no prefix write) prove loop-invariance.
      const preLoopDecls: tstl.VariableDeclarationStatement[] = [];
      hoistScope(
        stmt.body.statements,
        threshold,
        true,
        alreadyHoisted,
        context,
        loopReservedNames,
        isRootAllowed,
        preLoopDecls,
        loopNames,
      );
      // Array-element hoists depend on the loop variable -- they stay inside the body.
      hoistArrayElements(stmt.body.statements, loopNames, threshold, context, loopReservedNames);
      processFunctionBodies(stmt.body.statements, { ...ctx, reservedNames: loopReservedNames });
      if (preLoopDecls.length > 0) {
        statements.splice(j, 0, ...preLoopDecls);
        j += preLoopDecls.length;
      }
    } else if (tstl.isWhileStatement(stmt) || tstl.isRepeatStatement(stmt)) {
      processFunctionBodies(stmt.body.statements, { ...ctx, reservedNames: scopeReservedNames });
    }
  }
}

export const createVisitors: RuleFactory = (_checker, config) => {
  const resolved = resolveLocalizerConfig(config.rules.localizer);
  if (!resolved) return {};

  const { isRootAllowedStrict, isRootAllowedLenient } = buildRootFilters(
    resolved.include,
    resolved.exclude,
  );

  return {
    [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context: tstl.TransformationContext) => {
      const result = context.superTransformNode(node);
      const fileNode = Array.isArray(result) ? result[0] : result;
      if (fileNode && tstl.isFile(fileNode)) {
        processFile(fileNode, resolved, context, isRootAllowedStrict, isRootAllowedLenient);
        return fileNode;
      }
      // Fallback: superTransformStatements still routes each statement through the
      // full plugin visitor chain, so other rules (inline, loop-rebase, etc.) still fire.
      const stmts: tstl.Statement[] = [];
      for (const s of node.statements) {
        stmts.push(...context.superTransformStatements(s));
      }
      const file = tstl.createFile(stmts, context.usedLuaLibFeatures, "", node);
      processFile(file, resolved, context, isRootAllowedStrict, isRootAllowedLenient);
      return file;
    },
  };
};
