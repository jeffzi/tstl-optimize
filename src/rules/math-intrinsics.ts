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

/**
 * Lua has no `math.sqrt` intrinsic that compiles to a single opcode.
 * Raising to the 0.5 power is mathematically equivalent and lets the VM
 * use the `POW` instruction rather than a C-level function call.
 */
function buildSqrt(luaArg: tstl.Expression): tstl.Expression {
  return tstl.createBinaryExpression(
    luaArg,
    tstl.createNumericLiteral(0.5),
    tstl.SyntaxKind.PowerOperator,
  );
}

/**
 * Lua 5.1's `math.floor` returns a float, and `arg - arg % 1` is the
 * idiomatic integer-truncation trick.  However it breaks for ±infinity
 * (infinity mod 1 is NaN in IEEE 754), so the generated expression guards
 * with `(arg == math.huge or arg == -math.huge) and math.floor(arg) or ...`
 * to fall back to the library call only for those two special values.
 */
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

/**
 * Lua 5.1 has no `math.abs` intrinsic, so we emit the standard
 * `and`/`or` ternary idiom.  The zero branch `(arg == 0) and 0 or ...`
 * is required to normalise `-0` → `0`, matching IEEE 754 `Math.abs`
 * semantics; without it `-0` would pass the `< 0` check as falsy and
 * the or-arm would return `arg` unchanged.
 */
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

/**
 * Lua 5.1's `and`/`or` ternary: `(cond) and truthy or falsy`.
 * This is only safe when both arguments are guaranteed to be numeric
 * literals — i.e. never falsy in Lua — because Lua treats `0` as truthy
 * (unlike JS).  For variables, NaN would make the `and`-arm false and
 * the result would silently return the wrong operand.
 */
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

