import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import type { RuleFactory } from "../config";
import { walkStatements } from "../lua-ast/lua-walker";

interface Replacement {
  apply(): void;
}

interface AnalysisResult {
  replacements: Replacement[];
  blocked: boolean;
}

function analyzeBody(body: tstl.Block, varName: string): AnalysisResult {
  const replacements: Replacement[] = [];
  let blocked = false;

  walkStatements(body.statements, {
    expr: (expr, replace, control) => {
      if (blocked) {
        control.stop();
        return;
      }

      // var + 1 or 1 + var → rebaseable
      if (tstl.isBinaryExpression(expr) && expr.operator === tstl.SyntaxKind.AdditionOperator) {
        const lIsVar = tstl.isIdentifier(expr.left) && expr.left.text === varName;
        const rIsVar = tstl.isIdentifier(expr.right) && expr.right.text === varName;
        const lIsOne = tstl.isNumericLiteral(expr.left) && expr.left.value === 1;
        const rIsOne = tstl.isNumericLiteral(expr.right) && expr.right.value === 1;
        if ((lIsVar && rIsOne) || (lIsOne && rIsVar)) {
          replacements.push({ apply: () => replace(tstl.createIdentifier(varName)) });
          control.skip();
          return;
        }
      }

      // Bare identifier reference → blocks rebase
      if (tstl.isIdentifier(expr) && expr.text === varName) {
        blocked = true;
        control.stop();
        return;
      }

      // FunctionExpression: skip body if param shadows the variable
      if (tstl.isFunctionExpression(expr) && expr.params?.some((p) => p.text === varName)) {
        control.skip();
      }
    },
    stmt: (stmt, control) => {
      if (blocked) {
        control.stop();
        return;
      }

      // Assignment to the variable itself → blocks rebase
      if (tstl.isAssignmentStatement(stmt)) {
        for (const lhs of stmt.left) {
          if (tstl.isIdentifier(lhs) && lhs.text === varName) {
            blocked = true;
            control.stop();
            return;
          }
        }
      }

      // Nested for with same control variable → shadowed, skip
      if (tstl.isForStatement(stmt) && stmt.controlVariable.text === varName) {
        control.skip();
        return;
      }

      // ForIn with shadowing iteration variable → skip
      if (tstl.isForInStatement(stmt) && stmt.names.some((n) => n.text === varName)) {
        control.skip();
      }
    },
  });

  return { replacements, blocked };
}

function incrementLimit(limit: tstl.Expression): tstl.Expression {
  // n - 1 → n
  if (
    tstl.isBinaryExpression(limit) &&
    limit.operator === tstl.SyntaxKind.SubtractionOperator &&
    tstl.isNumericLiteral(limit.right) &&
    limit.right.value === 1
  ) {
    return limit.left;
  }
  // NumericLiteral(N) → NumericLiteral(N + 1)
  if (tstl.isNumericLiteral(limit)) {
    return tstl.createNumericLiteral(limit.value + 1);
  }
  // fallback: limit + 1
  return tstl.createBinaryExpression(
    limit,
    tstl.createNumericLiteral(1),
    tstl.SyntaxKind.AdditionOperator,
  );
}

export const createVisitors: RuleFactory = (_checker, _config) => ({
  [ts.SyntaxKind.ForOfStatement]: (
    node: ts.ForOfStatement,
    context: tstl.TransformationContext,
  ) => {
    const result = context.superTransformStatements(node);

    // TSTL compiles $range for-of to a Lua numeric for; anything else is ipairs etc.
    const forStmt = result.find((s): s is tstl.ForStatement => tstl.isForStatement(s));
    if (!forStmt) return result;

    // Eligibility: init must be 0
    if (
      !tstl.isNumericLiteral(forStmt.controlVariableInitializer) ||
      forStmt.controlVariableInitializer.value !== 0
    ) {
      return result;
    }
    // Step must be absent or exactly 1
    if (forStmt.stepExpression !== undefined) {
      if (!tstl.isNumericLiteral(forStmt.stepExpression) || forStmt.stepExpression.value !== 1) {
        return result;
      }
    }

    const varName = forStmt.controlVariable.text;
    const { replacements, blocked } = analyzeBody(forStmt.body, varName);
    if (blocked || replacements.length === 0) return result;

    // Rebase: init 0→1, limit +1, replace all var+1 with bare var
    forStmt.controlVariableInitializer = tstl.createNumericLiteral(1);
    forStmt.limitExpression = incrementLimit(forStmt.limitExpression);
    for (const r of replacements) {
      r.apply();
    }

    return result;
  },
});
