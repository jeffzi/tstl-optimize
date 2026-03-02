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
): Set<string> {
  const { chainCounts, scopeDefs } = collectScopeInfo(statements, shallow);
  const toHoist = new Map<string, tstl.Identifier>();
  const decls: tstl.VariableDeclarationStatement[] = [];

  // Sort entries by chain string for deterministic output
  const sorted = [...chainCounts.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [chain, count] of sorted) {
    if (count < threshold || alreadyHoisted.has(chain)) continue;
    const parts = chain.split(".");
    const hoistName = `____${parts.join("_")}`;
    if (scopeDefs.has(parts[0]) || scopeDefs.has(hoistName) || reservedNames?.has(hoistName))
      continue;
    const ident = tstl.createIdentifier(hoistName, undefined, context.nextSymbolId());
    toHoist.set(chain, ident);
    scopeDefs.add(hoistName);
    decls.push(tstl.createVariableDeclarationStatement(ident, buildChainExpression(chain)));
  }

  if (toHoist.size > 0) {
    replaceChains(statements, toHoist);
    statements.unshift(...decls);
  }

  return new Set(toHoist.keys());
}

/** Check for top-level return/break that would prevent write-back from executing. */
function hasEarlyExit(statements: tstl.Statement[]): boolean {
  for (const stmt of statements) {
    if (tstl.isReturnStatement(stmt) || tstl.isBreakStatement(stmt)) return true;
    // Recurse into if/do blocks — break/return there still exits our scope
    if (tstl.isIfStatement(stmt)) {
      if (hasEarlyExit(stmt.ifBlock.statements)) return true;
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          if (hasEarlyExit([stmt.elseBlock])) return true;
        } else {
          if (hasEarlyExit(stmt.elseBlock.statements)) return true;
        }
      }
    }
    if (tstl.isDoStatement(stmt)) {
      if (hasEarlyExit(stmt.statements)) return true;
    }
    // Don't recurse into nested loops or functions — break/return there only exits the inner scope
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
    stmt: (stmt) => {
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
): void {
  const { scopeDefs } = collectScopeInfo(statements, true);
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

    const hoistName = `____${baseName}`;
    const indexName = loopVar.get(baseName);
    if (indexName === undefined) continue;

    // Safety: base locally defined — hoisting would read before definition
    if (scopeDefs.has(baseName)) continue;
    // Safety: temp name collides with existing definitions or loop vars
    if (scopeDefs.has(hoistName) || loopVarNames.has(hoistName)) continue;
    // Safety: written base + early exit → write-back wouldn't always execute
    if (writes.has(baseName) && earlyExit) continue;

    const ident = tstl.createIdentifier(hoistName, undefined, context.nextSymbolId());
    toHoist.set(baseName, ident);
    scopeDefs.add(hoistName);

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

function processFile(
  file: tstl.File,
  config: LocalizerConfig,
  context: tstl.TransformationContext,
): void {
  const { threshold, scope } = config;

  if (scope === "module") {
    hoistScope(file.statements, threshold, false, new Set(), context);
  } else if (scope === "function") {
    processFunctionBodies(file.statements, threshold, new Set(), context);
  } else {
    // "all": module pass first, then function pass for remaining chains
    const hoistedAtModule = hoistScope(file.statements, threshold, false, new Set(), context);
    processFunctionBodies(file.statements, threshold, hoistedAtModule, context);
  }
}

function processFunctionBodies(
  statements: tstl.Statement[],
  threshold: number,
  alreadyHoisted: ReadonlySet<string>,
  context: tstl.TransformationContext,
): void {
  for (const stmt of statements) {
    if (
      (tstl.isVariableDeclarationStatement(stmt) || tstl.isAssignmentStatement(stmt)) &&
      tstl.isFunctionDefinition(stmt)
    ) {
      const fn = stmt.right[0];
      const paramNames = new Set(fn.params?.filter(tstl.isIdentifier).map((p) => p.text));
      hoistScope(fn.body.statements, threshold, true, alreadyHoisted, context, paramNames);
      processFunctionBodies(fn.body.statements, threshold, alreadyHoisted, context);
    } else if (tstl.isDoStatement(stmt)) {
      processFunctionBodies(stmt.statements, threshold, alreadyHoisted, context);
    } else if (tstl.isIfStatement(stmt)) {
      processFunctionBodies(stmt.ifBlock.statements, threshold, alreadyHoisted, context);
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          processFunctionBodies([stmt.elseBlock], threshold, alreadyHoisted, context);
        } else {
          processFunctionBodies(stmt.elseBlock.statements, threshold, alreadyHoisted, context);
        }
      }
    } else if (tstl.isForInStatement(stmt) || tstl.isForStatement(stmt)) {
      const loopNames = tstl.isForInStatement(stmt)
        ? new Set(stmt.names.filter(tstl.isIdentifier).map((n) => n.text))
        : new Set([stmt.controlVariable.text]);
      hoistScope(stmt.body.statements, threshold, true, alreadyHoisted, context, loopNames);
      hoistArrayElements(stmt.body.statements, loopNames, threshold, context);
      processFunctionBodies(stmt.body.statements, threshold, alreadyHoisted, context);
    } else if (tstl.isWhileStatement(stmt) || tstl.isRepeatStatement(stmt)) {
      processFunctionBodies(stmt.body.statements, threshold, alreadyHoisted, context);
    }
  }
}

export const createVisitors: RuleFactory = (_checker, config) => {
  const resolved = resolveLocalizerConfig(config.rules.localizer);
  if (!resolved) return {};

  return {
    [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context: tstl.TransformationContext) => {
      const result = context.superTransformNode(node);
      const fileNode = result[0];
      if (fileNode && tstl.isFile(fileNode)) {
        processFile(fileNode, resolved, context);
        return fileNode;
      }
      // Fallback: superTransformStatements still routes each statement through the
      // full plugin visitor chain, so other rules (inline, loop-rebase, etc.) still fire.
      const stmts: tstl.Statement[] = [];
      for (const s of node.statements) {
        stmts.push(...context.superTransformStatements(s));
      }
      const file = tstl.createFile(stmts, context.usedLuaLibFeatures, "", node);
      processFile(file, resolved, context);
      return file;
    },
  };
};
