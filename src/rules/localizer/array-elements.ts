// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { withPositionFrom } from "../../ast/deep-clone";
import { Walk, walkStatements } from "../../ast/lua-walker";
import {
  collectArrayElementAccesses,
  collectScopeInfo,
  isLoopVarRebind,
  matchLoopIndexAccess,
} from "../../ast/scope";
import { allocateHoistName, mergeNameSets } from "./hoist";
import { hasCallExpression, hasEarlyExit } from "./safety";

/** Replace matching `base[loopVar]` expressions with cloned temp identifiers. */
export function replaceArrayElements(
  statements: tstl.Statement[],
  hoisted: Map<string, tstl.Identifier>,
  loopVarNames: ReadonlySet<string>,
): void {
  walkStatements(statements, {
    shallow: true,
    expr: (expr: tstl.Expression) => {
      const baseName = matchLoopIndexAccess(expr, loopVarNames)?.base;
      if (!baseName) return Walk.keep;

      const ident = hoisted.get(baseName);
      if (ident) {
        return Walk.replace(tstl.cloneNode(ident));
      }
      return Walk.keep;
    },
    stmt: (stmt, control) => {
      if (isLoopVarRebind(stmt, loopVarNames)) {
        control.skip();
        return;
      }

      if (tstl.isAssignmentStatement(stmt)) {
        for (let i = 0; i < stmt.left.length; i++) {
          const lhs = stmt.left[i];
          const baseName = lhs && matchLoopIndexAccess(lhs, loopVarNames)?.base;
          if (!baseName) continue;

          const ident = hoisted.get(baseName);
          if (ident) {
            stmt.left[i] = tstl.cloneNode(ident);
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
export function hoistArrayElements(
  statements: tstl.Statement[],
  loopVarNames: ReadonlySet<string>,
  threshold: number,
  context: tstl.TransformationContext,
  reservedNames?: ReadonlySet<string>,
): void {
  const { scopeDefs } = collectScopeInfo(statements, true);
  const unavailableNames = mergeNameSets(scopeDefs, loopVarNames, reservedNames);
  const { counts, writes, loopVar, firstAccess } = collectArrayElementAccesses(
    statements,
    loopVarNames,
    true,
  );

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
    /* v8 ignore next -- counts and loopVar are populated together; undefined is unreachable */
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

    const positionSource = firstAccess.get(baseName);
    /* v8 ignore next -- counts and firstAccess are populated together; undefined is unreachable */
    if (positionSource === undefined) {
      throw new Error(`unreachable: no firstAccess for ${baseName}`);
    }
    const tableAccess = tstl.createTableIndexExpression(
      withPositionFrom(tstl.createIdentifier(baseName), positionSource),
      withPositionFrom(tstl.createIdentifier(indexName), positionSource),
    );
    withPositionFrom(tableAccess, positionSource);
    const decl = tstl.createVariableDeclarationStatement(ident, tableAccess);
    withPositionFrom(decl, positionSource);
    decls.push(decl);

    if (writes.has(baseName)) {
      const writeAccess = tstl.createTableIndexExpression(
        withPositionFrom(tstl.createIdentifier(baseName), positionSource),
        withPositionFrom(tstl.createIdentifier(indexName), positionSource),
      );
      withPositionFrom(writeAccess, positionSource);
      const writeback = tstl.createAssignmentStatement(writeAccess, tstl.cloneNode(ident));
      withPositionFrom(writeback, positionSource);
      writebacks.push(writeback);
    }
  }

  if (toHoist.size > 0) {
    replaceArrayElements(statements, toHoist, loopVarNames);
    statements.unshift(...decls);
    statements.push(...writebacks);
  }
}
