// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import type { isLuaRhsPure } from "../../ast/lua-ast";

/**
 * Descriptor for a matched 2-temp compound-assignment pattern.
 *
 * - `declStmt`: The `local v1, v2 = E1, E2` declaration.
 * - `assignStmt`: The `v1[v2] = <rhs>` assignment immediately following.
 * - `base`: The original base expression (E1, cloned).
 * - `key`: The original key expression (E2, cloned).
 * - `v1Name` / `v2Name`: Source names (`.text`) of the two temp identifiers.
 *
 * Identity is tracked by name, not `symbolId`: TSTL stamps every generated
 * temporary with the shared sentinel `symbolId = -1`, so `symbolId` equality is
 * meaningless between temps. The names (`____arr_0`, `____temp_1`, …) come from a
 * file-global monotonic counter and are unique.
 */
export type UnspillMatch = {
  declStmt: tstl.VariableDeclarationStatement;
  assignStmt: tstl.AssignmentStatement;
  base: tstl.Expression;
  key: tstl.Expression;
  v1Name: string;
  v2Name: string;
};

/**
 * Descriptor for a matched 3-temp value-temp pattern (expression form).
 *
 * - `declStmt`: The `local v1, v2 = E1, E2` declaration.
 * - `valueDeclStmt`: The `local v3 = v1[v2] <op> rhs` value-temp init immediately following.
 * - `assignStmt`: The `v1[v2] = v3` (or `v1[v2] = <expr with v3>`) assignment.
 * - `base`: The original base expression (E1).
 * - `key`: The original key expression (E2).
 * - `v1Name` / `v2Name`: Source names (`.text`) of the base/key temp identifiers.
 *
 * See {@link UnspillMatch} for why identity is by name and not `symbolId`.
 */
export type UnspillValueTempMatch = {
  declStmt: tstl.VariableDeclarationStatement;
  valueDeclStmt: tstl.VariableDeclarationStatement;
  valueInit: tstl.Expression;
  assignStmt: tstl.AssignmentStatement;
  base: tstl.Expression;
  key: tstl.Expression;
  v1Name: string;
  v2Name: string;
};

/**
 * Validates and extracts the first statement shared by both unspill patterns:
 *   local v1, v2 = E1, E2
 * requiring exactly two temp bindings whose two RHS expressions are both pure
 * under `isPure`. Returns the base/key expressions and the temp names, or
 * `undefined` if the statement is not this shape.
 */
function matchUnspillDecl(
  stmt: tstl.Statement | undefined,
  isPure: typeof isLuaRhsPure,
):
  | {
      declStmt: tstl.VariableDeclarationStatement;
      base: tstl.Expression;
      key: tstl.Expression;
      v1Name: string;
      v2Name: string;
    }
  | undefined {
  if (
    stmt === undefined ||
    !tstl.isVariableDeclarationStatement(stmt) ||
    stmt.left.length !== 2 ||
    stmt.right === undefined ||
    stmt.right.length !== 2
  ) {
    return undefined;
  }

  const base = stmt.right[0];
  const key = stmt.right[1];
  const v1Name = stmt.left[0];
  const v2Name = stmt.left[1];

  if (
    base === undefined ||
    key === undefined ||
    v1Name === undefined ||
    v2Name === undefined ||
    !isPure(base) ||
    !isPure(key)
  ) {
    return undefined;
  }

  return { declStmt: stmt, base, key, v1Name: v1Name.text, v2Name: v2Name.text };
}

/**
 * Attempts to match the TSTL compound-assignment 3-temp value-temp pattern at position `index`.
 *
 * The pattern is:
 *   local v1, v2 = E1, E2                  -- VariableDeclarationStatement (base/key temps)
 *   local v3 = <expr containing v1[v2]>    -- VariableDeclarationStatement (value temp)
 *   v1[v2] = <rhs referencing v3>          -- AssignmentStatement
 *
 * where E1 and E2 are both pure under `isPure`. The base/key temps are substituted away
 * (partial collapse); v3 and its consumer downstream are left untouched.
 *
 * Returns a descriptor when the pattern matches, `undefined` otherwise.
 */
export function matchUnspillValueTemp(
  stmts: readonly tstl.Statement[],
  index: number,
  isPure: typeof isLuaRhsPure,
): UnspillValueTempMatch | undefined {
  const decl = matchUnspillDecl(stmts[index], isPure);
  if (decl === undefined) {
    return undefined;
  }
  const { declStmt, base, key, v1Name, v2Name } = decl;

  const valueDeclStmt = stmts[index + 1];
  if (valueDeclStmt === undefined) {
    return undefined;
  }

  // Second stmt: local v3 = <expr containing v1[v2]>
  if (
    !tstl.isVariableDeclarationStatement(valueDeclStmt) ||
    valueDeclStmt.left.length !== 1 ||
    valueDeclStmt.right === undefined ||
    valueDeclStmt.right.length !== 1
  ) {
    return undefined;
  }

  const [valueInit] = valueDeclStmt.right;
  /* v8 ignore next -- length check above ensures valueInit exists */
  if (valueInit === undefined) {
    return undefined;
  }

  /* v8 ignore next -- TSTL always emits v1[v2] in the value-temp init */
  if (!rhsContainsIndexRead(valueInit, v1Name, v2Name)) {
    return undefined;
  }

  // Third stmt: v1[v2] = <rhs>
  const assignStmt = stmts[index + 2];
  if (assignStmt === undefined) {
    return undefined;
  }

  const validatedAssign = validateIndexLhs(assignStmt, v1Name, v2Name);
  if (validatedAssign === undefined) {
    return undefined;
  }

  return {
    declStmt,
    valueDeclStmt,
    valueInit,
    assignStmt: validatedAssign,
    base,
    key,
    v1Name,
    v2Name,
  };
}

