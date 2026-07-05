// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { deepCloneExpression } from "../../ast/deep-clone";

/**
 * Recursively transform a Lua expression tree. `leafFn` is called on each node;
 * if it returns a value, that replaces the node (no further recursion).
 * Otherwise the default recursion rebuilds the node with mapped children.
 * Recurses into nested function bodies (e.g. IIFEs from eager-argument evaluation).
 */
function mapLuaExpression(
  node: tstl.Expression,
  leafFn: (n: tstl.Expression) => tstl.Expression | undefined,
): tstl.Expression {
  const hit = leafFn(node);
  if (hit !== undefined) return hit;

  const recurse = (n: tstl.Expression) => mapLuaExpression(n, leafFn);

  if (tstl.isBinaryExpression(node)) {
    return tstl.createBinaryExpression(recurse(node.left), recurse(node.right), node.operator);
  }
  if (tstl.isUnaryExpression(node)) {
    return tstl.createUnaryExpression(recurse(node.operand), node.operator);
  }
  if (tstl.isCallExpression(node)) {
    return tstl.createCallExpression(recurse(node.expression), node.params.map(recurse));
  }
  if (tstl.isMethodCallExpression(node)) {
    return tstl.createMethodCallExpression(
      recurse(node.prefixExpression),
      node.name,
      node.params.map(recurse),
    );
  }
  if (tstl.isTableIndexExpression(node)) {
    return tstl.createTableIndexExpression(recurse(node.table), recurse(node.index));
  }
  if (tstl.isParenthesizedExpression(node)) {
    return tstl.createParenthesizedExpression(recurse(node.expression));
  }
  if (tstl.isTableExpression(node)) {
    return tstl.createTableExpression(
      node.fields.map((field) =>
        tstl.createTableFieldExpression(
          recurse(field.value),
          field.key ? recurse(field.key) : undefined,
        ),
      ),
    );
  }
  if (tstl.isConditionalExpression(node)) {
    return tstl.createConditionalExpression(
      recurse(node.condition),
      recurse(node.whenTrue),
      recurse(node.whenFalse),
    );
  }
  if (tstl.isFunctionExpression(node)) {
    return tstl.createFunctionExpression(
      tstl.createBlock(mapLuaStatements(node.body.statements, leafFn)),
      node.params,
      node.dots,
      node.flags,
    );
  }
  return node;
}

export function substituteParams(
  node: tstl.Expression,
  paramMap: Map<tstl.SymbolId, tstl.Expression>,
): tstl.Expression {
  return mapLuaExpression(node, (n) => {
    if (!tstl.isIdentifier(n)) return undefined;
    const mapped = n.symbolId !== undefined ? paramMap.get(n.symbolId) : undefined;
    return mapped ? deepCloneExpression(mapped) : undefined;
  });
}

/**
 * Recursively transform a Lua statement list. `leafFn` is called on each expression
 * node via `mapLuaExpression`; if it returns a value, that replaces the expression.
 * Produces new statement arrays without mutating originals.
 * @internal Exported for testing only.
 */
