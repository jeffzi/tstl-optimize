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
 * Counts unsubstitutable references to `v1Name` or `v2Name` inside an expression.
 *
 * Uses `forEachAccess` to count ALL accesses (fail-closed against unknown node kinds),
 * then subtracts the number of reachable `v1[v2]` patterns that `substituteTemps`
 * will rewrite. Any unsubstitutable accesses would be orphaned if the
 * `local v1, v2 = base, key` declaration is dropped, so they cause the fold to decline.
 *
 * A genuine fold has (total accesses == 2 * reachablePatterns), so this function returns 0
 * and the existing gates at the call sites remain satisfied.
 */
function countUnsubstitutableAccesses(
  expr: tstl.Expression,
  v1Name: string,
  v2Name: string,
): number {
  // Count ALL accesses using the full-coverage walker forEachAccess.
  // Wrap the expression in a synthetic return statement to walk it.
  let totalAccesses = 0;
  const synthStmt = tstl.createReturnStatement([expr]);
  forEachAccess(synthStmt, ({ identifier }) => {
    if (identifier.text === v1Name || identifier.text === v2Name) {
      totalAccesses++;
    }
  });

  // Count only the v1[v2] patterns that substituteTemps CAN rewrite
  // (those reachable via the TableIndexExpression + BinaryExpression recursion spine).
  let reachablePatterns = 0;

  function countReachable(node: tstl.Expression): void {
    if (tstl.isTableIndexExpression(node)) {
      // Check if this is exactly our v1[v2] pattern
      if (
        tstl.isIdentifier(node.table) &&
        tstl.isIdentifier(node.index) &&
        node.table.text === v1Name &&
        node.index.text === v2Name
      ) {
        // This is a reachable v1[v2] pattern that substituteTemps will rewrite.
        reachablePatterns++;
        return;
      }

      // Not a matching v1[v2] pattern — recurse into table and index
      countReachable(node.table);
      countReachable(node.index);
      return;
    }

    if (tstl.isBinaryExpression(node)) {
      countReachable(node.left);
      countReachable(node.right);
      return;
    }

    // Other expression types: no further recursion
  }

  countReachable(expr);

  // Return the count of accesses not covered by reachable substitutable patterns.
  // A genuine fold has totalAccesses == 2 * reachablePatterns (every v1/v2 access
  // is inside a substitutable v1[v2]), so this returns 0 and the fold proceeds.
  // Any temp reference outside the reachable patterns makes this > 0 and declines.
  return totalAccesses - 2 * reachablePatterns;
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
 * Rebuilds the assignment LHS `v1[v2]` as `base[key]`, cloning base/key and
 * carrying source positions from the original temp identifiers so sourcemaps
 * stay anchored. Shared by the 2-temp and 3-temp collapse paths.
 */
function rebuildLhs(
  assignStmt: tstl.AssignmentStatement,
  base: tstl.Expression,
  key: tstl.Expression,
): tstl.TableIndexExpression {
  const origLhs = assignStmt.left[0] as tstl.TableIndexExpression;
  const newBase = withPositionFrom(deepCloneExpression(base), origLhs.table);
  const newKey = withPositionFrom(deepCloneExpression(key), origLhs.index);
  return withPositionFrom(tstl.createTableIndexExpression(newBase, newKey), origLhs);
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
  const newLhs = rebuildLhs(assignStmt, base, key);

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
  const newLhs = rebuildLhs(assignStmt, base, key);
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
      const { v1Name, v2Name, valueInit } = vtMatch;

      // Safety: v1 and v2 must not appear beyond the 3-statement window (i, i+1, i+2).
      const v1CountBeyond = countNameAccesses(stmts, v1Name, i + 3, stmts.length - 1);
      const v2CountBeyond = countNameAccesses(stmts, v2Name, i + 3, stmts.length - 1);

      // Also check for bare v1/v2 reads in the value-temp init and assignment RHS,
      // which would be orphaned if the `local v1, v2 = base, key` decl is dropped.
      const bareInInit = countUnsubstitutableAccesses(valueInit, v1Name, v2Name);
      const bareInRhs = countUnsubstitutableAccesses(vtMatch.assignStmt.right[0], v1Name, v2Name);

      if (v1CountBeyond === 0 && v2CountBeyond === 0 && bareInInit === 0 && bareInRhs === 0) {
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

    // Also check for bare v1/v2 reads in the assignment RHS, which would be orphaned
    // if the `local v1, v2 = base, key` decl is dropped.
    const bareInRhs = countUnsubstitutableAccesses(match.assignStmt.right[0], v1Name, v2Name);

    /* v8 ignore next -- TSTL's 2-temp statement form never references temps beyond the assignment */
    if (v1CountBeyond > 0 || v2CountBeyond > 0 || bareInRhs > 0) {
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

/**
 * Recursively unspills `stmts` and replaces its contents in place. Keeps the
 * parent node's identity (block, loop body, if/else branch) while rewriting its
 * statement list.
 */
function cleanInPlace(stmts: tstl.Statement[], isPure: (e: tstl.Expression) => boolean): void {
  const cleaned = unspillStatements(stmts, { isPure });
  stmts.splice(0, stmts.length, ...cleaned);
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
        cleanInPlace(expr.body.statements, isPure);
        return Walk.skip;
      }
      return Walk.keep;
    },
  });

  if (tstl.isDoStatement(stmt)) {
    cleanInPlace(stmt.statements, isPure);
    return;
  }

  if (
    tstl.isWhileStatement(stmt) ||
    tstl.isRepeatStatement(stmt) ||
    tstl.isForStatement(stmt) ||
    tstl.isForInStatement(stmt)
  ) {
    cleanInPlace(stmt.body.statements, isPure);
    return;
  }

  if (tstl.isIfStatement(stmt)) {
    cleanInPlace(stmt.ifBlock.statements, isPure);

    if (stmt.elseBlock) {
      if (tstl.isIfStatement(stmt.elseBlock)) {
        recurseIntoNestedScopes(stmt.elseBlock, isPure);
      } else {
        cleanInPlace(stmt.elseBlock.statements, isPure);
      }
    }
  }
}
