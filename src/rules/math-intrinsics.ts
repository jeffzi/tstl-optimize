import ts from "typescript";
// biome-ignore lint/performance/noNamespaceImport: TSTL has no default export
import * as tstl from "typescript-to-lua";
import { deepCloneExpression } from "../ast/deep-clone";
import { hasSideEffects, SideEffectOptions } from "../ast/ts-ast";
import type { RuleFactory } from "../config";

interface MathMethodCallInfo {
  method: string;
  receiverKind: "builtin-direct" | "builtin-alias" | "typed-math";
}

function unwrapAliasExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isBuiltinMathAlias(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  const target = unwrapAliasExpression(expression);
  if (ts.isIdentifier(target) && target.text === "Math") {
    const symbol = checker.getSymbolAtLocation(target);
    return symbol?.getName() === "Math";
  }

  if (!ts.isIdentifier(target)) return false;

  const symbol = checker.getSymbolAtLocation(target);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);

  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !ts.isVariableStatement(declaration.parent.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }

  return isBuiltinMathAlias(declaration.initializer, checker, seenSymbols);
}

function getMathMethodCallInfo(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): MathMethodCallInfo | undefined {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return undefined;

  const symbol = checker.getSymbolAtLocation(expr.expression);
  if (!symbol) return undefined;

  const type = checker.getTypeOfSymbol(symbol);
  const typeName = checker.typeToString(type);
  if (typeName !== "Math") return undefined;

  return {
    method: expr.name.text,
    receiverKind:
      ts.isIdentifier(expr.expression) && expr.expression.text === "Math"
        ? "builtin-direct"
        : isBuiltinMathAlias(expr.expression, checker)
          ? "builtin-alias"
          : "typed-math",
  };
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
  const positiveInfinity = tstl.createTableIndexExpression(
    tstl.createIdentifier("math"),
    tstl.createStringLiteral("huge"),
  );
  const negativeInfinity = tstl.createUnaryExpression(
    tstl.createParenthesizedExpression(deepCloneExpression(positiveInfinity)),
    tstl.SyntaxKind.NegationOperator,
  );
  const isPositiveInfinity = tstl.createBinaryExpression(
    deepCloneExpression(luaArg),
    positiveInfinity,
    tstl.SyntaxKind.EqualityOperator,
  );
  const isNegativeInfinity = tstl.createBinaryExpression(
    deepCloneExpression(luaArg),
    negativeInfinity,
    tstl.SyntaxKind.EqualityOperator,
  );
  const isInfinite = tstl.createBinaryExpression(
    isPositiveInfinity,
    isNegativeInfinity,
    tstl.SyntaxKind.OrOperator,
  );
  const guardedCall = tstl.createCallExpression(
    tstl.createTableIndexExpression(
      tstl.createIdentifier("math"),
      tstl.createStringLiteral("floor"),
    ),
    [deepCloneExpression(luaArg)],
  );
  const right = tstl.createBinaryExpression(
    deepCloneExpression(luaArg),
    tstl.createNumericLiteral(1),
    tstl.SyntaxKind.ModuloOperator,
  );
  const fastPath = tstl.createBinaryExpression(luaArg, right, tstl.SyntaxKind.SubtractionOperator);
  return tstl.createBinaryExpression(
    tstl.createBinaryExpression(isInfinite, guardedCall, tstl.SyntaxKind.AndOperator),
    fastPath,
    tstl.SyntaxKind.OrOperator,
  );
}

