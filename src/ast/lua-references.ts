// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";

/** A single identifier access visited in evaluation order.
 *
 * - `identifier`: The Lua identifier being accessed.
 * - `kind`: Whether this is a read (RHS) or write (LHS assignment/declaration).
 * - `inFunctionBody`: True if this access is inside a nested FunctionExpression body.
 */
export type AccessEntry = {
  identifier: tstl.Identifier;
  kind: "read" | "write";
  inFunctionBody: boolean;
};

/**
 * Visits every identifier access in a tstl statement in dead-local evaluation order.
 * Returning true from visit stops the walk early.
 *
 * Evaluation order rules:
 * - AssignmentStatement LHS:
 *   - TableIndexExpression targets: emit .table (read) then .index (read) immediately
 *   - Plain Identifier targets: accumulate as a deferred write (emitted AFTER all
 *     table/index reads and all RHS reads)
 * - AssignmentStatement RHS: emit all reads left-to-right
 * - Deferred plain-Identifier writes are emitted in source order after RHS
 * - VariableDeclarationStatement: emit LHS identifiers as "write", then RHS reads
 * - ReturnStatement, ExpressionStatement, IfStatement, WhileStatement, RepeatStatement,
 *   ForStatement, ForInStatement, DoStatement: emit all identifier accesses as "read"
 *   (for-control init/limit/step, conditions, expressions, body recursion)
 * - FunctionExpression bodies: descend into them and set inFunctionBody: true for
 *   all accesses inside
 */
