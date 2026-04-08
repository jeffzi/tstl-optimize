import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isLuaRhsPure } from "../ast/lua-ast";
import { walkStatements } from "../ast/lua-walker";
import type { RuleFactory } from "../config";

/**
 * Two-pass dead-local elimination on a single function body's statement list.
 *
 * Pass 1 (shallow): collect single-var declarations at this scope only — `shallow: true`
 * stops at FunctionExpression boundaries so nested declarations aren't misattributed.
 *
 * Pass 2 (deep): collect all identifier reads. Deep walk is required so closure captures
 * inside nested functions count as reads of the outer declaration.
 */
function eliminateDeadLocals(statements: tstl.Statement[]): void {
  const declsBySymbol = new Map<number, { stmt: tstl.Statement; rhs: tstl.Expression }>();

  walkStatements(statements, {
    expr: () => {},
    stmt: (stmt) => {
      if (tstl.isVariableDeclarationStatement(stmt)) {
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
    const reads = new Set<number>();
    walkStatements(statements, {
      expr: (expr) => {
        if (tstl.isIdentifier(expr) && expr.symbolId !== undefined) {
          reads.add(expr.symbolId);
        }
      },
    });

    const toRemove = new Set<tstl.Statement>();
    for (const [symbolId, { stmt, rhs }] of declsBySymbol) {
      if (!reads.has(symbolId) && isLuaRhsPure(rhs)) {
        toRemove.add(stmt);
      }
      // Impure RHS must execute even when the variable is never read — keep it.
    }

    if (toRemove.size > 0) {
      const kept = statements.filter((s) => !toRemove.has(s));
      statements.length = 0;
      statements.push(...kept);
    }
  }

  recurseIntoFunctionBodies(statements);
}

/**
 * Recursively processes nested function bodies to eliminate dead locals in each scope.
 *
 * Finds FunctionExpression nodes in stored positions (variable/assignment RHS, call
 * arguments, table field values, IIFE callees) within all reachable statement lists,
 * including compound statement bodies (do, if, while, for, etc.).
 */
function recurseIntoFunctionBodies(statements: tstl.Statement[]): void {
  walkStatements(statements, {
    shallow: true,
    expr: (expr, _replace, control) => {
      if (tstl.isFunctionExpression(expr)) {
        eliminateDeadLocals(expr.body.statements);
        control.skip();
      }
    },
  });

  for (const stmt of statements) {
    if (tstl.isDoStatement(stmt)) {
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
  [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context): tstl.File => {
    const nodes = context.superTransformNode(node);
    const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;
    if (!file || !tstl.isFile(file) || !file.statements) return file;
    // Module-level locals are intentionally excluded — only function-scope dead locals are removed.
    recurseIntoFunctionBodies(file.statements);
    return file;
  },
});
