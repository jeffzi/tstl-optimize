// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { walkStatements } from "../../ast/lua-walker";
import { collectArrayElementAccesses, collectScopeInfo } from "../../ast/scope";
import { allocateHoistName, mergeNameSets } from "./hoist";
import { hasCallExpression, hasEarlyExit } from "./safety";

function getLocalizedArrayBaseName(
  expr: tstl.Expression,
  loopVarNames: ReadonlySet<string>,
): string | undefined {
  if (
    !tstl.isTableIndexExpression(expr) ||
    !tstl.isIdentifier(expr.table) ||
    !tstl.isIdentifier(expr.index) ||
    !loopVarNames.has(expr.index.text)
  ) {
    return undefined;
  }

  return expr.table.text;
}

/** Replace matching `base[loopVar]` expressions with cloned temp identifiers. */
export function replaceArrayElements(
  statements: tstl.Statement[],
  hoisted: Map<string, tstl.Identifier>,
  loopVarNames: ReadonlySet<string>,
): void {
  walkStatements(statements, {
    shallow: true,
    expr: (expr, replace, control) => {
      const baseName = getLocalizedArrayBaseName(expr, loopVarNames);
      if (!baseName) return;

      const ident = hoisted.get(baseName);
      if (ident) {
        replace(tstl.cloneIdentifier(ident));
        control.skip();
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
          const baseName = lhs && getLocalizedArrayBaseName(lhs, loopVarNames);
          if (!baseName) continue;

          const ident = hoisted.get(baseName);
          if (ident) {
            stmt.left[i] = tstl.cloneIdentifier(ident);
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
    /* v8 ignore next */ // counts and loopVar are populated together — undefined is unreachable
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