export function forEachAccess(
  statement: tstl.Statement,
  visit: (entry: AccessEntry) => boolean | undefined,
): void {
  const walkExpressions = (exprs: tstl.Expression[], inFunctionBody: boolean): boolean => {
    for (const expr of exprs) {
      if (walkExpression(expr, inFunctionBody)) {
        return true;
      }
    }
    return false;
  };

  const walkExpression = (expr: tstl.Expression, inFunctionBody: boolean): boolean => {
    if (tstl.isIdentifier(expr)) {
      return visit({ identifier: expr, kind: "read", inFunctionBody }) ?? false;
    }

    if (tstl.isFunctionExpression(expr)) {
      return walkStatements(expr.body.statements, true);
    }

    if (tstl.isTableIndexExpression(expr)) {
      if (walkExpression(expr.table, inFunctionBody)) {
        return true;
      }
      return walkExpression(expr.index, inFunctionBody);
    }

    if (tstl.isBinaryExpression(expr)) {
      if (walkExpression(expr.left, inFunctionBody)) {
        return true;
      }
      return walkExpression(expr.right, inFunctionBody);
    }

    if (tstl.isUnaryExpression(expr)) {
      return walkExpression(expr.operand, inFunctionBody);
    }

    if (tstl.isCallExpression(expr)) {
      if (walkExpression(expr.expression, inFunctionBody)) {
        return true;
      }
      return walkExpressions(expr.params, inFunctionBody);
    }

    if (tstl.isMethodCallExpression(expr)) {
      if (walkExpression(expr.prefixExpression, inFunctionBody)) {
        return true;
      }
      return walkExpressions(expr.params, inFunctionBody);
    }

    if (tstl.isTableExpression(expr)) {
      for (const field of expr.fields) {
        if (field.key && walkExpression(field.key, inFunctionBody)) {
          return true;
        }
        if (walkExpression(field.value, inFunctionBody)) {
          return true;
        }
      }
      return false;
    }

    if (tstl.isConditionalExpression(expr)) {
      if (walkExpression(expr.condition, inFunctionBody)) {
        return true;
      }
      if (walkExpression(expr.whenTrue, inFunctionBody)) {
        return true;
      }
      return walkExpression(expr.whenFalse, inFunctionBody);
    }

    if (tstl.isParenthesizedExpression(expr)) {
      return walkExpression(expr.expression, inFunctionBody);
    }

    return false;
  };

  const walkStatements = (statements: tstl.Statement[], inFunctionBody: boolean): boolean => {
    for (const stmt of statements) {
      if (walkStatement(stmt, inFunctionBody)) {
        return true;
      }
    }
    return false;
  };

  const walkStatement = (stmt: tstl.Statement, inFunctionBody: boolean): boolean => {
    if (tstl.isAssignmentStatement(stmt)) {
      // Lua assignment semantics: all RHS expressions are evaluated before any writes
      // take effect. Table-index LHS targets require reads of both .table and .index,
      // so they are emitted immediately. Plain Identifier targets are deferred until
      // after all RHS reads to reflect the correct evaluation order.
      const deferredWrites: tstl.Identifier[] = [];

      for (const lhs of stmt.left) {
        if (tstl.isTableIndexExpression(lhs)) {
          if (walkExpression(lhs.table, inFunctionBody)) {
            return true;
          }
          if (walkExpression(lhs.index, inFunctionBody)) {
            return true;
          }
        } else if (tstl.isIdentifier(lhs)) {
          deferredWrites.push(lhs);
        }
      }

      for (const rhs of stmt.right) {
        if (walkExpression(rhs, inFunctionBody)) {
          return true;
        }
      }

      for (const write of deferredWrites) {
        if (visit({ identifier: write, kind: "write", inFunctionBody })) {
          return true;
        }
      }

      return false;
    }

    if (tstl.isVariableDeclarationStatement(stmt)) {
      // LHS identifiers are writes, RHS are reads
      for (const lhs of stmt.left) {
        if (visit({ identifier: lhs, kind: "write", inFunctionBody })) {
          return true;
        }
      }

      if (stmt.right) {
        for (const rhs of stmt.right) {
          if (walkExpression(rhs, inFunctionBody)) {
            return true;
          }
        }
      }

      return false;
    }

    if (tstl.isReturnStatement(stmt)) {
      if (stmt.expressions) {
        for (const expr of stmt.expressions) {
          if (walkExpression(expr, inFunctionBody)) {
            return true;
          }
        }
      }
      return false;
    }

    if (tstl.isExpressionStatement(stmt)) {
      return walkExpression(stmt.expression, inFunctionBody);
    }

    if (tstl.isIfStatement(stmt)) {
      if (walkExpression(stmt.condition, inFunctionBody)) {
        return true;
      }
      if (walkStatements(stmt.ifBlock.statements, inFunctionBody)) {
        return true;
      }
      // elseBlock can be a nested IfStatement (elseif chain) or a plain Block.
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          return walkStatement(stmt.elseBlock, inFunctionBody);
        }
        return walkStatements(stmt.elseBlock.statements, inFunctionBody);
      }
      return false;
    }

    if (tstl.isWhileStatement(stmt)) {
      if (walkExpression(stmt.condition, inFunctionBody)) {
        return true;
      }
      return walkStatements(stmt.body.statements, inFunctionBody);
    }

    if (tstl.isRepeatStatement(stmt)) {
      if (walkStatements(stmt.body.statements, inFunctionBody)) {
        return true;
      }
      return walkExpression(stmt.condition, inFunctionBody);
    }

    if (tstl.isForStatement(stmt)) {
      // controlVariable is a binding (not walked); only initializer/limit/step are reads
      if (walkExpression(stmt.controlVariableInitializer, inFunctionBody)) {
        return true;
      }
      if (walkExpression(stmt.limitExpression, inFunctionBody)) {
        return true;
      }
      if (stmt.stepExpression && walkExpression(stmt.stepExpression, inFunctionBody)) {
        return true;
      }
      return walkStatements(stmt.body.statements, inFunctionBody);
    }

    if (tstl.isForInStatement(stmt)) {
      for (const expr of stmt.expressions) {
        if (walkExpression(expr, inFunctionBody)) {
          return true;
        }
      }
      return walkStatements(stmt.body.statements, inFunctionBody);
    }

    if (tstl.isDoStatement(stmt)) {
      return walkStatements(stmt.statements, inFunctionBody);
    }

    // For other statement types, no identifier accesses
    return false;
  };

  walkStatement(statement, false);
}

/**
 * Removes from `names` any name that appears as a shadowing binding in `nodes`.
 * Returns the same ReadonlySet instance when no shadowing occurs; a new Set otherwise.
 */
export function withoutShadowedNames<T>(
  names: ReadonlySet<string>,
  nodes: Iterable<T>,
  getName: (node: T) => string | undefined,
): ReadonlySet<string> {
  let result: Set<string> | undefined;

  for (const node of nodes) {
    const name = getName(node);
    if (name !== undefined && names.has(name)) {
      if (result === undefined) {
        result = new Set(names);
      }
      result.delete(name);
    }
  }

  return result ?? names;
}
