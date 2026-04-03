import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { walkStatements } from "../ast/lua-walker";
import type { PluginConfig, RuleFactory } from "../config";

type ConstantValue = number | string | boolean;

function getLiteralValue(expr: tstl.Expression): ConstantValue | undefined {
  if (tstl.isNumericLiteral(expr)) return expr.value;
  if (tstl.isStringLiteral(expr)) return expr.value;
  if (tstl.isBooleanLiteral(expr)) return expr.kind === tstl.SyntaxKind.TrueKeyword;
  return undefined;
}

function createLiteral(value: ConstantValue): tstl.Expression {
  if (typeof value === "number") return tstl.createNumericLiteral(value);
  if (typeof value === "string") return tstl.createStringLiteral(value);
  return tstl.createBooleanLiteral(value);
}

function evaluateBinary(
  op: tstl.Operator,
  left: ConstantValue,
  right: ConstantValue,
): ConstantValue | undefined {
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case tstl.SyntaxKind.AdditionOperator:
        return left + right;
      case tstl.SyntaxKind.SubtractionOperator:
        return left - right;
      case tstl.SyntaxKind.MultiplicationOperator:
        return left * right;
      case tstl.SyntaxKind.DivisionOperator:
        return left / right;
      case tstl.SyntaxKind.FloorDivisionOperator:
        return Math.floor(left / right);
      case tstl.SyntaxKind.ModuloOperator:
        return left % right;
      case tstl.SyntaxKind.PowerOperator:
        return left ** right;
      case tstl.SyntaxKind.EqualityOperator:
        return left === right;
      case tstl.SyntaxKind.InequalityOperator:
        return left !== right;
      case tstl.SyntaxKind.LessThanOperator:
        return left < right;
      case tstl.SyntaxKind.LessEqualOperator:
        return left <= right;
      case tstl.SyntaxKind.GreaterThanOperator:
        return left > right;
      case tstl.SyntaxKind.GreaterEqualOperator:
        return left >= right;
    }
  }
  if (typeof left === "string" && typeof right === "string") {
    switch (op) {
      case tstl.SyntaxKind.ConcatOperator:
        return left + right;
      case tstl.SyntaxKind.EqualityOperator:
        return left === right;
      case tstl.SyntaxKind.InequalityOperator:
        return left !== right;
      case tstl.SyntaxKind.LessThanOperator:
        return left < right;
      case tstl.SyntaxKind.LessEqualOperator:
        return left <= right;
      case tstl.SyntaxKind.GreaterThanOperator:
        return left > right;
      case tstl.SyntaxKind.GreaterEqualOperator:
        return left >= right;
    }
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    switch (op) {
      case tstl.SyntaxKind.EqualityOperator:
        return left === right;
      case tstl.SyntaxKind.InequalityOperator:
        return left !== right;
      case tstl.SyntaxKind.AndOperator:
        return left && right;
      case tstl.SyntaxKind.OrOperator:
        return left || right;
    }
  }
  // Mixed types
  switch (op) {
    case tstl.SyntaxKind.EqualityOperator:
      return left === right;
    case tstl.SyntaxKind.InequalityOperator:
      return left !== right;
    case tstl.SyntaxKind.AndOperator:
      return left && right;
    case tstl.SyntaxKind.OrOperator:
      return left || right;
  }
  return undefined;
}

function evaluateUnary(op: tstl.Operator, operand: ConstantValue): ConstantValue | undefined {
  switch (op) {
    case tstl.SyntaxKind.NegationOperator:
      if (typeof operand === "number") return -operand;
      break;
    case tstl.SyntaxKind.NotOperator:
      return !operand;
    case tstl.SyntaxKind.BitwiseNotOperator:
      if (typeof operand === "number") return ~operand;
      break;
    case tstl.SyntaxKind.LengthOperator:
      if (typeof operand === "string") return operand.length;
      break;
  }
  return undefined;
}

