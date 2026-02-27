import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import type { RuleFactory } from "../config";
import { hasSideEffects } from "../lua-ast/ts-ast";

function isMathMethodCall(node: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return undefined;

  const symbol = checker.getSymbolAtLocation(expr.expression);
  if (!symbol) return undefined;

  const type = checker.getTypeOfSymbol(symbol);
  const typeName = checker.typeToString(type);
  if (typeName !== "Math") return undefined;

  return expr.name.text;
}

/** Build `arg ^ 0.5` */
function buildSqrt(luaArg: tstl.Expression): tstl.Expression {
  return tstl.createBinaryExpression(
    luaArg,
    tstl.createNumericLiteral(0.5),
    tstl.SyntaxKind.PowerOperator,
  );
}

/** Build `arg - arg % 1` */
function buildFloor(luaArg: tstl.Expression): tstl.Expression {
  const right = tstl.createBinaryExpression(
    tstl.cloneNode(luaArg),
    tstl.createNumericLiteral(1),
    tstl.SyntaxKind.ModuloOperator,
  );
  return tstl.createBinaryExpression(luaArg, right, tstl.SyntaxKind.SubtractionOperator);
}

/** Build `(arg < 0) and -arg or arg` */
function buildAbs(luaArg: tstl.Expression): tstl.Expression {
  const condition = tstl.createBinaryExpression(
    luaArg,
    tstl.createNumericLiteral(0),
    tstl.SyntaxKind.LessThanOperator,
  );
  const negated = tstl.createUnaryExpression(
    tstl.cloneNode(luaArg),
    tstl.SyntaxKind.NegationOperator,
  );
  const andExpr = tstl.createBinaryExpression(condition, negated, tstl.SyntaxKind.AndOperator);
  return tstl.createBinaryExpression(andExpr, tstl.cloneNode(luaArg), tstl.SyntaxKind.OrOperator);
}

/** Build `(a > b) and a or b` for max, `(a < b) and a or b` for min */
function buildMinMax(
  luaA: tstl.Expression,
  luaB: tstl.Expression,
  op: tstl.SyntaxKind.GreaterThanOperator | tstl.SyntaxKind.LessThanOperator,
): tstl.Expression {
  const condition = tstl.createBinaryExpression(luaA, luaB, op);
  const andExpr = tstl.createBinaryExpression(
    condition,
    tstl.cloneNode(luaA),
    tstl.SyntaxKind.AndOperator,
  );
  return tstl.createBinaryExpression(andExpr, tstl.cloneNode(luaB), tstl.SyntaxKind.OrOperator);
}

function handleCallExpression(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Expression | undefined {
  const method = isMathMethodCall(node, checker);
  if (!method) return undefined;

  const args = node.arguments;

  switch (method) {
    case "sqrt": {
      if (args.length !== 1) return undefined;
      return buildSqrt(context.transformExpression(args[0]));
    }
    case "floor": {
      if (args.length !== 1) return undefined;
      if (hasSideEffects(args[0])) return undefined;
      return buildFloor(context.transformExpression(args[0]));
    }
    case "abs": {
      if (args.length !== 1) return undefined;
      if (hasSideEffects(args[0])) return undefined;
      return buildAbs(context.transformExpression(args[0]));
    }
    case "max": {
      if (args.length !== 2) return undefined;
      if (hasSideEffects(args[0]) || hasSideEffects(args[1])) return undefined;
      return buildMinMax(
        context.transformExpression(args[0]),
        context.transformExpression(args[1]),
        tstl.SyntaxKind.GreaterThanOperator,
      );
    }
    case "min": {
      if (args.length !== 2) return undefined;
      if (hasSideEffects(args[0]) || hasSideEffects(args[1])) return undefined;
      return buildMinMax(
        context.transformExpression(args[0]),
        context.transformExpression(args[1]),
        tstl.SyntaxKind.LessThanOperator,
      );
    }
    default:
      return undefined;
  }
}

export const createVisitors: RuleFactory = (checker, config) => ({
  [ts.SyntaxKind.CallExpression]: (
    node: ts.CallExpression,
    context: tstl.TransformationContext,
  ) => {
    // LuaJIT's C function dispatch is faster than inline Lua expressions
    if (config.target !== "luajit") {
      const result = handleCallExpression(node, checker, context);
      if (result) return result;
    }
    return context.superTransformExpression(node);
  },

  [ts.SyntaxKind.BinaryExpression]: (
    node: ts.BinaryExpression,
    context: tstl.TransformationContext,
  ) => {
    // x ** 2 → x * x
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) {
      if (
        ts.isNumericLiteral(node.right) &&
        node.right.text === "2" &&
        !hasSideEffects(node.left)
      ) {
        return tstl.createBinaryExpression(
          context.transformExpression(node.left),
          context.transformExpression(node.left),
          tstl.SyntaxKind.MultiplicationOperator,
        );
      }
    }
    return context.superTransformExpression(node);
  },
});