/**
 * The `and`/`or` ternary pattern used by `buildMinMax` breaks when an
 * argument is NaN: `NaN > b` is false, so the `and`-arm short-circuits
 * and `or` returns `b` — the wrong answer.  Numeric literals parsed from
 * source cannot be NaN, so they are the only safe inputs for the rewrite.
 */
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
    const result = tstl.createMethodCallExpression(
      context.transformExpression(expr.expression),
      tstl.createIdentifier(expr.name.text),
      node.arguments.map((arg) => context.transformExpression(arg)),
    );
    tstl.setNodeOriginal(result, node);
    return result;
  }

  if (mathCall.receiverKind === "builtin-alias") {
    const result = tstl.createCallExpression(
      tstl.createTableIndexExpression(
        context.transformExpression(expr.expression),
        tstl.createStringLiteral(expr.name.text),
      ),
      node.arguments.map((arg) => context.transformExpression(arg)),
    );
    tstl.setNodeOriginal(result, node);
    return result;
  }

  const method = mathCall.method;

  const args = node.arguments;

  switch (method) {
    case "sqrt": {
      if (args.length !== 1) return undefined;
      const sqrtResult = buildSqrt(context.transformExpression(args[0]));
      tstl.setNodeOriginal(sqrtResult, node);
      return sqrtResult;
    }
    case "floor": {
      if (args.length !== 1) return undefined;
      if (ts.isNumericLiteral(args[0])) {
        const foldedValue = Number(args[0].text);
        if (Number.isFinite(foldedValue)) {
          const lit = tstl.createNumericLiteral(Math.floor(foldedValue));
          tstl.setNodeOriginal(lit, node);
          return lit;
        }
      }
      if (hasSideEffects(args[0])) return undefined;
      const floorResult = buildFloor(context.transformExpression(args[0]));
      tstl.setNodeOriginal(floorResult, node);
      return floorResult;
    }
    case "ceil": {
      if (args.length !== 1) return undefined;
      if (ts.isNumericLiteral(args[0])) {
        const foldedValue = Number(args[0].text);
        if (Number.isFinite(foldedValue)) {
          const lit = tstl.createNumericLiteral(Math.ceil(foldedValue));
          tstl.setNodeOriginal(lit, node);
          return lit;
        }
      }
      return undefined;
    }
    case "round": {
      if (args.length !== 1) return undefined;
      if (ts.isNumericLiteral(args[0])) {
        const foldedValue = Number(args[0].text);
        if (Number.isFinite(foldedValue)) {
          // Math.round uses "round half toward positive infinity" — the same
          // semantics as Lua's math.floor(x + 0.5) idiom emitted by TSTL.
          const lit = tstl.createNumericLiteral(Math.round(foldedValue));
          tstl.setNodeOriginal(lit, node);
          return lit;
        }
      }
      return undefined;
    }
    case "abs": {
      if (args.length !== 1) return undefined;
      if (hasSideEffects(args[0])) return undefined;
      const absResult = buildAbs(context.transformExpression(args[0]));
      tstl.setNodeOriginal(absResult, node);
      return absResult;
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
      const minMaxResult = buildMinMax(
        context.transformExpression(args[0]),
        context.transformExpression(args[1]),
        op,
      );
      tstl.setNodeOriginal(minMaxResult, node);
      return minMaxResult;
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

      // Strength reduction: x / n → multiplication by reciprocal when:
      // - operator is division
      // - right side is a numeric literal that is a power of 2
      // - left side is side-effect-free
      if (
        node.operatorToken.kind === ts.SyntaxKind.SlashToken &&
        ts.isNumericLiteral(node.right) &&
        !hasSideEffects(node.left, SideEffectOptions.ConsiderIdentityMutating)
      ) {
        const divisor = Number(node.right.text);
        // Check if divisor is a positive power of 2:
        // n > 0 && Math.log2(n) % 1 === 0 guarantees exact representation
        if (divisor > 0 && Math.log2(divisor) % 1 === 0) {
          const reciprocal = 1 / divisor;
          const divResult = tstl.createBinaryExpression(
            context.transformExpression(node.left),
            tstl.createNumericLiteral(reciprocal),
            tstl.SyntaxKind.MultiplicationOperator,
          );
          tstl.setNodeOriginal(divResult, node);
          return divResult;
        }
      }

      // Strength reduction: x ** n → multiplication when side-effect-free
      // x ** 2 → x * x
      // x ** 3 → x * x * x
      // x ** 4 → (x * x) * (x * x)
      if (
        node.operatorToken.kind !== ts.SyntaxKind.AsteriskAsteriskToken ||
        !ts.isNumericLiteral(node.right) ||
        hasSideEffects(node.left, SideEffectOptions.ConsiderIdentityMutating)
      ) {
        return undefined;
      }

      const exponent = node.right.text;
      const luaBase = context.transformExpression(node.left);

      let powResult: tstl.Expression | undefined;
      if (exponent === "2") {
        powResult = tstl.createBinaryExpression(
          luaBase,
          deepCloneExpression(luaBase),
          tstl.SyntaxKind.MultiplicationOperator,
        );
      } else if (exponent === "3") {
        // Compute (x * x) * x to ensure left-associative grouping
        const x2 = tstl.createBinaryExpression(
          deepCloneExpression(luaBase),
          deepCloneExpression(luaBase),
          tstl.SyntaxKind.MultiplicationOperator,
        );
        powResult = tstl.createBinaryExpression(
          x2,
          deepCloneExpression(luaBase),
          tstl.SyntaxKind.MultiplicationOperator,
        );
      } else if (exponent === "4" && config.target === "luajit") {
        // Lua 5.1's C pow() is faster than 3 MUL bytecodes at this exponent
        const x2a = tstl.createBinaryExpression(
          deepCloneExpression(luaBase),
          deepCloneExpression(luaBase),
          tstl.SyntaxKind.MultiplicationOperator,
        );
        const x2b = tstl.createBinaryExpression(
          deepCloneExpression(luaBase),
          deepCloneExpression(luaBase),
          tstl.SyntaxKind.MultiplicationOperator,
        );
        powResult = tstl.createBinaryExpression(
          tstl.createParenthesizedExpression(x2a),
          tstl.createParenthesizedExpression(x2b),
          tstl.SyntaxKind.MultiplicationOperator,
        );
      }

      if (!powResult) return undefined;

      tstl.setNodeOriginal(powResult, node);
      return powResult;
    },
  };
  return visitors as tstl.Visitors;
};