function optimizeControlFlow(statements: tstl.Statement[]): void {
  let hasReturn = false;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];

    if (hasReturn) {
      statements.length = i;
      break;
    }

    if (tstl.isReturnStatement(stmt)) {
      hasReturn = true;
      continue;
    }

    if (tstl.isIfStatement(stmt)) {
      optimizeControlFlow(stmt.ifBlock.statements);

      let currentElse = stmt.elseBlock;
      while (currentElse) {
        if (tstl.isIfStatement(currentElse)) {
          optimizeControlFlow(currentElse.ifBlock.statements);
          currentElse = currentElse.elseBlock;
        } else {
          optimizeControlFlow(currentElse.statements);
          break;
        }
      }

      // Check if all branches are empty
      let allBranchesEmpty = stmt.ifBlock.statements.length === 0;
      let checkElse = stmt.elseBlock;
      while (allBranchesEmpty && checkElse) {
        if (tstl.isIfStatement(checkElse)) {
          if (checkElse.ifBlock.statements.length > 0) {
            allBranchesEmpty = false;
          }
          checkElse = checkElse.elseBlock;
        } else {
          if (checkElse.statements.length > 0) {
            allBranchesEmpty = false;
          }
          checkElse = undefined;
        }
      }

      if (allBranchesEmpty) {
        // Remove this if statement
        statements.splice(i, 1);
        i--;
      } else {
        // Prune trailing empty else/elseif
        let node: tstl.IfStatement | tstl.Block | undefined = stmt;
        const stack: { parent: tstl.IfStatement; node: tstl.IfStatement | tstl.Block }[] = [];

        while (node && tstl.isIfStatement(node)) {
          if (node.elseBlock) {
            stack.push({ parent: node, node: node.elseBlock });
            node = node.elseBlock;
          } else {
            break;
          }
        }

        while (stack.length > 0) {
          const { parent, node } = stack.pop()!;
          if (tstl.isIfStatement(node)) {
            if (node.ifBlock.statements.length === 0 && !node.elseBlock) {
              parent.elseBlock = undefined;
            } else {
              break; // stop pruning if we hit a non-empty block
            }
          } else {
            if (node.statements.length === 0) {
              parent.elseBlock = undefined;
            } else {
              break; // stop pruning if we hit a non-empty block
            }
          }
        }
      }
    } else if (tstl.isDoStatement(stmt)) {
      optimizeControlFlow(stmt.statements);
    } else if (tstl.isWhileStatement(stmt)) {
      optimizeControlFlow(stmt.body.statements);
    } else if (tstl.isRepeatStatement(stmt)) {
      optimizeControlFlow(stmt.body.statements);
    } else if (tstl.isForStatement(stmt)) {
      optimizeControlFlow(stmt.body.statements);
    } else if (tstl.isForInStatement(stmt)) {
      optimizeControlFlow(stmt.body.statements);
    }
  }
}

export const createVisitors: RuleFactory = (
  _checker: ts.TypeChecker,
  _config: PluginConfig,
): tstl.Visitors => {
  return {
    [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context) => {
      const nodes = context.superTransformNode(node);
      const file = (Array.isArray(nodes) ? nodes[0] : nodes) as tstl.File;

      if (!file || !file.statements) return file;

      // Phase 1: Fold constants (bottom-up simulation via repeated passes)
      let changed = true;
      let passes = 0;
      while (changed && passes < 10) {
        changed = false;
        passes++;
        walkStatements(file.statements, {
          expr: (expr, replace) => {
            if (tstl.isBinaryExpression(expr)) {
              const leftVal = getLiteralValue(expr.left);
              const rightVal = getLiteralValue(expr.right);
              if (leftVal !== undefined && rightVal !== undefined) {
                const folded = evaluateBinary(expr.operator, leftVal, rightVal);
                if (folded !== undefined) {
                  const lit = createLiteral(folded);
                  lit.line = expr.line;
                  lit.column = expr.column;
                  replace(lit);
                  changed = true;
                }
              }
            } else if (tstl.isUnaryExpression(expr)) {
              const operandVal = getLiteralValue(expr.operand);
              if (operandVal !== undefined) {
                const folded = evaluateUnary(expr.operator, operandVal);
                if (folded !== undefined) {
                  const lit = createLiteral(folded);
                  lit.line = expr.line;
                  lit.column = expr.column;
                  replace(lit);
                  changed = true;
                }
              }
            }
          },
        });
      }

      // Phase 2: Control flow optimization
      optimizeControlFlow(file.statements);

      return file;
    },
  };
};