export function mapLuaStatements(
  statements: readonly tstl.Statement[],
  leafFn: (n: tstl.Expression) => tstl.Expression | undefined,
): tstl.Statement[] {
  const recurse = (n: tstl.Expression) => mapLuaExpression(n, leafFn);
  const recurseStmts = (stmts: readonly tstl.Statement[]) => mapLuaStatements(stmts, leafFn);

  function mapIfStatement(stmt: tstl.IfStatement): tstl.IfStatement {
    let elseBlock: tstl.Block | tstl.IfStatement | undefined;
    if (stmt.elseBlock) {
      if (tstl.isIfStatement(stmt.elseBlock)) {
        elseBlock = mapIfStatement(stmt.elseBlock);
      } else {
        elseBlock = tstl.createBlock(recurseStmts(stmt.elseBlock.statements));
      }
    }
    return tstl.createIfStatement(
      recurse(stmt.condition),
      tstl.createBlock(recurseStmts(stmt.ifBlock.statements)),
      elseBlock,
    );
  }

  return statements.map((stmt): tstl.Statement => {
    if (tstl.isDoStatement(stmt)) {
      return tstl.createDoStatement(recurseStmts(stmt.statements));
    }
    if (tstl.isVariableDeclarationStatement(stmt)) {
      return tstl.createVariableDeclarationStatement(
        stmt.left.map((id) => {
          const mapped = recurse(id);
          // canInline/canInlineStatements rejects writes to params, so LHS identifiers
          // are never in paramMap and leafFn never substitutes them.
          /* v8 ignore next */
          if (!tstl.isIdentifier(mapped)) throw new Error("invariant: LHS identifier");
          return mapped;
        }),
        stmt.right?.map(recurse),
      );
    }
    if (tstl.isAssignmentStatement(stmt)) {
      return tstl.createAssignmentStatement(
        stmt.left.map((left) => {
          const mapped = recurse(left);
          // isParamWritten rejects inline when params appear on LHS, so assignment
          // targets (Identifier | TableIndexExpression) are never substituted.
          /* v8 ignore next */
          if (!tstl.isIdentifier(mapped) && !tstl.isTableIndexExpression(mapped)) {
            throw new Error("invariant: LHS assignment expression");
          }
          return mapped;
        }),
        stmt.right.map(recurse),
      );
    }
    if (tstl.isIfStatement(stmt)) {
      return mapIfStatement(stmt);
    }
    if (tstl.isWhileStatement(stmt)) {
      return tstl.createWhileStatement(
        tstl.createBlock(recurseStmts(stmt.body.statements)),
        recurse(stmt.condition),
      );
    }
    if (tstl.isRepeatStatement(stmt)) {
      return tstl.createRepeatStatement(
        tstl.createBlock(recurseStmts(stmt.body.statements)),
        recurse(stmt.condition),
      );
    }
    if (tstl.isForStatement(stmt)) {
      return tstl.createForStatement(
        tstl.createBlock(recurseStmts(stmt.body.statements)),
        stmt.controlVariable,
        recurse(stmt.controlVariableInitializer),
        recurse(stmt.limitExpression),
        stmt.stepExpression ? recurse(stmt.stepExpression) : undefined,
      );
    }
    if (tstl.isForInStatement(stmt)) {
      return tstl.createForInStatement(
        tstl.createBlock(recurseStmts(stmt.body.statements)),
        stmt.names,
        stmt.expressions.map(recurse),
      );
    }
    if (tstl.isReturnStatement(stmt)) {
      return tstl.createReturnStatement(stmt.expressions.map(recurse));
    }
    if (tstl.isExpressionStatement(stmt)) {
      return tstl.createExpressionStatement(recurse(stmt.expression));
    }
    return tstl.cloneNode(stmt);
  });
}

export function substituteParamsInStatements(
  statements: readonly tstl.Statement[],
  paramMap: ReadonlyMap<tstl.SymbolId, tstl.Expression>,
): tstl.Statement[] {
  return mapLuaStatements(statements, (n) => {
    if (!tstl.isIdentifier(n)) return undefined;
    const mapped = n.symbolId !== undefined ? paramMap.get(n.symbolId) : undefined;
    return mapped ? deepCloneExpression(mapped) : undefined;
  });
}

// ---------------------------------------------------------------------------
// Position walk infrastructure
//
// These walk the Lua AST without rebuilding it (unlike mapLuaExpression /
// mapLuaStatements) so callers can mutate positions in place.  FunctionExpression
// bodies ARE visited — synthetic IIFEs used by the eager-argument path need
// their positions stamped just like any other inlined node.
// ---------------------------------------------------------------------------

function walkExpr(node: tstl.Expression, visit: (n: tstl.Node) => void): void {
  visit(node);
  if (tstl.isBinaryExpression(node)) {
    walkExpr(node.left, visit);
    walkExpr(node.right, visit);
  } else if (tstl.isUnaryExpression(node)) {
    walkExpr(node.operand, visit);
  } else if (tstl.isCallExpression(node)) {
    walkExpr(node.expression, visit);
    for (const param of node.params) walkExpr(param, visit);
  } else if (tstl.isMethodCallExpression(node)) {
    walkExpr(node.prefixExpression, visit);
    for (const param of node.params) walkExpr(param, visit);
  } else if (tstl.isTableIndexExpression(node)) {
    walkExpr(node.table, visit);
    walkExpr(node.index, visit);
  } else if (tstl.isParenthesizedExpression(node)) {
    walkExpr(node.expression, visit);
  } else if (tstl.isTableExpression(node)) {
    for (const field of node.fields) {
      visit(field);
      if (field.key) walkExpr(field.key, visit);
      walkExpr(field.value, visit);
    }
  } else if (tstl.isConditionalExpression(node)) {
    walkExpr(node.condition, visit);
    walkExpr(node.whenTrue, visit);
    walkExpr(node.whenFalse, visit);
  } else if (tstl.isFunctionExpression(node)) {
    visit(node.body);
    walkStmtList(node.body.statements, visit);
  }
}

