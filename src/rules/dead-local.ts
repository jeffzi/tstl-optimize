import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";

/**
 * Lua-side purity predicate for RHS safety gate (D-03).
 *
 * Only considers an expression pure if it cannot have side effects.
 * CallExpression, MethodCallExpression, BinaryExpression, etc. are impure.
 * Note: the hasSideEffects function in src/ast/ts-ast.ts takes ts.Expression and cannot
 * be used here — this rule runs post-transpile on tstl.Expression nodes only.
 */
function isLuaRhsPure(expr: tstl.Expression): boolean {
  if (tstl.isNumericLiteral(expr)) return true;
  if (tstl.isStringLiteral(expr)) return true;
  if (tstl.isBooleanLiteral(expr)) return true;
  if (tstl.isNilLiteral(expr)) return true;
  if (tstl.isIdentifier(expr)) return true;
  if (tstl.isFunctionExpression(expr)) return true;
  if (tstl.isTableExpression(expr)) {
    return expr.fields.every(
      (f) => isLuaRhsPure(f.value) && (f.key === undefined || isLuaRhsPure(f.key)),
    );
  }
  // CallExpression, MethodCallExpression, BinaryExpression, etc. — impure
  return false;
}

/**
 * Performs a two-pass dead-local elimination on a function body's statement list.
 *
 * Pass 1 (shallow): Collect single-var VariableDeclarationStatement nodes using
 * walkStatements with shallow: true. Shallow mode stops at FunctionExpression
 * boundaries so declarations inside nested functions are not attributed to this scope.
 *
 * Pass 2 (deep): Collect all identifier reads via walkStatements without shallow.
 * Deep walk ensures closure captures count as outer-scope uses (Pitfall 2).
 *
 * After processing this function body, recursively processes nested function bodies.
 */
function eliminateDeadLocals(statements: tstl.Statement[]): void {
  // Pass 1: collect single-var declarations at this scope level only.
  // Use walkStatements with shallow: true so declarations inside nested FunctionExpressions
  // are not attributed to this scope. We filter out nested stmts by checking the stmt hook
  // fires only for top-level statements of this body (shallow mode stops recursion).
  // To track which top-level statement each decl belongs to, we track via Set<Statement>.
  const declsBySymbol = new Map<number, { stmt: tstl.Statement; rhs: tstl.Expression }>();

  walkStatements(statements, {
    expr: () => {
      // No-op: we only care about statement-level declarations in Pass 1
    },
    stmt: (stmt) => {
      if (tstl.isVariableDeclarationStatement(stmt)) {
        // Only handle single-var, single-RHS declarations (D-05)
        if (stmt.left.length === 1 && stmt.right !== undefined && stmt.right.length === 1) {
          const symbolId = stmt.left[0].symbolId;
          if (symbolId !== undefined) {
            declsBySymbol.set(symbolId, { stmt, rhs: stmt.right[0] });
          }
        }
      }
    },
    shallow: true,
  });

  if (declsBySymbol.size > 0) {
    // Pass 2: collect reads (deep — closure captures count as outer-scope uses)
    const reads = new Set<number>();
    walkStatements(statements, {
      expr: (expr) => {
        if (tstl.isIdentifier(expr) && expr.symbolId !== undefined) {
          reads.add(expr.symbolId);
        }
      },
      // No shallow flag — default deep walk so closure reads are captured
    });

    // Determine which statements to remove
    const toRemove = new Set<tstl.Statement>();
    for (const [symbolId, { stmt, rhs }] of declsBySymbol) {
      if (reads.has(symbolId)) {
        // Variable is read — keep it
        continue;
      }
      if (isLuaRhsPure(rhs)) {
        // Pure RHS — safe to drop the declaration entirely
        toRemove.add(stmt);
      }
      // Impure RHS (call expression, etc.) — must execute; keep the declaration (D-03)
    }

    if (toRemove.size > 0) {
      // Filter statements in-place, preserving original array reference
      const kept = statements.filter((s) => !toRemove.has(s));
      statements.length = 0;
      statements.push(...kept);
    }
  }

  // Recurse into nested function bodies (after modifying the current level)
  recurseIntoFunctionBodies(statements);
}

/**
 * Recursively processes nested function bodies to eliminate dead locals in each scope.
 *
 * TSTL represents all function declarations as AssignmentStatement or
 * VariableDeclarationStatement with FunctionExpression RHS. walkStatements with
 * shallow: true stops at FunctionExpression boundaries, so we must find and
 * recurse into them explicitly here.
 */
function recurseIntoFunctionBodies(statements: tstl.Statement[]): void {
  for (const stmt of statements) {
    if (tstl.isAssignmentStatement(stmt) || tstl.isVariableDeclarationStatement(stmt)) {
      const rights = tstl.isAssignmentStatement(stmt) ? stmt.right : (stmt.right ?? []);
      for (const rhs of rights) {
        if (tstl.isFunctionExpression(rhs)) {
          eliminateDeadLocals(rhs.body.statements);
        }
      }
    } else if (tstl.isDoStatement(stmt)) {
      recurseIntoFunctionBodies(stmt.statements);
    } else if (tstl.isIfStatement(stmt)) {
      recurseIntoFunctionBodies(stmt.ifBlock.statements);
      if (stmt.elseBlock) {
        if (tstl.isIfStatement(stmt.elseBlock)) {
          recurseIntoFunctionBodies([stmt.elseBlock]);
        } else {
          recurseIntoFunctionBodies(stmt.elseBlock.statements);
        }
      }
    } else if (tstl.isWhileStatement(stmt)) {
      recurseIntoFunctionBodies(stmt.body.statements);
    } else if (tstl.isRepeatStatement(stmt)) {
      recurseIntoFunctionBodies(stmt.body.statements);
    } else if (tstl.isForStatement(stmt)) {
      recurseIntoFunctionBodies(stmt.body.statements);
    } else if (tstl.isForInStatement(stmt)) {
      recurseIntoFunctionBodies(stmt.body.statements);
    }
  }
}

export const createVisitors: RuleFactory = (): tstl.Visitors => ({
  [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context) => {
    const nodes = context.superTransformNode(node);
    const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;
    if (!file?.statements) return file;
    // D-02: module-level locals are out of scope — process only function bodies
    recurseIntoFunctionBodies(file.statements);
    return file;
  },
});