/**
 * Attempts to match the TSTL compound-assignment 2-temp pattern at position `index`.
 *
 * The pattern is:
 *   local v1, v2 = E1, E2           -- VariableDeclarationStatement
 *   v1[v2] = <rhs containing v1[v2]>  -- AssignmentStatement
 *
 * where E1 and E2 are both pure under `isPure`.
 *
 * Returns a descriptor when the pattern matches, `undefined` otherwise.
 */
export function matchUnspillPair(
  stmts: readonly tstl.Statement[],
  index: number,
  isPure: typeof isLuaRhsPure,
): UnspillMatch | undefined {
  const decl = matchUnspillDecl(stmts[index], isPure);
  if (decl === undefined) {
    return undefined;
  }
  const { declStmt, base, key, v1Name, v2Name } = decl;

  const assignStmt = stmts[index + 1];
  if (assignStmt === undefined) {
    return undefined;
  }

  // Second stmt: v1[v2] = <rhs>
  const validatedAssign = validateIndexLhs(assignStmt, v1Name, v2Name);
  if (validatedAssign === undefined) {
    return undefined;
  }

  // RHS must contain a read of v1[v2] (the original value being modified).
  // right.length check: TSTL always emits a single RHS expression for compound assignments.
  /* v8 ignore next -- TSTL always emits exactly one RHS expression for compound assignments */
  if (validatedAssign.right.length !== 1) {
    return undefined;
  }

  const [rhsExpr] = validatedAssign.right;
  /* v8 ignore next -- length check above ensures rhsExpr exists */
  if (rhsExpr === undefined) {
    return undefined;
  }

  /* v8 ignore next -- TSTL always emits v1[v2] as the left operand of the RHS expression */
  if (!rhsContainsIndexRead(rhsExpr, v1Name, v2Name)) {
    return undefined;
  }

  return { declStmt, assignStmt: validatedAssign, base, key, v1Name, v2Name };
}

/**
 * Validates that `stmt` is an AssignmentStatement whose single LHS is a
 * `v1[v2]` TableIndexExpression with Identifier table and index matching
 * the given temp names. Returns the narrowed statement or `undefined`.
 */
function validateIndexLhs(
  stmt: tstl.Statement | undefined,
  v1Name: string,
  v2Name: string,
): tstl.AssignmentStatement | undefined {
  if (stmt === undefined || !tstl.isAssignmentStatement(stmt)) {
    return undefined;
  }

  /* v8 ignore next -- TSTL always emits exactly one LHS for indexed compound-assignment */
  if (stmt.left.length !== 1) {
    return undefined;
  }

  const [lhs] = stmt.left;
  /* v8 ignore next -- length check above ensures lhs exists */
  if (lhs === undefined) {
    return undefined;
  }

  /* v8 ignore next -- TSTL always emits a TableIndexExpression with Identifier table and index */
  if (
    !tstl.isTableIndexExpression(lhs) ||
    !tstl.isIdentifier(lhs.table) ||
    !tstl.isIdentifier(lhs.index)
  ) {
    return undefined;
  }

  /* v8 ignore next -- TSTL always emits matching temp names in the following assignment */
  if (lhs.table.text !== v1Name || lhs.index.text !== v2Name) {
    return undefined;
  }

  return stmt;
}

/**
 * Returns true if the expression contains a `v1[v2]` TableIndexExpression
 * where v1 is named `v1Name` and v2 is named `v2Name`.
 *
 * TSTL always emits the compound-assign RHS as a BinaryExpression whose left
 * operand is the `v1[v2]` read, so BinaryExpression and TableIndexExpression
 * are the only forms this function needs to recurse over.
 *
 * Used to confirm the RHS reads from the same indexed location being written.
 */
function rhsContainsIndexRead(expr: tstl.Expression, v1Name: string, v2Name: string): boolean {
  if (tstl.isTableIndexExpression(expr)) {
    return (
      tstl.isIdentifier(expr.table) &&
      tstl.isIdentifier(expr.index) &&
      expr.table.text === v1Name &&
      expr.index.text === v2Name
    );
  }

  if (tstl.isBinaryExpression(expr)) {
    // TSTL always places the v1[v2] read as the left operand of the binary expression,
    // so the right branch of this || is rarely taken but kept for correctness.
    /* v8 ignore next -- TSTL always places the temp-read as the left operand of the binary RHS */
    return (
      rhsContainsIndexRead(expr.left, v1Name, v2Name) ||
      rhsContainsIndexRead(expr.right, v1Name, v2Name)
    );
  }

  /* v8 ignore next -- RHS of TSTL compound-assign is always BinaryExpression or TableIndexExpression */
  return false;
}
