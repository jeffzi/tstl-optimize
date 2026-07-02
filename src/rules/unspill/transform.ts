// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { deepCloneExpression, withPositionFrom } from "../../ast/deep-clone";
import { isLuaRhsPure } from "../../ast/lua-ast";
import { forEachAccess } from "../../ast/lua-references";
import { Walk, walkStatements } from "../../ast/lua-walker";
import {
  matchUnspillPair,
  matchUnspillValueTemp,
  type UnspillMatch,
  type UnspillValueTempMatch,
} from "./match";

/**
 * Counts how many access slots reference the identifier named `name` across
 * `stmts[startIndex..endIndex]`. Used to verify that the two temp vars are
 * referenced exclusively within the single assignment statement and nowhere
 * else.
 *
 * Identity is by name, not `symbolId`: TSTL stamps every generated temporary
 * with the shared sentinel `symbolId = -1`, so counting by `symbolId` would
 * conflate unrelated temps (e.g. the value temp `____x_2` in a downstream
 * `return ____x_2`) with the base/key temps and wrongly decline a valid fold.
 */
function countNameAccesses(
  stmts: readonly tstl.Statement[],
  name: string,
  startIndex: number,
  endIndex: number,
): number {
  let count = 0;
  for (let i = startIndex; i <= endIndex && i < stmts.length; i++) {
    forEachAccess(stmts[i], ({ identifier }) => {
      if (identifier.text === name) {
        count++;
      }
      return undefined;
    });
  }
  return count;
}

/**
 * Replaces all occurrences of `v1[v2]` (matched by name) in `expr` with
 * fresh clones of `base[key]`. Returns a new expression tree.
 *
 * Each occurrence gets a fresh clone so no two nodes in the tree share identity.
 */
function substituteTemps(
  expr: tstl.Expression,
  v1Name: string,
  v2Name: string,
  base: tstl.Expression,
  key: tstl.Expression,
): tstl.Expression {
  if (tstl.isIdentifier(expr)) {
    // Plain identifier references to v1 or v2 should not appear in the substituted
    // positions (they only appear as table/index inside the index expression).
    // This is a safety fallback that passes through unmolested.
    return expr;
  }

  if (tstl.isTableIndexExpression(expr)) {
    // Check if this is exactly our v1[v2] pattern
    if (
      tstl.isIdentifier(expr.table) &&
      tstl.isIdentifier(expr.index) &&
      expr.table.text === v1Name &&
      expr.index.text === v2Name
    ) {
      // Substitute with base[key] — fresh clones to avoid shared node identity
      const newBase = withPositionFrom(deepCloneExpression(base), expr.table);
      const newKey = withPositionFrom(deepCloneExpression(key), expr.index);
      return withPositionFrom(tstl.createTableIndexExpression(newBase, newKey), expr);
    }

    // Recurse into table/index sub-expressions
    return withPositionFrom(
      tstl.createTableIndexExpression(
        substituteTemps(expr.table, v1Name, v2Name, base, key),
        substituteTemps(expr.index, v1Name, v2Name, base, key),
      ),
      expr,
    );
  }

  if (tstl.isBinaryExpression(expr)) {
    return withPositionFrom(
      tstl.createBinaryExpression(
        substituteTemps(expr.left, v1Name, v2Name, base, key),
        substituteTemps(expr.right, v1Name, v2Name, base, key),
        expr.operator,
      ),
      expr,
    );
  }

  /* v8 ignore next -- TSTL does not emit UnaryExpression or ParenthesizedExpression in the RHS of the 2-temp pattern */
  return expr;
}

/**
 * Applies a single unspill substitution given a confirmed match descriptor.
 *
 * Produces an `AssignmentStatement` of the form `base[key] = <rhs substituted>`,
 * positioned from the original decl statement (to preserve sourcemap info).
 */
