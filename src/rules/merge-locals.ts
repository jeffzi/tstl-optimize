import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isLuaRhsPure } from "../ast/lua-ast";
import { walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";

/**
 * Returns true if `expr` references any name in `names`.
 * Special case: calls expressionReferencesAnyOf but handles function body upvalue
 * capture detection (functions evaluated before binding in multi-assignment).
 */
function referencesAnyOf(expr: tstl.Expression, names: ReadonlySet<string>): boolean {
  if (tstl.isFunctionExpression(expr)) {
    return functionBodyReferencesAnyOf(expr.body.statements, names);
  }
  return expressionReferencesAnyOf(expr, names);
}

/**
 * Recursively scan a statement list for identifier references that match `names`.
 * Used to detect upvalue captures in function bodies.
 */
function functionBodyReferencesAnyOf(
  statements: tstl.Statement[],
  names: ReadonlySet<string>,
): boolean {
  for (const stmt of statements) {
    if (statementReferencesAnyOf(stmt, names)) return true;
  }
  return false;
}

/**
 * Check if a statement contains any identifier reference matching `names`.
 */
function statementReferencesAnyOf(stmt: tstl.Statement, names: ReadonlySet<string>): boolean {
  // For variable and assignment statements, check RHS expressions.
  if (tstl.isVariableDeclarationStatement(stmt)) {
    const rhs = stmt.right;
    return rhs?.some((expr) => expressionReferencesAnyOf(expr, names)) ?? false;
  }

  if (tstl.isAssignmentStatement(stmt)) {
    return (
      stmt.left.some((lhs) => expressionReferencesAnyOf(lhs, names)) ||
      stmt.right.some((rhs) => expressionReferencesAnyOf(rhs, names))
    );
  }

  // For control-flow statements, recurse into their bodies.
  if (tstl.isReturnStatement(stmt)) {
    return stmt.expressions?.some((expr) => expressionReferencesAnyOf(expr, names)) ?? false;
  }

  if (tstl.isIfStatement(stmt)) {
    if (expressionReferencesAnyOf(stmt.condition, names)) return true;
    if (functionBodyReferencesAnyOf(stmt.ifBlock.statements, names)) return true;
    if (stmt.elseBlock) {
      const elseStmts = tstl.isIfStatement(stmt.elseBlock)
        ? [stmt.elseBlock]
        : stmt.elseBlock.statements;
      if (functionBodyReferencesAnyOf(elseStmts, names)) return true;
    }
    return false;
  }

  if (tstl.isWhileStatement(stmt)) {
    if (expressionReferencesAnyOf(stmt.condition, names)) return true;
    if (functionBodyReferencesAnyOf(stmt.body.statements, names)) return true;
    return false;
  }

  if (tstl.isRepeatStatement(stmt)) {
    if (expressionReferencesAnyOf(stmt.condition, names)) return true;
    if (functionBodyReferencesAnyOf(stmt.body.statements, names)) return true;
    return false;
  }

  if (tstl.isForStatement(stmt)) {
    if (expressionReferencesAnyOf(stmt.controlVariableInitializer, names)) return true;
    if (expressionReferencesAnyOf(stmt.limitExpression, names)) return true;
    if (stmt.stepExpression && expressionReferencesAnyOf(stmt.stepExpression, names)) return true;
    if (functionBodyReferencesAnyOf(stmt.body.statements, names)) return true;
    return false;
  }

  if (tstl.isForInStatement(stmt)) {
    return (
      stmt.expressions.some((expr) => expressionReferencesAnyOf(expr, names)) ||
      functionBodyReferencesAnyOf(stmt.body.statements, names)
    );
  }

  if (tstl.isDoStatement(stmt)) {
    return functionBodyReferencesAnyOf(stmt.statements, names);
  }

  if (tstl.isExpressionStatement(stmt)) {
    return expressionReferencesAnyOf(stmt.expression, names);
  }

  return false;
}

/**
 * Recursively scan an expression tree for identifier references matching `names`.
 */
function expressionReferencesAnyOf(expr: tstl.Expression, names: ReadonlySet<string>): boolean {
  if (tstl.isIdentifier(expr)) return names.has(expr.text);

  if (tstl.isTableExpression(expr)) {
    return expr.fields.some(
      (f) =>
        expressionReferencesAnyOf(f.value, names) ||
        (f.key !== undefined && expressionReferencesAnyOf(f.key, names)),
    );
  }

  if (tstl.isCallExpression(expr)) {
    if (expressionReferencesAnyOf(expr.expression, names)) return true;
    for (const arg of expr.params) {
      if (expressionReferencesAnyOf(arg, names)) return true;
    }
    return false;
  }

  if (tstl.isMethodCallExpression(expr)) {
    if (expressionReferencesAnyOf(expr.prefixExpression, names)) return true;
    for (const arg of expr.params) {
      if (expressionReferencesAnyOf(arg, names)) return true;
    }
    return false;
  }

  if (tstl.isBinaryExpression(expr)) {
    return (
      expressionReferencesAnyOf(expr.left, names) || expressionReferencesAnyOf(expr.right, names)
    );
  }

  if (tstl.isUnaryExpression(expr)) {
    return expressionReferencesAnyOf(expr.operand, names);
  }

  if (tstl.isTableIndexExpression(expr)) {
    if (expressionReferencesAnyOf(expr.table, names)) return true;
    if (expressionReferencesAnyOf(expr.index, names)) return true;
    return false;
  }

  if (tstl.isParenthesizedExpression(expr)) {
    return expressionReferencesAnyOf(expr.expression, names);
  }

  if (tstl.isFunctionExpression(expr)) {
    return functionBodyReferencesAnyOf(expr.body.statements, names);
  }

  // Literals, nil, boolean, string, number: no references.
  return false;
}

/**
 * Returns true if `stmt` qualifies for merging: single-LHS with pure or absent RHS.
 */
function isMergeable(stmt: tstl.Statement): stmt is tstl.VariableDeclarationStatement {
  if (!tstl.isVariableDeclarationStatement(stmt)) return false;
  if (stmt.left.length !== 1) return false;
  const rhs = stmt.right;
  if (!rhs || rhs.length === 0) return true;
  if (rhs.length > 1) return false;
  return isLuaRhsPure(rhs[0]);
}

/**
 * Merge consecutive single-LHS pure-RHS VariableDeclarationStatements
 * in-place within the given statements array.
 *
 * A run of N>=2 eligible statements is collapsed into one multi-var statement.
 * Runs of length 1 are left as-is. After processing non-mergeable statements,
 * recurses into compound statements that contain function bodies.
 */
function mergeConsecutiveLocals(statements: tstl.Statement[]): void {
  const result: tstl.Statement[] = [];
  let run: tstl.VariableDeclarationStatement[] = [];
  let declaredNames = new Set<string>();

  function flushRun(): void {
    if (run.length >= 2) {
      const lefts = run.map((s) => s.left[0]);
      const hasAnyRhs = run.some((s) => s.right && s.right.length > 0);
      const rights = hasAnyRhs
        ? run.map((s) => (s.right && s.right.length > 0 ? s.right[0] : tstl.createNilLiteral()))
        : undefined;
      const merged = tstl.createVariableDeclarationStatement(lefts, rights);
      const origin = run[0];
      if (origin.line !== undefined) merged.line = origin.line;
      if (origin.column !== undefined) merged.column = origin.column;
      result.push(merged);
    } else if (run.length === 1) {
      result.push(run[0]);
    }
    run = [];
    declaredNames = new Set<string>();
  }

  for (const stmt of statements) {
    if (isMergeable(stmt)) {
      const rhs = stmt.right?.[0];
      if (rhs !== undefined && referencesAnyOf(rhs, declaredNames)) {
        flushRun();
      }
      declaredNames.add(stmt.left[0].text);
      run.push(stmt);
    } else {
      flushRun();
      result.push(stmt);
      recurseIntoFunctionBodies([stmt]);
    }
  }
  flushRun();

  // Recurse into FunctionExpressions found at any expression depth in ALL statements
  // (including mergeable ones that were placed in runs). The loop above only recurses
  // into non-mergeable statements; mergeable statements with FunctionExpression values
  // nested inside table constructors (e.g. `const obj = { fn: function() {...} }`)
  // would otherwise be missed.
  mergeFunctionBodiesShallow(result);

  statements.length = 0;
  statements.push(...result);
}

/** Shallow-walk statements to find FunctionExpressions and merge their bodies. */
function mergeFunctionBodiesShallow(statements: tstl.Statement[]): void {
  walkStatements(statements, {
    expr: (expr, _replace, control) => {
      if (tstl.isFunctionExpression(expr)) {
        mergeConsecutiveLocals(expr.body.statements);
        control.skip();
      }
    },
    shallow: true,
  });
}

/**
 * Recursively find function bodies in statements and apply mergeConsecutiveLocals
 * to each. Module-level statements are walked but not merged — only function body
 * statement lists are merged.
 */
function recurseIntoFunctionBodies(statements: tstl.Statement[]): void {
  for (const stmt of statements) {
    if (tstl.isDoStatement(stmt)) {
      mergeConsecutiveLocals(stmt.statements);
    } else if (tstl.isIfStatement(stmt)) {
      mergeConsecutiveLocals(stmt.ifBlock.statements);
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          recurseIntoFunctionBodies([stmt.elseBlock]);
        } else {
          mergeConsecutiveLocals(stmt.elseBlock.statements);
        }
      }
    } else if (tstl.isWhileStatement(stmt)) {
      mergeConsecutiveLocals(stmt.body.statements);
    } else if (tstl.isRepeatStatement(stmt)) {
      mergeConsecutiveLocals(stmt.body.statements);
    } else if (tstl.isForStatement(stmt)) {
      mergeConsecutiveLocals(stmt.body.statements);
    } else if (tstl.isForInStatement(stmt)) {
      mergeConsecutiveLocals(stmt.body.statements);
    }
  }
}

export const createVisitors: RuleFactory = () => ({
  [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context): tstl.File => {
    const nodes = context.superTransformNode(node);
    const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;
    if (!file || !tstl.isFile(file) || !file.statements) return file;

    // Module-level locals are not merged, but we must recurse into blocks
    // and find any top-level FunctionExpressions.
    recurseIntoFunctionBodies(file.statements);

    mergeFunctionBodiesShallow(file.statements);

    return file;
  },
});
