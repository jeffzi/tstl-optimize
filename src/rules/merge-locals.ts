import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { getElseBranchStatements, isLuaRhsPure } from "../ast/lua-ast";
import { withoutShadowedNames } from "../ast/lua-references";
import { walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";

function expressionsReferenceAnyOf(
  expressions: readonly tstl.Expression[] | undefined,
  names: ReadonlySet<string>,
): boolean {
  return expressions?.some((expression) => expressionReferencesAnyOf(expression, names)) ?? false;
}

/**
 * Recursively scan a statement list for identifier references that match `names`.
 * Used to detect upvalue captures in function bodies.
 */
function functionBodyReferencesAnyOf(
  statements: readonly tstl.Statement[],
  names: ReadonlySet<string>,
): boolean {
  if (names.size === 0) {
    return false;
  }

  let activeNames = names;

  for (const stmt of statements) {
    if (statementReferencesAnyOf(stmt, activeNames)) {
      return true;
    }

    if (!tstl.isVariableDeclarationStatement(stmt)) {
      continue;
    }

    activeNames = withoutShadowedNames(activeNames, stmt.left, (lhs) =>
      tstl.isIdentifier(lhs) ? lhs.text : undefined,
    );
    if (activeNames.size === 0) {
      return false;
    }
  }

  return false;
}

/**
 * Check if a statement contains any identifier reference matching `names`.
 */
function statementReferencesAnyOf(stmt: tstl.Statement, names: ReadonlySet<string>): boolean {
  if (names.size === 0) {
    return false;
  }

  // For variable and assignment statements, check RHS expressions.
  if (tstl.isVariableDeclarationStatement(stmt)) {
    return expressionsReferenceAnyOf(stmt.right, names);
  }

  if (tstl.isAssignmentStatement(stmt)) {
    return (
      expressionsReferenceAnyOf(stmt.left, names) || expressionsReferenceAnyOf(stmt.right, names)
    );
  }

  // For control-flow statements, recurse into their bodies.
  if (tstl.isReturnStatement(stmt)) {
    return expressionsReferenceAnyOf(stmt.expressions, names);
  }

  if (tstl.isIfStatement(stmt)) {
    if (
      expressionReferencesAnyOf(stmt.condition, names) ||
      functionBodyReferencesAnyOf(stmt.ifBlock.statements, names)
    ) {
      return true;
    }
    if (stmt.elseBlock) {
      if (functionBodyReferencesAnyOf(getElseBranchStatements(stmt.elseBlock), names)) {
        return true;
      }
    }
    return false;
  }

  if (tstl.isWhileStatement(stmt)) {
    return (
      expressionReferencesAnyOf(stmt.condition, names) ||
      functionBodyReferencesAnyOf(stmt.body.statements, names)
    );
  }

  if (tstl.isRepeatStatement(stmt)) {
    return (
      expressionReferencesAnyOf(stmt.condition, names) ||
      functionBodyReferencesAnyOf(stmt.body.statements, names)
    );
  }

  if (tstl.isForStatement(stmt)) {
    const forBodyNames = withoutShadowedNames(
      names,
      [stmt.controlVariable],
      (controlVariable) => controlVariable.text,
    );
    return (
      expressionReferencesAnyOf(stmt.controlVariableInitializer, names) ||
      expressionReferencesAnyOf(stmt.limitExpression, names) ||
      (stmt.stepExpression !== undefined &&
        expressionReferencesAnyOf(stmt.stepExpression, names)) ||
      functionBodyReferencesAnyOf(stmt.body.statements, forBodyNames)
    );
  }

  if (tstl.isForInStatement(stmt)) {
    const forInBodyNames = withoutShadowedNames(names, stmt.names, (name) => name.text);
    return (
      expressionsReferenceAnyOf(stmt.expressions, names) ||
      functionBodyReferencesAnyOf(stmt.body.statements, forInBodyNames)
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
  if (names.size === 0) {
    return false;
  }

  if (tstl.isIdentifier(expr)) return names.has(expr.text);

  if (tstl.isTableExpression(expr)) {
    return expr.fields.some(
      (f) =>
        expressionReferencesAnyOf(f.value, names) ||
        (f.key !== undefined && expressionReferencesAnyOf(f.key, names)),
    );
  }

  if (tstl.isCallExpression(expr)) {
    return (
      expressionReferencesAnyOf(expr.expression, names) ||
      expressionsReferenceAnyOf(expr.params, names)
    );
  }

  if (tstl.isMethodCallExpression(expr)) {
    return (
      expressionReferencesAnyOf(expr.prefixExpression, names) ||
      expressionsReferenceAnyOf(expr.params, names)
    );
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
    return (
      expressionReferencesAnyOf(expr.table, names) || expressionReferencesAnyOf(expr.index, names)
    );
  }

  if (tstl.isParenthesizedExpression(expr)) {
    return expressionReferencesAnyOf(expr.expression, names);
  }

  if (tstl.isConditionalExpression(expr)) {
    return (
      expressionReferencesAnyOf(expr.condition, names) ||
      expressionReferencesAnyOf(expr.whenTrue, names) ||
      expressionReferencesAnyOf(expr.whenFalse, names)
    );
  }

  if (tstl.isFunctionExpression(expr)) {
    const activeNames = withoutShadowedNames(names, expr.params ?? [], (param) =>
      tstl.isIdentifier(param) ? param.text : undefined,
    );
    if (activeNames.size === 0) {
      return false;
    }

    return functionBodyReferencesAnyOf(expr.body.statements, activeNames);
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
      if (rhs !== undefined && expressionReferencesAnyOf(rhs, declaredNames)) {
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
        if (tstl.isBlock(stmt.elseBlock)) {
          mergeConsecutiveLocals(stmt.elseBlock.statements);
        } else {
          recurseIntoFunctionBodies([stmt.elseBlock]);
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