function applyUnspill(match: UnspillMatch): tstl.AssignmentStatement {
  const { assignStmt, base, key, v1Name, v2Name } = match;

  // Build the new LHS: base[key]
  const origLhs = assignStmt.left[0] as tstl.TableIndexExpression;
  const newBase = withPositionFrom(deepCloneExpression(base), origLhs.table);
  const newKey = withPositionFrom(deepCloneExpression(key), origLhs.index);
  const newLhs = withPositionFrom(tstl.createTableIndexExpression(newBase, newKey), origLhs);

  // Build the new RHS: substitute all v1[v2] → base[key] in the original RHS
  const newRhs = substituteTemps(assignStmt.right[0], v1Name, v2Name, base, key);

  return withPositionFrom(tstl.createAssignmentStatement([newLhs], [newRhs]), match.declStmt);
}

/**
 * Applies a partial collapse for the 3-statement value-temp form.
 *
 * Produces:
 *   local v3 = E1[E2] <op> rhs   (v1[v2] → E1[E2] in the init)
 *   E1[E2] = v3 rhs               (LHS v1[v2] → E1[E2]; RHS references v3, left untouched)
 *
 * The `local v1, v2 = E1, E2` decl is dropped. v3 and its downstream consumer are kept.
 */
function applyUnspillValueTemp(
  match: UnspillValueTempMatch,
): [tstl.VariableDeclarationStatement, tstl.AssignmentStatement] {
  const { valueDeclStmt, valueInit, assignStmt, base, key, v1Name, v2Name } = match;

  // Rewrite the value-temp init: substitute v1[v2] → E1[E2]
  const newInit = substituteTemps(valueInit, v1Name, v2Name, base, key);
  const newValueDecl = withPositionFrom(
    tstl.createVariableDeclarationStatement(valueDeclStmt.left, [newInit]),
    valueDeclStmt,
  );

  // Rewrite the assignment LHS: v1[v2] → E1[E2]; RHS is untouched (references v3)
  const origLhs = assignStmt.left[0] as tstl.TableIndexExpression;
  const newBase = withPositionFrom(deepCloneExpression(base), origLhs.table);
  const newKey = withPositionFrom(deepCloneExpression(key), origLhs.index);
  const newLhs = withPositionFrom(tstl.createTableIndexExpression(newBase, newKey), origLhs);
  const newAssign = withPositionFrom(
    tstl.createAssignmentStatement([newLhs], assignStmt.right),
    match.declStmt,
  );

  return [newValueDecl, newAssign];
}

/**
 * Eliminates redundant TSTL compound-assignment temporaries from a flat statement
 * list, returning a new list with the matched pairs collapsed.
 *
 * The pattern matched (in pairs):
 *   local v1, v2 = E1, E2
 *   v1[v2] = v1[v2] <op> rhs
 *
 * Safety gates (all must hold):
 * - E1 and E2 are both pure (identifier or literal).
 * - v1 and v2 are referenced only within the immediately following assignment.
 * - The pair is contiguous (no intervening statements).
 *
 * Does NOT recurse into nested scopes — the caller (`unspillStatements`) handles
 * recursion. This keeps each pass strictly over a single flat list.
 */
function unspillFlat(
  stmts: tstl.Statement[],
  isPure: (e: tstl.Expression) => boolean,
): tstl.Statement[] {
  const result: tstl.Statement[] = [];
  let i = 0;

  while (i < stmts.length) {
    // Try the 3-statement value-temp form first — it's a strict superset of the 2-statement
    // shape at position i, so checking it first avoids a redundant 2-stmt match attempt.
    const vtMatch = matchUnspillValueTemp(stmts, i, isPure);

    if (vtMatch !== undefined) {
      const { v1Name, v2Name } = vtMatch;

      // Safety: v1 and v2 must not appear beyond the 3-statement window (i, i+1, i+2).
      const v1CountBeyond = countNameAccesses(stmts, v1Name, i + 3, stmts.length - 1);
      const v2CountBeyond = countNameAccesses(stmts, v2Name, i + 3, stmts.length - 1);

      if (v1CountBeyond === 0 && v2CountBeyond === 0) {
        const [newValueDecl, newAssign] = applyUnspillValueTemp(vtMatch);
        result.push(newValueDecl, newAssign);
        i += 3; // skip decl, value-temp decl, and original assign
        continue;
      }
    }

    const match = matchUnspillPair(stmts, i, isPure);

    if (match === undefined) {
      result.push(stmts[i]);
      i++;
      continue;
    }

    const { v1Name, v2Name } = match;

    // Safety: verify both temps appear only in the pair (decl + assign) and nowhere else.
    // The decl writes them (decl is at i), assign reads/writes them (assign is at i+1).
    // Any access beyond index i+1 means the temps escape — decline substitution.
    const v1CountBeyond = countNameAccesses(stmts, v1Name, i + 2, stmts.length - 1);
    const v2CountBeyond = countNameAccesses(stmts, v2Name, i + 2, stmts.length - 1);

    /* v8 ignore next -- TSTL's 2-temp statement form never references temps beyond the assignment */
    if (v1CountBeyond > 0 || v2CountBeyond > 0) {
      result.push(stmts[i]);
      i++;
      continue;
    }

    // Pattern confirmed — substitute and drop the decl
    result.push(applyUnspill(match));
    i += 2; // skip both decl and original assign
  }

  return result;
}

