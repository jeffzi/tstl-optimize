import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import type { LocalizerConfig, RuleFactory } from "../config";
import { resolveLocalizerConfig } from "../config";
import { walkStatements } from "../lua-ast/lua-walker";
import { buildChainExpression, collectScopeInfo, luaPropertyChain } from "../lua-ast/scope";

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
  initialDefs?: Iterable<string>,
  reservedNames?: ReadonlySet<string>,
): Set<string> {
  const { chainCounts, scopeDefs } = collectScopeInfo(statements, shallow, initialDefs);
  const toHoist = new Map<string, tstl.Identifier>();
  const decls: tstl.VariableDeclarationStatement[] = [];

  // Sort entries by chain string for deterministic output
  const sorted = [...chainCounts.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [chain, count] of sorted) {
    if (count < threshold || alreadyHoisted.has(chain)) continue;
    const parts = chain.split(".");
    const lastSegment = parts[parts.length - 1];
    if (scopeDefs.has(parts[0]) || scopeDefs.has(lastSegment) || reservedNames?.has(lastSegment))
      continue;
    const ident = tstl.createIdentifier(lastSegment, undefined, context.nextSymbolId());
    toHoist.set(chain, ident);
    scopeDefs.add(lastSegment);
    decls.push(tstl.createVariableDeclarationStatement(ident, buildChainExpression(chain)));
  }

  if (toHoist.size > 0) {
    replaceChains(statements, toHoist);
    statements.unshift(...decls);
  }

  return new Set(toHoist.keys());
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
      hoistScope(
        fn.body.statements,
        threshold,
        true,
        alreadyHoisted,
        context,
        undefined,
        paramNames,
      );
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
      hoistScope(
        stmt.body.statements,
        threshold,
        true,
        alreadyHoisted,
        context,
        undefined,
        loopNames,
      );
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
