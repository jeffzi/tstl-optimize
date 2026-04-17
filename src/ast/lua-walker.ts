// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

export interface TraversalControl {
  skip(): void;
  stop(): void;
}

type ExprVisitor = (
  expr: tstl.Expression,
  replace: (n: tstl.Expression) => void,
  control: TraversalControl,
) => void;

type StmtVisitor = (stmt: tstl.Statement, control: TraversalControl) => void;

interface WalkerHooks {
  expr: ExprVisitor;
  stmt?: StmtVisitor;
  shallow?: boolean;
  /** When set, the walker increments this around guarded contexts (and/or RHS,
   *  if-branches, conditional expression branches) so callers can skip counting. */
  guardDepth?: number;
}

/** Walk a Lua statement list, calling hooks for each expression and statement. */
export function walkStatements(statements: tstl.Statement[], hooks: WalkerHooks): void {
  const { expr: exprHook, stmt: stmtHook, shallow } = hooks;
  let stopped = false;
  let skipped = false;

  const control: TraversalControl = {
    skip() {
      skipped = true;
    },
    stop() {
      stopped = true;
    },
  };

  const enterGuard = (): void => {
    if (hooks.guardDepth !== undefined) hooks.guardDepth++;
  };
  const exitGuard = (): void => {
    if (hooks.guardDepth !== undefined) hooks.guardDepth--;
  };

  function visitExpr(expr: tstl.Expression, replace: (n: tstl.Expression) => void): void {
    skipped = false;
    exprHook(expr, replace, control);
    if (stopped || skipped) return;
    recurseExpr(expr);
  }

  function recurseExpr(expr: tstl.Expression): void {
    if (tstl.isBinaryExpression(expr)) {
      visitExpr(expr.left, (n) => {
        expr.left = n;
      });
      if (stopped) return;
      const isGuardOp =
        expr.operator === tstl.SyntaxKind.AndOperator ||
        expr.operator === tstl.SyntaxKind.OrOperator;
      if (isGuardOp) enterGuard();
      visitExpr(expr.right, (n) => {
        expr.right = n;
      });
      if (isGuardOp) exitGuard();
    } else if (tstl.isUnaryExpression(expr)) {
      visitExpr(expr.operand, (n) => {
        expr.operand = n;
      });
    } else if (tstl.isCallExpression(expr)) {
      visitExpr(expr.expression, (n) => {
        expr.expression = n;
      });
      for (let i = 0; i < expr.params.length && !stopped; i++) {
        visitExpr(expr.params[i], (n) => {
          expr.params[i] = n;
        });
      }
    } else if (tstl.isMethodCallExpression(expr)) {
      visitExpr(expr.prefixExpression, (n) => {
        expr.prefixExpression = n;
      });
      for (let i = 0; i < expr.params.length && !stopped; i++) {
        visitExpr(expr.params[i], (n) => {
          expr.params[i] = n;
        });
      }
    } else if (tstl.isTableIndexExpression(expr)) {
      visitExpr(expr.table, (n) => {
        expr.table = n;
      });
      if (stopped) return;
      visitExpr(expr.index, (n) => {
        expr.index = n;
      });
    } else if (tstl.isTableExpression(expr)) {
      for (const field of expr.fields) {
        if (stopped) return;
        if (field.key) {
          visitExpr(field.key, (n) => {
            field.key = n;
          });
        }
        if (stopped) return;
        visitExpr(field.value, (n) => {
          field.value = n;
        });
      }
    } else if (tstl.isFunctionExpression(expr)) {
      if (!shallow) {
        walkStmts(expr.body.statements);
      }
    } else if (tstl.isParenthesizedExpression(expr)) {
      visitExpr(expr.expression, (n) => {
        expr.expression = n;
      });
    } else if (tstl.isConditionalExpression(expr)) {
      visitExpr(expr.condition, (n) => {
        expr.condition = n;
      });
      if (stopped) return;
      enterGuard();
      visitExpr(expr.whenTrue, (n) => {
        expr.whenTrue = n;
      });
      if (stopped) {
        exitGuard();
        return;
      }
      visitExpr(expr.whenFalse, (n) => {
        expr.whenFalse = n;
      });
      exitGuard();
    }
  }

  function walkStmt(stmt: tstl.Statement): void {
    if (stmtHook) {
      skipped = false;
      stmtHook(stmt, control);
      if (stopped || skipped) return;
    }

    if (tstl.isDoStatement(stmt)) {
      walkStmts(stmt.statements);
    } else if (tstl.isVariableDeclarationStatement(stmt)) {
      const { right } = stmt;
      if (right) {
        for (let i = 0; i < right.length && !stopped; i++) {
          visitExpr(right[i], (n) => {
            right[i] = n;
          });
        }
      }
    } else if (tstl.isAssignmentStatement(stmt)) {
      for (const lhs of stmt.left) {
        if (stopped) return;
        if (tstl.isTableIndexExpression(lhs)) {
          visitExpr(lhs.table, (n) => {
            lhs.table = n;
          });
          if (stopped) return;
          visitExpr(lhs.index, (n) => {
            lhs.index = n;
          });
        } else if (tstl.isIdentifier(lhs)) {
          visitExpr(lhs, (_n) => {
            // No-op replace for identifier LHS (walker just needs to visit it)
          });
        }
      }
      for (let i = 0; i < stmt.right.length && !stopped; i++) {
        visitExpr(stmt.right[i], (n) => {
          stmt.right[i] = n;
        });
      }
    } else if (tstl.isIfStatement(stmt)) {
      visitExpr(stmt.condition, (n) => {
        stmt.condition = n;
      });
      if (stopped) return;
      enterGuard();
      walkStmts(stmt.ifBlock.statements);
      if (stopped) {
        exitGuard();
        return;
      }
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          walkStmt(stmt.elseBlock);
        } else {
          walkStmts(stmt.elseBlock.statements);
        }
      }
      exitGuard();
    } else if (tstl.isWhileStatement(stmt)) {
      visitExpr(stmt.condition, (n) => {
        stmt.condition = n;
      });
      if (stopped) return;
      walkStmts(stmt.body.statements);
    } else if (tstl.isRepeatStatement(stmt)) {
      walkStmts(stmt.body.statements);
      if (stopped) return;
      visitExpr(stmt.condition, (n) => {
        stmt.condition = n;
      });
    } else if (tstl.isForStatement(stmt)) {
      visitExpr(stmt.controlVariableInitializer, (n) => {
        stmt.controlVariableInitializer = n;
      });
      if (stopped) return;
      visitExpr(stmt.limitExpression, (n) => {
        stmt.limitExpression = n;
      });
      if (stopped) return;
      if (stmt.stepExpression) {
        visitExpr(stmt.stepExpression, (n) => {
          stmt.stepExpression = n;
        });
        if (stopped) return;
      }
      walkStmts(stmt.body.statements);
    } else if (tstl.isForInStatement(stmt)) {
      for (let i = 0; i < stmt.expressions.length && !stopped; i++) {
        visitExpr(stmt.expressions[i], (n) => {
          stmt.expressions[i] = n;
        });
      }
      if (stopped) return;
      walkStmts(stmt.body.statements);
    } else if (tstl.isReturnStatement(stmt)) {
      for (let i = 0; i < stmt.expressions.length && !stopped; i++) {
        visitExpr(stmt.expressions[i], (n) => {
          stmt.expressions[i] = n;
        });
      }
    } else if (tstl.isExpressionStatement(stmt)) {
      visitExpr(stmt.expression, (n) => {
        stmt.expression = n;
      });
    }
  }

  function walkStmts(stmts: tstl.Statement[]): void {
    for (const stmt of stmts) {
      if (stopped) return;
      walkStmt(stmt);
    }
  }

  walkStmts(statements);
}