/**
 * Recursively eliminates compound-assignment temporaries throughout a complete
 * statement tree, including nested loop bodies, if/else branches, do blocks,
 * and function expression bodies.
 *
 * The `isPure` predicate defaults to `isLuaRhsPure` when not provided.
 *
 * This is the public entry point used by the SourceFile visitor in `index.ts`.
 */
export function unspillStatements(
  stmts: tstl.Statement[],
  opts?: { isPure?: (e: tstl.Expression) => boolean },
): tstl.Statement[] {
  const pure = opts?.isPure ?? isLuaRhsPure;

  const processed = unspillFlat(stmts, pure);

  // Recurse into nested scopes so loop bodies and nested blocks are also cleaned.
  for (const stmt of processed) {
    recurseIntoNestedScopes(stmt, pure);
  }

  return processed;
}

function recurseIntoNestedScopes(
  stmt: tstl.Statement,
  isPure: (e: tstl.Expression) => boolean,
): void {
  // A shallow walkStatements pass catches FunctionExpression nodes in every
  // statement position — local declarations, assignment RHS, call arguments —
  // without a fragile hand-enumerated allowlist of statement kinds. Function
  // bodies are independent scopes: their statements are nested inside the
  // FunctionExpression node and never appear in the parent list directly.
  walkStatements([stmt], {
    shallow: true,
    expr: (expr) => {
      if (tstl.isFunctionExpression(expr)) {
        const cleaned = unspillStatements(expr.body.statements, { isPure });
        expr.body.statements.splice(0, expr.body.statements.length, ...cleaned);
        return Walk.skip;
      }
      return Walk.keep;
    },
  });

  if (tstl.isDoStatement(stmt)) {
    const cleaned = unspillStatements(stmt.statements, { isPure });
    stmt.statements.splice(0, stmt.statements.length, ...cleaned);
    return;
  }

  if (
    tstl.isWhileStatement(stmt) ||
    tstl.isRepeatStatement(stmt) ||
    tstl.isForStatement(stmt) ||
    tstl.isForInStatement(stmt)
  ) {
    const bodyStmts = stmt.body.statements;
    const cleaned = unspillStatements(bodyStmts, { isPure });
    bodyStmts.splice(0, bodyStmts.length, ...cleaned);
    return;
  }

  if (tstl.isIfStatement(stmt)) {
    const ifCleaned = unspillStatements(stmt.ifBlock.statements, { isPure });
    stmt.ifBlock.statements.splice(0, stmt.ifBlock.statements.length, ...ifCleaned);

    if (stmt.elseBlock) {
      if (tstl.isIfStatement(stmt.elseBlock)) {
        recurseIntoNestedScopes(stmt.elseBlock, isPure);
      } else {
        const elseCleaned = unspillStatements(stmt.elseBlock.statements, { isPure });
        stmt.elseBlock.statements.splice(0, stmt.elseBlock.statements.length, ...elseCleaned);
      }
    }
  }
}