function walkStmt(stmt: tstl.Statement, visit: (n: tstl.Node) => void): void {
  visit(stmt);
  if (tstl.isDoStatement(stmt)) {
    walkStmtList(stmt.statements, visit);
  } else if (tstl.isVariableDeclarationStatement(stmt)) {
    for (const id of stmt.left) walkExpr(id, visit);
    if (stmt.right) for (const right of stmt.right) walkExpr(right, visit);
  } else if (tstl.isAssignmentStatement(stmt)) {
    for (const left of stmt.left) walkExpr(left, visit);
    for (const right of stmt.right) walkExpr(right, visit);
  } else if (tstl.isIfStatement(stmt)) {
    walkExpr(stmt.condition, visit);
    visit(stmt.ifBlock);
    walkStmtList(stmt.ifBlock.statements, visit);
    if (stmt.elseBlock) {
      if (tstl.isIfStatement(stmt.elseBlock)) {
        walkStmt(stmt.elseBlock, visit);
      } else {
        visit(stmt.elseBlock);
        walkStmtList(stmt.elseBlock.statements, visit);
      }
    }
  } else if (tstl.isWhileStatement(stmt)) {
    walkExpr(stmt.condition, visit);
    visit(stmt.body);
    walkStmtList(stmt.body.statements, visit);
  } else if (tstl.isRepeatStatement(stmt)) {
    walkExpr(stmt.condition, visit);
    visit(stmt.body);
    walkStmtList(stmt.body.statements, visit);
  } else if (tstl.isForStatement(stmt)) {
    walkExpr(stmt.controlVariable, visit);
    walkExpr(stmt.controlVariableInitializer, visit);
    walkExpr(stmt.limitExpression, visit);
    if (stmt.stepExpression) walkExpr(stmt.stepExpression, visit);
    visit(stmt.body);
    walkStmtList(stmt.body.statements, visit);
  } else if (tstl.isForInStatement(stmt)) {
    for (const id of stmt.names) walkExpr(id, visit);
    for (const expression of stmt.expressions) walkExpr(expression, visit);
    visit(stmt.body);
    walkStmtList(stmt.body.statements, visit);
  } else if (tstl.isReturnStatement(stmt)) {
    for (const expression of stmt.expressions) walkExpr(expression, visit);
  } else if (tstl.isExpressionStatement(stmt)) {
    walkExpr(stmt.expression, visit);
  }
}

function walkStmtList(stmts: readonly tstl.Statement[], visit: (n: tstl.Node) => void): void {
  for (const s of stmts) walkStmt(s, visit);
}

const clearPos = (n: tstl.Node): void => {
  n.line = undefined;
  n.column = undefined;
};

/**
 * Clear all source positions in a statement list (mutates in place).
 * Called before parameter substitution so function-body positions are erased
 * before the post-stamp pass attributes every unpositioned node to the call site.
 */
export function clearNodePositions(stmts: readonly tstl.Statement[]): void {
  walkStmtList(stmts, clearPos);
}

/**
 * Clear all source positions in an expression tree (mutates in place).
 * Used for single-expression bodies (expression-body inlines, return expressions).
 */
export function clearExpressionPositions(expr: tstl.Expression): void {
  walkExpr(expr, clearPos);
}

/**
 * Walk all nodes in a statement list, calling `visit` on each node (mutating walk).
 * Exported for position-stamping passes in builders.
 */
export function walkLuaNodes(
  stmts: readonly tstl.Statement[],
  visit: (n: tstl.Node) => void,
): void {
  walkStmtList(stmts, visit);
}

/**
 * Walk all nodes in an expression tree, calling `visit` on each node (mutating walk).
 * Exported for position-stamping passes in builders.
 */
export function walkLuaExpression(node: tstl.Expression, visit: (n: tstl.Node) => void): void {
  walkExpr(node, visit);
}

// ---------------------------------------------------------------------------
// Require-chain pattern recognition
//
// `extractRequirePattern` identifies bare `require("path")` calls and
// `require("path").member` table-index expressions.  Consumed by the
// `hoist-require` refold-phase rule to deduplicate repeated require chains
// at function/module scope.
// ---------------------------------------------------------------------------

interface RequirePattern {
  requirePath: string;
  /** Undefined for a bare `require("path")` without a member access. */
  memberName: string | undefined;
}

/**
 * Check whether `expr` is a `require("path")` call (bare) or a
 * `require("path").member` table-index expression.
 *
 * Returns `{ requirePath, memberName }` on a match, `undefined` otherwise.
 */
export function extractRequirePattern(expr: tstl.Expression): RequirePattern | undefined {
  // Bare require("path")
  if (
    tstl.isCallExpression(expr) &&
    tstl.isIdentifier(expr.expression) &&
    expr.expression.text === "require" &&
    expr.params.length === 1 &&
    tstl.isStringLiteral(expr.params[0])
  ) {
    return { requirePath: expr.params[0].value, memberName: undefined };
  }

  // require("path").member  →  TableIndexExpression(CallExpression(require, ["path"]), StringLiteral(member))
  if (tstl.isTableIndexExpression(expr) && tstl.isStringLiteral(expr.index)) {
    const tablePattern = extractRequirePattern(expr.table);
    if (tablePattern !== undefined && tablePattern.memberName === undefined) {
      return { requirePath: tablePattern.requirePath, memberName: expr.index.value };
    }
  }

  return undefined;
}
