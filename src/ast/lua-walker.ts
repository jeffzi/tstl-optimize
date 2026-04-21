// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

export interface TraversalControl {
  skip(): void;
  stop(): void;
}

// Walk action API (D-prime)
export const Walk = {
  keep: Object.freeze({ kind: "keep" } as const),
  skip: Object.freeze({ kind: "skip" } as const),
  stop: Object.freeze({ kind: "stop" } as const),
  replace: (node: tstl.Expression) => ({ kind: "replace", node }) as const,
  replaceChildren: (node: tstl.Expression) => ({ kind: "replaceChildren", node }) as const,
};

export type ExprAction =
  | typeof Walk.keep
  | typeof Walk.skip
  | typeof Walk.stop
  | ReturnType<typeof Walk.replace>
  | ReturnType<typeof Walk.replaceChildren>;

/** D-prime expr visitor — returns an ExprAction to control traversal. */
export type ExprVisitor = (expr: tstl.Expression) => ExprAction;

type StmtVisitor = (stmt: tstl.Statement, control: TraversalControl) => void;

type FuncEnterVisitor = (expr: tstl.FunctionExpression) => void;
type FuncExitVisitor = (expr: tstl.FunctionExpression) => void;

interface WalkerHooks {
  expr: ExprVisitor;
  stmt?: StmtVisitor;
  shallow?: boolean;
  /** When set, the walker increments this around guarded contexts (and/or RHS,
   *  if-branches, conditional expression branches) so callers can skip counting. */
  guardDepth?: number;
  /** Called when entering a nested FunctionExpression body (only when shallow=false). */
  funcEnter?: FuncEnterVisitor;
  /** Called when exiting a nested FunctionExpression body (only when shallow=false). */
  funcExit?: FuncExitVisitor;
}

/** Walk a Lua statement list, calling hooks for each expression and statement. */
export function walkStatements(statements: readonly tstl.Statement[], hooks: WalkerHooks): void {
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
    const action = exprHook(expr);
    switch (action.kind) {
      case "stop":
        stopped = true;
        return;
      case "skip":
        return;
      case "replace":
        if (action.node === expr) {
          throw new Error(
            "Walk.replace(expr) where node === expr is not allowed; use Walk.keep or Walk.skip instead",
          );
        }
        replace(action.node);
        return;
      case "replaceChildren":
        if (action.node === expr) {
          throw new Error(
            "Walk.replaceChildren(expr) where node === expr is not allowed; use Walk.keep or Walk.skip instead",
          );
        }
        replace(action.node);
        recurseExpr(action.node);
        return;
      case "keep":
        recurseExpr(expr);
        return;
    }
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
        const { funcEnter, funcExit } = hooks;
        if (funcEnter) funcEnter(expr);
        walkStmts(expr.body.statements);
        if (funcExit) funcExit(expr);
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
            throw new Error(
              "walkStatements: Identifier LHS of AssignmentStatement is not replaceable; visitor must return Walk.keep or Walk.skip instead of Walk.replace / Walk.replaceChildren",
            );
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
      const { expressions } = stmt;
      if (!expressions) return;
      for (let i = 0; i < expressions.length && !stopped; i++) {
        visitExpr(expressions[i], (n) => {
          expressions[i] = n;
        });
      }
    } else if (tstl.isExpressionStatement(stmt)) {
      visitExpr(stmt.expression, (n) => {
        stmt.expression = n;
      });
    }
  }

  function walkStmts(stmts: readonly tstl.Statement[]): void {
    for (const stmt of stmts) {
      if (stopped) return;
      walkStmt(stmt);
    }
  }

  walkStmts(statements);
}