/** Build `(arg == 0) and 0 or ((arg < 0) and -arg or arg)` */
function buildAbs(luaArg: tstl.Expression): tstl.Expression {
  const zeroCheck = tstl.createBinaryExpression(
    luaArg,
    tstl.createNumericLiteral(0),
    tstl.SyntaxKind.EqualityOperator,
  );
  const condition = tstl.createBinaryExpression(
    deepCloneExpression(luaArg),
    tstl.createNumericLiteral(0),
    tstl.SyntaxKind.LessThanOperator,
  );
  const negated = tstl.createUnaryExpression(
    tstl.createParenthesizedExpression(deepCloneExpression(luaArg)),
    tstl.SyntaxKind.NegationOperator,
  );
  const andExpr = tstl.createBinaryExpression(condition, negated, tstl.SyntaxKind.AndOperator);
  const nonZeroAbs = tstl.createBinaryExpression(
    andExpr,
    deepCloneExpression(luaArg),
    tstl.SyntaxKind.OrOperator,
  );
  const zeroBranch = tstl.createBinaryExpression(
    zeroCheck,
    tstl.createNumericLiteral(0),
    tstl.SyntaxKind.AndOperator,
  );
  return tstl.createBinaryExpression(
    zeroBranch,
    tstl.createParenthesizedExpression(nonZeroAbs),
    tstl.SyntaxKind.OrOperator,
  );
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

function isSafeMinMaxRewriteArg(node: ts.Expression): boolean {
  return ts.isNumericLiteral(node);
}

function handleCallExpression(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  context: tstl.TransformationContext,
): tstl.Expression | undefined {
  const mathCall = getMathMethodCallInfo(node, checker);
  if (!mathCall) return undefined;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return undefined;

  if (mathCall.receiverKind === "typed-math") {
    return tstl.createMethodCallExpression(
      context.transformExpression(expr.expression),
      tstl.createIdentifier(expr.name.text),
      node.arguments.map((arg) => context.transformExpression(arg)),
    );
  }

  if (mathCall.receiverKind === "builtin-alias") {
    return tstl.createCallExpression(
      tstl.createTableIndexExpression(
        context.transformExpression(expr.expression),
        tstl.createStringLiteral(expr.name.text),
      ),
      node.arguments.map((arg) => context.transformExpression(arg)),
    );
  }

  const method = mathCall.method;

  const args = node.arguments;

  switch (method) {
    case "sqrt": {
      if (args.length !== 1) return undefined;
      return buildSqrt(context.transformExpression(args[0]));
    }
    case "floor": {
      if (args.length !== 1) return undefined;
      if (ts.isNumericLiteral(args[0])) {
        const foldedValue = Number(args[0].text);
        if (Number.isFinite(foldedValue)) {
          return tstl.createNumericLiteral(Math.floor(foldedValue));
        }
      }
      if (hasSideEffects(args[0])) return undefined;
      return buildFloor(context.transformExpression(args[0]));
    }
    case "abs": {
      if (args.length !== 1) return undefined;
      if (hasSideEffects(args[0])) return undefined;
      return buildAbs(context.transformExpression(args[0]));
    }
    case "max":
    case "min": {
      if (args.length !== 2) return undefined;
      if (hasSideEffects(args[0]) || hasSideEffects(args[1])) return undefined;
      if (!isSafeMinMaxRewriteArg(args[0]) || !isSafeMinMaxRewriteArg(args[1])) {
        return undefined;
      }
      const op =
        method === "max" ? tstl.SyntaxKind.GreaterThanOperator : tstl.SyntaxKind.LessThanOperator;
      return buildMinMax(
        context.transformExpression(args[0]),
        context.transformExpression(args[1]),
        op,
      );
    }
    default:
      return undefined;
  }
}

export const createVisitors: RuleFactory = (checker, config) => {
  // Returns undefined to signal "not handled" to the merge wrapper in index.ts;
  // the strict tstl.Visitors type doesn't model this protocol, so we cast here
  type LooseVisitor = (node: ts.Node, context: tstl.TransformationContext) => unknown;
  const visitors: Record<number, LooseVisitor> = {
    [ts.SyntaxKind.CallExpression]: (node, context) => {
      if (!ts.isCallExpression(node)) return undefined;
      // LuaJIT's C function dispatch is faster than inline Lua expressions
      if (config.target !== "luajit") {
        const result = handleCallExpression(node, checker, context);
        if (result) return result;
      }
      return undefined;
    },

    [ts.SyntaxKind.BinaryExpression]: (node, context) => {
      if (!ts.isBinaryExpression(node)) return undefined;
      const binNode = node;
      // x ** 2 → x * x
      if (
        binNode.operatorToken.kind !== ts.SyntaxKind.AsteriskAsteriskToken ||
        !ts.isNumericLiteral(binNode.right) ||
        binNode.right.text !== "2" ||
        hasSideEffects(binNode.left, SideEffectOptions.ConsiderIdentityMutating)
      ) {
        return undefined;
      }
      const luaBase = context.transformExpression(binNode.left);
      return tstl.createBinaryExpression(
        luaBase,
        deepCloneExpression(luaBase),
        tstl.SyntaxKind.MultiplicationOperator,
      );
    },
  };
  return visitors as tstl.Visitors;
};
