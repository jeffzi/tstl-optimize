import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isLuaRhsPure } from "../ast/lua-ast";
import type { RuleFactory } from "../config";
import { isRuleEnabled } from "../config";

/**
 * Returns true if `stmt` qualifies for inclusion in a merge run.
 *
 * Requirements (per D-01, D-03):
 * - Must be a VariableDeclarationStatement
 * - Must have exactly one LHS identifier (multi-LHS breaks the run)
 * - RHS must be absent or provably pure (no side effects)
 */
function isMergeable(stmt: tstl.Statement): stmt is tstl.VariableDeclarationStatement {
  if (!tstl.isVariableDeclarationStatement(stmt)) return false;
  if (stmt.left.length !== 1) return false; // multi-LHS breaks run (D-03)
  const rhs = stmt.right;
  // No RHS (local a) → treated as pure (nil initializer)
  if (!rhs || rhs.length === 0) return true;
  return isLuaRhsPure(rhs[0]);
}

/**
 * Merge consecutive single-LHS pure-RHS VariableDeclarationStatements
 * in-place within the given statements array.
 *
 * A run of N>=2 eligible statements is collapsed into one multi-var statement.
 * Runs of length 1 are left as-is (no merging).
 *
 * After processing non-mergeable statements, recurses into compound statements
 * that contain function bodies (per D-06: module-level is NOT merged here).
 */
function mergeConsecutiveLocals(statements: tstl.Statement[]): void {
  const result: tstl.Statement[] = [];
  let run: tstl.VariableDeclarationStatement[] = [];

  function flushRun(): void {
    if (run.length >= 2) {
      const lefts = run.map((s) => s.left[0]);
      // Positional RHS: for slots with no RHS, emit nothing — but we need to preserve
      // positional alignment. If all have RHS or all lack RHS, just concat. If mixed:
      // we pad missing RHS slots with nil literals to maintain alignment.
      const hasAnyRhs = run.some((s) => s.right && s.right.length > 0);
      let rights: tstl.Expression[] | undefined;
      if (hasAnyRhs) {
        rights = run.map((s) =>
          s.right && s.right.length > 0 ? s.right[0] : tstl.createNilLiteral(),
        );
      }
      result.push(tstl.createVariableDeclarationStatement(lefts, rights));
    } else if (run.length === 1) {
      result.push(run[0]);
    }
    run = [];
  }

  for (const stmt of statements) {
    if (isMergeable(stmt)) {
      run.push(stmt);
    } else {
      flushRun();
      result.push(stmt);
      // Recurse into compound statements that can contain function bodies
      recurseIntoFunctionBodies([stmt]);
    }
  }
  flushRun();

  statements.length = 0;
  statements.push(...result);
}

/**
 * Recursively find function bodies in statements and apply mergeConsecutiveLocals
 * to each function body's statement list.
 *
 * This is the entry point for module-level processing (D-06): we walk module-level
 * statements looking for function bodies without merging module-level statements.
 */
function recurseIntoFunctionBodies(statements: tstl.Statement[]): void {
  for (const stmt of statements) {
    if (tstl.isVariableDeclarationStatement(stmt)) {
      // local fn = function() ... end — recurse into function expression body
      const rhs = stmt.right?.[0];
      if (rhs && tstl.isFunctionExpression(rhs)) {
        mergeConsecutiveLocals(rhs.body.statements);
      }
    } else if (tstl.isAssignmentStatement(stmt)) {
      // function foo() ... end — emitted as assignment with FunctionExpression RHS
      for (const rhs of stmt.right) {
        if (tstl.isFunctionExpression(rhs)) {
          mergeConsecutiveLocals(rhs.body.statements);
        }
      }
    } else if (tstl.isDoStatement(stmt)) {
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

export const createVisitors: RuleFactory = (_checker, config) => {
  return {
    [ts.SyntaxKind.SourceFile]: (node, context) => {
      const nodes = context.superTransformNode(node);
      const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;
      if (!file?.statements) return file;
      if (!isRuleEnabled(config.rules, "merge-locals")) return file;
      // D-06: Apply to function bodies only — walk module-level statements
      // looking for function bodies without merging module-level statements themselves.
      recurseIntoFunctionBodies(file.statements);
      return file;
    },
  };
};
