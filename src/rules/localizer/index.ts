import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { getElseBranchStatements } from "../../ast/lua-ast";
import { Walk, walkStatements } from "../../ast/lua-walker";
import { collectScopeInfo } from "../../ast/scope";
import type { LocalizerConfig, RuleFactory } from "../../config";
import { resolveLocalizerConfig } from "../../config";
import { hoistArrayElements } from "./array-elements";
import { hoistScope, mergeNameSets } from "./hoist";
import { STDLIB_ROOTS } from "./safety";

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
  const runModulePass = (): Set<string> =>
    hoistScope(file.statements, threshold, false, new Set<string>(), context, {
      isRootAllowed: isRootAllowedStrict,
    });
  const functionContext = {
    threshold,
    context,
    isRootAllowed: isRootAllowedLenient,
    reservedNames: new Set<string>(),
  };

  switch (scope) {
    case "module":
      runModulePass();
      return;
    case "function":
      processFunctionBodies(file.statements, {
        ...functionContext,
        alreadyHoisted: new Set<string>(),
      });
      return;
    case "all": {
      // Module pass runs first, then function bodies only hoist the remaining chains.
      const alreadyHoisted = runModulePass();
      processFunctionBodies(file.statements, {
        ...functionContext,
        alreadyHoisted,
      });
      return;
    }
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
    expr: (expr: tstl.Expression) => {
      if (tstl.isFunctionExpression(expr)) {
        const paramNames = new Set(expr.params?.filter(tstl.isIdentifier).map((p) => p.text));
        const functionReservedNames = mergeNameSets(scopeReservedNames, paramNames);
        hoistScope(expr.body.statements, threshold, true, alreadyHoisted, context, {
          reservedNames: functionReservedNames,
          isRootAllowed,
        });
        processFunctionBodies(expr.body.statements, {
          ...ctx,
          reservedNames: functionReservedNames,
        });
        return Walk.skip;
      }
      return Walk.keep;
    },
  });

  for (let j = 0; j < statements.length; j++) {
    const stmt = statements[j];
    if (tstl.isDoStatement(stmt)) {
      processFunctionBodies(stmt.statements, ctx);
    } else if (tstl.isIfStatement(stmt)) {
      // Hoist chains inside if-block (pass outer snapshot of alreadyHoisted to each branch)
      hoistScope(stmt.ifBlock.statements, threshold, true, alreadyHoisted, context, {
        reservedNames: scopeReservedNames,
        isRootAllowed,
      });
      processFunctionBodies(stmt.ifBlock.statements, ctx);
      // Hoist chains inside else-block independently
      if (stmt.elseBlock) {
        const elseBranchStatements = getElseBranchStatements(stmt.elseBlock);
        hoistScope(elseBranchStatements, threshold, true, alreadyHoisted, context, {
          reservedNames: scopeReservedNames,
          isRootAllowed,
          elseBranchOwner: stmt,
        });
        processFunctionBodies(getElseBranchStatements(stmt.elseBlock), ctx);
      }
    } else if (tstl.isForInStatement(stmt) || tstl.isForStatement(stmt)) {
      const loopNames = tstl.isForInStatement(stmt)
        ? new Set(stmt.names.filter(tstl.isIdentifier).map((n) => n.text))
        : new Set([stmt.controlVariable.text]);
      const loopReservedNames = mergeNameSets(scopeReservedNames, loopNames);
      // Collect chain decls for pre-loop (LICM) placement. The same safety gates that
      // allow hoisting (no intervening call, no prefix write) prove loop-invariance.
      const preLoopDecls: tstl.VariableDeclarationStatement[] = [];
      hoistScope(stmt.body.statements, threshold, true, alreadyHoisted, context, {
        reservedNames: loopReservedNames,
        isRootAllowed,
        outDecls: preLoopDecls,
        extraBoundNames: loopNames,
      });
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
