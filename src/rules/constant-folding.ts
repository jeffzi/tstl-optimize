import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { isLuaExprPure } from "../ast/lua-ast";
import { createLiteral, getLiteralValue } from "../ast/lua-literal";
import { Walk, walkStatements } from "../ast/lua-walker";
import type { ConstantValue, RuleFactory } from "../config";
import { getTransformedFile } from "./source-file";

// ---------------------------------------------------------------------------
// Constant evaluation
// ---------------------------------------------------------------------------

const UTF8_ENCODER = new TextEncoder();

function finiteOrUndefined(n: number): number | undefined {
  return Number.isFinite(n) ? n : undefined;
}

function compareUtf8Strings(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let i = 0; i < sharedLength; i++) {
    if (leftBytes[i] !== rightBytes[i]) {
      return leftBytes[i] < rightBytes[i] ? -1 : 1;
    }
  }

  if (leftBytes.length === rightBytes.length) return 0;
  return leftBytes.length < rightBytes.length ? -1 : 1;
}

function evaluateBinary(
  op: tstl.Operator,
  left: ConstantValue,
  right: ConstantValue,
): ConstantValue | undefined {
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case tstl.SyntaxKind.AdditionOperator:
        return finiteOrUndefined(left + right);
      case tstl.SyntaxKind.SubtractionOperator:
        return finiteOrUndefined(left - right);
      case tstl.SyntaxKind.MultiplicationOperator:
        return finiteOrUndefined(left * right);
      case tstl.SyntaxKind.DivisionOperator:
        return finiteOrUndefined(left / right);
      case tstl.SyntaxKind.FloorDivisionOperator:
        return finiteOrUndefined(Math.floor(left / right));
      case tstl.SyntaxKind.ModuloOperator:
        return finiteOrUndefined(((left % right) + right) % right);
      case tstl.SyntaxKind.PowerOperator:
        return finiteOrUndefined(left ** right);
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
    const ordering = compareUtf8Strings(left, right);
    switch (op) {
      case tstl.SyntaxKind.ConcatOperator:
        return left + right;
      case tstl.SyntaxKind.EqualityOperator:
        return left === right;
      case tstl.SyntaxKind.InequalityOperator:
        return left !== right;
      case tstl.SyntaxKind.LessThanOperator:
        return ordering < 0;
      case tstl.SyntaxKind.LessEqualOperator:
        return ordering <= 0;
      case tstl.SyntaxKind.GreaterThanOperator:
        return ordering > 0;
      case tstl.SyntaxKind.GreaterEqualOperator:
        return ordering >= 0;
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
  // Mixed types — only fold equality; and/or have different semantics in Lua vs JS for non-booleans
  switch (op) {
    case tstl.SyntaxKind.EqualityOperator:
      return left === right;
    case tstl.SyntaxKind.InequalityOperator:
      return left !== right;
  }
  return undefined;
}

function evaluateUnary(op: tstl.Operator, operand: ConstantValue): ConstantValue | undefined {
  switch (op) {
    case tstl.SyntaxKind.NotOperator:
      return typeof operand === "boolean" ? !operand : undefined;
    case tstl.SyntaxKind.BitwiseNotOperator:
      if (typeof operand === "number" && Number.isSafeInteger(operand)) {
        return Number(~BigInt(operand));
      }
      break;
    case tstl.SyntaxKind.LengthOperator:
      if (typeof operand === "string") return UTF8_ENCODER.encode(operand).length;
      break;
    case tstl.SyntaxKind.NegationOperator:
      if (typeof operand === "number") return -operand;
      break;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Control-flow folding
// ---------------------------------------------------------------------------

/** Returns true only if every condition in the if/elseif chain is side-effect-free. */
function allConditionsPure(stmt: tstl.IfStatement): boolean {
  if (!isLuaExprPure(stmt.condition)) return false;
  let cursor = stmt.elseBlock;
  while (cursor && tstl.isIfStatement(cursor)) {
    if (!isLuaExprPure(cursor.condition)) return false;
    cursor = cursor.elseBlock;
  }
  return true;
}

/**
 * Recurses into an if/elseif/else chain, pruning empty pure branches. Returns true if the
 * whole statement is now dead (every branch empty and every condition pure) and should be
 * removed by the caller.
 */
function foldIfStatement(stmt: tstl.IfStatement): boolean {
  optimizeControlFlow(stmt.ifBlock.statements);

  // Single forward pass: recurse into each branch and simultaneously track
  // allBranchesEmpty / pruneFrom so we only traverse the elseif chain once.
  // pruneFrom resets to undefined when a non-empty bare else is seen (terminal).
  let allBranchesEmpty = stmt.ifBlock.statements.length === 0;
  let pruneFrom: tstl.IfStatement | undefined = allBranchesEmpty ? undefined : stmt;
  let cursor = stmt.elseBlock;
  while (cursor) {
    if (tstl.isIfStatement(cursor)) {
      optimizeControlFlow(cursor.ifBlock.statements);
      if (cursor.ifBlock.statements.length > 0) {
        allBranchesEmpty = false;
        pruneFrom = cursor;
      }
      cursor = cursor.elseBlock;
    } else {
      optimizeControlFlow(cursor.statements);
      if (cursor.statements.length > 0) {
        allBranchesEmpty = false;
        pruneFrom = undefined; // bare else is terminal; nothing to prune after it
      }
      break;
    }
  }

  if (allBranchesEmpty && allConditionsPure(stmt)) {
    return true;
  }
  if (pruneFrom !== undefined) {
    // Only prune trailing empty elseif branches whose conditions are pure.
    let canPrune = true;
    let toCheck = pruneFrom.elseBlock;
    while (toCheck && tstl.isIfStatement(toCheck)) {
      if (!isLuaExprPure(toCheck.condition)) {
        canPrune = false;
        break;
      }
      toCheck = toCheck.elseBlock;
    }
    if (canPrune) pruneFrom.elseBlock = undefined;
  }
  return false;
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
      if (foldIfStatement(stmt)) {
        statements.splice(i, 1);
        i--;
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

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

export const createVisitors: RuleFactory = (): tstl.Visitors => {
  return {
    [ts.SyntaxKind.SourceFile]: (node: ts.SourceFile, context): tstl.File => {
      const nodes = context.superTransformNode(node);
      const file = getTransformedFile(nodes);

      // Fold constants via repeated bottom-up passes until stable (max 10 to bound
      // pathological cases — in practice 1–2 passes suffice for real code).
      let changed = true;
      let passes = 0;
      while (changed && passes < 10) {
        changed = false;
        passes++;
        walkStatements(file.statements, {
          expr: (expr: tstl.Expression) => {
            if (tstl.isBinaryExpression(expr)) {
              const leftVal = getLiteralValue(expr.left);
              const rightVal = getLiteralValue(expr.right);
              if (leftVal !== undefined && rightVal !== undefined) {
                const folded = evaluateBinary(expr.operator, leftVal, rightVal);
                if (folded !== undefined) {
                  const lit = createLiteral(folded, { wrapNegativeNumber: true });
                  lit.line = expr.line;
                  lit.column = expr.column;
                  changed = true;
                  return Walk.replace(lit);
                }
              }
            } else if (tstl.isUnaryExpression(expr)) {
              // Preserve raw `-<numeric>` literals as-is. Re-folding the unary node
              // inside createNegativeLiteral() would wrap the same negative value on
              // every pass, but derived negatives still need the wrapped literal path
              // so exponentiation keeps `(-n)` grouped.
              if (
                expr.operator === tstl.SyntaxKind.NegationOperator &&
                tstl.isNumericLiteral(expr.operand)
              ) {
                return Walk.keep;
              }
              const operandVal = getLiteralValue(expr.operand);
              if (operandVal !== undefined) {
                const folded = evaluateUnary(expr.operator, operandVal);
                if (folded !== undefined) {
                  const lit = createLiteral(folded, {
                    wrapNegativeNumber: expr.operator === tstl.SyntaxKind.NegationOperator,
                  });
                  lit.line = expr.line;
                  lit.column = expr.column;
                  changed = true;
                  return Walk.replace(lit);
                }
              }
            }
            return Walk.keep;
          },
        });
      }

      optimizeControlFlow(file.statements);

      return file;
    },
  };
};
